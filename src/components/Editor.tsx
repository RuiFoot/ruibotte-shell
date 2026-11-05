import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, type LanguageSupport, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { Braces, Eye, Save, Table2 } from "lucide-react";
import { api } from "../lib/ipc";
import { altView, BinaryPreview, MarkdownView, TableView } from "./Preview";
import { useCallback, useEffect, useRef, useState } from "react";
import { asSshError, type FileText, type FsBackend } from "../lib/ipc";

const ENCODINGS = ["UTF-8", "EUC-KR", "UTF-16LE", "UTF-16BE", "Shift_JIS", "windows-1252"];

/** 언어 — 이름·확장자로 고르고, 필요한 것만 그때 받는다 */
async function languageFor(path: string): Promise<LanguageSupport | StreamLanguage<unknown> | null> {
	const name = path.split("/").pop()?.toLowerCase() ?? "";
	const ext = name.includes(".") ? name.split(".").pop() : "";
	const legacy = async (m: Promise<Record<string, unknown>>, key: string) =>
		StreamLanguage.define((await m)[key] as Parameters<typeof StreamLanguage.define>[0]);
	switch (ext) {
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
		case "ts":
		case "tsx":
			return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "tsx", typescript: true });
		case "json":
			return (await import("@codemirror/lang-json")).json();
		case "md":
		case "markdown":
			return (await import("@codemirror/lang-markdown")).markdown();
		case "xml":
		case "xsd":
		case "pom":
			return (await import("@codemirror/lang-xml")).xml();
		case "html":
		case "htm":
		case "jsp":
			return (await import("@codemirror/lang-html")).html();
		case "css":
			return (await import("@codemirror/lang-css")).css();
		case "yml":
		case "yaml":
			return (await import("@codemirror/lang-yaml")).yaml();
		case "py":
			return (await import("@codemirror/lang-python")).python();
		case "sql":
			return (await import("@codemirror/lang-sql")).sql();
		case "sh":
		case "bash":
		case "zsh":
			return legacy(import("@codemirror/legacy-modes/mode/shell"), "shell");
		case "properties":
		case "conf":
		case "cfg":
		case "ini":
		case "env":
			return legacy(import("@codemirror/legacy-modes/mode/properties"), "properties");
		case "toml":
			return legacy(import("@codemirror/legacy-modes/mode/toml"), "toml");
	}
	if (name === "dockerfile") return legacy(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile");
	if (name.startsWith(".bash") || name === ".profile") return legacy(import("@codemirror/legacy-modes/mode/shell"), "shell");
	if (name === "nginx.conf") return legacy(import("@codemirror/legacy-modes/mode/nginx"), "nginx");
	return null;
}

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

type Status = { text: string; tone?: "ok" | "err" | "warn" };

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
	const [file, setFile] = useState<FileText | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>({ text: "여는 중…" });
	const [encoding, setEncoding] = useState<string | undefined>(undefined);
	const saveRef = useRef<() => void>(() => {});
	const [alt, setAlt] = useState(false);
	const [altText, setAltText] = useState("");
	const [autoSave, setAutoSave] = useState(false);
	const autoTimer = useRef<number | undefined>(undefined);
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
				setDirty(false);
				const v = view.current;
				if (v) {
					v.dispatch({
						changes: { from: 0, to: v.state.doc.length, insert: f.text?.replace(/\r\n?/g, "\n") ?? "" },
						effects: ro.current.reconfigure(EditorState.readOnly.of(f.binary || f.tooLarge || f.meta.guessed)),
					});
				}
				const ms = Math.round(performance.now() - t0);
				if (f.tooLarge) setStatus({ text: `${(f.size / 1048576).toFixed(1)} MiB — 너무 커서 편집기로 열지 않았습니다`, tone: "warn" });
				else if (f.binary) setStatus({ text: "바이너리 파일 — 편집할 수 없습니다", tone: "warn" });
				else if (f.meta.guessed) setStatus({ text: `인코딩을 확신할 수 없어 읽기 전용(${f.meta.encoding}로 추측). 오른쪽에서 인코딩을 골라 다시 여세요.`, tone: "warn" });
				else setStatus({ text: `${ms} ms에 열림` });
				void languageFor(path).then((l) => {
					if (!gone && view.current) view.current.dispatch({ effects: lang.current.reconfigure(l ?? []) });
				});
			})
			.catch((e) => !gone && setStatus({ text: asSshError(e).message, tone: "err" }));
		return () => {
			gone = true;
		};
	}, [fs, path, encoding]);

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
					syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
					keymap.of([
						{ key: "Mod-s", preventDefault: true, run: () => (saveRef.current(), true) },
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
					]),
					lang.current.of([]),
					ro.current.of(EditorState.readOnly.of(true)),
					theme,
					EditorView.updateListener.of((u) => {
						if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete") || t.isUserEvent("undo") || t.isUserEvent("redo") || t.isUserEvent("move"))) {
							setDirty(true);
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

	const save = useCallback(async () => {
		const v = view.current;
		if (!v || !file || readOnly) return;
		setStatus({ text: "저장 중…" });
		try {
			const saved = await fs.write(path, v.state.doc.toString(), file.meta, file.mtime);
			setFile({ ...file, size: saved.size, mtime: saved.mtime });
			setDirty(false);
			setStatus({ text: `저장함 · ${new Date().toLocaleTimeString()}`, tone: "ok" });
		} catch (e) {
			setStatus({ text: asSshError(e).message, tone: "err" });
		}
	}, [fs, path, file, readOnly]);
	saveRef.current = () => void save();

	// 자동 저장 — 고친 뒤 1.5초 멈추면(읽기 전용·충돌이면 하지 않음)
	useEffect(() => {
		window.clearTimeout(autoTimer.current);
		if (autoSave && dirty && !readOnly) autoTimer.current = window.setTimeout(() => saveRef.current(), 1500);
		return () => window.clearTimeout(autoTimer.current);
	}, [autoSave, dirty, readOnly]);

	const tidy = () => {
		const v = view.current;
		if (!v) return;
		const src = v.state.doc.toString();
		let out: string | null = null;
		try {
			if (/\.json$/i.test(path)) out = JSON.stringify(JSON.parse(src), null, 2);
			else if (/\.(xml|xsd|pom|svg|xhtml)$/i.test(path)) {
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

	if (file?.binary) return <BinaryPreview fs={fs} path={path} kind="hex" />;

	return (
		<>
			<div className="cm-host" ref={host} hidden={alt} />
			{alt && altKind === "markdown" && <MarkdownView text={altText} />}
			{alt && (altKind === "csv" || altKind === "tsv") && <TableView text={altText} sep={altKind === "csv" ? "," : "\t"} />}
			<div className="statusbar">
				<span className={status.tone === "ok" ? "ok" : status.tone === "err" ? "err" : status.tone === "warn" ? "warn" : undefined}>
					{status.text}
				</span>
				<span style={{ marginLeft: "auto" }} />
				{file && !file.binary && !file.tooLarge && (
					<>
						<select
							className="status-select"
							value={file.meta.encoding}
							onChange={(e) => setEncoding(e.target.value)}
							title="다른 인코딩으로 다시 열기"
						>
							{[...new Set([file.meta.encoding, ...ENCODINGS])].map((x) => (
								<option key={x}>{x}</option>
							))}
						</select>
						<span>
							{file.meta.eol}
							{file.meta.bom ? " · BOM" : ""}
						</span>
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
						{/\.(json|xml|xsd|pom|svg|xhtml)$/i.test(path) && !readOnly && (
							<button type="button" className="btn ghost" style={{ height: 20 }} onClick={tidy} title="들여쓰기 정리">
								<Braces size={12} /> 정리
							</button>
						)}
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={!dirty || readOnly} onClick={() => void save()} title="저장 (Ctrl+S)">
							<Save size={12} /> 저장
						</button>
					</>
				)}
			</div>
		</>
	);
}
