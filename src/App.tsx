import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, ListTree, ChevronDown, ChevronRight, Database, Download, Settings as SettingsIcon, FileDown, FileUp, Folder, House, KeyRound, Minus, Pencil, Play, Plus, RotateCcw, Search, Server, Square, SquareTerminal, Table2, Unplug, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "../assets/icon.svg?url";
import { ConnectDialog } from "./components/ConnectDialog";
import { Select } from "./components/Select";
import { confirmDiscard, dirtyTitles } from "./lib/dirty";
import { ConnectionsPane } from "./components/ConnectionsPane";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DbConnectDialog, type DbConnectOk } from "./components/DbConnectDialog";
import { ExportSheet, ImportSheet } from "./components/ImportSheet";
import { blankProfile, ProfileSheet } from "./components/ProfileSheet";
import { type AppInfo, api, type ConnectOk, localFs, localTerm, type Profile, runningTransfers, sshFs, sshTerm } from "./lib/ipc";
import { installNow, startUpdater, useUpdate } from "./lib/updater";

// 무거운 칸(xterm·편집기·표·사전)은 처음 열 때 받는다 — 첫 화면(홈)은 가볍게
const Workbench = lazy(() => import("./components/Workbench").then((m) => ({ default: m.Workbench })));
const ResultGridPane = lazy(() => import("./components/ResultGrid").then((m) => ({ default: m.ResultGridPane })));
const SettingsPane = lazy(() => import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })));
const DbWorkbench = lazy(() => import("./components/DbWorkbench").then((m) => ({ default: m.DbWorkbench })));
const CommandDictionaryPane = lazy(() => import("./components/CommandDictionary").then((m) => ({ default: m.CommandDictionaryPane })));

type TabKind = "home" | "local" | "ssh" | "db" | "grid" | "dict" | "settings" | "connections";
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
	connections: <ListTree size={14} />,
};
/** 마지막 접속 — 초(유닉스) → "3시간 전" */
function ago(t: number) {
	const s = Math.max(0, Date.now() / 1000 - t);
	if (s < 60) return "방금";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
	return new Date(t * 1000).toLocaleDateString();
}
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

	// 지난번 열려 있던 연결(앱을 다시 켜면 홈에서 한 번에 다시 열기)
	const [lastSession, setLastSession] = useState<number[]>([]);
	const sessionLoaded = useRef(false);
	useEffect(() => {
		void api.settingGet("session.open").then((v) => {
			try {
				setLastSession(v ? (JSON.parse(v) as number[]) : []);
			} catch {
				setLastSession([]);
			}
			sessionLoaded.current = true;
		});
	}, []);
	useEffect(() => {
		if (!sessionLoaded.current) return;
		const ids = tabs.map((t) => t.ssh?.profile.id ?? t.db?.profile.id).filter((x): x is number => x != null);
		if (ids.length) {
			setLastSession([]);
			void api.settingSet("session.open", JSON.stringify([...new Set(ids)]));
		} else if (!lastSession.length) void api.settingSet("session.open", "[]");
	}, [tabs, lastSession.length]);

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
			if (!confirmDiscard(dirtyTitles(id), "이 탭을 닫으면")) return;
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

	// 내 연결 조회 — 종류·묶음 거르기·정렬, 지금 조회를 시작 화면으로 고정, 묶음 고정(맨 위·펼침)
	const [kindF, setKindF] = useState<"all" | "ssh" | "db" | "fav">("all");
	const [groupF, setGroupF] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<"fav" | "name" | "recent" | "host">("fav");
	const [pinnedGroups, setPinnedGroups] = useState<string[]>([]);
	const [viewPinned, setViewPinned] = useState(false);
	useEffect(() => {
		void api.settingGet("home.view").then((v) => {
			if (!v) return;
			try {
				const o = JSON.parse(v) as { q?: string; kind?: typeof kindF; group?: string | null; sort?: typeof sortBy };
				setQ(o.q ?? "");
				setKindF(o.kind ?? "all");
				setGroupF(o.group ?? null);
				setSortBy(o.sort ?? "fav");
				setViewPinned(true);
			} catch {
				// 무시
			}
		});
		void api.settingGet("home.pinnedGroups").then((v) => {
			try {
				setPinnedGroups(v ? (JSON.parse(v) as string[]) : []);
			} catch {
				setPinnedGroups([]);
			}
		});
	}, []);
	const togglePinGroup = (g: string) => {
		const next = pinnedGroups.includes(g) ? pinnedGroups.filter((x) => x !== g) : [...pinnedGroups, g];
		setPinnedGroups(next);
		void api.settingSet("home.pinnedGroups", JSON.stringify(next));
	};
	const pinView = (on: boolean) => {
		setViewPinned(on);
		void api.settingSet("home.view", on ? JSON.stringify({ q, kind: kindF, group: groupF, sort: sortBy }) : "");
	};
	const allGroups = useMemo(() => [...new Set(profiles.map((p) => p.groupName?.trim()).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ko")), [profiles]);
	const filtered = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = profiles.filter((p) => {
			if (kindF === "ssh" && p.kind !== "ssh") return false;
			if (kindF === "db" && p.kind !== "db") return false;
			if (kindF === "fav" && !p.favorite) return false;
			if (groupF !== null && (p.groupName?.trim() || "") !== groupF) return false;
			if (!words.length) return true;
			const hay = [p.name, p.host, p.username, p.engine, p.groupName, p.memo, p.database, `${p.host}:${p.port}`].filter(Boolean).join(" ").toLowerCase();
			return words.every((w) => hay.includes(w));
		});
		list = [...list].sort((a, b) => {
			if (sortBy === "name") return a.name.localeCompare(b.name, "ko");
			if (sortBy === "host") return a.host.localeCompare(b.host) || a.port - b.port;
			if (sortBy === "recent") return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
			return Number(b.favorite) - Number(a.favorite) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name, "ko");
		});
		return list;
	}, [profiles, q, kindF, groupF, sortBy]);
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
		// 고정한 묶음 먼저(고정한 순서), 그다음 이름순, 묶지 않음은 맨 뒤
		const rank = (g: string) => (pinnedGroups.includes(g) ? pinnedGroups.indexOf(g) : 1000);
		return [...m.entries()].sort(([a], [b]) => rank(a) - rank(b) || (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
	};
	// 사이드바: 즐겨찾기(★) + 즐겨찾기가 아닌 최근 5개 — 나머지는 연결 관리·홈에서
	const favs = profiles.filter((p) => p.favorite).sort((a, b) => a.name.localeCompare(b.name, "ko"));
	const recent = profiles
		.filter((p) => !p.favorite && p.lastUsedAt)
		.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
		.slice(0, 5);
	const sbRow = (p: Profile) => (
		<div
			key={p.id}
			className="sb-row"
			onContextMenu={(e) => {
				e.preventDefault();
				setPmenu({ x: e.clientX, y: e.clientY, p });
			}}
		>
			<button type="button" className="sb-item" title={`${p.kind === "db" ? `${p.engine} ` : ""}${p.username ? `${p.username}@` : ""}${p.host}:${p.port}${p.memo ? `\n${p.memo}` : ""} — 눌러 접속`} onClick={() => connect(p)}>
				<span className="dot" style={{ background: p.color ?? "var(--accent)" }} />
				{p.kind === "ssh" ? <Server size={12} className="sb-kind" /> : <Database size={12} className="sb-kind" />}
				<span className="sb-name">{p.name}</span>
			</button>
			<span className="sb-acts">
				<button type="button" className="sb-act" title="접속" onClick={() => connect(p)}>
					<Play size={12} />
				</button>
				<button type="button" className="sb-act" title="설정" onClick={() => editProfile(p)}>
					<Pencil size={12} />
				</button>
			</span>
		</div>
	);
	const isWin = info?.os === "windows";
	const mod = info?.os === "macos" ? "⌘" : "Ctrl+";
	const win = getCurrentWindow();
	// 앱을 끌 때: 저장 안 한 편집기가 있으면 묻는다(창 단추·Alt+F4·작업 표시줄 모두)
	useEffect(() => {
		const un = win.onCloseRequested((e) => {
			if (runningTransfers.size && !confirm(`전송 ${runningTransfers.size}개가 아직 돌고 있습니다. 끄면 멈춥니다(나중에 "다시(이어서)" 로 이어 받을 수 있음). 끌까요?`)) {
				e.preventDefault();
				return;
			}
			if (!confirmDiscard(dirtyTitles(), "앱을 끄면")) e.preventDefault();
		});
		// 도는 전송 세기
		const unT = listen<{ id: number; state: string }>("transfer", (ev) => {
			if (ev.payload.state === "running") runningTransfers.add(ev.payload.id);
			else runningTransfers.delete(ev.payload.id);
		});
		return () => {
			void un.then((f) => f());
			void unT.then((f) => f());
		};
	}, [win]);
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
				<button type="button" className="sb-item" aria-current={activeKind === "connections"} onClick={() => open("connections", "연결 관리", true)}>
					<ListTree size={16} /> 연결 관리
				</button>

				<div className="sb-section">즐겨찾기</div>
				{favs.length ? (
					favs.map((p) => sbRow(p))
				) : (
					<div className="sb-hint">연결 카드의 ☆ 를 누르면 여기에 둡니다</div>
				)}
				{recent.length > 0 && (
					<>
						<div className="sb-section">최근</div>
						{recent.map((p) => sbRow(p))}
					</>
				)}
				<button type="button" className="sb-item sb-more" onClick={() => open("connections", "연결 관리", true)}>
					<ListTree size={14} /> 모든 연결 {profiles.length ? `(${profiles.length})` : ""}
				</button>
				<button type="button" className="sb-item sb-more" onClick={() => setSheet(blankProfile("ssh"))}>
					<Plus size={14} /> 새 연결
				</button>

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
									{lastSession.length > 0 && profiles.some((p) => p.id != null && lastSession.includes(p.id)) && (
										<div className="resume-bar">
											<span>
												지난번에 열려 있던 연결 —{" "}
												{profiles
													.filter((p) => p.id != null && lastSession.includes(p.id))
													.map((p) => p.name)
													.join(", ")}
											</span>
											<button
												type="button"
												className="btn primary"
												onClick={() => {
													const list = profiles.filter((p) => p.id != null && lastSession.includes(p.id));
													setLastSession([]);
													// 하나씩(암호 창이 겹치지 않게) — 첫 것만 바로, 나머지는 잠깐씩 띄워서
													list.forEach((p, i) => window.setTimeout(() => connect(p), i * 400));
												}}
											>
												다시 열기
											</button>
											<button type="button" className="btn ghost" onClick={() => setLastSession([])}>
												닫기
											</button>
										</div>
									)}
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
										<h2 style={{ margin: 0, flex: 1 }}>
											내 연결 <small className="count">{filtered.length === profiles.length ? profiles.length : `${filtered.length} / ${profiles.length}`}</small>
										</h2>
										<button type="button" className="btn ghost" onClick={() => open("connections", "연결 관리", true)} title="연결 만들기·고치기·지우기·묶음 — 한 화면에서">
											<ListTree size={14} /> 연결 관리
										</button>
										<button type="button" className="btn ghost" onClick={() => setImporting(true)} title="~/.ssh/config·PuTTY 에서">
											<FileDown size={14} /> 가져오기
										</button>
										<button type="button" className="btn ghost" onClick={() => setExporting(true)} title="ssh config 로">
											<FileUp size={14} /> 내보내기
										</button>
									</div>
									<div className="find-bar">
										<div className="seg tiny" role="group">
											{(
												[
													["all", "전체"],
													["ssh", "SSH"],
													["db", "DB"],
													["fav", "★ 즐겨찾기"],
												] as const
											).map(([k, l]) => (
												<button key={k} type="button" aria-pressed={kindF === k} onClick={() => setKindF(k)}>
													{l}
												</button>
											))}
										</div>
										{allGroups.length > 0 && (
											<div className="chips" style={{ margin: 0 }}>
												{allGroups.map((g) => (
													<button key={g} type="button" className={`chip${groupF === g ? " on" : ""}`} onClick={() => setGroupF(groupF === g ? null : g)}>
														{pinnedGroups.includes(g) ? "📌 " : ""}
														{g}
													</button>
												))}
											</div>
										)}
										<span style={{ flex: 1 }} />
										<Select<"fav" | "name" | "recent" | "host">
											size="sm"
											value={sortBy}
											onChange={setSortBy}
											title="정렬"
											options={[
												{ value: "fav", label: "즐겨찾기·최근 순" },
												{ value: "recent", label: "최근 접속 순" },
												{ value: "name", label: "이름 순" },
												{ value: "host", label: "주소 순" },
											]}
										/>
										<button
											type="button"
											className={`btn ghost${viewPinned ? " on" : ""}`}
											title={viewPinned ? "시작 화면 고정 풀기" : "지금 조회(검색어·종류·묶음·정렬)를 앱을 켤 때 그대로 보이게 고정"}
											onClick={() => pinView(!viewPinned)}
										>
											📌 {viewPinned ? "고정됨" : "이 조회 고정"}
										</button>
										{(q || kindF !== "all" || groupF !== null) && (
											<button
												type="button"
												className="btn ghost"
												onClick={() => {
													setQ("");
													setKindF("all");
													setGroupF(null);
												}}
											>
												모두 보기
											</button>
										)}
									</div>
									{filtered.length ? (
										grouped(filtered).map(([g, items]) => (
											<section key={g || "-"} className="pgroup">
												{(g || grouped(filtered).length > 1) && (
													<button type="button" className="pgroup-head" onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
														{folded.has(g) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
														<Folder size={13} /> {g || "묶지 않음"} <small>{items.length}</small>
														{g && (
															<span
																role="button"
																tabIndex={-1}
																className={`pin${pinnedGroups.includes(g) ? " on" : ""}`}
																title={pinnedGroups.includes(g) ? "고정 풀기" : "이 묶음 고정(맨 위·늘 펼침)"}
																onClick={(e) => {
																	e.stopPropagation();
																	togglePinGroup(g);
																}}
															>
																📌
															</span>
														)}
													</button>
												)}
												{(!folded.has(g) || pinnedGroups.includes(g)) && (
													<div className="plist">
														{items.map((p) => (
															<div
																key={p.id}
																className="pcard"
																title={p.memo ?? undefined}
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
																		<button
																			type="button"
																			className={`star${p.favorite ? " on" : ""}`}
																			title={p.favorite ? "즐겨찾기 빼기" : "즐겨찾기(목록 맨 위)"}
																			onClick={(e) => {
																				e.stopPropagation();
																				void api.profileSave({ ...p, favorite: !p.favorite }).then(reload);
																			}}
																		>
																			{p.favorite ? "★" : "☆"}
																		</button>
																		<span className="nm">{p.name}</span>
																		{p.legacy !== "off" && <span className="badge warn">{LEVEL_BADGE[p.legacy]}</span>}
																	</b>
																	<small>
																		{p.secretSaved && <KeyRound size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
																		{p.kind === "db" ? `${p.engine} · ` : ""}
																		{p.username ? `${p.username}@` : ""}
																		{p.host}:{p.port}
																		{p.lastUsedAt ? <span className="last-used"> · {ago(p.lastUsedAt)}</span> : null}
																	</small>
																	{p.memo && <small className="memo">{p.memo}</small>}
																</div>
																<button
																	type="button"
																	className="btn pc-connect"
																	title="접속"
																	onClick={(e) => {
																		e.stopPropagation();
																		connect(p);
																	}}
																>
																	<Play size={12} /> 접속
																</button>
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
									<Workbench ownerId={t.id} fs={backendFor(t).fs} term={backendFor(t).term} active={t.id === active} label="내 PC 셸" layoutKey="layout.local" />
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
										ownerId={t.id}
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
								{t.kind === "connections" && (
									<ConnectionsPane profiles={profiles} reload={reload} onConnect={connect} onImport={() => setImporting(true)} onExport={() => setExporting(true)} />
								)}
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
