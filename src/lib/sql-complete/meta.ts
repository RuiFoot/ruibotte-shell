/**
 * 완성용 DB 이름 기억 — 연결(·데이터베이스)마다 하나. 객체 트리(db_tree)를 그대로 쓰고, 행 수 추정·기본 스키마만 짧은 조회로 더 읽는다.
 * - 스키마 목록 → 기본 스키마(지금 DB·search_path) 표 → 다른 스키마는 필요할 때
 * - 실패는 기억하지 않는다(다음 완성 때 다시) — 0.14 는 첫 실패를 빈 목록으로 굳혀 다시 연결할 때까지 표가 안 나왔다
 * - 행 수는 뒤에서 읽어 채운다(첫 목록을 기다리게 하지 않는다)
 */
import type { ColInfo, FkRow } from "./joins";

export type TreeNode = { name: string; kind: "schema" | "table" | "view" | "column"; detail?: string | null };
export type TableInfo = { schema: string; name: string; view: boolean; note?: string; rows?: number };
export type MetaDeps = {
	tree: (path: string[]) => Promise<TreeNode[]>;
	/** 짧은 조회 — 행(글자) 배열. 없으면 행 수·기본 스키마를 읽지 않는다 */
	query?: (sql: string, max: number) => Promise<(string | null)[][]>;
	engine: string;
	/** 스키마의 외래 키(작업대의 fksOf) */
	fks?: (schema: string) => Promise<FkRow[]>;
};

/** 시스템 스키마는 목록에서 뺀다(직접 쳐서 고르면 그 안은 보인다) */
export const SYSTEM_SCHEMA =
	/^(pg_catalog|information_schema|pg_toast|mysql|performance_schema|sys|sysibm|ctxsys|mdsys|xdb|system|outln|dbsnmp|appqossys|wmsys|olapsys|ordsys|ordplugins|lbacsys|dvsys|gsmadmin_internal|anonymous|apex_\w+|flows_files|orddata|si_informtn_schema|xs\$null|ojvmsys|gsmcatuser|gsmuser|audsys|dip|remote_scheduler_agent|sysbackup|sysdg|syskm|sysrac|dbsfwuser|ggsys|db_\w+|guest)$/i;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 열 detail(Rust db_tree: "varchar(20) · NOT NULL · PK") 읽기 */
export function parseColumn(n: TreeNode): ColInfo {
	const d = (n.detail ?? "").trim();
	const bits = d.split(/\s+·\s+/);
	let type = bits[0] ?? "";
	const flags = bits.slice(1).join(" ");
	// 목업·JDBC 처럼 "bigint PK" 로 붙어 오는 것도
	const tail = /\s+(PK|IDX|인덱스|NOT NULL)$/i.exec(type);
	let extra = "";
	if (tail) {
		extra = tail[1];
		type = type.slice(0, tail.index);
	}
	const all = `${flags} ${extra}`;
	return { name: n.name, type, pk: /\bPK\b/i.test(all), idx: /인덱스|\bIDX\b/i.test(all), notNull: /NOT NULL/i.test(all) || /\bPK\b/i.test(all) };
}

function defaultSchemaSql(engine: string): string | null {
	if (engine === "mysql" || engine === "mariadb") return "SELECT DATABASE()";
	if (engine === "postgres") return "SELECT current_schema()";
	if (engine === "mssql") return "SELECT SCHEMA_NAME()";
	if (engine === "oracle" || engine === "tibero") return "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual";
	return null;
}
function rowCountSql(engine: string, schema: string): string | null {
	if (engine === "mysql" || engine === "mariadb") return `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ${lit(schema)}`;
	if (engine === "postgres")
		return `SELECT c.relname, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${lit(schema)} AND c.relkind IN ('r','p','m','f')`;
	if (engine === "mssql")
		return `SELECT t.name, SUM(p.rows) FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) WHERE s.name = ${lit(schema)} GROUP BY t.name`;
	if (engine === "oracle" || engine === "tibero") return `SELECT table_name, num_rows FROM all_tables WHERE owner = ${lit(schema)}`;
	return null;
}

/** 실패하면 잊는 기억(다음에 다시 읽는다) */
function memo<T>(load: () => Promise<T>): { get: () => Promise<T>; peek: () => T | undefined } {
	let p: Promise<T> | null = null;
	let v: T | undefined;
	// 막 실패했으면 잠깐(3초) 다시 묻지 않는다 — 끊긴 연결에 낱말마다 조회가 쌓이지 않게
	let failedAt = 0;
	let lastErr: unknown;
	return {
		get: () => {
			if (!p && Date.now() - failedAt < 3000) return Promise.reject(lastErr);
			p ??= load().then(
				(x) => ((v = x), x),
				(e) => {
					p = null;
					failedAt = Date.now();
					lastErr = e;
					throw e;
				},
			);
			return p;
		},
		peek: () => v,
	};
}
function memoMap<T>(load: (k: string) => Promise<T>) {
	const m = new Map<string, ReturnType<typeof memo<T>>>();
	return (key: string) => {
		const k = key.toLowerCase();
		let e = m.get(k);
		if (!e) {
			e = memo(() => load(key));
			m.set(k, e);
		}
		return e;
	};
}

export type Meta = ReturnType<typeof createMeta>;

export function createMeta(deps: MetaDeps) {
	const schemaList = memo(() => deps.tree([]).then((l) => l.filter((n) => n.kind === "schema").map((n) => n.name)));
	const defSchema = memo(async (): Promise<string | null> => {
		const sql = defaultSchemaSql(deps.engine);
		let cur: string | null = null;
		if (sql && deps.query) cur = (await deps.query(sql, 1).catch(() => []))[0]?.[0] ?? null;
		const all = await schemaList.get().catch(() => [] as string[]);
		const hit = cur ? all.find((s) => s.toLowerCase() === cur.toLowerCase()) : undefined;
		if (hit) return hit;
		if (cur && !all.length) return cur;
		// 기본을 모르면: PostgreSQL public, SQL Server dbo, 아니면 시스템이 아닌 첫 스키마
		return all.find((s) => /^(public|dbo)$/i.test(s)) ?? all.find((s) => !SYSTEM_SCHEMA.test(s)) ?? all[0] ?? null;
	});
	const rowCounts = memoMap(async (schema: string) => {
		const m = new Map<string, number>();
		const sql = rowCountSql(deps.engine, schema);
		if (!sql || !deps.query) return m;
		for (const r of await deps.query(sql, 100000)) {
			const n = Number(r[1]);
			if (r[0] && Number.isFinite(n) && n >= 0) m.set(r[0].toLowerCase(), n);
		}
		return m;
	});
	const tableList = memoMap(async (schema: string) => {
		const l = (await deps.tree([schema])).filter((n) => n.kind !== "column");
		const out: TableInfo[] = l.map((n) => ({ schema, name: n.name, view: n.kind === "view", note: n.detail ?? undefined }));
		// 행 수는 뒤에서 — 오면 같은 객체에 채운다(다음 목록부터 보인다)
		void rowCounts(schema)
			.get()
			.then((m) => {
				for (const t of out) t.rows = m.get(t.name.toLowerCase());
			})
			.catch(() => undefined);
		return out;
	});
	const columnList = memoMap(async (key: string) => {
		const [schema, table] = JSON.parse(key) as [string, string];
		return (await deps.tree([schema, table])).filter((n) => n.kind === "column").map(parseColumn);
	});
	const fkList = memoMap(async (schema: string) => (deps.fks ? await deps.fks(schema) : []));

	const schemas = () => schemaList.get().catch(() => [] as string[]);
	const tables = (schema: string) => tableList(schema).get().catch(() => [] as TableInfo[]);
	const findSchema = async (name: string) => (await schemas()).find((s) => s.toLowerCase() === name.toLowerCase());

	/** 이름으로 표 찾기 — 스키마가 없으면 기본 스키마, 이미 읽은 스키마, 그다음 사용자 스키마 몇 개 */
	const resolve = async (name: string, schema?: string): Promise<TableInfo | null> => {
		const lc = name.toLowerCase();
		if (schema) {
			const s = (await findSchema(schema)) ?? schema;
			return (await tables(s)).find((t) => t.name.toLowerCase() === lc) ?? null;
		}
		const def = await defSchema.get().catch(() => null);
		if (def) {
			const t = (await tables(def)).find((x) => x.name.toLowerCase() === lc);
			if (t) return t;
		}
		const all = await schemas();
		// 이미 읽은 스키마 먼저(조회 없이), 그다음 사용자 스키마 8개까지
		for (const s of all) {
			const t = tableList(s).peek()?.find((x) => x.name.toLowerCase() === lc);
			if (t) return t;
		}
		for (const s of all.filter((x) => !SYSTEM_SCHEMA.test(x) && x !== def).slice(0, 8)) {
			const t = (await tables(s)).find((x) => x.name.toLowerCase() === lc);
			if (t) return t;
		}
		return null;
	};

	return {
		engine: deps.engine,
		schemas,
		defaultSchema: () => defSchema.get().catch(() => null),
		tables,
		/** 행 수를 조금(최대 ms) 기다린다 — 첫 목록에 행 수가 보이게, 느리면 그냥 간다 */
		rowsSoon: (schema: string, ms = 150) =>
			Promise.race([
				rowCounts(schema)
					.get()
					.then(() => tableList(schema).get())
					.then(() => undefined)
					.catch(() => undefined),
				new Promise<void>((r) => setTimeout(r, ms)),
			]),
		/** 읽어 둔 표 목록(없으면 undefined) — 기다리지 않는 자리용 */
		tablesNow: (schema: string) => tableList(schema).peek(),
		columns: (schema: string, table: string) => columnList(JSON.stringify([schema, table])).get().catch(() => [] as ColInfo[]),
		fks: (schema: string) => fkList(schema).get().catch(() => [] as FkRow[]),
		resolve,
	};
}
