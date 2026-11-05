import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { asSshError, type FileText, type FsBackend } from "../lib/ipc";
import { codeHighlight } from "../lib/cmTheme";

export type DiffSide = { fs: FsBackend; path: string; label: string };

const theme = EditorView.theme({
	"&": { fontSize: "12.5px", backgroundColor: "var(--surface)", color: "var(--text)" },
	".cm-scroller": { fontFamily: "var(--font-mono)" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" },
});

/**
 * 좌우 비교 — 바뀐 덩어리를 강조하고, 가운데 단추로 덩어리를 한쪽으로 옮긴다.
 * 양쪽 다 고칠 수 있고 각각 원래 인코딩·줄 끝으로 저장한다(연 뒤 바뀌었으면 거절).
 */
export function DiffView({ a, b }: { a: DiffSide; b: DiffSide }) {
	const host = useRef<HTMLDivElement>(null);
	const mv = useRef<MergeView | null>(null);
	const files = useRef<[FileText | null, FileText | null]>([null, null]);
	const [status, setStatus] = useState("읽는 중…");

	useEffect(() => {
		let gone = false;
		Promise.all([a.fs.read(a.path), b.fs.read(b.path)])
			.then(([fa, fb]) => {
				if (gone || !host.current) return;
				if (fa.binary || fb.binary || fa.tooLarge || fb.tooLarge) {
					setStatus("바이너리이거나 너무 커서 비교할 수 없습니다");
					return;
				}
				files.current = [fa, fb];
				const ext = [lineNumbers(), codeHighlight, theme];
				mv.current = new MergeView({
					parent: host.current,
					a: { doc: (fa.text ?? "").replace(/\r\n?/g, "\n"), extensions: ext },
					b: { doc: (fb.text ?? "").replace(/\r\n?/g, "\n"), extensions: ext },
					revertControls: "a-to-b",
					highlightChanges: true,
					gutter: true,
					collapseUnchanged: { margin: 3, minSize: 6 },
				});
				const n = mv.current.chunks.length;
				setStatus(n ? `바뀐 곳 ${n}군데` : "두 파일이 같습니다");
			})
			.catch((e) => setStatus(asSshError(e).message));
		return () => {
			gone = true;
			mv.current?.destroy();
			mv.current = null;
		};
	}, [a, b]);

	async function save(side: 0 | 1) {
		const v = mv.current;
		const f = files.current[side];
		if (!v || !f) return;
		const s = side === 0 ? a : b;
		try {
			const r = await s.fs.write(s.path, (side === 0 ? v.a : v.b).state.doc.toString(), f.meta, f.mtime);
			files.current[side] = { ...f, mtime: r.mtime, size: r.size };
			setStatus(`${s.label} 저장함`);
		} catch (e) {
			setStatus(asSshError(e).message);
		}
	}

	return (
		<div className="panel-fill">
			<div className="wb-bar">
				<span className="diff-label" title={a.path}>
					{a.label}
				</span>
				<button type="button" className="btn ghost" onClick={() => void save(0)}>
					<Save size={13} /> 왼쪽 저장
				</button>
				<span style={{ flex: 1 }} />
				<span className="diff-label" title={b.path}>
					{b.label}
				</span>
				<button type="button" className="btn ghost" onClick={() => void save(1)}>
					<Save size={13} /> 오른쪽 저장
				</button>
			</div>
			<div className="diff-host" ref={host} />
			<div className="statusbar">
				<span>{status}</span>
				<span style={{ marginLeft: "auto" }}>가운데 ⇨ 단추로 왼쪽 덩어리를 오른쪽에 넣습니다</span>
			</div>
		</div>
	);
}
