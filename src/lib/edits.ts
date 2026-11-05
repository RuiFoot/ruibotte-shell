/**
 * 표 편집 → 엔진별 SQL. 값은 늘 매개변수로 묶는다(SQL 에 직접 넣지 않음).
 * PostgreSQL: $n::text::형식(어떤 형식이든 글로 받아 서버가 바꿈), SQL Server: @Pn, MySQL·JDBC: ?
 * UPDATE·DELETE 는 PK 로 정확히 1행(백엔드가 확인하고 아니면 모두 되돌림).
 */
import { quoteIdentFor } from "./engines";

export type ColMeta = { name: string; dataType: string; nullable: boolean; default?: string | null; pk: boolean; enumValues?: string[] | null };
export type Cell = string | null;
export type EditStmt = { sql: string; params: Cell[]; expectOne: boolean };

export type FieldKind = "bool" | "enum" | "int" | "numeric" | "date" | "datetime" | "time" | "json" | "uuid" | "longtext" | "text" | "binary";

export function fieldKind(m: ColMeta | undefined): FieldKind {
	if (!m) return "text";
	if (m.enumValues?.length) return "enum";
	const t = m.dataType.toLowerCase();
	if (/^(boolean|bool)$|^bit(\(1\))?$|^tinyint\(1\)/.test(t)) return "bool";
	if (/^(tiny|small|medium|big)?int|^integer|serial|^int\d|^year/.test(t)) return "int";
	if (/numeric|decimal|real|double|float|money|^number/.test(t)) return "numeric";
	if (/^date$/.test(t)) return "date";
	if (/timestamp|datetime/.test(t)) return "datetime";
	if (/^time/.test(t)) return "time";
	if (/json/.test(t)) return "json";
	if (/uuid|uniqueidentifier/.test(t)) return "uuid";
	if (/bytea|blob|binary|image/.test(t)) return "binary";
	if (/text|clob|\(max\)|xml/.test(t)) return "longtext";
	return "text";
}

/** 입력 검사 — 틀리면 까닭 */
export function validate(kind: FieldKind, v: Cell, m?: ColMeta): string | null {
	if (v === null) return m && !m.nullable ? "NULL 을 넣을 수 없는 열입니다" : null;
	if (kind === "int" && !/^-?\d+$/.test(v.trim())) return "정수가 아닙니다";
	if (kind === "numeric" && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return "숫자가 아닙니다";
	if (kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return "YYYY-MM-DD 꼴이어야 합니다";
	if (kind === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())) return "UUID 꼴이 아닙니다";
	if (kind === "json") {
		try {
			JSON.parse(v);
		} catch {
			return "JSON 문법이 틀렸습니다";
		}
	}
	if (kind === "enum" && m?.enumValues && !m.enumValues.includes(v)) return "고를 수 있는 값이 아닙니다";
	return null;
}

function ph(engine: string, n: number, type: string): string {
	if (engine === "postgres") return `$${n}::text::${type}`;
	if (engine === "mssql") return `@P${n}`;
	return "?";
}

export function qualified(engine: string, schema: string | null, table: string): string {
	return schema && schema !== "(기본)" ? `${quoteIdentFor(engine, schema)}.${quoteIdentFor(engine, table)}` : quoteIdentFor(engine, table);
}

export function buildUpdate(engine: string, table: string, metas: ColMeta[], pk: { name: string; value: Cell }[], changes: { name: string; value: Cell }[]): EditStmt {
	const params: Cell[] = [];
	const typeOf = (n: string) => metas.find((m) => m.name === n)?.dataType ?? "text";
	const set = changes.map((c) => {
		if (c.value === null) return `${quoteIdentFor(engine, c.name)} = NULL`;
		params.push(c.value);
		return `${quoteIdentFor(engine, c.name)} = ${ph(engine, params.length, typeOf(c.name))}`;
	});
	const where = pk.map((k) => {
		params.push(k.value);
		return `${quoteIdentFor(engine, k.name)} = ${ph(engine, params.length, typeOf(k.name))}`;
	});
	return { sql: `UPDATE ${table} SET ${set.join(", ")} WHERE ${where.join(" AND ")}`, params, expectOne: true };
}

export function buildDelete(engine: string, table: string, metas: ColMeta[], pk: { name: string; value: Cell }[]): EditStmt {
	const params: Cell[] = [];
	const typeOf = (n: string) => metas.find((m) => m.name === n)?.dataType ?? "text";
	const where = pk.map((k) => {
		params.push(k.value);
		return `${quoteIdentFor(engine, k.name)} = ${ph(engine, params.length, typeOf(k.name))}`;
	});
	return { sql: `DELETE FROM ${table} WHERE ${where.join(" AND ")}`, params, expectOne: true };
}

/** 새 행 — 손대지 않은 열은 빼서 기본값을 쓴다 */
export function buildInsert(engine: string, table: string, metas: ColMeta[], values: { name: string; value: Cell }[]): EditStmt {
	if (!values.length) {
		return { sql: engine === "mariadb" || engine === "mysql" ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`, params: [], expectOne: false };
	}
	const params: Cell[] = [];
	const typeOf = (n: string) => metas.find((m) => m.name === n)?.dataType ?? "text";
	const vals = values.map((c) => {
		if (c.value === null) return "NULL";
		params.push(c.value);
		return ph(engine, params.length, typeOf(c.name));
	});
	return { sql: `INSERT INTO ${table} (${values.map((c) => quoteIdentFor(engine, c.name)).join(", ")}) VALUES (${vals.join(", ")})`, params, expectOne: false };
}

/** 보여 주기용 — 매개변수를 글자 값으로 끼운 SQL(실행은 매개변수로) */
export function previewSql(engine: string, s: EditStmt): string {
	let i = 0;
	const lit = (v: Cell) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
	// PostgreSQL 은 '값'::text::형식 꼴로 남겨도 그대로 실행되는 SQL 이다
	if (engine === "postgres") return s.sql.replace(/\$(\d+)/g, (_m, n) => lit(s.params[Number(n) - 1]));
	if (engine === "mssql") return s.sql.replace(/@P(\d+)/g, (_m, n) => lit(s.params[Number(n) - 1]));
	return s.sql.replace(/\?/g, () => lit(s.params[i++]));
}

/** 복사 형식 */
export function formatRows(kind: "csv" | "tsv" | "json" | "markdown" | "insert", cols: string[], rows: Cell[][], engine: string, table?: string): string {
	if (kind === "json") return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), null, 2);
	if (kind === "markdown") {
		const esc = (v: Cell) => (v === null ? "NULL" : v.replace(/\|/g, "\\|").replace(/\n/g, " "));
		return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
	}
	if (kind === "insert") {
		const t = table ?? "표";
		const lit = (v: Cell) => (v === null ? "NULL" : /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);
		return rows.map((r) => `INSERT INTO ${t} (${cols.map((c) => quoteIdentFor(engine, c)).join(", ")}) VALUES (${r.map(lit).join(", ")});`).join("\n");
	}
	const sep = kind === "tsv" ? "\t" : ",";
	const cell = (v: Cell) => {
		if (v === null) return "";
		if (kind === "csv" && /[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
		return kind === "tsv" ? v.replace(/[\t\n]/g, " ") : v;
	};
	return [cols.map((c) => cell(c)).join(sep), ...rows.map((r) => r.map(cell).join(sep))].join("\n");
}
