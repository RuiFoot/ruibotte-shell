import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll, toggleComment } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { diff as textDiff, MergeView } from "@codemirror/merge";
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightWhitespace, keymap, lineNumbers } from "@codemirror/view";
import { Braces, Eye, GitCompare, Save, Table2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { editingExtensions } from "../lib/cmEditing";
import { codeHighlight } from "../lib/cmTheme";
import { api, asSshError, type FileText, type FsBackend, type TextMeta } from "../lib/ipc";
import { detectLang, LANGS, loadLang } from "../lib/languages";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { altView, BinaryPreview, MarkdownView, TableView } from "./Preview";
import { Select } from "./Select";

const ENCODINGS = ["UTF-8", "EUC-KR", "UTF-16LE", "UTF-16BE", "Shift_JIS", "windows-1252"];

const theme = EditorView.theme({
	"&": { height: "100%", fontSize: "13px", backgroundColor: "var(--surface)", color: "var(--text)" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" },
	".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fill) 45%, transparent)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(10,132,255,0.25) !important" },
	".cm-cursor": { borderLeftColor: "var(--accent)" },
	".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
});

type Status = { text: string; tone?: "ok" | "err" | "warn"; conflict?: boolean };

const normalize = (t: string) => t.replace(/\r\n?/g, "\n");

/** 바뀐 줄 수(대략) — 바뀐 덩어리가 걸친 줄을 센다 */
function changedLines(a: string, b: string): number {
	if (a === b) return 0;
	let n = 0;
	for (const c of textDiff(a, b)) {
		const seg = b.slice(c.fromB, c.toB);
		const old = a.slice(c.fromA, c.toA);
		n += Math.max(1, Math.max(seg.split("\n").length, old.split("\n").length));
	}
	return n;
}

/**
 * 파일 편집기 — 원래 인코딩·줄 끝·BOM 을 지켜 저장, 열고 나서 바뀐 파일은 덮어쓰지 않음.
 * 상태 줄: 줄·칸, 언어, 인코딩(다시 열기·바꿔 저장), 줄 끝·BOM 바꾸기, 바뀐 곳.
 * 고치고 저장 안 한 내용은 초안으로 남겨 다음에 열 때 되살릴 수 있다.
 */
export function EditorView_({
	fs,
	path,
	active,
	onDirtyChange,
}: {
	fs: FsBackend;
	path: string;
	active: boolean;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const lang = useRef(new Compartment());
	const ro = useRef(new Compartment());
	const ws = useRef(new Compartment());
	const [file, setFile] = useState<FileText | null>(null);
	/** 저장할 때 쓸 형식(인코딩·줄 끝·BOM) — 바꾸면 고친 것으로 친다 */
	const [saveMeta, setSaveMeta] = useState<TextMeta | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>({ text: "여는 중…" });
	const [encoding, setEncoding] = useState<string | undefined>(undefined);
	const saveRef = useRef<(force?: boolean) => void>(() => {});
	const [alt, setAlt] = useState(false);
	const [altText, setAltText] = useState("");
	const [autoSave, setAutoSave] = useState(false);
	const autoTimer = useRef<number | undefined>(undefined);
	const [langId, setLangId] = useState<string | null>(null);
	const [autoLang, setAutoLang] = useState<string | null>(null);
	const [pos, setPos] = useState({ line: 1, col: 1, sel: 0 });
	const [changed, setChanged] = useState(0);
	const [draft, setDraft] = useState<string | null>(null);
	const [diffOf, setDiffOf] = useState<{ title: string; a: string; b: string; aLabel: string; bLabel: string } | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [showWs, setShowWs] = useState(false);
	const original = useRef("");
	const draftKey = `draft.${fs.side}:${fs.label}:${path}`;
	const draftTimer = useRef<number | undefined>(undefined);
	const altKind = altView(path);
	useEffect(() => {
		void api.settingGet("editor.autosave").then((v) => setAutoSave(v === "1"));
	}, []);

	const readOnly = !file || file.binary || file.tooLarge || file.meta.guessed;

	// 파일 읽기(인코딩을 바꾸면 다시)
	useEffect(() => {
		let gone = false;
		const t0 = performance.now();
		fs.read(path, encoding)
			.then((f) => {
				if (gone) return;
				setFile(f);
				setSaveMeta(f.meta);
				setDirty(false);
				const text = normalize(f.text ?? "");
				original.current = text;
				const v = view.current;
				if (v) {
					v.dispatch({
						changes: { from: 0, to: v.state.doc.length, insert: text },
						effects: ro.current.reconfigure(EditorState.readOnly.of(f.binary || f.tooLarge || f.meta.guessed)),
					});
				}
				const ms = Math.round(performance.now() - t0);
				if (f.tooLarge) setStatus({ text: `${(f.size / 1048576).toFixed(1)} MiB — 너무 커서 편집기로 열지 않았습니다`, tone: "warn" });
				else if (f.binary) setStatus({ text: "바이너리 파일 — 편집할 수 없습니다", tone: "warn" });
				else if (f.meta.guessed) setStatus({ text: `인코딩을 확신할 수 없어 읽기 전용(${f.meta.encoding}로 추측). 오른쪽에서 인코딩을 골라 다시 여세요.`, tone: "warn" });
				else setStatus({ text: `${ms} ms에 열림` });
				// CSV·TSV·마크다운은 처음부터 표·미리보기로(상태 줄 단추로 편집)
				if (altView(path) && !f.tooLarge) {
					setAltText(text);
					setAlt(true);
				}
				const guess = detectLang(path, text.slice(0, text.indexOf("\n") >>> 0));
				setAutoLang(guess);
				void api.settingGet(`lang.${path.split(".").pop()}`).then((saved) => !gone && setLangId(saved || guess));
				// 저장 안 한 초안이 남아 있으면 되살릴지 묻는다
				void api.settingGet(draftKey).then((d) => {
					if (!gone && d && d !== text) setDraft(d);
				});
			})
			.catch((e) => !gone && setStatus({ text: asSshError(e).message, tone: "err" }));
		return () => {
			gone = true;
		};
	}, [fs, path, encoding, draftKey]);

	// 언어 적용(짐작 또는 상태 줄에서 고른 것)
	useEffect(() => {
		let gone = false;
		void loadLang(langId).then((l) => {
			if (!gone && view.current) view.current.dispatch({ effects: lang.current.reconfigure(l ?? []) });
		});
		return () => {
			gone = true;
		};
	}, [langId]);

	// 편집기 만들기(한 번)
	useEffect(() => {
		if (!host.current) return;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: "",
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					foldGutter(),
					history(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					search({ top: true }),
					codeHighlight,
					...editingExtensions(),
					keymap.of([
						{ key: "Mod-s", preventDefault: true, run: () => (saveRef.current(), true) },
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
					]),
					lang.current.of([]),
					ro.current.of(EditorState.readOnly.of(true)),
					ws.current.of([]),
					theme,
					EditorView.updateListener.of((u) => {
						if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete") || t.isUserEvent("undo") || t.isUserEvent("redo") || t.isUserEvent("move"))) {
							setDirty(true);
						}
						if (u.selectionSet || u.docChanged) {
							const s = u.state.selection.main;
							const line = u.state.doc.lineAt(s.head);
							setPos({ line: line.number, col: s.head - line.from + 1, sel: u.state.selection.ranges.reduce((a, r) => a + (r.to - r.from), 0) });
						}
					}),
				],
			}),
		});
		view.current = v;
		return () => {
			v.destroy();
			view.current = null;
		};
	}, []);

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
	useEffect(() => {
		if (active) requestAnimationFrame(() => view.current?.focus());
	}, [active]);

	// 고친 동안: 바뀐 줄 수와 초안(0.8초 멈추면)
	useEffect(() => {
		window.clearTimeout(draftTimer.current);
		if (!dirty) {
			setChanged(0);
			return;
		}
		draftTimer.current = window.setTimeout(() => {
			const now = view.current?.state.doc.toString() ?? "";
			setChanged(changedLines(original.current, now));
			void api.settingSet(draftKey, now === original.current ? "" : now);
		}, 800);
		return () => window.clearTimeout(draftTimer.current);
	});

	const save = useCallback(
		async (force = false) => {
			const v = view.current;
			if (!v || !file || !saveMeta || readOnly) return;
			setStatus({ text: "저장 중…" });
			const text = v.state.doc.toString();
			try {
				const saved = await fs.write(path, text, saveMeta, force ? null : file.mtime);
				setFile({ ...file, size: saved.size, mtime: saved.mtime, meta: saveMeta });
				original.current = text;
				setDirty(false);
				setChanged(0);
				void api.settingSet(draftKey, "");
				setStatus({ text: `저장함 · ${new Date().toLocaleTimeString()}`, tone: "ok" });
			} catch (e) {
				const x = asSshError(e);
				const conflict = x.code === "CONFLICT" || /바뀌었습니다/.test(x.message);
				setStatus({ text: x.message, tone: "err", conflict });
			}
		},
		[fs, path, file, saveMeta, readOnly, draftKey],
	);
	saveRef.current = (force?: boolean) => void save(force);

	// 자동 저장 — 고친 뒤 1.5초 멈추면(읽기 전용·충돌이면 하지 않음)
	useEffect(() => {
		window.clearTimeout(autoTimer.current);
		if (autoSave && dirty && !readOnly && !status.conflict) autoTimer.current = window.setTimeout(() => saveRef.current(), 1500);
		return () => window.clearTimeout(autoTimer.current);
	}, [autoSave, dirty, readOnly, status.conflict]);

	const tidy = () => {
		const v = view.current;
		if (!v) return;
		const src = v.state.doc.toString();
		let out: string | null = null;
		try {
			if (/\.json$/i.test(path) || langId === "json") out = JSON.stringify(JSON.parse(src), null, 2);
			else if (/\.(xml|xsd|pom|svg|xhtml)$/i.test(path) || langId === "xml") {
				let depth = 0;
				out = src
					.replace(/>\s*</g, ">\n<")
					.split("\n")
					.map((line) => {
						const l = line.trim();
						if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
						const s = "  ".repeat(depth) + l;
						if (/^<[^!?/][^>]*[^/]>$/.test(l) && !/<\/[^>]+>$/.test(l)) depth++;
						return s;
					})
					.join("\n");
			}
		} catch (x) {
			setStatus({ text: `정리하지 못했습니다: ${String(x)}`, tone: "err" });
			return;
		}
		if (out != null && out !== src) {
			v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: out }, userEvent: "input" });
			setDirty(true);
		}
	};
	const canTidy = /\.(json|xml|xsd|pom|svg|xhtml)$/i.test(path) || langId === "json" || langId === "xml";

	const changeMeta = (patch: Partial<TextMeta>) => {
		if (!saveMeta || readOnly) return;
		setSaveMeta({ ...saveMeta, ...patch });
		setDirty(true);
	};

	const compareServer = async () => {
		try {
			const f = await fs.read(path, saveMeta?.encoding);
			setDiffOf({ title: "서버의 지금 내용과 비교", a: normalize(f.text ?? ""), b: view.current?.state.doc.toString() ?? "", aLabel: "서버(지금)", bLabel: "내가 고친 것" });
		} catch (e) {
			setStatus({ text: asSshError(e).message, tone: "err" });
		}
	};

	const menuItems = (): MenuItem[] => {
		const v = view.current;
		if (!v) return [];
		const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
		const ro2 = readOnly;
		return [
			{
				label: "잘라내기",
				disabled: ro2 || !sel,
				run: () => {
					void navigator.clipboard.writeText(sel);
					v.dispatch(v.state.replaceSelection(""), { userEvent: "delete.cut" });
					setDirty(true);
				},
			},
			{ label: "복사", disabled: !sel, run: () => void navigator.clipboard.writeText(sel) },
			{
				label: "붙여넣기",
				disabled: ro2,
				run: () =>
					void navigator.clipboard.readText().then((t) => {
						v.dispatch(v.state.replaceSelection(t), { userEvent: "input.paste" });
						setDirty(true);
					}),
			},
			{ label: "모두 선택", run: () => selectAll(v) },
			{ sep: true },
			{ label: "주석 켜고 끄기  Ctrl+/", disabled: ro2, run: () => toggleComment(v) },
			{ label: "찾기·바꾸기  Ctrl+F", run: () => openSearchPanel(v) },
			{ label: "줄로 가기  Ctrl+G", run: () => gotoLine(v) },
			{ label: showWs ? "공백 숨기기" : "공백 보이기", run: () => toggleWs() },
			...(canTidy && !ro2 ? [{ label: "들여쓰기 정리", run: tidy }] : []),
			{ sep: true },
			{ label: "바뀐 곳 보기", disabled: !dirty, run: () => setDiffOf({ title: "저장 전 바뀐 곳", a: original.current, b: v.state.doc.toString(), aLabel: "열었을 때", bLabel: "지금" }) },
			{ label: "저장  Ctrl+S", disabled: !dirty || ro2, run: () => saveRef.current() },
		];
	};
	const toggleWs = () => {
		const next = !showWs;
		setShowWs(next);
		view.current?.dispatch({ effects: ws.current.reconfigure(next ? highlightWhitespace() : []) });
	};

	if (file?.binary) return <BinaryPreview fs={fs} path={path} kind="hex" />;

	const metaChanged = !!file && !!saveMeta && (file.meta.encoding !== saveMeta.encoding || file.meta.eol !== saveMeta.eol || file.meta.bom !== saveMeta.bom);

	return (
		<>
			{draft !== null && (
				<div className="draft-bar">
					<span>저장하지 않고 닫은 고친 내용이 있습니다.</span>
					<button
						type="button"
						className="btn primary"
						onClick={() => {
							const v = view.current;
							if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: draft }, userEvent: "input" });
							setDirty(true);
							setDraft(null);
						}}
					>
						되살리기
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => {
							setDiffOf({ title: "초안과 파일 비교", a: original.current, b: draft, aLabel: "파일", bLabel: "초안" });
						}}
					>
						비교
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => {
							void api.settingSet(draftKey, "");
							setDraft(null);
						}}
					>
						버리기
					</button>
				</div>
			)}
			<div
				className="cm-host"
				ref={host}
				hidden={alt}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenu({ x: e.clientX, y: e.clientY });
				}}
			/>
			{alt && altKind === "markdown" && <MarkdownView text={altText} />}
			{alt && (altKind === "csv" || altKind === "tsv") && <TableView text={altText} sep={altKind === "csv" ? "," : "\t"} />}
			<div className="statusbar">
				<span className={status.tone === "ok" ? "ok" : status.tone === "err" ? "err" : status.tone === "warn" ? "warn" : undefined} title={status.text}>
					{status.text}
				</span>
				{status.conflict && (
					<>
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void compareServer()}>
							<GitCompare size={12} /> 서버 것과 비교
						</button>
						<button
							type="button"
							className="btn ghost danger"
							style={{ height: 20 }}
							onClick={() => {
								if (confirm("서버에서 바뀐 내용을 내 것으로 덮어씁니다. 계속할까요?")) saveRef.current(true);
							}}
						>
							덮어쓰기
						</button>
					</>
				)}
				<span style={{ marginLeft: "auto" }} />
				{file && !file.binary && !file.tooLarge && saveMeta && (
					<>
						{dirty && changed > 0 && (
							<button
								type="button"
								className="btn ghost"
								style={{ height: 20 }}
								title="저장 전 바뀐 곳 보기"
								onClick={() => setDiffOf({ title: "저장 전 바뀐 곳", a: original.current, b: view.current?.state.doc.toString() ?? "", aLabel: "열었을 때", bLabel: "지금" })}
							>
								<GitCompare size={12} /> 바뀐 곳 {changed}줄
							</button>
						)}
						<span title="줄·칸(고른 글자 수)">
							{pos.line}:{pos.col}
							{pos.sel ? ` (${pos.sel})` : ""}
						</span>
						<Select
							size="sm"
							value={langId ?? ""}
							onChange={(v) => {
								setLangId(v || autoLang);
								void api.settingSet(`lang.${path.split(".").pop()}`, v);
							}}
							title="언어(문법 색) — 고르면 같은 확장자에 기억"
							options={[{ value: "", label: autoLang ? `자동 · ${LANGS.find((l) => l.id === autoLang)?.label ?? autoLang}` : "일반 글" }, ...LANGS.map((l) => ({ value: l.id, label: l.label }))]}
						/>
						<Select
							size="sm"
							value={saveMeta.encoding}
							onChange={(enc) => {
								if (readOnly || !dirty) {
									setEncoding(enc);
									return;
								}
								// 고친 게 있으면 다시 열지 않고 저장 형식만 바꾼다
								changeMeta({ encoding: enc });
							}}
							title="인코딩 — 고친 게 없으면 이 인코딩으로 다시 열고, 고친 게 있으면 이 인코딩으로 바꿔 저장"
							options={[...new Set([saveMeta.encoding, ...ENCODINGS])].map((x) => ({ value: x, label: x }))}
						/>
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={readOnly} title="줄 끝 바꾸기(저장할 때 적용)" onClick={() => changeMeta({ eol: saveMeta.eol === "CRLF" ? "LF" : "CRLF" })}>
							{saveMeta.eol}
						</button>
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={readOnly} title="BOM 붙이기·빼기(저장할 때 적용)" onClick={() => changeMeta({ bom: !saveMeta.bom })}>
							{saveMeta.bom ? "BOM" : "BOM 없음"}
						</button>
						{metaChanged && <span className="warn">형식 바꿈 — 저장하면 적용</span>}
						{readOnly ? <span>읽기 전용</span> : null}
						{autoSave && !readOnly ? <span title="설정 › 편집기에서 끔">자동 저장</span> : null}
						{altKind && (
							<button
								type="button"
								className={`btn ghost${alt ? " on" : ""}`}
								style={{ height: 20 }}
								onClick={() => {
									setAltText(view.current?.state.doc.toString() ?? "");
									setAlt((x) => !x);
								}}
								title={altKind === "markdown" ? "미리보기" : "표로 보기"}
							>
								{altKind === "markdown" ? <Eye size={12} /> : <Table2 size={12} />} {alt ? "편집" : altKind === "markdown" ? "미리보기" : "표"}
							</button>
						)}
						{canTidy && !readOnly && (
							<button type="button" className="btn ghost" style={{ height: 20 }} onClick={tidy} title="들여쓰기 정리">
								<Braces size={12} /> 정리
							</button>
						)}
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={!dirty || readOnly} onClick={() => saveRef.current()} title="저장 (Ctrl+S)">
							<Save size={12} /> 저장
						</button>
					</>
				)}
			</div>
			{menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
			{diffOf && <DiffSheet {...diffOf} onClose={() => setDiffOf(null)} />}
		</>
	);
}

/** 두 글 나란히 비교(읽기 전용) — 저장 전 바뀐 곳·서버와 충돌·초안 */
function DiffSheet({ title, a, b, aLabel, bLabel, onClose }: { title: string; a: string; b: string; aLabel: string; bLabel: string; onClose: () => void }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!host.current) return;
		const ext = [lineNumbers(), codeHighlight, theme, EditorState.readOnly.of(true), EditorView.editable.of(false)];
		const mv = new MergeView({ parent: host.current, a: { doc: a, extensions: ext }, b: { doc: b, extensions: ext }, highlightChanges: true, gutter: true });
		return () => mv.destroy();
	}, [a, b]);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<div className="sheet" style={{ width: "min(1100px, calc(100vw - 32px))" }}>
				<div className="sheet-title">
					<h3>{title}</h3>
					<small style={{ color: "var(--text-3)" }}>
						왼쪽 {aLabel} · 오른쪽 {bLabel}
					</small>
				</div>
				<div className="diff-sheet" ref={host} />
				<div className="sheet-actions">
					<button type="button" className="btn primary" autoFocus onClick={onClose}>
						닫기
					</button>
				</div>
			</div>
		</div>
	);
}
