import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, House, Link2, RefreshCw } from "lucide-react";
import { memo, type ReactElement, useCallback, useEffect, useState } from "react";
import { asSshError, type FsBackend, type FsEntry } from "../lib/ipc";

const CODE = /\.(js|ts|tsx|jsx|json|py|java|go|rs|sh|sql|xml|yml|yaml|html|css|jsp|php|rb|c|h|cpp|kt)$/i;

function icon(e: FsEntry, open: boolean) {
	if (e.kind === "dir") return open ? <FolderOpen size={15} className="ti dir" /> : <Folder size={15} className="ti dir" />;
	if (e.kind === "link") return <Link2 size={15} className="ti" />;
	if (CODE.test(e.name)) return <FileCode size={15} className="ti" />;
	if (/\.(log|txt|md|conf|properties|ini|cfg|env)$/i.test(e.name)) return <FileText size={15} className="ti" />;
	return <File size={15} className="ti" />;
}

type Node = { entries?: FsEntry[]; error?: string; loading?: boolean };

/** 파일 트리 — 펼칠 때만 그 폴더를 읽는다(원격·내 PC 공용) */
export const FileTree = memo(function FileTree({
	fs,
	root,
	onRoot,
	onOpen,
	selected,
}: {
	fs: FsBackend;
	root: string;
	onRoot: (p: string) => void;
	onOpen: (e: FsEntry) => void;
	selected?: string;
}) {
	const [nodes, setNodes] = useState<Record<string, Node>>({});
	const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
	const [rootInput, setRootInput] = useState(root);

	const load = useCallback(
		(path: string) => {
			setNodes((n) => ({ ...n, [path]: { ...n[path], loading: true } }));
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

	const toggle = (p: string) => {
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(p)) n.delete(p);
			else {
				n.add(p);
				if (!nodes[p]?.entries) load(p);
			}
			return n;
		});
	};

	const refresh = () => {
		for (const p of open) load(p);
	};

	const rows: ReactElement[] = [];
	const walk = (path: string, depth: number) => {
		const node = nodes[path];
		if (node?.error) {
			rows.push(
				<div key={`${path}#err`} className="tree-msg err" style={{ paddingLeft: 12 + depth * 14 }}>
					{node.error}
				</div>,
			);
			return;
		}
		if (!node?.entries) {
			rows.push(
				<div key={`${path}#loading`} className="tree-msg" style={{ paddingLeft: 12 + depth * 14 }}>
					읽는 중…
				</div>,
			);
			return;
		}
		if (!node.entries.length) {
			rows.push(
				<div key={`${path}#empty`} className="tree-msg" style={{ paddingLeft: 12 + depth * 14 }}>
					비어 있음
				</div>,
			);
		}
		for (const e of node.entries) {
			const isOpen = open.has(e.path);
			rows.push(
				<button
					key={e.path}
					type="button"
					className="tree-row"
					aria-current={selected === e.path}
					style={{ paddingLeft: 6 + depth * 14 }}
					title={e.path}
					onClick={() => (e.kind === "dir" ? toggle(e.path) : onOpen(e))}
					onDoubleClick={() => e.kind === "dir" && onRoot(e.path)}
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

	const parent = root.replace(/\/[^/]+\/?$/, "") || "/";
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
				<button type="button" className="btn ghost icon" title="위 폴더" onClick={() => onRoot(parent)} disabled={root === "/" || /^[A-Za-z]:\/?$/.test(root)}>
					<ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
				</button>
				<button type="button" className="btn ghost icon" title="홈" onClick={() => onRoot(fs.home)}>
					<House size={14} />
				</button>
				<button type="button" className="btn ghost icon" title="새로 읽기" onClick={refresh}>
					<RefreshCw size={13} />
				</button>
			</div>
			<div className="tree-body">{rows}</div>
		</div>
	);
});
