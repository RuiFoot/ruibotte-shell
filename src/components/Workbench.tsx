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
import { confirmDiscard, forgetOwner, isDirty, setDirty } from "../lib/dirty";
import "dockview-react/dist/styles/dockview.css";
import { listen } from "@tauri-apps/api/event";
import { Activity, Cog, Container, Globe, TextSearch, ArrowDownUp, ArrowLeftRight, ArrowRightLeft, Columns2, FileText, FolderTree, Layers, LayoutTemplate, Monitor, Plus, Radio, RefreshCcw, Rows2, ShieldAlert, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
} from "../lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { DiffView } from "./DiffView";
import { EditorView_ } from "./Editor";
import { BinaryPreview, previewKind } from "./Preview";
import { freeName, useConflictAsk } from "./ConflictSheet";
import { ContextMenu } from "./ContextMenu";
import { ForwardChips, ForwardSheet, TmuxSheet } from "./ForwardPanel";
import { RouteChip } from "./RouteChip";
import { MiniMonitor } from "./MiniMonitor";
import { QuickOpen } from "./QuickOpen";
import { LayoutLockButton, useLayoutLock } from "../lib/layoutLock";
import { MonitorPanel } from "./MonitorPanel";
import { Select } from "./Select";
import { SyncPanel } from "./SyncPanel";
import { TailView } from "./TailView";
import { invoke } from "@tauri-apps/api/core";
import type { CompletionSource } from "../lib/termComplete";
import { type DragEntry, FileTree } from "./FileTree";
import { TerminalView } from "./Terminal";
import { askText } from "../lib/ask";
import type { SudoCtx } from "./panels/common";
import { ContentSearch } from "./panels/ContentSearch";
import { DockerPanel } from "./panels/DockerPanel";
import { ServicesPanel } from "./panels/ServicesPanel";
import { WebPortsPanel } from "./panels/WebPortsPanel";
import { type Command, useCommands } from "../lib/commands";

/**
 * IDE식 작업대 — 트리·편집기·터미널이 모두 도킹 칸이다.
 * 탭을 끌어 위·아래·좌·우 어디에나 붙이거나 다른 칸에 합치고, 띄워 둘 수도 있다.
 * 고정 칸(트리·터미널·내 PC 트리)의 배치는 작업대 종류별로 앱 DB 에 저장한다(편집기 탭은 저장하지 않음).
 */

const theme: DockviewTheme = { name: "rbshell", className: "rbshell-dock", gap: 0, dndOverlayMounting: "relative" };

type Which = "remote" | "local";
type Ctx = {
	fs: FsBackend;
	local?: FsBackend;
	term: TermBackend;
	label: string;
	startPath?: string;
	openFile: (which: Which, e: FsEntry, line?: number) => void;
	activePanel: string | null;
	drop: (src: DragEntry, destSide: "remote" | "local", destDir: string) => void;
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
	onCwd: (path: string) => void;
	completion: CompletionSource;
	openTail: (which: Which, e: FsEntry) => void;
	compare: (which: Which, e: FsEntry) => void;
	compareLabel: (which: Which, e: FsEntry) => string;
	archive: (e: FsEntry) => void;
	relay: (e: FsEntry) => void;
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
	openTerminalCmd: (cmd: string, title: string) => void;
	/** 지금 터미널 폴더 */
	cwdNow: () => string | null;
	/** 원격: 포트 포워딩 관리 창 열기(상태 줄 표시를 누르면) */
	openForwards?: () => void;
	/** 원격: 이 서버 번호(서버별 터미널 색) */
	profileId?: number;
};
const WbCtx = createContext<Ctx | null>(null);
const useWb = () => useContext(WbCtx) as Ctx;

function TreePanel(props: IDockviewPanelProps<{ which: Which }>) {
	const ctx = useWb();
	const fs = props.params.which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
	// 원격 트리는 / 를 뿌리로 두고 시작 폴더(또는 홈)를 펼쳐 보인다 — 이전 판과 같은 틀
	const start = props.params.which === "remote" ? ctx.startPath || fs.home : fs.home;
	const [root, setRoot] = useState(fs.side === "remote" ? "/" : fs.home);
	const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(() => (fs.side === "remote" ? { path: start, nonce: 1 } : null));
	const follows = props.params.which === "remote" || !ctx.local;
	const [note, setNote] = useState<string | null>(null);
	// 트리에서 폴더를 고르면(같이) 터미널이 그 폴더로 — 프롬프트가 아니면 알리고 보내지 않는다
	const onSelectDir = (dir: string) => {
		if (!ctx.follow || !follows) return;
		if (!ctx.cd(dir, true)) {
			setNote("터미널이 명령을 실행 중이라 cd 하지 않았습니다");
			window.setTimeout(() => setNote(null), 3000);
		}
	};
	// 터미널을 따라가기: 원격 트리(또는 내 PC 작업대의 트리)만
	useEffect(() => {
		const follows = props.params.which === "remote" || !ctx.local;
		if (!follows) return;
		const on = (ev: Event) => setReveal({ path: (ev as CustomEvent<string>).detail, nonce: Date.now() });
		window.addEventListener(`rb-cwd-${ctx.treeKey}`, on);
		return () => window.removeEventListener(`rb-cwd-${ctx.treeKey}`, on);
	}, [ctx.treeKey, ctx.local, props.params.which]);
	return (
		<div className="panel-fill">
			<FileTree
				fs={fs}
				root={root}
				onRoot={setRoot}
				reveal={reveal}
				onSelectDir={onSelectDir}
				sync={follows ? (ctx.follow ? "together" : "apart") : undefined}
				onSyncChange={follows ? (m) => ctx.setFollow(m === "together") : undefined}
				note={note}
				onOpen={(e) => ctx.openFile(props.params.which, e)}
				onDrop={(src, dir) => ctx.drop(src, fs.side, dir)}
				onSend={ctx.local ? (e) => ctx.sendTo(props.params.which, e) : undefined}
				sendLabel={props.params.which === "local" ? "서버로 올리기" : "내 PC로 받기"}
				onCd={props.params.which === "remote" || !ctx.local ? ctx.cd : undefined}
				onTail={(e) => ctx.openTail(props.params.which, e)}
				onCompare={(e) => ctx.compare(props.params.which, e)}
				compareLabel={(e) => ctx.compareLabel(props.params.which, e)}
				onArchive={props.params.which === "remote" && fs.side === "remote" ? ctx.archive : undefined}
				onRelay={props.params.which === "remote" && ctx.hasPeers ? ctx.relay : undefined}
				onUploadPick={props.params.which === "remote" ? ctx.uploadPick : undefined}
				onDownloadTo={props.params.which === "remote" ? ctx.downloadTo : undefined}
				onNewTerminal={follows ? ctx.newTerminal : undefined}
			/>
		</div>
	);
}

function EditorPanel(props: IDockviewPanelProps<{ which: Which; path: string; name: string; line?: { n: number; seq: number } }>) {
	const ctx = useWb();
	const fs = props.params.which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
	const onDirty = useCallback(
		(dirty: boolean) => {
			setDirty(ctx.owner, props.api.id, props.params.name, dirty);
			props.api.setTitle(`${dirty ? "● " : ""}${props.params.name}`);
		},
		[props.api, props.params.name, ctx.owner],
	);
	useEffect(() => () => setDirty(ctx.owner, props.api.id, "", false), [ctx.owner, props.api.id]);
	const kind = previewKind(props.params.path);
	return (
		<div className="panel-fill">
			{kind ? (
				<BinaryPreview fs={fs} path={props.params.path} kind={kind} />
			) : (
				<EditorView_
					fs={fs}
					path={props.params.path}
					active={ctx.activePanel === props.api.id}
					onDirtyChange={onDirty}
					line={props.params.line}
					onTail={() => ctx.openTail(props.params.which, { name: props.params.name, path: props.params.path, kind: "file", size: 0 })}
				/>
			)}
		</div>
	);
}

function TerminalPanel(props: IDockviewPanelProps<{ n: number; cwd?: string; shell?: string }>) {
	const ctx = useWb();
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
	const completion = useMemo(() => ({ ...ctx.completion, key: `${ctx.completion.key}:${kind}`, shellKind: kind as "linux" | "pwsh" | "cmd" }), [ctx.completion, kind]);
	// 터미널이 셸 정보(목록)를 받기 전에는 열지 않는다(기본 셸로 한 번 열렸다 다시 열리지 않게)
	if (ctx.localShells && !shell) return <div className="panel-fill" />;
	return (
		<div className="panel-fill">
			<TerminalView
				backend={ctx.term}
				active={ctx.activePanel === props.api.id}
				cwd={props.params.cwd ?? ctx.startPath}
				label={ctx.label}
				toolbar={false}
				onShell={(h) => ctx.registerShell(props.api.id, h)}
				onCwd={ctx.onCwd}
				onInput={(d) => ctx.broadcast(props.api.id, d)}
				completion={ctx.localShells ? completion : ctx.completion}
				shell={shell}
				shellOptions={ctx.localShells?.map((s) => ({ value: s.id, label: s.label, hint: s.admin ? "관리자" : undefined }))}
				onShellChange={(id) => {
					setShell(id);
					props.api.updateParameters({ ...props.params, shell: id });
					const label = ctx.localShells?.find((s) => s.id === id)?.label;
					if (label) props.api.setTitle(label);
				}}
				defaultEncoding={ctx.termEncoding}
				onOpenPath={(p) => ctx.openFile("remote", { name: p.split("/").pop() ?? p, path: p, kind: "file", size: 0 })}
				onSplit={(dir) => ctx.splitTerminal(props.api.id, dir)}
				statusExtra={
					visible && ctx.fs.side === "remote" && ctx.fs.conn != null ? (
						<>
							<RouteChip conn={ctx.fs.conn} />
							{ctx.openForwards && <ForwardChips conn={ctx.fs.conn} onOpen={ctx.openForwards} />}
							<MiniMonitor conn={ctx.fs.conn} onOpen={ctx.openMonitor} />
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
	return <TailView fs={fs} path={props.params.path} />;
}

function DiffPanel(props: IDockviewPanelProps<{ a: { which: Which; path: string }; b: { which: Which; path: string } }>) {
	const ctx = useWb();
	const side = (s: { which: Which; path: string }) => {
		const fs = s.which === "local" ? ctx.local ?? ctx.fs : ctx.fs;
		return { fs, path: s.path, label: `${s.which === "local" ? "내 PC" : fs.label}:${s.path.split("/").pop()}` };
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: 열 때 한 번
	const sides = useMemo(() => [side(props.params.a), side(props.params.b)] as const, []);
	return <DiffView a={sides[0]} b={sides[1]} />;
}

function SyncDock() {
	const ctx = useWb();
	if (ctx.fs.conn == null || !ctx.syncInfo) return null;
	return <SyncPanel conn={ctx.fs.conn} remoteHome={ctx.fs.home} user={ctx.syncInfo.user} host={ctx.syncInfo.host} port={ctx.syncInfo.port} onRun={ctx.showTransfers} />;
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
	return <ServicesPanel conn={ctx.fs.conn} sudo={ctx.sudo} sudoOn={ctx.sudoOn} visible={visible} onOpenTerminal={ctx.openTerminalCmd} />;
}
function DockerDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const visible = usePanelVisible(props.api);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return remoteOnly;
	return <DockerPanel conn={ctx.fs.conn} sudo={ctx.sudo} visible={visible} onOpenTerminal={ctx.openTerminalCmd} />;
}
function WebPortsDock(props: IDockviewPanelProps) {
	const ctx = useWb();
	const visible = usePanelVisible(props.api);
	if (ctx.fs.side !== "remote" || ctx.fs.conn == null) return remoteOnly;
	return <WebPortsPanel conn={ctx.fs.conn} sudo={ctx.sudo} visible={visible} />;
}
function SearchDock(_props: IDockviewPanelProps) {
	const ctx = useWb();
	return (
		<ContentSearch
			side={ctx.fs.side}
			conn={ctx.fs.conn}
			sudo={ctx.sudo}
			startDir={ctx.cwdNow() ?? ctx.fs.home}
			onOpenFile={(p, line) => ctx.openFile("remote", { name: p.split("/").pop() ?? p, path: p, kind: "file", size: 0 }, line)}
		/>
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
	return <MonitorPanel conn={ctx.fs.conn} sudoOn={ctx.sudoOn} visible={visible} />;
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

function TransfersPanel() {
	const ctx = useWb();
	const [list, setList] = useState<TransferProgress[]>([]);
	useEffect(() => {
		const un = listen<TransferProgress>("transfer", (e) => {
			const p = e.payload;
			setList((l) => {
				const i = l.findIndex((x) => x.id === p.id);
				if (i < 0) return [p, ...l].slice(0, 50);
				const n = l.slice();
				n[i] = p;
				return n;
			});
			if (p.state === "done" || p.state === "cancelled") {
				notifyFsChanged(p.direction === "up" ? "remote" : "local", parentDir(p.dest), ctx.fs.conn);
			}
		});
		return () => void un.then((f) => f());
	}, [ctx.fs.conn]);
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
						<i style={{ width: a.state === "running" ? "40%" : "100%" }} />
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
							{p.direction === "up" ? "↑ 올리기" : p.direction === "relay" ? "⇄ 중계" : "↓ 받기"} <b>{p.name}</b>
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
							</span>
						)}
						<div className={`bar ${p.state}`}>
							<i style={{ width: `${pct}%` }} />
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
	const anyDoc = d.panels.find((p) => /^(edit|tail|diff):/.test(p.id) || p.id === "monitor");
	if (anyDoc) {
		d.addPanel({ ...opts, renderer: "always", position: { referencePanel: anyDoc.id, direction: "within" } });
		return;
	}
	const term = d.panels.find((p) => p.id.startsWith("term-"));
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
	d.addPanel({
		...opts,
		renderer: "always",
		position: term ? { referencePanel: term.id, direction: "within" } : { direction: "below" },
		inactive: !focus,
	});
}

/**
 * 기본 배치(Orbit 작업대와 같은 틀): 왼쪽 트리 · 가운데 문서 자리(비어 있으면 안내) · 아래 터미널.
 * 내 PC 트리는 기본으로 두지 않고, 주고받을 때 도구 막대의 "내 PC" 로 오른쪽에 연다.
 */
function defaultLayout(d: DockviewApi) {
	d.clear();
	d.addPanel({ id: "tree", component: "tree", title: "파일", params: { which: "remote" }, renderer: "always" });
	const term = d.addPanel({
		id: "term-1",
		component: "terminal",
		title: "터미널",
		params: { n: 1 },
		renderer: "always",
		position: { referencePanel: "tree", direction: "right" },
	});
	const docs = d.addGroup({ referencePanel: "term-1", direction: "above" });
	d.getPanel("tree")?.api.setSize({ width: 280 });
	const total = docs.height + term.group.height;
	if (total > 0) docs.api.setSize({ height: Math.round(total * 0.6) });
	term.api.setActive();
}

/** 저장용 배치 — 편집기 탭은 빼고 고정 칸만 */
function stripEditors(json: ReturnType<DockviewApi["toJSON"]>) {
	const j = structuredClone(json) as unknown as {
		panels: Record<string, unknown>;
		grid: { root: unknown };
		activeGroup?: string;
	};
	for (const id of Object.keys(j.panels)) if (!FIXED.test(id)) delete j.panels[id];
	const walk = (node: { type: string; data: unknown }): boolean => {
		if (node.type === "leaf") {
			const g = node.data as { views: string[]; activeView?: string };
			g.views = g.views.filter((v) => FIXED.test(v));
			if (g.activeView && !FIXED.test(g.activeView)) g.activeView = g.views[0];
			return true;
		}
		const kids = node.data as { type: string; data: unknown }[];
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

const openEditors = new Map<string, { which: Which; path: string; name: string }[]>();

export function Workbench({
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
	/** 열려 있는 다른 SSH 연결(중계 대상) */
	peers?: { conn: number; label: string; home: string }[];
	syncInfo?: { user: string; host: string; port: number };
	/** 앱 탭 이름 — 저장 안 한 편집기를 앱 탭 단위로 묻기 위해 */
	ownerId?: string;
	/** 원격: 이 연결의 서버(포트 포워딩 규칙·tmux 설정) */
	server?: { profileId: number; conn: number; tmux: boolean; name: string };
}) {
	const [fwdOpen, setFwdOpen] = useState(false);
	const [tmuxOpen, setTmuxOpen] = useState(false);
	const [sudoOn, setSudoOn] = useState(false);
	const [sudoPlace, setSudoPlace] = useState<"together" | "apart">("together");
	const [follow, setFollow] = useState(true);
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
	const fsNow = sudoOn && sudoFs ? sudoFs : fs;
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
		}),
		[fs, label],
	);
	const lastCwd = useRef<string | null>(null);
	const dock = useRef<DockviewApi | null>(null);
	const [activePanel, setActivePanel] = useState<string | null>(null);
	const termSeq = useRef(1);
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

	const openFile = useCallback((which: Which, e: FsEntry, lineNo?: number) => {
		const d = dock.current;
		if (!d) return;
		rememberRef.current(which, e);
		const id = `edit:${which}:${e.path}`;
		const line = lineNo ? { n: lineNo, seq: Date.now() } : undefined;
		const existing = d.getPanel(id);
		if (existing) {
			if (line) existing.api.updateParameters({ line });
			existing.api.setActive();
			return;
		}
		addDoc(d, { id, component: "editor", title: e.name, params: { which, path: e.path, name: e.name, line } });
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
		(path: string) => {
			lastCwd.current = path;
			if (follow) window.dispatchEvent(new CustomEvent(`rb-cwd-${instance.current}`, { detail: path }));
		},
		[follow],
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

	const fsOf = useCallback((side: "remote" | "local") => (side === "local" && local ? local : fs), [fs, local]);

	const drop = useCallback(
		async (src: DragEntry, destSide: "remote" | "local", destDir: string) => {
			try {
				if (src.side === destSide) {
					// 같은 쪽 = 옮기기
					if (parentDir(src.path) === destDir || destDir === src.path || destDir.startsWith(`${src.path}/`)) return;
					if (!confirm(`${src.name} 을(를) ${destDir} 로 옮길까요?`)) return;
					await fsOf(destSide).rename(src.path, joinPath(destDir, src.name));
					notifyFsChanged(destSide, destDir, fs.conn);
					notifyFsChanged(src.side, parentDir(src.path), fs.conn);
					return;
				}
				if (fs.conn == null) return;
				const existing = await fsOf(destSide).list(destDir);
				let overwrite = false;
				let destName: string | undefined;
				if (existing.some((x) => x.name === src.name)) {
					// 덮어쓰기·건너뛰기(폴더면 안의 같은 이름만)·이름 바꿔 보내기(name (1).ext)
					const choice = await conflict.ask([src.name], destDir, destSide === "local");
					if (!choice) return;
					overwrite = choice === "overwrite";
					if (choice === "rename") destName = freeName(src.name, new Set(existing.map((x) => x.name)));
				}
				showTransfers();
				await transfers.start(fs.conn, src.side === "local" ? "up" : "down", src.path, destDir, overwrite, destName);
			} catch (e) {
				alert(asSshError(e).message);
			}
		},
		[fs, fsOf, conflict.ask],
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
		[fs],
	);

	const relay = useCallback(
		async (e: FsEntry) => {
			if (fs.conn == null || !peers.length) return;
			const pick =
				peers.length === 1
					? peers[0]
					: peers[Number((await askText({ title: "어느 서버로 보낼까요?", choiceOnly: true, choices: peers.map((p, i) => ({ value: String(i), label: p.label })) })) ?? -1)];
			if (!pick) return;
			const dest = await askText({ title: `${pick.label} 로 보내기`, message: "받을 폴더", value: pick.home, okLabel: "보내기" });
			if (!dest) return;
			showTransfers();
			try {
				await invoke("relay_start", { fromConn: fs.conn, src: e.path, toConn: pick.conn, destDir: dest, overwrite: confirm("같은 이름이 있으면 덮어쓸까요? (취소 = 건너뛰기)") });
			} catch (x) {
				alert(asSshError(x).message);
			}
		},
		[fs, peers],
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
	const openTerminalCmdRef = useRef<(cmd: string, title: string) => void>(() => {});
	openTerminalCmdRef.current = (cmd: string, title: string) => {
		const d = dock.current;
		if (!d) return;
		termSeq.current += 1;
		const n = termSeq.current;
		const id = `term-${n}`;
		const ref = d.panels.find((p) => p.id.startsWith("term-"));
		d.addPanel({ id, component: "terminal", title, params: { n }, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
		let tries = 0;
		const send = () => {
			const h = shells.current.get(id);
			if (h && (!h.idle || h.idle())) return void h.send(`${cmd}\r`);
			if (++tries < 60) window.setTimeout(send, 150);
		};
		window.setTimeout(send, 300);
	};

	const addTerminalRef = useRef<(cwd?: string, shell?: string, near?: string) => void>(() => {});
	const addTerminal = (cwd?: string, shell?: string, near?: string) => {
		const d = dock.current;
		if (!d) return;
		termSeq.current += 1;
		const n = termSeq.current;
		const ref = (near ? d.getPanel(near) : undefined) ?? d.panels.find((p) => p.id.startsWith("term-"));
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
		if (id === "localtree") d.getPanel(id)?.api.setSize({ width: 300 });
	};

	// 기본 배치가 바뀌면(v2: 트리·문서·아래 터미널) 옛 저장 배치는 쓰지 않는다
	const savedKey = `${layoutKey}.v2`;
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
			if (!ok) defaultLayout(e.api);
			// 다시 연결한 뒤: 끊기기 전에 열려 있던 편집기 탭을 다시 연다(초안은 편집기가 되살리기를 묻는다)
			for (const x of openEditors.get(owner) ?? []) {
				if (!e.api.getPanel(`edit:${x.which}:${x.path}`)) addDoc(e.api, { id: `edit:${x.which}:${x.path}`, component: "editor", title: x.name, params: x });
			}
		});
		e.api.onDidActivePanelChange((ev) => setActivePanel(ev.panel?.id ?? null));
		e.api.onDidLayoutChange(() => {
			if (gone.current) return;
			setShownIds(e.api.panels.map((p) => p.id).join("|"));
			window.clearTimeout(saveTimer.current);
			saveTimer.current = window.setTimeout(() => {
				const d = dock.current;
				if (!d || gone.current) return;
				void api.settingSet(savedKey, JSON.stringify(stripEditors(d.toJSON())));
				openEditors.set(
					owner,
					d.panels.filter((p) => p.id.startsWith("edit:")).map((p) => p.params as { which: Which; path: string; name: string }),
				);
			}, 600);
		});
	};

	const ctx = useMemo<Ctx>(
		() => ({
			fs: fsNow,
			local,
			term,
			label,
			startPath,
			openFile,
			activePanel: active ? activePanel : null,
			drop: (src: DragEntry, side: "remote" | "local", dir: string) => void drop(src, side, dir),
			sendTo,
			cd,
			follow,
			setFollow,
			uploadPick: local && fs.side === "remote" ? uploadPick : undefined,
			downloadTo: local && fs.side === "remote" ? downloadTo : undefined,
			newTerminal: (dir: string) => addTerminalRef.current(dir),
			termEncoding,
			localShells: fs.side === "local" ? shellList : undefined,
			defaultShell,
			registerShell,
			onCwd,
			broadcast,
			completion,
			openTail,
			compare,
			compareLabel,
			archive: (e: FsEntry) => void archive(e),
			relay: (e: FsEntry) => void relay(e),
			hasPeers: peers.length > 0,
			showTransfers: () => showTransfers(true),
			syncInfo,
			treeKey: instance.current,
			owner,
			sudoOn: sudoOn && !!sudoFs,
			splitTerminal,
			locked,
			broadcastOn,
			setBroadcast: setBroadcastOn,
			addTerminalNear: (id?: string) => addTerminalRef.current(undefined, undefined, id),
			openMonitor: () => openMonitorRef.current(),
			sudo: sudo ? { mode: sudo.mode, user: sudo.user || "root" } : undefined,
			openTerminalCmd: (cmd: string, title: string) => openTerminalCmdRef.current(cmd, title),
			cwdNow: () => lastCwd.current,
			openForwards: server ? () => setFwdOpen(true) : undefined,
			profileId: server?.profileId,
			rootShell: fs.side === "remote" && sudoMode !== "off" ? (id: string, on: boolean) => void rootShell(id, on) : undefined,
		}),
		[fsNow, local, term, label, startPath, openFile, activePanel, active, drop, sendTo, cd, registerShell, onCwd, broadcast, completion, openTail, compare, compareLabel, archive, relay, peers, syncInfo, sudoOn, sudoFs, sudoMode, owner, follow, uploadPick, downloadTo, termEncoding, setFollow, shellList, defaultShell, splitTerminal, rootShell, fs.side, locked, broadcastOn, server, sudo],
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
			defaultLayout(dock.current);
		}
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
			w("splitRight", "터미널 오른쪽으로 나누기", split("right"), { disabled: locked, hint: lockHint, keywords: "split 분할" }),
			w("splitBelow", "터미널 아래로 나누기", split("below"), { disabled: locked, hint: lockHint, keywords: "split 분할" }),
			w("broadcast", broadcastOn ? "동시 입력 끄기" : "동시 입력 켜기", () => setBroadcastOn(!broadcastRef.current), { hint: "한 터미널에 친 것을 이 작업대의 모든 터미널에", keywords: "broadcast 브로드캐스트" }),
			w("termPane", "터미널 칸 숨기기·보이기", toggleTermPane, { keys: "Ctrl+`" }),
			w("focusTree", "트리로 옮기기", () => focusPanel((id) => id === "tree" || id === "localtree"), { keys: "Alt+1" }),
			w("focusDoc", "문서(편집기)로 옮기기", () => focusPanel((id) => /^(edit|tail|diff):/.test(id) || id === "monitor"), { keys: "Alt+2" }),
			w("focusTerm", "터미널로 옮기기", () => focusPanel((id) => id.startsWith("term-")), { keys: "Alt+3" }),
			w("lock", locked ? "배치 잠금 풀기" : "배치 잠그기", () => setLocked(!lockedRef.current), { keys: "Ctrl+Alt+L", keywords: "lock 고정" }),
			w("defaultLayout", "기본 배치로 되돌리기", resetLayout, { disabled: locked, hint: lockHint ?? "왼쪽 트리 · 가운데 문서 · 아래 터미널", keywords: "layout reset 초기화" }),
			w("tree", has("tree") ? "파일 칸 닫기" : "파일 칸 열기", () => toggle("tree"), { disabled: locked, hint: lockHint, keywords: "트리 tree" }),
			w("help", "단축키 도움말", () => setHelp(true), { keys: "F1", keywords: "도움말 help shortcut" }),
		];
		if (local) {
			list.push(
				w("localtree", has("localtree") ? "내 PC 칸 닫기" : "내 PC 칸 열기", () => toggle("localtree"), { disabled: locked, hint: lockHint ?? "서버 트리와 끌어 놓아 주고받기" }),
				w("transfers", "전송 칸 보기", () => showTransfers(true), { keywords: "올리기 받기 upload download" }),
			);
		}
		if (fs.side === "remote" && fs.conn != null) {
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
						// 파일 내용 찾기 칸
						e.preventDefault();
						e.stopPropagation();
						openTool("search", "내용 찾기");
					} else if (e.key === "F1") {
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
						{local && (
							<button type="button" className={`btn ghost${has("localtree") ? " on" : ""}`} onClick={() => toggle("localtree")} title={`내 PC 칸 — 내 PC 파일 트리 ${has("localtree") ? "닫기" : "열기"}(서버 트리와 끌어 놓아 주고받기)`} aria-pressed={has("localtree")}>
								<Monitor size={14} /> <span className="lbl">내 PC</span>
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
						{fs.side === "remote" && fs.conn != null && (
							<>
								<button type="button" className={`btn ghost${has("services") ? " on" : ""}`} onClick={() => openTool("services", "서비스")} title="서비스 칸 — systemd 서비스 상태·시작·중지·재시작·journal 로그">
									<Cog size={14} /> <span className="lbl">서비스</span>
								</button>
								<button type="button" className={`btn ghost${has("docker") ? " on" : ""}`} onClick={() => openTool("docker", "Docker")} title="Docker 칸 — 컨테이너 목록·로그·안에 셸 열기·재시작·이미지">
									<Container size={14} /> <span className="lbl">Docker</span>
								</button>
								<button type="button" className={`btn ghost${has("webports") ? " on" : ""}`} onClick={() => openTool("webports", "웹 화면")} title="웹 화면 — 서버에서 듣고 있는 포트, 눌러 포워딩 켜고 브라우저로 열기">
									<Globe size={14} /> <span className="lbl">웹</span>
								</button>
							</>
						)}
						<button type="button" className={`btn ghost${has("search") ? " on" : ""}`} onClick={() => openTool("search", "내용 찾기")} title="내용 찾기 — 폴더 안 파일 내용을 grep 으로 찾고 그 줄로 열기(Ctrl+Shift+F)">
							<TextSearch size={14} /> <span className="lbl">찾기</span>
						</button>
						{local && syncInfo && (
							<button type="button" className={`btn ghost${has("sync") ? " on" : ""}`} onClick={openSync} title="동기화 칸 — 내 PC 폴더 ↔ 이 서버 폴더(rsync 모드)·자동 반영">
								<RefreshCcw size={14} /> <span className="lbl">동기화</span>
							</button>
						)}
					</span>
					{server && (
						<>
							<span className="sep" />
							<span className="wb-group" role="group" aria-label="연결">
								<span className="wb-group-label">연결</span>
								<button type="button" className={`btn ghost${fwdOpen ? " on" : ""}`} onClick={() => setFwdOpen(true)} title="포트 포워딩 — 로컬·원격·SOCKS 규칙 추가·고치기·켜고 끄기(켜진 것은 터미널 상태 줄에 ⇄ 로)">
									<ArrowRightLeft size={14} /> <span className="lbl">포워딩</span>
								</button>
								<button type="button" className={`btn ghost${tmuxOpen ? " on" : ""}`} onClick={() => setTmuxOpen(true)} title={`tmux 세션 보기·끝내기${server.tmux ? " — 이 서버는 터미널을 tmux 로 엽니다(끊겨도 이어짐)" : ""}`}>
									<Layers size={14} /> <span className="lbl">tmux{server.tmux ? " ●" : ""}</span>
								</button>
							</span>
						</>
					)}
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
						<button
							type="button"
							className="btn ghost"
							title={locked ? "배치가 잠겨 있어 초기화할 수 없습니다" : "기본 배치 — 이 작업대의 칸을 왼쪽 트리·가운데 문서·아래 터미널로 되돌리기"}
							disabled={locked}
							onClick={resetLayout}
						>
							<LayoutTemplate size={14} /> <span className="lbl">기본 배치</span>
						</button>
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
}

/** F1 — 단축키 모음 */
function ShortcutHelp({ locked, onClose }: { locked: boolean; onClose: () => void }) {
	const mac = document.documentElement.dataset.os === "macos";
	const rows: [string, string][] = [
		["앱", ""],
		[mac ? "⌘⇧P" : "Ctrl+Shift+P", "명령 팔레트 — 서버·탭·작업대 동작·설정을 한 칸에서 찾아 실행(초성도)"],
		[mac ? "⌘T · ⌘W" : "Ctrl+T · Ctrl+W", "내 PC 터미널 · 탭 닫기"],
		[mac ? "⌘K" : "Ctrl+K", "홈에서 연결 찾기"],
		[mac ? "⌘B" : "Ctrl+B", "사이드바 접기·펴기"],
		["작업대", ""],
		["Alt+1 · 2 · 3", "트리 · 문서 · 터미널로"],
		["Ctrl+`", "터미널 칸 숨기기·보이기"],
		["Alt+O", "파일 빠른 열기(이름으로 찾기 · /경로 바로 열기)"],
		["Ctrl+Shift+F", "파일 내용 찾기(grep — 결과를 누르면 그 줄로)"],
		["Ctrl+Alt+L", `배치 잠그기·풀기 — 지금 ${locked ? "잠김(칸 끌기·나누기·크기 바꾸기·구조 칸 닫기 막음)" : "풀림"}`],
		["F1", "이 도움말"],
		["파일 트리", ""],
		["↑ ↓ ← → · Enter", "옮기기 · 접고 펴기 · 열기"],
		["F2 · Del", "이름 바꾸기 · 지우기"],
		["Alt+← · Alt+→ · Backspace", "뒤로 · 앞으로 · 위 폴더(마우스 옆 단추도)"],
		["편집기", ""],
		["Ctrl+S", "저장"],
		["Ctrl+F · Ctrl+G", "찾기·바꾸기 · 줄로 가기"],
		["Ctrl+/ · Ctrl+D", "주석 · 같은 낱말 더 고르기"],
		["Alt+누르기 · Alt+끌기", "커서 더하기 · 사각 선택"],
		["Ctrl+Space", "자동완성 열기"],
		["터미널", ""],
		["Tab · Shift+Tab · Enter · Esc", "자동완성 목록 다음 · 이전 · 넣기 · 닫기"],
		["→", "흐린 제안 받기"],
		["Ctrl+↑ · Ctrl+↓", "이전 · 다음 명령으로"],
		["Ctrl+Shift+C · V · F", "복사 · 붙여넣기 · 찾기"],
		["Ctrl+누르기", "출력의 경로를 편집기로 열기"],
		["Ctrl+= · − · 0", "글자 크기"],
		["Alt+P", "스니펫·명령어 사전"],
	];
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
