import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, ChevronDown, ChevronRight, Database, Download, Settings as SettingsIcon, FileDown, FileUp, Folder, House, KeyRound, Minus, Pencil, Plus, RotateCcw, Search, Server, Square, SquareTerminal, Table2, Unplug, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "../assets/icon.svg?url";
import { ConnectDialog } from "./components/ConnectDialog";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DbConnectDialog, type DbConnectOk } from "./components/DbConnectDialog";
import { ExportSheet, ImportSheet } from "./components/ImportSheet";
import { blankProfile, ProfileSheet } from "./components/ProfileSheet";
import { type AppInfo, api, type ConnectOk, localFs, localTerm, type Profile, sshFs, sshTerm } from "./lib/ipc";
import { installNow, startUpdater, useUpdate } from "./lib/updater";

// 무거운 칸(xterm·편집기·표·사전)은 처음 열 때 받는다 — 첫 화면(홈)은 가볍게
const Workbench = lazy(() => import("./components/Workbench").then((m) => ({ default: m.Workbench })));
const ResultGridPane = lazy(() => import("./components/ResultGrid").then((m) => ({ default: m.ResultGridPane })));
const SettingsPane = lazy(() => import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })));
const DbWorkbench = lazy(() => import("./components/DbWorkbench").then((m) => ({ default: m.DbWorkbench })));
const CommandDictionaryPane = lazy(() => import("./components/CommandDictionary").then((m) => ({ default: m.CommandDictionaryPane })));

type TabKind = "home" | "local" | "ssh" | "db" | "grid" | "dict" | "settings";
type DbInfo = { ok: DbConnectOk; profile: Profile; readOnly: boolean };
type SshInfo = { ok: ConnectOk; profile: Profile; closed?: boolean };
type Tab = { id: string; kind: TabKind; title: string; ssh?: SshInfo; db?: DbInfo; color?: string | null };

const TAB_ICON: Record<TabKind, ReactNode> = {
	home: <House size={14} />,
	local: <SquareTerminal size={14} />,
	ssh: <Server size={14} />,
	db: <Database size={14} />,
	grid: <Table2 size={14} />,
	dict: <BookOpen size={14} />,
	settings: <SettingsIcon size={14} />,
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
	const [connecting, setConnecting] = useState<{ p: Profile; tabId?: string } | null>(null);
	const [dbConnecting, setDbConnecting] = useState<Profile | null>(null);
	const [importing, setImporting] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [q, setQ] = useState("");
	/** 시트를 다시 열 때(복제 등) 새로 그리게 */
	const [sheetKey, setSheetKey] = useState(0);
	const [pmenu, setPmenu] = useState<{ x: number; y: number; p: Profile } | null>(null);
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const upd = useUpdate();

	const reload = useCallback(() => {
		void api.profilesList().then(setProfiles);
	}, []);

	useEffect(() => {
		void api.appInfo().then((i) => {
			setInfo(i);
			document.documentElement.dataset.os = i.os;
			document.documentElement.dataset.backdrop = i.osBackdrop ? "os" : "solid";
			startUpdater(i.version, i.portable);
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
			if (t?.db) void invoke("db_disconnect", { conn: t.db.ok.connId });
			const i = ts.findIndex((x) => x.id === id);
			const next = ts.filter((x) => x.id !== id);
			setTabs(next);
			if (id === active) setActive(next[Math.max(0, i - 1)].id);
		},
		[active],
	);

	const onConnected = useCallback(
		(ok: ConnectOk, p: Profile, tabId?: string) => {
			setConnecting(null);
			reload();
			if (tabId) {
				// 다시 연결 — 같은 탭에 새 연결(작업대는 새로 그려지고 배치는 저장본 그대로)
				backends.current.delete(tabId);
				setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, ssh: { ok, profile: p } } : t)));
				setActive(tabId);
				return;
			}
			open("ssh", p.name, false, { ssh: { ok, profile: p }, color: p.color });
		},
		[open, reload],
	);

	// 연결 끊김 — 탭에 표시하고, 저장한 암호가 있으면 바로 다시 연결을 시도
	useEffect(() => {
		const un = listen<{ conn: number }>("ssh-closed", (e) => {
			const t = tabsRef.current.find((x) => x.ssh?.ok.connId === e.payload.conn);
			if (!t?.ssh) return;
			setTabs((ts) => ts.map((x) => (x.id === t.id && x.ssh ? { ...x, ssh: { ...x.ssh, closed: true } } : x)));
			if (t.ssh.profile.secretSaved || t.ssh.profile.auth === "key") setConnecting({ p: t.ssh.profile, tabId: t.id });
		});
		return () => void un.then((f) => f());
	}, []);

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
	const editProfile = (p: Profile) => {
		setSheetKey((k) => k + 1);
		setSheet(p);
	};
	const profileMenu = (p: Profile): MenuItem[] => [
		{ label: "접속", run: () => connect(p) },
		{ label: "설정…", run: () => editProfile(p) },
		{ label: "복제", run: () => editProfile({ ...p, id: undefined, name: `${p.name} 복사본`, secretSaved: false }) },
		...(p.secretSaved ? [{ label: "저장한 암호 지우기", run: () => void invoke("secret_forget", { profileId: p.id }).then(reload) }] : []),
		{ sep: true as const },
		{
			label: "지우기",
			danger: true,
			run: () => {
				if (p.id != null && confirm(`${p.name} 연결을 지울까요? 저장한 암호도 함께 지웁니다.`)) void api.profileDelete(p.id).then(reload);
			},
		},
	];
	/** 묶음별로 — 이름순, 묶지 않은 것은 맨 뒤 */
	const grouped = (list: Profile[]) => {
		const m = new Map<string, Profile[]>();
		for (const p of list) {
			const g = p.groupName?.trim() || "";
			m.set(g, [...(m.get(g) ?? []), p]);
		}
		return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
	};
	const sbList = (list: Profile[], title: (p: Profile) => string) =>
		grouped(list).map(([g, items]) => {
			const key = `sb:${g}`;
			return (
				<div key={g || "-"}>
					{g && (
						<button type="button" className="sb-group" onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
							{folded.has(key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {g}
						</button>
					)}
					{!folded.has(key) &&
						items.map((p) => (
							<button
								key={p.id}
								type="button"
								className={`sb-item${g ? " in-group" : ""}`}
								title={title(p)}
								onClick={() => connect(p)}
								onContextMenu={(e) => {
									e.preventDefault();
									setPmenu({ x: e.clientX, y: e.clientY, p });
								}}
							>
								<span className="dot" style={{ background: p.color ?? "var(--accent)" }} /> {p.name}
							</button>
						))}
				</div>
			);
		});
	const isWin = info?.os === "windows";
	const mod = info?.os === "macos" ? "⌘" : "Ctrl+";
	const win = getCurrentWindow();
	const activeKind = tabs.find((t) => t.id === active)?.kind;

	const connect = (p: Profile) => {
		if (p.kind === "db") {
			setDbConnecting(p);
			return;
		}
		setConnecting({ p });
	};

	// 원격·내 PC 백엔드는 탭마다 한 번만 만든다(다시 그릴 때 셸이 다시 열리지 않게)
	const backends = useRef(new Map<string, { fs: ReturnType<typeof localFs>; term: typeof localTerm; local?: ReturnType<typeof localFs> }>());
	const backendFor = (t: Tab) => {
		let b = backends.current.get(t.id);
		if (!b) {
			b = t.ssh
				? { fs: sshFs(t.ssh.ok.connId, t.ssh.profile.name, t.ssh.ok.home), term: sshTerm(t.ssh.ok.connId), local: localFs(localHome) }
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
					sbList(ssh, (p) => `${p.username ? `${p.username}@` : ""}${p.host}:${p.port}`)
				) : (
					<button type="button" className="sb-item" style={{ color: "var(--text-3)" }} onClick={() => setSheet(blankProfile("ssh"))}>
						<Plus size={14} /> 서버 추가
					</button>
				)}
				<div className="sb-section">데이터베이스</div>
				{dbs.length ? (
					sbList(dbs, (p) => `${p.engine} ${p.host}:${p.port}`)
				) : (
					<button type="button" className="sb-item" style={{ color: "var(--text-3)" }} onClick={() => setSheet(blankProfile("db"))}>
						<Plus size={14} /> DB 추가
					</button>
				)}

				<div className="sb-foot">
					{upd.phase === "available" && (
						<button type="button" className="update-pill" onClick={() => void installNow()} title={upd.portable ? "포터블판 — 릴리스 페이지에서 새 파일 받기" : "받아서 설치하고 다시 켭니다"}>
							<Download size={14} /> {upd.latest} {upd.portable ? "새 파일 받기" : "업데이트 설치"}
						</button>
					)}
					{(upd.phase === "downloading" || upd.phase === "installing") && (
						<span className="update-pill">{upd.phase === "installing" ? "설치 중…" : `받는 중… ${upd.pct ?? 0}%`}</span>
					)}
					<button type="button" className="sb-item" aria-current={activeKind === "settings"} onClick={() => open("settings", "설정", true)}>
						<SettingsIcon size={16} /> 설정 <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 11 }}>{info ? `v${info.version}${info.portable ? " · 포터블" : ""}` : ""}</span>
					</button>
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
						<section key={t.id} className={`pane${t.kind === "home" || t.kind === "settings" ? " home" : ""}`} hidden={t.id !== active}>
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
									<div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
										<h2 style={{ margin: 0, flex: 1 }}>내 연결</h2>
										<button type="button" className="btn ghost" onClick={() => setImporting(true)} title="~/.ssh/config·PuTTY 에서">
											<FileDown size={14} /> 가져오기
										</button>
										<button type="button" className="btn ghost" onClick={() => setExporting(true)} title="ssh config 로">
											<FileUp size={14} /> 내보내기
										</button>
									</div>
									{filtered.length ? (
										grouped(filtered).map(([g, items]) => (
											<section key={g || "-"} className="pgroup">
												{(g || grouped(filtered).length > 1) && (
													<button type="button" className="pgroup-head" onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
														{folded.has(g) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
														<Folder size={13} /> {g || "묶지 않음"} <small>{items.length}</small>
													</button>
												)}
												{!folded.has(g) && (
													<div className="plist">
														{items.map((p) => (
															<div
																key={p.id}
																className="pcard"
																role="button"
																tabIndex={0}
																onClick={() => connect(p)}
																onKeyDown={(e) => e.key === "Enter" && connect(p)}
																onContextMenu={(e) => {
																	e.preventDefault();
																	setPmenu({ x: e.clientX, y: e.clientY, p });
																}}
															>
																<span style={{ width: 10, height: 10, borderRadius: "50%", flex: "none", background: p.color ?? "var(--accent)" }} />
																<div className="meta">
																	<b>
																		<span className="nm">{p.name}</span>
																		{p.legacy !== "off" && <span className="badge warn">{LEVEL_BADGE[p.legacy]}</span>}
																	</b>
																	<small>
																		{p.secretSaved && <KeyRound size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
																		{p.kind === "db" ? `${p.engine} · ` : ""}
																		{p.username ? `${p.username}@` : ""}
																		{p.host}:{p.port}
																	</small>
																</div>
																<button
																	type="button"
																	className="btn ghost icon"
																	aria-label="설정"
																	title="설정(고치기·복제·지우기) — 우클릭 메뉴도 있습니다"
																	onClick={(e) => {
																		e.stopPropagation();
																		editProfile(p);
																	}}
																>
																	<Pencil size={13} />
																</button>
															</div>
														))}
													</div>
												)}
											</section>
										))
									) : (
										<div className="empty">{q ? "맞는 연결이 없습니다." : "저장한 연결이 없습니다. 위에서 SSH 서버나 데이터베이스를 추가하세요."}</div>
									)}
								</div>
							)}
							<Suspense fallback={null}>
								{t.kind === "local" && localHome && (
									<Workbench fs={backendFor(t).fs} term={backendFor(t).term} active={t.id === active} label="내 PC 셸" layoutKey="layout.local" />
								)}
								{t.kind === "ssh" && t.ssh?.closed && (
									<div className="closed-banner">
										<Unplug size={15} /> 연결이 끊겼습니다. 열린 파일의 저장 안 된 내용은 다시 연결하면 사라집니다.
										<button type="button" className="btn primary" onClick={() => t.ssh && setConnecting({ p: t.ssh.profile, tabId: t.id })}>
											<RotateCcw size={13} /> 다시 연결
										</button>
									</div>
								)}
								{t.kind === "ssh" && t.ssh && (
									<Workbench
										key={t.ssh.ok.connId}
										fs={backendFor(t).fs}
										local={backendFor(t).local}
										term={backendFor(t).term}
										layoutKey="layout.ssh"
										profileId={t.ssh.profile.id}
										peers={tabs
											.filter((x) => x.ssh && x.id !== t.id && !x.ssh.closed)
											.map((x) => ({ conn: x.ssh?.ok.connId as number, label: x.ssh?.profile.name ?? "", home: x.ssh?.ok.home ?? "/" }))}
										syncInfo={{ user: t.ssh.profile.username, host: t.ssh.profile.host, port: t.ssh.profile.port }}
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
								{t.kind === "db" && t.db && (
									<DbWorkbench
										conn={t.db.ok.connId}
										engine={t.db.profile.engine ?? "postgres"}
										readOnly={t.db.readOnly}
										version={t.db.ok.version}
										profileId={t.db.profile.id}
										active={t.id === active}
										features={t.db.ok.features}
									/>
								)}
								{t.kind === "grid" && <ResultGridPane />}
								{t.kind === "settings" && <SettingsPane info={info} />}
								{t.kind === "dict" && <CommandDictionaryPane />}
							</Suspense>
						</section>
					))}
				</div>
			</main>

			{sheet && (
				<ProfileSheet
					key={sheetKey}
					others={profiles}
					initial={sheet}
					onClose={() => setSheet(null)}
					onSaved={() => {
						setSheet(null);
						reload();
					}}
					onDeleted={() => {
						setSheet(null);
						reload();
					}}
					onDuplicate={(p) => editProfile(p)}
				/>
			)}
			{pmenu && <ContextMenu x={pmenu.x} y={pmenu.y} items={profileMenu(pmenu.p)} onClose={() => setPmenu(null)} />}
			{connecting && (
				<ConnectDialog
					profile={connecting.p}
					onConnected={(ok, p) => onConnected(ok, p, connecting.tabId)}
					onCancel={() => setConnecting(null)}
					onProfileChanged={reload}
				/>
			)}
			{dbConnecting && (
				<DbConnectDialog
					profile={dbConnecting}
					onCancel={() => setDbConnecting(null)}
					onConnected={(ok, readOnly) => {
						const p = dbConnecting;
						setDbConnecting(null);
						reload();
						open("db", p.name, false, { db: { ok, profile: p, readOnly }, color: p.color });
					}}
				/>
			)}
			{importing && (
				<ImportSheet
					onClose={() => setImporting(false)}
					onDone={() => {
						setImporting(false);
						reload();
					}}
				/>
			)}
			{exporting && <ExportSheet onClose={() => setExporting(false)} />}
		</div>
	);
}

function QuickCard(props: { color: string; icon: ReactNode; title: string; desc: string; onClick: () => void }) {
	return (
		<button type="button" className="qcard" onClick={props.onClick}>
			<span className="ic" style={{ background: props.color }}>
				{props.icon}
			</span>
			<span className="qtext">
				<b>{props.title}</b>
				<small>{props.desc}</small>
			</span>
		</button>
	);
}
