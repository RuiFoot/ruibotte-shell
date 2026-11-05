import { FileText, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { FsBackend, FsEntry, TermBackend } from "../lib/ipc";
import { EditorView_ } from "./Editor";
import { FileTree } from "./FileTree";
import { TerminalView } from "./Terminal";

type Doc = { path: string; name: string; dirty: boolean };

/** 세로 분할선 — 끌어서 왼쪽 칸 너비를 바꾼다 */
function Splitter({ onDrag }: { onDrag: (dx: number) => void }) {
	const last = useRef(0);
	return (
		<div
			className="splitter"
			onPointerDown={(e) => {
				last.current = e.clientX;
				(e.target as HTMLElement).setPointerCapture(e.pointerId);
			}}
			onPointerMove={(e) => {
				if (!(e.buttons & 1)) return;
				const dx = e.clientX - last.current;
				last.current = e.clientX;
				if (dx) onDrag(dx);
			}}
		/>
	);
}

/**
 * 3칸 작업대 — 트리 · 편집기 · 터미널. 원격(SSH)과 내 PC 가 같은 화면을 쓴다.
 */
export function Workbench({
	fs,
	term,
	active,
	label,
	startPath,
	badge,
}: {
	fs: FsBackend;
	term: TermBackend;
	active: boolean;
	label: string;
	startPath?: string;
	badge?: React.ReactNode;
}) {
	const [root, setRoot] = useState(startPath || fs.home);
	const [docs, setDocs] = useState<Doc[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [treeW, setTreeW] = useState(260);
	const [termW, setTermW] = useState(0.42); // 터미널 = 남은 폭의 비율
	const body = useRef<HTMLDivElement>(null);

	const openFile = useCallback((e: FsEntry) => {
		setDocs((ds) => (ds.some((d) => d.path === e.path) ? ds : [...ds, { path: e.path, name: e.name, dirty: false }]));
		setCurrent(e.path);
	}, []);

	const closeDoc = (path: string) => {
		const d = docs.find((x) => x.path === path);
		if (d?.dirty && !confirm(`${d.name} 의 바뀐 내용을 저장하지 않고 닫을까요?`)) return;
		const next = docs.filter((x) => x.path !== path);
		setDocs(next);
		if (current === path) setCurrent(next.at(-1)?.path ?? null);
	};

	const setDirty = useMemo(() => {
		const cache = new Map<string, (dirty: boolean) => void>();
		return (path: string) => {
			let f = cache.get(path);
			if (!f) {
				f = (dirty: boolean) => setDocs((ds) => ds.map((d) => (d.path === path && d.dirty !== dirty ? { ...d, dirty } : d)));
				cache.set(path, f);
			}
			return f;
		};
	}, []);

	const total = () => body.current?.clientWidth ?? 1200;

	return (
		<div className="wb" ref={body} style={{ gridTemplateColumns: `${treeW}px 4px 1fr 4px ${Math.round(termW * 100)}%` }}>
			<FileTree fs={fs} root={root} onRoot={setRoot} onOpen={openFile} selected={current ?? undefined} />
			<Splitter onDrag={(dx) => setTreeW((w) => Math.min(520, Math.max(170, w + dx)))} />
			<div className="wb-center">
				<div className="doc-tabs">
					{docs.map((d) => (
						<button key={d.path} type="button" className="doc-tab" aria-selected={d.path === current} onClick={() => setCurrent(d.path)} title={d.path}>
							<span>{d.name}</span>
							{d.dirty ? (
								<span className="dirty" title="저장 안 됨" />
							) : (
								<span
									className="x"
									role="button"
									aria-label="닫기"
									onClick={(e) => {
										e.stopPropagation();
										closeDoc(d.path);
									}}
								>
									<X size={11} />
								</span>
							)}
						</button>
					))}
					<span style={{ flex: 1 }} />
					{badge}
				</div>
				<div className="doc-body">
					{docs.length === 0 && (
						<div className="doc-empty">
							<FileText size={28} strokeWidth={1.2} />
							<p>왼쪽 트리에서 파일을 누르면 여기서 열립니다</p>
							<small>Ctrl+S 저장 · 원래 인코딩·줄 끝을 그대로 지킵니다</small>
						</div>
					)}
					{docs.map((d) => (
						<div key={d.path} className="doc-pane" hidden={d.path !== current}>
							<EditorView_ fs={fs} path={d.path} active={active && d.path === current} onDirtyChange={setDirty(d.path)} />
						</div>
					))}
				</div>
			</div>
			<Splitter onDrag={(dx) => setTermW((r) => Math.min(0.75, Math.max(0.2, r - dx / total())))} />
			<div className="wb-term">
				<TerminalView backend={term} active={active} cwd={startPath} label={label} toolbar={false} />
			</div>
		</div>
	);
}
