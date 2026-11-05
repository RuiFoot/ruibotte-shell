import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, House, Link2, RefreshCw } from "lucide-react";
import { memo, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { asSshError, type FsBackend, type FsEntry, joinPath, notifyFsChanged, parentDir } from "../lib/ipc";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const CODE = /\.(js|ts|tsx|jsx|json|py|java|go|rs|sh|sql|xml|yml|yaml|html|css|jsp|php|rb|c|h|cpp|kt)$/i;
export const DRAG_MIME = "application/x-rbshell-entry";

export type DragEntry = { side: "remote" | "local"; conn?: number; path: string; name: string; kind: FsEntry["kind"] };

function icon(e: FsEntry, open: boolean) {
	if (e.kind === "dir") return open ? <FolderOpen size={15} className="ti dir" /> : <Folder size={15} className="ti dir" />;
	if (e.kind === "link") return <Link2 size={15} className="ti" />;
	if (CODE.test(e.name)) return <FileCode size={15} className="ti" />;
	if (/\.(log|txt|md|conf|properties|ini|cfg|env)$/i.test(e.name)) return <FileText size={15} className="ti" />;
	return <File size={15} className="ti" />;
}

function fmtSize(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
	return `${(n / 1073741824).toFixed(2)} GB`;
}

type Node = { entries?: FsEntry[]; error?: string };

/**
 * 파일 트리 — 펼칠 때만 그 폴더를 읽는다(원격·내 PC 공용).
 * 우클릭 메뉴(새 폴더·새 파일·이름 바꾸기·지우기·경로 복사·주고받기), 끌어 놓기(옮기기·주고받기).
 */
export const FileTree = memo(function FileTree({
	fs,
	root,
	onRoot,
	onOpen,
	onDrop,
	onSend,
	sendLabel,
	onCd,
	onTail,
	onCompare,
	compareLabel,
	onArchive,
	onRelay,
	selected,
}: {
	fs: FsBackend;
	root: string;
	onRoot: (p: string) => void;
	onOpen: (e: FsEntry) => void;
	/** 끌어 놓기 — 다른 트리에서 오면 주고받기, 같은 트리면 옮기기 */
	onDrop?: (src: DragEntry, destDir: string) => void;
	/** 반대편으로 보내기(올리기·받기) */
	onSend?: (e: FsEntry) => void;
	sendLabel?: string;
	/** 터미널에서 이 폴더로 이동 */
	onCd?: (dir: string) => void;
	/** 실시간 보기 */
	onTail?: (e: FsEntry) => void;
	/** 비교 — 첫 번째는 고르기, 두 번째는 비교 */
	onCompare?: (e: FsEntry) => void;
	compareLabel?: (e: FsEntry) => string;
	/** 폴더째 받기(.tar.gz) */
	onArchive?: (e: FsEntry) => void;
	/** 다른 서버로 보내기(중계) */
	onRelay?: (e: FsEntry) => void;
	selected?: string;
}) {
	const [nodes, setNodes] = useState<Record<string, Node>>({});
	const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
	const [rootInput, setRootInput] = useState(root);
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const [dropOn, setDropOn] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	const openRef = useRef(open);
	openRef.current = open;

	const load = useCallback(
		(path: string) => {
			fs.list(path)
				.then((entries) => setNodes((n) => ({ ...n, [path]: { entries } })))
				.catch((e) => setNodes((n) => ({ ...n, [path]: { error: asSshError(e).message } })));
		},
		[fs],
	);

	useEffect(() => {
		setRootInput(root);
		setOpen(new Set([root]));
		setNodes({});
		load(root);
	}, [root, load]);

	// 전송·조작 뒤 그 폴더를 다시 읽는다(열려 있을 때만)
	useEffect(() => {
		const on = (ev: Event) => {
			const d = (ev as CustomEvent<{ side: string; dir: string; conn?: number }>).detail;
			if (d.side !== fs.side || (fs.side === "remote" && d.conn !== fs.conn)) return;
			if (openRef.current.has(d.dir)) load(d.dir);
		};
		window.addEventListener("rb-fs-changed", on);
		return () => window.removeEventListener("rb-fs-changed", on);
	}, [fs, load]);

	const toggle = (p: string) => {
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(p)) n.delete(p);
			else {
				n.add(p);
				load(p);
			}
			return n;
		});
	};

	const refresh = () => {
		for (const p of open) load(p);
	};

	const flash = (t: string) => {
		setMsg(t);
		window.setTimeout(() => setMsg(null), 4000);
	};

	const act = async (f: () => Promise<unknown>, dir: string) => {
		try {
			await f();
			notifyFsChanged(fs.side, dir, fs.conn);
			if (!open.has(dir)) toggle(dir);
		} catch (e) {
			flash(asSshError(e).message);
		}
	};

	const menuFor = (e: FsEntry | null, dir: string): MenuItem[] => {
		const items: MenuItem[] = [
			{
				label: "새 파일…",
				run: () => {
					const name = prompt("새 파일 이름");
					if (name) void act(() => fs.touch(joinPath(dir, name)), dir);
				},
			},
			{
				label: "새 폴더…",
				run: () => {
					const name = prompt("새 폴더 이름");
					if (name) void act(() => fs.mkdir(joinPath(dir, name)), dir);
				},
			},
		];
		if (e) {
			items.push({ sep: true });
			if (e.kind !== "dir") items.push({ label: "열기", run: () => onOpen(e) });
			if (e.kind !== "dir" && onTail) items.push({ label: "실시간 보기(tail -F)", run: () => onTail(e) });
			if (e.kind !== "dir" && onCompare) items.push({ label: compareLabel?.(e) ?? "비교 대상으로 고르기", run: () => onCompare(e) });
			if (e.kind === "dir" && onArchive) items.push({ label: "폴더째 받기(.tar.gz)…", run: () => onArchive(e) });
			if (onRelay) items.push({ label: "다른 서버로 보내기…", run: () => onRelay(e) });
			if (onSend) items.push({ label: sendLabel ?? "보내기", run: () => onSend(e) });
			if (e.kind === "dir" && onCd) items.push({ label: "터미널에서 이 폴더로", run: () => onCd(e.path) });
			if (e.kind === "dir") items.push({ label: "여기를 맨 위로", run: () => onRoot(e.path) });
			items.push(
				{ sep: true },
				{
					label: "이름 바꾸기…",
					run: () => {
						const name = prompt("새 이름", e.name);
						if (name && name !== e.name) void act(() => fs.rename(e.path, joinPath(parentDir(e.path), name)), parentDir(e.path));
					},
				},
				{ label: "경로 복사", run: () => void navigator.clipboard.writeText(e.path) },
				{ label: "이름 복사", run: () => void navigator.clipboard.writeText(e.name) },
				{ sep: true },
				{
					label: fs.side === "local" ? "휴지통으로" : "지우기…",
					danger: true,
					run: () => {
						const what = e.kind === "dir" ? `폴더 ${e.name} 와 안의 모든 것` : e.name;
						const ok = fs.side === "local" ? confirm(`${what}을(를) 휴지통으로 보낼까요?`) : prompt(`서버에서 ${what}을(를) 지웁니다. 되살릴 수 없습니다.\n지우려면 이름을 그대로 치세요: ${e.name}`) === e.name;
						if (ok) void act(() => fs.remove(e.path), parentDir(e.path));
					},
				},
			);
		} else {
			items.push({ sep: true }, { label: "새로 읽기", run: refresh }, { label: "경로 복사", run: () => void navigator.clipboard.writeText(dir) });
		}
		return items;
	};

	const dropProps = (dir: string) => ({
		onDragOver: (ev: React.DragEvent) => {
			if (!onDrop || !ev.dataTransfer.types.includes(DRAG_MIME)) return;
			ev.preventDefault();
			ev.stopPropagation();
			ev.dataTransfer.dropEffect = "copy";
			setDropOn(dir);
		},
		onDragLeave: () => setDropOn((d) => (d === dir ? null : d)),
		onDrop: (ev: React.DragEvent) => {
			const raw = ev.dataTransfer.getData(DRAG_MIME);
			setDropOn(null);
			if (!raw || !onDrop) return;
			ev.preventDefault();
			ev.stopPropagation();
			onDrop(JSON.parse(raw) as DragEntry, dir);
		},
	});

	const rows: ReactElement[] = [];
	const walk = (path: string, depth: number) => {
		const node = nodes[path];
		const pad = 12 + depth * 14;
		if (node?.error) {
			rows.push(
				<div key={`${path}#err`} className="tree-msg err" style={{ paddingLeft: pad }}>
					{node.error}
				</div>,
			);
			return;
		}
		if (!node?.entries) {
			rows.push(
				<div key={`${path}#loading`} className="tree-msg" style={{ paddingLeft: pad }}>
					읽는 중…
				</div>,
			);
			return;
		}
		if (!node.entries.length) {
			rows.push(
				<div key={`${path}#empty`} className="tree-msg" style={{ paddingLeft: pad }}>
					비어 있음
				</div>,
			);
		}
		for (const e of node.entries) {
			const isOpen = open.has(e.path);
			const dir = e.kind === "dir" ? e.path : path;
			rows.push(
				<button
					key={e.path}
					type="button"
					className="tree-row"
					data-drop={dropOn === e.path && e.kind === "dir" ? "on" : undefined}
					aria-current={selected === e.path}
					style={{ paddingLeft: 6 + depth * 14 }}
					title={`${e.path}${e.kind === "file" ? ` · ${fmtSize(e.size)}` : ""}`}
					draggable
					onDragStart={(ev) => {
						const d: DragEntry = { side: fs.side, conn: fs.conn, path: e.path, name: e.name, kind: e.kind };
						ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(d));
						ev.dataTransfer.effectAllowed = "copyMove";
					}}
					onClick={() => (e.kind === "dir" ? toggle(e.path) : onOpen(e))}
					onDoubleClick={() => e.kind === "dir" && onRoot(e.path)}
					onContextMenu={(ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						setMenu({ x: ev.clientX, y: ev.clientY, items: menuFor(e, dir) });
					}}
					{...(e.kind === "dir" ? dropProps(e.path) : {})}
				>
					<ChevronRight size={12} className="chev" style={{ visibility: e.kind === "dir" ? "visible" : "hidden", transform: isOpen ? "rotate(90deg)" : undefined }} />
					{icon(e, isOpen)}
					<span className={e.name.startsWith(".") ? "dim" : undefined}>{e.name}</span>
				</button>,
			);
			if (e.kind === "dir" && isOpen) walk(e.path, depth + 1);
		}
	};
	walk(root, 0);

	const atTop = root === "/" || /^[A-Za-z]:\/?$/.test(root);
	return (
		<div className="tree">
			<div className="tree-head">
				<form
					onSubmit={(ev) => {
						ev.preventDefault();
						onRoot(rootInput.trim() || "/");
					}}
					style={{ flex: 1, minWidth: 0 }}
				>
					<input className="path-input" value={rootInput} onChange={(e) => setRootInput(e.target.value)} spellCheck={false} title="경로를 치고 Enter" />
				</form>
				<button type="button" className="btn ghost icon" title="위 폴더" onClick={() => onRoot(parentDir(root))} disabled={atTop}>
					<ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
				</button>
				<button type="button" className="btn ghost icon" title="홈" onClick={() => onRoot(fs.home)}>
					<House size={14} />
				</button>
				<button type="button" className="btn ghost icon" title="새로 읽기" onClick={refresh}>
					<RefreshCw size={13} />
				</button>
			</div>
			<div
				className="tree-body"
				data-drop={dropOn === root ? "on" : undefined}
				onContextMenu={(ev) => {
					ev.preventDefault();
					setMenu({ x: ev.clientX, y: ev.clientY, items: menuFor(null, root) });
				}}
				{...dropProps(root)}
			>
				{rows}
			</div>
			{msg && <div className="tree-toast">{msg}</div>}
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
		</div>
	);
});
