import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, Command as CommandIcon, ListTree, PanelLeftClose, PanelLeftOpen, Database, Download, Settings as SettingsIcon, House, KeyRound, Minus, Pencil, Play, Plus, RotateCcw, Save, Server, Square, SquareTerminal, Table2, Unplug, X, ArrowLeftRight, Route } from "lucide-react";
import { lazy, memo, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "../assets/icon.svg?url";
import { ConnectDialog, needsHuman, sshConnectWith } from "./components/ConnectDialog";
import { confirmOpenTx } from "./lib/dbTx";
import { CLOSE_DOC_EVENT, confirmDiscard, dirtyTitles } from "./lib/dirty";
import { ConnectionsPane } from "./components/ConnectionsPane";
import { KeysPane } from "./components/KeysPane";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DbConnectDialog } from "./components/DbConnectDialog";
import { HomePane, LEVEL_BADGE, type QuickSpec } from "./components/HomePane";
import { ExportSheet, ImportSheet } from "./components/ImportSheet";
import { blankProfile, ProfileSheet } from "./components/ProfileSheet";
import { routeTitle, routeWorthShowing } from "./components/RouteChip";
import { ServerCard } from "./components/ServerCard";
import { type Account, accountName, type AppInfo, api, asSshError, type ConnectOk, defaultAccount, directArgs, localFs, localTerm, type Profile, runningTransfers, sshFs, sshTerm, transferArgs, withAccount } from "./lib/ipc";
import type { DbConnectOk } from "./components/DbConnectDialog";
import { askText } from "./lib/ask";
import { checkNow, installNow, startUpdater, useUpdate } from "./lib/updater";
import { CommandPalette } from "./components/CommandPalette";
import { type Command, OPEN_PALETTE_EVENT, OPEN_SETTINGS_EVENT, requestSettingsSection, SETTINGS_SECTIONS, type SettingsSection, useCommands } from "./lib/commands";
import { type AppTheme, getAppearance, loadAppearance, setAppearance, TERM_SCHEMES } from "./lib/theme";

// 무거운 칸(xterm·편집기·표·사전)은 처음 열 때 받는다 — 첫 화면(홈)은 가볍게
const Workbench = lazy(() => import("./components/Workbench").then((m) => ({ default: m.Workbench })));
const ResultGridPane = lazy(() => import("./components/ResultGrid").then((m) => ({ default: m.ResultGridPane })));
const SettingsPane = lazy(() => import("./components/SettingsPane").then((m) => ({ default: m.SettingsPane })));
const DbWorkbench = lazy(() => import("./components/DbWorkbench").then((m) => ({ default: m.DbWorkbench })));
const CommandDictionaryPane = lazy(() => import("./components/CommandDictionary").then((m) => ({ default: m.CommandDictionaryPane })));

type TabKind = "home" | "local" | "ssh" | "db" | "grid" | "dict" | "settings" | "connections" | "keys";
type DbInfo = { ok: DbConnectOk; profile: Profile; readOnly: boolean };
/** retry: 조용히 다시 잇는 중(몇 번째) · lastError: 조용한 다시 연결이 다 실패한 까닭 */
type SshInfo = { ok: ConnectOk; profile: Profile; closed?: boolean; retry?: number; lastError?: string };
type Tab = { id: string; kind: TabKind; title: string; ssh?: SshInfo; db?: DbInfo; color?: string | null };
/** 접속 창 대기열 한 칸 — tabId: 그 탭을 다시 연결, besideOf: 그 탭 옆 칸에 열 "다른 서버" */
type ConnReq = { key: string; seq: number; p: Profile; tabId?: string; besideOf?: string; error?: string };
type DbReq = { key: string; seq: number; p: Profile };
type PeerInfo = { conn: number; label: string; home: string; target?: { user: string; host: string; port: number } };
type Focus = boolean | "later";
type Backend = { fs: ReturnType<typeof localFs>; term: typeof localTerm; local?: ReturnType<typeof localFs> };

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

// 탭 번호는 겹치면 안 된다 — 모듈이 다시 읽혀(개발 중 새로 고침) 숫자가 처음으로 돌아가도 겹치지 않게 무작위 꼬리를 붙인다
let seq = 0;
const newTab = (kind: TabKind, title: string, extra?: Partial<Tab>): Tab => ({ id: `${kind}-${++seq}-${Math.random().toString(36).slice(2, 7)}`, kind, title, ...extra });
let reqSeq = 0;
const noop = () => {};
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
/** 끊긴 뒤 조용히 다시 잇는 간격(저장한 자격으로) — 다 실패하면 탭 띠에 까닭을 남긴다 */
const RETRY_DELAYS = [2000, 4000, 8000];
/** 절전 복귀 감지 — 이 주기 타이머가 1분 넘게 늦으면 깨어난 것으로 본다 */
const TICK_MS = 15000;
/** 물을 것 없이(저장한 암호·키·에이전트) 다시 이을 수 있는 연결 */
const canRetrySilently = (s: SshInfo) => !!(s.profile.secretSaved || s.ok.usedSavedSecret || s.profile.auth !== "password");
/** Ctrl+Shift+T 로 다시 열 닫은 탭 수 */
const CLOSED_KEEP = 10;

function quickTitle(p: Profile) {
	const a = defaultAccount(p);
	return `${a ? `${accountName(a)}${a.label?.trim() ? `(${a.username})` : ""} 계정` : "기본 계정"}으로 바로 접속${(p.accounts?.length ?? 0) > 1 ? ` — 계정 ${p.accounts?.length}개 중` : ""}`;
}

/** 늘 같은 참조인 콜백 — 부를 때는 마지막 렌더의 함수를 부른다(memo 한 칸에 넘기는 콜백용) */
function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
	const r = useRef(fn);
	r.current = fn;
	return useCallback((...a: A) => r.current(...a), []);
}

export function App() {
	const [info, setInfo] = useState<AppInfo | null>(null);
	const [localHome, setLocalHome] = useState<string>("");
	const [tabs, setTabs] = useState<Tab[]>(() => [newTab("home", "홈")]);
	const [active, setActive] = useState(tabs[0].id);
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [sheet, setSheet] = useState<Profile | null>(null);
	/**
	 * 접속 창 대기열 — 한 번에 하나만 보이고 차례로 연다(절전 복귀·"다시 열기"로 암호·지문을 물을 탭이 여럿이어도 모두).
	 * 대기열의 참값은 ref(같은 틱에 여러 번 넣어도 겹침 거르기가 맞게), 상태는 화면용 거울
	 */
	const [connQ, setConnQ] = useState<ConnReq[]>([]);
	const connQRef = useRef<ConnReq[]>([]);
	const editQ = useCallback((f: (q: ConnReq[]) => ConnReq[]) => {
		connQRef.current = f(connQRef.current);
		setConnQ(connQRef.current);
	}, []);
	/** 서버 카드(누르면 계정 고르기) — 서버 번호 */
	const [cardId, setCardId] = useState<number | null>(null);
	const [dbQ, setDbQ] = useState<DbReq[]>([]);
	const dbQRef = useRef<DbReq[]>([]);
	const editDbQ = useCallback((f: (q: DbReq[]) => DbReq[]) => {
		dbQRef.current = f(dbQRef.current);
		setDbQ(dbQRef.current);
	}, []);
	const [importing, setImporting] = useState(false);
	const [exporting, setExporting] = useState(false);
	/** 시트를 다시 열 때(복제 등) 새로 그리게 */
	const [sheetKey, setSheetKey] = useState(0);
	const [pmenu, setPmenu] = useState<{ x: number; y: number; p: Profile } | null>(null);
	const upd = useUpdate();
	/** 명령 팔레트(열려 있으면 처음 찾는 말) */
	const [palette, setPalette] = useState<string | null>(null);
	// 화면 설정(앱 테마·터미널 색·글꼴)은 첫 화면 전에 반영
	useEffect(() => {
		void loadAppearance();
	}, []);

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
	const activeRef = useRef(active);
	activeRef.current = active;

	/** 대기열이 남은 동안 붙은 탭 — 대기열이 다 빈 뒤에 옮긴다(옮긴 탭의 터미널이 다음 접속 창의 암호 칸 포커스를 뺏지 않게) */
	const pendingFocus = useRef<string | null>(null);
	/** focus: true 지금 옮김 · "later" 대기열이 빈 뒤 · false 옮기지 않음 */
	const focusTab = useCallback((id: string, focus: Focus) => {
		if (focus === true) {
			pendingFocus.current = null;
			setActive(id);
		} else if (focus === "later") pendingFocus.current = id;
	}, []);
	const open = useCallback(
		(kind: TabKind, title: string, single = false, extra?: Partial<Tab>, focus: Focus = true) => {
			const same = single ? tabsRef.current.find((t) => t.kind === kind) : undefined;
			if (same) {
				setActive(same.id);
				return;
			}
			const t = newTab(kind, title, extra);
			setTabs((ts) => [...ts, t]);
			focusTab(t.id, focus);
		},
		[focusTab],
	);

	/** 그 탭 SSH 상태 일부만 바꾼다(다른 탭 객체는 그대로 — 숨은 탭이 다시 그려지지 않게) */
	const patchSsh = useCallback((tabId: string, patch: Partial<SshInfo>) => {
		setTabs((ts) => ts.map((t) => (t.id === tabId && t.ssh ? { ...t, ssh: { ...t.ssh, ...patch } } : t)));
	}, []);

	// 원격·내 PC 백엔드는 탭마다 한 번만 만든다(다시 그릴 때 셸이 다시 열리지 않게)
	const backends = useRef(new Map<string, Backend>());
	const peerCache = useRef(new Map<string, { key: string; list: PeerInfo[] }>());
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

	// ── 끊긴 연결 정리·조용한 다시 연결 ──
	/** 앱이 스스로 끊은(다시 연결로 바뀐·죽은 것으로 본) 연결 — 그 ssh-closed 는 무시한다 */
	const retired = useRef(new Set<number>());
	/** 끊을 옛 연결 — 작업대가 새 연결로 다시 그려진 뒤(커밋 뒤 효과)에 끊는다 */
	const retireQ = useRef<number[]>([]);
	const retire = useCallback((conn: number) => {
		retired.current.add(conn);
		retireQ.current.push(conn);
	}, []);
	useEffect(() => {
		if (!retireQ.current.length) return;
		for (const c of retireQ.current.splice(0)) void api.sshDisconnect(c).catch(noop);
	}, [tabs]);
	/** 조용히 다시 잇는 중인 탭 — 취소 표시 */
	const auto = useRef(new Map<string, { cancelled: boolean }>());
	const stopAuto = useCallback((tabId: string) => {
		const a = auto.current.get(tabId);
		if (!a) return false;
		a.cancelled = true;
		auto.current.delete(tabId);
		return true;
	}, []);

	/** 접속 창 대기열에 넣는다 — 같은 탭(또는 같은 서버·계정의 새 연결)이 이미 기다리면 넣지 않는다 */
	const enqueue = useCallback(
		(r: Omit<ConnReq, "key" | "seq">) => {
			if (r.tabId && stopAuto(r.tabId)) patchSsh(r.tabId, { retry: undefined });
			const q = connQRef.current;
			// 저장한 서버는 서버·계정으로, 임시 접속은 주소·계정으로 같은 것을 거른다
			const same = (x: ConnReq) => (r.p.id != null ? x.p.id === r.p.id && x.p.accountId === r.p.accountId : x.p.id == null && x.p.host === r.p.host && x.p.port === r.p.port && x.p.username === r.p.username);
			const dup = r.tabId ? q.some((x) => x.tabId === r.tabId) : q.some((x) => !x.tabId && x.besideOf === r.besideOf && same(x));
			if (dup) return;
			const n = ++reqSeq;
			editQ((qq) => [...qq, { ...r, key: `c${n}`, seq: n }]);
		},
		[editQ, patchSsh, stopAuto],
	);
	const dequeue = useCallback((key: string) => editQ((q) => q.filter((x) => x.key !== key)), [editQ]);
	/** 접속 창에서 붙었을 때 — 기다리는 창이 더 있으면 탭 옮기기는 미룬다 */
	const holdFocus = useCallback((): Focus => (connQRef.current.length + dbQRef.current.length ? "later" : true), []);
	useEffect(() => {
		if (connQ.length || dbQ.length || !pendingFocus.current) return;
		const id = pendingFocus.current;
		pendingFocus.current = null;
		if (tabsRef.current.some((t) => t.id === id)) setActive(id);
	}, [connQ, dbQ]);
	const dbEnqueue = useCallback(
		(p: Profile) => {
			if (p.id != null && dbQRef.current.some((x) => x.p.id === p.id && x.p.accountId === p.accountId)) return;
			const n = ++reqSeq;
			editDbQ((q) => [...q, { key: `d${n}`, seq: n, p }]);
		},
		[editDbQ],
	);

	/** 접속 성공 — focus: 그 탭으로 옮길지(조용한 다시 연결은 지금 보는 탭을 뺏지 않는다) */
	const onConnected = useCallback(
		(ok: ConnectOk, p: Profile, tabId?: string, besideOf?: string, focus: Focus = true) => {
			reload();
			if (besideOf && tabsRef.current.some((t) => t.id === besideOf)) {
				const t = newTab("ssh", tabTitle({ ...p, username: ok.username || p.username }), { ssh: { ok, profile: p }, color: p.color });
				setTabs((ts) => [...ts, t]);
				window.dispatchEvent(new CustomEvent("rb-open-peer", { detail: { owner: besideOf, conn: ok.connId } }));
				return;
			}
			if (tabId) {
				const cur = tabsRef.current.find((t) => t.id === tabId);
				if (!cur?.ssh) {
					// 기다리는 사이 탭을 닫았다 — 붙은 연결은 버린다
					void api.sshDisconnect(ok.connId).catch(noop);
					return;
				}
				stopAuto(tabId);
				// 다시 연결 — 같은 탭에 새 연결(작업대는 새로 그려지고 배치는 저장본 그대로). 옛 연결(점프 세션·SFTP)은 작업대가 바뀐 뒤 끊는다
				if (cur.ssh.ok.connId !== ok.connId) retire(cur.ssh.ok.connId);
				backends.current.delete(tabId);
				setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, ssh: { ok, profile: p } } : t)));
				focusTab(tabId, focus);
				return;
			}
			open("ssh", tabTitle({ ...p, username: ok.username || p.username }), false, { ssh: { ok, profile: p }, color: p.color }, focus);
		},
		[focusTab, open, reload, retire, stopAuto],
	);

	/** 끊긴 탭을 저장한 자격으로 조용히 다시 잇는다(2·4·8초 뒤 세 번) — 사람이 답할 단계면 바로 접속 창 */
	const autoReconnect = useStable(async (tabId: string) => {
		if (auto.current.has(tabId) || connQRef.current.some((x) => x.tabId === tabId)) return;
		const tok = { cancelled: false };
		auto.current.set(tabId, tok);
		let lastError = "";
		for (let i = 0; i < RETRY_DELAYS.length; i++) {
			patchSsh(tabId, { retry: i + 1, lastError: undefined });
			await sleep(RETRY_DELAYS[i]);
			if (tok.cancelled) return;
			const t = tabsRef.current.find((x) => x.id === tabId);
			if (!t?.ssh) {
				auto.current.delete(tabId);
				return;
			}
			const prof = t.ssh.profile;
			try {
				const ok = await sshConnectWith(prof);
				if (tok.cancelled || !tabsRef.current.some((x) => x.id === tabId)) {
					void api.sshDisconnect(ok.connId).catch(noop);
					return;
				}
				auto.current.delete(tabId);
				onConnected(ok, prof, tabId, undefined, false);
				return;
			} catch (raw) {
				if (tok.cancelled) return;
				const e = asSshError(raw);
				if (needsHuman(e)) {
					auto.current.delete(tabId);
					patchSsh(tabId, { retry: undefined });
					// 인증에서 막혔으면 저장한 암호는 백엔드가 지웠다 — 창은 다시 붙어 보지 말고 그 안내와 함께 암호 칸부터
					const auth = e.code === "AUTH_FAILED" || e.code === "NEED_SECRET";
					enqueue(auth ? { p: { ...prof, secretSaved: false }, tabId, error: e.message } : { p: prof, tabId });
					return;
				}
				lastError = e.message;
			}
		}
		auto.current.delete(tabId);
		patchSsh(tabId, { retry: undefined, lastError: lastError || "다시 잇지 못했습니다" });
	});

	/** 그 연결이 죽었다 — 탭에 표시하고, 물을 것 없이 이을 수 있으면 조용히 다시 잇는다 */
	const markDead = useStable((conn: number) => {
		const t = tabsRef.current.find((x) => x.ssh?.ok.connId === conn);
		if (!t?.ssh || t.ssh.closed) return;
		patchSsh(t.id, { closed: true });
		if (canRetrySilently(t.ssh)) void autoReconnect(t.id);
	});
	useEffect(() => {
		const un = listen<{ conn: number }>("ssh-closed", (e) => {
			if (retired.current.delete(e.payload.conn)) return;
			markDead(e.payload.conn);
		});
		return () => void un.then((f) => f());
	}, [markDead]);

	// 절전 복귀·창 다시 보임·망 복구 — 열린 SSH 탭마다 가벼운 요청(sftp realpath ".")으로 살아 있는지 찔러 본다
	const probing = useRef(new Set<number>());
	const probe = useStable(async (tabId: string, conn: number) => {
		if (probing.current.has(conn)) return;
		probing.current.add(conn);
		try {
			const ping = invoke<string>("sftp_realpath", { conn, path: "." }).then(
				() => true,
				() => false,
			);
			// 3초 안에 답이 없으면 20초 더 기다린다 — 절전 복귀 직후 망이 올라오는 중이면 살아날 세션을 죽은 것으로 보아 끊지 않게.
			// 거절(연결 없음·채널 닫힘)은 바로 죽음, 23초 넘게 아무 답이 없고 망은 붙어 있으면 반쯤 열린 TCP 로 보고 다시 잇는다
			let alive = await Promise.race([ping, sleep(3000).then(() => null)]);
			if (alive === null) alive = await Promise.race([ping, sleep(20000).then(() => null)]);
			if (alive) return;
			if (alive === null && !navigator.onLine) return;
			const t = tabsRef.current.find((x) => x.id === tabId);
			if (!t?.ssh || t.ssh.ok.connId !== conn || t.ssh.closed) return;
			retire(conn);
			markDead(conn);
		} finally {
			probing.current.delete(conn);
		}
	});
	useEffect(() => {
		let last = Date.now();
		let lastProbe = 0;
		const probeAll = () => {
			const now = Date.now();
			if (now - lastProbe < 5000) return;
			lastProbe = now;
			if (!navigator.onLine) return;
			for (const t of tabsRef.current) if (t.ssh && !t.ssh.closed && !auto.current.has(t.id)) void probe(t.id, t.ssh.ok.connId);
		};
		const iv = window.setInterval(() => {
			const now = Date.now();
			if (now - last > TICK_MS + 60000) probeAll();
			last = now;
		}, TICK_MS);
		const onVis = () => {
			if (document.visibilityState === "visible") probeAll();
		};
		// 망이 돌아오면 — 산 연결은 찔러 보고, 다시 잇기를 다 실패한 탭은 한 번 더 조용히
		const onOnline = () => {
			probeAll();
			for (const t of tabsRef.current) {
				if (t.ssh?.closed && !auto.current.has(t.id) && !connQRef.current.some((x) => x.tabId === t.id) && canRetrySilently(t.ssh)) void autoReconnect(t.id);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		window.addEventListener("online", onOnline);
		return () => {
			window.clearInterval(iv);
			document.removeEventListener("visibilitychange", onVis);
			window.removeEventListener("online", onOnline);
		};
	}, [probe, autoReconnect]);

	/** 닫은 SSH·DB 탭(접속 정보만, 최근 것 먼저) — Ctrl+Shift+T */
	const closedTabs = useRef<{ kind: "ssh" | "db"; p: Profile }[]>([]);
	const close = useCallback(
		(id: string) => {
			const ts = tabsRef.current;
			if (ts.length === 1) return;
			const t = ts.find((x) => x.id === id);
			// DB 작업대는 반영 전 표 편집을 owner `db:<연결 번호>` 로 올린다
			if (!confirmDiscard([...dirtyTitles(id), ...(t?.db ? dirtyTitles(`db:${t.db.ok.connId}`) : [])], "이 탭을 닫으면")) return;
			if (t?.db && !confirmOpenTx([t.db.ok.connId], "이 탭을 닫으면")) return;
			stopAuto(id);
			if (connQRef.current.some((x) => x.tabId === id || x.besideOf === id)) editQ((q) => q.filter((x) => x.tabId !== id && x.besideOf !== id));
			if (t?.ssh) {
				const conn = t.ssh.ok.connId;
				void api.sshDisconnect(conn).catch(noop);
				// 이 연결로 시작한 전송의 "다시" 조건 — 연결이 없어지면 쓸 데가 없다
				for (const [k, v] of transferArgs) if (v.conn === conn) transferArgs.delete(k);
				for (const [k, v] of directArgs) if (v.fromConn === conn || v.toConn === conn) directArgs.delete(k);
			}
			if (t?.db) void invoke("db_disconnect", { conn: t.db.ok.connId });
			const sp = t?.ssh?.profile ?? t?.db?.profile;
			if (t && sp && (t.kind === "ssh" || t.kind === "db")) closedTabs.current = [{ kind: t.kind, p: sp }, ...closedTabs.current].slice(0, CLOSED_KEEP);
			backends.current.delete(id);
			peerCache.current.delete(id);
			const i = ts.findIndex((x) => x.id === id);
			const next = ts.filter((x) => x.id !== id);
			setTabs((cur) => cur.filter((x) => x.id !== id));
			if (id === activeRef.current) setActive(next[Math.max(0, i - 1)].id);
		},
		[editQ, stopAuto],
	);
	const reopenClosed = useCallback(() => {
		const [c, ...rest] = closedTabs.current;
		if (!c) return;
		closedTabs.current = rest;
		if (c.kind === "ssh") enqueue({ p: c.p });
		else dbEnqueue(c.p);
	}, [enqueue, dbEnqueue]);
	/** 다음·이전(dir) 또는 n번째 탭 */
	const stepTab = useCallback((dir: number) => {
		const ts = tabsRef.current;
		const i = ts.findIndex((t) => t.id === activeRef.current);
		const t = ts[(i + dir + ts.length) % ts.length];
		if (t) setActive(t.id);
	}, []);

	// 단축키: ⌘/Ctrl+T 새 로컬 터미널, ⌘/Ctrl+W 문서 칸(없으면 탭) 닫기, ⌘/Ctrl+Shift+W 탭 닫기, ⌘/Ctrl+K 찾기
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
				// 편집기 같은 문서 칸에 있으면 그 칸만 닫는다(VS Code 처럼) — 작업대가 받아 처리하면 서버 탭은 그대로. Ctrl+Shift+W 는 늘 서버 탭
				if (!e.shiftKey) {
					const ev = new CustomEvent(CLOSE_DOC_EVENT, { cancelable: true });
					window.dispatchEvent(ev);
					if (ev.defaultPrevented) return;
				}
				close(activeRef.current);
			} else if (k === "k") {
				e.preventDefault();
				open("home", "홈", true);
				requestAnimationFrame(() => document.getElementById("home-search")?.focus());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [info?.os, open, close]);

	// 탭 옮기기: Ctrl+Tab / Ctrl+Shift+Tab(맥도 Ctrl, ⌘⇧[ ] 도), ⌘/Ctrl+1~8 n번째·9 마지막, ⌘/Ctrl+Shift+T 닫은 탭 다시 열기
	// 터미널(xterm)·편집기가 받기 전에 잡는다 — Ctrl+Tab 이 셸에 Tab 으로, Ctrl+숫자가 제어 문자로 가지 않게
	useEffect(() => {
		const mac = info?.os === "macos";
		const onKey = (e: KeyboardEvent) => {
			if (e.altKey || e.isComposing) return;
			// 접속 창·시트·팔레트가 떠 있으면 뒤의 탭을 바꾸지 않는다(바뀐 탭의 터미널이 포커스를 가져가 암호가 셸로 갈 수 있다)
			if (document.querySelector(".scrim")) return;
			let hit = false;
			if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
				stepTab(e.shiftKey ? -1 : 1);
				hit = true;
			} else {
				const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
				if (!mod) return;
				if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
					const ts = tabsRef.current;
					const n = Number(e.code.slice(5));
					const t = n === 9 ? ts[ts.length - 1] : ts[n - 1];
					if (t) setActive(t.id);
					hit = true;
				} else if (e.shiftKey && e.code === "KeyT") {
					// 누르고 있어도 한 번만(닫은 탭이 줄줄이 열리지 않게)
					if (!e.repeat) reopenClosed();
					hit = true;
				} else if (mac && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
					stepTab(e.code === "BracketLeft" ? -1 : 1);
					hit = true;
				}
			}
			if (hit) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [info?.os, stepTab, reopenClosed]);

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

	/** 저장 안 한 임시 접속 탭에서 「저장」을 눌렀을 때 — 저장하면 그 탭이 저장한 서버를 가리키게 */
	const saveFor = useRef<string | null>(null);
	const editProfile = useStable((p: Profile) => {
		saveFor.current = null;
		setSheetKey((k) => k + 1);
		setSheet(p);
	});
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
	const mod = info?.os === "macos" ? "⌘" : "Ctrl+";
	// 렌더마다 새 객체라 [win] 효과가 매번 닫기·전송 듣기를 풀었다 다시 걸었다 — 한 번만
	const win = useMemo(() => getCurrentWindow(), []);
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

	/** 그 계정으로(안 주면 기본 계정) 접속 */
	const connectAs = useStable((p: Profile, a?: Account) => {
		const eff = withAccount(p, a ?? defaultAccount(p));
		setCardId(null);
		if (p.kind === "db") {
			dbEnqueue(eff);
			return;
		}
		enqueue({ p: eff });
	});
	/**
	 * 서버를 누르면 — 계정이 하나뿐이고 더 물을 것이 없으면(암호 저장됨·키·에이전트) 바로 접속,
	 * 아니면 서버 카드(서버 정보·계정 고르기). 카드는 우클릭 › 서버 카드로 언제든 연다
	 */
	const connect = useStable((p: Profile) => {
		if (p.id == null) return;
		const accts = p.accounts ?? [];
		const only = accts.length === 1 ? accts[0] : undefined;
		if (only && (only.secretSaved || only.auth !== "password")) {
			connectAs(p, only);
			return;
		}
		setCardId(p.id);
	});
	/** 빠른 접속(홈 검색 칸 user@host:port) — 저장한 서버와 같으면 그 서버로, 아니면 저장하지 않은 임시 접속 */
	const onQuick = useStable(async (s: QuickSpec) => {
		const host = s.host.toLowerCase();
		const same = profiles.find((p) => p.kind === "ssh" && p.id != null && p.host.toLowerCase() === host && p.port === s.port && (!s.user || p.accounts?.some((a) => a.username === s.user)));
		if (same) {
			if (s.user) connectAs(same, same.accounts?.find((a) => a.username === s.user));
			else connect(same);
			return;
		}
		let user = s.user;
		if (!user) {
			const v = await askText({ title: `${s.host}${s.port !== 22 ? `:${s.port}` : ""} 에 접속할 계정`, message: "저장하지 않고 바로 접속합니다 — 접속한 뒤 작업대의 「저장」으로 연결 목록에 넣을 수 있습니다.", placeholder: "사용자 이름", okLabel: "접속" });
			if (!v?.trim()) return;
			user = v.trim();
		}
		enqueue({ p: { ...blankProfile("ssh"), name: s.host, host: s.host, port: s.port, username: user, favorite: false, color: null } });
	});
	/** 작업대의 "다른 서버" — 저장한 서버를 골라 연결하고, 그 탭에 머문 채 옆 칸에 트리를 연다 */
	const connectBeside = useStable(async (tabId: string) => {
		const list = profiles.filter((p) => p.kind !== "db" && p.id != null);
		if (!list.length) {
			alert("저장한 서버가 없습니다 — 왼쪽 목록에서 서버를 먼저 추가하세요");
			return;
		}
		const pick = await askText({
			title: "옆에 열 서버",
			message: "연결하면 새 탭이 생기고, 지금 작업대 옆 칸에 그 서버 파일 트리가 열립니다. 트리끼리 끌어 놓으면 서버끼리 주고받습니다.",
			choiceOnly: true,
			choices: list.map((p) => ({ value: String(p.id), label: p.name || p.host })),
		});
		const p = list.find((x) => String(x.id) === pick);
		if (!p) return;
		enqueue({ p: withAccount(p, defaultAccount(p)), besideOf: tabId });
	});
	/** 끊긴 탭 "다시 연결" — 조용한 다시 잇기를 멈추고 접속 창으로 */
	const reconnectTab = useStable((tabId: string) => {
		const t = tabsRef.current.find((x) => x.id === tabId);
		if (t?.ssh) enqueue({ p: t.ssh.profile, tabId });
	});
	const saveTemp = useStable((tabId: string) => {
		const t = tabsRef.current.find((x) => x.id === tabId);
		if (!t?.ssh) return;
		editProfile({ ...t.ssh.profile, username: t.ssh.ok.username || t.ssh.profile.username, favorite: true, color: blankProfile("ssh").color });
		saveFor.current = tabId;
	});
	const card = cardId != null ? profiles.find((p) => p.id === cardId) : undefined;

	// ── 지난 세션: 홈의 "다시 열기", 설정 "켤 때 지난 연결 다시 열기"면 저절로 ──
	const [lastSession, setLastSession] = useState<SessionItem[]>([]);
	const sessionLoaded = useRef(false);
	/** 접속 창 대기열로 차례로(그때 쓴 계정으로, 지워졌으면 기본 계정) */
	const resumeSession = useStable((items: SessionItem[], list: Profile[]) => {
		setLastSession([]);
		for (const x of items) {
			const p = list.find((y) => y.id === x.p);
			if (p) connectAs(p, p.accounts?.find((y) => y.id === x.a));
		}
	});
	const restoredOnce = useRef(false);
	useEffect(() => {
		void Promise.all([api.settingGet("session.open"), api.settingGet("session.autoRestore")]).then(async ([v, ar]) => {
			if (restoredOnce.current) return;
			restoredOnce.current = true;
			const items = parseSession(v);
			if (ar === "1" && items.length) {
				const list = await api.profilesList();
				setProfiles(list);
				sessionLoaded.current = true;
				resumeSession(items, list);
				return;
			}
			setLastSession(items);
			sessionLoaded.current = true;
		});
	}, [resumeSession]);
	useEffect(() => {
		if (!sessionLoaded.current) return;
		const items: SessionItem[] = [];
		const add = (p?: Profile) => {
			if (p?.id == null) return;
			if (!items.some((x) => x.p === p.id && x.a === p.accountId)) items.push({ p: p.id, a: p.accountId });
		};
		for (const t of tabs) add(t.ssh?.profile ?? t.db?.profile);
		// 아직 대기열에서 기다리는 연결도(복원 도중 앱을 꺼도 나머지를 잃지 않게)
		for (const x of connQ) if (!x.tabId && !x.besideOf) add(x.p);
		for (const x of dbQ) add(x.p);
		if (items.length) {
			setLastSession([]);
			void api.settingSet("session.open", JSON.stringify(items));
		} else if (!lastSession.length) void api.settingSet("session.open", "[]");
	}, [tabs, connQ, dbQ, lastSession.length]);
	const resumeLabel = useMemo(
		() =>
			lastSession
				.map((x) => {
					const p = profiles.find((y) => y.id === x.p);
					if (!p) return "";
					const a = p.accounts?.find((y) => y.id === x.a) ?? defaultAccount(p);
					return a ? `${a.username}@${p.name}` : p.name;
				})
				.filter(Boolean)
				.join(", "),
		[lastSession, profiles],
	);
	const onResume = useStable(() => resumeSession(lastSession, profiles));
	const onDismissResume = useCallback(() => setLastSession([]), []);
	const onHomeOpen = useCallback(
		(w: "local" | "dict" | "connections") => {
			if (w === "local") open("local", "내 PC");
			else if (w === "dict") open("dict", "명령어 사전", true);
			else open("connections", "연결 관리", true);
		},
		[open],
	);
	const onNewProfile = useCallback((k: "ssh" | "db") => setSheet(blankProfile(k)), []);
	const onMenuAt = useCallback((x: number, y: number, p: Profile) => setPmenu({ x, y, p }), []);
	const openImport = useCallback(() => setImporting(true), []);
	const openExport = useCallback(() => setExporting(true), []);

	/** 설정의 그 범주(·하위 화면·줄)로 */
	const gotoSettings = (id: SettingsSection) => {
		requestSettingsSection(id);
		open("settings", "설정", true);
	};
	// 다른 화면이 openSettings("terminal") 로 부르면 설정 탭을 앞으로(갈 곳은 설정 화면이 가져간다)
	useEffect(() => {
		const on = () => open("settings", "설정", true);
		window.addEventListener(OPEN_SETTINGS_EVENT, on);
		return () => window.removeEventListener(OPEN_SETTINGS_EVENT, on);
	}, [open]);
	/** 설정 화면에서 여는 다른 화면 */
	const onSettingsOpen = useCallback(
		(w: "keys" | "connections" | "import") => {
			if (w === "keys") open("keys", "키 관리", true);
			else if (w === "connections") open("connections", "연결 관리", true);
			else setImporting(true);
		},
		[open],
	);
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
			a("homeSearch", "홈에서 연결 찾기", focusHomeSearch, { keys: "Mod+K", keywords: "빠른 접속 user@host quick connect" }),
			a("local", "내 PC 터미널 새로 열기", () => open("local", "내 PC"), { keys: "Mod+T", keywords: "로컬 터미널 셸 local" }),
			a("closeTab", "지금 탭 닫기", () => close(active), { keys: "Mod+W", disabled: tabsRef.current.length <= 1 }),
			a("nextTab", "다음 탭", () => stepTab(1), { keys: "Ctrl+Tab", keywords: "탭 옮기기 next tab" }),
			a("prevTab", "이전 탭", () => stepTab(-1), { keys: "Ctrl+Shift+Tab", keywords: "탭 옮기기 previous tab" }),
			a("reopenTab", "닫은 탭 다시 열기", reopenClosed, { keys: "Mod+Shift+T", keywords: "되살리기 reopen closed tab", disabled: !closedTabs.current.length }),
			a("connections", "연결 관리", () => open("connections", "연결 관리", true), { keywords: "서버 목록 프로필" }),
			a("keys", "키 관리", () => open("keys", "키 관리", true), { keywords: "ssh key 공개키 ppk" }),
			a("dict", "명령어 사전", () => open("dict", "명령어 사전", true), { keywords: "리눅스 명령 도움말" }),
			a("newSsh", "새 SSH 서버", () => setSheet(blankProfile("ssh")), { keywords: "추가 연결 만들기" }),
			a("newDb", "새 데이터베이스 연결", () => setSheet(blankProfile("db")), { keywords: "추가 db 만들기" }),
			a("import", "연결 가져오기", () => setImporting(true), { hint: "~/.ssh/config·PuTTY", keywords: "import" }),
			a("export", "연결 내보내기", () => setExporting(true), { hint: "ssh config 로", keywords: "export" }),
			a("sidebar", sbRail ? "사이드바 펴기" : "사이드바 접기", () => setSbManual(!sbRail), { keys: "Mod+B" }),
			a("settings", "설정", () => open("settings", "설정", true), { keywords: "settings 환경" }),
			...SETTINGS_SECTIONS.map((x) => a(`settings.${x.id}`, `설정 › ${x.label}`, () => gotoSettings(x.path), { keywords: x.keywords })),
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

	/** 다른 서버 칸 목록 — 탭마다, 내용이 같으면 지난 배열을 그대로(작업대가 다시 그려지지 않게) */
	const peersFor = (t: Tab): PeerInfo[] => {
		const list: PeerInfo[] = [];
		for (const x of tabs) {
			if (!x.ssh || x.id === t.id || x.ssh.closed) continue;
			const user = x.ssh.ok.username || x.ssh.profile.username;
			list.push({ conn: x.ssh.ok.connId, label: tabTitle({ ...x.ssh.profile, username: user }), home: x.ssh.ok.home ?? "/", target: { user, host: x.ssh.profile.host, port: x.ssh.profile.port } });
		}
		const key = JSON.stringify(list);
		const c = peerCache.current.get(t.id);
		if (c && c.key === key) return c.list;
		peerCache.current.set(t.id, { key, list });
		return list;
	};
	const keyConns = useMemo(() => tabs.filter((x) => x.ssh && !x.ssh.closed).map((x) => ({ conn: x.ssh?.ok.connId as number, label: x.title })), [tabs]);
	// SSH·DB 접속 창은 한 줄로 — 먼저 들어온 것부터(이미 뜬 창은 나중 것에 밀려 사라지지 않는다)
	const connHead = connQ[0] && (!dbQ[0] || connQ[0].seq < dbQ[0].seq) ? connQ[0] : undefined;
	const dbHead = connHead ? undefined : dbQ[0];
	const waiting = connQ.length + dbQ.length - 1;

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
						{tabs.map((t, i) => (
							<button
								key={t.id}
								type="button"
								role="tab"
								className="tab"
								aria-selected={t.id === active}
								title={i < 8 ? `${t.title} (${mod}${i + 1})` : t.title}
								onClick={() => setActive(t.id)}
								onAuxClick={(e) => e.button === 1 && close(t.id)}
								style={t.color ? { boxShadow: t.id === active ? `inset 0 -2px 0 ${t.color}, var(--shadow-card)` : `inset 0 -2px 0 ${t.color}` } : undefined}
							>
								{t.ssh?.retry ? <RotateCcw size={14} className="spin" aria-label="다시 잇는 중" /> : t.ssh?.closed ? <Unplug size={14} aria-label="끊김" /> : TAB_ICON[t.kind]}
								<span>{t.title}</span>
								{t.db?.profile.sshTunnelProfileId ? (
									<span className="tab-via" title={`SSH 경유 — ${profiles.find((x) => x.id === t.db?.profile.sshTunnelProfileId)?.name ?? "SSH 서버"} 를 거쳐 접속`}>
										<ArrowLeftRight size={11} aria-hidden />
									</span>
								) : null}
								{routeWorthShowing(t.ssh?.ok.route) && t.ssh?.ok.route ? (
									<span className="tab-route" title={routeTitle(t.ssh.ok.route)} aria-label={`경로: ${t.ssh.ok.route.label}`}>
										<Route size={11} aria-hidden />
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
						<section key={t.id} className={`pane${t.kind === "home" ? " home" : t.kind === "settings" ? " settings-host" : ""}`} hidden={t.id !== active}>
							{t.kind === "home" && (
								<HomePane
									profiles={profiles}
									mod={mod}
									resumeLabel={resumeLabel}
									onResume={onResume}
									onDismissResume={onDismissResume}
									onConnect={connect}
									onConnectAs={connectAs}
									onQuick={onQuick}
									onMenu={onMenuAt}
									onEdit={editProfile}
									onNew={onNewProfile}
									onOpen={onHomeOpen}
									onImport={openImport}
									onExport={openExport}
									reload={reload}
									quickTitle={quickTitle}
								/>
							)}
							<Suspense fallback={null}>
								{t.kind === "local" && localHome && (
									<Workbench ownerId={t.id} fs={backendFor(t).fs} term={backendFor(t).term} active={t.id === active} label="내 PC 셸" layoutKey="layout.local" />
								)}
								{t.kind === "ssh" && t.ssh && (
									<SshTab
										t={t}
										active={t.id === active}
										tmux={!!profiles.find((x) => x.id === t.ssh?.profile.id)?.tmux}
										peers={peersFor(t)}
										backend={backendFor(t)}
										onConnectOther={connectBeside}
										onReconnect={reconnectTab}
										onSave={saveTemp}
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
								{t.kind === "settings" && <SettingsPane info={info} onOpen={onSettingsOpen} />}
								{t.kind === "keys" && <KeysPane conns={keyConns} />}
								{t.kind === "connections" && <ConnectionsPane profiles={profiles} reload={reload} onConnect={connect} onImport={openImport} onExport={openExport} />}
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
					onClose={() => {
						saveFor.current = null;
						setSheet(null);
					}}
					onSaved={(id) => {
						setSheet(null);
						const tabId = saveFor.current;
						saveFor.current = null;
						void api.profilesList().then((list) => {
							setProfiles(list);
							const sp = tabId ? list.find((x) => x.id === id) : undefined;
							// 임시 접속 탭 — 저장한 서버(기본 계정)를 가리키게(다음 다시 연결·지난 세션·tmux 가 그 서버를 따른다)
							if (tabId && sp) setTabs((ts) => ts.map((t) => (t.id === tabId && t.ssh && t.ssh.profile.id == null ? { ...t, color: sp.color, ssh: { ...t.ssh, profile: withAccount(sp, defaultAccount(sp)) } } : t)));
						});
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
			{connHead && (
				<ConnectDialog
					// 대기열 칸마다 새 창으로(앞 창의 상태·시작 표시가 남아 다른 탭에 붙지 않게)
					key={connHead.key}
					profile={connHead.p}
					queued={waiting}
					initialError={connHead.error}
					onConnected={(ok, p) => {
						dequeue(connHead.key);
						onConnected(ok, p, connHead.tabId, connHead.besideOf, holdFocus());
					}}
					onCancel={() => dequeue(connHead.key)}
					onProfileChanged={reload}
				/>
			)}
			{/* DB 접속 창도 차례로 — SSH 접속 창이 다 끝난 뒤(창이 겹쳐 뜨지 않게) */}
			{dbHead && (
				<DbConnectDialog
					key={dbHead.key}
					profile={dbHead.p}
					onCancel={() => editDbQ((q) => q.filter((x) => x.key !== dbHead.key))}
					onConnected={(ok, readOnly) => {
						const p = dbHead.p;
						editDbQ((q) => q.filter((x) => x.key !== dbHead.key));
						reload();
						open("db", tabTitle(p), false, { db: { ok, profile: p, readOnly }, color: p.color }, holdFocus());
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

/**
 * SSH 탭 한 칸 — 끊김 띠 + 작업대. 작업대에 넘기는 객체·콜백은 여기서 안정된 참조로 만든다
 * (앱이 다시 그려져도 이 탭의 연결·프로필이 그대로면 숨은 작업대가 다시 그려지지 않게)
 */
const SshTab = memo(function SshTab({
	t,
	active,
	tmux,
	peers,
	backend,
	onConnectOther,
	onReconnect,
	onSave,
}: {
	t: Tab;
	active: boolean;
	tmux: boolean;
	peers: PeerInfo[];
	backend: Backend;
	onConnectOther: (tabId: string) => void;
	onReconnect: (tabId: string) => void;
	onSave: (tabId: string) => void;
}) {
	const s = t.ssh as SshInfo;
	const { ok, profile } = s;
	const tabId = t.id;
	const user = ok.username || profile.username;
	const server = useMemo(() => (profile.id != null ? { profileId: profile.id, conn: ok.connId, tmux, name: profile.name } : undefined), [profile.id, profile.name, ok.connId, tmux]);
	const sudo = useMemo(() => ({ mode: ok.sudo ?? "ask", user: ok.sudoUser ?? "root" }), [ok.sudo, ok.sudoUser]);
	const syncInfo = useMemo(() => ({ user, host: profile.host, port: profile.port }), [user, profile.host, profile.port]);
	const other = useCallback(() => void onConnectOther(tabId), [onConnectOther, tabId]);
	const temp = profile.id == null;
	const badge = useMemo(
		() => (
			<>
				{profile.legacy !== "off" ? (
					<span className="badge warn" title="이 서버에는 오래된 알고리즘을 허용했습니다">
						{LEVEL_BADGE[profile.legacy]}
					</span>
				) : (
					<span className="badge" title={ok.fingerprint}>
						{ok.algorithm}
					</span>
				)}
				{temp && (
					<button type="button" className="btn ghost tiny" title="저장하지 않은 임시 접속 — 연결 목록에 저장" onClick={() => onSave(tabId)}>
						<Save size={12} /> 저장
					</button>
				)}
			</>
		),
		[profile.legacy, ok.fingerprint, ok.algorithm, temp, onSave, tabId],
	);
	return (
		<>
			{s.closed && (
				<div className="closed-banner" role="status">
					{s.retry ? (
						<>
							<RotateCcw size={15} className="spin" /> 연결이 끊겨 다시 잇는 중… ({s.retry}/{RETRY_DELAYS.length}) — 붙으면 열려 있던 파일을 다시 엽니다.
							<button type="button" className="btn" onClick={() => onReconnect(tabId)}>
								지금 다시 연결
							</button>
						</>
					) : (
						<>
							<Unplug size={15} /> 연결이 끊겼습니다{s.lastError ? ` — ${s.lastError}` : ""}. 다시 연결하면 열려 있던 파일을 다시 엽니다 — 저장 안 한 고친 내용은 초안으로 남아 열 때 되살릴 수 있습니다.
							<button type="button" className="btn primary" onClick={() => onReconnect(tabId)}>
								<RotateCcw size={13} /> 다시 연결
							</button>
						</>
					)}
				</div>
			)}
			<Workbench
				ownerId={tabId}
				key={ok.connId}
				fs={backend.fs}
				local={backend.local}
				term={backend.term}
				layoutKey="layout.ssh"
				server={server}
				sudo={sudo}
				peers={peers}
				onConnectOther={other}
				syncInfo={syncInfo}
				active={active}
				label={`${user}@${profile.host}`}
				startPath={profile.defaultPath ?? undefined}
				badge={badge}
			/>
		</>
	);
});
