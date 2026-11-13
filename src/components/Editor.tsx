import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll, toggleComment } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Annotation, ChangeSet, Compartment, EditorState, Text } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightWhitespace, keymap, lineNumbers } from "@codemirror/view";
import { jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { showMinimap } from "@replit/codemirror-minimap";
import { Braces, Eye, GitCompare, Map as MapIcon, Save, Table2, Radio } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { editingExtensions } from "../lib/cmEditing";
import { codeHighlight } from "../lib/cmTheme";
import { AUTO_SAVE_DEFAULT, type AutoSave, autoSaveWhenLabel, loadAutoSave, onAutoSave, setAutoSave as storeAutoSave } from "../lib/autoSave";
import { onDraftFlush } from "../lib/dirty";
import { api, asSshError, type FileText, type FsBackend, type TextMeta } from "../lib/ipc";
import { detectLang, LANGS, loadLang } from "../lib/languages";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { jsonPathAt } from "../lib/jsonPath";
import { DiffTools, navChunk, trackSide, wsConfig } from "./DiffView";
import { altView, BinaryPreview, MarkdownView, TableView } from "./Preview";
import { Select } from "./Select";
import { onSettingLive, setSettingLive } from "../lib/settingsBus";

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

/** retry: 저장에 실패해 본문·초안은 그대로 두었다 — "다시 저장"(force: 쓰고 난 뒤 크기가 달라 서버 파일이 이미 바뀌었을 때) */
type Status = { text: string; tone?: "ok" | "err" | "warn"; conflict?: boolean; retry?: "plain" | "force" };

/** 파일을 불러와 문서를 채운 트랜잭션 — 고침으로 치지 않는다 */
const LOADED = Annotation.define<boolean>();

const MINIMAP_EVENT = "rb-minimap";
/** 미니맵 — 글자 대신 덩어리로 그려 가볍게, 보이는 곳 표시는 늘 */
const MINIMAP = {
	create: () => ({ dom: document.createElement("div") }),
	displayText: "blocks" as const,
	showOverlay: "always" as const,
};
/** 미니맵 켜고 끄기 — 열린 편집기 모두에 */
function setMinimapPref(on: boolean) {
	setSettingLive("editor.minimap", on ? "1" : "0");
	window.dispatchEvent(new CustomEvent<boolean>(MINIMAP_EVENT, { detail: on }));
}

const normalize = (t: string) => t.replace(/\r\n?/g, "\n");

/** 바뀐 줄 수(대략) — 연 때(base) 에서 지금(doc) 까지 쌓은 변경(ChangeSet)이 걸친 줄을 센다. 전체 문자열 비교 없이 변경 덩어리 수만큼만 든다 */
function changedLines(base: Text, doc: Text, ch: ChangeSet | null): number {
	if (!ch || ch.empty) return 0;
	let n = 0;
	ch.iterChangedRanges((fromA, toA, fromB, toB) => {
		const a = base.lineAt(toA).number - base.lineAt(fromA).number + 1;
		const b = doc.lineAt(toB).number - doc.lineAt(fromB).number + 1;
		n += Math.max(1, a, b);
	});
	return n;
}

/** 같은 글인지 — 길이가 다르면 바로 아니고, 같을 때만 줄 단위로 비교 */
const sameDoc = (a: Text, b: Text) => a === b || (a.length === b.length && a.eq(b));

/** 초안을 쓰는 주기 — 문서가 클수록 느리게(멈출 때마다 전체 문자열을 만들고 DB 에 쓰므로) */
const draftDelay = (len: number) => (len > 1_000_000 ? 3000 : len > 200_000 ? 1500 : 800);

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
	onTail,
	line,
}: {
	fs: FsBackend;
	path: string;
	active: boolean;
	onDirtyChange: (dirty: boolean) => void;
	/** 이 줄로 가서 열기(내용 찾기 결과) — 값이 { n, seq } 로 바뀔 때마다 다시 간다 */
	line?: { n: number; seq: number };
	/** 실시간 보기(tail -F) 칸 열기 */
	onTail?: () => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const lineRef = useRef(line);
	lineRef.current = line;
	const loadedRef = useRef(false);
	const goLine = useCallback(() => {
		const v = view.current;
		const want = lineRef.current?.n;
		if (!v || !want || !loadedRef.current) return;
		const ln = v.state.doc.line(Math.min(Math.max(1, want), v.state.doc.lines));
		v.dispatch({ selection: { anchor: ln.from, head: ln.to }, effects: EditorView.scrollIntoView(ln.from, { y: "center" }) });
		v.focus();
	}, []);
	const lang = useRef(new Compartment());
	const ro = useRef(new Compartment());
	const ws = useRef(new Compartment());
	const mini = useRef(new Compartment());
	const lint = useRef(new Compartment());
	const [minimap, setMinimap] = useState(true);
	const [file, setFile] = useState<FileText | null>(null);
	/** 저장할 때 쓸 형식(인코딩·줄 끝·BOM) — 바꾸면 고친 것으로 친다 */
	const [saveMeta, setSaveMeta] = useState<TextMeta | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<Status>({ text: "여는 중…" });
	const [encoding, setEncoding] = useState<string | undefined>(undefined);
	const saveRef = useRef<(force?: boolean, quiet?: boolean) => void>(() => {});
	const [alt, setAlt] = useState(false);
	const [altText, setAltText] = useState("");
	const [auto, setAuto] = useState<AutoSave>(AUTO_SAVE_DEFAULT);
	const [autoState, setAutoState] = useState<{ s: "saving" | "saved" | "failed"; at?: string; msg?: string } | null>(null);
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
	/** 연 때(또는 마지막으로 저장한 때)의 문서와 그 뒤 쌓은 변경 — 초안 주기마다 전체를 비교하지 않으려고 */
	const origDoc = useRef<Text>(Text.empty);
	const accum = useRef<ChangeSet | null>(null);
	/** 저장을 시작한 뒤 쌓은 변경(저장하는 사이 더 고친 것) */
	const sinceSave = useRef<ChangeSet | null>(null);
	const lastDraftDoc = useRef<Text | null>(null);
	/** 파일을 (다시) 읽은 횟수 — 저장하는 사이 다시 읽었으면 저장 완료가 기준 문서를 되돌리지 않게 */
	const loadGen = useRef(0);
	// sudo 를 켜고 끄면 fs 가 바뀐다(이름에 "(sudo)") — 초안 열쇠와 다시 읽기는 그와 상관없이 같은 파일로 본다
	const draftKey = `draft.${fs.side}:${fs.label.replace(/ \(sudo[^)]*\)$/, "")}:${path}`;
	const fsRef = useRef(fs);
	fsRef.current = fs; // 저장·비교는 지금 fs(sudo 를 켠 뒤 저장하면 root 로)
	const readFailed = useRef(false);
	// 이미 연 파일은 sudo 를 켜고 꺼도 다시 읽지 않는다(고친 내용이 덮이고 사라졌다). 권한이 없어 못 열었던 파일만 새 권한으로 다시 읽는다
	const fsKey = `${fs.side}:${fs.conn ?? ""}${readFailed.current ? `:${fs.label}` : ""}`;
	const draftTimer = useRef<number | undefined>(undefined);
	const altKind = altView(path);
	useEffect(() => {
		void loadAutoSave().then(setAuto);
		return onAutoSave(setAuto);
	}, []);

	const readOnly = !file || file.binary || file.tooLarge || file.meta.guessed;

	// 이미 열려 있을 때 줄 요청이 바뀌면 그 줄로
	// biome-ignore lint/correctness/useExhaustiveDependencies: line.seq 가 바뀔 때만
	useEffect(() => goLine(), [line?.seq, goLine]);

	// 파일 읽기(인코딩을 바꾸면 다시)
	useEffect(() => {
		let gone = false;
		const t0 = performance.now();
		fsRef.current
			.read(path, encoding)
			.then((f) => {
				readFailed.current = false;
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
						annotations: LOADED.of(true),
						effects: ro.current.reconfigure(EditorState.readOnly.of(f.binary || f.tooLarge || f.meta.guessed)),
					});
					loadedRef.current = true;
					origDoc.current = v.state.doc;
					loadGen.current++;
					accum.current = null;
					sinceSave.current = null;
					lastDraftDoc.current = null;
					goLine();
				}
				const ms = Math.round(performance.now() - t0);
				if (f.tooLarge)
					setStatus({
						text: `${(f.size / 1048576).toFixed(1)} MiB 라 앞부분(${(text.length / 1048576).toFixed(1)} MiB)만 읽기 전용으로 열었습니다 — 끝부분은 "실시간"으로 보세요`,
						tone: "warn",
					});
				else if (f.binary) setStatus({ text: "바이너리 파일 — 편집할 수 없습니다", tone: "warn" });
				else if (f.meta.guessed) setStatus({ text: `인코딩을 확신할 수 없어 읽기 전용(${f.meta.encoding}로 추측). 오른쪽에서 인코딩을 골라 다시 여세요.`, tone: "warn" });
				else setStatus({ text: ms > 1500 ? `${(ms / 1000).toFixed(1)}초 걸려 열었습니다` : "" }); // 빨리 열리면 상태 줄을 비워 둔다(잡음)
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
			.catch((e) => {
				if (gone) return;
				readFailed.current = true;
				setStatus({ text: asSshError(e).message, tone: "err" });
			});
		return () => {
			gone = true;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: fs 는 fsKey 로 본다(sudo 전환만으로 다시 읽지 않게)
	}, [fsKey, path, encoding, draftKey]);

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
					mini.current.of([]),
					lint.current.of([]),
					theme,
					EditorView.updateListener.of((u) => {
						// 파일을 불러와 채운 것만 빼고 모든 변경이 고침이다(주석 켜기·들여쓰기처럼 userEvent 가 없는 명령도)
						if (u.docChanged) docRef.current = u.state.doc;
						if (u.docChanged && !u.transactions.some((t) => t.annotation(LOADED))) {
							accum.current = accum.current ? accum.current.compose(u.changes) : u.changes;
							if (saving.current) sinceSave.current = sinceSave.current ? sinceSave.current.compose(u.changes) : u.changes;
							scheduleDraft.current();
							setDirty(true);
							// 자동 저장이 실패해 멈춰 있었으면 사람이 다시 고친 지금부터 다시 시도한다
							setAutoState((a) => (a?.s === "failed" ? null : a));
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

	useEffect(() => {
		void api.settingGet("editor.minimap").then((v) => setMinimap(v !== "0"));
		const on = (e: Event) => setMinimap((e as CustomEvent<boolean>).detail);
		window.addEventListener(MINIMAP_EVENT, on);
		// 설정 › 편집기 에서 바꿔도
		const off = onSettingLive(["editor.minimap"], (_, v) => setMinimap(v !== "0"));
		return () => {
			window.removeEventListener(MINIMAP_EVENT, on);
			off();
		};
	}, []);
	// 미니맵(오른쪽 개요 막대 — Orbit Monaco 와 같이 기본 켬). 아주 긴 파일(5만 줄 넘음)은 그리는 값이 커서 뺀다
	const loadedLen = file?.text?.length ?? 0;
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		const on = minimap && !alt && loadedLen > 0 && v.state.doc.lines <= 50_000;
		v.dispatch({ effects: mini.current.reconfigure(on ? showMinimap.of(MINIMAP) : []) });
	}, [minimap, alt, loadedLen]);
	// JSON 은 문법 오류에 밑줄·줄 표시(올리면 이유)
	useEffect(() => {
		const v = view.current;
		if (!v) return;
		const json = langId === "json" || /\.json$/i.test(path);
		v.dispatch({ effects: lint.current.reconfigure(json ? [linter(jsonParseLinter(), { delay: 400 }), lintGutter()] : []) });
	}, [langId, path]);

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
	// 탭·앱을 닫기 전에(묻는 창이 타이머를 막는다) 그리고 칸이 사라질 때 — 마지막 입력까지 초안으로
	const docRef = useRef<Text | null>(null);
	const flushDraft = useRef(() => {});
	flushDraft.current = () => {
		// 칸이 사라질 때는 편집기가 먼저 정리되므로 마지막 문서(Text 참조)를 따로 들고 있다
		const doc = docRef.current;
		if (!doc || !dirty || readOnly) return;
		if (!sameDoc(doc, origDoc.current)) void api.settingSet(draftKey, doc.toString());
	};
	useEffect(() => {
		const off = onDraftFlush(() => flushDraft.current());
		return () => {
			flushDraft.current();
			off();
		};
	}, []);
	useEffect(() => {
		if (active) requestAnimationFrame(() => view.current?.focus());
	}, [active]);

	// 고친 동안: 바뀐 줄 수와 초안(멈추면 — 문서가 클수록 늦게). 고칠 때마다 타이머를 다시 걸고(updateListener), 렌더마다 다시 걸지 않는다
	const draftKeyRef = useRef(draftKey);
	draftKeyRef.current = draftKey;
	const scheduleDraft = useRef(() => {});
	scheduleDraft.current = () => {
		window.clearTimeout(draftTimer.current);
		const v = view.current;
		if (!v) return;
		draftTimer.current = window.setTimeout(() => {
			const cur = view.current;
			if (!cur) return;
			const doc = cur.state.doc;
			const same = sameDoc(doc, origDoc.current);
			// 초안 쓰기가 먼저 — 바뀐 줄 수 계산이 어긋나도(기준 문서가 달라진 드문 경우) 초안은 남는다
			if (doc !== lastDraftDoc.current) {
				lastDraftDoc.current = doc;
				void api.settingSet(draftKeyRef.current, same ? "" : doc.toString());
			}
			try {
				setChanged(same ? 0 : changedLines(origDoc.current, doc, accum.current));
			} catch {
				setChanged(same ? 0 : 1);
			}
			// 되돌리기로 연 때와 똑같아졌으면 고친 것이 아니다(형식만 바꾼 것은 남긴다)
			if (same && !metaChangedRef.current) setDirty(false);
		}, draftDelay(v.state.doc.length));
	};
	useEffect(() => {
		if (!dirty) {
			window.clearTimeout(draftTimer.current);
			setChanged(0);
		} else scheduleDraft.current();
	}, [dirty]);
	useEffect(() => () => window.clearTimeout(draftTimer.current), []);

	const saving = useRef(false);
	const metaChangedRef = useRef(false);
	const save = useCallback(
		async (force = false, quiet = false) => {
			const v = view.current;
			if (!v || !file || !saveMeta || readOnly || saving.current) return;
			saving.current = true;
			// 자동 저장은 조용히 — 상태 줄 글은 그대로 두고 스위치에만 "저장 중…·자동 저장됨 시각"
			if (quiet) setAutoState({ s: "saving" });
			else setStatus({ text: "저장 중…" });
			const docAt = v.state.doc;
			const text = docAt.toString();
			sinceSave.current = null;
			const gen = loadGen.current;
			try {
				// 연 때의 수정 시각·크기를 같이 넘긴다 — 서버가 그사이 바뀌었거나 쓴 뒤 크기가 다르면 거절·알림
				const saved = await fsRef.current.write(path, text, saveMeta, force ? null : file.mtime, force ? null : file.size);
				setFile({ ...file, size: saved.size, mtime: saved.mtime, meta: saveMeta });
				// 저장하는 사이 다시 읽었으면(인코딩 바꿔 열기) 기준 문서는 다시 읽은 쪽 그대로
				if (gen === loadGen.current) {
					original.current = text;
					origDoc.current = docAt;
					accum.current = sinceSave.current;
				}
				// 저장하는 사이 더 고쳤으면 고친 상태로 남긴다(다음 자동 저장이 이어서)
				const nowDoc = view.current?.state.doc ?? docAt;
				const edited = !sameDoc(nowDoc, docAt);
				setDirty(edited);
				setChanged(edited ? changedLines(docAt, nowDoc, accum.current) : 0);
				lastDraftDoc.current = nowDoc;
				void api.settingSet(draftKey, edited ? nowDoc.toString() : "");
				const at = new Date().toLocaleTimeString("ko-KR", { hour12: false });
				if (quiet) {
					setAutoState({ s: "saved", at });
					setStatus((st) => (st.tone === "err" || st.tone === "ok" ? { text: "" } : st));
				} else {
					setAutoState(null);
					setStatus({ text: `저장함 · ${at}`, tone: "ok" });
				}
			} catch (e) {
				const x = asSshError(e);
				const conflict = x.code === "CONFLICT" || /바뀌었습니다/.test(x.message);
				// 쓴 뒤 크기가 기대와 다르다 — 서버 파일이 이미 바뀌었을 수 있어 내 본문은 그대로 두고 다시 저장(덮어쓰기)을 권한다
				const sizeBad = x.code === "SIZE_MISMATCH";
				if (quiet) setAutoState({ s: "failed", msg: conflict ? "그사이 서버 파일이 바뀌어 자동 저장을 멈췄습니다 — 비교한 뒤 저장하세요" : sizeBad ? "저장한 파일의 크기가 달라 자동 저장을 멈췄습니다 — 다시 저장하세요" : x.message });
				// 본문·초안은 건드리지 않는다(저장 실패 시 지워지는 일 없음). 충돌이 아니면 "다시 저장"
				setStatus({
					text: conflict && quiet ? `자동 저장 멈춤 — ${x.message}` : sizeBad ? `저장 뒤 파일 크기가 다릅니다(${x.message}) — 내 내용은 그대로 있습니다` : x.message,
					tone: "err",
					conflict,
					retry: conflict ? undefined : sizeBad ? "force" : "plain",
				});
			} finally {
				saving.current = false;
			}
		},
		[path, file, saveMeta, readOnly, draftKey],
	);
	saveRef.current = (force?: boolean, quiet?: boolean) => void save(force, quiet);

	// 자동 저장 ① 멈추면 — 고치다 멈추고 delayMs 뒤(읽기 전용·충돌이면 하지 않음, 실패하면 다음에 고칠 때 다시)
	// biome-ignore lint/correctness/useExhaustiveDependencies: 고칠 때마다(렌더마다) 타이머를 다시 건다
	useEffect(() => {
		window.clearTimeout(autoTimer.current);
		// 실패하면 다음에 고칠 때까지 쉰다(권한 없음·끊김에서 1.5초마다 끝없이 다시 쓰지 않게)
		if (auto.on && auto.when !== "blur" && dirty && !readOnly && !status.conflict && autoState?.s !== "failed")
			autoTimer.current = window.setTimeout(() => saveRef.current(false, true), auto.delayMs);
		return () => window.clearTimeout(autoTimer.current);
	});
	// 자동 저장 ② 포커스가 떠날 때 — 이 편집기에서 다른 곳으로, 또는 앱 창이 뒤로 갈 때
	const blurSave = useRef(() => {});
	blurSave.current = () => {
		if (auto.on && auto.when !== "delay" && dirty && !readOnly && !status.conflict && autoState?.s !== "failed") saveRef.current(false, true);
	};
	useEffect(() => {
		const onWin = () => blurSave.current();
		const onVis = () => document.visibilityState === "hidden" && blurSave.current();
		window.addEventListener("blur", onWin);
		document.addEventListener("visibilitychange", onVis);
		return () => {
			window.removeEventListener("blur", onWin);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, []);


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
	const isJson = /\.(json|jsonc|json5)$/i.test(path) || langId === "json";

	const changeMeta = (patch: Partial<TextMeta>) => {
		if (!saveMeta || readOnly) return;
		setSaveMeta({ ...saveMeta, ...patch });
		setDirty(true);
	};

	const compareServer = async () => {
		try {
			const f = await fsRef.current.read(path, saveMeta?.encoding);
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
			...(saveMeta && !ro2 ? [{ label: saveMeta.bom ? "BOM 빼기(저장할 때)" : "BOM 붙이기(저장할 때)", run: () => changeMeta({ bom: !saveMeta.bom }) }] : []),
			...(isJson
				? [
						{
							label: "JSON 경로 복사",
							run: () => {
								const p = jsonPathAt(v.state.doc.toString(), v.state.selection.main.head);
								void navigator.clipboard.writeText(p).then(() => setStatus({ text: `복사했습니다 — ${p}`, tone: "ok" }));
							},
						},
					]
				: []),
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
	metaChangedRef.current = metaChanged;

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
							// 지금 고친 내용의 초안은 다시 쓴다(건너뛰기 때문에 같은 문서면 안 써진다)
							lastDraftDoc.current = null;
							if (dirty) scheduleDraft.current();
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
				onBlur={(e) => {
					// 편집기 안(찾기 칸 등)으로 옮겨 가는 것은 떠난 게 아니다
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) blurSave.current();
				}}
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
				{status.retry && (
					<button
						type="button"
						className="btn ghost"
						style={{ height: 20 }}
						title={status.retry === "force" ? "방금 쓴 파일의 크기가 달라 서버 파일이 이미 바뀌었을 수 있습니다 — 내 내용으로 다시 씁니다" : "저장에 실패했습니다 — 내 내용은 그대로입니다. 다시 시도"}
						onClick={() => saveRef.current(status.retry === "force")}
					>
						<Save size={12} /> 다시 저장
					</button>
				)}
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
				{file?.tooLarge && !file.binary && (
					<>
						<span>읽기 전용 · 앞부분만</span>
						{onTail && (
							<button type="button" className="btn ghost" style={{ height: 20 }} onClick={onTail} title="실시간 보기(tail -F) — 끝부분을 보고 새 줄을 따라간다">
								<Radio size={12} /> 실시간
							</button>
						)}
					</>
				)}
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
						{saveMeta.bom && (
							<button type="button" className="btn ghost" style={{ height: 20 }} disabled={readOnly} title="BOM 이 붙은 파일 — 눌러서 빼기(저장할 때 적용). 붙이기는 우클릭 메뉴" onClick={() => changeMeta({ bom: false })}>
								BOM
							</button>
						)}
						{metaChanged && <span className="warn">형식 바꿈 — 저장하면 적용</span>}
						{readOnly ? <span>읽기 전용</span> : null}
						<AutoSaveSwitch
							auto={auto}
							blocked={readOnly ? "읽기 전용 파일" : null}
							state={autoState}
							dirty={dirty}
							onChange={(next) => {
								storeAutoSave(next);
								setAuto(next);
								if (!next.on) setAutoState(null);
							}}
							onRetry={() => saveRef.current(false, true)}
						/>
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
						{onTail && (langId === "log" || autoLang === "log") && (
							<button type="button" className="btn ghost" style={{ height: 20 }} onClick={onTail} title="실시간 보기(tail -F) — 새 줄을 따라간다">
								<Radio size={12} /> 실시간
							</button>
						)}
						{canTidy && !readOnly && (
							<button type="button" className="btn ghost" style={{ height: 20 }} onClick={tidy} title="들여쓰기 정리">
								<Braces size={12} /> 정리
							</button>
						)}
						<button
							type="button"
							className={`btn ghost${minimap ? " on" : ""}`}
							style={{ height: 20 }}
							aria-pressed={minimap}
							title={minimap ? "미니맵 숨기기" : "미니맵 보이기"}
							onClick={() => setMinimapPref(!minimap)}
						>
							<MapIcon size={12} />
						</button>
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

/** 상태 줄 자동 저장 스위치 — 누르면 켜고 끄기, 켜져 있으면 시점(멈추면·포커스 떠날 때·둘 다)을 고른다 */
function AutoSaveSwitch({
	auto,
	blocked,
	state,
	dirty,
	onChange,
	onRetry,
}: {
	auto: AutoSave;
	blocked: string | null;
	state: { s: "saving" | "saved" | "failed"; at?: string; msg?: string } | null;
	dirty: boolean;
	onChange: (next: AutoSave) => void;
	onRetry: () => void;
}) {
	const label = !auto.on
		? "자동 저장 꺼짐"
		: blocked
			? "자동 저장 — 이 파일 제외"
			: state?.s === "saving"
				? "저장 중…"
				: state?.s === "failed"
					? "자동 저장 실패 · 다시"
					: dirty
						? "● 저장 안 됨"
						: state?.at
							? `자동 저장됨 · ${state.at}`
							: "✓ 자동 저장";
	const title = blocked
		? `자동 저장을 쓸 수 없음 — ${blocked}`
		: auto.on && state?.s === "failed"
			? `${state.msg ?? "자동 저장 실패"} — 눌러서 다시 시도`
			: `자동 저장 ${auto.on ? "켜짐" : "꺼짐"} (${autoSaveWhenLabel(auto)}) — 눌러서 ${auto.on ? "끄기" : "켜기"}. 확인 창 없이 저장하고, 그사이 서버 파일이 바뀌었으면 멈춥니다`;
	return (
		<span className="autosave">
			<button
				type="button"
				role="switch"
				aria-checked={auto.on}
				className={`btn ghost${auto.on && !blocked ? " on" : ""}${auto.on && state?.s === "failed" ? " danger" : ""}`}
				style={{ height: 20 }}
				title={title}
				onClick={() => (auto.on && state?.s === "failed" ? onRetry() : onChange({ ...auto, on: !auto.on }))}
			>
				{label}
			</button>
			{auto.on && !blocked && (
				<Select
					size="sm"
					value={auto.when}
					onChange={(v) => onChange({ ...auto, when: v as AutoSave["when"] })}
					title="자동 저장 시점"
					options={[
						{ value: "delay", label: `멈추고 ${auto.delayMs / 1000}초` },
						{ value: "blur", label: "포커스 떠날 때" },
						{ value: "both", label: "둘 다" },
					]}
				/>
			)}
		</span>
	);
}

/** 두 글 나란히 비교(읽기 전용) — 저장 전 바뀐 곳·서버와 충돌·초안 */
function DiffSheet({ title, a, b, aLabel, bLabel, onClose }: { title: string; a: string; b: string; aLabel: string; bLabel: string; onClose: () => void }) {
	const host = useRef<HTMLDivElement>(null);
	const mv = useRef<MergeView | null>(null);
	const side = useRef<"a" | "b">("b");
	const [ignoreWs, setIgnoreWs] = useState(false);
	const [count, setCount] = useState(0);
	useEffect(() => {
		if (!host.current) return;
		// 읽기 전용이지만 커서는 둘 수 있게(차이 이동)
		const ext = [lineNumbers(), codeHighlight, theme, EditorState.readOnly.of(true)];
		const m = new MergeView({ parent: host.current, a: { doc: a, extensions: ext }, b: { doc: b, extensions: ext }, highlightChanges: true, gutter: true });
		mv.current = m;
		setCount(m.chunks.length);
		const untrack = trackSide(m, (s) => {
			side.current = s;
		});
		return () => {
			untrack();
			m.destroy();
			mv.current = null;
		};
	}, [a, b]);
	useEffect(() => {
		const m = mv.current;
		if (!m) return;
		m.reconfigure({ diffConfig: wsConfig(ignoreWs) });
		requestAnimationFrame(() => mv.current && setCount(mv.current.chunks.length));
	}, [ignoreWs]);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<div className="sheet" style={{ width: "min(1100px, calc(100vw - 32px))" }}>
				<div className="sheet-title">
					<h3>{title}</h3>
					<small style={{ color: "var(--text-3)" }}>
						왼쪽 {aLabel} · 오른쪽 {bLabel} · 바뀐 곳 {count}군데
					</small>
					<span style={{ flex: 1 }} />
					<DiffTools ignoreWs={ignoreWs} onIgnoreWs={setIgnoreWs} onNav={(d) => navChunk(side.current === "a" ? mv.current?.a : mv.current?.b, d)} />
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
