import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, Command as CommandIcon, ListTree, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, Database, Download, Settings as SettingsIcon, FileDown, FileUp, Folder, House, KeyRound, Minus, Pencil, Play, Plus, RotateCcw, Search, Server, Square, SquareTerminal, Table2, Unplug, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "../assets/icon.svg?url";
import { ConnectDialog } from "./components/ConnectDialog";
import { Select } from "./components/Select";
import { confirmOpenTx } from "./lib/dbTx";
import { confirmDiscard, dirtyTitles } from "./lib/dirty";
import { ConnectionsPane } from "./components/ConnectionsPane";
import { KeysPane } from "./components/KeysPane";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DbConnectDialog, type DbConnectOk } from "./components/DbConnectDialog";
import { ExportSheet, ImportSheet } from "./components/ImportSheet";
import { blankProfile, ProfileSheet } from "./components/ProfileSheet";
import { routeTitle, routeWorthShowing } from "./components/RouteChip";
import { agoMs, ServerCard } from "./components/ServerCard";
import { type Account, accountName, type AppInfo, api, type ConnectOk, defaultAccount, localFs, localTerm, type Profile, runningTransfers, sshFs, sshTerm, withAccount } from "./lib/ipc";
import { checkNow, installNow, startUpdater, useUpdate } from "./lib/updater";
import { CommandPalette } from "./components/CommandPalette";
import { type Command, OPEN_PALETTE_EVENT, requestSettingsSection, SETTINGS_SECTIONS, type SettingsSection, useCommands } from "./lib/commands";
import { type AppTheme, getAppearance, loadAppearance, setAppearance, TERM_SCHEMES } from "./lib/theme";

// 무거운 칸(xterm·편집기·표·사전)은 처음 열 때 받는다 — 첫 화면(홈)은 가볍게
const Workbench = lazy(() => import("./components/Workbench").then((m) => ({ default: m.Workbench })));
const ResultGridPane = lazy(() => import("./components/ResultGrid").then((m) => ({ default: m.ResultGridPane })));
const SettingsPane = lazy(() => import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })));
const DbWorkbench = lazy(() => import("./components/DbWorkbench").then((m) => ({ default: m.DbWorkbench })));
const CommandDictionaryPane = lazy(() => import("./components/CommandDictionary").then((m) => ({ default: m.CommandDictionaryPane })));

type TabKind = "home" | "local" | "ssh" | "db" | "grid" | "dict" | "settings" | "connections" | "keys";
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
	keys: <KeyRound size={14} />,
};
/** 지난 세션 한 칸 — 서버와 그때 쓴 계정 */
type SessionItem = { p: number; a?: number };
function parseSession(v: string | null): SessionItem[] {
	try {
		const raw = v ? (JSON.parse(v) as unknown[]) : [];
		// 예전 판은 서버 번호만 적었다
		return raw.map((x) => (typeof x === "number" ? { p: x } : (x as SessionItem))).filter((x) => typeof x?.p === "number");
	} catch {
		return [];
	}
}
/** 탭 제목 — 계정@서버 */
const tabTitle = (p: Profile) => (p.username ? `${p.username}@${p.name}` : p.name);
const KIND_LABEL: Record<TabKind, string> = {
	home: "홈",
	local: "내 PC 터미널",
	ssh: "SSH",
	db: "DB",
	grid: "결과 표",
	dict: "명령어 사전",
	settings: "설정",
	connections: "연결 관리",
	keys: "키 관리",
};
const LEVEL_BADGE: Record<string, string> = { rsa: "구형 SSH · RSA", sha1: "구형 SSH · SHA-1", weakest: "구형 SSH · 최후" };

// 탭 번호는 겹치면 안 된다 — 모듈이 다시 읽혀(개발 중 새로 고침) 숫자가 처음으로 돌아가도 겹치지 않게 무작위 꼬리를 붙인다
let seq = 0;
const newTab = (kind: TabKind, title: string, extra?: Partial<Tab>): Tab => ({ id: `${kind}-${++seq}-${Math.random().toString(36).slice(2, 7)}`, kind, title, ...extra });

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
	/** 서버 카드(누르면 계정 고르기) — 서버 번호 */
	const [cardId, setCardId] = useState<number | null>(null);
	const [dbConnecting, setDbConnecting] = useState<Profile | null>(null);
	const [importing, setImporting] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [q, setQ] = useState("");
	/** 시트를 다시 열 때(복제 등) 새로 그리게 */
	const [sheetKey, setSheetKey] = useState(0);
	const [pmenu, setPmenu] = useState<{ x: number; y: number; p: Profile } | null>(null);
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const upd = useUpdate();
	/** 명령 팔레트(열려 있으면 처음 찾는 말) */
	const [palette, setPalette] = useState<string | null>(null);
	// 화면 설정(앱 테마·터미널 색·글꼴)은 첫 화면 전에 반영
	useEffect(() => {
		void loadAppearance();
	}, []);

	// 지난번 열려 있던 연결(앱을 다시 켜면 홈에서 한 번에 다시 열기)
	// 지난번 열려 있던 연결(서버 + 그때 쓴 계정) — 앱을 다시 켜면 홈에서 한 번에 다시 열기
	const [lastSession, setLastSession] = useState<SessionItem[]>([]);
	const sessionLoaded = useRef(false);
	useEffect(() => {
		void api.settingGet("session.open").then((v) => {
			setLastSession(parseSession(v));
			sessionLoaded.current = true;
		});
	}, []);
	useEffect(() => {
		if (!sessionLoaded.current) return;
		const items: SessionItem[] = [];
		for (const t of tabs) {
			const p = t.ssh?.profile ?? t.db?.profile;
			if (p?.id == null) continue;
			if (!items.some((x) => x.p === p.id && x.a === p.accountId)) items.push({ p: p.id, a: p.accountId });
		}
		if (items.length) {
			setLastSession([]);
			void api.settingSet("session.open", JSON.stringify(items));
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
			if (t?.db && !confirmOpenTx([t.db.ok.connId], "이 탭을 닫으면")) return;
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
			open("ssh", tabTitle({ ...p, username: ok.username || p.username }), false, { ssh: { ok, profile: p }, color: p.color });
		},
		[open, reload],
	);

	// 연결 끊김 — 탭에 표시하고, 저장한 암호가 있으면 바로 다시 연결을 시도
	useEffect(() => {
		const un = listen<{ conn: number }>("ssh-closed", (e) => {
			const t = tabsRef.current.find((x) => x.ssh?.ok.connId === e.payload.conn);
			if (!t?.ssh) return;
			setTabs((ts) => ts.map((x) => (x.id === t.id && x.ssh ? { ...x, ssh: { ...x.ssh, closed: true } } : x)));
			if (t.ssh.profile.secretSaved || t.ssh.ok.usedSavedSecret || t.ssh.profile.auth !== "password") setConnecting({ p: t.ssh.profile, tabId: t.id });
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

	// 명령 팔레트: Ctrl+Shift+P(맥 ⌘⇧P) — 터미널(xterm)·편집기에 가기 전에 잡는다(셸에 ^P 가 가지 않게)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = info?.os === "macos" ? e.metaKey : e.ctrlKey;
			if (!mod || !e.shiftKey || e.altKey || e.code !== "KeyP") return;
			e.preventDefault();
			e.stopPropagation();
			setPalette((v) => (v === null ? "" : null));
		};
		const onOpen = (e: Event) => setPalette((e as CustomEvent<string>).detail ?? "");
		window.addEventListener("keydown", onKey, { capture: true });
		window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
		return () => {
			window.removeEventListener("keydown", onKey, { capture: true });
			window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
		};
	}, [info?.os]);

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
		{ label: "서버 카드(계정 고르기)…", run: () => { if (p.id != null) setCardId(p.id); } },
		...(p.accounts ?? []).map((a) => ({ label: `${accountName(a)}${a.label?.trim() ? ` (${a.username})` : ""} 계정으로 접속${a.isDefault ? " ★" : ""}`, run: () => connectAs(p, a) })),
		{ sep: true as const },
		{ label: "설정…", run: () => editProfile(p) },
		{ label: "복제", run: () => editProfile({ ...p, id: undefined, name: `${p.name} 복사본`, secretSaved: false }) },
		...(p.secretSaved ? [{ label: "기본 계정의 저장한 암호 지우기", run: () => void api.accountSecretSet(defaultAccount(p)?.id ?? -1, "").then(reload) }] : []),
		{ sep: true as const },
		{
			label: "지우기",
			danger: true,
			run: () => {
					if (p.id != null && confirm(`${p.name} 서버를 지울까요? 계정 ${p.accounts?.length ?? 1}개와 저장한 암호도 함께 지웁니다.`)) void api.profileDelete(p.id).then(reload);
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
				<button
					type="button"
					className="sb-item"
					title={`${p.kind === "db" ? `${p.engine} ` : ""}${p.host}:${p.port} · 계정 ${p.accounts?.length ?? 1}개${p.memo ? `\n${p.memo}` : ""}\n눌러 서버 정보·계정 고르기`}
					onClick={() => connect(p)}
				>
				<span className="dot" style={{ background: p.color ?? "var(--accent)" }} />
				{p.kind === "ssh" ? <Server size={12} className="sb-kind" /> : <Database size={12} className="sb-kind" />}
				<span className="sb-name">{p.name}</span>
			</button>
			<span className="sb-acts">
					<button type="button" className="sb-act" title={quickTitle(p)} onClick={() => connectAs(p)}>
						<Play size={12} />
					</button>
				<button type="button" className="sb-act" title="설정" onClick={() => editProfile(p)}>
					<Pencil size={12} />
				</button>
			</span>
		</div>
	);
	const isWin = info?.os === "windows";
	const sessionProfiles = lastSession.map((x) => ({ x, p: profiles.find((p) => p.id === x.p) })).filter((y): y is { x: SessionItem; p: Profile } => !!y.p);
	const mod = info?.os === "macos" ? "⌘" : "Ctrl+";
	const win = getCurrentWindow();
	// 앱을 끌 때: 저장 안 한 편집기가 있으면 묻는다(창 단추·Alt+F4·작업 표시줄 모두)
	useEffect(() => {
		const un = win.onCloseRequested((e) => {
			if (runningTransfers.size && !confirm(`전송 ${runningTransfers.size}개가 아직 돌고 있습니다. 끄면 멈춥니다(나중에 "다시(이어서)" 로 이어 받을 수 있음). 끌까요?`)) {
				e.preventDefault();
				return;
			}
			if (!confirmDiscard(dirtyTitles(), "앱을 끄면")) {
				e.preventDefault();
				return;
			}
			if (!confirmOpenTx(null, "앱을 끄면")) e.preventDefault();
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
	// 사이드바: 홈에서만 펼치고, 그 밖의 화면에서는 아이콘 막대로 접어 둔다(화면을 옮겨도 왔다 갔다 하지 않음).
	// 단추·Ctrl+B 로 손수 펴면 홈으로 돌아올 때까지 그대로 편 채로 둔다. 아이콘을 누르면 그 화면으로 바로 간다(이름은 툴팁).
	const onHome = activeKind === "home" || activeKind === undefined;
	const [sbManual, setSbManual] = useState<boolean | null>(null);
	useEffect(() => {
		if (onHome) setSbManual(null);
	}, [onHome]);
	const sbRail = onHome ? sbManual === true : (sbManual ?? true);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyB") {
				e.preventDefault();
				setSbManual(!sbRail);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [sbRail]);

	/**
	 * 서버를 누르면 — 계정이 하나뿐이고 더 물을 것이 없으면(암호 저장됨·키·에이전트) 바로 접속,
	 * 아니면 서버 카드(서버 정보·계정 고르기). 카드는 우클릭 › 서버 카드로 언제든 연다
	 */
	const connect = (p: Profile) => {
		if (p.id == null) return;
		const accts = p.accounts ?? [];
		const only = accts.length === 1 ? accts[0] : undefined;
		if (only && (only.secretSaved || only.auth !== "password")) {
			connectAs(p, only);
			return;
		}
		setCardId(p.id);
	};
	/** 그 계정으로(안 주면 기본 계정) 접속 */
	const connectAs = (p: Profile, a?: Account) => {
		const eff = withAccount(p, a ?? defaultAccount(p));
		setCardId(null);
		if (p.kind === "db") {
			setDbConnecting(eff);
			return;
		}
		setConnecting({ p: eff });
	};
	const quickTitle = (p: Profile) => {
		const a = defaultAccount(p);
		return `${a ? `${accountName(a)}${a.label?.trim() ? `(${a.username})` : ""} 계정` : "기본 계정"}으로 바로 접속${(p.accounts?.length ?? 0) > 1 ? ` — 계정 ${p.accounts?.length}개 중` : ""}`;
	};
	const card = cardId != null ? profiles.find((p) => p.id === cardId) : undefined;

	/** 설정의 그 묶음으로 */
	const gotoSettings = (id: SettingsSection) => {
		requestSettingsSection(id);
		open("settings", "설정", true);
	};
	const focusHomeSearch = () => {
		open("home", "홈", true);
		requestAnimationFrame(() => document.getElementById("home-search")?.focus());
	};
	// 명령 팔레트 — 연결·열린 탭·앱(작업대·DB 작업대는 자기 화면이 앞에 있을 때 따로 등록)
	useCommands("app", true, () => {
		const out: Command[] = [];
		for (const p of profiles) {
			if (p.id == null) continue;
			const where = `${p.kind === "db" ? `${p.engine ?? "DB"} · ` : ""}${p.host}:${p.port}`;
			const kw = [p.host, p.groupName, p.memo, p.kind, p.engine, ...(p.accounts ?? []).map((a) => `${a.username} ${a.label ?? ""}`)].filter(Boolean).join(" ");
			const def = defaultAccount(p);
			out.push(
				{ id: `conn.card.${p.id}`, group: "conn", title: p.name, hint: `${where} · 서버 카드`, keywords: kw, run: () => { if (p.id != null) setCardId(p.id); } },
				{ id: `conn.go.${p.id}`, group: "conn", title: `${p.name} — 기본 계정으로 접속`, hint: def ? accountName(def) : undefined, keywords: `${kw} 접속 연결 connect`, run: () => connectAs(p) },
			);
			if ((p.accounts?.length ?? 0) > 1) {
				for (const a of p.accounts ?? []) {
					out.push({
						id: `conn.as.${p.id}.${a.id}`,
						group: "conn",
						title: `${p.name} › ${accountName(a)}`,
						hint: `${a.label?.trim() ? `${a.username} · ` : ""}이 계정으로 접속${a.isDefault ? " · 기본" : ""}`,
						keywords: `${kw} 계정 접속`,
						run: () => connectAs(p, a),
					});
				}
			}
			out.push({ id: `conn.edit.${p.id}`, group: "conn", title: `${p.name} — 서버 설정`, hint: where, keywords: `${kw} 고치기 편집 설정`, run: () => editProfile(p) });
		}
		for (const t of tabsRef.current) {
			out.push({ id: `tab.${t.id}`, group: "tabs", title: t.title, hint: `${KIND_LABEL[t.kind]}${t.id === active ? " · 지금 탭" : ""}`, keywords: "탭 tab 옮기기", run: () => setActive(t.id) });
		}
		const a = (id: string, title: string, run: () => void, extra?: Partial<Command>): Command => ({ id: `app.${id}`, group: "app", title, run, ...extra });
		out.push(
			a("home", "홈", () => open("home", "홈", true)),
			a("homeSearch", "홈에서 연결 찾기", focusHomeSearch, { keys: "Mod+K" }),
			a("local", "내 PC 터미널 새로 열기", () => open("local", "내 PC"), { keys: "Mod+T", keywords: "로컬 터미널 셸 local" }),
			a("closeTab", "지금 탭 닫기", () => close(active), { keys: "Mod+W", disabled: tabsRef.current.length <= 1 }),
			a("connections", "연결 관리", () => open("connections", "연결 관리", true), { keywords: "서버 목록 프로필" }),
			a("keys", "키 관리", () => open("keys", "키 관리", true), { keywords: "ssh key 공개키 ppk" }),
			a("dict", "명령어 사전", () => open("dict", "명령어 사전", true), { keywords: "리눅스 명령 도움말" }),
			a("newSsh", "새 SSH 서버", () => setSheet(blankProfile("ssh")), { keywords: "추가 연결 만들기" }),
			a("newDb", "새 데이터베이스 연결", () => setSheet(blankProfile("db")), { keywords: "추가 db 만들기" }),
			a("import", "연결 가져오기", () => setImporting(true), { hint: "~/.ssh/config·PuTTY", keywords: "import" }),
			a("export", "연결 내보내기", () => setExporting(true), { hint: "ssh config 로", keywords: "export" }),
			a("sidebar", sbRail ? "사이드바 펴기" : "사이드바 접기", () => setSbManual(!sbRail), { keys: "Mod+B" }),
			a("settings", "설정", () => open("settings", "설정", true), { keywords: "settings 환경" }),
			...SETTINGS_SECTIONS.map((x) => a(`settings.${x.id}`, `설정 › ${x.label}`, () => gotoSettings(x.id), { keywords: x.keywords })),
			a("update", "업데이트 확인", () => {
				void checkNow(true);
				gotoSettings("update");
			}, { keywords: "새 버전 update" }),
		);
		const cur = getAppearance();
		for (const [k, l] of [
			["system", "시스템 따라"],
			["light", "밝게"],
			["dark", "어둡게"],
		] as [AppTheme, string][]) {
			out.push(a(`theme.${k}`, `테마: ${l}`, () => setAppearance({ app: k }), { hint: cur.app === k ? "지금" : undefined, keywords: "테마 다크 라이트 dark light theme 화면" }));
		}
		for (const sc of TERM_SCHEMES) {
			out.push(a(`scheme.${sc.id}`, `터미널 색: ${sc.label}`, () => setAppearance({ termScheme: sc.id }), { hint: cur.termScheme === sc.id ? "지금" : undefined, keywords: "터미널 색 구성 테마 color scheme" }));
		}
		return out;
	});

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
		<div className="app" data-sb={sbRail ? "rail" : "open"}>
			<aside className="sidebar" data-tauri-drag-region>
				<div className="sidebar-head" data-tauri-drag-region>
					<img src={iconUrl} alt="" />
					<span className="sb-title">RuiBotte Shell</span>
					<button
						type="button"
						className="sb-pin"
						title={sbRail ? "사이드바 펴기(Ctrl+B)" : "사이드바 접기(Ctrl+B) — 접속 화면에서는 저절로 접힘"}
						aria-label={sbRail ? "사이드바 펴기" : "사이드바 접기"}
						onClick={() => setSbManual(!sbRail)}
					>
						{sbRail ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
					</button>
				</div>
				<button type="button" className="sb-item" title="홈" aria-current={activeKind === "home"} onClick={() => open("home", "홈", true)}>
					<House size={16} /> 홈
				</button>
				<button type="button" className="sb-item" title="내 PC 터미널" aria-current={activeKind === "local"} onClick={() => open("local", "내 PC")}>
					<SquareTerminal size={16} /> 내 PC 터미널
				</button>
				<button type="button" className="sb-item" title="명령어 사전" aria-current={activeKind === "dict"} onClick={() => open("dict", "명령어 사전", true)}>
					<BookOpen size={16} /> 명령어 사전
				</button>
				<button type="button" className="sb-item" title="연결 관리" aria-current={activeKind === "connections"} onClick={() => open("connections", "연결 관리", true)}>
					<ListTree size={16} /> 연결 관리
				</button>
				<button type="button" className="sb-item" title="SSH 키 관리" aria-current={activeKind === "keys"} onClick={() => open("keys", "키 관리", true)}>
					<KeyRound size={16} /> 키 관리
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
				<button type="button" className="sb-item sb-more" title="모든 연결 — 연결 관리" onClick={() => open("connections", "연결 관리", true)}>
					<ListTree size={14} /> 모든 연결 {profiles.length ? `(${profiles.length})` : ""}
				</button>
				<button type="button" className="sb-item sb-more" title="새 연결" onClick={() => setSheet(blankProfile("ssh"))}>
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
					<button type="button" className="sb-item" title="설정" aria-current={activeKind === "settings"} onClick={() => open("settings", "설정", true)}>
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
								{t.db?.profile.sshTunnelProfileId ? (
									<span className="tab-via" title={`SSH 경유 — ${profiles.find((x) => x.id === t.db?.profile.sshTunnelProfileId)?.name ?? "SSH 서버"} 를 거쳐 접속`}>
										⇄
									</span>
								) : null}
								{routeWorthShowing(t.ssh?.ok.route) && t.ssh?.ok.route ? (
									<span className="tab-route" title={routeTitle(t.ssh.ok.route)} aria-label={`경로: ${t.ssh.ok.route.label}`}>
										⇢
									</span>
								) : null}
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
					<button type="button" className="btn ghost icon cp-open" title={`명령 팔레트 (${info?.os === "macos" ? "⌘⇧P" : "Ctrl+Shift+P"}) — 서버·탭·동작·설정 찾아 실행`} aria-label="명령 팔레트" onClick={() => setPalette("")}>
						<CommandIcon size={14} />
					</button>
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
										{sessionProfiles.length > 0 && (
											<div className="resume-bar">
												<span>
													지난번에 열려 있던 연결 —{" "}
													{sessionProfiles
														.map(({ x, p }) => {
															const a = p.accounts?.find((y) => y.id === x.a) ?? defaultAccount(p);
															return a ? `${a.username}@${p.name}` : p.name;
														})
														.join(", ")}
												</span>
											<button
												type="button"
												className="btn primary"
												onClick={() => {
														const list = sessionProfiles;
														setLastSession([]);
														// 하나씩(암호 창이 겹치지 않게), 그때 쓴 계정으로(지워졌으면 기본 계정)
														list.forEach(({ x, p }, i) => window.setTimeout(() => connectAs(p, p.accounts?.find((y) => y.id === x.a)), i * 400));
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
																	title={`${p.memo ? `${p.memo}\n` : ""}눌러 서버 정보·계정 고르기`}
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
																	</b>
																	<small>
																			{p.legacy !== "off" && <span className="badge warn pc-legacy">{LEVEL_BADGE[p.legacy]}</span>}
																			{p.secretSaved && <KeyRound size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
																			{p.kind === "db" ? `${p.engine} · ` : ""}
																			{p.username ? `${p.username}@` : ""}
																			{p.host}:{p.port}
																			{(p.accounts?.length ?? 0) > 1 && <span className="last-used"> · 계정 {p.accounts?.length}</span>}
																			{p.lastUsedAt ? <span className="last-used"> · {agoMs(p.lastUsedAt)}</span> : null}
																	</small>
																	{p.memo && <small className="memo">{p.memo}</small>}
																</div>
																<button
																	type="button"
																		className="btn pc-connect"
																		title={quickTitle(p)}
																		onClick={(e) => {
																			e.stopPropagation();
																			connectAs(p);
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
										<Unplug size={15} /> 연결이 끊겼습니다. 다시 연결하면 열려 있던 파일을 다시 엽니다 — 저장 안 한 고친 내용은 초안으로 남아 열 때 되살릴 수 있습니다.
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
										server={t.ssh.profile.id != null ? { profileId: t.ssh.profile.id, conn: t.ssh.ok.connId, tmux: !!profiles.find((x) => x.id === t.ssh?.profile.id)?.tmux, name: t.ssh.profile.name } : undefined}
											sudo={{ mode: t.ssh.ok.sudo ?? "ask", user: t.ssh.ok.sudoUser ?? "root" }}
											peers={tabs
											.filter((x) => x.ssh && x.id !== t.id && !x.ssh.closed)
												.map((x) => ({ conn: x.ssh?.ok.connId as number, label: x.ssh ? tabTitle({ ...x.ssh.profile, username: x.ssh.ok.username || x.ssh.profile.username }) : "", home: x.ssh?.ok.home ?? "/" }))}
											syncInfo={{ user: t.ssh.ok.username || t.ssh.profile.username, host: t.ssh.profile.host, port: t.ssh.profile.port }}
											active={t.id === active}
											label={`${t.ssh.ok.username || t.ssh.profile.username}@${t.ssh.profile.host}`}
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
								{t.kind === "keys" && (
									<KeysPane
										conns={tabs
											.filter((x) => x.ssh && !x.ssh.closed)
											.map((x) => ({ conn: x.ssh?.ok.connId as number, label: x.title }))}
									/>
								)}
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
					onAccountsChanged={reload}
				/>
			)}
			{card && (
				<ServerCard
					profile={card}
					via={card.sshTunnelProfileId ? (profiles.find((x) => x.id === card.sshTunnelProfileId)?.name ?? "지워진 SSH 서버") : undefined}
					servers={profiles}
					openConn={tabs.find((x) => x.ssh && !x.ssh.closed && x.ssh.profile.id === card.id)?.ssh?.ok.connId}
					onClose={() => setCardId(null)}
					onConnect={(a) => connectAs(card, a)}
					onEditServer={() => {
						setCardId(null);
						editProfile(card);
					}}
					onChanged={reload}
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
							open("db", tabTitle(p), false, { db: { ok, profile: p, readOnly }, color: p.color });
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
			{palette !== null && <CommandPalette initial={palette} onClose={() => setPalette(null)} />}
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
