import {
	DockviewDefaultTab,
	DockviewReact,
	type DockviewApi,
	type DockviewReadyEvent,
	type DockviewTheme,
	type IDockviewHeaderActionsProps,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
} from "dockview-react";
import { CLOSE_DOC_EVENT, confirmDiscard, forgetOwner, isDirty, setDirty } from "../lib/dirty";
import "dockview-react/dist/styles/dockview.css";
import { listen } from "@tauri-apps/api/event";
import { Activity, ChevronDown, Wrench, Server, ArrowDownUp, ArrowLeftRight, Columns2, FileText, FolderTree, Monitor, Plus, Radio, Route, Rows2, Container, SquareTerminal, ShieldAlert, X, ArrowUp, ArrowDown } from "lucide-react";
import { createContext, lazy, memo, Suspense, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	api,
	asSshError,
	type FsBackend,
	type FsEntry,
	type SudoMode,
	joinPath,
	notifyFsChanged,
	parentDir,
	type ShellHandle,
	sshSudoFs,
	sudoApi,
	type TermBackend,
	type TransferProgress,
	transfers,
	localShells,
	type ShellInfo,
	transferArgs,
	directArgs,
	containerFs,
} from "../lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { previewKind } from "../lib/previewKind";
import { freeName, useConflictAsk } from "./ConflictSheet";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ForwardChips, ForwardSheet, TmuxSheet } from "./ForwardPanel";
import { RouteChip } from "./RouteChip";
import { MiniMonitor } from "./MiniMonitor";
import { QuickOpen } from "./QuickOpen";
import { LayoutLockButton, useLayoutLock } from "../lib/layoutLock";
import { Select } from "./Select";
import { invoke } from "@tauri-apps/api/core";
import type { CompletionSource } from "../lib/termComplete";
import { type DragEntry, FileTree } from "./FileTree";
import { sshFs } from "../lib/ipc";
import { TerminalView } from "./Terminal";
import { askText } from "../lib/ask";
import { ctxContainer } from "../lib/shellCtx";
import type { SudoCtx } from "./panels/common";
import { type Command, useCommands } from "../lib/commands";
import { FORMS } from "../lib/cmdAssist";
import { shortcutRows } from "../lib/shortcuts";

// 처음 열 때 읽는 칸들 — 작업대를 여는 데 편집기(CodeMirror)·마크다운·표·비교 코드를 같이 읽지 않게
const EditorView_ = lazy(() => import("./Editor").then((m) => ({ default: m.EditorView_ })));
const BinaryPreview = lazy(() => import("./Preview").then((m) => ({ default: m.BinaryPreview })));
const DiffView = lazy(() => import("./DiffView").then((m) => ({ default: m.DiffView })));
const TailView = lazy(() => import("./TailView").then((m) => ({ default: m.TailView })));
const MonitorPanel = lazy(() => import("./MonitorPanel").then((m) => ({ default: m.MonitorPanel })));
const SyncPanel = lazy(() => import("./SyncPanel").then((m) => ({ default: m.SyncPanel })));
const ContentSearch = lazy(() => import("./panels/ContentSearch").then((m) => ({ default: m.ContentSearch })));
const DockerPanel = lazy(() => import("./panels/DockerPanel").then((m) => ({ default: m.DockerPanel })));
const ServicesPanel = lazy(() => import("./panels/ServicesPanel").then((m) => ({ default: m.ServicesPanel })));
const WebPortsPanel = lazy(() => import("./panels/WebPortsPanel").then((m) => ({ default: m.WebPortsPanel })));
/** 칸 안의 lazy 부분이 올 때까지 빈 칸 */
const Lz = ({ children }: { children: ReactNode }) => <Suspense fallback={<div className="panel-fill" />}>{children}</Suspense>;

/**
 * IDE식 작업대 — 트리·편집기·터미널이 모두 도킹 칸이다.
 * 탭을 끌어 위·아래·좌·우 어디에나 붙이거나 다른 칸에 합치고, 띄워 둘 수도 있다.
 * 고정 칸(트리·터미널·내 PC 트리)의 배치는 작업대 종류별로 앱 DB 에 저장한다(편집기 탭은 저장하지 않음).
 */

const theme: DockviewTheme = { name: "rbshell", className: "rbshell-dock", gap: 0, dndOverlayMounting: "relative" };

type Which = "remote" | "local";
/** 같은 앱에 열려 있는 다른 SSH 연결(서버 ↔ 서버 주고받기) */
type Target = { user: string; host: string; port: number };
type Peer = { conn: number; label: string; home: string; /** 다른 서버에서 이 서버로 접속할 주소(서버끼리 바로 보내기) */ target?: Target };
type Ctx = {
	fs: FsBackend;
	local?: FsBackend;
	term: TermBackend;
	label: string;
	startPath?: string;
	openFile: (which: Which, e: FsEntry, line?: number, peer?: Peer, ctr?: string) => void;
	/** 컨테이너 안 파일(docker exec) — 이름별로 하나 */
	ctrFs: (name: string) => FsBackend;
	/** 트리를 서버로 되돌리기(다음 프롬프트까지) */
	leaveCtr: () => void;
	/** 끌어 놓기 — destConn: 받는 트리의 연결(다른 서버 칸이면 그 서버). 서버가 다르면 중계 */
	drop: (src: DragEntry, destSide: "remote" | "local", destDir: string, destConn?: number) => void;
	/** 다른 서버 칸의 파일 접근 */
	peerFs: (p: Peer) => FsBackend;
	sendTo: (from: Which, e: FsEntry) => void;
	/** 지금 터미널을 그 폴더로 — 프롬프트가 아니면 보내지 않고 false */
	cd: (dir: string, quiet?: boolean) => boolean;
	/** 트리↔터미널 같이(따라가기) */
	follow: boolean;
	setFollow: (v: boolean) => void;
	/** 올리기(파일·폴더 고르기) — 원격 작업대만 */
	uploadPick?: (dir: string, folder: boolean) => void;
	/** 받을 곳 골라 받기 — 원격 작업대만 */
	downloadTo?: (e: FsEntry) => void;
	/** 이 폴더에서 새 터미널 */
	newTerminal: (dir: string) => void;
	/** 서버 로캘로 짐작한 터미널 인코딩 */
	termEncoding?: string;
	/** 내 PC 작업대: 쓸 수 있는 셸과 기본 셸 */
	localShells?: ShellInfo[];
	defaultShell?: string;
	registerShell: (panelId: string, h: ShellHandle | null) => void;
	onCwd: (path: string, ctx?: string, focus?: boolean, panelId?: string) => void;
	/** 손으로 친 docker exec — 그 터미널 맥락을 컨테이너로 두고 트리를 연다 */
	openCtrTree: (name: string, panelId: string) => void;
	/** 보이는 터미널이 트리와 다른 곳(서버·컨테이너)에 있다 — 트리 → 터미널 cd 를 보내지 않는다 */
	termOtherSide: () => boolean;
	completion: CompletionSource;
	openTail: (which: Which, e: FsEntry) => void;
	compare: (which: Which, e: FsEntry) => void;
	compareLabel: (which: Which, e: FsEntry) => string;
	archive: (e: FsEntry) => void;
	/** 다른 서버로 보내기 — fromConn 이 없으면 이 작업대 서버에서 */
	relay: (e: FsEntry, fromConn?: number) => void;
	hasPeers: boolean;
	showTransfers: () => void;
	syncInfo?: { user: string; host: string; port: number };
	/** 동시 입력: 한 터미널에 친 것을 다른 터미널에도 */
	broadcast: (fromPanel: string, data: string) => void;
	/** 바뀔 때마다 트리가 다시 그려지도록(sudo 켜고 끄기) */
	treeKey: string;
	/** 저장 안 한 편집기 기록의 주인(앱 탭) */
	owner: string;
	/** sudo 켜짐 — 자원 칸의 du·kill 용(암호·대상 사용자는 연결한 계정을 따른다) */
	sudoOn: boolean;
	/** 지금 칸 최대화·되돌리기(Alt+M) */
	toggleMaximize: () => void;
	/** 활성 칸(칸마다 boolean 만 구독) */
	activeStore: ActiveStore;
	/** 이 터미널 옆(오른쪽·아래)에 새 터미널 */
	splitTerminal: (panelId: string, dir: "right" | "below") => void;
	/** 원격 작업대: 이 터미널을 root 셸로(sudo -i)·나오기 */
	rootShell?: (panelId: string, on: boolean) => void;
	/** 배치 잠금 — 구조 칸(트리·터미널·전송 등)은 닫지 못한다 */
	locked: boolean;
	/** 동시 입력 켜짐(터미널 칸 머리에서 켜고 끈다) */
	broadcastOn: boolean;
	setBroadcast: (v: boolean) => void;
	/** 그 터미널과 같은 칸에 새 터미널 탭 */
	addTerminalNear: (panelId?: string) => void;
	/** 큰 자원 칸 열기 */
	openMonitor: () => void;
	/** 연결한 계정의 sudo 설정(서비스·Docker 칸) */
	sudo?: SudoCtx;
	/** 새 터미널을 열고 명령 실행(컨테이너 셸·journal 등) */
	openTerminalCmd: (cmd: string, title: string, ctr?: string) => void;
	/** 지금 터미널 폴더 */
	cwdNow: () => string | null;
	/** 원격: 포트 포워딩 관리 창 열기(상태 줄 표시를 누르면) */
	openForwards?: () => void;
	/** 원격: 이 서버 번호(서버별 터미널 색) */
	profileId?: number;
};
const WbCtx = createContext<Ctx | null>(null);

/**
 * 활성 칸 store — 활성 칸이 바뀔 때 모든 칸(트리·터미널·편집기…)이 다시 그려지지 않게,
 * 칸마다 "내가 활성인가" boolean 만 구독한다(useSyncExternalStore 는 값이 같으면 다시 그리지 않는다).
 */
type ActiveStore = {
	panel: string | null;
	/** 이 작업대(앱 탭)가 앞에 보이는가 */
	app: boolean;
	subs: Set<() => void>;
	sub: (f: () => void) => () => void;
	set: (panel: string | null, app?: boolean) => void;
};
function makeActiveStore(): ActiveStore {
	const st: ActiveStore = {
		panel: null,
		app: false,
		subs: new Set(),
		sub: (f) => {
			st.subs.add(f);
			return () => void st.subs.delete(f);
		},
		set: (panel, app) => {
			if (st.panel === panel && (app === undefined || st.app === app)) return;
			st.panel = panel;
			if (app !== undefined) st.app = app;
			for (const f of st.subs) f();
		},
	};
	return st;
}
const useWb = () => useContext(WbCtx) as Ctx;
/** 이 칸이 지금 활성(초점)인가 — 앱 탭이 가려져 있으면 아니다 */
const useIsActive = (id: string) => {
	const st = useWb().activeStore;
	return useSyncExternalStore(st.sub, () => st.app && st.panel === id);
};
/** 이 작업대(앱 탭)가 앞에 보이는가 — 가려진 탭은 서버에 묻지 않는다 */
const useAppActive = () => {
	const st = useWb().activeStore;
	return useSyncExternalStore(st.sub, () => st.app);
};

function TreePanel(props: IDockviewPanelProps<{ which: Which }>) {
	const ctx = useWb();
	const which = props.params.which;
	const fs = which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
	// 원격 트리는 / 를 뿌리로 두고 시작 폴더(또는 홈)를 펼쳐 보인다 — 이전 판과 같은 틀
	const start = which === "remote" ? ctx.startPath || fs.home : fs.home;
	const [root, setRoot] = useState(fs.side === "remote" ? "/" : fs.home);
	const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(() => (fs.side === "remote" ? { path: start, nonce: 1 } : null));
	const follows = which === "remote" || !ctx.local;
	const [note, setNote] = useState<string | null>(null);
	const { follow, setFollow, cd, termOtherSide, openFile, drop, sendTo, openTail, compare, compareLabel, archive, relay, newTerminal, leaveCtr } = ctx;
	const hasLocal = !!ctx.local;
	const inCtr = fs.container;
	const fsSide = fs.side;
	// 트리에서 폴더를 고르면(같이) 터미널이 그 폴더로 — 프롬프트가 아니면 알리고 보내지 않는다
	const onSelectDir = useCallback(
		(dir: string) => {
			if (!follow || !follows) return;
			if (!cd(dir, true)) {
				setNote(termOtherSide() ? "터미널이 트리와 다른 곳(서버·컨테이너)에 있어 cd 하지 않았습니다" : "터미널이 명령을 실행 중이라 cd 하지 않았습니다");
				window.setTimeout(() => setNote(null), 3000);
			}
		},
		[follow, follows, cd, termOtherSide],
	);
	// 터미널을 따라가기: 원격 트리(또는 내 PC 작업대의 트리)만
	useEffect(() => {
		if (!follows) return;
		const on = (ev: Event) => setReveal({ path: (ev as CustomEvent<string>).detail, nonce: Date.now() });
		window.addEventListener(`rb-cwd-${ctx.treeKey}`, on);
		return () => window.removeEventListener(`rb-cwd-${ctx.treeKey}`, on);
	}, [ctx.treeKey, follows]);
	// 인라인 콜백을 칸 안에서 안정시킨다 — FileTree 의 memo 가 효과를 내도록
	const onSyncChange = useCallback((m: "together" | "apart") => setFollow(m === "together"), [setFollow]);
	const onOpen = useCallback((e: FsEntry) => openFile(which, e, undefined, undefined, inCtr), [openFile, which, inCtr]);
	const onDrop = useCallback((src: DragEntry, dir: string) => drop(src, fsSide, dir), [drop, fsSide]);
	const onSend = useCallback((e: FsEntry) => sendTo(which, e), [sendTo, which]);
	const onTail = useCallback((e: FsEntry) => openTail(which, e), [openTail, which]);
	const onCompare = useCallback((e: FsEntry) => compare(which, e), [compare, which]);
	const compareLabelFor = useCallback((e: FsEntry) => compareLabel(which, e), [compareLabel, which]);
	// 터미널이 docker exec 로 들어간 컨테이너 — 트리가 컨테이너 파일을 본다(SFTP 전송·실시간 보기 등은 서버 파일 전용이라 끈다)
	return (
		<div className="panel-fill">
			{inCtr && (
				<div className="tree-ctx" role="status">
					<Container size={13} aria-hidden />
					<span>
						컨테이너 <b>{inCtr}</b>
					</span>
					<small>터미널에서 exit 하면 서버 트리로</small>
					<button type="button" className="btn ghost" onClick={leaveCtr} title="지금 트리만 서버 파일로 되돌립니다 — 터미널이 컨테이너에서 다음 프롬프트를 그리면 다시 따라갑니다">
						서버 트리
					</button>
				</div>
			)}
			<FileTree
				key={inCtr ?? "host"}
				fs={fs}
				root={root}
				onRoot={setRoot}
				reveal={reveal}
				onSelectDir={onSelectDir}
				sync={follows ? (follow ? "together" : "apart") : undefined}
				onSyncChange={follows ? onSyncChange : undefined}
				note={note}
				onOpen={onOpen}
				onDrop={inCtr ? undefined : onDrop}
				onSend={hasLocal && !inCtr ? onSend : undefined}
				sendLabel={which === "local" ? "서버로 올리기" : "내 PC로 받기"}
				onCd={which === "remote" || !hasLocal ? cd : undefined}
				onTail={inCtr ? undefined : onTail}
				onCompare={inCtr ? undefined : onCompare}
				compareLabel={compareLabelFor}
				onArchive={which === "remote" && fsSide === "remote" && !inCtr ? archive : undefined}
				onRelay={which === "remote" && ctx.hasPeers && !inCtr ? relay : undefined}
				onUploadPick={which === "remote" && !inCtr ? ctx.uploadPick : undefined}
				onDownloadTo={which === "remote" && !inCtr ? ctx.downloadTo : undefined}
				onNewTerminal={follows && !inCtr ? newTerminal : undefined}
			/>
		</div>
	);
}

/**
 * 다른 서버 칸 — 같은 앱에 열려 있는 다른 SSH 연결의 파일 트리(IntelliJ 의 원격 호스트 여러 개처럼).
 * 이 작업대 서버 트리·내 PC 트리와 서로 끌어 놓으면 주고받는다(서버끼리는 내 PC 를 거쳐 중계, sha256 확인·이어 보내기).
 */
function PeerTreePanel(props: IDockviewPanelProps<{ peer: Peer }>) {
	const ctx = useWb();
	const peer = props.params.peer;
	const fs = ctx.peerFs(peer);
	const [root, setRoot] = useState("/");
	const [reveal] = useState(() => ({ path: peer.home, nonce: 1 }));
	return (
		<div className="panel-fill">
			<FileTree
				fs={fs}
				root={root}
				onRoot={setRoot}
				reveal={reveal}
				onOpen={(e) => ctx.openFile("remote", e, undefined, peer)}
				onDrop={(src, dir) => ctx.drop(src, "remote", dir, peer.conn)}
				onSend={ctx.local ? (e) => ctx.drop({ side: "remote", conn: peer.conn, path: e.path, name: e.name, kind: e.kind }, "local", ctx.local?.home ?? "") : undefined}
				sendLabel="내 PC로 받기"
				onRelay={(e) => ctx.relay(e, peer.conn)}
			/>
		</div>
	);
}

function EditorPanel(props: IDockviewPanelProps<{ which: Which; path: string; name: string; line?: { n: number; seq: number }; peer?: Peer; ctr?: string }>) {
	const ctx = useWb();
	const isActive = useIsActive(props.api.id);
	const fs = props.params.peer
		? ctx.peerFs(props.params.peer)
		: props.params.ctr
			? ctx.ctrFs(props.params.ctr)
			: props.params.which === "local"
				? (ctx.local ?? ctx.fs)
				: ctx.fs;
	const onDirty = useCallback(
		(dirty: boolean) => {
			setDirty(ctx.owner, props.api.id, props.params.name, dirty);
			// 다른 서버·컨테이너 파일은 어디 것인지 탭에 남긴다(같은 이름의 서버 파일과 헷갈리지 않게)
			const where = props.params.ctr ? ` · ${props.params.ctr}` : props.params.peer ? ` · ${props.params.peer.label}` : "";
			props.api.setTitle(`${dirty ? "● " : ""}${props.params.name}${where}`);
		},
		[props.api, props.params.name, props.params.ctr, props.params.peer, ctx.owner],
	);
	useEffect(() => () => setDirty(ctx.owner, props.api.id, "", false), [ctx.owner, props.api.id]);
	const kind = previewKind(props.params.path);
	return (
		<div className="panel-fill">
			{kind ? (
				<Lz>
				<BinaryPreview fs={fs} path={props.params.path} kind={kind} />
			</Lz>
			) : (
				<Lz>
					<EditorView_
					fs={fs}
					path={props.params.path}
					active={isActive}
					onDirtyChange={onDirty}
					line={props.params.line}
					onTail={props.params.ctr ? undefined : () => ctx.openTail(props.params.which, { name: props.params.name, path: props.params.path, kind: "file", size: 0 })}
										/>
									</Lz>
			)}
		</div>
	);
}

function TerminalPanel(props: IDockviewPanelProps<{ n: number; cwd?: string; shell?: string }>) {
	const ctx = useWb();
	const isActive = useIsActive(props.api.id);
	const appActive = useAppActive();
	// 내 PC 작업대: 셸 고르기(기본은 설정 › 터미널 › 내 PC 셸)
	const [shell, setShell] = useState<string | undefined>(props.params.shell ?? (ctx.localShells ? ctx.defaultShell : undefined));
	useEffect(() => {
		if (!shell && ctx.localShells && ctx.defaultShell) setShell(ctx.defaultShell);
	}, [ctx.defaultShell, ctx.localShells, shell]);
	// 보이는 터미널에만 작은 자원 표시(가려진 탭은 서버에 묻지 않는다)
	const [visible, setVisible] = useState(props.api.isVisible);
	useEffect(() => {
		const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		return () => d.dispose();
	}, [props.api]);
	const info = ctx.localShells?.find((s) => s.id === shell);
	const kind = info ? (info.kind === "pwsh" ? "pwsh" : info.kind === "cmd" ? "cmd" : "linux") : "linux";
	// 이 터미널이 지금 들어가 있는 컨테이너 — 경로 자동완성 목록을 그 쪽 파일로
	const myCtr = useRef<string | null>(null);
	const completion = useMemo(
		() => ({
			...ctx.completion,
			key: `${ctx.completion.key}:${kind}`,
			shellKind: kind as "linux" | "pwsh" | "cmd",
			listDir: (dir: string) => (myCtr.current ? ctx.ctrFs(myCtr.current).list(dir) : ctx.completion.listDir(dir)),
		}),
		[ctx.completion, ctx.ctrFs, kind],
	);
	// 명령 입력 보조(D25) — 원격 SSH 와 내 PC 의 bash·zsh·Git Bash·WSL 만(PowerShell·cmd·그 밖은 끔)
	const assist = !ctx.localShells || (!!info && (info.kind === "bash" || info.kind === "zsh" || info.kind === "wsl"));
	// 터미널이 셸 정보(목록)를 받기 전에는 열지 않는다(기본 셸로 한 번 열렸다 다시 열리지 않게)
	if (ctx.localShells && !shell) return <div className="panel-fill" />;
	return (
		<div className="panel-fill">
			<TerminalView
				backend={ctx.term}
				active={isActive}
				cwd={props.params.cwd ?? ctx.startPath}
				label={ctx.label}
				toolbar={false}
				onShell={(h) => ctx.registerShell(props.api.id, h)}
				onCwd={(p, c, f) => {
					if (c !== undefined) myCtr.current = ctxContainer(c);
					ctx.onCwd(p, c, f, props.api.id);
				}}
				onManualCtr={(name) => {
					myCtr.current = name;
					ctx.openCtrTree(name, props.api.id);
				}}
				onInput={(d) => ctx.broadcast(props.api.id, d)}
				completion={ctx.localShells ? completion : ctx.completion}
				assist={assist}
				shell={shell}
				shellOptions={ctx.localShells?.map((s) => ({ value: s.id, label: s.label, hint: s.admin ? "관리자" : undefined }))}
				onShellChange={(id) => {
					setShell(id);
					props.api.updateParameters({ ...props.params, shell: id });
					const label = ctx.localShells?.find((s) => s.id === id)?.label;
					if (label) props.api.setTitle(label);
				}}
				defaultEncoding={ctx.termEncoding}
				onOpenPath={(p, c) => ctx.openFile("remote", { name: p.split("/").pop() ?? p, path: p, kind: "file", size: 0 }, undefined, undefined, ctxContainer(c) ?? undefined)}
				onSplit={(dir) => ctx.splitTerminal(props.api.id, dir)} onMaximize={ctx.toggleMaximize}
				statusExtra={
					visible && ctx.fs.side === "remote" && ctx.fs.conn != null ? (
						<>
							<RouteChip conn={ctx.fs.conn} />
							{ctx.openForwards && <ForwardChips conn={ctx.fs.conn} onOpen={ctx.openForwards} />}
							<MiniMonitor conn={ctx.fs.conn} onOpen={ctx.openMonitor} enabled={appActive} />
						</>
					) : undefined
				}
				onRootShell={ctx.rootShell ? (on) => ctx.rootShell?.(props.api.id, on) : undefined}
				profileId={ctx.profileId}
				onRecording={(on) => {
					// 기록 중이면 탭 이름 앞(동시 입력 표시 뒤)에 ●
					const m = /^(⇉ )?(● )?([\s\S]*)$/.exec(props.api.title ?? "");
					props.api.setTitle(`${m?.[1] ?? ""}${on ? "● " : ""}${m?.[3] ?? ""}`);
				}}
			/>
		</div>
	);
}

function TailPanel(props: IDockviewPanelProps<{ which: Which; path: string }>) {
	const ctx = useWb();
	const fs = props.params.which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
	return (
		<Lz>
			<TailView fs={fs} path={props.params.path} />
		</Lz>
	);
}

function DiffPanel(props: IDockviewPanelProps<{ a: { which: Which; path: string }; b: { which: Which; path: string } }>) {
	const ctx = useWb();
	const side = (s: { which: Which; path: string }) => {
		const fs = s.which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
		return { fs, path: s.path, label: `${s.which === "local" ? "내 PC" : fs.label}:${s.path.split("/").pop()}` };
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: 열 때 한 번
	const sides = useMemo(() => [side(props.params.a), side(props.params.b)] as const, []);
	return (
		<Lz>
			<DiffView a={sides[0]} b={sides[1]} />
		</Lz>
	);
}

function SyncDock() {
	const ctx = useWb();
	if (ctx.fs.conn == null || !ctx.syncInfo) return null;
	return (
		<Lz>
			<SyncPanel conn={ctx.fs.conn} remoteHome={ctx.fs.home} user={ctx.syncInfo.user} host={ctx.syncInfo.host} port={ctx.syncInfo.port} onRun={ctx.showTransfers} />
		</Lz>
	);
}

/** 칸이 보이는지(자동 새로 고침·실시간 보기는 보일 때만) */
function usePanelVisible(api: IDockviewPanelProps["api"]) {
	const [visible, setVisible] = useState(api.isVisible);
	useEffect(() => {
		const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		return () => d.dispose();
	}, [api]);
	return visible;
}
const remoteOnly = <div className="panel-fill mon-empty"><p>원격 서버 작업대에서만 볼 수 있습니다</p></div>;

function ServicesDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const visible = usePanelVisible(props.api);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return remoteOnly;
	return (
		<Lz>
			<ServicesPanel conn={ctx.fs.conn} sudo={ctx.sudo} sudoOn={ctx.sudoOn} visible={visible} onOpenTerminal={ctx.openTerminalCmd} />
		</Lz>
	);
}
function DockerDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const visible = usePanelVisible(props.api);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return remoteOnly;
	return (
		<Lz>
			<DockerPanel conn={ctx.fs.conn} sudo={ctx.sudo} visible={visible} onOpenTerminal={ctx.openTerminalCmd} />
		</Lz>
	);
}
function WebPortsDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const visible = usePanelVisible(props.api);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return remoteOnly;
	return (
		<Lz>
			<WebPortsPanel conn={ctx.fs.conn} sudo={ctx.sudo} visible={visible} />
		</Lz>
	);
}
function SearchDock(_props: IDockviewPanelProps) {
	const ctx = useWb();
	return (
		<Lz>
			<ContentSearch
			side={ctx.fs.side}
			conn={ctx.fs.conn}
			sudo={ctx.sudo}
			startDir={ctx.cwdNow() ?? ctx.fs.home}
			onOpenFile={(p, line) => ctx.openFile("remote", { name: p.split("/").pop() ?? p, path: p, kind: "file", size: 0 }, line)}
			/>
		</Lz>
	);
}

function MonitorDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const [visible, setVisible] = useState(props.api.isVisible);
	useEffect(() => {
		const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		return () => d.dispose();
	}, [props.api]);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return <div className="panel-fill mon-empty"><p>원격 서버 작업대에서만 볼 수 있습니다</p></div>;
	return (
		<Lz>
			<MonitorPanel conn={ctx.fs.conn} sudoOn={ctx.sudoOn} visible={visible} />
		</Lz>
	);
}

/** 탭 — 저장 안 한 편집기는 닫기 전에 묻는다 */
/** 터미널 칸 머리 오른쪽 — 이 칸에 새 터미널·동시 입력·나누기(대상이 이 칸이라 도구 막대가 아니라 여기에) */
function GroupActions(props: IDockviewHeaderActionsProps) {
	const ctx = useWb();
	const terms = props.panels.filter((p) => p.id.startsWith("term-"));
	if (!terms.length) return null;
	const target = props.activePanel?.id.startsWith("term-") ? props.activePanel.id : terms[0].id;
	return (
		<div className="group-actions" onMouseDown={(e) => e.stopPropagation()}>
			<button type="button" className="btn ghost icon" title="이 칸에 새 터미널 탭(같은 연결 위 새 채널)" onClick={() => ctx.addTerminalNear(target)}>
				<Plus size={13} />
			</button>
			<button
				type="button"
				className={`btn ghost icon${ctx.broadcastOn ? " on bcast-on" : ""}`}
				aria-pressed={ctx.broadcastOn}
				title={ctx.broadcastOn ? "동시 입력 켜짐 — 한 터미널에 친 것이 이 작업대의 모든 터미널(탭에 ⇉ 표시)에 갑니다. 눌러 끄기" : "동시 입력 — 한 터미널에 친 것을 이 작업대의 모든 터미널에"}
				onClick={() => ctx.setBroadcast(!ctx.broadcastOn)}
			>
				<Radio size={13} />
			</button>
			<button type="button" className="btn ghost icon" title={ctx.locked ? "배치가 잠겨 있어 나눌 수 없습니다" : "오른쪽으로 나누기 — 이 터미널 옆에 새 터미널 칸"} disabled={ctx.locked} onClick={() => ctx.splitTerminal(target, "right")}>
				<Columns2 size={13} />
			</button>
			<button type="button" className="btn ghost icon" title={ctx.locked ? "배치가 잠겨 있어 나눌 수 없습니다" : "아래로 나누기 — 이 터미널 아래에 새 터미널 칸"} disabled={ctx.locked} onClick={() => ctx.splitTerminal(target, "below")}>
				<Rows2 size={13} />
			</button>
		</div>
	);
}

/** 문서 칸(편집기·tail·비교) — 배치를 잠가도 닫을 수 있다 */
const isDoc = (id: string) => /^(edit|tail|diff):/.test(id);

function GuardedTab(props: IDockviewPanelHeaderProps) {
	const ctx = useWb();
	// 잠금: 구조 칸은 같은 칸에 다른 탭이 있을 때만 닫을 수 있다(칸이 없어지지 않게)
	const noClose = ctx.locked && !isDoc(props.api.id) && props.api.group.panels.length <= 1;
	return (
		<DockviewDefaultTab
			{...props}
			hideClose={noClose}
			closeActionOverride={() => {
				if (noClose) return;
				if (isDirty(ctx.owner, props.api.id) && !confirmDiscard([props.api.title?.replace(/^● /, "") ?? props.api.id], "이 탭을 닫으면")) return;
				props.api.close();
			}}
		/>
	);
}

function Watermark() {
	return (
		<div className="dock-watermark">
			<FileText size={28} strokeWidth={1.2} />
			<p style={{ margin: 0, color: "var(--text-2)" }}>트리에서 파일을 누르면 여기서 열립니다</p>
			<small>탭을 끌어 위·아래·좌·우로 옮기거나 다른 칸에 합칠 수 있습니다</small>
		</div>
	);
}

function fmtBytes(n: number) {
	if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
	return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 전송 칸 — 진행률·속도·취소, 끝나면 받은 쪽 트리를 새로 읽는다 */
/** 남은 시간 — 초 → 1시간 2분 · 3분 4초 · 5초 */
function fmtEta(s: number) {
	if (!Number.isFinite(s)) return "";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = Math.round(s % 60);
	return h ? `${h}시간 ${m}분` : m ? `${m}분 ${sec}초` : `${sec}초`;
}

/** 서버 → 서버 보내는 방식(지난번에 고른 것을 위에) */
let s2sLast: "direct" | "relay" = "relay";
async function askServerToServer(name: string, from: string, to: string, t: Target): Promise<"direct" | "relay" | null> {
	const opts = [
		{
			value: "direct",
			label: "서버끼리 바로",
			desc: `${from}에서 ${t.user}@${t.host} 로 직접 접속해 rsync(없으면 scp)로 보냅니다. 내 PC 회선을 쓰지 않아 빠릅니다 — 보내는 서버의 키가 받는 서버에 등록돼 있어야 합니다.`,
		},
		{
			value: "relay",
			label: "내 PC 거쳐서",
			desc: "내 PC 가 두 서버에 연결된 채로 흘려 보냅니다. 서버끼리 막혀 있어도 되고, sha256 확인·끊기면 이어 보내기를 합니다.",
		},
	];
	if (s2sLast === "relay") opts.reverse();
	const v = await askText({ title: `${name} 보내기`, message: `${from} → ${to}`, choiceOnly: true, choices: opts });
	if (v !== "direct" && v !== "relay") return null;
	s2sLast = v;
	return v;
}

/** 작업대(owner)별 옆에 연 다른 서버 칸(peer) 연결 — 전송 칸이 peer ↔ 내 PC 전송을 제 것으로 알아보는 데 쓴다 */
const peerConnsOf = new Map<string, Set<number>>();

function TransfersPanel() {
	const ctx = useWb();
	const [list, setList] = useState<TransferProgress[]>([]);
	// 앱 탭마다 이 칸이 있다 — 다른 탭(다른 서버)에서 시작한 전송이 섞여 보이지 않게 출발 연결(conn)이 내 것이 아니면 무시한다
	const myConn = useRef(ctx.fs.conn);
	myConn.current = ctx.fs.conn;
	const ownerRef = useRef(ctx.owner);
	ownerRef.current = ctx.owner;
	useEffect(() => {
		const un = listen<TransferProgress>("transfer", (e) => {
			const p = e.payload;
			// 내 작업대가 시작한 전송: 출발·도착 연결이 내 것이거나, 옆에 연 다른 서버 칸(peer) ↔ 내 PC 전송(conn = peer, destConn 없음)
			const mine = (c: number | null | undefined) => c != null && (c === myConn.current || (peerConnsOf.get(ownerRef.current)?.has(c) ?? false));
			if (p.conn != null && !mine(p.conn) && !mine(p.destConn)) return;
			setList((l) => {
				const i = l.findIndex((x) => x.id === p.id);
				if (i < 0) return [p, ...l].slice(0, 50);
				const n = l.slice();
				n[i] = p;
				return n;
			});
			if (p.state === "done" || p.state === "cancelled") {
				// 서버 → 서버는 받는 서버 트리를, 아니면 받은 쪽(올리기=이 서버, 받기=내 PC)
				if (p.destConn != null) notifyFsChanged("remote", parentDir(p.dest), p.destConn);
							else notifyFsChanged(p.direction === "up" ? "remote" : "local", parentDir(p.dest), p.conn ?? myConn.current);
						}
					});
					return () => void un.then((f) => f());
				}, []);
	const [archives, setArchives] = useState<{ path: string; dest: string; bytes: number; state: string; error?: string | null }[]>([]);
	useEffect(() => {
		const un = listen<{ path: string; dest: string; bytes: number; state: string; error?: string | null }>("archive", (e) => {
			const p = e.payload;
			setArchives((l) => [p, ...l.filter((x) => x.dest !== p.dest)].slice(0, 20));
		});
		return () => void un.then((f) => f());
	}, []);
	if (!list.length && !archives.length) return <div className="dock-watermark">트리끼리 끌어 놓거나 우클릭 › 올리기·받기</div>;
	return (
		<div className="xfer">
			{archives.map((a) => (
				<div key={a.dest} className="xfer-row">
					<span>
						↓ 폴더째 <b>{a.path.split("/").pop()}</b> (.tar.gz)
					</span>
					<small>{a.state === "running" ? "받는 중" : a.state === "done" ? "완료" : "실패"}</small>
					<div className={`bar ${a.state}`}>
						<i style={{ transform: `scaleX(${a.state === "running" ? 0.4 : 1})` }} />
					</div>
					<small>
						{fmtBytes(a.bytes)}
						{a.error ? ` · ${a.error}` : ""}
					</small>
					<small />
				</div>
			))}
			{list.map((p) => {
				const pct = p.bytesTotal ? Math.round((100 * p.bytesDone) / p.bytesTotal) : p.state === "done" ? 100 : 0;
				const speed = p.ms > 0 ? p.bytesDone / (p.ms / 1000) : 0;
				return (
					<div key={p.id} className="xfer-row">
						<span>
							{p.direction === "up" ? (
								<><ArrowUp size={12} aria-hidden /> 올리기</>
							) : p.direction === "relay" ? (
								<><ArrowLeftRight size={12} aria-hidden /> 내 PC 거쳐</>
							) : p.direction === "direct" ? (
								<><Route size={12} aria-hidden /> 서버끼리</>
							) : (
								<><ArrowDown size={12} aria-hidden /> 받기</>
							)}{" "}
							<b>{p.name}</b>
						</span>
						{p.state === "running" ? (
							<button type="button" className="btn ghost icon" style={{ height: 20, width: 20 }} title="취소" onClick={() => void transfers.cancel(p.id)}>
								<X size={12} />
							</button>
						) : (
							<span className="xfer-end">
								<small>{p.state === "done" ? "완료" : p.state === "cancelled" ? "취소됨" : "실패"}</small>
								{(p.state === "error" || p.state === "cancelled") && transferArgs.has(p.id) && (
									<button
										type="button"
										className="btn ghost"
										style={{ height: 20 }}
										title="다시 — 다 받은 파일은 건너뛰고, 받다 만 파일(.rbpart)은 이어서"
										onClick={() => {
											const a = transferArgs.get(p.id);
											if (a) void transfers.start(a.conn, a.direction, a.src, a.destDir, false, a.destName).catch((e) => alert(asSshError(e).message));
										}}
									>
										다시(이어서)
									</button>
								)}
								{p.state === "error" && directArgs.has(p.id) && (
									<button
										type="button"
										className="btn ghost"
										style={{ height: 20 }}
										title="서버끼리 바로 보내지 못했을 때 — 내 PC 가 양쪽에 연결된 채로 흘려 보냅니다(sha256 확인·이어 보내기)"
										onClick={() => {
											const a = directArgs.get(p.id);
											if (a) void invoke("relay_start", { ...a, destName: a.destName ?? null }).catch((e) => alert(asSshError(e).message));
										}}
									>
										내 PC 거쳐서
									</button>
								)}
							</span>
						)}
						<div className={`bar ${p.state}`}>
							<i style={{ transform: `scaleX(${pct / 100})` }} />
						</div>
						<small>
							{fmtBytes(p.bytesDone)} / {fmtBytes(p.bytesTotal)} · 파일 {p.filesDone}/{p.filesTotal}
							{p.skipped ? ` · 건너뜀 ${p.skipped}` : ""}
							{p.verified ? ` · sha256 확인 ${p.verified}` : ""}
							{p.resumed ? ` · 이어받음 ${p.resumed}` : ""}
							{p.error ? ` · ${p.error}` : ""}
						</small>
						<small>
							{speed ? `${fmtBytes(speed)}/s` : ""}
							{p.state === "running" && speed > 0 && p.bytesTotal > p.bytesDone ? ` · 남은 ${fmtEta((p.bytesTotal - p.bytesDone) / speed)}` : ""}
						</small>
					</div>
				);
			})}
		</div>
	);
}

const components = {
	tree: TreePanel,
	peertree: PeerTreePanel,
	editor: EditorPanel,
	terminal: TerminalPanel,
	transfers: TransfersPanel,
	tail: TailPanel,
	diff: DiffPanel,
	sync: SyncDock,
	monitor: MonitorDock,
	services: ServicesDock,
	docker: DockerDock,
	webports: WebPortsDock,
	search: SearchDock,
};
const FIXED = /^(tree|localtree|transfers|term-\d+)$/;

/**
 * 문서 칸(편집기·tail·비교·자원) 놓기 — 빈 문서 자리(기본 배치의 가운데)가 있으면 거기,
 * 이미 문서가 있으면 그 칸의 탭으로, 둘 다 없으면 터미널 위 넓은 자리(높이 62%).
 */
function addDoc(d: DockviewApi, opts: { id: string; component: string; title: string; params?: object }) {
	const empty = d.groups.find((g) => g.panels.length === 0);
	if (empty) {
		d.addPanel({ ...opts, renderer: "always", position: { referenceGroup: empty.id } });
		return;
	}
	const anyDoc = d.panels.find((p) => /^(edit|tail|diff):/.test(p.id) || /^(monitor|services|docker|webports|search)$/.test(p.id));
	if (anyDoc) {
		d.addPanel({ ...opts, renderer: "always", position: { referencePanel: anyDoc.id, direction: "within" } });
		return;
	}
	const term = d.panels.find((p) => p.id.startsWith("term-"));
	unhide(term);
	const p = d.addPanel({
		...opts,
		renderer: "always",
		position: term ? { referencePanel: term.id, direction: "above" } : { referencePanel: d.getPanel("tree") ? "tree" : (d.panels[0]?.id ?? ""), direction: "right" },
	});
	if (term) {
		const total = p.group.height + term.group.height;
		if (total > 0) p.group.api.setSize({ height: Math.round(total * 0.62) });
	}
}

/** 아래 칸(전송·동기화) — VS Code 의 아래 패널처럼 터미널 칸의 탭으로 */
function addBottom(d: DockviewApi, opts: { id: string; component: string; title: string }, focus: boolean) {
	const term = d.panels.find((p) => p.id.startsWith("term-"));
	unhide(term);
	d.addPanel({
		...opts,
		renderer: "always",
		position: term ? { referencePanel: term.id, direction: "within" } : { direction: "below" },
		inactive: !focus,
	});
}

/**
 * 기본 배치 — 터미널 우선. 서버 작업대는 왼쪽 트리 + 나머지 전부 터미널, 내 PC 작업대는 터미널만.
 * 문서 칸(편집기·tail·비교·도구)은 파일을 열 때 터미널 위에 생긴다(addDoc). 빈 문서 자리를 미리 두지 않는다.
 * 내 PC 트리·다른 서버 칸은 주고받을 때 도구 막대에서 오른쪽에 연다.
 */
function defaultLayout(d: DockviewApi, terminalOnly = false) {
	d.clear();
	if (terminalOnly) {
		const term = d.addPanel({ id: "term-1", component: "terminal", title: "터미널", params: { n: 1 }, renderer: "always" });
		term.api.setActive();
		return;
	}
	d.addPanel({ id: "tree", component: "tree", title: "파일", params: { which: "remote" }, renderer: "always" });
	const term = d.addPanel({
		id: "term-1",
		component: "terminal",
		title: "터미널",
		params: { n: 1 },
		renderer: "always",
		position: { referencePanel: "tree", direction: "right" },
	});
	d.getPanel("tree")?.api.setSize({ width: 250 });
	term.api.setActive();
}

/**
 * 되살린 배치 바로잡기 — 서버 작업대가 "트리만 덩그러니" 보이지 않게.
 * ① Ctrl+` 로 숨긴 칸은 다시 보이게(옛 저장본에 숨김이 남아 있을 수 있다)
 * ② 편집기를 빼고 저장해 비어 버린 칸은 지운다
 * ③ 터미널이 없으면(마지막 터미널을 닫은 채 저장) 트리 오른쪽에 하나
 * ④ sizes: 트리 밖 칸이 최소 폭(100)에 붙어 있으면 편다 — 숨은 터미널 칸 "위"에 편집기가 열리며 100px 띠로 굳은 배치.
 *    작업대가 실제로 보일 때(폭이 있을 때)만, 되살릴 때 한 번
 */
function repairLayout(d: DockviewApi, needTerm: boolean, nextTerm: () => number, sizes: boolean) {
	for (const g of d.groups) if (!g.api.isVisible) g.api.setVisible(true);
	for (const g of [...d.groups]) if (g.panels.length === 0 && d.groups.length > 1) d.removeGroup(g);
	const sized = d.width >= 480 && d.height >= 240;
	if (needTerm && !d.panels.some((p) => p.id.startsWith("term-"))) {
		const n = nextTerm();
		const tree = d.getPanel("tree");
		d.addPanel({
			id: `term-${n}`,
			component: "terminal",
			title: n === 1 ? "터미널" : `터미널 ${n}`,
			params: { n },
			renderer: "always",
			position: tree ? { referencePanel: "tree", direction: "right" } : undefined,
		});
		if (tree && sized) tree.api.setSize({ width: 250 });
	}
	if (!sizes || !sized) return;
	const MIN = 104; // dockview 의 칸 최소 크기는 100
	const tree = d.getPanel("tree")?.group;
	const others = d.groups.filter((g) => g !== tree);
	// 트리 밖 칸이 모두 최소 폭이면(트리가 화면을 다 차지) 트리를 기본 폭으로
	if (tree && others.length && others.every((g) => g.width <= MIN)) tree.api.setSize({ width: 250 });
	for (const g of others) {
		if (g.width <= MIN) g.api.setSize({ width: Math.round(d.width * 0.5) });
		if (g.height <= MIN && d.height > 400) g.api.setSize({ height: Math.round(d.height * 0.4) });
	}
}

/** 칸이 숨겨져 있으면(Ctrl+`) 보이게 — 숨은 칸을 기준으로 새 칸을 붙이면 크기 0 옆에 끼어 안 보인다 */
function unhide(p: { group: { api: { isVisible: boolean; setVisible(v: boolean): void } } } | undefined) {
	if (p && !p.group.api.isVisible) p.group.api.setVisible(true);
}

/** 저장용 배치 — 편집기 탭은 빼고 고정 칸만 */
function stripEditors(json: ReturnType<DockviewApi["toJSON"]>) {
	const j = structuredClone(json) as unknown as {
		panels: Record<string, unknown>;
		grid: { root: unknown };
		activeGroup?: string;
	};
	for (const id of Object.keys(j.panels)) if (!FIXED.test(id)) delete j.panels[id];
	const walk = (node: { type: string; data: unknown; visible?: boolean }): boolean => {
		delete node.visible;
		if (node.type === "leaf") {
			const g = node.data as { views: string[]; activeView?: string };
			g.views = g.views.filter((v) => FIXED.test(v));
			if (g.activeView && !FIXED.test(g.activeView)) g.activeView = g.views[0];
			return true;
		}
		const kids = node.data as { type: string; data: unknown; visible?: boolean }[];
		for (const k of kids) walk(k);
		return true;
	};
	walk(j.grid.root as { type: string; data: unknown });
	return j as unknown as ReturnType<DockviewApi["toJSON"]>;
}

/**
 * 열려 있던 편집기 탭(앱 탭별) — 연결이 끊겨 다시 연결하면 작업대가 새로 그려지는데, 그때 같은 파일들을 다시 연다.
 * 저장 안 한 고친 내용은 편집기 초안으로 남아 다시 열 때 되살릴지 묻는다.
 */
/** 동시 입력이 켜졌을 때 터미널 탭 이름 앞 표시 */
const BCAST = "⇉ ";

/** 키 이벤트가 터미널 안에서 났는지 */
const inTerminal = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.(".xterm");

const openEditors = new Map<string, { which: Which; path: string; name: string }[]>();

export const Workbench = memo(function Workbench({
	fs,
	local,
	term,
	active,
	label,
	startPath,
	badge,
	layoutKey,
	sudo,
	peers = [],
	syncInfo,
	ownerId,
	server,
	onConnectOther,
}: {
	fs: FsBackend;
	/** 원격 작업대일 때 내 PC 트리(전송용) */
	local?: FsBackend;
	term: TermBackend;
	active: boolean;
	label: string;
	startPath?: string;
	badge?: ReactNode;
	/** 배치 저장 이름(작업대 종류별) */
	layoutKey: string;
	/** 연결한 계정의 sudo 설정 — off 면 sudo 단추·root 셸을 숨긴다(원격만) */
	sudo?: { mode: SudoMode; user: string };
	/** 열려 있는 다른 SSH 연결(서버 ↔ 서버 대상) */
	peers?: Peer[];
	/** 다른 서버를 골라 연결 — 연결되면 이 작업대 옆 칸에 그 서버 트리를 연다(rb-open-peer) */
	onConnectOther?: () => void;
	syncInfo?: { user: string; host: string; port: number };
	/** 앱 탭 이름 — 저장 안 한 편집기를 앱 탭 단위로 묻기 위해 */
	ownerId?: string;
	/** 원격: 이 연결의 서버(포트 포워딩 규칙·tmux 설정) */
	server?: { profileId: number; conn: number; tmux: boolean; name: string };
}) {
	// App 이 렌더마다 새로 만드는 객체 props 를 값이 같으면 같은 참조로 — ctx 가 이유 없이 바뀌지 않게
	const syncInfoS = useMemo(() => (syncInfo ? { user: syncInfo.user, host: syncInfo.host, port: syncInfo.port } : undefined), [syncInfo?.user, syncInfo?.host, syncInfo?.port]);
	const sudoS = useMemo(() => (sudo ? { mode: sudo.mode, user: sudo.user || "root" } : undefined), [sudo?.mode, sudo?.user]);
	const hasServer = !!server;
	const serverProfileId = server?.profileId;
	const onConnectOtherRef = useRef(onConnectOther);
	onConnectOtherRef.current = onConnectOther;
	const hasConnectOther = !!onConnectOther;
	const [fwdOpen, setFwdOpen] = useState(false);
	const [tmuxOpen, setTmuxOpen] = useState(false);
	const [sudoOn, setSudoOn] = useState(false);
	const [sudoPlace, setSudoPlace] = useState<"together" | "apart">("together");
	const [follow, setFollow] = useState(true);
	/** 터미널이 지금 들어가 있는 컨테이너(트리·편집기가 볼 곳) — 셸 훅이 프롬프트마다 알려 준다 */
	const [ctr, setCtr] = useState<string | null>(null);
	const [broadcastOn, setBroadcastOn] = useState(false);
	const broadcastRef = useRef(false);
	broadcastRef.current = broadcastOn;
	const [sudoAsk, setSudoAsk] = useState<{ error?: string } | null>(null);
	const sudoMode = sudo?.mode ?? "ask";
	const sudoUser = sudo?.user && sudo.user !== "root" ? sudo.user : "";
	const sudoAs = sudoUser ? ` -u ${sudoUser}` : "";
	const instance = useRef(`wb${Math.random().toString(36).slice(2, 8)}`);
	const owner = ownerId ?? instance.current;
	// 서버 로캘이 EUC-KR(CP949) 이면 터미널을 처음부터 EUC-KR 로
	const [termEncoding, setTermEncoding] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (fs.side !== "remote" || fs.conn == null) return;
		void invoke<string>("ssh_exec", { conn: fs.conn, cmd: 'locale charmap 2>/dev/null; echo "$LANG $LC_ALL"' })
			.then((out) => {
				if (/euc-?kr|cp949|ksc5601|uhc/i.test(out)) setTermEncoding("EUC-KR");
			})
			.catch(() => undefined);
	}, [fs]);
	const [help, setHelp] = useState(false);
	const [locked, setLocked] = useLayoutLock(layoutKey);
	const lockedRef = useRef(locked);
	lockedRef.current = locked;
	const [lockNote, setLockNote] = useState(false);
	/** 지금 열린 칸 id(도구 막대 단추 켜짐 표시) */
	const [shownIds, setShownIds] = useState("");
	const has = (id: string) => shownIds.split("|").includes(id);
	/** 잠겨 있으면 알리고 true */
	const blockedByLock = () => {
		if (!lockedRef.current) return false;
		setLockNote(true);
		window.setTimeout(() => setLockNote(false), 2500);
		return true;
	};
	const [quickOpen, setQuickOpen] = useState(false);
	const conflict = useConflictAsk();
	// 내 PC 셸 목록·기본 셸·관리자 여부
	const [shellList, setShellList] = useState<ShellInfo[] | undefined>(undefined);
	const [defaultShell, setDefaultShell] = useState<string | undefined>(undefined);
	const [isAdmin, setIsAdmin] = useState(false);
	const [adminMenu, setAdminMenu] = useState<{ x: number; y: number } | null>(null);
	const [toolMenu, setToolMenu] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (fs.side !== "local") return;
		void localShells().then(async (l) => {
			const saved = await api.settingGet("term.localShell");
			setShellList(l);
			setDefaultShell(l.find((s) => s.id === saved)?.id ?? l[0]?.id);
		});
		void invoke<boolean>("app_is_admin").then(setIsAdmin).catch(() => undefined);
	}, [fs]);
	useEffect(() => () => forgetOwner(owner), [owner]);
	const sudoFs = useMemo(
		() => (fs.side === "remote" && fs.conn != null && sudoMode !== "off" ? sshSudoFs(fs.conn, fs.label, fs.home, sudoUser || "root") : null),
		[fs, sudoMode, sudoUser],
	);
	const ctrCache = useRef(new Map<string, FsBackend>());
	const ctrFs = useCallback(
		(name: string) => {
			if (fs.conn == null) return fs;
			const k = `${fs.conn}:${name}`;
			let f = ctrCache.current.get(k);
			if (!f) {
				f = containerFs(fs.conn, name);
				ctrCache.current.set(k, f);
			}
			return f;
		},
		[fs],
	);
	const ctrRef = useRef(ctr);
	ctrRef.current = ctr;
	/** 터미널 칸마다 마지막 프롬프트의 맥락(host · docker:이름) — 트리는 지금 쓰는(마지막으로 초점을 받은) 터미널을 따른다 */
	const termCtx = useRef(new Map<string, string | undefined>());
	const lastTerm = useRef<string | null>(null);
	const fsNow = ctr && fs.side === "remote" && fs.conn != null ? ctrFs(ctr) : sudoOn && sudoFs ? sudoFs : fs;
	// 자동완성 출처 — 원격은 SFTP 목록·compgen, 내 PC 는 파일 목록·사전
	const completion = useMemo<CompletionSource>(
		() => ({
			key: fs.side === "remote" ? `ssh:${label}` : "local",
			home: fs.home,
			listDir: (dir) => fs.list(dir),
			commands: async () => {
				if (fs.side !== "remote" || fs.conn == null) return [];
				const out = await invoke<string>("ssh_exec", { conn: fs.conn, cmd: "bash -lc 'compgen -c' 2>/dev/null | sort -u | head -5000" });
				return out.split("\n").filter((x) => /^[\w.+-]+$/.test(x));
			},
			units:
				fs.side === "remote" && fs.conn != null
					? async () => {
							const out = await invoke<string>("ssh_exec", { conn: fs.conn, cmd: "systemctl list-units --all --no-legend --plain 2>/dev/null | awk '{print $1}' | head -3000" });
							return out.split("\n").filter((x) => /^[\w@.:-]+$/.test(x));
						}
					: undefined,
			containers:
				fs.side === "remote" && fs.conn != null
					? async () => {
							const out = await invoke<string>("ssh_exec", { conn: fs.conn, cmd: "docker ps -a --format '{{.Names}}' 2>/dev/null | head -500" });
							return out.split("\n").filter(Boolean);
						}
					: undefined,
			// 명령 입력 보조(D25)의 폼 후보·man — 읽기 전용 명령만 부른다(cmdAssist.ts)
			exec: fs.side === "remote" && fs.conn != null ? (cmd) => invoke<string>("ssh_exec", { conn: fs.conn, cmd }) : undefined,
		}),
		[fs, label],
	);
	const lastCwd = useRef<string | null>(null);
	const dock = useRef<DockviewApi | null>(null);
	// Ctrl+W: 보이는 이 작업대에서 문서 칸(편집기·실시간 보기·비교)에 초점이 있으면 그 칸만 닫는다(고친 게 있으면 묻는다)
	useEffect(() => {
		if (!active) return;
		const on = (ev: Event) => {
			const d = dock.current;
			const p = d?.activePanel;
			if (!d || !p || !isDoc(p.id)) return;
			const focus = document.activeElement;
			if (!focus || !p.view.content.element.contains(focus)) return;
			ev.preventDefault();
			if (isDirty(owner, p.id) && !confirmDiscard([p.title?.replace(/^● /, "") ?? p.id], "이 탭을 닫으면")) return;
			p.api.close();
		};
		window.addEventListener(CLOSE_DOC_EVENT, on);
		return () => window.removeEventListener(CLOSE_DOC_EVENT, on);
	}, [active, owner]);
	const [activeStore] = useState(makeActiveStore);
useEffect(() => activeStore.set(activeStore.panel, active), [active, activeStore]);
	const termSeq = useRef(1);
	/** 되살릴 때 작업대가 가려져 있어 크기 바로잡기를 미뤘다 */
	const repairPending = useRef(false);
	const activeRef = useRef(active);
	activeRef.current = active;
	const saveTimer = useRef<number | undefined>(undefined);

	// 최근 연 파일(작업대 종류·서버별로 앱 설정에) — 명령 팔레트의 "최근 파일"
	const recentKey = `recent.files.${fs.side === "remote" ? label : "local"}`;
	const recentFiles = useRef<{ which: Which; path: string; name: string }[]>([]);
	useEffect(() => {
		void api.settingGet(recentKey).then((v) => {
			try {
				const a = v ? (JSON.parse(v) as unknown) : [];
				recentFiles.current = Array.isArray(a) ? (a as { which: Which; path: string; name: string }[]).filter((x) => typeof x?.path === "string").slice(0, 15) : [];
			} catch {
				recentFiles.current = [];
			}
		});
	}, [recentKey]);
	const rememberFile = useCallback(
		(which: Which, e: FsEntry) => {
			recentFiles.current = [{ which, path: e.path, name: e.name }, ...recentFiles.current.filter((x) => !(x.which === which && x.path === e.path))].slice(0, 15);
			void api.settingSet(recentKey, JSON.stringify(recentFiles.current));
		},
		[recentKey],
	);
	const rememberRef = useRef(rememberFile);
	rememberRef.current = rememberFile;

	const openFile = useCallback((which: Which, e: FsEntry, lineNo?: number, peer?: Peer, ctr?: string) => {
		const d = dock.current;
		if (!d) return;
		if (!peer && !ctr) rememberRef.current(which, e);
		const id = peer ? `edit:peer${peer.conn}:${e.path}` : ctr ? `edit:ctr:${ctr}:${e.path}` : `edit:${which}:${e.path}`;
		const line = lineNo ? { n: lineNo, seq: Date.now() } : undefined;
		const existing = d.getPanel(id);
		if (existing) {
			if (line) existing.api.updateParameters({ line });
			existing.api.setActive();
			return;
		}
		addDoc(d, { id, component: "editor", title: peer ? `${e.name} · ${peer.label}` : ctr ? `${e.name} · ${ctr}` : e.name, params: { which, path: e.path, name: e.name, line, peer, ctr } });
	}, []);

	// 동시 입력: 받는 터미널 탭에 ⇉ 표시
	useEffect(() => {
		const d = dock.current;
		if (!d) return;
		for (const p of d.panels) {
			if (!p.id.startsWith("term-")) continue;
			const t = (p.title ?? "").replace(/^⇉ /, "");
			p.api.setTitle(broadcastOn ? `${BCAST}${t}` : t);
		}
	}, [broadcastOn]);

	const shells = useRef(new Map<string, ShellHandle>());
	const registerShell = useCallback((id: string, h: ShellHandle | null) => {
		if (h) shells.current.set(id, h);
		else shells.current.delete(id);
	}, []);
	const visibleShell = () => {
		const d = dock.current;
		const termId = d?.panels.find((p) => p.id.startsWith("term-") && p.api.isVisible)?.id ?? [...shells.current.keys()][0];
		return termId ? { id: termId, h: shells.current.get(termId) } : null;
	};

	const broadcast = useCallback((from: string, data: string) => {
		if (!broadcastRef.current) return;
		for (const [id, h] of shells.current) if (id !== from) h.send(data);
	}, []);

	const onCwd = useCallback(
		(path: string, c?: string, focus?: boolean, panelId?: string) => {
			if (panelId) {
				if (c !== undefined) termCtx.current.set(panelId, c);
				if (focus || !lastTerm.current || !dock.current?.getPanel(lastTerm.current)) lastTerm.current = panelId;
				// 뒤에 있는 다른 터미널의 프롬프트는 트리를 옮기지 않는다
				else if (lastTerm.current !== panelId) return;
			}
			// 터미널로 초점만 옮긴 것 — 이미 그 셸 쪽·그 폴더면 트리를 건드리지 않는다
			if (focus && path === lastCwd.current && ctxContainer(c) === ctrRef.current) return;
			lastCwd.current = path;
			if (!follow) return;
			// 그 프롬프트를 그린 셸 쪽으로 — docker exec 로 들어가면 컨테이너, exit 하면 서버(셸 훅이 없는 셸이면 그대로)
			if (c !== undefined) setCtr(fs.side === "remote" ? ctxContainer(c) : null);
			window.dispatchEvent(new CustomEvent(`rb-cwd-${instance.current}`, { detail: path }));
		},
		[follow, fs.side],
	);

	/** sudo 켜기: 되는지 보고(암호가 필요하면 묻고), 같이 모드면 보이는 터미널도 root 셸로 */
	const enableSudo = async (password: string | null, save: boolean) => {
		if (fs.conn == null) return;
		try {
			await sudoApi.check(fs.conn, password, save);
			setSudoAsk(null);
			setSudoOn(true);
			if (sudoPlace === "together") {
				const s = visibleShell();
				if (s?.h) {
					s.h.send(` sudo -s${sudoAs}\r`);
					// 암호는 화면을 거치지 않고 앱이 그 셸에 넣는다(이번에 넣었거나 저장한 sudo 암호)
					if (await s.h.expect(/assword[^\n]*:\s*$/, 2500)) await s.h.sudoPw?.();
				}
			}
		} catch (e) {
			const err = asSshError(e);
			if (err.code === "NEED_SECRET" || err.code === "AUTH_FAILED") setSudoAsk({ error: err.code === "AUTH_FAILED" ? err.message : undefined });
			else alert(err.message);
		}
	};
	const disableSudo = () => {
		setSudoOn(false);
		if (sudoPlace === "together") visibleShell()?.h?.send(" exit\r");
	};

	/** 터미널에서 그 폴더로 — 보이는(없으면 첫) 터미널에 */
	const cd = useCallback(
		(dir: string, quiet = false) => {
			const d = dock.current;
			const s = visibleShell();
			const termId = s?.id;
			const send = s?.h?.send;
			if (!send) return false;
			// 터미널이 트리와 다른 곳(서버·컨테이너)에 있으면 경로가 맞지 않는다
			if (termId && termCtx.current.has(termId) && ctxContainer(termCtx.current.get(termId)) !== ctrRef.current) return false;
			// 명령 실행 중·입력 중(vim 등)이면 보내지 않는다
			if (s?.h?.idle && !s.h.idle()) return false;
			// 원격은 POSIX 셸(작은따옴표), 내 PC 는 PowerShell/zsh 모두 받는 큰따옴표
			const q = local ? `'${dir.replaceAll("'", "'\\''")}'` : `"${dir}"`;
			send(` cd ${q}\r`);
			if (termId && !quiet) d?.getPanel(termId)?.api.setActive();
			return true;
		},
		[local],
	);

	/** 전송 칸 — 전송이 시작되면 조용히(포커스 없이) 붙고, 도구 막대에서 누르면 앞으로 */
	const showTransfersRef = useRef<(focus?: boolean) => void>(() => {});
	const showTransfers = (focus = false) => {
		const d = dock.current;
		if (!d) return;
		const ex = d.getPanel("transfers");
		if (ex) {
			if (focus) ex.api.setActive();
			return;
		}
		addBottom(d, { id: "transfers", component: "transfers", title: "전송" }, focus);
	};

	const peerFsMap = useRef(new Map<number, FsBackend>());
	const peerFs = useCallback((p: Peer) => {
		let f = peerFsMap.current.get(p.conn);
		if (!f) {
			f = sshFs(p.conn, p.label, p.home);
			peerFsMap.current.set(p.conn, f);
		}
		return f;
	}, []);
	const peersRef = useRef(peers);
	peersRef.current = peers;
	/** 연결 번호 → 그 쪽 파일 접근(이 작업대 서버·다른 서버) */
	const fsOfConn = useCallback(
		(conn: number | undefined) => {
			if (conn == null || conn === fs.conn) return fs;
			const p = peersRef.current.find((x) => x.conn === conn);
			return p ? peerFs(p) : fs;
		},
		[fs, peerFs],
	);
	const fsOf = useCallback((side: "remote" | "local", conn?: number) => (side === "local" && local ? local : fsOfConn(conn)), [fsOfConn, local]);

	const drop = useCallback(
		async (src: DragEntry, destSide: "remote" | "local", destDir: string, destConnArg?: number) => {
			try {
				const srcConn = src.side === "remote" ? (src.conn ?? fs.conn) : undefined;
				const destConn = destSide === "remote" ? (destConnArg ?? fs.conn) : undefined;
				const sameServer = src.side === "remote" && destSide === "remote" && srcConn === destConn;
				if ((src.side === "local" && destSide === "local") || sameServer) {
					// 같은 쪽 = 옮기기
					if (parentDir(src.path) === destDir || destDir === src.path || destDir.startsWith(`${src.path}/`)) return;
					if (!confirm(`${src.name} 을(를) ${destDir} 로 옮길까요?`)) return;
					await fsOf(destSide, destConn).rename(src.path, joinPath(destDir, src.name));
					notifyFsChanged(destSide, destDir, destConn);
					notifyFsChanged(src.side, parentDir(src.path), srcConn);
					return;
				}
				const destFs = fsOf(destSide, destConn);
				const existing = await destFs.list(destDir);
				let overwrite = false;
				let destName: string | undefined;
				if (existing.some((x) => x.name === src.name)) {
					// 덮어쓰기·건너뛰기(폴더면 안의 같은 이름만)·이름 바꿔 보내기(name (1).ext)
					const choice = await conflict.ask([src.name], destDir, destSide === "local");
					if (!choice) return;
					overwrite = choice === "overwrite";
					if (choice === "rename") destName = freeName(src.name, new Set(existing.map((x) => x.name)));
				}
				if (src.side === "remote" && destSide === "remote" && srcConn != null && destConn != null) {
					const peerOf = (c: number) => peersRef.current.find((p) => p.conn === c);
					const target = destConn === fs.conn ? syncInfoS : peerOf(destConn)?.target;
					const from = srcConn === fs.conn ? fs.label : (peerOf(srcConn)?.label ?? "보내는 서버");
					const to = destConn === fs.conn ? fs.label : (peerOf(destConn)?.label ?? "받는 서버");
					const how = target ? await askServerToServer(src.name, from, to, target) : "relay";
					if (!how) return;
					showTransfers();
					const args = { fromConn: srcConn, src: src.path, toConn: destConn, destDir, overwrite, destName };
					if (how === "direct" && target) {
						// 보내는 서버가 받는 서버에 직접 접속(rsync, 없으면 scp) — 안 되면 전송 칸에서 "내 PC 거쳐서" 로 다시
						const id = await invoke<number>("direct_start", { ...args, destName: destName ?? null, target });
						directArgs.set(id, args);
						return;
					}
					// 내 PC 를 거쳐 흘려 보냄(디스크에 남기지 않음)
					await invoke("relay_start", { ...args, destName: destName ?? null });
					return;
				}
				showTransfers();
				const conn = src.side === "remote" ? srcConn : destConn;
				if (conn == null) return;
				await transfers.start(conn, src.side === "local" ? "up" : "down", src.path, destDir, overwrite, destName);
			} catch (e) {
				alert(asSshError(e).message);
			}
		},
		[fs, fsOf, conflict.ask, syncInfoS],
	);

	/** 우클릭 › 올리기/받기 — 반대편 홈 폴더로 */
	const sendTo = useCallback(
		(from: Which, e: FsEntry) => {
			const destSide = from === "local" ? "remote" : "local";
			const dest = destSide === "remote" ? fs.home : (local?.home ?? "");
			void drop({ side: from === "local" ? "local" : "remote", conn: fs.conn, path: e.path, name: e.name, kind: e.kind }, destSide, dest);
		},
		[drop, fs, local],
	);

	/** 올리기 — 내 PC 에서 파일(여러 개)이나 폴더를 골라 이 서버 폴더로 */
	const uploadPick = useCallback(
		async (dir: string, folder: boolean) => {
			const picked = await openDialog({ multiple: !folder, directory: folder, title: folder ? "올릴 폴더 고르기" : "올릴 파일 고르기" });
			const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []) as string[];
			for (const p of paths) {
				const name = p.replace(/\\/g, "/").split("/").pop() ?? p;
				await drop({ side: "local", path: p.replace(/\\/g, "/"), name, kind: folder ? "dir" : "file" }, "remote", dir);
			}
		},
		[drop],
	);
	/** 받을 곳을 골라 받기 */
	const downloadTo = useCallback(
		async (e: FsEntry) => {
			const dest = await openDialog({ directory: true, multiple: false, title: `${e.name} 을(를) 받을 폴더` });
			if (typeof dest !== "string") return;
			await drop({ side: "remote", conn: fs.conn, path: e.path, name: e.name, kind: e.kind }, "local", dest.replace(/\\/g, "/"));
		},
		[drop, fs],
	);

	showTransfersRef.current = showTransfers;
	/** 편집기들이 있는 칸 옆에(없으면 트리 오른쪽) */
	const addBeside = (opts: { id: string; component: string; title: string; params: object }) => {
		const d = dock.current;
		if (!d) return;
		const ex = d.getPanel(opts.id);
		if (ex) return void ex.api.setActive();
		addDoc(d, opts);
	};

	const openTail = useCallback((which: Which, e: FsEntry) => {
		addBeside({ id: `tail:${which}:${e.path}`, component: "tail", title: `⟳ ${e.name}`, params: { which, path: e.path } });
	}, []);

	const compareFirst = useRef<{ which: Which; path: string; name: string } | null>(null);
	const compareLabel = useCallback((which: Which, e: FsEntry) => {
		const f = compareFirst.current;
		if (!f) return "비교 대상으로 고르기";
		if (f.which === which && f.path === e.path) return "비교 대상 고르기 취소";
		return `${f.name} 와(과) 비교`;
	}, []);
	const compare = useCallback((which: Which, e: FsEntry) => {
		const f = compareFirst.current;
		if (!f) {
			compareFirst.current = { which, path: e.path, name: e.name };
			return;
		}
		compareFirst.current = null;
		if (f.which === which && f.path === e.path) return;
		addBeside({ id: `diff:${f.which}:${f.path}|${which}:${e.path}`, component: "diff", title: `⇄ ${f.name} · ${e.name}`, params: { a: { which: f.which, path: f.path }, b: { which, path: e.path } } });
	}, []);

	const archive = useCallback(
		async (e: FsEntry) => {
			if (fs.conn == null) return;
			const dest = await saveDialog({ defaultPath: `${e.name}.tar.gz`, filters: [{ name: "tar.gz", extensions: ["gz", "tgz"] }] });
			if (!dest) return;
			showTransfers();
			try {
				await invoke("ssh_download_targz", { conn: fs.conn, path: e.path, dest });
			} catch (x) {
				alert(asSshError(x).message);
			}
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: fs 는 연결 번호만 쓴다
		[fs.conn],
	);

	const relay = useCallback(
		async (e: FsEntry, fromConn?: number) => {
			const from = fromConn ?? fs.conn;
			if (from == null) return;
			const targets: Peer[] = [...(fs.conn != null ? [{ conn: fs.conn, label: fs.label, home: fs.home }] : []), ...peersRef.current].filter((p) => p.conn !== from);
			if (!targets.length) return;
			const pick =
				targets.length === 1
					? targets[0]
					: targets[Number((await askText({ title: "어느 서버로 보낼까요?", choiceOnly: true, choices: targets.map((p, i) => ({ value: String(i), label: p.label })) })) ?? -1)];
			if (!pick) return;
			const dest = await askText({ title: `${pick.label} 로 보내기`, message: "받을 폴더 — 다른 서버 칸을 열고 끌어 놓아도 됩니다", value: pick.home, okLabel: "보내기" });
			if (!dest) return;
			// 같은 이름 처리는 끌어 놓기와 같은 시트로
			void drop({ side: "remote", conn: from, path: e.path, name: e.name, kind: e.kind }, "remote", dest, pick.conn);
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: fs 는 연결·이름·홈만 쓴다
		[fs.conn, fs.label, fs.home, drop],
	);

	const openSync = () => {
		const d = dock.current;
		if (!d) return;
		if (d.getPanel("sync")) return void d.getPanel("sync")?.api.setActive();
		addBottom(d, { id: "sync", component: "sync", title: "동기화" }, true);
	};

	const openMonitorRef = useRef<() => void>(() => {});
	const openMonitor = () => {
		const d = dock.current;
		if (!d) return;
		if (d.getPanel("monitor")) return void d.getPanel("monitor")?.api.setActive();
		addDoc(d, { id: "monitor", component: "monitor", title: "자원" });
	};
	openMonitorRef.current = openMonitor;
	/** 문서 칸에 도구 칸 하나(있으면 앞으로) */
	const openTool = (id: "services" | "docker" | "webports" | "search", title: string) => {
		const d = dock.current;
		if (!d) return;
		if (d.getPanel(id)) return void d.getPanel(id)?.api.setActive();
		addDoc(d, { id, component: id, title });
	};
	/** 새 터미널을 열고, 셸이 준비되면 명령을 보낸다 */
	const openTerminalCmdRef = useRef<(cmd: string, title: string, ctr?: string) => void>(() => {});
	openTerminalCmdRef.current = (cmd: string, title: string, ctr?: string) => {
		const d = dock.current;
		if (!d) return;
		termSeq.current += 1;
		const n = termSeq.current;
		const id = `term-${n}`;
		const ref = d.panels.find((p) => p.id.startsWith("term-"));
		unhide(ref);
		d.addPanel({ id, component: "terminal", title, params: { n }, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
		let tries = 0;
		const send = () => {
			const h = shells.current.get(id);
			if (h && (!h.idle || h.idle())) {
				h.send(`${cmd}\r`);
				if (ctr) h.armCtr?.(ctr);
				return;
			}
			if (++tries < 60) window.setTimeout(send, 150);
		};
		window.setTimeout(send, 300);
	};

	// 앱 탭이 보이게 되면(크기가 생기면) 찌그러진 칸을 편다 — 처음 열 때 가려져 있었던 작업대
	useEffect(() => {
		if (!active) return;
		const id = requestAnimationFrame(() => {
			const d = dock.current;
			if (!d || d.width === 0) return;
			if (repairPending.current) {
				repairPending.current = false;
				repairLayout(d, false, () => ++termSeq.current, true);
			}
			// 가려진 동안 칸이 열리고 닫히면 칸 내용이 0 크기로 잡힌 채 남는다 — 한 번 다시 그린다
			d.layout(d.width, d.height, true);
		});
		return () => cancelAnimationFrame(id);
	}, [active]);
	/** 터미널 단추 — 있으면 그 터미널로, 없으면(닫았으면) 트리 오른쪽에 새로 */
	const showTerminal = () => {
		const d = dock.current;
		if (!d) return;
		const t = d.panels.find((p) => p.id.startsWith("term-") && p.api.isVisible) ?? d.panels.find((p) => p.id.startsWith("term-"));
		if (t) {
			unhide(t);
			t.api.setActive();
			if (t.group.width <= 104 || t.group.height <= 104) repairLayout(d, false, () => ++termSeq.current, true);
			return;
		}
		if (blockedByLock()) return;
		repairLayout(d, true, () => ++termSeq.current, true);
	};
	const addTerminalRef = useRef<(cwd?: string, shell?: string, near?: string) => void>(() => {});
	const addTerminal = (cwd?: string, shell?: string, near?: string) => {
		const d = dock.current;
		if (!d) return;
		termSeq.current += 1;
		const n = termSeq.current;
		const ref = (near ? d.getPanel(near) : undefined) ?? d.panels.find((p) => p.id.startsWith("term-"));
		unhide(ref);
		d.addPanel({
			id: `term-${n}`,
			component: "terminal",
			title: `${broadcastRef.current ? BCAST : ""}${cwd ? `터미널 ${n} · ${cwd.split("/").filter(Boolean).pop() ?? "/"}` : `터미널 ${n}`}`,
			params: { n, cwd, shell },
			renderer: "always",
			position: ref ? { referencePanel: ref.id, direction: "within" } : undefined,
		});
	};
	addTerminalRef.current = addTerminal;

	/** 터미널 나누기 — 그 터미널 오른쪽·아래에 새 칸(지금 폴더에서) */
	const splitTerminal = useCallback((panelId: string, dir: "right" | "below") => {
		const d = dock.current;
		if (!d || blockedByLock()) return;
		termSeq.current += 1;
		const n = termSeq.current;
		const cwd = lastCwd.current ?? undefined;
		const ref = d.getPanel(panelId);
		unhide(ref);
		d.addPanel({
			id: `term-${n}`,
			component: "terminal",
			title: `${broadcastRef.current ? BCAST : ""}터미널 ${n}`,
			params: { n, cwd },
			renderer: "always",
			position: ref ? { referencePanel: ref.id, direction: dir } : undefined,
		});
	}, []);

	/** 이 터미널을 root 셸로(sudo -i) — 저장해 둔(이번에 넣은) sudo 암호가 있으면 프롬프트에 넣는다 */
	const rootShell = useCallback(async (panelId: string, on: boolean) => {
		const h = shells.current.get(panelId);
		if (!h) return;
		if (h.idle && !h.idle()) {
			alert("터미널이 명령을 실행 중입니다. 끝난 뒤 다시 하세요.");
			return;
		}
		if (!on) {
			h.send(" exit\r");
			return;
		}
		h.send(` sudo -i${sudoAs}\r`);
		if (await h.expect(/assword[^\n]*:\s*$/, 2500)) await h.sudoPw?.();
	}, [sudoAs]);

	/** 다른 서버 칸 — 열려 있는 다른 SSH 연결을 골라 오른쪽에(이미 있으면 닫기) */
	const togglePeer = async (conn?: number) => {
		const d = dock.current;
		if (!d || blockedByLock()) return;
		let p = conn != null ? peers.find((x) => x.conn === conn) : undefined;
		if (!p) {
			if (!peers.length) {
				onConnectOtherRef.current?.();
				return;
			}
			p =
				peers.length === 1
					? peers[0]
					: peers[Number((await askText({ title: "어느 서버를 옆에 열까요?", choiceOnly: true, choices: peers.map((x, i) => ({ value: String(i), label: `${d.getPanel(`peer:${x.conn}`) ? "닫기 — " : ""}${x.label}` })) })) ?? -1)];
			if (!p) return;
		}
		const id = `peer:${p.conn}`;
		const ex = d.getPanel(id);
		if (ex) {
			d.removePanel(ex);
			return;
		}
		const beside = d.getPanel("localtree") ?? d.panels.find((x) => x.id.startsWith("peer:"));
		d.addPanel({
			id,
			component: "peertree",
			title: p.label,
			params: { peer: p },
			renderer: "always",
			position: beside ? { referencePanel: beside.id, direction: "below" } : { direction: "right" },
		});
		if (!beside) d.getPanel(id)?.api.setSize({ width: 300 });
	};
	const togglePeerRef = useRef(togglePeer);
	togglePeerRef.current = togglePeer;
	// 여기서 골라 연결한 서버 — 연결이 peers 에 들어오면 옆 칸에 연다
	const pendingPeer = useRef<number | null>(null);
	useEffect(() => {
		const h = (e: Event) => {
			const d = (e as CustomEvent<{ owner: string; conn: number }>).detail;
			if (d.owner !== owner) return;
			if (peersRef.current.some((x) => x.conn === d.conn)) void togglePeerRef.current(d.conn);
			else pendingPeer.current = d.conn;
		};
		window.addEventListener("rb-open-peer", h);
		return () => window.removeEventListener("rb-open-peer", h);
	}, [owner]);
	useEffect(() => {
		const c = pendingPeer.current;
		if (c != null && peers.some((x) => x.conn === c)) {
			pendingPeer.current = null;
			void togglePeerRef.current(c);
		}
	}, [peers]);
	// 다른 연결이 닫히면 그 칸도 닫는다
	useEffect(() => {
		const d = dock.current;
		if (!d) return;
		const alive = new Set(peers.map((x) => `peer:${x.conn}`));
		for (const p of [...d.panels]) if (p.id.startsWith("peer:") && !alive.has(p.id)) d.removePanel(p);
		for (const [c] of peerFsMap.current) if (!peers.some((x) => x.conn === c)) peerFsMap.current.delete(c);
	}, [peers]);
	// 전송 칸이 다른 서버 칸(peer) ↔ 내 PC 전송도 이 작업대 것으로 보게 — ctx 에 넣지 않아 다시 그리기 없음
	useEffect(() => {
		peerConnsOf.set(owner, new Set(peers.map((x) => x.conn)));
		return () => void peerConnsOf.delete(owner);
	}, [peers, owner]);

	const toggle = (id: "tree" | "localtree") => {
		const d = dock.current;
		if (!d || blockedByLock()) return;
		const p = d.getPanel(id);
		if (p) {
			d.removePanel(p);
			return;
		}
		d.addPanel({
			id,
			component: "tree",
			title: id === "tree" ? "파일" : "내 PC",
			params: { which: id === "tree" ? "remote" : "local" },
			renderer: "always",
			// 원격 트리는 왼쪽 끝, 내 PC 트리는 오른쪽 끝(주고받을 때만 여는 칸)
			position: { direction: id === "tree" ? "left" : "right" },
		});
		d.getPanel(id)?.api.setSize({ width: id === "localtree" ? 300 : 250 });
	};

	// 기본 배치가 바뀌면 옛 저장 배치는 쓰지 않는다(v3: 터미널 우선 — 빈 문서 자리 없음, 내 PC 셸은 터미널만)
	const savedKey = `${layoutKey}.v3`;
	const terminalOnly = fs.side === "local";
	// 다시 열 편집기 목록은 서버(프로필·계정)마다 — 하나로 두면 다른 서버에서 연 경로가 이 서버에서 열린다
	const editorsKey = `${savedKey}.editors.${server ? `p${server.profileId}:${label}` : "local"}`;
	const gone = useRef(false);
	const onReady = (e: DockviewReadyEvent) => {
		dock.current = e.api;
		gone.current = false;
		void api.settingGet(savedKey).then((saved) => {
			let ok = false;
			if (saved) {
				try {
					e.api.fromJSON(JSON.parse(saved));
					ok = e.api.panels.some((p) => p.id.startsWith("term-")) || e.api.panels.some((p) => p.id === "tree");
					for (const p of e.api.panels) {
						const m = /^term-(\d+)$/.exec(p.id);
						if (m) termSeq.current = Math.max(termSeq.current, Number(m[1]));
						// 동시 입력 표시는 저장본에 남기지 않는다(다시 열면 꺼진 상태)
						if (m && p.title?.startsWith(BCAST)) p.api.setTitle(p.title.slice(BCAST.length));
					}
				} catch {
					ok = false;
				}
			}
			if (!ok) defaultLayout(e.api, terminalOnly);
			else {
				const sized = e.api.width >= 480;
				repairLayout(e.api, true, () => ++termSeq.current, sized);
				repairPending.current = !sized;
			}
			// 다시 연결한 뒤·앱을 다시 연 뒤: 열려 있던 편집기 탭을 다시 연다(초안은 편집기가 되살리기를 묻는다).
			// 이 창에서 연 적이 없으면(앱 재시작) 저장해 둔 목록에서 — 많으면 앞 12개만
			const reopen = (list: { which: Which; path: string; name: string }[]) => {
				if (gone.current) return;
				for (const x of list.slice(0, 12)) {
					// 다른 서버 칸에서 연 파일은 그 칸(연결)이 다시 있어야 하니 되살리지 않는다(같은 경로가 이 서버 탭으로 열리지 않게)
					if ((x as { peer?: unknown }).peer || (x as { ctr?: unknown }).ctr) continue;
					if (!e.api.getPanel(`edit:${x.which}:${x.path}`)) addDoc(e.api, { id: `edit:${x.which}:${x.path}`, component: "editor", title: x.name, params: x });
				}
			};
			const mem = openEditors.get(owner);
			if (mem) reopen(mem);
			else
				void api.settingGet(editorsKey).then((v) => {
					try {
						const list = v ? (JSON.parse(v) as { which: Which; path: string; name: string }[]) : [];
						if (Array.isArray(list)) reopen(list.filter((x) => x && typeof x.path === "string" && (x.which === "remote" || x.which === "local")));
					} catch {
						/* 깨진 저장본은 무시 */
					}
				});
		});
		e.api.onDidActivePanelChange((ev) => {
			activeStore.set(ev.panel?.id ?? null);
			if (ev.panel?.id.startsWith("term-")) lastTerm.current = ev.panel.id;
		});
		e.api.onDidLayoutChange(() => {
			if (gone.current) return;
			setShownIds(e.api.panels.map((p) => p.id).join("|"));
			window.clearTimeout(saveTimer.current);
			saveTimer.current = window.setTimeout(() => {
				const d = dock.current;
				if (!d || gone.current) return;
				// 가려진 앱 탭에서는 작업대 크기가 0 으로 다시 그려진다 — 그 배치를 저장하면 다음에 칸이 찌그러져 열린다
				if (!activeRef.current || d.width < 240 || d.height < 160) return;
				// 최대화 중에는 배치(숨은 칸이 있는 상태)를 저장하지 않는다 — 열린 편집기 목록은 그래도 저장
				if (!d.hasMaximizedGroup()) void api.settingSet(savedKey, JSON.stringify(stripEditors(d.toJSON())));
				const eds = d.panels.filter((p) => p.id.startsWith("edit:")).map((p) => p.params as { which: Which; path: string; name: string; peer?: unknown; ctr?: unknown });
				openEditors.set(owner, eds);
				// 다른 서버 칸에서 연 파일은 그 연결이 있어야 하니 앱을 다시 열 때는 빼고 남긴다
				void api.settingSet(editorsKey, JSON.stringify(eds.filter((x) => !x.peer && !x.ctr).map(({ which, path, name }) => ({ which, path, name }))));
			}, 600);
		});
	};

	// ctx 에 싣는 함수는 참조를 안정시킨다 — 칸(트리 등)의 memo 가 효과를 내도록
	const dropV = useCallback((src: DragEntry, side: "remote" | "local", dir: string, destConn?: number) => void drop(src, side, dir, destConn), [drop]);
	const newTerminalCb = useCallback((dir: string) => addTerminalRef.current(dir), []);
	const archiveV = useCallback((e: FsEntry) => void archive(e), [archive]);
	const relayV = useCallback((e: FsEntry, fromConn?: number) => void relay(e, fromConn), [relay]);
	const leaveCtr = useCallback(() => setCtr(null), []);
	const termOtherSide = useCallback(() => {
		const id = visibleShell()?.id;
		return !!id && termCtx.current.has(id) && ctxContainer(termCtx.current.get(id)) !== ctrRef.current;
		// biome-ignore lint/correctness/useExhaustiveDependencies: visibleShell 은 ref 만 읽는다
	}, []);
	const openCtrTree = useCallback(
		(name: string, panelId: string) => {
			termCtx.current.set(panelId, `docker:${name}`);
			lastTerm.current = panelId;
			if (fs.conn == null) return;
			setCtr(name);
			void invoke<[string, string]>("ctr_where", { conn: fs.conn, ctr: name })
				.then(([cwd]) => {
					lastCwd.current = cwd;
					window.dispatchEvent(new CustomEvent(`rb-cwd-${instance.current}`, { detail: cwd }));
				})
				.catch((e) => alert(asSshError(e).message));
		},
		[fs.conn],
	);
	const addTerminalNear = useCallback((id?: string) => addTerminalRef.current(undefined, undefined, id), []);
	const openMonitorCb = useCallback(() => openMonitorRef.current(), []);
	const openTerminalCmdCb = useCallback((cmd: string, title: string, ctr?: string) => openTerminalCmdRef.current(cmd, title, ctr), []);
	const cwdNow = useCallback(() => lastCwd.current, []);
	const showTransfersFocus = useCallback(() => showTransfersRef.current(true), []);
	const openForwards = useCallback(() => setFwdOpen(true), []);
	const rootShellV = useCallback((id: string, on: boolean) => void rootShell(id, on), [rootShell]);
	const toggleMaximize = useCallback(() => toggleMaxRef.current(), []);
	const ctx = useMemo<Ctx>(
		() => ({
			fs: fsNow,
			local,
			term,
			label,
			startPath,
			openFile,
			drop: dropV,
			peerFs,
			sendTo,
			cd,
			follow,
			setFollow,
			uploadPick: local && fs.side === "remote" ? uploadPick : undefined,
			downloadTo: local && fs.side === "remote" ? downloadTo : undefined,
			newTerminal: newTerminalCb,
			termEncoding,
			localShells: fs.side === "local" ? shellList : undefined,
			defaultShell,
			registerShell,
			onCwd,
			ctrFs,
			openCtrTree,
			termOtherSide,
			leaveCtr,
			broadcast,
			completion,
			openTail,
			compare,
			compareLabel,
			archive: archiveV,
			relay: relayV,
			hasPeers: peers.length > 0,
			showTransfers: showTransfersFocus,
			syncInfo: syncInfoS,
			treeKey: instance.current,
			owner,
			sudoOn: sudoOn && !!sudoFs,
			splitTerminal,
			locked,
			broadcastOn,
			setBroadcast: setBroadcastOn,
			addTerminalNear,
			openMonitor: openMonitorCb,
			sudo: sudoS,
			openTerminalCmd: openTerminalCmdCb,
			cwdNow,
			openForwards: hasServer ? openForwards : undefined,
			profileId: serverProfileId,
			rootShell: fs.side === "remote" && sudoMode !== "off" ? rootShellV : undefined,
			toggleMaximize,
			activeStore,
		}),
		[fsNow, local, term, label, startPath, openFile, dropV, sendTo, cd, registerShell, onCwd, ctrFs, broadcast, completion, openTail, compare, compareLabel, archiveV, relayV, peers.length, peerFs, syncInfoS, sudoOn, sudoFs, sudoMode, owner, follow, uploadPick, downloadTo, termEncoding, shellList, defaultShell, splitTerminal, rootShellV, fs.side, locked, broadcastOn, hasServer, serverProfileId, sudoS, newTerminalCb, openCtrTree, termOtherSide, leaveCtr, addTerminalNear, openMonitorCb, openTerminalCmdCb, cwdNow, showTransfersFocus, openForwards, toggleMaximize, activeStore, fs.conn],
	);

	useEffect(() => {
		gone.current = false;
		return () => {
			gone.current = true;
			window.clearTimeout(saveTimer.current);
		};
	}, []);

	/** 그 종류 칸으로 옮기고 안에 포커스(Alt+1·2·3, 명령 팔레트) */
	const focusPanel = (pred: (id: string) => boolean) => {
		const d = dock.current;
		if (!d) return;
		const p = d.panels.find((x) => pred(x.id) && x.api.isVisible) ?? d.panels.find((x) => pred(x.id));
		if (p) {
			p.api.setActive();
			requestAnimationFrame(() => (p.view.content.element.querySelector("textarea, .tree-body, .cm-content, [tabindex]") as HTMLElement | null)?.focus());
		}
	};
	const toggleTermPane = () => {
		const t = dock.current?.panels.find((x) => x.id.startsWith("term-"));
		if (t) t.group.api.setVisible(!t.group.api.isVisible);
	};
	const resetLayout = () => {
		if (dock.current && !blockedByLock()) {
			termSeq.current = 1;
			defaultLayout(dock.current, terminalOnly);
		}
	};
	/** 이 칸 최대화·되돌리기(Alt+M) — DB 작업대와 같은 규칙: 최대화 중이면 되돌리고, 아니면 초점이 있는 칸을 최대화 */
	const toggleMaxRef = useRef<() => void>(() => {});
	toggleMaxRef.current = () => {
		const d = dock.current;
		if (!d) return;
		if (d.hasMaximizedGroup()) return d.exitMaximizedGroup();
		const p = d.activePanel ?? d.panels.find((x) => x.api.isVisible);
		if (p) d.maximizeGroup(p);
	};
	/** 칸 안으로 초점 */
	const focusIn = (p: { view: { content: { element: HTMLElement } } }) =>
		requestAnimationFrame(() => (p.view.content.element.querySelector("textarea, .tree-body, .cm-content, [tabindex]") as HTMLElement | null)?.focus());
	/** 칸 사이 이동(Alt+Shift+방향키) — 지금 칸 가장자리에서 그 방향으로 맞닿은(가장 가까운) 칸 */
	const movePane = (dir: "left" | "right" | "up" | "down") => {
		const d = dock.current;
		const cur = d?.activeGroup ?? d?.activePanel?.group;
		if (!d || !cur) return;
		const c = cur.element.getBoundingClientRect();
		let best: { g: (typeof d.groups)[number]; gap: number; overlap: number } | null = null;
		for (const g of d.groups) {
			if (g === cur || !g.api.isVisible || !g.activePanel) continue;
			const r = g.element.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) continue;
			const horiz = dir === "left" || dir === "right";
			const gap = dir === "right" ? r.left - c.right : dir === "left" ? c.left - r.right : dir === "down" ? r.top - c.bottom : c.top - r.bottom;
			const overlap = horiz ? Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) : Math.min(r.right, c.right) - Math.max(r.left, c.left);
			if (gap < -4 || overlap <= 0) continue;
			if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && overlap > best.overlap)) best = { g, gap, overlap };
		}
		const p = best?.g.activePanel;
		if (p) {
			p.api.setActive();
			focusIn(p);
		}
	};
	/** 초점이 있는(없으면 보이는) 터미널 */
	const focusedTerm = () => {
		const a = dock.current?.activePanel;
		return a?.id.startsWith("term-") ? a.id : targetTerm();
	};
	/** 명령 대상 터미널 — 보이는(없으면 첫) 터미널 칸 */
	const targetTerm = () => visibleShell()?.id ?? dock.current?.panels.find((p) => p.id.startsWith("term-"))?.id;

	// 명령 팔레트 — 이 작업대가 앞에 보일 때만 자기 명령을 등록한다
	useCommands(`workbench:${instance.current}`, active, () => {
		const w = (id: string, title: string, run: () => void, extra?: Partial<Command>): Command => ({ id: `wb.${id}`, title, group: "work", run, ...extra });
		const lockHint = locked ? "배치가 잠겨 있음(Ctrl+Alt+L 로 풀기)" : undefined;
		const split = (dir: "right" | "below") => () => {
			const t = targetTerm();
			if (t) splitTerminal(t, dir);
		};
		const list: Command[] = [
			w("quickOpen", "파일 빠른 열기", () => setQuickOpen(true), { keys: "Alt+O", keywords: "찾기 열기 이름 경로 file open" }),
			w("newTerminal", "새 터미널", () => addTerminalRef.current(lastCwd.current ?? undefined, undefined, targetTerm()), { hint: "지금 폴더에서, 같은 칸의 탭으로", keywords: "terminal shell 셸" }),
			w("splitRight", "터미널 오른쪽으로 나누기", split("right"), { keys: "Alt+Shift+=", disabled: locked, hint: lockHint, keywords: "split 분할" }),
							w("splitBelow", "터미널 아래로 나누기", split("below"), { keys: "Alt+Shift+-", disabled: locked, hint: lockHint, keywords: "split 분할" }),
							w("maximize", "칸 최대화·되돌리기", () => toggleMaxRef.current(), { keys: "Alt+M", hint: "초점이 있는 칸을 작업대 가득(다시 누르면 되돌림)", keywords: "maximize 최대화 확대 zoom 전체화면" }),
							w("paneLeft", "왼쪽 칸으로 이동", () => movePane("left"), { keys: "Alt+Shift+←", keywords: "pane focus 칸 이동 포커스" }),
							w("paneRight", "오른쪽 칸으로 이동", () => movePane("right"), { keys: "Alt+Shift+→", keywords: "pane focus 칸 이동 포커스" }),
							w("paneUp", "위쪽 칸으로 이동", () => movePane("up"), { keys: "Alt+Shift+↑", keywords: "pane focus 칸 이동 포커스" }),
							w("paneDown", "아래쪽 칸으로 이동", () => movePane("down"), { keys: "Alt+Shift+↓", keywords: "pane focus 칸 이동 포커스" }),
			w("broadcast", broadcastOn ? "동시 입력 끄기" : "동시 입력 켜기", () => setBroadcastOn(!broadcastRef.current), { hint: "한 터미널에 친 것을 이 작업대의 모든 터미널에", keywords: "broadcast 브로드캐스트" }),
			w("termPane", "터미널 칸 숨기기·보이기", toggleTermPane, { keys: "Ctrl+`" }),
			w("focusTree", "트리로 옮기기", () => focusPanel((id) => id === "tree" || id === "localtree"), { keys: "Alt+1" }),
			w("focusDoc", "문서(편집기)로 옮기기", () => focusPanel((id) => /^(edit|tail|diff):/.test(id) || id === "monitor"), { keys: "Alt+2" }),
			w("focusTerm", "터미널로 옮기기", () => focusPanel((id) => id.startsWith("term-")), { keys: "Alt+3" }),
			w("lock", locked ? "배치 잠금 풀기" : "배치 잠그기", () => setLocked(!lockedRef.current), { keys: "Ctrl+Alt+L", keywords: "lock 고정" }),
			w("defaultLayout", "기본 배치로 되돌리기", resetLayout, { disabled: locked, hint: lockHint ?? (terminalOnly ? "터미널만" : "왼쪽 트리 · 오른쪽 터미널(파일을 열면 터미널 위에)"), keywords: "layout reset 초기화" }),
			w("tree", has("tree") ? "파일 칸 닫기" : "파일 칸 열기", () => toggle("tree"), { disabled: locked, hint: lockHint, keywords: "트리 tree" }),
			w("help", "단축키 도움말", () => setHelp(true), { keys: "F1", keywords: "도움말 help shortcut" }),
		];
		// 명령 입력 보조(D25) — 보이는 터미널이 리눅스 셸일 때만
		{
			const ax = visibleShell()?.h?.assist;
			const off = ax ? {} : { disabled: true, hint: "리눅스 셸 터미널(SSH·bash·zsh·Git Bash·WSL)에서만" };
			list.push(
				w("assist.explain", "명령 풀이", () => ax?.({ kind: "explain" }), { keys: "Ctrl+Shift+E", hint: "고른 글자나 지금 입력 줄을 조각마다 풀이", keywords: "explain 설명 풀이 옵션", ...off }),
				w("assist.form", "명령 만들기…", () => ax?.({ kind: "form" }), { hint: "칸을 채워 명령을 만들고 입력 줄에 넣기", keywords: "form 폼 빈칸 템플릿", ...off }),
				...FORMS.map(({ cmd, form }) =>
					w(`assist.form.${form.id}`, `명령 만들기: ${form.label}`, () => ax?.({ kind: "form", id: form.id }), { hint: form.d, keywords: `${cmd} form 폼 만들기`, ...off }),
				),
			);
		}
		if (local) {
			list.push(
				w("localtree", has("localtree") ? "내 PC 칸 닫기" : "내 PC 칸 열기", () => toggle("localtree"), { disabled: locked, hint: lockHint ?? "서버 트리와 끌어 놓아 주고받기" }),
				w("transfers", "전송 칸 보기", () => showTransfers(true), { keywords: "올리기 받기 upload download" }),
			);
		}
		if (fs.side === "remote" && fs.conn != null) {
			for (const p of peers)
				list.push(
					w(`peer.${p.conn}`, `다른 서버 칸: ${p.label}`, () => void togglePeerRef.current(p.conn), {
						disabled: locked,
						hint: "트리끼리 끌어 놓으면 서버 ↔ 서버로 보냄",
						keywords: "server relay 중계 서버 전송 scp",
					}),
				);
			list.push(w("monitor", "자원 칸 보기", openMonitor, { hint: "CPU·메모리·디스크·네트워크·프로세스", keywords: "monitor 모니터 top" }));
			list.push(w("services", "서비스 칸 보기", () => openTool("services", "서비스"), { hint: "systemd 서비스·journal", keywords: "systemctl systemd journal 서비스" }));
			list.push(w("docker", "Docker 칸 보기", () => openTool("docker", "Docker"), { hint: "컨테이너·로그·셸", keywords: "docker container 컨테이너 podman" }));
			list.push(w("webports", "서버 웹 화면 열기", () => openTool("webports", "웹 화면"), { hint: "듣고 있는 포트 → 포워딩 → 브라우저", keywords: "port 포트 web 웹 브라우저" }));
		}
		list.push(w("search", "파일 내용 찾기", () => openTool("search", "내용 찾기"), { hint: "grep — Ctrl+Shift+F", keywords: "grep 검색 찾기 search" }));
		if (local && syncInfo) list.push(w("sync", "동기화 칸 보기", openSync, { hint: "내 PC 폴더 ↔ 이 서버 폴더", keywords: "rsync sync" }));
		if (server) {
			list.push(
				w("forwards", "포트 포워딩", () => setFwdOpen(true), { hint: "로컬·원격·SOCKS 규칙", keywords: "port forward tunnel 터널" }),
				w("tmux", "tmux 세션", () => setTmuxOpen(true), { hint: "세션 보기·끝내기", keywords: "tmux session" }),
			);
		}
		if (sudoFs) {
			list.push(
				w("sudo", sudoOn ? "sudo 끄기" : "sudo 켜기", () => (sudoOn ? disableSudo() : void enableSudo(null, false)), {
					hint: `${sudoUser || "root"} 권한으로 파일 작업${sudoPlace === "together" ? " + 보이는 터미널" : ""}`,
					keywords: "root 권한 관리자",
				}),
			);
			const t = targetTerm();
			if (t) list.push(w("rootShell", "보이는 터미널을 root 셸로(sudo -i)", () => void rootShell(t, true), { keywords: "sudo root" }));
		}
		if (fs.side === "local") {
			list.push(
				w("adminWindow", "관리자 권한 새 창 — 지금 셸", () => void invoke("pty_admin_window", { shell: defaultShell, cwd: lastCwd.current }).catch((e) => alert(String(e))), { keywords: "admin 관리자 elevated" }),
				...(shellList ?? []).filter((x) => x.admin).map((x) => w(`admin.${x.id}`, `관리자 셸 열기 — ${x.label}`, () => addTerminalRef.current(undefined, x.id), { keywords: "admin 관리자" })),
			);
		}
		for (const f of recentFiles.current) {
			const dir = f.path.slice(0, Math.max(0, f.path.lastIndexOf("/"))) || "/";
			list.push({
				id: `file.${recentKey}.${f.which}:${f.path}`,
				title: f.name,
				hint: `${f.which === "local" && local ? "내 PC · " : ""}${dir}`,
				group: "files",
				keywords: f.path,
				run: () => openFile(f.which, { name: f.name, path: f.path, kind: "file", size: 0 }),
			});
		}
		return list;
	});

	return (
		<WbCtx.Provider value={ctx}>
			<div
				className="wb-dock-shell"
				onKeyDownCapture={(e) => {
					const d = dock.current;
					if (!d) return;
					if (e.ctrlKey && e.key === "`") {
						// 터미널 칸 숨기기·보이기
						e.preventDefault();
						toggleTermPane();
					} else if (e.altKey && !e.ctrlKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
						e.preventDefault();
						if (e.key === "1") focusPanel((id) => id === "tree" || id === "localtree");
						if (e.key === "2") focusPanel((id) => /^(edit|tail|diff):/.test(id) || id === "monitor");
						if (e.key === "3") focusPanel((id) => id.startsWith("term-"));
					} else if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyL") {
						// 배치 잠그기·풀기
						e.preventDefault();
						e.stopPropagation();
						setLocked(!lockedRef.current);
					} else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyO") {
						// 파일 빠른 열기 — 터미널에 Alt+O 가 가지 않게
						e.preventDefault();
						e.stopPropagation();
						setQuickOpen(true);
					} else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF") {
						// 터미널 안이면 터미널 찾기(터미널이 처리), 밖이면 파일 내용 찾기 칸
						if (inTerminal(e.target)) return;
						e.preventDefault();
						e.stopPropagation();
						openTool("search", "내용 찾기");
					} else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyM") {
						// 이 칸 최대화·되돌리기(DB 작업대 Alt+M 과 같은 규칙)
						e.preventDefault();
						e.stopPropagation();
						toggleMaxRef.current();
					} else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === "Equal" || e.code === "Minus")) {
						// 터미널 나누기 — Alt+Shift+= 오른쪽, Alt+Shift+- 아래(Windows Terminal 과 같음). 터미널에 초점이 없으면 보이는 터미널을
						e.preventDefault();
						e.stopPropagation();
						const t = focusedTerm();
						if (t) splitTerminal(t, e.code === "Equal" ? "right" : "below");
					} else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.startsWith("Arrow") && !(e.target as HTMLElement | null)?.closest?.(".cm-editor")) {
						// 칸 사이 이동 — 편집기 안의 Alt+Shift+방향키는 편집기 몫(줄 복사·구문 선택), 거기서는 Alt+1·2·3
						e.preventDefault();
						e.stopPropagation();
						movePane(e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : "down");
					} else if (e.key === "F1") {
						// 터미널 안의 F1 은 셸 프로그램 몫(htop·mc 등)
						if (inTerminal(e.target)) return;
						e.preventDefault();
						setHelp(true);
					}
				}}
			>
				<div className="wb-bar" role="toolbar" aria-label="작업대 도구">
					<span className="wb-group" role="group" aria-label="칸 열기">
						<span className="wb-group-label">칸</span>
						<button type="button" className={`btn ghost${has("tree") ? " on" : ""}`} onClick={() => toggle("tree")} title={`파일 칸 — ${fs.side === "remote" ? "서버" : "내 PC"} 파일 트리 ${has("tree") ? "닫기" : "열기"}`} aria-pressed={has("tree")}>
							<FolderTree size={14} /> <span className="lbl">파일</span>
						</button>
						<button type="button" className={`btn ghost${shownIds.includes("term-") ? " on" : ""}`} onClick={showTerminal} title={shownIds.includes("term-") ? "터미널로" : "터미널 열기 — 닫혀 있으면 트리 오른쪽에 새로"} aria-pressed={shownIds.includes("term-")}>
							<SquareTerminal size={14} /> <span className="lbl">터미널</span>
						</button>
						{local && (
							<button type="button" className={`btn ghost${has("localtree") ? " on" : ""}`} onClick={() => toggle("localtree")} title={`내 PC 칸 — 내 PC 파일 트리 ${has("localtree") ? "닫기" : "열기"}(서버 트리와 끌어 놓아 주고받기)`} aria-pressed={has("localtree")}>
								<Monitor size={14} /> <span className="lbl">내 PC</span>
							</button>
						)}
						{fs.side === "remote" && (peers.length > 0 || hasConnectOther) && (
							<button
								type="button"
								className={`btn ghost${shownIds.includes("peer:") ? " on" : ""}`}
								onClick={() => void togglePeer()}
								title={peers.length ? "다른 서버 칸 — 열려 있는 다른 서버의 파일 트리를 옆에(트리끼리 끌어 놓으면 서버 ↔ 서버로 보냄)" : "다른 서버 칸 — 서버를 골라 연결하고 그 파일 트리를 옆에 엽니다(트리끼리 끌어 놓으면 서버 ↔ 서버로 보냄)"}
								aria-pressed={shownIds.includes("peer:")}
							>
								<Server size={14} /> <span className="lbl">다른 서버</span>
							</button>
						)}
						{local && (
							<button type="button" className={`btn ghost${has("transfers") ? " on" : ""}`} onClick={() => showTransfers(true)} title="전송 칸 — 올리기·받기 진행 목록(터미널 칸의 탭으로)">
								<ArrowDownUp size={14} /> <span className="lbl">전송</span>
							</button>
						)}
						{fs.side === "remote" && fs.conn != null && (
							<button type="button" className={`btn ghost${has("monitor") ? " on" : ""}`} onClick={openMonitor} title="자원 칸 — 이 서버의 CPU·메모리·디스크·네트워크·프로세스(문서 칸의 탭으로)">
								<Activity size={14} /> <span className="lbl">자원</span>
							</button>
						)}
						<button
							type="button"
							className={`btn ghost${toolMenu ? " on" : ""}`}
							onClick={(e) => {
								const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
								setToolMenu({ x: r.left, y: r.bottom + 4 });
							}}
							title="도구 — 서비스·Docker·웹 화면·내용 찾기·동기화·포트 포워딩·tmux·기본 배치(명령 팔레트 Ctrl+Shift+P 로도 찾습니다)"
							aria-haspopup="menu"
						>
							<Wrench size={14} /> <span className="lbl">도구</span> <ChevronDown size={12} />
						</button>
					</span>
					{(sudoFs || fs.side === "local") && <span className="sep" />}
					{(sudoFs || fs.side === "local") && (
						<span className="wb-group" role="group" aria-label="권한">
							<span className="wb-group-label">권한</span>
							{fs.side === "local" && (
								<button
									type="button"
									className={`btn ghost${isAdmin ? " on danger-on" : ""}`}
									title={isAdmin ? "앱 전체가 관리자 권한으로 돌고 있습니다(내 PC 셸·파일 모두)" : "관리자 권한 — 관리자 셸을 앱 안·새 창에 열거나 앱을 관리자로 다시 열기"}
									onClick={(e) => {
										const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
										setAdminMenu({ x: r.left, y: r.bottom + 4 });
									}}
								>
									<ShieldAlert size={14} /> <span className="lbl keep">{isAdmin ? "관리자" : "관리자로…"}</span>
								</button>
							)}
							{sudoFs && (
								<>
									<button
										type="button"
										className={`btn ghost${sudoOn ? " on danger-on" : ""}`}
										aria-pressed={sudoOn}
										title={`${sudoOn ? `sudo 켜짐 — 파일 트리·편집기가 ${sudoUser || "root"} 권한${sudoPlace === "together" ? ", 보이는 터미널도 sudo 셸" : ""}. 눌러 끄기` : `sudo — 파일 작업(트리·편집기)에 ${sudoUser || "root"} 권한${sudoPlace === "together" ? ", 보이는 터미널도 sudo 셸로" : ""}. 눌러 켜기`} · 계정 설정: ${sudoMode === "ask" ? "물어보기" : sudoMode === "saved" ? "암호 저장" : "암호 없이"}`}
										onClick={() => (sudoOn ? disableSudo() : void enableSudo(null, false))}
									>
										<ShieldAlert size={14} /> <span className="lbl keep">{sudoOn ? "sudo 켜짐" : "sudo"}{sudoUser ? ` (${sudoUser})` : ""}</span>
									</button>
									<Select<"together" | "apart">
										size="sm"
										value={sudoPlace}
										onChange={setSudoPlace}
										title="sudo 를 어디에 — 켜기 전에 고릅니다"
										disabled={sudoOn}
										options={[
											{ value: "together", label: "파일 + 터미널", hint: "보이는 터미널도 sudo -s" },
											{ value: "apart", label: "파일만", hint: "터미널은 그대로" },
										]}
									/>
								</>
							)}
						</span>
					)}
					<span className="sep" />
					<span className="wb-group" role="group" aria-label="배치">
						<span className="wb-group-label">배치</span>
						<LayoutLockButton locked={locked} onChange={setLocked} />
					</span>
					{lockNote && <span className="badge warn">배치가 잠겨 있습니다 — 자물쇠(Ctrl+Alt+L)로 푸세요</span>}
					<span style={{ flex: 1 }} />
					{local && (
						<span className="badge wb-chip" title="트리끼리 끌어 놓거나 우클릭으로 주고받기">
							<ArrowLeftRight size={12} /> {local.label} ↔ {fs.label}
						</span>
					)}
					<span className="wb-chip">{badge}</span>
				</div>
				{server && fwdOpen && <ForwardSheet profileId={server.profileId} conn={server.conn} title={server.name} onClose={() => setFwdOpen(false)} />}
				{server && tmuxOpen && <TmuxSheet conn={server.conn} title={server.name} enabled={server.tmux} onClose={() => setTmuxOpen(false)} />}
				{sudoAsk && (
					<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setSudoAsk(null)}>
						<form
							className="sheet"
							onSubmit={(e) => {
								e.preventDefault();
								const f = new FormData(e.currentTarget);
								void enableSudo(String(f.get("pw") ?? ""), f.get("save") === "on");
							}}
						>
							<h3>sudo 암호</h3>
							<p style={{ color: "var(--text-2)", marginTop: 0 }}>{sudoUser || "root"} 권한으로 파일을 읽고 씁니다. 넣은 암호는 이 연결 동안 기억하고, 저장하면 이 계정에서 다시 묻지 않습니다.</p>
							<div className="field">
								<input name="pw" type="password" autoFocus placeholder="sudo 암호" />
							</div>
							{sudoAsk.error && <p className="err">{sudoAsk.error}</p>}
							{fs.side === "remote" && (
								<label className="check">
									<input name="save" type="checkbox" /> 이 계정의 sudo 암호로 저장(OS 자격 증명 저장소, sudo 설정이 '암호 저장'으로)
								</label>
							)}
							<div className="sheet-actions">
								<button type="button" className="btn" onClick={() => setSudoAsk(null)}>
									취소
								</button>
								<button type="submit" className="btn primary">
									켜기
								</button>
							</div>
						</form>
					</div>
				)}
				<div className="wb-dock">
					<DockviewReact
						theme={theme}
						components={components}
						watermarkComponent={Watermark}
						defaultTabComponent={GuardedTab}
						onReady={onReady}
						rightHeaderActionsComponent={GroupActions}
						disableDnd={locked}
						locked={locked}
					/>
				</div>
			</div>
			{help && <ShortcutHelp locked={locked} onClose={() => setHelp(false)} />}
			{quickOpen && (
				<QuickOpen
					fs={fsNow}
					base={(lastCwd.current ?? fs.home).replace(/\\/g, "/")}
					onClose={() => setQuickOpen(false)}
					onOpen={(path) => {
						setQuickOpen(false);
						openFile("remote", { name: path.split("/").pop() ?? path, path, kind: "file", size: 0 });
					}}
				/>
			)}
			{conflict.element}
			{toolMenu && (
				<ContextMenu
					x={toolMenu.x}
					y={toolMenu.y}
					onClose={() => setToolMenu(null)}
					items={[
						...(fs.side === "remote" && fs.conn != null
							? ([
									{ label: `${has("monitor") ? "✓ " : ""}자원 — CPU·메모리·디스크·프로세스`, run: openMonitor },
									{ label: `${has("services") ? "✓ " : ""}서비스 — systemd·journal`, run: () => openTool("services", "서비스") },
									{ label: `${has("docker") ? "✓ " : ""}Docker — 컨테이너·로그·셸`, run: () => openTool("docker", "Docker") },
									{ label: `${has("webports") ? "✓ " : ""}웹 화면 — 듣는 포트 → 포워딩 → 브라우저`, run: () => openTool("webports", "웹 화면") },
								] as MenuItem[])
							: []),
						{ label: `${has("search") ? "✓ " : ""}내용 찾기 — grep  Ctrl+Shift+F`, run: () => openTool("search", "내용 찾기") },
						...(local && syncInfo ? ([{ label: `${has("sync") ? "✓ " : ""}동기화 — 내 PC 폴더 ↔ 서버 폴더(rsync 모드)`, run: openSync }] as MenuItem[]) : []),
						...(server
							? ([
									{ sep: true },
									{ label: "포트 포워딩…", run: () => setFwdOpen(true) },
									{ label: `tmux 세션…${server.tmux ? " (이 서버는 tmux 로 열기)" : ""}`, run: () => setTmuxOpen(true) },
								] as MenuItem[])
							: []),
						{ sep: true },
						{ label: terminalOnly ? "기본 배치 — 터미널만" : "기본 배치 — 왼쪽 트리 · 오른쪽 터미널", run: resetLayout, disabled: locked },
					]}
				/>
			)}
			{adminMenu && (
				<ContextMenu
					x={adminMenu.x}
					y={adminMenu.y}
					onClose={() => setAdminMenu(null)}
					items={[
						...(shellList ?? [])
							.filter((x) => x.admin)
							.map((x) => ({ label: `앱 안에서 열기 — ${x.label}`, run: () => addTerminalRef.current(undefined, x.id) })),
						{ label: "관리자 권한 새 창 — 지금 셸", run: () => void invoke("pty_admin_window", { shell: defaultShell, cwd: lastCwd.current }).catch((e) => alert(String(e))) },
						{ label: "앱 전체를 관리자 권한으로 다시 열기…", danger: true, run: () => confirm("앱을 관리자 권한으로 다시 엽니다(지금 창은 닫힙니다). 저장 안 한 것은 초안으로 남습니다. 계속할까요?") && void invoke("app_relaunch_admin").catch((e) => alert(String(e))) },
						...(shellList?.some((x) => x.admin) ? [] : [{ sep: true as const }, { label: "gsudo 를 깔면 앱 안에서 관리자 셸을 열 수 있습니다", disabled: true, run: () => {} }]),
					]}
				/>
			)}
		</WbCtx.Provider>
	);
});

/** F1 — 단축키 모음 */
function ShortcutHelp({ locked, onClose }: { locked: boolean; onClose: () => void }) {
	const mac = document.documentElement.dataset.os === "macos";
	const rows = shortcutRows(mac, locked);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<div className="sheet" style={{ width: "min(560px, calc(100vw - 32px))" }}>
				<h3>단축키</h3>
				<table className="keys">
					<tbody>
						{rows.map(([k, v]) =>
							v ? (
								<tr key={k}>
									<td>
										<kbd>{k}</kbd>
									</td>
									<td>{v}</td>
								</tr>
							) : (
								<tr key={k} className="sec">
									<td colSpan={2}>{k}</td>
								</tr>
							),
						)}
					</tbody>
				</table>
				<div className="sheet-actions">
					<button type="button" className="btn primary" autoFocus onClick={onClose}>
						닫기
					</button>
				</div>
			</div>
		</div>
	);
}
