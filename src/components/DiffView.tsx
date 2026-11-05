import { Change, diff, goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { codeHighlight } from "../lib/cmTheme";
import { asSshError, type FileText, type FsBackend } from "../lib/ipc";

export type DiffSide = { fs: FsBackend; path: string; label: string };

const theme = EditorView.theme({
	"&": { fontSize: "12.5px", backgroundColor: "var(--surface)", color: "var(--text)" },
	".cm-scroller": { fontFamily: "var(--font-mono)" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" },
});

/**
 * 앞뒤 공백을 무시한 줄 단위 비교 — 줄마다 다듬은 글을 한 글자 부호로 바꿔 비교하고, 결과를 원래 글의 자리로 되돌린다.
 * MergeView 의 diffConfig.override 로 쓴다.
 */
export function trimmedLineDiff(a: string, b: string): readonly Change[] {
	const codes = new Map<string, string>();
	const starts = (t: string) => {
		const out = [0];
		for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) out.push(i + 1);
		return out;
	};
	const sa = starts(a);
	const sb = starts(b);
	const encode = (t: string, s: number[]) => {
		let out = "";
		for (let i = 0; i < s.length; i++) {
			const line = t.slice(s[i], (s[i + 1] ?? t.length + 1) - 1).trim();
			let c = codes.get(line);
			if (c === undefined) {
				if (codes.size > 0xd7ff - 0x100) return null;
				c = String.fromCharCode(0x100 + codes.size);
				codes.set(line, c);
			}
			out += c;
		}
		return out;
	};
	const ea = encode(a, sa);
	const eb = encode(b, sb);
	if (ea === null || eb === null) return diff(a, b);
	const at = (s: number[], t: string, line: number) => (line < s.length ? s[line] : t.length);
	return diff(ea, eb).map((c) => new Change(at(sa, a, c.fromA), at(sa, a, c.toA), at(sb, b, c.fromB), at(sb, b, c.toB)));
}

/** 앞·다음 바뀐 곳으로 — 마지막으로 누른 쪽 편집기에서 */
export function navChunk(view: EditorView | null | undefined, dir: "next" | "previous") {
	if (!view) return;
	(dir === "next" ? goToNextChunk : goToPreviousChunk)({ state: view.state, dispatch: view.dispatch });
	view.focus();
}

/**
 * 덩어리 옮기기 — 커서가 있는 바뀐 덩어리(또는 전체)를 반대쪽에 넣는다.
 * toRight: 왼쪽(a) 것을 오른쪽(b)에, 아니면 오른쪽 것을 왼쪽에. 커서는 마지막으로 누른 쪽 기준.
 */
export function applyChunk(mv: MergeView, cursorSide: "a" | "b", toRight: boolean, all: boolean): boolean {
	const src = toRight ? mv.a : mv.b;
	const dst = toRight ? mv.b : mv.a;
	if (all) {
		dst.dispatch({ changes: { from: 0, to: dst.state.doc.length, insert: src.state.doc.toString() }, userEvent: "input" });
		return true;
	}
	const ed = cursorSide === "a" ? mv.a : mv.b;
	const pos = ed.state.selection.main.head;
	const c = mv.chunks.find((x) => (cursorSide === "a" ? pos >= x.fromA && pos <= x.endA : pos >= x.fromB && pos <= x.endB));
	if (!c) return false;
	const sLen = src.state.doc.length;
	const dLen = dst.state.doc.length;
	const [sf, st] = toRight ? [c.fromA, c.toA] : [c.fromB, c.toB];
	let [df, dt] = toRight ? [c.fromB, c.toB] : [c.fromA, c.toA];
	let insert = src.state.sliceDoc(Math.min(sf, sLen), Math.min(st, sLen));
	if (sf > sLen && df <= dLen) {
		// 이쪽은 끝에 없는 줄 — 저쪽의 앞 줄바꿈까지 지운다
		df = Math.max(0, df - 1);
	}
	if (df > dLen) {
		// 저쪽 끝에 줄을 붙인다 — 앞에 줄바꿈
		insert = `\n${insert.replace(/\n$/, "")}`;
		df = dLen;
		dt = dLen;
	}
	dst.dispatch({ changes: { from: df, to: Math.min(dt, dLen), insert }, userEvent: "input" });
	return true;
}

/** 비교 머리줄의 차이 이동·공백 무시·덩어리/전체 옮기기 단추 — 단추를 눌러도 편집기 초점을 빼앗지 않는다 */
export function DiffTools({
	ignoreWs,
	onIgnoreWs,
	onNav,
	onApply,
}: {
	ignoreWs: boolean;
	onIgnoreWs: (v: boolean) => void;
	onNav: (dir: "next" | "previous") => void;
	onApply?: (toRight: boolean, all: boolean) => void;
}) {
	return (
		<span
			className="diff-tools"
			onMouseDown={(e) => {
				if ((e.target as HTMLElement).closest("button")) e.preventDefault();
			}}
		>
			<button type="button" className="btn ghost icon" title="이전 차이" onClick={() => onNav("previous")}>
				<ChevronUp size={13} />
			</button>
			<button type="button" className="btn ghost icon" title="다음 차이" onClick={() => onNav("next")}>
				<ChevronDown size={13} />
			</button>
			<label className="check" style={{ margin: 0 }} title="줄 앞뒤의 공백·탭 차이는 같은 것으로 본다">
				<input type="checkbox" checked={ignoreWs} onChange={(e) => onIgnoreWs(e.target.checked)} /> 앞뒤 공백 무시
			</label>
			{onApply && (
				<>
					<span className="sep" />
					<button type="button" className="btn ghost" title="커서가 있는 덩어리를 오른쪽에 반영" onClick={() => onApply(true, false)}>
						덩어리 <ArrowRight size={12} />
					</button>
					<button type="button" className="btn ghost" title="커서가 있는 덩어리를 왼쪽으로 가져오기" onClick={() => onApply(false, false)}>
						<ArrowLeft size={12} /> 덩어리
					</button>
					<button type="button" className="btn ghost" title="왼쪽 전체를 오른쪽에 — 저장은 따로" onClick={() => onApply(true, true)}>
						전체 <ArrowRight size={12} />
					</button>
					<button type="button" className="btn ghost" title="오른쪽 전체를 왼쪽으로 — 저장은 따로" onClick={() => onApply(false, true)}>
						<ArrowLeft size={12} /> 전체
					</button>
				</>
			)}
		</span>
	);
}

/** MergeView 의 두 편집기 중 마지막으로 누른 쪽 */
export function trackSide(mv: MergeView, set: (s: "a" | "b") => void) {
	const fa = () => set("a");
	const fb = () => set("b");
	mv.a.dom.addEventListener("focusin", fa);
	mv.b.dom.addEventListener("focusin", fb);
	return () => {
		mv.a.dom.removeEventListener("focusin", fa);
		mv.b.dom.removeEventListener("focusin", fb);
	};
}

export const wsConfig = (ignore: boolean) => (ignore ? { override: trimmedLineDiff } : { scanLimit: 500 });

/**
 * 좌우 비교 — 바뀐 덩어리를 강조하고, 가운데 단추·머리줄 단추로 덩어리를 한쪽으로 옮긴다.
 * 양쪽 다 고칠 수 있고 각각 원래 인코딩·줄 끝으로 저장한다(연 뒤 바뀌었으면 거절).
 */
export function DiffView({ a, b }: { a: DiffSide; b: DiffSide }) {
	const host = useRef<HTMLDivElement>(null);
	const mv = useRef<MergeView | null>(null);
	const files = useRef<[FileText | null, FileText | null]>([null, null]);
	const side = useRef<"a" | "b">("a");
	const [status, setStatus] = useState("읽는 중…");
	const [count, setCount] = useState<number | null>(null);
	const [ignoreWs, setIgnoreWs] = useState(false);
	const [dirty, setDirty] = useState<[boolean, boolean]>([false, false]);

	useEffect(() => {
		let gone = false;
		let untrack: (() => void) | undefined;
		Promise.all([a.fs.read(a.path), b.fs.read(b.path)])
			.then(([fa, fb]) => {
				if (gone || !host.current) return;
				if (fa.binary || fb.binary || fa.tooLarge || fb.tooLarge) {
					setStatus("바이너리이거나 너무 커서 비교할 수 없습니다");
					return;
				}
				files.current = [fa, fb];
				const recount = () => requestAnimationFrame(() => mv.current && setCount(mv.current.chunks.length));
				const ext = (i: 0 | 1) => [
					lineNumbers(),
					codeHighlight,
					theme,
					EditorView.updateListener.of((u) => {
						if (!u.docChanged) return;
						setDirty((d) => (i === 0 ? [true, d[1]] : [d[0], true]));
						recount();
					}),
				];
				mv.current = new MergeView({
					parent: host.current,
					a: { doc: (fa.text ?? "").replace(/\r\n?/g, "\n"), extensions: ext(0) },
					b: { doc: (fb.text ?? "").replace(/\r\n?/g, "\n"), extensions: ext(1) },
					revertControls: "a-to-b",
					highlightChanges: true,
					gutter: true,
					collapseUnchanged: { margin: 3, minSize: 6 },
				});
				untrack = trackSide(mv.current, (s) => {
					side.current = s;
				});
				setCount(mv.current.chunks.length);
				setStatus("");
			})
			.catch((e) => setStatus(asSshError(e).message));
		return () => {
			gone = true;
			untrack?.();
			mv.current?.destroy();
			mv.current = null;
		};
	}, [a, b]);

	useEffect(() => {
		const v = mv.current;
		if (!v) return;
		v.reconfigure({ diffConfig: wsConfig(ignoreWs) });
		requestAnimationFrame(() => mv.current && setCount(mv.current.chunks.length));
	}, [ignoreWs]);

	async function save(i: 0 | 1) {
		const v = mv.current;
		const f = files.current[i];
		if (!v || !f) return;
		const s = i === 0 ? a : b;
		try {
			const r = await s.fs.write(s.path, (i === 0 ? v.a : v.b).state.doc.toString(), f.meta, f.mtime);
			files.current[i] = { ...f, mtime: r.mtime, size: r.size };
			setDirty((d) => (i === 0 ? [false, d[1]] : [d[0], false]));
			setStatus(`${s.label} 저장함`);
		} catch (e) {
			setStatus(asSshError(e).message);
		}
	}

	const apply = (toRight: boolean, all: boolean) => {
		const v = mv.current;
		if (!v) return;
		if (!applyChunk(v, side.current, toRight, all)) setStatus("커서를 바뀐 덩어리 안에 두고 누르세요");
		else setStatus(`${toRight ? "오른쪽" : "왼쪽"}에 넣었습니다 — 저장은 따로`);
	};

	return (
		<div className="panel-fill">
			<div className="wb-bar">
				<span className="diff-label" title={a.path}>
					{dirty[0] ? "● " : ""}
					{a.label}
				</span>
				<button type="button" className="btn ghost" disabled={!dirty[0]} onClick={() => void save(0)}>
					<Save size={13} /> 왼쪽 저장
				</button>
				<span style={{ flex: 1 }} />
				<DiffTools ignoreWs={ignoreWs} onIgnoreWs={setIgnoreWs} onNav={(d) => navChunk(side.current === "a" ? mv.current?.a : mv.current?.b, d)} onApply={apply} />
				<span style={{ flex: 1 }} />
				<span className="diff-label" title={b.path}>
					{dirty[1] ? "● " : ""}
					{b.label}
				</span>
				<button type="button" className="btn ghost" disabled={!dirty[1]} onClick={() => void save(1)}>
					<Save size={13} /> 오른쪽 저장
				</button>
			</div>
			<div className="diff-host" ref={host} />
			<div className="statusbar">
				<span>{count === null ? status : count ? `바뀐 곳 ${count}군데` : "두 파일이 같습니다"}</span>
				{count !== null && status && <span>{status}</span>}
				<span style={{ marginLeft: "auto" }}>가운데 ⇨ 단추나 위 "덩어리" 단추로 옮긴 뒤 저장하세요</span>
			</div>
		</div>
	);
}
