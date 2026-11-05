import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, Database, Download, House, Minus, Pencil, Plus, Search, Server, Square, SquareTerminal, Table2, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "../assets/icon.svg?url";
import { ConnectDialog } from "./components/ConnectDialog";
import { blankProfile, ProfileSheet } from "./components/ProfileSheet";
import { type AppInfo, api, type ConnectOk, localFs, localTerm, type Profile, sshFs, sshTerm } from "./lib/ipc";
import { useUpdater } from "./lib/updater";

// 무거운 칸(xterm·편집기·표·사전)은 처음 열 때 받는다 — 첫 화면(홈)은 가볍게
const Workbench = lazy(() => import("./components/Workbench").then((m) => ({ default: m.Workbench })));
const ResultGridPane = lazy(() => import("./components/ResultGrid").then((m) => ({ default: m.ResultGridPane })));
const CommandDictionaryPane = lazy(() => import("./components/CommandDictionary").then((m) => ({ default: m.CommandDictionaryPane })));

type TabKind = "home" | "local" | "ssh" | "grid" | "dict";
type SshInfo = { ok: ConnectOk; profile: Profile };
type Tab = { id: string; kind: TabKind; title: string; ssh?: SshInfo; color?: string | null };

const TAB_ICON: Record<TabKind, ReactNode> = {
	home: <House size={14} />,
	local: <SquareTerminal size={14} />,
	ssh: <Server size={14} />,
	grid: <Table2 size={14} />,
	dict: <BookOpen size={14} />,
};
const LEVEL_BADGE: Record<string, string> = { rsa: "구형 SSH · RSA", sha1: "구형 SSH · SHA-1", weakest: "구형 SSH · 최후" };

let seq = 0;
const newTab = (kind: TabKind, title: string, extra?: Partial<Tab>): Tab => ({ id: `${kind}-${++seq}`, kind, title, ...extra });

function greeting(): string {
	const h = new Date().getHours();
	if (h < 6) return "늦은 밤이에요";
	if (h < 12) return "좋은 아침이에요";
	if (h < 18) return "좋은 오후예요";
	return "좋은 저녁이에요";
}

export function App() {
	const [info, setInfo] = useState<AppInfo | null>(null);
	const [localHome, setLocalHome] = useState<string>("");
	const [tabs, setTabs] = useState<Tab[]>(() => [newTab("home", "홈")]);
	const [active, setActive] = useState(tabs[0].id);
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [sheet, setSheet] = useState<Profile | null>(null);
	const [connecting, setConnecting] = useState<Profile | null>(null);
	const [q, setQ] = useState("");
	const { state: upd, install } = useUpdater();

	const reload = useCallback(() => {
		void api.profilesList().then(setProfiles);
	}, []);

	useEffect(() => {
		void api.appInfo().then((i) => {
			setInfo(i);
			document.documentElement.dataset.os = i.os;
			document.documentElement.dataset.backdrop = i.osBackdrop ? "os" : "solid";
		});
		void api.localHome().then(setLocalHome);
		reload();
	}, [reload]);

	// 상태 갱신 함수 안에서 다른 setState 를 부르지 않는다(StrictMode 두 번 실행) — 지금 탭은 ref 로 읽는다
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;

	const open = useCallback((kind: TabKind, title: string, single = false, extra?: Partial<Tab>) => {
		const same = single ? tabsRef.current.find((t) => t.kind === kind) : undefined;
		if (same) {
			setActive(same.id);
			return;
		}
		const t = newTab(kind, title, extra);
		setTabs((ts) => [...ts, t]);
		setActive(t.id);
	}, []);

	const close = useCallback(
		(id: string) => {
			const ts = tabsRef.current;
			if (ts.length === 1) return;
			const t = ts.find((x) => x.id === id);
			if (t?.ssh) void api.sshDisconnect(t.ssh.ok.connId);
			const i = ts.findIndex((x) => x.id === id);
			const next = ts.filter((x) => x.id !== id);
			setTabs(next);
			if (id === active) setActive(next[Math.max(0, i - 1)].id);
		},
		[active],
	);

	const onConnected = useCallback(
		(ok: ConnectOk, p: Profile) => {
			setConnecting(null);
			reload();
			open("ssh", p.name, false, { ssh: { ok, profile: p }, color: p.color });
		},
		[open, reload],
	);

	// 단축키: ⌘/Ctrl+T 새 로컬 터미널, ⌘/Ctrl+W 탭 닫기, ⌘/Ctrl+K 찾기
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = info?.os === "macos" ? e.metaKey : e.ctrlKey;
			if (!mod || e.altKey) return;
			const k = e.key.toLowerCase();
			if (k === "t" && !e.shiftKey) {
				e.preventDefault();
				open("local", "내 PC");
			} else if (k === "w") {
				e.preventDefault();
				close(active);
			} else if (k === "k") {
				e.preventDefault();
				open("home", "홈", true);
				requestAnimationFrame(() => document.getElementById("home-search")?.focus());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [info?.os, open, close, active]);

	const filtered = useMemo(() => {
		const w = q.trim().toLowerCase();
		if (!w) return profiles;
		return profiles.filter((p) => `${p.name} ${p.host} ${p.username} ${p.engine ?? ""}`.toLowerCase().includes(w));
	}, [profiles, q]);
	const ssh = profiles.filter((p) => p.kind === "ssh");
	const dbs = profiles.filter((p) => p.kind === "db");
	const isWin = info?.os === "windows";
	const mod = info?.os === "macos" ? "⌘" : "Ctrl+";
	const win = getCurrentWindow();
	const activeKind = tabs.find((t) => t.id === active)?.kind;

	const connect = (p: Profile) => {
		if (p.kind === "db") {
			alert("DB 접속은 1단계 후반에 붙습니다.");
			return;
		}
		setConnecting(p);
	};

	// 원격·내 PC 백엔드는 탭마다 한 번만 만든다(다시 그릴 때 셸이 다시 열리지 않게)
	const backends = useRef(new Map<string, { fs: ReturnType<typeof localFs>; term: typeof localTerm }>());
	const backendFor = (t: Tab) => {
		let b = backends.current.get(t.id);
		if (!b) {
			b = t.ssh
				? { fs: sshFs(t.ssh.ok.connId, t.ssh.profile.name, t.ssh.ok.home), term: sshTerm(t.ssh.ok.connId) }
				: { fs: localFs(localHome), term: localTerm };
			backends.current.set(t.id, b);
		}
		return b;
	};

	return (
		<div className="app">
			<aside className="sidebar" data-tauri-drag-region>
				<div className="sidebar-head" data-tauri-drag-region>
					<img src={iconUrl} alt="" />
					RuiBotte Shell
				</div>
				<button type="button" className="sb-item" aria-current={activeKind === "home"} onClick={() => open("home", "홈", true)}>
					<House size={16} /> 홈
				</button>
				<button type="button" className="sb-item" aria-current={activeKind === "local"} onClick={() => open("local", "내 PC")}>
					<SquareTerminal size={16} /> 내 PC 터미널
				</button>
				<button type="button" className="sb-item" aria-current={activeKind === "dict"} onClick={() => open("dict", "명령어 사전", true)}>
					<BookOpen size={16} /> 명령어 사전
				</button>

				<div className="sb-section">SSH 서버</div>
				{ssh.length ? (
					ssh.map((p) => (
						<button key={p.id} type="button" className="sb-item" title={`${p.username ? `${p.username}@` : ""}${p.host}:${p.port}`} onClick={() => connect(p)}>
							<span className="dot" style={{ background: p.color ?? "var(--accent)" }} /> {p.name}
						</button>
					))
				) : (
					<button type="button" className="sb-item" style={{ color: "var(--text-3)" }} onClick={() => setSheet(blankProfile("ssh"))}>
						<Plus size={14} /> 서버 추가
					</button>
				)}
				<div className="sb-section">데이터베이스</div>
				{dbs.length ? (
					dbs.map((p) => (
						<button key={p.id} type="button" className="sb-item" title={`${p.engine} ${p.host}:${p.port}`} onClick={() => connect(p)}>
							<span className="dot" style={{ background: p.color ?? "var(--accent)" }} /> {p.name}
						</button>
					))
				) : (
					<button type="button" className="sb-item" style={{ color: "var(--text-3)" }} onClick={() => setSheet(blankProfile("db"))}>
						<Plus size={14} /> DB 추가
					</button>
				)}
				<div className="sb-section">실험</div>
				<button type="button" className="sb-item" aria-current={activeKind === "grid"} onClick={() => open("grid", "결과 표 시제품", true)}>
					<Table2 size={16} /> 결과 표 시제품
				</button>

				<div className="sb-foot">
					{upd.phase === "available" && (
						<button type="button" className="update-pill" onClick={() => void install()}>
							<Download size={14} /> {upd.version} 업데이트 설치
						</button>
					)}
					{upd.phase === "installing" && <span className="update-pill">설치 중… {upd.pct}%</span>}
					{upd.phase === "error" && <span className="err">업데이트 실패: {upd.message}</span>}
					<span>{info ? `v${info.version}${info.portable ? " · 포터블" : ""}` : ""}</span>
				</div>
			</aside>

			<main className="main">
				<div className="titlebar" data-tauri-drag-region>
					<div className="tabs" role="tablist">
						{tabs.map((t) => (
							<button
								key={t.id}
								type="button"
								role="tab"
								className="tab"
								aria-selected={t.id === active}
								onClick={() => setActive(t.id)}
								onAuxClick={(e) => e.button === 1 && close(t.id)}
								style={t.color ? { boxShadow: t.id === active ? `inset 0 -2px 0 ${t.color}, var(--shadow-card)` : `inset 0 -2px 0 ${t.color}` } : undefined}
							>
								{TAB_ICON[t.kind]}
								<span>{t.title}</span>
								{tabs.length > 1 && (
									<span
										className="x"
										role="button"
										aria-label="탭 닫기"
										onClick={(e) => {
											e.stopPropagation();
											close(t.id);
										}}
									>
										<X size={12} />
									</span>
								)}
							</button>
						))}
						<button type="button" className="btn ghost icon" title={`내 PC 터미널 (${mod}T)`} onClick={() => open("local", "내 PC")}>
							<Plus size={15} />
						</button>
					</div>
					<div className="drag" data-tauri-drag-region />
					{isWin && (
						<div className="winctl">
							<button type="button" aria-label="최소화" onClick={() => void win.minimize()}>
								<Minus size={15} strokeWidth={1.5} />
							</button>
							<button type="button" aria-label="최대화" onClick={() => void win.toggleMaximize()}>
								<Square size={12} strokeWidth={1.5} />
							</button>
							<button type="button" className="close" aria-label="닫기" onClick={() => void win.close()}>
								<X size={16} strokeWidth={1.5} />
							</button>
						</div>
					)}
				</div>

				<div className="content">
					{tabs.map((t) => (
						<section key={t.id} className={`pane${t.kind === "home" ? " home" : ""}`} hidden={t.id !== active}>
							{t.kind === "home" && (
								<div className="home-inner">
									<h1>{greeting()}</h1>
									<p className="sub">어디에 접속할까요?</p>
									<label className="search">
										<Search size={17} />
										<input id="home-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="서버·데이터베이스 찾기" spellCheck={false} />
										<kbd>{mod}K</kbd>
									</label>
									<div className="quick">
										<QuickCard color="#0a84ff" icon={<Server size={18} />} title="SSH 서버" desc="터미널·파일·편집기" onClick={() => setSheet(blankProfile("ssh"))} />
										<QuickCard color="#30d158" icon={<Database size={18} />} title="데이터베이스" desc="PostgreSQL·MariaDB·MySQL" onClick={() => setSheet(blankProfile("db"))} />
										<QuickCard color="#5e5ce6" icon={<SquareTerminal size={18} />} title="내 PC 터미널" desc={`이 PC 폴더·셸 (${mod}T)`} onClick={() => open("local", "내 PC")} />
										<QuickCard color="#ff9f0a" icon={<BookOpen size={18} />} title="명령어 사전" desc="358개 리눅스 명령 한국어" onClick={() => open("dict", "명령어 사전", true)} />
									</div>
									<h2>내 연결</h2>
									{filtered.length ? (
										<div className="plist">
											{filtered.map((p) => (
												<div
													key={p.id}
													className="pcard"
													role="button"
													tabIndex={0}
													onClick={() => connect(p)}
													onKeyDown={(e) => e.key === "Enter" && connect(p)}
												>
													<span style={{ width: 10, height: 10, borderRadius: "50%", flex: "none", background: p.color ?? "var(--accent)" }} />
													<div className="meta">
														<b>{p.name}</b>
														<small>
															{p.kind === "db" ? `${p.engine} · ` : ""}
															{p.username ? `${p.username}@` : ""}
															{p.host}:{p.port}
														</small>
													</div>
													{p.legacy !== "off" && <span className="badge warn">{LEVEL_BADGE[p.legacy]}</span>}
													<button
														type="button"
														className="btn ghost icon"
														aria-label="고치기"
														onClick={(e) => {
															e.stopPropagation();
															setSheet(p);
														}}
													>
														<Pencil size={13} />
													</button>
													<button
														type="button"
														className="btn ghost icon"
														aria-label="지우기"
														onClick={(e) => {
															e.stopPropagation();
															if (p.id != null && confirm(`${p.name} 연결을 지울까요? 저장한 암호도 함께 지웁니다.`)) void api.profileDelete(p.id).then(reload);
														}}
													>
														<X size={14} />
													</button>
												</div>
											))}
										</div>
									) : (
										<div className="empty">{q ? "맞는 연결이 없습니다." : "저장한 연결이 없습니다. 위에서 SSH 서버나 데이터베이스를 추가하세요."}</div>
									)}
								</div>
							)}
							<Suspense fallback={null}>
								{t.kind === "local" && localHome && (
									<Workbench fs={backendFor(t).fs} term={backendFor(t).term} active={t.id === active} label="내 PC 셸" />
								)}
								{t.kind === "ssh" && t.ssh && (
									<Workbench
										fs={backendFor(t).fs}
										term={backendFor(t).term}
										active={t.id === active}
										label={`${t.ssh.profile.username}@${t.ssh.profile.host}`}
										startPath={t.ssh.profile.defaultPath ?? undefined}
										badge={
											t.ssh.profile.legacy !== "off" ? (
												<span className="badge warn" title="이 서버에는 오래된 알고리즘을 허용했습니다">
													{LEVEL_BADGE[t.ssh.profile.legacy]}
												</span>
											) : (
												<span className="badge" title={t.ssh.ok.fingerprint}>
													{t.ssh.ok.algorithm}
												</span>
											)
										}
									/>
								)}
								{t.kind === "grid" && <ResultGridPane />}
								{t.kind === "dict" && <CommandDictionaryPane />}
							</Suspense>
						</section>
					))}
				</div>
			</main>

			{sheet && (
				<ProfileSheet
					initial={sheet}
					onClose={() => setSheet(null)}
					onSaved={() => {
						setSheet(null);
						reload();
					}}
				/>
			)}
			{connecting && <ConnectDialog profile={connecting} onConnected={onConnected} onCancel={() => setConnecting(null)} onProfileChanged={reload} />}
		</div>
	);
}

function QuickCard(props: { color: string; icon: ReactNode; title: string; desc: string; onClick: () => void }) {
	return (
		<button type="button" className="qcard" onClick={props.onClick}>
			<span className="ic" style={{ background: props.color }}>
				{props.icon}
			</span>
			<b>{props.title}</b>
			<small>{props.desc}</small>
		</button>
	);
}
