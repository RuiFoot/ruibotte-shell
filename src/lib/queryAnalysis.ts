/**
 * 쿼리 분석기 — 연결마다 하나. 쿼리 지도·튜닝 칸이 보일 때만 편집기를 듣고,
 * 입력이 300ms 멈추면 커서 문장을 백엔드(sql_map)로 읽어 캐시한 메타데이터와 맞춘다.
 * - 같은 문장이면 다시 읽지 않는다(위치만 옮김) · 1MB 넘는 스크립트는 끈다
 * - 읽기 실패(치는 중)면 마지막 성공 그림을 흐리게 둔다
 * - 메타데이터는 표마다 한 번 채운다(db_tree·db_table_meta·인덱스 목록) — 실행 중·PG 트랜잭션 중에는 미룬다
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { type Fk, fkSql, indexColsSql, type IndexInfo, parseIndexRows } from "./dbtools";
import type { ColMeta } from "./edits";
import { allFindings, type Finding, type QueryMap, type Resolved, resolveCols, type TableMeta } from "./queryLint";
import { currentView, runBackground, subscribeEditor } from "./queryWatch";
import { splitSql, type Stmt } from "./sql";

const PAUSE_MS = 300;
const MAX_DOC = 1_000_000;
/** 못 읽은 메타데이터는 이만큼 지난 뒤 다시 */
const RETRY_MS = 15_000;
/** 스키마를 뒤질 상한(아주 큰 서버) */
const MAX_SCHEMAS = 40;

export type AnalyzeDeps = {
	conn: number;
	engine: string;
	epoch: number;
	/** MySQL 지금 데이터베이스(한정 없는 표 이름을 찾을 곳) */
	defaultSchema: string | null;
	running: boolean;
	inTx: boolean;
};

/** 메타데이터 조회 상한 — 사용자 실행을 오래 막지 않게 */
const BG_TIMEOUT_MS = 3000;
type QueryOk = { resultId?: number | null; rowCount: number };
/** 뒤 조회 — 연결마다 한 줄로(같은 연결 BUSY 방지), 짧은 시간 상한 */
function bgRows(conn: number, sql: string, max: number): Promise<(string | null)[][]> {
	return runBackground(conn, async () => {
		const ok = await invoke<QueryOk>("db_query", { conn, sql, maxRows: max, timeoutMs: BG_TIMEOUT_MS, stream: null });
		if (!ok.resultId) return [];
		try {
			return await invoke<(string | null)[][]>("db_rows", { result: ok.resultId, from: 0, to: ok.rowCount });
		} finally {
			void invoke("db_result_close", { result: ok.resultId });
		}
	});
}

export type Snapshot = {
	/** 문장(편집기 위치) */
	stmt: Stmt;
	map: QueryMap;
	resolved: Resolved | null;
	findings: Finding[];
	/** 구조가 같으면 같은 값 — 그림은 이것이 바뀔 때만 다시 그린다 */
	shape: string;
	/** 마지막 읽기가 실패해 지난 그림을 보여 주는 중 */
	stale: boolean;
	error: string | null;
	/** 메타데이터 상태 */
	note: string | null;
};
export type State = { snap: Snapshot | null; off: string | null; busy: boolean };

type Node = { name: string; kind: string; detail?: string | null };

/** 연결·epoch 마다 메타데이터 기억 */
class Meta {
	private schemas: Promise<string[]> | null = null;
	private tables = new Map<string, Promise<Node[] | null>>();
	/** 읽기에 실패한 것이 있었다 — 조금 뒤 다시 맞춘다 */
	failed = false;
	private cols = new Map<string, Promise<ColMeta[] | null>>();
	private idx = new Map<string, Promise<IndexInfo[] | null>>();
	private fkMap = new Map<string, Promise<Fk[] | null>>();
	constructor(private conn: number) {}

	private retry<K, V>(m: Map<K, Promise<V>>, k: K) {
		this.failed = true;
		window.setTimeout(() => m.delete(k), RETRY_MS);
	}
	listSchemas(allow: boolean): Promise<string[]> | null {
		if (!this.schemas && !allow) return null;
		this.schemas ??= invoke<Node[]>("db_tree", { conn: this.conn, path: [] })
			.then((l) => l.filter((n) => n.kind === "schema").map((n) => n.name))
			.catch(() => {
				this.failed = true;
				window.setTimeout(() => (this.schemas = null), RETRY_MS);
				return [] as string[];
			});
		return this.schemas;
	}
	/** 표 목록 — 못 읽었으면 null(빈 목록과 다르다: "없는 표"라 하지 않는다) */
	listTables(schema: string, allow: boolean): Promise<Node[] | null> | null {
		const k = schema.toLowerCase();
		let p = this.tables.get(k);
		if (!p) {
			if (!allow) return null;
			p = invoke<Node[]>("db_tree", { conn: this.conn, path: [schema] }).catch(() => {
				this.retry(this.tables, k);
				return null;
			});
			this.tables.set(k, p);
		}
		return p;
	}
	columns(schema: string, table: string, allow: boolean): Promise<ColMeta[] | null> | null {
		const k = `${schema}.${table}`.toLowerCase();
		let p = this.cols.get(k);
		if (!p) {
			if (!allow) return null;
			p = invoke<ColMeta[]>("db_table_meta", { conn: this.conn, schema: schema === "(기본)" ? null : schema, table }).catch(() => {
				this.retry(this.cols, k);
				return null;
			});
			this.cols.set(k, p);
		}
		return p;
	}
	/** 인덱스 목록 — 엔진이 지원하지 않으면 null 을 바로, 아직 못 읽고 허락도 없으면 null(대기) */
	indexes(engine: string, schema: string, table: string, allow: boolean): Promise<IndexInfo[] | null> | null {
		const k = `${schema}.${table}`.toLowerCase();
		let p = this.idx.get(k);
		if (!p) {
			const sql = indexColsSql(engine, schema === "(기본)" ? null : schema, table);
			if (!sql) return Promise.resolve(null);
			if (!allow) return null;
			p = bgRows(this.conn, sql, 5000)
				.then(parseIndexRows)
				.catch(() => {
					this.retry(this.idx, k);
					return null;
				});
			this.idx.set(k, p);
		}
		return p;
	}
	/** 스키마의 외래 키 — 못 읽었으면 null(FK 없는 조인이라 하지 않는다) */
	fks(engine: string, schema: string, allow: boolean): Promise<Fk[] | null> | null {
		const k = schema.toLowerCase();
		let p = this.fkMap.get(k);
		if (!p) {
			const sql = fkSql(engine, schema);
			if (!sql) return Promise.resolve(null);
			if (!allow) return null;
			p = bgRows(this.conn, sql, 50000)
				.then((rows) => rows.map((r) => ({ table: r[0] ?? "", column: r[1] ?? "", refTable: r[2] ?? "", refColumn: r[3] ?? "" })) as Fk[] | null)
				.catch(() => {
					this.retry(this.fkMap, k);
					return null;
				});
			this.fkMap.set(k, p);
		}
		return p;
	}
	/** 이름으로 표 찾기 — "wait"(허락 없이는 못 읽음) | [찾은 것 | null, 끝까지 찾았나] */
	async find(schema: string | null, name: string, prefer: string | null, mysql: boolean, allow: boolean): Promise<"wait" | [{ schema: string; name: string; kind: "table" | "view" } | null, boolean]> {
		const sp = this.listSchemas(allow);
		if (!sp) return "wait";
		const all = await sp;
		if (!all.length) return [null, false];
		const low = name.toLowerCase();
		let cands: string[];
		if (schema) cands = all.filter((s) => s.toLowerCase() === schema.toLowerCase());
		else if (mysql && prefer) cands = all.filter((s) => s.toLowerCase() === prefer.toLowerCase());
		else cands = prefer ? [...all.filter((s) => s.toLowerCase() === prefer.toLowerCase()), ...all.filter((s) => s.toLowerCase() !== prefer.toLowerCase())] : all;
		let complete = cands.length <= MAX_SCHEMAS;
		for (const s of cands.slice(0, MAX_SCHEMAS)) {
			const tp = this.listTables(s, allow);
			if (!tp) return "wait";
			const list = await tp;
			if (!list) {
				complete = false;
				continue;
			}
			const t = list.find((n) => n.name.toLowerCase() === low && n.kind !== "column" && n.kind !== "schema");
			if (t) return [{ schema: s, name: t.name, kind: t.kind === "view" ? "view" : "table" }, true];
		}
		return [null, complete && (!!schema || cands.length > 0)];
	}
}

const metas = new Map<string, Meta>();
function metaFor(conn: number, epoch: number): Meta {
	const k = `${conn}:${epoch}`;
	let m = metas.get(k);
	if (!m) {
		for (const key of metas.keys()) if (key.startsWith(`${conn}:`)) metas.delete(key);
		m = new Meta(conn);
		metas.set(k, m);
	}
	return m;
}

/** 위치를 뺀 구조 — 그리기 판단용 */
function shapeOf(map: QueryMap, r: Resolved | null): string {
	const strip = (o: object) => JSON.stringify(o, (k, v) => (k === "pos" ? undefined : v));
	const metaKey = r ? r.meta.map((m) => (m === undefined ? "-" : m === null ? "0" : `${m.cols?.length ?? "?"}:${m.indexes?.length ?? "?"}`)).join(",") + r.colTable.join(",") : "";
	return strip(map) + metaKey;
}

class Analyzer {
	deps: AnalyzeDeps;
	private consumers = new Map<symbol, { visible: boolean; cb: (s: State) => void }>();
	private off: (() => void) | null = null;
	private timer: number | undefined;
	private seq = 0;
	private lastText: string | null = null;
	private metaPending = false;
	/** 문서가 그대로면 문장 나누기를 다시 하지 않는다(커서만 옮긴 경우) */
	private lastDoc: unknown = null;
	private splits: Stmt[] = [];
	private retryTimer: number | undefined;
	state: State = { snap: null, off: null, busy: false };

	constructor(deps: AnalyzeDeps) {
		this.deps = deps;
	}

	update(d: AnalyzeDeps) {
		const wasBlocked = this.deps.running || (this.deps.inTx && this.deps.engine === "postgres");
		const epochChanged = d.epoch !== this.deps.epoch || d.defaultSchema !== this.deps.defaultSchema;
		this.deps = d;
		const blocked = d.running || (d.inTx && d.engine === "postgres");
		if (epochChanged) {
			this.lastText = null;
			this.schedule(0);
		} else if (wasBlocked && !blocked && this.metaPending) {
			this.lastText = null;
			this.schedule(0);
		}
	}

	private anyVisible() {
		for (const c of this.consumers.values()) if (c.visible) return true;
		return false;
	}

	attach(id: symbol, visible: boolean, cb: (s: State) => void) {
		// 모든 칸이 잠깐 떨어졌다 다시 붙으면(칸 다시 그리기·StrictMode) 지도에서 빠진 채 남아,
		// 뒤에 붙는 칸이 새 분석기를 만들어 서로 다른 문장을 보였다 — 다시 붙을 때 자리를 되찾는다
		if (!analyzers.has(this.deps.conn)) analyzers.set(this.deps.conn, this);
		this.consumers.set(id, { visible, cb });
		this.wire();
		cb(this.state);
	}
	setVisible(id: symbol, visible: boolean) {
		const c = this.consumers.get(id);
		if (!c || c.visible === visible) return;
		c.visible = visible;
		this.wire();
	}
	detach(id: symbol) {
		this.consumers.delete(id);
		this.wire();
		// 아무 칸도 안 보면 버린다(연결이 닫혀도 남지 않게)
		if (!this.consumers.size && analyzers.get(this.deps.conn) === this) analyzers.delete(this.deps.conn);
	}
	/** 보이는 칸이 있을 때만 편집기를 듣는다 */
	private wire() {
		const want = this.anyVisible();
		if (want && !this.off) {
			this.off = subscribeEditor(this.deps.conn, () => this.schedule(PAUSE_MS));
			this.schedule(0);
		} else if (!want && this.off) {
			this.off();
			this.off = null;
			window.clearTimeout(this.timer);
		}
	}
	/** 지금 다시(새로 읽기 단추) */
	refresh() {
		this.lastText = null;
		this.schedule(0);
	}

	private schedule(ms: number) {
		window.clearTimeout(this.timer);
		if (!this.anyVisible()) return;
		this.timer = window.setTimeout(() => void this.run(), ms);
	}

	private emit(s: Partial<State>) {
		this.state = { ...this.state, ...s };
		for (const c of this.consumers.values()) c.cb(this.state);
	}

	private async run() {
		const view = currentView(this.deps.conn);
		if (!view) return this.emit({ off: "SQL 편집기를 누르면 그 커서 문장을 그립니다", snap: null });
		const doc = view.state.doc;
		if (doc.length > MAX_DOC) return this.emit({ off: "1MB 가 넘는 스크립트라 지도를 끕니다" });
		if (doc !== this.lastDoc) {
			this.lastDoc = doc;
			this.splits = splitSql(doc.toString());
		}
		const pos = view.state.selection.main.head;
		const all = this.splits;
		const stmt = all.find((s) => pos >= s.from && pos <= s.to + 1) ?? [...all].reverse().find((s) => s.to < pos) ?? all[0] ?? null;
		if (!stmt || !stmt.text.trim()) {
			this.lastText = null;
			return this.emit({ off: "커서가 있는 곳에 문장이 없습니다", snap: null });
		}
		const snap = this.state.snap;
		// 지금 그림과 같은 문장 — 위치만 옮긴다(실패해 흐리게 둔 그림이면 다시 또렷하게)
		if (snap && stmt.text === snap.stmt.text) {
			this.lastText = stmt.text;
			if (snap.stmt.from !== stmt.from || snap.stale) this.emit({ snap: { ...snap, stmt, stale: false, error: null } });
			return;
		}
		// 방금 읽기에 실패한 그 문장 그대로 — 다시 읽어도 같다
		if (stmt.text === this.lastText) return;
		this.lastText = stmt.text;
		const my = ++this.seq;
		const d = this.deps;
		let map: QueryMap;
		try {
			map = await invoke<QueryMap>("sql_map", { sql: stmt.text, engine: d.engine });
		} catch (e) {
			map = { ok: false, error: String(e), kind: "other", dialect: "", scopes: [], tables: [], joins: [], cols: [], facts: [], clauses: [], outs: [] };
		}
		if (my !== this.seq) return;
		if (!map.ok) {
			const prev = this.state.snap;
			return this.emit({ off: null, snap: prev ? { ...prev, stale: true, error: map.error } : null, busy: false, ...(prev ? {} : { off: `읽지 못했습니다 — ${map.error ?? ""}` }) });
		}
		if (!map.tables.length && map.kind !== "select") {
			return this.emit({ off: map.kind === "other" ? "SELECT·INSERT·UPDATE·DELETE 문장만 그립니다" : null, snap: { stmt, map, resolved: null, findings: [], shape: shapeOf(map, null), stale: false, error: null, note: null } });
		}
		// 메타데이터가 캐시에 있으면 한 번에, 처음 읽느라 늦으면 구조부터 그린다
		const rp = this.resolve(map);
		const quick = await Promise.race([rp, new Promise<null>((r) => window.setTimeout(() => r(null), 120))]);
		if (my !== this.seq) return;
		if (!quick) this.emit({ off: null, busy: true, snap: { stmt, map, resolved: null, findings: [], shape: shapeOf(map, null), stale: false, error: null, note: "메타데이터 맞추는 중…" } });
		const { resolved, note, retry } = await rp;
		if (my !== this.seq) return;
		// 메타데이터를 못 읽은 것이 있으면 조금 뒤 한 번 더(캐시가 비워진 뒤)
		window.clearTimeout(this.retryTimer);
		if (retry)
			this.retryTimer = window.setTimeout(() => {
				this.lastText = null;
				this.schedule(0);
			}, RETRY_MS + 500);
		const findings = allFindings(resolved, stmt.text, d.engine);
		this.emit({ busy: false, snap: { stmt, map, resolved, findings, shape: shapeOf(map, resolved), stale: false, error: null, note } });
	}

	private async resolve(map: QueryMap): Promise<{ resolved: Resolved; note: string | null; retry: boolean }> {
		const d = this.deps;
		const m = metaFor(d.conn, d.epoch);
		m.failed = false;
		// 실행 중에는 아무것도 묻지 않는다(같은 연결). PG 트랜잭션 중에는 캐시에 없는 것을 모두 미룬다 — 오류 하나가 트랜잭션을 깨뜨린다
		const allowTree = !d.running && !(d.inTx && d.engine === "postgres");
		const allowSql = allowTree;
		const mysql = d.engine === "mysql" || d.engine === "mariadb";
		const meta: (TableMeta | null | undefined)[] = map.tables.map(() => undefined);
		let searched = true;
		let pending = false;
		const noIndex = !indexColsSql(d.engine, null, "x");
		const fks = new Map<string, Fk[]>();
		await Promise.all(
			map.tables.map(async (t) => {
				if (t.virt || t.cte !== null || t.derived !== null) return;
				const found = await m.find(t.schema, t.name, d.defaultSchema, mysql, allowTree);
				if (found === "wait") {
					pending = true;
					return;
				}
				const [hit, complete] = found;
				if (!hit) {
					if (!complete) searched = false;
					meta[t.id] = null;
					return;
				}
				const cp = m.columns(hit.schema, hit.name, allowTree);
				const cols = cp ? await cp : null;
				if (!cp) pending = true;
				let indexes: IndexInfo[] | null = null;
				const ip = m.indexes(d.engine, hit.schema, hit.name, allowSql);
				if (ip === null) pending = true;
				else indexes = await ip;
				const fp = m.fks(d.engine, hit.schema, allowSql);
				if (fp === null) pending = true;
				else {
					const list = await fp;
					if (list) fks.set(hit.schema.toLowerCase(), list);
				}
				meta[t.id] = { schema: hit.schema, name: hit.name, kind: hit.kind, cols, indexes };
			}),
		);
		this.metaPending = pending;
		const colTable = resolveCols(map, meta);
		const notes = [pending && (d.running ? "쿼리 실행 중이라 인덱스·FK 는 끝난 뒤 읽습니다" : "트랜잭션 중이라 새 메타데이터는 끝난 뒤 읽습니다(PostgreSQL — 오류가 트랜잭션을 깨뜨리지 않게)"), noIndex && "이 엔진은 인덱스 목록을 못 읽어 인덱스 검사를 건너뜁니다", !searched && "스키마가 많아 일부 표는 찾지 못했을 수 있습니다"].filter(Boolean);
		return { resolved: { map, meta, searched, colTable, fks }, note: notes.length ? notes.join(" · ") : null, retry: m.failed };
	}
}

const analyzers = new Map<number, Analyzer>();
export function analyzerFor(deps: AnalyzeDeps): Analyzer {
	let a = analyzers.get(deps.conn);
	if (!a) {
		a = new Analyzer(deps);
		analyzers.set(deps.conn, a);
	} else a.update(deps);
	return a;
}
export type { Analyzer };

/** 칸에서 쓰는 훅 — 보일 때만 분석기를 듣는다 */
export function useAnalysis(deps: AnalyzeDeps, visible: boolean): { state: State; refresh: () => void } {
	const id = useMemo(() => Symbol("qa"), []);
	const a = analyzerFor(deps);
	const [state, setState] = useState<State>(a.state);
	useEffect(() => {
		a.attach(id, visible, setState);
		return () => a.detach(id);
	}, [a, id]);
	useEffect(() => a.setVisible(id, visible), [a, id, visible]);
	return { state, refresh: () => a.refresh() };
}
