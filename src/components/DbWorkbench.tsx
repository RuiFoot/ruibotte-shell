import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MySQL, PostgreSQL, sql } from "@codemirror/lang-sql";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ChevronRight, Columns3, Database, Download, Eye, FilePlus, LayoutTemplate, Lock, Play, PlayCircle, Square, Table } from "lucide-react";
import { createContext, type ReactElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { quoteIdent, splitSql, statementAt } from "../lib/sql";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { DataGrid, type GridCol } from "./DataGrid";

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
type ResultParams = { sql: string; state: "running" | "ok" | "error"; ok?: QueryOk; error?: DbError; at: number };

type Node = { name: string; kind: "schema" | "table" | "view" | "column"; detail?: string | null };

type Ctx = {
	conn: number;
	mysql: boolean;
	readOnly: boolean;
	run: (stmts: string[]) => void;
	insertText: (s: string) => void;
	registerEditor: (id: string, v: EditorView | null) => void;
	draftKey: string;
};
const DbCtx = createContext<Ctx | null>(null);
const useDb = () => useContext(DbCtx) as Ctx;

const db = {
	query: (conn: number, sql: string, maxRows: number) => invoke<QueryOk>("db_query", { conn, sql, maxRows }),
	cancel: (conn: number) => invoke<void>("db_cancel", { conn }),
	rows: (result: number, from: number, to: number) => invoke<(string | null)[][]>("db_rows", { result, from, to }),
	export: (result: number, format: string, path: string) => invoke<number>("db_export", { result, format, path }),
	tree: (conn: number, path: string[]) => invoke<Node[]>("db_tree", { conn, path }),
	closeResult: (result: number) => invoke<void>("db_result_close", { result }),
};

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

function SqlPanel(props: IDockviewPanelProps<{ n: number }>) {
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
					syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
					sql({ dialect: ctx.mysql ? MySQL : PostgreSQL, upperCaseKeywords: false }),
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
		void api.settingGet(key).then((t) => {
			if (t && v.state.doc.length === 0) v.dispatch({ changes: { from: 0, insert: t } });
		});
		ctx.registerEditor(props.api.id, v);
		return () => {
			window.clearTimeout(timer);
			ctx.registerEditor(props.api.id, null);
			v.destroy();
		};
	}, [ctx.mysql, ctx.draftKey, ctx.registerEditor, props.api.id, props.params.n]);
	return <div className="cm-host" ref={host} style={{ height: "100%" }} />;
}

function ResultPanel(props: IDockviewPanelProps<ResultParams>) {
	const ctx = useDb();
	const p = props.params;
	const [exportMsg, setExportMsg] = useState("");
	const fetchRows = useCallback((from: number, to: number) => (p.ok?.resultId ? db.rows(p.ok.resultId, from, to) : Promise.resolve([])), [p.ok?.resultId]);

	async function doExport(format: "csv" | "tsv" | "json") {
		if (!p.ok?.resultId) return;
		const path = await saveDialog({ defaultPath: `result.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
		if (!path) return;
		const n = await db.export(p.ok.resultId, format, path);
		setExportMsg(`${n.toLocaleString()}행을 저장했습니다`);
	}

	if (p.state === "running")
		return (
			<div className="dock-watermark">
				<p>실행 중…</p>
				<button type="button" className="btn" onClick={() => void db.cancel(ctx.conn)}>
					<Square size={12} /> 취소
				</button>
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
	const ok = p.ok as QueryOk;
	return (
		<div className="panel-fill">
			{ok.resultId ? (
				<DataGrid columns={ok.columns} rowCount={ok.rowCount} fetchRows={fetchRows} resetKey={ok.resultId} />
			) : (
				<div className="dock-watermark">
					<p style={{ color: "var(--text)" }}>{ok.affected != null ? `${ok.affected.toLocaleString()}행 반영` : "완료"}</p>
				</div>
			)}
			<div className="statusbar">
				<span className="ok">
					{ok.resultId ? `${ok.rowCount.toLocaleString()}행` : "완료"}
					{ok.truncated ? " (상한에서 멈춤)" : ""}
				</span>
				<span>{ok.ms.toLocaleString()} ms</span>
				{ok.firstRowMs != null && <span>첫 행 {ok.firstRowMs} ms</span>}
				{exportMsg && <span>{exportMsg}</span>}
				<span style={{ marginLeft: "auto" }} />
				{ok.resultId ? (
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

	const qname = (schema: string, table: string) => `${quoteIdent(schema, ctx.mysql)}.${quoteIdent(table, ctx.mysql)}`;
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
					onDoubleClick={() => (n.kind === "table" || n.kind === "view") && ctx.run([`SELECT * FROM ${qname(path[0], n.name)}`])}
					onContextMenu={(e) => {
						e.preventDefault();
						const items: MenuItem[] = [];
						if (n.kind === "table" || n.kind === "view") {
							const q = qname(path[0], n.name);
							items.push(
								{ label: "데이터 보기", run: () => ctx.run([`SELECT * FROM ${q}`]) },
								{ label: "행 수 세기", run: () => ctx.run([`SELECT count(*) AS row_count FROM ${q}`]) },
								{ label: "SELECT 문 넣기", run: () => ctx.insertText(`SELECT * FROM ${q} LIMIT 100;\n`) },
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

const components = { objects: ObjectsPanel, sql: SqlPanel, result: ResultPanel };
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
}: {
	conn: number;
	engine: string;
	readOnly: boolean;
	version: string;
	profileId?: number;
	active: boolean;
}) {
	const dock = useRef<DockviewApi | null>(null);
	const editors = useRef(new Map<string, EditorView>());
	const lastEditor = useRef<string | null>(null);
	const [maxRows, setMaxRows] = useState(10_000);
	const [running, setRunning] = useState(false);
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
		async (stmts: string[]) => {
			const d = dock.current;
			if (!d || !stmts.length) return;
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
				const params: ResultParams = { sql: stmts[i], state: "running", at: Date.now() };
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
				} catch (e) {
					panel.api.updateParameters({ ...params, state: "error", error: e as DbError });
					// 여러 문장이면 첫 오류에서 멈춘다
					for (const rest of d.panels.filter((p) => p.id.startsWith("res-") && Number(p.id.slice(4)) > i + 1)) d.removePanel(rest);
					break;
				}
			}
			setRunning(false);
			currentEditor()?.focus();
		},
		[conn],
	);

	const insertText = useCallback((s: string) => {
		const v = currentEditor();
		if (!v) return;
		v.dispatch({ changes: { from: v.state.selection.main.head, insert: s } });
		v.focus();
	}, []);

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

	const ctx = useMemo<Ctx>(
		() => ({ conn, mysql, readOnly, run: (s) => void run(s), insertText, registerEditor, draftKey: `sql.draft.${profileId ?? "adhoc"}` }),
		[conn, mysql, readOnly, run, insertText, registerEditor, profileId],
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
					<button type="button" className="btn ghost" disabled={!running} onClick={() => void db.cancel(conn)} title="실행 중인 문장 취소">
						<Square size={12} /> 취소
					</button>
					<span className="sep" />
					<select className="status-select" value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))} title="결과 행 상한">
						{[1000, 10_000, 100_000, 1_000_000].map((n) => (
							<option key={n} value={n}>
								최대 {n.toLocaleString()}행
							</option>
						))}
					</select>
					<button type="button" className="btn ghost" onClick={addSql} title="SQL 편집기 하나 더">
						<FilePlus size={14} /> SQL +
					</button>
					<button type="button" className="btn ghost" title="배치 초기화" onClick={() => dock.current && defaultLayout(dock.current)}>
						<LayoutTemplate size={14} /> 기본 배치
					</button>
					<span style={{ flex: 1 }} />
					{readOnly && (
						<span className="badge warn" title="세션 READ ONLY + 조회 문장만">
							<Lock size={11} /> 읽기 전용
						</span>
					)}
					<span className="badge">{version}</span>
				</div>
				<div className="wb-dock">
					<DockviewReact theme={theme} components={components} onReady={onReady} />
				</div>
			</div>
		</DbCtx.Provider>
	);
}
