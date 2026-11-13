import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { MSSQL, MySQL, PLSQL, PostgreSQL, StandardSQL, sql } from "@codemirror/lang-sql";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import "dockview-react/dist/styles/dockview.css";
import "../styles/db-extra.css";
import { ChevronRight, CircleStop, Columns3, Database, Download, Ellipsis, Eye, FileSearch, History, KeyRound, LayoutTemplate, ListTree, Lock, Play, PlayCircle, Plus, ScanSearch, Search, Square, Table, WandSparkles, Star } from "lucide-react";
import { DbActivityPanel } from "./panels/DbActivityPanel";
import { createContext, lazy, memo, type ReactElement, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ComparePanel, HistoryPanel } from "./DbPanels";
import { type ExplainOk, ExplainView } from "./DbExplain";
import { ImportCsvSheet } from "./DbImport";
import { type AskReq, AskSheet, BigEditSheet } from "./DbSheets";
import { setOpenTx } from "../lib/dbTx";
import { dirtyTitleOf, dirtyTitles, forgetOwner, onDraftFlush, setDirty } from "../lib/dirty";
import { useCommands } from "../lib/commands";
import { LayoutLockButton, useLayoutLock } from "../lib/layoutLock";

const ErdPanelLazy = lazy(() => import("./DbErd").then((m) => ({ default: m.ErdPanel })));
const QueryAnalysisLazy = lazy(() => import("./QueryAnalysis").then((m) => ({ default: m.QueryAnalysisPanel })));
import type { AnalysisTab } from "./QueryAnalysis";
import { api } from "../lib/ipc";
import { type Cell, type ColMeta, type EditStmt, buildDelete, buildInsert, buildUpdate, formatRows, previewSql, qualified } from "../lib/edits";
import {
	ddlSql,
	explainSql,
	type Fk,
	fkSql,
	indexSql,
	killSql,
	pagedSelect,
	queryRows,
	readOnlyUserSql,
	routinesSql,
	searchSql,
	sequencesSql,
	terminateSql,
	type Tool,
	toolSql,
} from "../lib/dbtools";
import { ENGINES, quoteIdentFor, selectTop } from "../lib/engines";
import { type Stmt, splitSql, statementAt } from "../lib/sql";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { CellEditor } from "./CellEditor";
import { DataGrid, type GridApi, type GridCol, type GridOverlay, groupDigits, type SelStats } from "./DataGrid";
import { saveXlsx, XLSX_MAX_ROWS } from "../lib/xlsxExport";
import { Select } from "./Select";
import { SnippetPalette } from "./SnippetPalette";
import { codeHighlight } from "../lib/cmTheme";
import { editingExtensions } from "../lib/cmEditing";
import { expandStarCommand, type SqlSource, sqlAutocompleteConfig, sqlCompletionSource } from "../lib/sqlComplete";
import { formatSqlIn } from "../lib/sqlFormat";
import { backgroundRows, dropEditor, forgetWatch, holdBackground, publishPlan, queryMapMarks, touchEditor, waitBackground } from "../lib/queryWatch";
import { onSettingLive, setSettingLive } from "../lib/settingsBus";

const theme: DockviewTheme = { name: "rbshell", className: "rbshell-dock", gap: 0, dndOverlayMounting: "relative" };

type QueryOk = {
	resultId?: number | null;
	columns: GridCol[];
	rowCount: number;
	affected?: number | null;
	truncated: boolean;
	/** 받는 중에 멈춤 — 받은 행은 결과에 남는다 */
	stopped?: "cancelled" | "timeout" | "memory" | null;
	ms: number;
	firstRowMs?: number | null;
	tx?: TxState;
};
/** 받는 중 알림(Rust db-rows-progress) — stream 은 실행마다 화면이 고른 번호 */
type RowsProgress = { stream: number; resultId: number; columns: GridCol[]; rowCount: number; ms: number; firstRowMs?: number | null };
type TxState = { inTx: boolean; stmts: number; manual: boolean };
type DbError = { code: string; message: string };
/** 표 보기 — 서버 쪽 WHERE·정렬·쪽 나누기 */
type Source = { schema: string | null; table: string; where?: string; order?: { col: string; desc: boolean } | null; offset?: number; limit?: number };
type ResultParams = { sql: string; state: "running" | "streaming" | "ok" | "error"; ok?: QueryOk; error?: DbError; at: number; source?: Source; tool?: string };

type Node = { name: string; kind: "schema" | "table" | "view" | "column"; detail?: string | null };

type Ctx = {
	conn: number;
	engine: string;
	mysql: boolean;
	readOnly: boolean;
	run: (stmts: string[], source?: Source, tool?: string) => void;
	openSql: (text: string, title?: string) => void;
	openPanel: (id: string, component: string, title: string, params: object) => void;
	historyScope: string;
	inTx: boolean;
	insertText: (s: string) => void;
	registerEditor: (id: string, v: EditorView | null) => void;
	draftKey: string;
	/** 실행 계획(커서 문장) */
	explain: () => void;
	/** 실행 중이면 멈추기 */
	cancel: () => void;
	/** 지금 실행 중인지(읽는 시점 값 — 구독하지 않는다. 구독이 필요한 칸은 LiveCtx) */
	isRunning: () => boolean;
	clearMessages: () => void;
	/** 표 보기 열기(서버 쪽 쪽 나누기·정렬) */
	openTable: (src: Source) => void;
	/** 입력 시트(window.prompt 대신) */
	ask: (req: AskReq) => Promise<string | null>;
	/** 다시 연결·데이터베이스 바꾸기마다 하나씩 — 트리·외래 키 기억을 새로 읽게 */
	epoch: number;
	/** 작업대 위 알림 줄 */
	notice: (msg: string) => void;
	/** CSV 가져오기 */
	importCsv: (schema: string | null, table: string) => void;
	/** 배치 잠금 */
	locked: boolean;
	/** 지금 데이터베이스(MySQL 한정 없는 표 이름) */
	database: string;
	/** 서버 버전 문자열(다시 연결하면 새 값) */
	version: string;
	/** 쿼리 분석 칸 열기(그 탭으로) */
	openAnalysis: (tab?: AnalysisTab) => void;
	/** 두 문장의 계획(튜닝 비교) — 실행 중 표시를 올리고, ANALYZE 는 묻는다 */
	explainPair: (a: string, b: string, analyze: boolean) => Promise<[ExplainOk, ExplainOk] | null>;
};
type Msg = { at: number; sql: string; ok: boolean; text: string; ms?: number };

/** 방금 실행한 문장 칠하기 — 글을 고치면 지운다 */
const ranEffect = StateEffect.define<{ from: number; to: number }[]>();
const ranField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		let d = tr.docChanged ? Decoration.none : deco.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(ranEffect)) d = Decoration.set(e.value.filter((r) => r.to > r.from).map((r) => Decoration.mark({ class: "cm-ran" }).range(r.from, r.to)));
		}
		return d;
	},
	provide: (f) => EditorView.decorations.from(f),
});
const DbCtx = createContext<Ctx | null>(null);
/**
 * 자주 바뀌는 값(실행 중 표시·메시지 목록) — DbCtx 에 두면 실행 메시지가 쌓일 때마다 DB 칸 전체가 다시 그려져서
 * 쓰는 칸(메시지·활동)만 따로 구독하게 뗐다.
 */
type Live = { running: boolean; messages: Msg[] };
const LiveCtx = createContext<Live>({ running: false, messages: [] });
/** db_query 받는 중 알림 번호(앱 전체에서 하나씩 늘림) */
let streamSeq = 0;
const useDb = () => useContext(DbCtx) as Ctx;

/** 이 연결의 DB 작업대가 dirty.ts 에 올리는 주인 이름 — 앱 끄기·탭 닫기 확인이 이 이름으로 묻는다 */
const dbOwner = (conn: number) => `db:${conn}`;
/** 결과 칸 하나의 표 편집 기록 이름 */
const editKey = (panelId: string) => `db-edit-${panelId}`;
/** 반영하지 않은 표 편집을 버려도 되는지 묻는다(없으면 true) — what 은 "다시 실행하면" 같은 말 */
function okToDiscardEdits(titles: string[], what: string): boolean {
	if (!titles.length) return true;
	const list = titles.slice(0, 8).join("\n· ");
	return confirm(`반영하지 않은 편집이 있습니다.\n· ${list}${titles.length > 8 ? "\n…" : ""}\n\n${what} 이 편집은 버려집니다. 계속할까요?`);
}

/** 연결마다 하나 — 열어 둔 SQL 편집기들이 같은 이름 목록을 함께 쓴다(데이터베이스를 바꾸면 지우고 새로) */
const completions = new Map<number, SqlSource>();
function completionOf(conn: number, engine: string, epoch: () => number): SqlSource {
	let s = completions.get(conn);
	if (!s) {
		s = sqlCompletionSource({
			engine,
			tree: (path) => invoke<Node[]>("db_tree", { conn, path }),
			// 기본 스키마·행 수·FK 는 뒤 조회 줄로(사용자 실행과 같은 연결 BUSY 로 부딪히지 않게 — 실행 중이면 BUSY 로 실패해 다음에 다시), 짧은 시간 상한
			query: (sql, max) => backgroundRows(conn, sql, max),
			fks: (schema) => fksLoad(conn, epoch(), engine, schema),
		});
		completions.set(conn, s);
	}
	return s;
}

/** 앞 주석을 뺀 첫 낱말이 DDL(CREATE·ALTER·DROP·RENAME·TRUNCATE)인지 — 성공하면 그 연결의 완성 이름 기억을 새로 */
const isDdl = (sql: string) => /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sql);
/** 연결의 완성 이름·외래 키 기억 비우기(다음 완성 때 다시 읽는다) */
function forgetCompletion(conn: number) {
	completions.delete(conn);
	for (const k of fkCache.keys()) if (k.startsWith(`${conn}:`)) fkCache.delete(k);
}

/** 외래 키 기억 — 연결·epoch·스키마마다. 뒤 조회 줄로 읽고, 못 읽었으면(BUSY 등) 기억하지 않는다(다음에 다시) */
const fkCache = new Map<string, Promise<Fk[]>>();
function fksLoad(conn: number, epoch: number, engine: string, schema: string): Promise<Fk[]> {
	const k = `${conn}:${epoch}:${schema}`;
	let p = fkCache.get(k);
	if (!p) {
		const sql = fkSql(engine, schema);
		const q: Promise<Fk[]> = sql ? backgroundRows(conn, sql, 50000).then((rows) => rows.map((r) => ({ table: r[0] ?? "", column: r[1] ?? "", refTable: r[2] ?? "", refColumn: r[3] ?? "" }))) : Promise.resolve([]);
		p = q.catch((e) => {
			if (fkCache.get(k) === p) fkCache.delete(k);
			throw e;
		});
		fkCache.set(k, p);
	}
	return p;
}
/** 외래 키(못 읽으면 빈 목록) */
const fksOf = (conn: number, epoch: number, engine: string, schema: string): Promise<Fk[]> => fksLoad(conn, epoch, engine, schema).catch(() => []);

/** 값 → SQL 글자(숫자 열이면 그대로) */
function sqlLit(val: string | null, kind?: string) {
	return val === null ? null : /^-?\d+(\.\d+)?$/.test(val) && kind !== "text" ? val : `'${val.replace(/'/g, "''")}'`;
}

const db = {
	query: (conn: number, sql: string, maxRows: number, timeoutMs?: number, stream?: number) =>
		invoke<QueryOk>("db_query", { conn, sql, maxRows, timeoutMs: timeoutMs || null, stream: stream ?? null }),
	cancel: (conn: number) => invoke<void>("db_cancel", { conn }),
	rows: (result: number, from: number, to: number) => invoke<(string | null)[][]>("db_rows", { result, from, to }),
	export: (result: number, format: string, path: string, insertPrefix?: string, mysql?: boolean) => invoke<number>("db_export", { result, format, path, insertPrefix: insertPrefix ?? null, mysql: mysql ?? null }),
	tree: (conn: number, path: string[]) => invoke<Node[]>("db_tree", { conn, path }),
	closeResult: (result: number) => invoke<void>("db_result_close", { result }),
	meta: (conn: number, schema: string | null, table: string) => invoke<ColMeta[]>("db_table_meta", { conn, schema, table }),
	apply: (conn: number, stmts: EditStmt[]) => invoke<{ affected: number[]; inTx: boolean; tx: TxState }>("db_apply", { conn, stmts }),
	tx: (conn: number, op: "begin" | "commit" | "rollback") => invoke<TxState>("db_tx", { conn, op }),
	txMode: (conn: number, manual: boolean) => invoke<TxState>("db_tx_mode", { conn, manual }),
	txState: (conn: number) => invoke<TxState>("db_tx_state", { conn }),
	reconnect: (conn: number, database?: string) => invoke<{ version: string; database?: string | null }>("db_reconnect", { conn, database: database ?? null }),
	databases: (conn: number) => invoke<string[]>("db_databases", { conn }),
	classify: (sqls: string[], engine: string) =>
		invoke<{ kind: string; keyword: string; writes: boolean; dangerous: boolean; reason: string; explainAnalyze: boolean; readOnlySafe: boolean }[]>("db_classify", { sqls, engine }),
	explain: (conn: number, sql: string, analyze: boolean) => invoke<ExplainOk>("db_explain", { conn, sql, analyze }),
	saveHex: (path: string, hex: string) => invoke<number>("db_save_hex", { path, hex }),
};

/** 트랜잭션 상태가 바뀌었다고 작업대에 알린다(결과 칸의 반영·표 편집도) */
const TX_EVENT = "rb-db-tx";
function announceTx(conn: number, tx?: TxState) {
	if (tx) window.dispatchEvent(new CustomEvent(TX_EVENT, { detail: { conn, tx } }));
}

/** 문자열·주석을 비운 SQL(판정용) */
function bare(sql: string) {
	return sql
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""')
		.replace(/--[^\n]*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "");
}

const sqlTheme = EditorView.theme({
	"&": { height: "100%", fontSize: "13px", backgroundColor: "var(--surface)", color: "var(--text)" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" },
	".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fill) 45%, transparent)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(10,132,255,0.25) !important" },
	".cm-cursor": { borderLeftColor: "var(--accent)" },
	".rb-run-flash": { backgroundColor: "rgba(10,132,255,0.16)" },
});

/** 실행할 문장들 — 고른 글이 있으면 그것, 아니면 커서 문장(all 이면 전체) */
function pickRanges(v: EditorView, all: boolean): Stmt[] {
	const doc = v.state.doc.toString();
	const sel = v.state.selection.main;
	if (!sel.empty) return splitSql(doc.slice(sel.from, sel.to)).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from }));
	if (all) return splitSql(doc);
	const s = statementAt(doc, sel.head);
	return s ? [s] : [];
}
function pickStatements(v: EditorView, all: boolean): string[] {
	const r = pickRanges(v, all);
	v.dispatch({ effects: ranEffect.of(r.map((x) => ({ from: x.from, to: x.to }))) });
	return r.map((s) => s.text);
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";

/** 빈 편집기 안내 — 실행 단축키를 처음부터 보여 준다(DOM 하나, React 를 거치지 않음) */
function emptyHint(): HTMLElement {
	const root = document.createElement("div");
	root.className = "sql-empty";
	const title = document.createElement("div");
	title.className = "sql-empty-title";
	title.textContent = "SQL 을 쓰고 실행하세요 — 커서가 있는 문장만 실행합니다";
	root.append(title);
	const keys: [string[], string][] = [
		[[MOD, "Enter"], "커서 문장 실행"],
		[[MOD, "Shift", "Enter"], "전체 실행"],
		[[MOD, "E"], "실행 계획"],
		[["Shift", ALT, "F"], "포맷"],
		[[MOD, "Space"], "이름 완성"],
		[[ALT, "O"], "객체 찾기"],
	];
	const list = document.createElement("div");
	list.className = "sql-empty-keys";
	for (const [ks, label] of keys) {
		const row = document.createElement("span");
		for (const k of ks) {
			const kbd = document.createElement("kbd");
			kbd.textContent = k;
			row.append(kbd);
		}
		row.append(document.createTextNode(` ${label}`));
		list.append(row);
	}
	root.append(list);
	const tip = document.createElement("div");
	tip.className = "sql-empty-tip";
	tip.textContent = "왼쪽 표를 두 번 누르면 내용 보기 · 오른쪽 쿼리 분석 칸이 치는 동안 구조·진단·인덱스 초안을 보여 줍니다";
	root.append(tip);
	return root;
}

/** 편집기 도구 막대가 쓰는 작업대 상태 — 바뀔 일이 드문 값만(실행 중 표시는 LiveCtx) */
type ToolState = {
	autoLimit: boolean;
	maxRows: number;
	timeoutMs: number;
	manual: boolean;
	inTx: boolean;
	txStmts: number;
	closed: boolean;
	readOnly: boolean;
	canCancel: boolean;
	/** 실행 계획 트리(또는 글)를 볼 수 있다 */
	canExplain: boolean;
	/** 실제 실행 계획(ANALYZE) */
	canAnalyze: boolean;
	analysisOpen: boolean;
	/** 작업대 동작 — 렌더마다 새 함수를 넣어도 막대가 다시 그려지지 않게 ref 로 */
	act: { current: ToolActs };
};
type ToolActs = {
	run: (v: EditorView | null, all: boolean) => void;
	explain: (v: EditorView | null, analyze: boolean) => void;
	cancel: () => void;
	format: (v: EditorView | null) => void;
	toggleAnalysis: () => void;
	history: () => void;
	snippets: () => void;
	find: () => void;
	tools: (x: number, y: number) => void;
	setAutoLimit: (on: boolean) => void;
	setMaxRows: (n: number) => void;
	setTimeoutMs: (n: number) => void;
	toggleManual: () => void;
	tx: (op: "commit" | "rollback") => void;
	newSql: () => void;
};
const ToolCtx = createContext<ToolState | null>(null);

const ROW_CAPS = [1000, 10_000, 100_000, 1_000_000].map((n) => ({ value: n, label: n.toLocaleString() }));

/**
 * 편집기 도구 막대 — 쿼리 탭 줄 바로 아래, 편집기마다 하나(그 편집기에 대해 실행).
 * 주 동작(실행·전체·계획·분석) | 보조(포맷·쿼리 분석·기록·즐겨찾기·찾기·도구…) | 오른쪽 끝 조용한 실행 설정.
 * 좁아지면 보조 글자부터 숨기고 아이콘만 남긴다(이름은 title).
 */
const SqlToolbar = memo(function SqlToolbar({ viewRef }: { viewRef: { current: EditorView | null } }) {
	const t = useContext(ToolCtx);
	const { running } = useContext(LiveCtx);
	if (!t) return null;
	const a = t.act.current;
	const v = () => viewRef.current;
	const off = running || t.closed;
	return (
		<div className="dbw-tools" role="toolbar" aria-label="SQL 도구">
			<div className="dbw-tools-row">
				<div className="dbw-grp">
					<button type="button" className="btn dbw-run" disabled={off} onClick={() => a.run(v(), false)} title={`커서 문장(또는 고른 글) 실행 — ${MOD}+Enter`}>
						<Play size={13} fill="currentColor" /> <span className="lbl keep">실행</span>
					</button>
					<button type="button" className="btn ghost" disabled={off} onClick={() => a.run(v(), true)} title={`편집기 전체 실행 — ${MOD}+Shift+Enter`}>
						<PlayCircle size={14} /> <span className="lbl">전체</span>
					</button>
					{t.canExplain && (
						<button type="button" className="btn ghost" disabled={off} onClick={() => a.explain(v(), false)} title={`실행 계획(EXPLAIN) — 실행하지 않음 · ${MOD}+E`}>
							<ListTree size={14} /> <span className="lbl">계획</span>
						</button>
					)}
					{t.canAnalyze && (
						<button type="button" className="btn ghost" disabled={off} onClick={() => a.explain(v(), true)} title="실제 실행 계획(EXPLAIN ANALYZE) — 문장을 실제로 실행해 잽니다(쓰기는 끝나고 되돌림, 묻고 실행)">
							<FileSearch size={14} /> <span className="lbl">분석</span>
						</button>
					)}
					{running && t.canCancel && (
						<button type="button" className="btn dbw-cancel" onClick={a.cancel} title="실행 중인 문장 취소 — Esc">
							<CircleStop size={14} /> <span className="lbl keep">취소</span>
						</button>
					)}
				</div>
				<span className="dbw-sep" />
				<div className="dbw-grp">
					<button type="button" className="btn ghost" onClick={() => a.format(v())} title={`SQL 포맷 — 고른 글만, 없으면 전체 · Shift+${ALT}+F`}>
						<WandSparkles size={14} /> <span className="lbl">포맷</span>
					</button>
					<button type="button" className={`btn ghost${t.analysisOpen ? " on" : ""}`} aria-pressed={t.analysisOpen} onClick={a.toggleAnalysis} title="쿼리 분석 칸 — 치는 동안 구조(쿼리 지도)·진단·인덱스 초안(서버에 묻지 않음)">
						<ScanSearch size={14} /> <span className="lbl">쿼리 분석</span>
					</button>
					<button type="button" className="btn ghost" onClick={a.history} title={`쿼리 기록 — ${ALT}+H`}>
						<History size={14} /> <span className="lbl">기록</span>
					</button>
					<button type="button" className="btn ghost" onClick={a.snippets} title="즐겨찾는 SQL(스니펫)">
						<Star size={14} /> <span className="lbl">즐겨찾기</span>
					</button>
					<button type="button" className="btn ghost" onClick={a.find} title={`객체 찾기 — 표·뷰·열 이름 · ${ALT}+O`}>
						<Search size={14} /> <span className="lbl">찾기</span>
					</button>
					<button type="button" className="btn ghost" onClick={(e) => a.tools(e.clientX, e.clientY + 12)} title="도구 — 표 크기·세션·잠금·활동 감시·쓰기 확인·표 보기 쪽 크기·포맷 키워드·배치">
						<Ellipsis size={14} /> <span className="lbl">도구</span>
					</button>
				</div>
				<div className="dbw-opts">
					{t.inTx && (
						<span className="dbw-tx">
							<span className="badge warn" title="커밋하거나 되돌리기 전까지 다른 세션에는 보이지 않고, 잠금을 쥐고 있을 수 있습니다. 10분 동안 입력이 없으면 저절로 되돌립니다.">
								트랜잭션 · {t.txStmts}문장
							</span>
							<button type="button" className="btn ghost dbw-mini" onClick={() => a.tx("commit")}>
								커밋
							</button>
							<button type="button" className="btn ghost dbw-mini" onClick={() => a.tx("rollback")}>
								롤백
							</button>
						</span>
					)}
					{!t.readOnly && (
						<button
							type="button"
							className={`dbw-chip${t.manual ? " on" : ""}`}
							aria-pressed={t.manual}
							onClick={a.toggleManual}
							title={t.manual ? "수동 커밋 — 쓰기 문장은 트랜잭션 안에서 실행되고, 커밋·되돌리기 뒤에도 이 모드가 이어집니다(눌러 자동 커밋으로)" : "자동 커밋 — 문장마다 바로 반영(눌러 수동 커밋으로)"}
						>
							{t.manual ? "수동 커밋" : "자동 커밋"}
						</button>
					)}
					<button
						type="button"
						className={`dbw-chip${t.autoLimit ? " on" : ""}`}
						aria-pressed={t.autoLimit}
						onClick={() => a.setAutoLimit(!t.autoLimit)}
						title="자동 LIMIT — LIMIT 없는 SELECT 에 행 상한을 서버 쪽에도 붙인다(PostgreSQL·MySQL·MariaDB·Oracle)"
					>
						<span className="dbw-check" aria-hidden>{t.autoLimit ? "✓" : ""}</span>
						<span className="lbl">자동 </span>LIMIT
					</button>
					<span className="dbw-opt" title="결과 행 상한 — 넘으면 받기를 멈춘다">
						<span className="lbl">행 상한</span>
						<Select size="sm" value={t.maxRows} onChange={a.setMaxRows} title="결과 행 상한" aria-label="결과 행 상한" options={ROW_CAPS} />
					</span>
					<span className="dbw-opt" title="문장 시간 상한 — 넘으면 멈춘다(PostgreSQL·MySQL 은 서버가, 그 밖은 앱이 재다가 취소)">
						<span className="lbl">시간</span>
						<Select size="sm" value={t.timeoutMs} onChange={a.setTimeoutMs} title="문장 시간 상한" aria-label="문장 시간 상한" options={TIMEOUTS} />
					</span>
				</div>
			</div>
		</div>
	);
});

function SqlPanel(props: IDockviewPanelProps<{ n: number; initial?: string }>) {
	const ctx = useDb();
	const host = useRef<HTMLDivElement>(null);
	const runRef = useRef(ctx.run);
	runRef.current = ctx.run;
	const engineRef = useRef(ctx.engine);
	engineRef.current = ctx.engine;
	const ctxRef = useRef(ctx);
	ctxRef.current = ctx;
	const viewRef = useRef<EditorView | null>(null);
	useEffect(() => {
		if (!host.current) return;
		const key = `${ctx.draftKey}.${props.params.n}`;
		let timer: number | undefined;
		// 초안 — 0.8초 멈추면 쓰되, 탭 닫기·앱 끄기·편집기 갈아 끼우기 전에는 대기 중인 것을 바로 쓴다
		let pending = false;
		let view: EditorView | null = null;
		const flush = () => {
			window.clearTimeout(timer);
			if (!pending || !view) return;
			pending = false;
			void api.settingSet(key, view.state.doc.toString());
		};
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: "",
				extensions: [
					lineNumbers(),
					history(),
					drawSelection(),
					bracketMatching(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					search({ top: true }),
					codeHighlight,
					ranField,
					queryMapMarks,
					// 빈 편집기에 할 수 있는 것을 알려 준다(처음 연 사람이 실행 키를 찾지 않게) — 글을 쓰면 사라진다
					placeholder(emptyHint),
					// DB 완성(문맥·표·열·조인·함수·키워드·문서 낱말을 한 소스가 순서대로) — 편집기는 감싼 함수를 받고 속은 데이터베이스를 바꾸면 갈아 끼운다
					...editingExtensions({ completion: sqlAutocompleteConfig((cx) => completionOf(ctx.conn, ctx.engine, () => ctxRef.current.epoch)(cx)) }),
					sql({
						dialect:
							ctx.engine === "postgres" ? PostgreSQL : ctx.mysql ? MySQL : ctx.engine === "mssql" ? MSSQL : ctx.engine === "oracle" || ctx.engine === "tibero" ? PLSQL : StandardSQL,
						upperCaseKeywords: false,
					}),
					keymap.of([
						{ key: "Mod-Enter", preventDefault: true, run: (view) => (runRef.current(pickStatements(view, false)), true) },
						{ key: "Mod-e", preventDefault: true, run: () => (ctxRef.current.explain(), true) },
						// SELECT * 의 * 옆에서 — 열 목록으로 펼치기
						{ key: "Alt-Enter", run: expandStarCommand(() => completionOf(ctx.conn, ctx.engine, () => ctxRef.current.epoch)) },
						{
							key: "Escape",
							run: () => {
								if (!ctxRef.current.isRunning()) return false;
								ctxRef.current.cancel();
								return true;
							},
						},
						{ key: "Shift-Mod-Enter", preventDefault: true, run: (view) => (runRef.current(pickStatements(view, true)), true) },
						{ key: "Shift-Alt-f", preventDefault: true, run: (view) => (void api.settingGet("db.fmtCase").then((c) => formatSqlIn(view, engineRef.current, c === "lower" || c === "preserve" ? c : "upper")), true) },
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
					]),
					sqlTheme,
					EditorView.updateListener.of((u) => {
						// 쿼리 지도·튜닝 칸에 알리기만(보이는 칸이 멈춤 뒤에 읽는다)
						if (u.docChanged || u.selectionSet || u.focusChanged) touchEditor(ctx.conn, u.view);
						if (!u.docChanged) return;
						pending = true;
						window.clearTimeout(timer);
						timer = window.setTimeout(flush, 800);
					}),
				],
			}),
		});
		view = v;
		viewRef.current = v;
		const offFlush = onDraftFlush(flush);
		if (props.params.initial) v.dispatch({ changes: { from: 0, insert: props.params.initial } });
		else
			void api.settingGet(key).then((t) => {
				if (t && v.state.doc.length === 0) v.dispatch({ changes: { from: 0, insert: t } });
			});
		ctx.registerEditor(props.api.id, v);
		return () => {
			flush();
			offFlush();
			view = null;
			viewRef.current = null;
			ctx.registerEditor(props.api.id, null);
			dropEditor(ctx.conn, v);
			v.destroy();
		};
	}, [ctx.mysql, ctx.engine, ctx.draftKey, ctx.registerEditor, props.api.id, props.params.n]);
	return (
		<div className="panel-fill sql-panel">
			<SqlToolbar viewRef={viewRef} />
			<div className="cm-host" ref={host} />
		</div>
	);
}

function ResultPanel(props: IDockviewPanelProps<ResultParams>) {
	const ctx = useDb();
	const p = props.params;
	const [msg, setMsg] = useState("");
	const grid = useRef<GridApi>(null);
	const [metas, setMetas] = useState<ColMeta[] | null>(null);
	const [edits, setEdits] = useState<Map<number, Map<number, Cell>>>(new Map());
	const [deleted, setDeleted] = useState<Set<number>>(new Set());
	const [added, setAdded] = useState<(Cell | undefined)[][]>([]);
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ok = p.ok;
	const rid = ok?.resultId ?? null;
	// 받는 중 — 표는 받은 만큼 늘어나고, 정렬·거르기·내보내기·고치기는 다 받은 뒤에
	const streaming = p.state === "streaming";
	const [, setClock] = useState(0);
	useEffect(() => {
		if (!streaming) return;
		const t = window.setInterval(() => setClock((n) => n + 1), 200);
		return () => window.clearInterval(t);
	}, [streaming]);
	// 받은 행 정렬·거르기(서버에 다시 묻지 않음) — 보이는 행 수와 다시 그리기 번호
	const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
	const [filter, setFilter] = useState("");
	const [viewCount, setViewCount] = useState<number | null>(null);
	const [viewSeq, setViewSeq] = useState(0);
	const [valueView, setValueView] = useState<{ col: string; value: string | null } | null>(null);
	const [bigEdit, setBigEdit] = useState<{ r: number; c: number; value: string | null } | null>(null);
	const [thousands, setThousands] = useState(false);
	const [stats, setStats] = useState<SelStats | null>(null);
	const [where, setWhere] = useState(p.source?.where ?? "");
	const [fks, setFks] = useState<Fk[]>([]);
	const [totalRows, setTotalRows] = useState<number | null>(null);
	useEffect(() => {
		void api.settingGet("db.thousands").then((v) => setThousands(v === "1"));
		return onSettingLive(["db.thousands"], (_, v) => setThousands(v === "1"));
	}, []);
	useEffect(() => setWhere(p.source?.where ?? ""), [p.source?.where]);
	const filterTimer = useRef<number | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 새 결과면 보기를 처음으로
	useEffect(() => {
		setSort(null);
		setFilter("");
		setViewCount(null);
	}, [rid]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 보기가 바뀌면(viewSeq) 다시 받는다
	const fetchRows = useCallback((from: number, to: number) => (rid ? db.rows(rid, from, to) : Promise.resolve([])), [rid, viewSeq]);

	// 표 보기면 열 정보를 받아 편집을 켠다(PK 가 결과에 다 있을 때만)
	useEffect(() => {
		setEdits(new Map());
		setDeleted(new Set());
		setAdded([]);
		setMetas(null);
		if (!p.source || !rid || ctx.readOnly) return;
		void db
			.meta(ctx.conn, p.source.schema, p.source.table)
			.then(setMetas)
			.catch(() => setMetas([]));
	}, [rid, p.source, ctx.conn, ctx.readOnly]);
	// 외래 키(참조 행 열기·가리키는 행) — 표 보기일 때 스키마 단위로 한 번
	useEffect(() => {
		setFks([]);
		const sch = p.source?.schema ?? null;
		if (!p.source || !sch) return;
		void fksOf(ctx.conn, ctx.epoch, ctx.engine, sch).then(setFks);
	}, [p.source, ctx.conn, ctx.epoch, ctx.engine]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 표·조건이 바뀌면 전체 행 수를 다시 센다
	useEffect(() => setTotalRows(null), [p.source?.table, p.source?.where]);

	// 반영하지 않은 편집 — 탭 닫기·앱 끄기·다시 실행 확인이 볼 수 있게 dirty.ts 에 올린다(반영·버리기·칸이 사라질 때 내린다)
	const changeCount = [...edits.keys()].filter((r) => !deleted.has(r)).length + deleted.size + added.length;
	const owner = dbOwner(ctx.conn);
	const dirtyId = editKey(props.api.id);
	const dirtyName = p.source?.table ?? "결과";
	useEffect(() => {
		setDirty(owner, dirtyId, `${dirtyName} 편집 ${changeCount}건`, changeCount > 0);
	}, [owner, dirtyId, dirtyName, changeCount]);
	useEffect(() => () => setDirty(owner, dirtyId, "", false), [owner, dirtyId]);

	if (p.state === "running")
		return (
			<div className="dock-watermark">
				<p>실행 중… 첫 행을 기다리는 중</p>
				<button type="button" className="btn" onClick={() => void db.cancel(ctx.conn)} title="실행 중인 문장 취소 — Esc">
					<Square size={12} /> 취소
				</button>
			</div>
		);
	if (p.state === "error")
		return (
			<div className="db-error selectable">
				<div className="db-error-head">
					<b>{p.error?.code === "CANCELLED" ? "취소했습니다" : p.error?.code === "TIMEOUT" ? "시간 상한을 넘겼습니다" : "오류"}</b>
					{p.error?.code && p.error.code !== "CANCELLED" && <span className="badge">{p.error.code}</span>}
					<span style={{ flex: 1 }} />
					<button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(`${p.error?.message ?? ""}\n\n${p.sql}`)}>
						오류·SQL 복사
					</button>
					<button type="button" className="btn ghost" onClick={() => ctx.openSql(p.sql, "고칠 SQL")}>
						편집기로
					</button>
				</div>
				<pre>{p.error?.message}</pre>
				<details>
					<summary>실행한 SQL</summary>
					<pre>{p.sql}</pre>
				</details>
			</div>
		);
	if (!ok) return null;

	const cols = ok.columns;
	const src = p.source;
	const metaOf = (ci: number) => metas?.find((m) => m.name.toLowerCase() === cols[ci]?.name.toLowerCase());
	const pkIdx = metas ? metas.filter((m) => m.pk).map((m) => cols.findIndex((c) => c.name.toLowerCase() === m.name.toLowerCase())) : [];
	const canEdit = !streaming && !!metas && pkIdx.length > 0 && pkIdx.every((i) => i >= 0);
	const why = streaming
		? "받는 중 — 다 받은 뒤에 고칠 수 있습니다"
		: ctx.readOnly
		? "읽기 전용 연결이라 고칠 수 없습니다"
		: !src
			? "표 보기(객체 트리 › 데이터 보기)에서만 고칠 수 있습니다"
			: metas && !pkIdx.length
				? "PK 가 없는 표라 고칠 수 없습니다"
				: metas && pkIdx.some((i) => i < 0)
					? "결과에 PK 열이 다 있어야 고칠 수 있습니다"
					: null;
	const table = src ? qualified(ctx.engine, src.schema, src.table) : "";
	const total = viewCount ?? ok.rowCount;
	const paged = !!src && src.limit != null;
	const offset = src?.offset ?? 0;
	const limit = src?.limit ?? 0;

	const overlay: GridOverlay = {
		added: added as Cell[][],
		cell: (r, c) => (r >= total ? undefined : edits.get(r)?.get(c)),
		cellEdited: (r, c) => r < total && !!edits.get(r)?.has(c),
		rowState: (r) => (r >= ok.rowCount ? "added" : deleted.has(r) ? "deleted" : edits.has(r) ? "edited" : undefined),
	};

	/**
	 * 칸 여러 개 한 번에 고치기 — 원래 값을 먼저 받아 두고 함수형 setState 로 한 번에 넣는다
	 * (칸마다 await 하면 앞 칸 결과를 덮어써 마지막 칸만 남던 문제). v 가 undefined 면 새 행에서 기본값 쓰기.
	 */
	const setCells = async (list: { r: number; c: number; v: Cell | undefined }[]) => {
		const base = new Map<number, Cell[]>();
		for (const r of new Set(list.filter((x) => x.r < ok.rowCount).map((x) => x.r))) base.set(r, (await db.rows(rid as number, r, r + 1))[0] ?? []);
		setAdded((prev) => {
			const n = prev.map((row) => row.slice());
			for (const { r, c, v } of list) if (r >= ok.rowCount && n[r - ok.rowCount]) n[r - ok.rowCount][c] = v;
			return n;
		});
		setEdits((prev) => {
			const m = new Map(prev);
			for (const { r, c, v } of list) {
				if (r >= ok.rowCount || v === undefined) continue;
				const row = new Map(m.get(r) ?? []);
				if (base.get(r)?.[c] === v) row.delete(c);
				else row.set(c, v);
				if (row.size) m.set(r, row);
				else m.delete(r);
			}
			return m;
		});
	};
	const setCell = (r: number, c: number, v: Cell | undefined) => setCells([{ r, c, v }]);

	const statements = async (): Promise<EditStmt[]> => {
		const out: EditStmt[] = [];
		const ms = metas ?? [];
		for (const [r, ch] of edits) {
			if (deleted.has(r)) continue;
			const base = (await db.rows(rid as number, r, r + 1))[0];
			out.push(
				buildUpdate(
					ctx.engine,
					table,
					ms,
					pkIdx.map((i) => ({ name: cols[i].name, value: base[i] })),
					[...ch].map(([c, v]) => ({ name: cols[c].name, value: v })),
				),
			);
		}
		for (const r of deleted) {
			const base = (await db.rows(rid as number, r, r + 1))[0];
			out.push(buildDelete(ctx.engine, table, ms, pkIdx.map((i) => ({ name: cols[i].name, value: base[i] }))));
		}
		for (const row of added) {
			out.push(
				buildInsert(
					ctx.engine,
					table,
					ms,
					row.map((v, i) => ({ name: cols[i].name, value: v, touched: v !== undefined })).filter((x) => x.touched) as { name: string; value: Cell }[],
				),
			);
		}
		return out;
	};

	const applyAll = async () => {
		setBusy(true);
		try {
			const st = await statements();
			const r = await db.apply(ctx.conn, st);
			announceTx(ctx.conn, r.tx);
			setMsg(`${r.affected.length}문장 반영${r.inTx ? "(트랜잭션 안 — 커밋해야 남습니다)" : ""}`);
			// 반영했으니 편집 기록을 비우고(다시 읽기가 반영 전 확인을 묻지 않게) 같은 조건으로 다시 읽는다
			setEdits(new Map());
			setDeleted(new Set());
			setAdded([]);
			setDirty(owner, dirtyId, "", false);
			ctx.run([p.sql], src);
		} catch (e) {
			setMsg((e as DbError).message ?? String(e));
		} finally {
			setBusy(false);
		}
	};

	const rowsFor = async (rs: number[]) => {
		const out: Cell[][] = [];
		for (const r of rs) {
			const g = grid.current?.row(r);
			out.push(g ?? (r < ok.rowCount ? (await db.rows(rid as number, r, r + 1))[0] : (added[r - ok.rowCount] as Cell[])));
		}
		return out;
	};

	/** 바이너리 칸 — 표 보기면 PK 로 그 칸 전체를 16진으로 다시 받아 파일로 */
	const saveBinary = async (r: number, c: number) => {
		if (!src || !canEdit) return;
		const base = (await db.rows(rid as number, r, r + 1))[0];
		const col = quoteIdentFor(ctx.engine, cols[c].name);
		const hexExpr = ctx.engine === "postgres" ? `encode(${col}, 'hex')` : ctx.mysql ? `HEX(${col})` : ctx.engine === "mssql" ? `CONVERT(varchar(max), ${col}, 2)` : null;
		if (!hexExpr) return void setMsg("이 엔진은 바이너리 내려받기를 지원하지 않습니다");
		const cond = pkIdx.map((i) => `${quoteIdentFor(ctx.engine, cols[i].name)} = ${sqlLit(base[i], cols[i].kind) ?? "NULL"}`).join(" AND ");
		try {
			const rows = await queryRows(ctx.conn, `SELECT ${hexExpr} FROM ${table} WHERE ${cond}`, 2);
			const hex = rows[0]?.[0];
			if (hex == null) return void setMsg("NULL 이라 저장할 것이 없습니다");
			const path = await saveDialog({ defaultPath: `${cols[c].name}.bin` });
			if (!path) return;
			const n = await db.saveHex(path, hex);
			setMsg(`${n.toLocaleString()}바이트 저장함`);
		} catch (x) {
			setMsg((x as DbError).message ?? String(x));
		}
	};

	const openMenu = (e: React.MouseEvent, r: number, c: number) => {
		const picked = grid.current?.selectedRows().length ? (grid.current?.selectedRows() ?? [r]) : [r];
		const copy = (kind: "csv" | "tsv" | "json" | "markdown" | "insert") => async () => {
			const rs = await rowsFor(picked);
			await navigator.clipboard.writeText(formatRows(kind, cols.map((x) => x.name), rs, ctx.engine, table || undefined));
			setMsg(`${rs.length}행 복사함`);
		};
		const items: MenuItem[] = [];
		if (c >= 0) {
			const val = grid.current?.row(r)?.[c] ?? null;
			items.push({ label: "값 보기…", run: () => setValueView({ col: cols[c].name, value: val }) });
			items.push({ label: "값 복사", run: () => void navigator.clipboard.writeText(val ?? "") });
			if (canEdit && r < ok.rowCount) items.push({ label: "크게 고치기…  Shift+Enter", run: () => setBigEdit({ r, c, value: val }) });
			if (cols[c].kind === "binary" && canEdit && r < ok.rowCount) items.push({ label: "바이너리 내려받기…", run: () => void saveBinary(r, c) });
			if (src) {
				const col = quoteIdentFor(ctx.engine, cols[c].name);
				const litv = sqlLit(val, cols[c].kind);
				items.push(
					{ label: "이 값으로 거르기", run: () => ctx.openTable({ ...src, where: `${col} ${litv === null ? "IS NULL" : `= ${litv}`}`, offset: 0 }) },
					{ label: "이 값 빼고", run: () => ctx.openTable({ ...src, where: `${col} ${litv === null ? "IS NOT NULL" : `<> ${litv}`}`, offset: 0 }) },
				);
				// 외래 키 따라가기 — 이 열이 가리키는 행, 이 값을 가리키는 다른 표의 행
				const name = cols[c].name.toLowerCase();
				const out = fks.filter((f) => f.table.toLowerCase() === src.table.toLowerCase() && f.column.toLowerCase() === name);
				const inc = fks.filter((f) => f.refTable.toLowerCase() === src.table.toLowerCase() && f.refColumn.toLowerCase() === name);
				if (val !== null && (out.length || inc.length)) {
					items.push({ sep: true });
					for (const f of out)
						items.push({
							label: `참조 행 열기 — ${f.refTable}.${f.refColumn}`,
							run: () => ctx.openTable({ schema: src.schema, table: f.refTable, where: `${quoteIdentFor(ctx.engine, f.refColumn)} = ${litv}`, offset: 0 }),
						});
					for (const f of inc.slice(0, 12))
						items.push({
							label: `가리키는 행 — ${f.table}.${f.column}`,
							run: () => ctx.openTable({ schema: src.schema, table: f.table, where: `${quoteIdentFor(ctx.engine, f.column)} = ${litv}`, offset: 0 }),
						});
				}
			}
			if (canEdit && metaOf(c)?.nullable !== false) items.push({ label: "NULL 로", run: () => void setCell(r, c, null) });
			if (canEdit && r >= ok.rowCount) items.push({ label: "기본값 쓰기(넣지 않음)", run: () => void setCell(r, c, undefined) });
			items.push({ sep: true });
		}
		items.push(
			{ label: `복사 — CSV(${picked.length}행)`, run: () => void copy("csv")() },
			{ label: "복사 — TSV(엑셀 붙여넣기)  Ctrl+C", run: () => void copy("tsv")() },
			{ label: "복사 — JSON", run: () => void copy("json")() },
			{ label: "복사 — Markdown 표", run: () => void copy("markdown")() },
			{ label: "복사 — INSERT 문", run: () => void copy("insert")() },
		);
		if (p.tool === "sessions") {
			const id = grid.current?.row(r)?.[0] ?? null;
			const k = id ? killSql(ctx.engine, id) : null;
			const t = id ? terminateSql(ctx.engine, id) : null;
			const extra: MenuItem[] = [];
			if (k && ctx.engine !== "mssql")
				extra.push({
					label: `세션 ${id} 의 쿼리 멈추기`,
					danger: true,
					run: () => {
						if (confirm(`세션 ${id} 에서 실행 중인 쿼리를 멈출까요?`)) ctx.run([k]);
					},
				});
			if (t)
				extra.push({
					label: `세션 ${id} 연결 끊기`,
					danger: true,
					run: () => {
						if (confirm(`세션 ${id} 의 연결을 끊을까요? 그 세션의 열린 트랜잭션은 되돌아갑니다.`)) {
							ctx.run([t]);
							window.setTimeout(() => ctx.run([p.sql], undefined, "sessions"), 700);
						}
					},
				});
			if (extra.length) items.unshift(...extra, { sep: true });
		}
		if (canEdit) {
			items.push(
				{ sep: true },
				{
					label: "행 복제",
					run: async () => {
						const rs = await rowsFor(picked);
						setAdded((prev) => [...prev, ...rs.map((row) => row.map((v, i) => (pkIdx.includes(i) && metaOf(i)?.default ? undefined : v)))]);
					},
				},
				{
					label: "새 행",
					run: () => setAdded((prev) => [...prev, cols.map(() => undefined)]),
				},
				{
					label: picked.every((x) => deleted.has(x)) ? "지우기 취소" : `행 지우기(${picked.length})  Del`,
					danger: true,
					run: () => toggleDelete(picked),
				},
			);
		}
		setMenu({ x: e.clientX, y: e.clientY, items });
	};

	/** 행 지우기 표시(이미 표시면 취소), 새 행은 바로 뺀다 */
	function toggleDelete(picked: number[]) {
		setDeleted((prev) => {
			const n = new Set(prev);
			const undo = picked.every((x) => n.has(x));
			for (const x of picked) {
				if (x >= total) continue;
				if (undo) n.delete(x);
				else n.add(x);
			}
			return n;
		});
		setAdded((prev) => prev.filter((_, i) => !picked.includes(total + i)));
	}

	const STREAM_WAIT = "받는 중 — 정렬·거르기·내보내기는 다 받은 뒤에 됩니다(취소하면 받은 행으로)";
	async function applyView(next: { sort: { col: number; desc: boolean } | null; filter: string }) {
		if (!rid || !ok) return;
		if (streaming) return void setMsg(STREAM_WAIT);
		if (changeCount > 0) {
			setMsg("고친 것을 반영하거나 되돌린 뒤에 정렬·거를 수 있습니다");
			return;
		}
		const n = await invoke<number>("db_view", { result: rid, sort: next.sort?.col ?? null, desc: !!next.sort?.desc, filter: next.filter.trim() || null });
		setViewCount(!next.sort && !next.filter.trim() ? null : n);
		setViewSeq((x) => x + 1);
	}
	const onSort = (c: number) => {
		if (streaming) return void setMsg(STREAM_WAIT);
		// 표 보기(쪽 나누기)면 서버 ORDER BY 로 — 받은 쪽만 정렬하면 순서가 틀린다
		if (paged && src) {
			if (changeCount > 0) return void setMsg("고친 것을 반영하거나 되돌린 뒤에 정렬할 수 있습니다");
			const name = cols[c].name;
			const cur = src.order;
			const order = cur?.col !== name ? { col: name, desc: false } : !cur.desc ? { col: name, desc: true } : null;
			ctx.openTable({ ...src, order, offset: 0 });
			return;
		}
		const next = sort?.col !== c ? { col: c, desc: false } : !sort.desc ? { col: c, desc: true } : null;
		setSort(next);
		void applyView({ sort: next, filter });
	};
	const gridSort = paged ? (src?.order ? { col: cols.findIndex((x) => x.name === src.order?.col), desc: src.order.desc } : null) : sort;

	const goPage = (o: number) => {
		if (!src) return;
		if (changeCount > 0) return void setMsg("고친 것을 반영하거나 되돌린 뒤에 쪽을 넘길 수 있습니다");
		ctx.openTable({ ...src, offset: Math.max(0, o) });
	};
	const countAll = async () => {
		if (!src) return;
		try {
			const r = await queryRows(ctx.conn, `SELECT count(*) FROM ${table}${src.where?.trim() ? ` WHERE ${src.where.trim()}` : ""}`, 1);
			setTotalRows(Number(r[0]?.[0] ?? 0));
		} catch (x) {
			setMsg((x as DbError).message ?? String(x));
		}
	};

	async function doExport(format: "csv" | "tsv" | "json" | "xlsx") {
		if (!rid) return;
		if (streaming) return void setMsg(STREAM_WAIT);
		const path = await saveDialog({ defaultPath: `result.${format}`, filters: [{ name: format === "xlsx" ? "엑셀" : format.toUpperCase(), extensions: [format] }] });
		if (!path) return;
		if (format === "xlsx") {
			// 보이는 행(정렬·거르기 적용) 그대로 — db_rows 가 보기 순서로 준다
			setMsg("엑셀 만드는 중…");
			try {
				const r = await saveXlsx(path, cols, total, (from, to) => db.rows(rid, from, to), src?.table ?? "result");
				setMsg(`${r.rows.toLocaleString()}행을 엑셀로 저장했습니다${r.capped ? `(엑셀 한 장 상한 ${XLSX_MAX_ROWS.toLocaleString()}행에서 멈춤)` : ""}`);
			} catch (x) {
				setMsg(`엑셀 저장 실패: ${String((x as DbError).message ?? x)}`);
			}
			return;
		}
		try {
			const n = await db.export(rid, format, path);
			setMsg(`${n.toLocaleString()}행을 저장했습니다`);
		} catch (x) {
			setMsg(`저장 실패: ${String((x as DbError).message ?? x)}`);
		}
	}
	const num = (v: string) => (thousands ? groupDigits(v) : v);
	const statChip = (label: string, v: string | undefined) =>
		v == null ? null : (
			<button
				type="button"
				className="sel-stat"
				title={`${label} 복사`}
				onClick={() => {
					void navigator.clipboard.writeText(v);
					setMsg(`${label} ${num(v)} 복사함`);
				}}
			>
				{label} <b>{num(v)}</b>
			</button>
		);

	return (
		<div className="panel-fill">
			{changeCount > 0 && (
				<div className="change-bar">
					<span>
						변경 <b>{changeCount}</b>건 — 바뀐 칸 {[...edits.values()].reduce((a, m) => a + m.size, 0)} · 새 행 {added.length} · 지울 행 {deleted.size}
					</span>
					<span style={{ flex: 1 }} />
					<button
						type="button"
						className="btn ghost"
						onClick={async () => {
							const st = await statements();
							setPreview(st.map((s) => `${previewSql(ctx.engine, s)};`).join("\n"));
						}}
					>
						SQL 보기
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => {
							setEdits(new Map());
							setDeleted(new Set());
							setAdded([]);
						}}
					>
						되돌리기
					</button>
					<button type="button" className="btn primary" disabled={busy} onClick={() => void applyAll()}>
						{busy ? "반영 중…" : ctx.inTx ? "반영(트랜잭션 안)" : "반영(커밋)"}
					</button>
				</div>
			)}
			{src && (
				<form
					className="where-bar"
					onSubmit={(e) => {
						e.preventDefault();
						ctx.openTable({ ...src, where: where.trim(), offset: 0 });
					}}
				>
					<code>SELECT * FROM {table} WHERE</code>
					<input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="조건(비우면 전체) — Enter 로 다시 읽기" spellCheck={false} />
				</form>
			)}
			{rid ? (
				<DataGrid
					apiRef={grid}
					columns={cols.map((c, i) => ({ ...c, pk: !!metaOf(i)?.pk, hint: metaOf(i)?.dataType }))}
					rowCount={total}
					fetchRows={fetchRows}
					resetKey={`${rid}:${viewSeq}`}
					sort={gridSort}
					onSort={onSort}
					overlay={overlay}
					editable={() => canEdit && !busy}
					onCellNull={(r, c) => metaOf(c)?.nullable !== false && void setCell(r, c, null)}
					onDeleteRows={(rs) => toggleDelete(rs)}
					onCopyRows={async (rs) => {
						const got = await rowsFor(rs);
						await navigator.clipboard.writeText(formatRows("tsv", cols.map((x) => x.name), got, ctx.engine));
						setMsg(`${got.length}행 복사함(TSV)`);
					}}
					onBigEdit={(r, c) => setBigEdit({ r, c, value: grid.current?.row(r)?.[c] ?? null })}
					onStats={setStats}
					onPaste={(r0, c0, pasted) => {
						const list: { r: number; c: number; v: Cell }[] = [];
						for (let i = 0; i < pasted.length; i++)
							for (let j = 0; j < pasted[i].length; j++) {
								const r = r0 + i;
								const c = c0 + j;
								if (r >= total + added.length || c >= cols.length) continue;
								const v = pasted[i][j];
								list.push({ r, c, v: v === "NULL" && metaOf(c)?.nullable !== false ? null : v });
							}
						void setCells(list);
						setMsg(`${list.length}칸 붙여 넣음 — 반영 전입니다`);
					}}
					thousands={thousands}
					renderEditor={(r, c, value, done, seeded) => (
						<CellEditor
							seeded={seeded}
							meta={metaOf(c)}
							value={value}
							onDefault={
								r >= ok.rowCount
									? () => {
											void setCell(r, c, undefined);
											done(undefined);
										}
									: undefined
							}
							onDone={(v, move) => {
								if (v !== undefined) void setCell(r, c, v);
								done(v, move);
							}}
						/>
					)}
					onContextMenu={openMenu}
				/>
			) : (
				<div className="dock-watermark">
					<p style={{ color: "var(--text)" }}>{ok.affected != null ? `${ok.affected.toLocaleString()}행 반영` : "완료"}</p>
				</div>
			)}
			<div className="statusbar">
				{streaming ? (
					<span className="db-streaming" title="받은 만큼 표가 늘어납니다 — 스크롤해서 보세요">
						<span className="db-streaming-dot" />
						받는 중 {ok.rowCount.toLocaleString()}행 · {((Date.now() - p.at) / 1000).toFixed(1)}초
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void db.cancel(ctx.conn)} title="그만 받기 — 받은 행은 남습니다(Esc)">
							<Square size={10} /> 취소
						</button>
					</span>
				) : (
					<>
						<span className={ok.stopped ? "db-stopped" : "ok"} title={ok.stopped === "memory" ? "결과 하나가 쓸 메모리 어림(512MB)을 넘어 멈췄습니다 — 조건·LIMIT 으로 줄여 보세요" : undefined}>
							{ok.stopped === "cancelled"
								? `취소됨 · 받은 ${ok.rowCount.toLocaleString()}행`
								: ok.stopped === "timeout"
									? `시간 상한 · 받은 ${ok.rowCount.toLocaleString()}행`
									: ok.stopped === "memory"
										? `메모리 상한에서 멈춤 · 받은 ${ok.rowCount.toLocaleString()}행`
										: rid
											? viewCount != null
												? `${viewCount.toLocaleString()} / ${ok.rowCount.toLocaleString()}행`
												: `${ok.rowCount.toLocaleString()}행`
											: "완료"}
							{ok.truncated && ok.stopped !== "memory" ? " (상한에서 멈춤)" : ""}
						</span>
						<span>{ok.ms.toLocaleString()} ms</span>
					</>
				)}
				{ok.firstRowMs != null && <span title="문장을 보낸 뒤 첫 행이 올 때까지">보냄→첫 행 {ok.firstRowMs.toLocaleString()} ms</span>}
				{rid && src && <span title={why ?? "두 번 누르기·F2 로 고치기, Shift+Enter 크게 고치기, Delete 로 행 지우기, 우클릭으로 행 추가"}>{why ? `🔒 ${why}` : canEdit ? "✎ 고칠 수 있음" : ""}</span>}
				{paged && (
					<span className="page-bar">
						<button type="button" className="btn ghost" disabled={offset === 0} onClick={() => goPage(offset - limit)} title="앞 쪽">
							◀
						</button>
						<span>
							{(ok.rowCount ? offset + 1 : offset).toLocaleString()}–{(offset + ok.rowCount).toLocaleString()}
							{totalRows != null ? ` / ${totalRows.toLocaleString()}` : ""}
						</span>
						<button type="button" className="btn ghost" disabled={ok.rowCount < limit} onClick={() => goPage(offset + limit)} title="다음 쪽">
							▶
						</button>
						{totalRows == null && (
							<button type="button" className="btn ghost" onClick={() => void countAll()} title="조건에 맞는 전체 행 수 세기(count)">
								전체 수
							</button>
						)}
					</span>
				)}
				{msg && <span>{msg}</span>}
				<span style={{ marginLeft: "auto" }} />
				{stats && (
					<span className="sel-stats" title={stats.partial ? "칸이 너무 많아 앞쪽 50만 칸만 셌습니다" : "누르면 그 값을 복사"}>
						{statChip("개수", String(stats.count))}
						{statChip("합계", stats.sum)}
						{statChip("평균", stats.avg)}
						{statChip("최소", stats.min)}
						{statChip("최대", stats.max)}
						{stats.partial && <span className="muted">일부</span>}
					</span>
				)}
				{rid ? (
					<>
						<button
							type="button"
							className={`btn ghost${thousands ? " on" : ""}`}
							style={{ height: 20 }}
							title="숫자 천 단위 구분"
							onClick={() => {
								setThousands(!thousands);
								setSettingLive("db.thousands", thousands ? "0" : "1");
							}}
						>
							1,000
						</button>
						<label className="res-filter" title="받은 행에서 거르기 — 띄어 쓰면 모두 들어간 행, 대소문자 무시, Esc 로 지우기">
							<Search size={11} />
							<input
								value={filter}
								disabled={streaming}
								placeholder={streaming ? "다 받은 뒤 거르기" : paged ? "이 쪽에서 거르기" : "결과에서 거르기"}
								spellCheck={false}
								onChange={(e) => {
									const v = e.target.value;
									setFilter(v);
									window.clearTimeout(filterTimer.current);
									filterTimer.current = window.setTimeout(() => void applyView({ sort: paged ? null : sort, filter: v }), 220);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape" && filter) {
										setFilter("");
										void applyView({ sort: paged ? null : sort, filter: "" });
									}
								}}
							/>
						</label>
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={streaming} title={streaming ? STREAM_WAIT : undefined} onClick={() => void doExport("csv")}>
							<Download size={12} /> CSV
						</button>
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={streaming} title={streaming ? STREAM_WAIT : undefined} onClick={() => void doExport("tsv")}>
							TSV
						</button>
						<button type="button" className="btn ghost" style={{ height: 20 }} disabled={streaming} title={streaming ? STREAM_WAIT : undefined} onClick={() => void doExport("json")}>
							JSON
						</button>
						<button
							type="button"
							className="btn ghost"
							style={{ height: 20 }}
							disabled={streaming}
							title={streaming ? STREAM_WAIT : "엑셀(xlsx) — 보이는 행(정렬·거르기 적용)"}
							onClick={() => void doExport("xlsx")}
						>
							엑셀
						</button>
					</>
				) : null}
			</div>
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
			{valueView && <ValueSheet col={valueView.col} value={valueView.value} onClose={() => setValueView(null)} />}
			{bigEdit && (
				<BigEditSheet
					col={cols[bigEdit.c]?.name ?? ""}
					value={bigEdit.value}
					readOnly={!canEdit}
					nullable={metaOf(bigEdit.c)?.nullable !== false}
					onDone={(v) => {
						if (v !== undefined && canEdit) void setCell(bigEdit.r, bigEdit.c, v);
						setBigEdit(null);
					}}
				/>
			)}
			{preview !== null && (
				<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
					<div className="sheet" style={{ width: "min(760px, calc(100vw - 32px))" }}>
						<h3>반영할 SQL</h3>
						<p style={{ color: "var(--text-2)", marginTop: -8, fontSize: 12.5 }}>보여 주기용으로 값을 끼웠습니다. 실제로는 값을 매개변수로 묶어 한 트랜잭션에서 실행하고, UPDATE·DELETE 가 정확히 1행이 아니면 모두 되돌립니다.</p>
						<textarea className="fp" readOnly value={preview} style={{ width: "100%", height: 260, border: 0, color: "var(--text)", resize: "vertical" }} />
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(preview)}>
								복사
							</button>
							<button type="button" className="btn primary" onClick={() => setPreview(null)}>
								닫기
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 객체 트리가 한 부모 아래 한 번에 그리는 자식 수 — 표가 수천 개인 스키마에서 DOM 이 수천 줄이 되지 않게(나머지는 "더 보기") */
const TREE_CAP = 300;

function ObjectsPanel() {
	const ctx = useDb();
	const [kids, setKids] = useState<Record<string, Node[] | string>>({});
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	/** 부모(스키마·표)마다 지금 보이는 자식 수 — 표가 수천 개여도 한 번에 TREE_CAP 개만 그린다 */
	const [shown, setShown] = useState<Record<string, number>>({});
	const openKey = `dbtree.open.${ctx.historyScope}`;
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

	const load = useCallback(
		(path: string[]) => {
			const k = path.join("\u0001");
			db.tree(ctx.conn, path)
				.then((n) => setKids((s) => ({ ...s, [k]: n })))
				.catch((e) => setKids((s) => ({ ...s, [k]: (e as DbError).message ?? String(e) })));
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: 다시 연결·데이터베이스 바꾸기(epoch)면 새로 읽는다
		[ctx.conn, ctx.epoch],
	);
	// 펼쳐 둔 스키마·표를 기억했다가 다시 펼친다
	// biome-ignore lint/correctness/useExhaustiveDependencies: 연결이 바뀔 때만
	useEffect(() => {
		setKids({});
		setShown({});
		load([]);
		void api.settingGet(openKey).then((v) => {
			try {
				const keys = v ? (JSON.parse(v) as string[]) : [];
				setOpen(new Set(keys));
				for (const k of keys) load(k.split("\u0001"));
			} catch {
				// 무시
			}
		});
	}, [load]);
	useEffect(() => {
		const t = window.setTimeout(() => void api.settingSet(openKey, JSON.stringify([...open].slice(0, 200))), 500);
		return () => window.clearTimeout(t);
	}, [open, openKey]);
	const showSql = (sql: string | null, tool?: string) => {
		if (sql) ctx.run([sql], undefined, tool ?? "catalog");
		else ctx.notice("이 엔진에서는 아직 지원하지 않습니다");
	};
	const errMsg = (x: unknown) => ctx.notice((x as DbError).message ?? String(x));
	/** 열 정보로 INSERT·UPDATE·DELETE 틀(값은 :이름 파라미터) */
	const dml = async (kind: "insert" | "update" | "delete", schema: string, table: string) => {
		try {
			const cols = await db.meta(ctx.conn, schema === "(기본)" ? null : schema, table);
			const q = qname(schema, table);
			const id = (n: string) => quoteIdentFor(ctx.engine, n);
			const param = (n: string) => `:${n.replace(/\W/g, "_")}`;
			const pk = cols.filter((c) => c.pk);
			const where = (pk.length ? pk : cols.slice(0, 1)).map((c) => `${id(c.name)} = ${param(c.name)}`).join(" AND ");
			const text =
				kind === "insert"
					? `INSERT INTO ${q} (${cols.map((c) => id(c.name)).join(", ")})\nVALUES (${cols.map((c) => param(c.name)).join(", ")});\n`
					: kind === "update"
						? `UPDATE ${q}\nSET ${cols
								.filter((c) => !c.pk)
								.map((c) => `${id(c.name)} = ${param(c.name)}`)
								.join(",\n    ")}\nWHERE ${where};\n`
						: `DELETE FROM ${q}\nWHERE ${where};\n`;
			ctx.insertText(text);
		} catch (x) {
			errMsg(x);
		}
	};
	/** 표 전체를 파일로(최대 100만 행) — sql 은 INSERT 문 */
	const exportTable = async (schema: string, table: string, format: "csv" | "tsv" | "json" | "sql" | "xlsx") => {
		const path = await saveDialog({ defaultPath: `${table}.${format}`, filters: [{ name: format === "xlsx" ? "엑셀" : format.toUpperCase(), extensions: [format] }] });
		if (!path) return;
		try {
			const ok = await db.query(ctx.conn, `SELECT * FROM ${qname(schema, table)}`, format === "xlsx" ? XLSX_MAX_ROWS : 1_000_000);
			if (!ok.resultId) return;
			const rid = ok.resultId;
			// 내보내기가 실패해도 백엔드에 남은 결과(최대 수백 MB)는 놓는다 — 형식 상관없이 finally 에서
			try {
				if (format === "xlsx") {
					const r = await saveXlsx(path, ok.columns, ok.rowCount, (from, to) => db.rows(rid, from, to), table);
					ctx.notice(`${r.rows.toLocaleString()}행을 엑셀로 저장했습니다${ok.truncated ? `(엑셀 한 장 상한 ${XLSX_MAX_ROWS.toLocaleString()}행에서 멈춤)` : ""}`);
					return;
				}
				const prefix = format === "sql" ? `INSERT INTO ${qname(schema, table)} (${ok.columns.map((c) => quoteIdentFor(ctx.engine, c.name)).join(", ")}) VALUES ` : undefined;
				const n = await db.export(rid, format, path, prefix, ctx.mysql);
				ctx.notice(`${n.toLocaleString()}행을 저장했습니다${ok.truncated ? "(100만 행에서 멈춤)" : ""}`);
			} finally {
				void db.closeResult(rid);
			}
		} catch (x) {
			errMsg(x);
		}
	};
	/** 비우기·지우기 — 이름을 그대로 쳐야 실행 */
	const destroy = async (kind: "truncate" | "drop", schema: string, table: string, what: "표" | "뷰" | "구체화 뷰") => {
		const word = kind === "truncate" ? "모든 행을 지웁니다. 되살릴 수 없습니다." : `${what}를 지웁니다. 되살릴 수 없습니다.`;
		const got = await ctx.ask({ title: kind === "truncate" ? `${table} 비우기` : `${table} 지우기`, message: word, confirmWord: table, okLabel: kind === "truncate" ? "비우기" : "지우기", danger: true });
		if (got !== table) return;
		const q = qname(schema, table);
		ctx.run([kind === "truncate" ? `TRUNCATE TABLE ${q}` : `DROP ${what === "뷰" ? "VIEW" : what === "구체화 뷰" ? "MATERIALIZED VIEW" : "TABLE"} ${q}`]);
		window.setTimeout(() => load([schema]), 800);
	};
	/** DDL 글 — 구체화 뷰는 PostgreSQL 카탈로그로 따로 */
	const ddlText = async (schema: string, n: Node): Promise<string | null> => {
		const mat = n.detail === "구체화 뷰";
		const l = (x: string) => `'${x.replace(/'/g, "''")}'`;
		const dq = mat
			? `SELECT 'CREATE MATERIALIZED VIEW ' || quote_ident(${l(schema)}) || '.' || quote_ident(${l(n.name)}) || E' AS\\n' || pg_get_viewdef(to_regclass(quote_ident(${l(schema)}) || '.' || quote_ident(${l(n.name)})), true)`
			: ddlSql(ctx.engine, schema, n.name, n.kind === "view");
		if (!dq) return null;
		const rows = await queryRows(ctx.conn, dq, 5);
		const text = rows[0]?.[rows[0].length - 1] ?? "";
		return `${text}${text.trim().endsWith(";") ? "" : ";"}\n`;
	};
	/** 이 표를 가리키는 표(역참조) — 고르면 그 표 보기 */
	const showIncoming = async (e: { x: number; y: number }, schema: string, table: string) => {
		const fks = (await fksOf(ctx.conn, ctx.epoch, ctx.engine, schema)).filter((f) => f.refTable.toLowerCase() === table.toLowerCase());
		if (!fks.length) return ctx.notice(`${table} 을(를) 가리키는 외래 키가 없습니다(같은 스키마 안에서)`);
		setMenu({
			x: e.x,
			y: e.y,
			items: fks.slice(0, 30).map((f) => ({
				label: `${f.table}.${f.column} → ${f.refColumn}`,
				run: () => ctx.openTable({ schema: schema === "(기본)" ? null : schema, table: f.table, where: `${quoteIdentFor(ctx.engine, f.column)} IS NOT NULL` }),
			})),
		});
	};
	const fl = filter.trim().toLowerCase();

	const qname = (schema: string, table: string) =>
		schema === "(기본)" ? quoteIdentFor(ctx.engine, table) : `${quoteIdentFor(ctx.engine, schema)}.${quoteIdentFor(ctx.engine, table)}`;
	const toggle = (path: string[]) => {
		const k = path.join("\u0001");
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(k)) n.delete(k);
			else {
				n.add(k);
				load(path);
			}
			return n;
		});
	};
	const srcOf = (schema: string, table: string): Source => ({ schema: schema === "(기본)" ? null : schema, table });

	const rows: ReactElement[] = [];
	const walk = (path: string[], depth: number) => {
		const v = kids[path.join("\u0001")];
		if (v === undefined) {
			rows.push(
				<div key={`${path.join("/")}#l`} className="tree-msg" style={{ paddingLeft: 12 + depth * 14 }}>
					읽는 중…
				</div>,
			);
			return;
		}
		if (typeof v === "string") {
			rows.push(
				<div key={`${path.join("/")}#e`} className="tree-msg err" style={{ paddingLeft: 12 + depth * 14 }}>
					{v}
				</div>,
			);
			return;
		}
		const pk = path.join("");
		const list = fl ? v.filter((n) => !((n.kind === "table" || n.kind === "view") && !n.name.toLowerCase().includes(fl))) : v;
		const cap = shown[pk] ?? TREE_CAP;
		for (const n of cap < list.length ? list.slice(0, cap) : list) {
			const p = [...path, n.name];
			const k = p.join("\u0001");
			const expandable = n.kind !== "column";
			const isOpen = open.has(k);
			const isPk = n.kind === "column" && / · PK$/.test(n.detail ?? "");
			const icon =
				n.kind === "schema" ? (
					<Database size={14} className="ti dir" />
				) : n.kind === "view" ? (
					<Eye size={14} className="ti" />
				) : n.kind === "table" ? (
					<Table size={14} className="ti dir" />
				) : isPk ? (
					<KeyRound size={13} className="ti" style={{ color: "#c77700" }} />
				) : (
					<Columns3 size={13} className="ti" />
				);
			rows.push(
				<button
					key={k}
					type="button"
					className="tree-row"
					style={{ paddingLeft: 6 + depth * 14 }}
					onClick={() => expandable && toggle(p)}
					onDoubleClick={() => {
						if (n.kind === "table" || n.kind === "view") ctx.openTable(srcOf(path[0], n.name));
						else if (n.kind === "column") ctx.insertText(quoteIdentFor(ctx.engine, n.name));
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						const at = { x: e.clientX, y: e.clientY };
						const items: MenuItem[] = [];
						if (n.kind === "table" || n.kind === "view") {
							const q = qname(path[0], n.name);
							const sch = path[0];
							const mat = n.detail === "구체화 뷰";
							items.push(
								{ label: "데이터 보기(고치기)", run: () => ctx.openTable(srcOf(sch, n.name)) },
								{ label: "행 수 세기", run: () => ctx.run([`SELECT count(*) AS row_count FROM ${q}`]) },
								{ label: "SELECT 문 넣기", run: () => ctx.insertText(`${selectTop(ctx.engine, q, 100)};\n`) },
							);
							if (ddlSql(ctx.engine, sch, n.name, n.kind === "view") || mat)
								items.push(
									{
										label: "DDL 보기",
										run: async () => {
											try {
												const t = await ddlText(sch, n);
												if (t) ctx.openSql(t, `DDL ${n.name}`);
											} catch (x) {
												errMsg(x);
											}
										},
									},
									{
										label: "DDL 복사",
										run: async () => {
											try {
												const t = await ddlText(sch, n);
												if (t) {
													await navigator.clipboard.writeText(t);
													ctx.notice(`${n.name} DDL 을 복사했습니다`);
												}
											} catch (x) {
												errMsg(x);
											}
										},
									},
								);
							if (mat && !ctx.readOnly) items.push({ label: "구체화 뷰 새로 고침(REFRESH)", run: () => ctx.run([`REFRESH MATERIALIZED VIEW ${q}`]) });
							items.push(
								{ label: "인덱스", run: () => showSql(indexSql(ctx.engine, sch === "(기본)" ? null : sch, n.name)) },
								{ label: "이 표를 가리키는 행(역참조)…", run: () => void showIncoming(at, sch, n.name) },
								{ sep: true },
								{ label: "INSERT 문 만들기", run: () => void dml("insert", sch, n.name) },
								{ label: "UPDATE 문 만들기", run: () => void dml("update", sch, n.name) },
								{ label: "DELETE 문 만들기", run: () => void dml("delete", sch, n.name) },
								{ sep: true },
								{ label: "내보내기 — CSV…", run: () => void exportTable(sch, n.name, "csv") },
								{ label: "내보내기 — TSV…", run: () => void exportTable(sch, n.name, "tsv") },
								{ label: "내보내기 — JSON…", run: () => void exportTable(sch, n.name, "json") },
								{ label: "내보내기 — 엑셀(xlsx)…", run: () => void exportTable(sch, n.name, "xlsx") },
								{ label: "내보내기 — SQL INSERT 파일…", run: () => void exportTable(sch, n.name, "sql") },
							);
							if (!ctx.readOnly && n.kind === "table") items.push({ label: "CSV 가져오기…", run: () => ctx.importCsv(sch === "(기본)" ? null : sch, n.name) });
							if (!ctx.readOnly) {
								items.push({ sep: true });
								if (n.kind === "table") items.push({ label: "비우기(TRUNCATE)…", danger: true, run: () => void destroy("truncate", sch, n.name, "표") });
								items.push({
									label: n.kind === "view" ? (mat ? "구체화 뷰 지우기(DROP)…" : "뷰 지우기(DROP)…") : "표 지우기(DROP)…",
									danger: true,
									run: () => void destroy("drop", sch, n.name, n.kind === "view" ? (mat ? "구체화 뷰" : "뷰") : "표"),
								});
							}
							items.push({ sep: true });
						}
						if (n.kind === "column") {
							const sch = path[0];
							const t = path[1];
							const col = quoteIdentFor(ctx.engine, n.name);
							items.push(
								{ label: "이름 넣기", run: () => ctx.insertText(col) },
								{
									label: "값 분포(많은 순 100)",
									run: () => {
										const base = `${col} AS 값, COUNT(*) AS 개수 FROM ${qname(sch, t)} GROUP BY ${col} ORDER BY 2 DESC`;
										ctx.run([ctx.engine === "mssql" ? `SELECT TOP 100 ${base}` : ctx.engine === "oracle" || ctx.engine === "tibero" ? `SELECT ${base} FETCH FIRST 100 ROWS ONLY` : `SELECT ${base} LIMIT 100`]);
									},
								},
								{ sep: true },
							);
						}
						if (n.kind === "schema") {
							const sch = n.name === "(기본)" ? null : n.name;
							items.push({ label: "함수·프로시저", run: () => showSql(routinesSql(ctx.engine, sch)) }, { label: "시퀀스", run: () => showSql(sequencesSql(ctx.engine, sch)) });
							items.push(
								{ label: "ERD(관계도)", run: () => ctx.openPanel(`erd:${n.name}`, "erd", `ERD ${n.name}`, { schema: n.name }) },
								{ label: "표 크기", run: () => toolSql(ctx.engine, "sizes", n.name) && ctx.run([toolSql(ctx.engine, "sizes", n.name) as string], undefined, "sizes") },
								{
									label: "다른 스키마와 비교…",
									run: async () => {
										const other = await ctx.ask({ title: "스키마 비교", message: `${n.name} 와(과) 비교할 스키마 이름`, placeholder: "스키마 이름", okLabel: "비교" });
										if (other) ctx.openPanel(`cmp:${n.name}:${other}`, "compare", `비교 ${n.name}↔${other}`, { a: n.name, b: other });
									},
								},
								{ label: "읽기 전용 계정 만들기 SQL", run: () => readOnlyUserSql(ctx.engine, sch) && ctx.openSql(readOnlyUserSql(ctx.engine, sch) as string, "읽기 전용 계정") },
								{ sep: true },
							);
						}
						items.push({ label: "이름 복사", run: () => void navigator.clipboard.writeText(n.name) });
						items.push({
							label: "이름 복사(따옴표)",
							run: () => void navigator.clipboard.writeText(n.kind === "table" || n.kind === "view" ? qname(path[0], n.name) : quoteIdentFor(ctx.engine, n.name)),
						});
						if (n.kind === "schema") items.push({ label: "새로 읽기", run: () => load(p) });
						setMenu({ x: e.clientX, y: e.clientY, items });
					}}
					title={n.detail ?? n.name}
				>
					<ChevronRight size={12} className="chev" style={{ visibility: expandable ? "visible" : "hidden", transform: isOpen ? "rotate(90deg)" : undefined }} />
					{icon}
					<span>{n.name}</span>
					{n.detail && <small style={{ marginLeft: "auto", color: "var(--text-3)", paddingRight: 6 }}>{n.detail}</small>}
				</button>,
			);
			if (expandable && isOpen) walk(p, depth + 1);
		}
		if (list.length > cap)
			rows.push(
				<button key={`${path.join("/")}#more`} type="button" className="tree-row" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => setShown((x) => ({ ...x, [pk]: cap + TREE_CAP }))}>
					<span style={{ color: "var(--text-3)" }}>… 더 보기 (남은 {(list.length - cap).toLocaleString()}개)</span>
				</button>,
			);
	};
	walk([], 0);
	return (
		<div className="tree">
			<label className="tree-filter">
				<Search size={12} />
				<input
					value={filter}
					onChange={(e) => {
						setFilter(e.target.value);
						setShown({});
					}}
					placeholder="표·뷰 이름 거르기"
					spellCheck={false}
					onKeyDown={(e) => {
						if (e.key !== "Escape") return;
						setFilter("");
						setShown({});
					}}
				/>
			</label>
			<div className="tree-body">{rows}</div>
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
		</div>
	);
}

function HistoryDock() {
	const ctx = useDb();
	return <HistoryPanel scope={ctx.historyScope} onInsert={ctx.insertText} onRun={(sql) => ctx.run([sql])} />;
}
function ErdDock(props: IDockviewPanelProps<{ schema: string }>) {
	const ctx = useDb();
	return (
		<Suspense fallback={<div className="dock-watermark">불러오는 중…</div>}>
			<ErdPanelLazy conn={ctx.conn} engine={ctx.engine} schema={props.params.schema} storeKey={ctx.historyScope} />
		</Suspense>
	);
}
function CompareDock(props: IDockviewPanelProps<{ a: string; b: string }>) {
	const ctx = useDb();
	return <ComparePanel conn={ctx.conn} a={props.params.a} b={props.params.b} />;
}

/** 메시지 — 실행한 문장마다 시각·결과·걸린 시간 */
function MessagesPanel() {
	const ctx = useDb();
	const { messages } = useContext(LiveCtx);
	return (
		<div className="panel-fill">
			<div className="msg-list selectable">
				{messages.length === 0 && (
					<div className="panel-hint msg-empty">
						<div>
							<kbd>{MOD}</kbd>
							<kbd>Enter</kbd> 커서 문장 실행 · <kbd>{MOD}</kbd>
							<kbd>Shift</kbd>
							<kbd>Enter</kbd> 전체 실행
						</div>
						<div>결과는 이 묶음의 탭으로 열리고, 여기에는 시각·결과·걸린 시간이 쌓입니다.</div>
					</div>
				)}
				{messages.map((m, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 시간 순 기록
					<div key={i} className={`msg-row${m.ok ? "" : " bad"}`} title={m.sql}>
						<span className="msg-at">{new Date(m.at).toLocaleTimeString()}</span>
						<span className="msg-res">{m.ok ? "✓" : "✗"} {m.text}</span>
						{m.ms != null && <span className="msg-ms">{m.ms.toLocaleString()} ms</span>}
						<code className="msg-sql">{m.sql.replace(/\s+/g, " ").slice(0, 200)}</code>
						<button type="button" className="btn ghost icon" title="편집기로" onClick={() => ctx.openSql(m.sql)}>
							<Play size={12} />
						</button>
					</div>
				))}
			</div>
			<div className="statusbar">
				<span>{messages.length}개</span>
				<span style={{ marginLeft: "auto" }} />
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={ctx.clearMessages}>
					지우기
				</button>
			</div>
		</div>
	);
}

/** 파라미터 한 화면 — :이름·? 값을 모두 받는다(값은 이 창에서 기억) */
const lastParams: Record<string, string> = {};
function ParamSheet({ names, qCount, onDone }: { names: string[]; qCount: number; onDone: (v: Record<string, string> | null) => void }) {
	const keys = [...names.map((n) => n), ...Array.from({ length: qCount }, (_, i) => `?${i + 1}`)];
	const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, lastParams[k] ?? ""])));
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
			<form
				className="sheet"
				onSubmit={(e) => {
					e.preventDefault();
					Object.assign(lastParams, vals);
					onDone(vals);
				}}
				onKeyDown={(e) => e.key === "Escape" && onDone(null)}
			>
				<h3>파라미터</h3>
				<p className="hint" style={{ margin: "-8px 0 12px" }}>문자는 그대로(따옴표 없이), 숫자는 숫자로, 비우면 NULL</p>
				{keys.map((k, i) => (
					<div key={k} className="field">
						<label htmlFor={`pa-${i}`}>{k.startsWith("?") ? `${k.slice(1)}번째 ?` : `:${k}`}</label>
						<input id={`pa-${i}`} autoFocus={i === 0} value={vals[k] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} spellCheck={false} />
					</div>
				))}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => onDone(null)}>
						취소
					</button>
					<button type="submit" className="btn primary">
						실행
					</button>
				</div>
			</form>
		</div>
	);
}

/** 자동 LIMIT — LIMIT·TOP·FETCH·ROWNUM 이 없는 SELECT 에만 붙인다(SQL Server 는 건드리지 않음) */
function withLimit(engine: string, sql: string, n: number): string {
	const b = bare(sql).trim();
	if (!/^(select|with)\b/i.test(b) || /\b(limit|top|fetch\s+first|rownum|offset)\b/i.test(b) || /\binto\b/i.test(b)) return sql;
	const body = sql.replace(/;\s*$/, "");
	if (engine === "postgres" || engine === "mysql" || engine === "mariadb" || engine === "cubrid") return `${body}\nLIMIT ${n}`;
	if (engine === "oracle" || engine === "tibero") return `${body}\nFETCH FIRST ${n} ROWS ONLY`;
	return sql;
}

/** 지금 도는 쿼리·잠금·막는 관계 — 같은 연결을 쓰므로 쿼리 실행 중·트랜잭션 안에서는 기다렸다 읽는다 */
function ActivityDock(props: IDockviewPanelProps) {
	const ctx = useDb();
	const [visible, setVisible] = useState(props.api.isVisible);
	useEffect(() => {
		const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		return () => d.dispose();
	}, [props.api]);
	const busy = useRef(false);
	const { running } = useContext(LiveCtx);
	busy.current = running || ctx.inTx;
	const runSql = useCallback(
		async (sql: string) => {
			if (busy.current) throw new Error(ctx.inTx ? "이 연결에 열린 트랜잭션이 있어 잠깐 멈췄습니다 — 커밋·되돌리기 뒤에 다시 읽습니다" : "쿼리가 실행 중이라 끝난 뒤 다시 읽습니다");
			return queryRows(ctx.conn, sql, 2000);
		},
		[ctx.conn, ctx.inTx],
	);
	return <DbActivityPanel engine={ctx.engine} runSql={runSql} visible={visible} />;
}

/** 칸이 보이는지(가려진 탭이면 분석을 쉰다) */
function usePanelVisible(api: IDockviewPanelProps["api"]) {
	const [visible, setVisible] = useState(api.isVisible);
	useEffect(() => {
		const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
		// 처음 그린 뒤 듣기 전에 바뀌었을 수 있다(새로 연 칸이 곧바로 보이는 때) — 들은 뒤 한 번 맞춘다
		setVisible(api.isVisible);
		return () => d.dispose();
	}, [api]);
	return visible;
}
function useAnalyzeDeps() {
	const ctx = useDb();
	const { running } = useContext(LiveCtx);
	const { conn, engine, epoch, database, inTx } = ctx;
	return useMemo(() => ({ conn, engine, epoch, defaultSchema: database || null, running, inTx }), [conn, engine, epoch, database, running, inTx]);
}
/** 쿼리 분석 칸(구조·진단·인덱스) — 껍데기는 QueryAnalysis, 지도·튜닝 본문은 각 파일 */
function AnalysisDock(props: IDockviewPanelProps<{ tab?: AnalysisTab; seq?: number }>) {
	const ctx = useDb();
	const visible = usePanelVisible(props.api);
	const deps = useAnalyzeDeps();
	const { engine } = ctx;
	const [tab, setTab] = useState<AnalysisTab>(props.params?.tab ?? "map");
	// 도구 막대·명령 팔레트가 탭을 골라 열면(seq 가 바뀜) 그 탭으로
	// biome 없음 — seq 는 같은 탭을 다시 골라도 바꾸는 신호
	useEffect(() => {
		if (props.params?.tab) setTab(props.params.tab);
	}, [props.params?.tab, props.params?.seq]);
	const pick = useCallback(
		(t: AnalysisTab) => {
			setTab(t);
			// 배치에 함께 저장(다시 켜면 보던 탭으로) — seq 는 그대로
			props.api.updateParameters({ ...props.params, tab: t });
		},
		[props.api, props.params],
	);
	const actions = useMemo(
		() => ({ explain: ctx.explain, openSql: ctx.openSql, canAnalyze: engine === "postgres" || engine === "mysql" || engine === "mariadb", explainPair: ctx.explainPair }),
		[ctx.explain, ctx.openSql, ctx.explainPair, engine],
	);
	return (
		<Suspense fallback={<div className="dock-watermark">불러오는 중…</div>}>
			<QueryAnalysisLazy deps={deps} visible={visible} actions={actions} tab={tab} onTab={pick} database={ctx.database} serverVersion={ctx.version} />
		</Suspense>
	);
}

function ExplainDock(props: IDockviewPanelProps<{ ok: ExplainOk; sql: string; analyze: boolean }>) {
	return <ExplainView ok={props.params.ok} sql={props.params.sql} analyze={props.params.analyze} />;
}

const components = { objects: ObjectsPanel, sql: SqlPanel, result: ResultPanel, history: HistoryDock, erd: ErdDock, compare: CompareDock, messages: MessagesPanel, explain: ExplainDock, activity: ActivityDock, analysis: AnalysisDock };
/** 배치에 저장하는 칸 — 결과·계획·기록처럼 실행마다 생기는 칸은 빼고 뼈대만 */
const FIXED = /^(objects|sql-\d+|messages|analysis)$/;
/** 배치를 잠그면 닫기를 숨기는 구조 칸 */
const STRUCT = /^(objects|sql-1|res-\d+|messages)$/;

/** 쿼리 탭 줄 오른쪽 "+" — SQL 편집기가 있는 묶음에만 */
function SqlTabActions(props: IDockviewHeaderActionsProps) {
	const t = useContext(ToolCtx);
	if (!t || !props.panels.some((p) => p.id.startsWith("sql-"))) return null;
	return (
		<button type="button" className="btn ghost icon dbw-tab-add" onClick={() => t.act.current.newSql()} title="새 SQL 탭">
			<Plus size={14} />
		</button>
	);
}

const LockCtx = createContext({ locked: false, owner: "" });
function LockTab(props: IDockviewPanelHeaderProps) {
	const { locked, owner } = useContext(LockCtx);
	const id = props.api.id;
	const fixed = locked && STRUCT.test(id);
	// 반영하지 않은 표 편집이 있는 결과 칸은 닫기 전에 묻는다(가운데 단추·× 모두 이 함수를 거친다)
	const guard = /^res-\d+$/.test(id)
		? () => {
				const t = dirtyTitleOf(owner, editKey(id));
				if (okToDiscardEdits(t ? [t] : [], "이 탭을 닫으면")) props.api.close();
			}
		: undefined;
	return <DockviewDefaultTab {...props} hideClose={fixed} closeActionOverride={fixed ? () => undefined : guard} />;
}

/** 이 시간 동안 입력이 없으면 열린 트랜잭션을 되돌린다 */
const TX_IDLE_MS = 10 * 60_000;

/** 배치 판 — 2: 쿼리 분석 칸·메시지 칸이 기본 배치에 들어온 판(0.15) */
const LAYOUT_V = 2;
const ANALYSIS_TITLE = "쿼리 분석";

/** 쿼리 분석 칸 — SQL 편집기 오른쪽에 너비 0.32 쯤 */
function addAnalysis(d: DockviewApi, tab: AnalysisTab = "map") {
	// 작업대 오른쪽 끝에 위아래 통째로(편집기·메시지 묶음 옆) — 편집기 묶음 안쪽을 가르면 메시지 칸 위에만 끼었다
	const p = d.addPanel({ id: "analysis", component: "analysis", title: ANALYSIS_TITLE, params: { tab }, position: { direction: "right" } });
	const w = Math.min(Math.max(320, Math.round((d.width || 1200) * 0.3)), Math.round((d.width || 1200) * 0.45));
	requestAnimationFrame(() => p.api.setSize({ width: w }));
	return p;
}
/** 메시지 칸 — 편집기 아래(결과·실행 계획이 이 묶음의 탭으로 붙는다) */
function addMessages(d: DockviewApi) {
	const sqlRef = d.panels.find((p) => p.id.startsWith("sql-"));
	const p = d.addPanel({ id: "messages", component: "messages", title: "메시지", position: sqlRef ? { referencePanel: sqlRef.id, direction: "below" } : undefined });
	requestAnimationFrame(() => p.api.setSize({ height: Math.max(180, Math.round((d.height || 700) * 0.36)) }));
	return p;
}

function defaultLayout(d: DockviewApi) {
	d.clear();
	d.addPanel({ id: "objects", component: "objects", title: "객체", renderer: "always" });
	d.addPanel({ id: "sql-1", component: "sql", title: "SQL", params: { n: 1 }, renderer: "always", position: { referencePanel: "objects", direction: "right" } });
	addAnalysis(d);
	addMessages(d);
	d.getPanel("objects")?.api.setSize({ width: 260 });
	d.getPanel("sql-1")?.api.setActive();
}

type GridNode = { type: string; data: unknown; size?: number };
/**
 * 저장한 배치 다듬기 — 0.14 의 "쿼리 지도"·"튜닝" 두 칸은 "쿼리 분석" 한 칸으로 옮기고(먼저 나온 자리에, 보던 쪽 탭으로),
 * 남길 칸만 두고, 빈 묶음은 빼낸다(빈 묶음이 남으면 다음에 열 때 빈 칸이 생겼다). 뿌리까지 비면 null.
 */
function tidyLayout(raw: unknown): { panels: Record<string, Record<string, unknown>>; grid: { root: GridNode } } | null {
	const j = raw as { panels?: Record<string, Record<string, unknown>>; grid?: { root?: GridNode } };
	if (!j?.panels || !j.grid?.root) return null;
	const old = ["querymap", "tuning"].filter((id) => j.panels?.[id]);
	if (old.length && !j.panels.analysis) {
		const first = old[0];
		j.panels.analysis = { ...j.panels[first], id: "analysis", contentComponent: "analysis", title: ANALYSIS_TITLE, params: { tab: first === "tuning" ? "diag" : "map" } };
	}
	for (const id of old) delete j.panels[id];
	for (const id of Object.keys(j.panels)) if (!FIXED.test(id)) delete j.panels[id];
	// 칸 하나는 한 묶음에만(지도·튜닝이 다른 묶음에 있었으면 먼저 나온 쪽에 남는다)
	const placed = new Set<string>();
	const tidyGroup = (g: { views: string[]; activeView?: string }) => {
		g.views = g.views
			.map((x) => (x === "querymap" || x === "tuning" ? "analysis" : x))
			.filter((x) => {
				if (!FIXED.test(x) || !j.panels?.[x] || placed.has(x)) return false;
				placed.add(x);
				return true;
			});
		if (g.activeView === "querymap" || g.activeView === "tuning") g.activeView = "analysis";
		if (g.activeView && !g.views.includes(g.activeView)) g.activeView = g.views[0];
		return g.views.length > 0;
	};
	const keep = (node: GridNode): boolean => {
		if (node.type === "leaf") return tidyGroup(node.data as { views: string[]; activeView?: string });
		const kids = (node.data as GridNode[]).filter(keep);
		node.data = kids;
		return kids.length > 0;
	};
	if (!keep(j.grid.root)) return null;
	const fl = (j as { floatingGroups?: { data: { views: string[]; activeView?: string } }[] }).floatingGroups;
	if (fl) (j as { floatingGroups?: unknown[] }).floatingGroups = fl.filter((f) => tidyGroup(f.data));
	return j as { panels: Record<string, Record<string, unknown>>; grid: { root: GridNode } };
}

const TIMEOUTS = [
	{ value: 0, label: "없음" },
	{ value: 30_000, label: "30초" },
	{ value: 60_000, label: "1분" },
	{ value: 300_000, label: "5분" },
	{ value: 900_000, label: "15분" },
	{ value: 1_800_000, label: "30분" },
];

export function DbWorkbench({
	conn,
	engine,
	readOnly,
	version,
	profileId,
	active,
	features: featuresIn,
}: {
	conn: number;
	engine: string;
	readOnly: boolean;
	version: string;
	profileId?: number;
	active: boolean;
	/** 엔진이 지원하는 기능 — readOnlySession·cancel */
	features?: string[] | null;
}) {
	const features = featuresIn ?? [];
	const canCancel = features.includes("cancel");
	const dock = useRef<DockviewApi | null>(null);
	const editors = useRef(new Map<string, EditorView>());
	const lastEditor = useRef<string | null>(null);
	const [maxRows, setMaxRows] = useState(10_000);
	const [running, setRunning] = useState(false);
	const runningRef = useRef(false);
	runningRef.current = running;
	const [paramAsk, setParamAsk] = useState<{ names: string[]; qCount: number; resolve: (v: Record<string, string> | null) => void } | null>(null);
	const [messages, setMessages] = useState<Msg[]>([]);
	const addMsg = useCallback((m: Msg) => {
		setMessages((l) => [m, ...l].slice(0, 500));
		const d = dock.current;
		if (d && !d.getPanel("messages")) {
			const ref = d.panels.find((p) => p.id.startsWith("res-"));
			if (ref) d.addPanel({ id: "messages", component: "messages", title: "메시지", position: { referencePanel: ref.id, direction: "within" }, inactive: true });
		}
	}, []);
	const [autoLimit, setAutoLimit] = useState(false);
	const [confirmWrites, setConfirmWrites] = useState(false);
	const [timeoutMs, setTimeoutMs] = useState(0);
	const [pageSize, setPageSize] = useState(1000);
	const [fmtCase, setFmtCase] = useState<"upper" | "lower" | "preserve">("upper");
	const autoLimitRef = useRef(false);
	autoLimitRef.current = autoLimit;
	const confirmWritesRef = useRef(false);
	confirmWritesRef.current = confirmWrites;
	const timeoutRef = useRef(0);
	timeoutRef.current = timeoutMs;
	const pageSizeRef = useRef(1000);
	pageSizeRef.current = pageSize;
	useEffect(() => {
		void api.settingGet("db.autoLimit").then((v) => setAutoLimit(v === "1"));
		void api.settingGet("db.confirmWrites").then((v) => setConfirmWrites(v === "1"));
		void api.settingGet("db.timeout").then((v) => v && setTimeoutMs(Number(v) || 0));
		void api.settingGet("db.pageSize").then((v) => v && setPageSize(Number(v) || 1000));
		void api.settingGet("db.fmtCase").then((v) => (v === "lower" || v === "preserve" || v === "upper") && setFmtCase(v));
		// 설정 › 데이터베이스 에서 바꾸면 열린 작업대도 따라간다
		return onSettingLive(["db.autoLimit", "db.confirmWrites", "db.timeout", "db.pageSize", "db.fmtCase"], (k, v) => {
			if (k === "db.autoLimit") setAutoLimit(v === "1");
			else if (k === "db.confirmWrites") setConfirmWrites(v === "1");
			else if (k === "db.timeout") setTimeoutMs(Number(v) || 0);
			else if (k === "db.pageSize") setPageSize(Number(v) || 1000);
			else if (v === "lower" || v === "preserve" || v === "upper") setFmtCase(v);
		});
	}, []);
	const [txState, setTxState] = useState<TxState>({ inTx: false, stmts: 0, manual: false });
	const inTx = txState.inTx;
	const [closed, setClosed] = useState(false);
	const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
	const noticeTimer = useRef<number | undefined>(undefined);
	const showNotice = useCallback((text: string, bad = false) => {
		setNotice({ text, bad });
		window.clearTimeout(noticeTimer.current);
		if (!bad) noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
	}, []);
	const [askReq, setAskReq] = useState<{ req: AskReq; resolve: (v: string | null) => void } | null>(null);
	const ask = useCallback((req: AskReq) => new Promise<string | null>((resolve) => setAskReq({ req, resolve })), []);
	const [csvTarget, setCsvTarget] = useState<{ schema: string | null; table: string } | null>(null);
	const [epoch, setEpoch] = useState(0);
	const [ver, setVer] = useState(version);
	const [databases, setDatabases] = useState<string[]>([]);
	const [curDb, setCurDb] = useState("");
	const [locked, setLocked] = useLayoutLock("db");
	const lockedRef = useRef(locked);
	lockedRef.current = locked;
	const lastInput = useRef(Date.now());
	const historyScope = `db:${profileId ?? "adhoc"}`;
	const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
	const [snip, setSnip] = useState(false);
	const txOp = async (op: "begin" | "commit" | "rollback") => {
		try {
			setTxState(await db.tx(conn, op));
			showNotice(op === "commit" ? "커밋했습니다" : op === "rollback" ? "되돌렸습니다" : "트랜잭션을 열었습니다");
		} catch (e) {
			showNotice((e as DbError).message ?? String(e), true);
		}
	};
	const toggleManual = async () => {
		const next = !txState.manual;
		if (!next && txState.inTx) {
			if (!confirm(`열린 트랜잭션(${txState.stmts}문장)이 있습니다. 커밋하고 자동 커밋으로 돌아갈까요?`)) return;
			await txOp("commit");
		}
		try {
			setTxState(await db.txMode(conn, next));
		} catch (e) {
			showNotice((e as DbError).message ?? String(e), true);
		}
	};
	const sqlSeq = useRef(1);
	const saveTimer = useRef<number | undefined>(undefined);
	// MySQL 계열만(SQL Server·Oracle·Tibero 를 MySQL 로 보면 내보내기에서 역슬래시가 두 배가 되고 HEX() 가 없어 실패했다)
	const mysql = engine === "mysql" || engine === "mariadb";
	const maxRef = useRef(maxRows);
	maxRef.current = maxRows;

	// 결과 칸(표 편집 반영)이 바꾼 트랜잭션 상태
	useEffect(() => {
		const on = (e: Event) => {
			const d = (e as CustomEvent<{ conn: number; tx: TxState }>).detail;
			if (d.conn === conn) setTxState(d.tx);
		};
		window.addEventListener(TX_EVENT, on);
		return () => window.removeEventListener(TX_EVENT, on);
	}, [conn]);
	// 탭 닫기·앱 끄기 경고용 기록
	useEffect(() => {
		setOpenTx(conn, txState.inTx ? { stmts: txState.stmts, label: curDb ? `${curDb} (${ver})` : ver } : null);
	}, [conn, txState, curDb, ver]);
	useEffect(() => () => setOpenTx(conn, null), [conn]);
	// 열린 채 10분 입력이 없으면 되돌린다(잠금을 오래 쥐지 않게)
	useEffect(() => {
		if (!txState.inTx) return;
		const t = window.setInterval(async () => {
			if (Date.now() - lastInput.current < TX_IDLE_MS || runningRef.current) return;
			try {
				setTxState(await db.tx(conn, "rollback"));
				showNotice("10분 동안 입력이 없어 열린 트랜잭션을 되돌렸습니다(잠금을 오래 쥐지 않도록)", true);
			} catch {
				// 다음 차례에 다시
			}
		}, 30_000);
		return () => window.clearInterval(t);
	}, [txState.inTx, conn, showNotice]);
	// 받는 중 알림 — 실행마다 stream 번호로 그 결과 탭을 늘린다(끝난 뒤 늦게 온 알림은 버린다)
	const streams = useRef(new Map<number, (p: RowsProgress) => void>());
	useEffect(() => {
		const un = listen<RowsProgress>("db-rows-progress", (e) => streams.current.get(e.payload.stream)?.(e.payload));
		return () => void un.then((f) => f());
	}, []);
	// 연결 끊김
	useEffect(() => {
		const un = listen<{ conn: number }>("db-closed", (e) => {
			if (e.payload.conn !== conn) return;
			setClosed(true);
			setTxState((s) => ({ ...s, inTx: false, stmts: 0 }));
		});
		return () => void un.then((f) => f());
	}, [conn]);
	// PostgreSQL — 데이터베이스 목록·지금 데이터베이스
	useEffect(() => {
		if (engine !== "postgres") return;
		void (async () => {
			try {
				const cur = await queryRows(conn, "SELECT current_database()", 1);
				setCurDb(cur[0]?.[0] ?? "");
				setDatabases((await db.databases(conn)) ?? []);
			} catch {
				// 목록을 못 읽으면 고르기를 감춘다
			}
		})();
	}, [conn, engine]);

	const reconnect = async (database?: string) => {
		try {
			const r = await db.reconnect(conn, database);
			setVer(r.version);
			setClosed(false);
			completions.delete(conn);
			setEpoch((x) => x + 1);
			if (r.database) setCurDb(r.database);
			setTxState(await db.txMode(conn, txState.manual));
			showNotice(database ? `${database} 데이터베이스로 바꿨습니다` : "다시 연결했습니다");
		} catch (e) {
			showNotice(`다시 연결하지 못했습니다 — ${(e as DbError).message ?? String(e)}`, true);
		}
	};
	const switchDb = (name: string) => {
		if (name === curDb) return;
		if (txState.inTx && !confirm(`열린 트랜잭션(${txState.stmts}문장)이 있습니다. 데이터베이스를 바꾸면 되돌아갑니다. 계속할까요?`)) return;
		void reconnect(name);
	};

	const registerEditor = useCallback((id: string, v: EditorView | null) => {
		if (v) {
			editors.current.set(id, v);
			lastEditor.current = id;
		} else editors.current.delete(id);
	}, []);

	const currentEditor = () => {
		const d = dock.current;
		const visible = d?.panels.find((p) => p.id.startsWith("sql-") && p.api.isActive) ?? d?.panels.find((p) => p.id.startsWith("sql-") && p.api.isVisible);
		return editors.current.get(visible?.id ?? lastEditor.current ?? "") ?? [...editors.current.values()][0];
	};

	const run = useCallback(
		async (input: string[], source?: Source, tool?: string) => {
			const d = dock.current;
			if (!d || !input.length) return;
			// 이미 실행 중이면 무시 — 두 번째 실행이 받는 중인 결과를 닫고 BUSY 로 덮어 첫 결과가 빈칸이 되었다
			if (runningRef.current) return; // 실행 중 표시가 떠 있다 — 멈추려면 Esc
			lastInput.current = Date.now();
			// 파라미터 — :이름(문자열·주석 밖, ::형변환 제외)과 ?(PostgreSQL 은 JSON 연산자라 빼고) 를 한 화면에서
			const names = [...new Set(input.flatMap((x) => [...bare(x).matchAll(/(?<![:\w]):([A-Za-z_][\w]*)/g)].map((m) => m[1])))];
			const qCount = engine === "postgres" || tool ? 0 : input.reduce((a, x) => a + (bare(x).match(/\?/g)?.length ?? 0), 0);
			let values: Record<string, string> = {};
			if (names.length || qCount) {
				const got = await new Promise<Record<string, string> | null>((resolve) => setParamAsk({ names, qCount, resolve }));
				setParamAsk(null);
				if (!got) return;
				values = got;
			}
			const lit = (v: string) => (v === "" ? "NULL" : /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);
			let qi = 0;
			let stmts = input.map((x) => {
				let y = names.length ? x.replace(/(?<![:\w]):([A-Za-z_][\w]*)/g, (m, n) => (n in values ? lit(values[n]) : m)) : x;
				if (qCount) y = y.replace(/\?/g, () => lit(values[`?${++qi}`] ?? ""));
				return y;
			});
			// 자동 LIMIT — LIMIT·TOP·FETCH 없는 SELECT 에 행 상한을 서버 쪽에도
			if (autoLimitRef.current && !tool) stmts = stmts.map((x) => withLimit(engine, x, maxRef.current));
			// 판정은 백엔드 규칙 하나로(GRANT·REVOKE, 쓰기 EXPLAIN ANALYZE, WITH … DELETE 같은 쓰기 CTE 까지).
			// 읽기 전용 연결은 백엔드가 실행 자체를 거절한다.
			if (!tool) {
				const cls = await db.classify(stmts, engine).catch(() => null);
				if (cls) {
					const writes = stmts.filter((_, i) => cls[i]?.writes);
					if (confirmWritesRef.current && writes.length && !confirm(`쓰기 문장 ${writes.length}개를 실행합니다.\n\n${writes.map((x) => x.slice(0, 160)).join("\n\n")}`)) return;
					const risky = stmts.map((x, i) => ({ x, c: cls[i] })).filter((y) => y.c?.dangerous);
					if (risky.length && !confirm(`되돌리기 어려운 문장이 있습니다. 실행할까요?\n\n${risky.map((y) => `· ${y.c.reason}\n${y.x.slice(0, 200)}`).join("\n\n")}`)) return;
				}
			}
			// 결과 칸(res-N)은 이번 실행이 덮어쓰거나 닫는다 — 반영하지 않은 표 편집이 있으면 먼저 묻는다
			if (!okToDiscardEdits(dirtyTitles(dbOwner(conn)), "다시 실행하면")) return;
			// 쿼리 지도의 뒤 조회(인덱스·FK)가 이 연결을 쓰는 중이면 끝나기를 잠깐 기다린다(BUSY 방지)
			holdBackground(conn, true);
			await waitBackground(conn);
			setRunning(true);
			// 문장마다 결과 탭 하나(결과 1, 2…) — 남는 예전 탭은 닫는다
			const existing = d.panels.filter((p) => p.id.startsWith("res-"));
			for (const p of existing.slice(stmts.length)) {
				const rid = (p.params as ResultParams | undefined)?.ok?.resultId;
				if (rid) void db.closeResult(rid);
				d.removePanel(p);
			}
			for (let i = 0; i < stmts.length; i++) {
				const id = `res-${i + 1}`;
				const params: ResultParams = { sql: stmts[i], state: "running", at: Date.now(), source: stmts.length === 1 ? source : undefined, tool };
				let panel = d.getPanel(id);
				const oldRid = (panel?.params as ResultParams | undefined)?.ok?.resultId;
				if (oldRid) void db.closeResult(oldRid);
				if (panel) panel.api.updateParameters(params);
				else {
					// 결과는 결과·메시지 묶음의 탭으로(기본 배치는 편집기 아래 메시지 칸)
					const ref = d.panels.find((p) => p.id.startsWith("res-")) ?? d.getPanel("messages");
					const sqlRef = d.panels.find((p) => p.id.startsWith("sql-"));
					panel = d.addPanel({
						id,
						component: "result",
						title: stmts.length > 1 ? `결과 ${i + 1}` : "결과",
						params,
						// 같은 묶음의 다른 탭(결과 2·메시지)으로 갔다 와도 표 편집·고른 칸·스크롤이 남게 — 기본(보일 때만 그림)이면 가려질 때 내려가 반영 전 편집이 사라졌다
						renderer: "always",
						position: ref ? { referencePanel: ref.id, direction: "within" } : sqlRef ? { referencePanel: sqlRef.id, direction: "below" } : undefined,
					});
					if (!ref) panel.api.setSize({ height: 300 });
				}
				panel.api.setTitle(stmts.length > 1 ? `결과 ${i + 1}` : "결과");
				if (i === 0) panel.api.setActive();
				const token = ++streamSeq;
				const tab = panel;
				streams.current.set(token, (pr) =>
					tab.api.updateParameters({
						...params,
						state: "streaming",
						ok: { resultId: pr.resultId, columns: pr.columns, rowCount: pr.rowCount, truncated: false, ms: pr.ms, firstRowMs: pr.firstRowMs },
					}),
				);
				try {
					const ok = await db.query(conn, stmts[i], maxRef.current, timeoutRef.current, token).finally(() => streams.current.delete(token));
					if (ok.tx) setTxState(ok.tx);
					panel.api.updateParameters({ ...params, state: "ok", ok });
					const rows = `${ok.rowCount.toLocaleString()}행`;
					const text = ok.stopped
						? `${ok.stopped === "cancelled" ? "취소됨" : ok.stopped === "timeout" ? "시간 상한" : "메모리 상한에서 멈춤"} · 받은 ${rows}`
						: ok.resultId
							? `${rows}${ok.truncated ? "(상한에서 멈춤)" : ""}`
							: ok.affected != null
								? `${ok.affected.toLocaleString()}행 반영`
								: "완료";
					addMsg({ at: Date.now(), sql: stmts[i], ok: !ok.stopped || ok.stopped === "memory", ms: ok.ms, text });
					// 표·열을 만들거나 바꿨으면 완성 이름 기억을 새로(열린 편집기는 다음 완성 때 다시 읽는다)
					if (!ok.stopped && isDdl(stmts[i])) forgetCompletion(conn);
					if (!tool) void invoke("history_add", { scope: historyScope, item: { sql: stmts[i], ms: ok.ms, rows: ok.rowCount, ok: true } }).then(() => window.dispatchEvent(new Event("rb-history")));
					if (ok.stopped === "memory") showNotice(`결과가 너무 커서(메모리 어림 512MB) ${rows}에서 멈췄습니다 — 조건이나 LIMIT 으로 줄여 보세요`, true);
					// 취소·시간 상한이면 남은 문장은 실행하지 않는다(받은 행은 이 탭에 남는다)
					if (ok.stopped === "cancelled" || ok.stopped === "timeout") {
						for (const rest of d.panels.filter((p) => p.id.startsWith("res-") && Number(p.id.slice(4)) > i + 1)) {
							const old = (rest.params as ResultParams | undefined)?.ok?.resultId;
							if (old) void db.closeResult(old);
							d.removePanel(rest);
						}
						break;
					}
				} catch (e) {
					const err = e as DbError;
					panel.api.updateParameters({ ...params, state: "error", error: err });
					addMsg({ at: Date.now(), sql: stmts[i], ok: false, text: err.message ?? String(e) });
					if (!tool) void invoke("history_add", { scope: historyScope, item: { sql: stmts[i], ok: false } }).then(() => window.dispatchEvent(new Event("rb-history")));
					if (err.code === "CLOSED" || err.code === "NETWORK") setClosed(true);
					void db
						.txState(conn)
						.then(setTxState)
						.catch(() => undefined);
					// 여러 문장이면 첫 오류에서 멈춘다
					for (const rest of d.panels.filter((p) => p.id.startsWith("res-") && Number(p.id.slice(4)) > i + 1)) d.removePanel(rest);
					break;
				}
			}
			setRunning(false);
			lastInput.current = Date.now();
			currentEditor()?.focus();
		},
		[conn, historyScope, engine, addMsg, showNotice],
	);

	const openTable = useCallback(
		(src: Source) => {
			const s: Source = { ...src, offset: src.offset ?? 0, limit: src.limit ?? pageSizeRef.current };
			const q = qualified(engine, s.schema, s.table);
			const order = s.order ? `${quoteIdentFor(engine, s.order.col)} ${s.order.desc ? "DESC" : "ASC"}` : undefined;
			void run([pagedSelect(engine, q, { where: s.where, order, offset: s.offset ?? 0, limit: s.limit ?? 1000 })], s);
		},
		[engine, run],
	);

	const insertText = useCallback((s: string) => {
		const v = currentEditor();
		if (!v) return;
		v.dispatch({ changes: { from: v.state.selection.main.head, insert: s } });
		v.focus();
	}, []);

	const openSql = useCallback((text: string, title?: string) => {
		const d = dock.current;
		if (!d) return;
		sqlSeq.current += 1;
		const n = sqlSeq.current;
		const ref = d.panels.find((p) => p.id.startsWith("sql-"));
		d.addPanel({ id: `sql-${n}`, component: "sql", title: title ?? `SQL ${n}`, params: { n, initial: text }, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
	}, []);

	const openPanel = useCallback((id: string, component: string, title: string, params: object) => {
		const d = dock.current;
		if (!d) return;
		const ex = d.getPanel(id);
		if (ex) return void ex.api.setActive();
		const ref = d.panels.find((p) => p.id.startsWith("sql-"));
		d.addPanel({ id, component, title, params, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
	}, []);

	/** 쿼리 분석 칸 — 있으면 그 탭으로, 없으면 SQL 편집기 오른쪽에 연다 */
	const analysisSeq = useRef(0);
	const [analysisOpen, setAnalysisOpen] = useState(false);
	const openAnalysis = useCallback((tab?: AnalysisTab) => {
		const d = dock.current;
		if (!d) return;
		const ex = d.getPanel("analysis");
		if (ex) {
			if (tab) ex.api.updateParameters({ ...(ex.params ?? {}), tab, seq: ++analysisSeq.current });
			return void ex.api.setActive();
		}
		addAnalysis(d, tab);
	}, []);
	/** 쿼리 분석 칸 켜고 끄기(도구 막대 단추·명령 팔레트) */
	const toggleAnalysis = useCallback(() => {
		const d = dock.current;
		const ex = d?.getPanel("analysis");
		if (ex) {
			// 가려진 탭이면 끄지 않고 앞으로
			if (!ex.api.isVisible) return void ex.api.setActive();
			ex.api.close();
		} else openAnalysis();
	}, [openAnalysis]);

	const runTool = (t: Tool) => {
		const sql = toolSql(engine, t);
		if (sql) void run([sql], undefined, t);
	};

	const findObjects = async () => {
		const q = await ask({ title: "객체 찾기", message: "표·뷰·열 이름에 들어간 말을 찾습니다", placeholder: "찾을 말", okLabel: "찾기" });
		const sql = q ? searchSql(engine, q) : null;
		if (sql) void run([sql], undefined, "search");
	};

	/** 실행 계획 — 트리로(PostgreSQL·MySQL·MariaDB·SQL Server), 그 밖 엔진은 결과 탭에 글로 */
	const explain = async (analyze = false, from?: EditorView | null) => {
		const v = from ?? currentEditor();
		if (!v) return;
		const st = pickStatements(v, false)[0];
		if (!st) return;
		const tree = engine === "postgres" || engine === "mysql" || engine === "mariadb" || engine === "mssql";
		if (!tree) {
			if (analyze) return showNotice("이 엔진은 실제 실행 계획(ANALYZE)을 지원하지 않습니다", true);
			const sqls = explainSql(engine, st);
			if (sqls) void run(sqls, undefined, "explain");
			return;
		}
		if (analyze) {
			if (engine === "mssql") return showNotice("SQL Server 는 예상 계획만 봅니다", true);
			const c = (await db.classify([st], engine).catch(() => null))?.[0];
			const warn = c?.writes
				? "실제 실행 계획(ANALYZE)은 문장을 실제로 실행합니다.\n쓰기 문장이라 실행한 뒤 되돌리지만, 시간이 걸리고 그동안 잠금이 잡힙니다.\n\n계속할까요?"
				: "실제 실행 계획(ANALYZE)은 문장을 실제로 실행해 시간을 잽니다. 오래 걸리는 문장이면 그만큼 기다립니다.\n\n계속할까요?";
			if (!confirm(warn)) return;
		}
		holdBackground(conn, true);
		await waitBackground(conn);
		setRunning(true);
		try {
			const ok = await db.explain(conn, st, analyze);
			publishPlan(conn, st, ok, analyze);
			const d = dock.current;
			if (!d) return;
			const params = { ok, sql: st, analyze };
			const title = analyze ? "실제 계획" : "실행 계획";
			const ex = d.getPanel("explain");
			if (ex) {
				ex.api.updateParameters(params);
				ex.api.setTitle(title);
				ex.api.setActive();
			} else {
				const ref = d.panels.find((p) => p.id.startsWith("res-")) ?? d.getPanel("messages");
				const sqlRef = d.panels.find((p) => p.id.startsWith("sql-"));
				const p = d.addPanel({
					id: "explain",
					component: "explain",
					title,
					params,
					position: ref ? { referencePanel: ref.id, direction: "within" } : sqlRef ? { referencePanel: sqlRef.id, direction: "below" } : undefined,
				});
				if (!ref) p.api.setSize({ height: 320 });
			}
		} catch (e) {
			showNotice((e as DbError).message ?? String(e), true);
		} finally {
			setRunning(false);
		}
	};

	const explainRef = useRef(explain);
	explainRef.current = explain;

	/** 튜닝 비교 — 두 문장의 계획을 차례로. 실행 중 표시를 올려 Esc 로 멈출 수 있게 */
	const explainPair = useCallback(
		async (a: string, b: string, analyze: boolean): Promise<[ExplainOk, ExplainOk] | null> => {
			if (runningRef.current) throw new Error("쿼리가 실행 중입니다 — 끝난 뒤 다시 하세요");
			// PostgreSQL 트랜잭션 안에서 EXPLAIN 이 실패하면 트랜잭션 전체가 깨진다
			if (engine === "postgres" && txState.inTx) throw new Error("열린 트랜잭션이 있어 비교 EXPLAIN 을 하지 않습니다 — 커밋·되돌리기 뒤에 하세요");
			if (analyze) {
				const cls = await db.classify([a, b], engine).catch(() => null);
				const writes = cls?.some((c) => c.writes);
				if (!confirm(`두 문장을 실제로 실행해 시간을 잽니다${writes ? "(쓰기 문장은 실행한 뒤 되돌리지만 그동안 잠금이 잡힙니다)" : ""}.\n오래 걸리는 문장이면 그만큼 기다립니다.\n\n계속할까요?`)) return null;
			}
			holdBackground(conn, true);
			await waitBackground(conn);
			setRunning(true);
			try {
				const x = await db.explain(conn, a, analyze);
				const y = await db.explain(conn, b, analyze);
				return [x, y];
			} finally {
				setRunning(false);
				holdBackground(conn, false);
			}
		},
		[conn, engine, txState.inTx],
	);

	const addSql = () => {
		const d = dock.current;
		if (!d) return;
		sqlSeq.current += 1;
		const n = sqlSeq.current;
		const ref = d.panels.find((p) => p.id.startsWith("sql-"));
		d.addPanel({ id: `sql-${n}`, component: "sql", title: `SQL ${n}`, params: { n }, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
	};

	const formatNow = (from?: EditorView | null) => {
		const v = from ?? currentEditor();
		if (v) void formatSqlIn(v, engine, fmtCase).then((ok) => !ok && showNotice("정렬하지 못했습니다 — 이 방언이 읽지 못하는 문장이 있습니다", true));
	};

	/** 결과 칸 최대화·되돌리기(Alt+M) */
	const toggleMax = () => {
		const d = dock.current;
		if (!d) return;
		if (d.hasMaximizedGroup()) return d.exitMaximizedGroup();
		const p = d.panels.find((x) => (x.id.startsWith("res-") || x.id === "explain") && x.api.isVisible) ?? d.activePanel;
		if (p) d.maximizeGroup(p);
	};

	/** 기본 배치 — 객체 | 편집기(위)·메시지(아래) | 쿼리 분석 */
	const resetLayout = () => {
		const d = dock.current;
		if (!d || lockedRef.current) return;
		if (!okToDiscardEdits(dirtyTitles(dbOwner(conn)), "기본 배치로 되돌리면 결과 칸이 닫혀")) return;
		defaultLayout(d);
	};

	// 명령 팔레트(Ctrl+Shift+P) — 이 DB 작업대가 앞에 있을 때만
	useCommands(`db:${conn}`, active, () => [
		{ id: "db.runCur", group: "db", title: "SQL 실행(커서 문장)", keys: "Mod+Enter", run: () => {
			const v = lastEditor.current ? editors.current.get(lastEditor.current) : undefined;
			if (v) run(pickStatements(v, false));
		} },
		{ id: "db.runAll", group: "db", title: "SQL 전체 실행", keys: "Shift+Mod+Enter", run: () => {
			const v = lastEditor.current ? editors.current.get(lastEditor.current) : undefined;
			if (v) run(pickStatements(v, true));
		} },
		{ id: "db.cancel", group: "db", title: "실행 멈추기", keys: "Esc", run: () => void db.cancel(conn), disabled: !running },
		{ id: "db.newSql", group: "db", title: "새 SQL 탭", run: () => openSql("", undefined) },
		{ id: "db.explain", group: "db", title: "실행 계획(커서 문장)", keys: "Mod+E", run: () => void explain(false) },
		{ id: "db.find", group: "db", title: "객체 찾기", keys: "Alt+O", run: () => void findObjects() },
		{ id: "db.analysis", group: "db", title: analysisOpen ? "쿼리 분석 칸 끄기" : "쿼리 분석 칸 켜기", hint: "구조(쿼리 지도)·진단·인덱스 초안 — 편집기 오른쪽", run: toggleAnalysis },
		{ id: "db.queryMap", group: "db", title: "쿼리 분석 — 구조(쿼리 지도)", hint: "치는 동안 표·조인·조건을 그림으로(서버에 묻지 않음)", run: () => openAnalysis("map") },
		{ id: "db.tuning", group: "db", title: "쿼리 분석 — 진단(튜닝 도우미)", hint: "구조·정적 검사·실행 계획 규칙", run: () => openAnalysis("diag") },
		{ id: "db.indexDraft", group: "db", title: "쿼리 분석 — 인덱스 초안", hint: "WHERE·JOIN·ORDER 열에 맞춘 CREATE INDEX 초안(실행하지 않음)", run: () => openAnalysis("index") },
		{ id: "db.cleanup", group: "db", title: "쿼리 분석 — 다듬기", hint: "지저분한 쿼리를 구조째 정리(쉼표 조인·(+)·중첩 서브쿼리·중복 조건) — 바꾼 곳마다 켜고 끄기·결과 같은지 확인", run: () => openAnalysis("cleanup") },
		{ id: "db.format", group: "db", title: "SQL 포맷", keys: "Shift+Alt+F", run: () => formatNow() },
		{ id: "db.snippets", group: "db", title: "즐겨찾는 SQL(스니펫)", run: () => setSnip(true) },
		{ id: "db.layoutReset", group: "db", title: "DB 작업대 기본 배치로", disabled: locked, run: resetLayout },
		{ id: "db.history", group: "db", title: "쿼리 기록", keys: "Alt+H", run: () => openPanel("history", "history", "기록", {}) },
		{ id: "db.activity", group: "db", title: "실행 중 쿼리·잠금 감시", hint: "막는 관계·쿼리 끊기", run: () => openPanel("activity", "activity", "활동", {}) },
		{ id: "db.sizes", group: "db", title: "표 크기", run: () => runTool("sizes"), disabled: !toolSql(engine, "sizes") },
		{ id: "db.max", group: "db", title: "결과 최대화·되돌리기", keys: "Alt+M", run: toggleMax },
		{ id: "db.lock", group: "db", title: locked ? "배치 잠금 풀기" : "배치 잠그기", keys: "Mod+Alt+L", run: () => setLocked(!locked) },
	]);

	const layoutKey = "layout.db";
	const onReady = (e: DockviewReadyEvent) => {
		dock.current = e.api;
		const syncOpen = () => setAnalysisOpen(!!e.api.getPanel("analysis"));
		e.api.onDidAddPanel(syncOpen);
		e.api.onDidRemovePanel(syncOpen);
		void api.settingGet(layoutKey).then((saved) => {
			let ok = false;
			if (saved) {
				try {
					const raw = JSON.parse(saved) as { rbLayout?: number };
					const v = raw.rbLayout ?? 1;
					delete raw.rbLayout;
					const j = tidyLayout(raw);
					if (j) {
						e.api.fromJSON(j as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
						ok = !!e.api.getPanel("objects") || e.api.panels.some((p) => p.id.startsWith("sql-"));
					}
					for (const p of e.api.panels) {
						const m = /^sql-(\d+)$/.exec(p.id);
						if (m) sqlSeq.current = Math.max(sqlSeq.current, Number(m[1]));
					}
					// 0.14 까지의 배치 — 새 기본 칸(쿼리 분석·메시지)을 한 번 넣어 준다(그 뒤로는 끈 대로 둔다)
					if (ok && v < LAYOUT_V) {
						if (!e.api.getPanel("messages")) addMessages(e.api);
						if (!e.api.getPanel("analysis")) addAnalysis(e.api);
					}
				} catch {
					ok = false;
				}
			}
			if (!ok) defaultLayout(e.api);
			syncOpen();
		});
		// 결과 칸을 닫으면 백엔드에 남은 결과 행(최대 수백 MB)도 놓는다 — 안 놓으면 큰 SELECT 를 거듭할수록 앱 메모리가 계속 늘었다
		e.api.onDidRemovePanel((p) => {
			const rid = (p.params as ResultParams | undefined)?.ok?.resultId;
			if (rid) void db.closeResult(rid);
		});
		e.api.onDidLayoutChange(() => {
			window.clearTimeout(saveTimer.current);
			saveTimer.current = window.setTimeout(() => {
				const d = dock.current;
				if (!d) return;
				// 뼈대 칸만 남기고 빈 묶음은 뺀다(결과만 있던 묶음이 다음에 빈 칸으로 남지 않게)
				const j = tidyLayout(structuredClone(d.toJSON()));
				if (!j) return;
				void api.settingSet(layoutKey, JSON.stringify({ ...j, rbLayout: LAYOUT_V }));
			}, 600);
		});
	};

	useEffect(() => {
		if (active) requestAnimationFrame(() => currentEditor()?.focus());
	}, [active]);
	// 단축키 — Alt+O 객체 찾기, Alt+H 기록, Alt+1/2/3 객체·편집기·결과로, Alt+M 결과 최대화, Ctrl+Alt+L 배치 잠금
	// 처리기는 렌더마다 ref 에 최신 것을 넣고, window 에는 한 번만 단다(예전엔 deps 없는 effect 라 렌더마다 떼었다 붙였다)
	const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
	useEffect(() => {
		if (!active) return;
		const h = (e: KeyboardEvent) => keyRef.current(e);
		window.addEventListener("keydown", h);
		return () => window.removeEventListener("keydown", h);
	}, [active]);
	keyRef.current = (e: KeyboardEvent) => {
		const d = dock.current;
		if (e.altKey && (e.ctrlKey || e.metaKey) && e.code === "KeyL") {
			e.preventDefault();
			setLocked(!lockedRef.current);
			return;
		}
		if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.code === "KeyO") {
			e.preventDefault();
			void findObjects();
		} else if (e.code === "KeyH") {
			e.preventDefault();
			const h = d?.getPanel("history");
			if (h?.api.isActive) h.api.close();
			else openPanel("history", "history", "기록", {});
		} else if (e.code === "Digit1") {
			e.preventDefault();
			d?.getPanel("objects")?.api.setActive();
			requestAnimationFrame(() => (document.querySelector(".tree-filter input") as HTMLElement | null)?.focus());
		} else if (e.code === "Digit2") {
			e.preventDefault();
			const v = currentEditor();
			const pid = [...editors.current.entries()].find(([, x]) => x === v)?.[0];
			if (pid) d?.getPanel(pid)?.api.setActive();
			v?.focus();
		} else if (e.code === "Digit3") {
			e.preventDefault();
			const r = d?.panels.find((p) => p.id.startsWith("res-") && p.api.isVisible) ?? d?.getPanel("res-1");
			r?.api.setActive();
			requestAnimationFrame(() => (document.querySelector(".dv-active-group .grid-scroll") as HTMLElement | null)?.focus());
		} else if (e.code === "KeyM") {
			e.preventDefault();
			toggleMax();
		}
	};

	const ctx = useMemo<Ctx>(
		() => ({
			conn,
			engine,
			mysql,
			readOnly,
			inTx,
			run: (s, src, tool) => void run(s, src, tool),
			insertText,
			registerEditor,
			openSql,
			openPanel,
			historyScope,
			draftKey: `sql.draft.${profileId ?? "adhoc"}`,
			explain: () => void explainRef.current(false),
			cancel: () => void db.cancel(conn),
			isRunning: () => runningRef.current,
			clearMessages: () => setMessages([]),
			openTable,
			ask,
			epoch,
			notice: (m) => showNotice(m),
			importCsv: (schema, table) => setCsvTarget({ schema, table }),
			locked,
			database: curDb,
			version: ver,
			openAnalysis,
			explainPair,
		}),
		[conn, engine, mysql, readOnly, inTx, run, insertText, registerEditor, openSql, openPanel, historyScope, profileId, openTable, ask, epoch, showNotice, locked, curDb, ver, openAnalysis, explainPair],
	);
	const live = useMemo<Live>(() => ({ running, messages }), [running, messages]);
	// 실행이 끝나면 뒤 조회(쿼리 지도 메타데이터)를 다시 허락
	useEffect(() => {
		if (!running) holdBackground(conn, false);
	}, [running, conn]);
	const lockValue = useMemo(() => ({ locked, owner: dbOwner(conn) }), [locked, conn]);
	// 이 작업대가 사라지면 남은 편집 기록도 지운다(칸마다 지우지만 한 번 더)
	useEffect(
		() => () => {
			forgetOwner(dbOwner(conn));
			forgetWatch(conn);
		},
		[conn],
	);

	const tick = (on: boolean) => (on ? "✓ " : "　");

	// 편집기 도구 막대 — 동작은 ref 로(렌더마다 새 함수라도 막대는 상태값이 바뀔 때만 다시 그린다)
	const toolActs = useRef<ToolActs>(null as unknown as ToolActs);
	toolActs.current = {
		run: (v, all) => {
			const ed = v ?? currentEditor();
			if (ed) void run(pickStatements(ed, all));
		},
		explain: (v, analyze) => void explain(analyze, v),
		cancel: () => void db.cancel(conn),
		format: (v) => formatNow(v),
		toggleAnalysis,
		history: () => openPanel("history", "history", "기록", {}),
		snippets: () => setSnip(true),
		find: () => void findObjects(),
		tools: (x, y) => setToolsMenu({ x, y }),
		setAutoLimit: (on) => {
			setAutoLimit(on);
			setSettingLive("db.autoLimit", on ? "1" : "0");
		},
		setMaxRows,
		setTimeoutMs: (v) => {
			setTimeoutMs(v);
			setSettingLive("db.timeout", String(v));
		},
		toggleManual: () => void toggleManual(),
		tx: (op) => void txOp(op),
		newSql: addSql,
	};
	const engineLabel = ENGINES.find((x) => x.key === engine)?.label ?? engine;
	const treeExplain = engine === "postgres" || engine === "mysql" || engine === "mariadb" || engine === "mssql";
	const toolState = useMemo<ToolState>(
		() => ({
			autoLimit,
			maxRows,
			timeoutMs,
			manual: txState.manual,
			inTx: txState.inTx,
			txStmts: txState.stmts,
			closed,
			readOnly,
			canCancel,
			canExplain: treeExplain || !!explainSql(engine, "x"),
			canAnalyze: engine === "postgres" || engine === "mysql" || engine === "mariadb",
			analysisOpen,
			act: toolActs,
		}),
		[autoLimit, maxRows, timeoutMs, txState, closed, readOnly, canCancel, treeExplain, engine, analysisOpen],
	);

	return (
		<DbCtx.Provider value={ctx}>
			<LiveCtx.Provider value={live}>
			<LockCtx.Provider value={lockValue}>
			<ToolCtx.Provider value={toolState}>
				<div
					className="wb-dock-shell"
					onKeyDownCapture={() => {
						lastInput.current = Date.now();
					}}
					onPointerDownCapture={() => {
						lastInput.current = Date.now();
					}}
				>
					{/* 연결 머리 — 지금 데이터베이스·서버 판·읽기 전용, 오른쪽 끝에 배치 */}
					<div className="wb-bar dbw-head">
						<span className="dbw-conn" title={`${engineLabel} · ${ver}`}>
							<Database size={14} />
							{databases.length > 1 ? (
								<Select
									size="sm"
									value={curDb}
									onChange={switchDb}
									title="데이터베이스 바꾸기 — 같은 서버의 다른 데이터베이스로 다시 연결"
									aria-label="데이터베이스"
									options={(databases.includes(curDb) ? databases : [curDb, ...databases]).map((n) => ({ value: n, label: n }))}
								/>
							) : (
								<b>{curDb || engineLabel}</b>
							)}
							<span className="dbw-ver">{ver}</span>
						</span>
						{readOnly && (
							<span
								className="badge warn"
								title={features.includes("readOnlySession") ? "세션 READ ONLY + 조회 문장만(앱 안쪽에서 판정)" : "이 엔진은 세션을 읽기 전용으로 못 바꿔 조회 문장 판별로만 막습니다. 확실히 하려면 읽기 전용 계정을 쓰세요."}
							>
								<Lock size={11} /> 읽기 전용{features.includes("readOnlySession") ? "" : "(문장 판별)"}
							</span>
						)}
						{confirmWrites && (
							<span className="badge" title="쓰기 확인 켜짐 — INSERT·UPDATE·DELETE·DDL·GRANT 를 실행 전에 모두 묻습니다(도구 메뉴에서 끔)">
								쓰기 확인
							</span>
						)}
						{running && (
							<span className="dbw-running" title="실행 중 — Esc 로 멈춤">
								<span className="db-streaming-dot" /> 실행 중
							</span>
						)}
						<span style={{ flex: 1 }} />
						<button type="button" className="btn ghost" title={locked ? "배치가 잠겨 있습니다(풀어야 초기화)" : "칸 배치를 기본으로(객체 | 편집기·메시지 | 쿼리 분석)"} disabled={locked} onClick={resetLayout}>
							<LayoutTemplate size={14} /> <span className="lbl">기본 배치</span>
						</button>
						<LayoutLockButton locked={locked} onChange={setLocked} />
					</div>
					{closed && (
						<div className="db-notice bad">
							<span className="grow">DB 연결이 끊겼습니다. 열려 있던 트랜잭션은 서버가 되돌렸습니다.</span>
							<button type="button" className="btn primary" style={{ height: 22 }} onClick={() => void reconnect()}>
								다시 연결
							</button>
						</div>
					)}
					{notice && !closed && (
						<div className={`db-notice${notice.bad ? " bad" : ""}`}>
							<span className="grow">{notice.text}</span>
							<button type="button" className="btn ghost" style={{ height: 22 }} onClick={() => setNotice(null)}>
								닫기
							</button>
						</div>
					)}
					<div className="wb-dock">
						<DockviewReact theme={theme} components={components} onReady={onReady} disableDnd={locked} locked={locked} defaultTabComponent={LockTab} leftHeaderActionsComponent={SqlTabActions} />
					</div>
					{toolsMenu && (
						<ContextMenu
							x={toolsMenu.x}
							y={toolsMenu.y}
							onClose={() => setToolsMenu(null)}
							items={[
								{ label: "쿼리 분석 — 구조(쿼리 지도)", run: () => openAnalysis("map") },
								{ label: "쿼리 분석 — 진단(튜닝)", run: () => openAnalysis("diag") },
								{ label: "쿼리 분석 — 인덱스 초안", run: () => openAnalysis("index") },
{ label: "쿼리 분석 — 다듬기", run: () => openAnalysis("cleanup") },
								{ sep: true },
								{ label: "표 크기", run: () => runTool("sizes"), disabled: !toolSql(engine, "sizes") },
								{ label: "세션(우클릭으로 멈추기·끊기)", run: () => runTool("sessions"), disabled: !toolSql(engine, "sessions") },
								{ label: "잠금 기다림", run: () => runTool("locks"), disabled: !toolSql(engine, "locks") },
								{ label: "실행 중 쿼리·잠금 감시(자동 새로 고침)", run: () => openPanel("activity", "activity", "활동", {}) },
								{ label: "읽기 전용 계정 만들기 SQL", run: () => readOnlyUserSql(engine, null) && openSql(readOnlyUserSql(engine, null) as string, "읽기 전용 계정"), disabled: !readOnlyUserSql(engine, null) },
								{ sep: true },
								{
									label: `${tick(confirmWrites)}쓰기 확인 — 쓰기 문장을 실행 전에 묻기`,
									run: () => {
										setConfirmWrites(!confirmWrites);
										setSettingLive("db.confirmWrites", confirmWrites ? "0" : "1");
									},
								},
								...[100, 500, 1000, 5000, 10_000].map((n) => ({
									label: `${tick(pageSize === n)}표 보기 한 쪽 — ${n.toLocaleString()}행`,
									run: () => {
										setPageSize(n);
										setSettingLive("db.pageSize", String(n));
									},
								})),
								{ sep: true },
								{ label: "새 SQL 탭", run: addSql },
								{ label: "결과 최대화·되돌리기  Alt+M", run: toggleMax },
								{ label: "기본 배치로", run: resetLayout, disabled: locked },
								{ label: `${locked ? "배치 잠금 풀기" : "배치 잠그기"}  Ctrl+Alt+L`, run: () => setLocked(!locked) },
								{ sep: true },
								...(["upper", "lower", "preserve"] as const).map((c) => ({
									label: `${tick(fmtCase === c)}정렬 키워드 — ${c === "upper" ? "대문자" : c === "lower" ? "소문자" : "그대로"}`,
									run: () => {
										setFmtCase(c);
										setSettingLive("db.fmtCase", c);
									},
								})),
							]}
						/>
					)}
					{snip && (
						<SnippetPalette
							kind="sql"
							onClose={() => setSnip(false)}
							onPick={(body, go) => {
								setSnip(false);
								if (go) void run(splitSql(body).map((x) => x.text));
								else insertText(body);
							}}
							currentLine={() => {
								const v = currentEditor();
								if (!v) return "";
								const sel = v.state.selection.main;
								return sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to);
							}}
						/>
					)}
				</div>
				{paramAsk && <ParamSheet names={paramAsk.names} qCount={paramAsk.qCount} onDone={paramAsk.resolve} />}
				{askReq && (
					<AskSheet
						req={askReq.req}
						onDone={(v) => {
							askReq.resolve(v);
							setAskReq(null);
						}}
					/>
				)}
				{csvTarget && (
					<ImportCsvSheet
						conn={conn}
						engine={engine}
						schema={csvTarget.schema}
						table={csvTarget.table}
						onClose={() => setCsvTarget(null)}
						onDone={(m) => {
							setCsvTarget(null);
							showNotice(m);
							void db
								.txState(conn)
								.then(setTxState)
								.catch(() => undefined);
						}}
					/>
				)}
			</ToolCtx.Provider>
			</LockCtx.Provider>
			</LiveCtx.Provider>
		</DbCtx.Provider>
	);
}

/** 칸 값 보기 — 긴 글·JSON(정리해 보기)·NULL 과 빈 문자열 구분, 복사 */
function ValueSheet({ col, value, onClose }: { col: string; value: string | null; onClose: () => void }) {
	const [pretty, setPretty] = useState(true);
	let json: string | null = null;
	if (value && /^\s*[[{]/.test(value)) {
		try {
			json = JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			json = null;
		}
	}
	const shown = value === null ? "" : json && pretty ? json : value;
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<div className="sheet" style={{ width: "min(760px, calc(100vw - 32px))" }}>
				<div className="sheet-title">
					<h3 style={{ fontFamily: "var(--font-mono)" }}>{col}</h3>
					<small style={{ color: "var(--text-3)" }}>
						{value === null ? "NULL" : value === "" ? "빈 문자열" : `${[...value].length.toLocaleString()}자${json ? " · JSON" : ""}`}
					</small>
				</div>
				{value === null ? (
					<p className="null-note">NULL — 값이 없습니다(빈 문자열과 다름)</p>
				) : (
					<textarea className="fp value-view" readOnly autoFocus value={shown} spellCheck={false} />
				)}
				<div className="sheet-actions">
					{json && (
						<label className="check" style={{ margin: 0, marginRight: "auto" }}>
							<input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> JSON 정리해 보기
						</label>
					)}
					<button type="button" className="btn" disabled={value === null} onClick={() => void navigator.clipboard.writeText(shown)}>
						복사
					</button>
					<button type="button" className="btn primary" onClick={onClose}>
						닫기
					</button>
				</div>
			</div>
		</div>
	);
}
