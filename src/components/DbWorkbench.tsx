import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { MSSQL, MySQL, PLSQL, PostgreSQL, StandardSQL, sql } from "@codemirror/lang-sql";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ChevronRight, Columns3, Database, Download, Eye, FilePlus, LayoutTemplate, Lock, Play, PlayCircle, Square, Table } from "lucide-react";
import { createContext, lazy, type ReactElement, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ComparePanel, HistoryPanel } from "./DbPanels";

const ErdPanelLazy = lazy(() => import("./DbErd").then((m) => ({ default: m.ErdPanel })));
import { api } from "../lib/ipc";
import { type Cell, type ColMeta, type EditStmt, buildDelete, buildInsert, buildUpdate, formatRows, previewSql, qualified } from "../lib/edits";
import { ddlSql, explainSql, killSql, queryRows, searchSql, type Tool, toolSql } from "../lib/dbtools";
import { quoteIdentFor, selectTop } from "../lib/engines";
import { splitSql, statementAt } from "../lib/sql";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { CellEditor } from "./CellEditor";
import { DataGrid, type GridApi, type GridCol, type GridOverlay } from "./DataGrid";
import { Select } from "./Select";
import { SnippetPalette } from "./SnippetPalette";
import { codeHighlight } from "../lib/cmTheme";
import { editingExtensions } from "../lib/cmEditing";
import { dbCompletionSource } from "../lib/sqlComplete";

const theme: DockviewTheme = { name: "rbshell", className: "rbshell-dock", gap: 0, dndOverlayMounting: "relative" };

type QueryOk = {
	resultId?: number | null;
	columns: GridCol[];
	rowCount: number;
	affected?: number | null;
	truncated: boolean;
	ms: number;
	firstRowMs?: number | null;
};
type DbError = { code: string; message: string };
type Source = { schema: string | null; table: string };
type ResultParams = { sql: string; state: "running" | "ok" | "error"; ok?: QueryOk; error?: DbError; at: number; source?: Source; tool?: string };

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
};
const DbCtx = createContext<Ctx | null>(null);
const useDb = () => useContext(DbCtx) as Ctx;

/** 연결마다 하나 — 열어 둔 SQL 편집기들이 같은 이름 목록을 함께 쓴다 */
const completions = new Map<number, ReturnType<typeof dbCompletionSource>>();
function completionFor(conn: number) {
	let s = completions.get(conn);
	if (!s) {
		s = dbCompletionSource((path) => invoke<Node[]>("db_tree", { conn, path }));
		completions.set(conn, s);
	}
	return s;
}

const db = {
	query: (conn: number, sql: string, maxRows: number) => invoke<QueryOk>("db_query", { conn, sql, maxRows }),
	cancel: (conn: number) => invoke<void>("db_cancel", { conn }),
	rows: (result: number, from: number, to: number) => invoke<(string | null)[][]>("db_rows", { result, from, to }),
	export: (result: number, format: string, path: string) => invoke<number>("db_export", { result, format, path }),
	tree: (conn: number, path: string[]) => invoke<Node[]>("db_tree", { conn, path }),
	closeResult: (result: number) => invoke<void>("db_result_close", { result }),
	meta: (conn: number, schema: string | null, table: string) => invoke<ColMeta[]>("db_table_meta", { conn, schema, table }),
	apply: (conn: number, stmts: EditStmt[]) => invoke<{ affected: number[]; inTx: boolean }>("db_apply", { conn, stmts }),
	tx: (conn: number, op: "begin" | "commit" | "rollback") => invoke<boolean>("db_tx", { conn, op }),
};

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
function pickStatements(v: EditorView, all: boolean): string[] {
	const doc = v.state.doc.toString();
	const sel = v.state.selection.main;
	if (!sel.empty) return splitSql(doc.slice(sel.from, sel.to)).map((s) => s.text);
	if (all) return splitSql(doc).map((s) => s.text);
	const s = statementAt(doc, sel.head);
	return s ? [s.text] : [];
}

function SqlPanel(props: IDockviewPanelProps<{ n: number; initial?: string }>) {
	const ctx = useDb();
	const host = useRef<HTMLDivElement>(null);
	const runRef = useRef(ctx.run);
	runRef.current = ctx.run;
	useEffect(() => {
		if (!host.current) return;
		const key = `${ctx.draftKey}.${props.params.n}`;
		let timer: number | undefined;
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
					...editingExtensions(),
					// DB 이름(스키마·표·열·별칭) 완성 — 키워드 완성은 sql() 이 함께 낸다
					EditorState.languageData.of(() => [{ autocomplete: completionFor(ctx.conn) }]),
					sql({
						dialect:
							ctx.engine === "postgres" ? PostgreSQL : ctx.mysql ? MySQL : ctx.engine === "mssql" ? MSSQL : ctx.engine === "oracle" || ctx.engine === "tibero" ? PLSQL : StandardSQL,
						upperCaseKeywords: false,
					}),
					keymap.of([
						{ key: "Mod-Enter", preventDefault: true, run: (view) => (runRef.current(pickStatements(view, false)), true) },
						{ key: "Shift-Mod-Enter", preventDefault: true, run: (view) => (runRef.current(pickStatements(view, true)), true) },
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
					]),
					sqlTheme,
					EditorView.updateListener.of((u) => {
						if (!u.docChanged) return;
						window.clearTimeout(timer);
						timer = window.setTimeout(() => void api.settingSet(key, u.state.doc.toString()), 800);
					}),
				],
			}),
		});
		if (props.params.initial) v.dispatch({ changes: { from: 0, insert: props.params.initial } });
		else
			void api.settingGet(key).then((t) => {
				if (t && v.state.doc.length === 0) v.dispatch({ changes: { from: 0, insert: t } });
			});
		ctx.registerEditor(props.api.id, v);
		return () => {
			window.clearTimeout(timer);
			ctx.registerEditor(props.api.id, null);
			v.destroy();
		};
	}, [ctx.mysql, ctx.engine, ctx.draftKey, ctx.registerEditor, props.api.id, props.params.n]);
	return <div className="cm-host" ref={host} style={{ height: "100%" }} />;
}

function ResultPanel(props: IDockviewPanelProps<ResultParams>) {
	const ctx = useDb();
	const p = props.params;
	const [msg, setMsg] = useState("");
	const grid = useRef<GridApi>(null);
	const [metas, setMetas] = useState<ColMeta[] | null>(null);
	const [edits, setEdits] = useState<Map<number, Map<number, Cell>>>(new Map());
	const [deleted, setDeleted] = useState<Set<number>>(new Set());
	const [added, setAdded] = useState<Cell[][]>([]);
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ok = p.ok;
	const rid = ok?.resultId ?? null;
	const fetchRows = useCallback((from: number, to: number) => (rid ? db.rows(rid, from, to) : Promise.resolve([])), [rid]);

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

	if (p.state === "running")
		return (
			<div className="dock-watermark">
				<p>실행 중…</p>
				{ctx.engine !== "mssql" && (
					<button type="button" className="btn" onClick={() => void db.cancel(ctx.conn)}>
						<Square size={12} /> 취소
					</button>
				)}
			</div>
		);
	if (p.state === "error")
		return (
			<div className="db-error selectable">
				<b>{p.error?.code === "CANCELLED" ? "취소했습니다" : "오류"}</b>
				<pre>{p.error?.message}</pre>
				<details>
					<summary>실행한 SQL</summary>
					<pre>{p.sql}</pre>
				</details>
			</div>
		);
	if (!ok) return null;

	const cols = ok.columns;
	const metaOf = (ci: number) => metas?.find((m) => m.name.toLowerCase() === cols[ci]?.name.toLowerCase());
	const pkIdx = metas ? metas.filter((m) => m.pk).map((m) => cols.findIndex((c) => c.name.toLowerCase() === m.name.toLowerCase())) : [];
	const canEdit = !!metas && pkIdx.length > 0 && pkIdx.every((i) => i >= 0);
	const why = ctx.readOnly
		? "읽기 전용 연결이라 고칠 수 없습니다"
		: !p.source
			? "표 보기(객체 트리 › 데이터 보기)에서만 고칠 수 있습니다"
			: metas && !pkIdx.length
				? "PK 가 없는 표라 고칠 수 없습니다"
				: metas && pkIdx.some((i) => i < 0)
					? "결과에 PK 열이 다 있어야 고칠 수 있습니다"
					: null;
	const table = p.source ? qualified(ctx.engine, p.source.schema, p.source.table) : "";
	const changeCount = [...edits.keys()].filter((r) => !deleted.has(r)).length + deleted.size + added.length;

	const overlay: GridOverlay = {
		added,
		cell: (r, c) => (r >= ok.rowCount ? undefined : edits.get(r)?.get(c)),
		cellEdited: (r, c) => r < ok.rowCount && !!edits.get(r)?.has(c),
		rowState: (r) => (r >= ok.rowCount ? "added" : deleted.has(r) ? "deleted" : edits.has(r) ? "edited" : undefined),
	};

	const setCell = async (r: number, c: number, v: Cell) => {
		if (r >= ok.rowCount) {
			const n = added.map((row) => row.slice());
			n[r - ok.rowCount][c] = v;
			setAdded(n);
			return;
		}
		const base = (await db.rows(rid as number, r, r + 1))[0]?.[c];
		const m = new Map(edits);
		const row = new Map(m.get(r) ?? []);
		if (base === v) row.delete(c);
		else row.set(c, v);
		if (row.size) m.set(r, row);
		else m.delete(r);
		setEdits(m);
	};

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
			setMsg(`${r.affected.length}문장 반영${r.inTx ? "(트랜잭션 안 — 커밋해야 남습니다)" : ""}`);
			ctx.run([p.sql], p.source);
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
			out.push(g ?? (r < ok.rowCount ? (await db.rows(rid as number, r, r + 1))[0] : added[r - ok.rowCount]));
		}
		return out;
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
			items.push({ label: "값 복사", run: () => void navigator.clipboard.writeText(val ?? "") });
			if (p.source) {
				const col = quoteIdentFor(ctx.engine, cols[c].name);
				const litv = val === null ? null : /^-?\d+(\.\d+)?$/.test(val) && cols[c].kind !== "text" ? val : `'${val.replace(/'/g, "''")}'`;
				const base = `SELECT * FROM ${table}`;
				items.push(
					{ label: "이 값으로 거르기", run: () => ctx.run([`${base} WHERE ${col} ${litv === null ? "IS NULL" : `= ${litv}`}`], p.source) },
					{ label: "이 값 빼고", run: () => ctx.run([`${base} WHERE ${col} ${litv === null ? "IS NOT NULL" : `<> ${litv}`}`], p.source) },
				);
			}
			if (canEdit && metaOf(c)?.nullable !== false) items.push({ label: "NULL 로", run: () => void setCell(r, c, null) });
			items.push({ sep: true });
		}
		items.push(
			{ label: `복사 — CSV(${picked.length}행)`, run: () => void copy("csv")() },
			{ label: "복사 — TSV(엑셀 붙여넣기)", run: () => void copy("tsv")() },
			{ label: "복사 — JSON", run: () => void copy("json")() },
			{ label: "복사 — Markdown 표", run: () => void copy("markdown")() },
			{ label: "복사 — INSERT 문", run: () => void copy("insert")() },
		);
		if (p.tool === "sessions") {
			const id = grid.current?.row(r)?.[0] ?? null;
			const k = id ? killSql(ctx.engine, id) : null;
			if (k)
				items.unshift(
					{
						label: `세션 ${id} 의 쿼리 멈추기`,
						danger: true,
						run: () => {
							if (confirm(`세션 ${id} 에서 실행 중인 쿼리를 멈출까요?`)) ctx.run([k]);
						},
					},
					{ sep: true },
				);
		}
		if (canEdit) {
			items.push(
				{ sep: true },
				{
					label: "행 복제",
					run: async () => {
						const rs = await rowsFor(picked);
						setAdded([...added, ...rs.map((row) => row.map((v, i) => (pkIdx.includes(i) && metaOf(i)?.default ? undefined : v)) as Cell[])]);
					},
				},
				{
					label: "새 행",
					run: () => setAdded([...added, cols.map(() => undefined) as unknown as Cell[]]),
				},
				{
					label: picked.every((x) => deleted.has(x)) ? "지우기 취소" : `행 지우기(${picked.length})`,
					danger: true,
					run: () => {
						const n = new Set(deleted);
						const undo = picked.every((x) => n.has(x));
						for (const x of picked) {
							if (x >= ok.rowCount) continue;
							if (undo) n.delete(x);
							else n.add(x);
						}
						setAdded(added.filter((_, i) => !picked.includes(ok.rowCount + i)));
						setDeleted(n);
					},
				},
			);
		}
		setMenu({ x: e.clientX, y: e.clientY, items });
	};

	async function doExport(format: "csv" | "tsv" | "json") {
		if (!rid) return;
		const path = await saveDialog({ defaultPath: `result.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
		if (!path) return;
		const n = await db.export(rid, format, path);
		setMsg(`${n.toLocaleString()}행을 저장했습니다`);
	}

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
			{rid ? (
				<DataGrid
					apiRef={grid}
					columns={cols}
					rowCount={ok.rowCount}
					fetchRows={fetchRows}
					resetKey={rid}
					overlay={overlay}
					editable={() => canEdit}
					onCellNull={(r, c) => metaOf(c)?.nullable !== false && void setCell(r, c, null)}
					renderEditor={(r, c, value, done) => (
						<CellEditor
							meta={metaOf(c)}
							value={value}
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
				<span className="ok">
					{rid ? `${ok.rowCount.toLocaleString()}행` : "완료"}
					{ok.truncated ? " (상한에서 멈춤)" : ""}
				</span>
				<span>{ok.ms.toLocaleString()} ms</span>
				{ok.firstRowMs != null && <span>첫 행 {ok.firstRowMs} ms</span>}
				{rid && p.source && <span title={why ?? "두 번 누르기·F2 로 고치기, Delete 로 NULL, 우클릭으로 행 추가·지우기"}>{why ? `🔒 ${why}` : canEdit ? "✎ 고칠 수 있음" : ""}</span>}
				{msg && <span>{msg}</span>}
				<span style={{ marginLeft: "auto" }} />
				{rid ? (
					<>
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void doExport("csv")}>
							<Download size={12} /> CSV
						</button>
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void doExport("tsv")}>
							TSV
						</button>
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void doExport("json")}>
							JSON
						</button>
					</>
				) : null}
			</div>
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
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

function ObjectsPanel() {
	const ctx = useDb();
	const [kids, setKids] = useState<Record<string, Node[] | string>>({});
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

	const load = useCallback(
		(path: string[]) => {
			const k = path.join("\u0001");
			db.tree(ctx.conn, path)
				.then((n) => setKids((s) => ({ ...s, [k]: n })))
				.catch((e) => setKids((s) => ({ ...s, [k]: (e as DbError).message ?? String(e) })));
		},
		[ctx.conn],
	);
	useEffect(() => load([]), [load]);

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
		for (const n of v) {
			const p = [...path, n.name];
			const k = p.join("\u0001");
			const expandable = n.kind !== "column";
			const isOpen = open.has(k);
			const icon =
				n.kind === "schema" ? <Database size={14} className="ti dir" /> : n.kind === "view" ? <Eye size={14} className="ti" /> : n.kind === "table" ? <Table size={14} className="ti dir" /> : <Columns3 size={13} className="ti" />;
			rows.push(
				<button
					key={k}
					type="button"
					className="tree-row"
					style={{ paddingLeft: 6 + depth * 14 }}
					onClick={() => expandable && toggle(p)}
					onDoubleClick={() => (n.kind === "table" || n.kind === "view") && ctx.run([`SELECT * FROM ${qname(path[0], n.name)}`], { schema: path[0] === "(기본)" ? null : path[0], table: n.name })}
					onContextMenu={(e) => {
						e.preventDefault();
						const items: MenuItem[] = [];
						if (n.kind === "table" || n.kind === "view") {
							const q = qname(path[0], n.name);
							items.push(
								{ label: "데이터 보기(고치기)", run: () => ctx.run([`SELECT * FROM ${q}`], { schema: path[0] === "(기본)" ? null : path[0], table: n.name }) },
								{ label: "행 수 세기", run: () => ctx.run([`SELECT count(*) AS row_count FROM ${q}`]) },
								{ label: "SELECT 문 넣기", run: () => ctx.insertText(`${selectTop(ctx.engine, q, 100)};\n`) },
							);
							const dq = ddlSql(ctx.engine, path[0], n.name, n.kind === "view");
							if (dq)
								items.push({
									label: "DDL 보기",
									run: async () => {
										try {
											const rows = await queryRows(ctx.conn, dq, 5);
											const text = rows[0]?.[rows[0].length - 1] ?? "";
											ctx.openSql(`${text}${text.trim().endsWith(";") ? "" : ";"}\n`, `DDL ${n.name}`);
										} catch (x) {
											alert((x as DbError).message ?? String(x));
										}
									},
								});
							items.push({ sep: true });
						}
						if (n.kind === "schema") {
							items.push(
								{ label: "ERD(관계도)", run: () => ctx.openPanel(`erd:${n.name}`, "erd", `ERD ${n.name}`, { schema: n.name }) },
								{ label: "표 크기", run: () => toolSql(ctx.engine, "sizes", n.name) && ctx.run([toolSql(ctx.engine, "sizes", n.name) as string], undefined, "sizes") },
								{
									label: "다른 스키마와 비교…",
									run: () => {
										const other = prompt(`${n.name} 와(과) 비교할 스키마 이름`);
										if (other) ctx.openPanel(`cmp:${n.name}:${other}`, "compare", `비교 ${n.name}↔${other}`, { a: n.name, b: other });
									},
								},
								{ sep: true },
							);
						}
						items.push({ label: "이름 복사", run: () => void navigator.clipboard.writeText(n.name) });
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
	};
	walk([], 0);
	return (
		<div className="tree">
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
			<ErdPanelLazy conn={ctx.conn} engine={ctx.engine} schema={props.params.schema} />
		</Suspense>
	);
}
function CompareDock(props: IDockviewPanelProps<{ a: string; b: string }>) {
	const ctx = useDb();
	return <ComparePanel conn={ctx.conn} a={props.params.a} b={props.params.b} />;
}

const components = { objects: ObjectsPanel, sql: SqlPanel, result: ResultPanel, history: HistoryDock, erd: ErdDock, compare: CompareDock };
const FIXED = /^(objects|sql-\d+)$/;

function defaultLayout(d: DockviewApi) {
	d.clear();
	d.addPanel({ id: "objects", component: "objects", title: "객체", renderer: "always" });
	d.addPanel({ id: "sql-1", component: "sql", title: "SQL", params: { n: 1 }, renderer: "always", position: { referencePanel: "objects", direction: "right" } });
	d.getPanel("objects")?.api.setSize({ width: 270 });
}

export function DbWorkbench({
	conn,
	engine,
	readOnly,
	version,
	profileId,
	active,
	features = [],
}: {
	conn: number;
	engine: string;
	readOnly: boolean;
	version: string;
	profileId?: number;
	active: boolean;
	/** 엔진이 지원하는 기능 — readOnlySession·cancel */
	features?: string[];
}) {
	const canCancel = features.includes("cancel");
	const dock = useRef<DockviewApi | null>(null);
	const editors = useRef(new Map<string, EditorView>());
	const lastEditor = useRef<string | null>(null);
	const [maxRows, setMaxRows] = useState(10_000);
	const [running, setRunning] = useState(false);
	const [inTx, setInTx] = useState(false);
	const historyScope = `db:${profileId ?? "adhoc"}`;
	const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
	const [snip, setSnip] = useState(false);
	const txOp = async (op: "begin" | "commit" | "rollback") => {
		try {
			setInTx(await db.tx(conn, op));
		} catch (e) {
			alert((e as DbError).message ?? String(e));
		}
	};
	const sqlSeq = useRef(1);
	const saveTimer = useRef<number | undefined>(undefined);
	const mysql = engine !== "postgres";
	const maxRef = useRef(maxRows);
	maxRef.current = maxRows;

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
			// :이름 파라미터 — 문자열·주석 밖, ::형변환 제외
			const names = [...new Set(input.flatMap((x) => [...bare(x).matchAll(/(?<![:\w]):([A-Za-z_][\w]*)/g)].map((m) => m[1])))];
			const values: Record<string, string> = {};
			for (const n of names) {
				const v = prompt(`파라미터 :${n} 값(문자는 그대로, 숫자는 숫자로, 비우면 NULL)`);
				if (v === null) return;
				values[n] = v;
			}
			const stmts = input.map((x) =>
				names.length
					? x.replace(/(?<![:\w]):([A-Za-z_][\w]*)/g, (m, n) => (n in values ? (values[n] === "" ? "NULL" : /^-?\d+(\.\d+)?$/.test(values[n]) ? values[n] : `'${values[n].replace(/'/g, "''")}'`) : m))
					: x,
			);
			// 쓰기 확인 — DDL, WHERE 없는 UPDATE·DELETE
			const risky = stmts.filter((x) => {
				const b = bare(x).trim().toLowerCase();
				const w = b.match(/^[a-z]+/)?.[0] ?? "";
				return ["drop", "truncate", "alter", "create", "rename"].includes(w) || ((w === "update" || w === "delete") && !/\bwhere\b/.test(b));
			});
			if (risky.length && !confirm(`되돌리기 어려운 문장이 있습니다. 실행할까요?\n\n${risky.map((x) => x.slice(0, 200)).join("\n\n")}`)) return;
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
					const ref = d.panels.find((p) => p.id.startsWith("res-"));
					const sqlRef = d.panels.find((p) => p.id.startsWith("sql-"));
					panel = d.addPanel({
						id,
						component: "result",
						title: stmts.length > 1 ? `결과 ${i + 1}` : "결과",
						params,
						position: ref ? { referencePanel: ref.id, direction: "within" } : sqlRef ? { referencePanel: sqlRef.id, direction: "below" } : undefined,
					});
					if (!ref) panel.api.setSize({ height: 300 });
				}
				panel.api.setTitle(stmts.length > 1 ? `결과 ${i + 1}` : "결과");
				if (i === 0) panel.api.setActive();
				try {
					const ok = await db.query(conn, stmts[i], maxRef.current);
					panel.api.updateParameters({ ...params, state: "ok", ok });
					if (!tool) void invoke("history_add", { scope: historyScope, item: { sql: stmts[i], ms: ok.ms, rows: ok.rowCount, ok: true } }).then(() => window.dispatchEvent(new Event("rb-history")));
				} catch (e) {
					panel.api.updateParameters({ ...params, state: "error", error: e as DbError });
					if (!tool) void invoke("history_add", { scope: historyScope, item: { sql: stmts[i], ok: false } }).then(() => window.dispatchEvent(new Event("rb-history")));
					// 여러 문장이면 첫 오류에서 멈춘다
					for (const rest of d.panels.filter((p) => p.id.startsWith("res-") && Number(p.id.slice(4)) > i + 1)) d.removePanel(rest);
					break;
				}
			}
			setRunning(false);
			currentEditor()?.focus();
		},
		[conn, historyScope],
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

	const runTool = (t: Tool) => {
		const sql = toolSql(engine, t);
		if (sql) void run([sql], undefined, t);
	};

	const findObjects = () => {
		const q = prompt("표·열 이름에서 찾을 말");
		const sql = q ? searchSql(engine, q) : null;
		if (sql) void run([sql], undefined, "search");
	};

	const explain = () => {
		const v = currentEditor();
		if (!v) return;
		const st = pickStatements(v, false)[0];
		const sqls = st ? explainSql(engine, st) : null;
		if (sqls) void run(sqls, undefined, "explain");
	};

	const addSql = () => {
		const d = dock.current;
		if (!d) return;
		sqlSeq.current += 1;
		const n = sqlSeq.current;
		const ref = d.panels.find((p) => p.id.startsWith("sql-"));
		d.addPanel({ id: `sql-${n}`, component: "sql", title: `SQL ${n}`, params: { n }, renderer: "always", position: ref ? { referencePanel: ref.id, direction: "within" } : undefined });
	};

	const layoutKey = "layout.db";
	const onReady = (e: DockviewReadyEvent) => {
		dock.current = e.api;
		void api.settingGet(layoutKey).then((saved) => {
			let ok = false;
			if (saved) {
				try {
					const j = JSON.parse(saved);
					e.api.fromJSON(j);
					ok = !!e.api.getPanel("objects") || e.api.panels.some((p) => p.id.startsWith("sql-"));
					for (const p of e.api.panels) {
						const m = /^sql-(\d+)$/.exec(p.id);
						if (m) sqlSeq.current = Math.max(sqlSeq.current, Number(m[1]));
					}
				} catch {
					ok = false;
				}
			}
			if (!ok) defaultLayout(e.api);
		});
		e.api.onDidLayoutChange(() => {
			window.clearTimeout(saveTimer.current);
			saveTimer.current = window.setTimeout(() => {
				const d = dock.current;
				if (!d) return;
				const j = structuredClone(d.toJSON()) as unknown as { panels: Record<string, unknown>; grid: { root: { type: string; data: unknown } } };
				for (const id of Object.keys(j.panels)) if (!FIXED.test(id)) delete j.panels[id];
				const walk = (node: { type: string; data: unknown }) => {
					if (node.type === "leaf") {
						const g = node.data as { views: string[]; activeView?: string };
						g.views = g.views.filter((x) => FIXED.test(x));
						if (g.activeView && !FIXED.test(g.activeView)) g.activeView = g.views[0];
					} else for (const k of node.data as { type: string; data: unknown }[]) walk(k);
				};
				walk(j.grid.root);
				void api.settingSet(layoutKey, JSON.stringify(j));
			}, 600);
		});
	};

	useEffect(() => {
		if (active) requestAnimationFrame(() => currentEditor()?.focus());
	}, [active]);
	useEffect(() => {
		if (!active) return;
		const on = (e: KeyboardEvent) => {
			if (e.altKey && e.code === "KeyO") {
				e.preventDefault();
				findObjects();
			}
		};
		window.addEventListener("keydown", on);
		return () => window.removeEventListener("keydown", on);
	});

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
		}),
		[conn, engine, mysql, readOnly, inTx, run, insertText, registerEditor, openSql, openPanel, historyScope, profileId],
	);

	return (
		<DbCtx.Provider value={ctx}>
			<div className="wb-dock-shell">
				<div className="wb-bar">
					<button type="button" className="btn ghost" disabled={running} onClick={() => { const v = currentEditor(); if (v) void run(pickStatements(v, false)); }} title="커서 문장(또는 고른 글) 실행 — Ctrl+Enter">
						<Play size={14} /> 실행
					</button>
					<button type="button" className="btn ghost" disabled={running} onClick={() => { const v = currentEditor(); if (v) void run(pickStatements(v, true)); }} title="전체 실행 — Ctrl+Shift+Enter">
						<PlayCircle size={14} /> 전체
					</button>
					{canCancel && (
						<button type="button" className="btn ghost" disabled={!running} onClick={() => void db.cancel(conn)} title="실행 중인 문장 취소">
							<Square size={12} /> 취소
						</button>
					)}
					<span className="sep" />
					{!readOnly &&
						(inTx ? (
							<>
								<span className="badge warn">트랜잭션 열림</span>
								<button type="button" className="btn ghost" onClick={() => void txOp("commit")}>
									커밋
								</button>
								<button type="button" className="btn ghost" onClick={() => void txOp("rollback")}>
									되돌리기
								</button>
							</>
						) : (
							<button type="button" className="btn ghost" onClick={() => void txOp("begin")} title="수동 트랜잭션 — 커밋·되돌리기 전까지 반영 안 됨">
								자동 커밋
							</button>
						))}
					<button type="button" className="btn ghost" onClick={(e) => setToolsMenu({ x: e.clientX, y: e.clientY + 12 })} title="DB 도구">
						도구 ▾
					</button>
					<button type="button" className="btn ghost" onClick={() => setSnip(true)} title="즐겨찾는 SQL(스니펫)">
						★ SQL
					</button>
					<span className="sep" />
					<Select size="sm" value={maxRows} onChange={setMaxRows} title="결과 행 상한" options={[1000, 10_000, 100_000, 1_000_000].map((n) => ({ value: n, label: `최대 ${n.toLocaleString()}행` }))} />
					<button type="button" className="btn ghost" onClick={addSql} title="SQL 편집기 하나 더">
						<FilePlus size={14} /> SQL +
					</button>
					<button type="button" className="btn ghost" title="배치 초기화" onClick={() => dock.current && defaultLayout(dock.current)}>
						<LayoutTemplate size={14} /> 기본 배치
					</button>
					<span style={{ flex: 1 }} />
					{readOnly && (
						<span
							className="badge warn"
							title={features.includes("readOnlySession") ? "세션 READ ONLY + 조회 문장만" : "이 엔진은 세션을 읽기 전용으로 못 바꿔 조회 문장 판별로만 막습니다. 확실히 하려면 읽기 전용 계정을 쓰세요."}
						>
							<Lock size={11} /> 읽기 전용{features.includes("readOnlySession") ? "" : "(문장 판별)"}
						</span>
					)}
					<span className="badge">{version}</span>
				</div>
				<div className="wb-dock">
					<DockviewReact theme={theme} components={components} onReady={onReady} />
				</div>
				{toolsMenu && (
					<ContextMenu
						x={toolsMenu.x}
						y={toolsMenu.y}
						onClose={() => setToolsMenu(null)}
						items={[
							{ label: "객체 찾기  Alt+O", run: findObjects, disabled: !searchSql(engine, "x") },
							{ label: "실행 계획(커서 문장)", run: explain, disabled: !explainSql(engine, "x") },
							{ sep: true },
							{ label: "표 크기", run: () => runTool("sizes"), disabled: !toolSql(engine, "sizes") },
							{ label: "세션(우클릭으로 멈추기)", run: () => runTool("sessions"), disabled: !toolSql(engine, "sessions") },
							{ label: "잠금 기다림", run: () => runTool("locks"), disabled: !toolSql(engine, "locks") },
							{ sep: true },
							{ label: "쿼리 기록", run: () => openPanel("history", "history", "기록", {}) },
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
		</DbCtx.Provider>
	);
}
