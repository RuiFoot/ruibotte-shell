/**
 * 표 편집 → 엔진별 SQL. 값은 늘 매개변수로 묶는다(SQL 에 직접 넣지 않음).
 * PostgreSQL: $n::text::형식(어떤 형식이든 글로 받아 서버가 바꿈), SQL Server: @Pn, MySQL·JDBC: ?
 * UPDATE·DELETE 는 PK 로 정확히 1행(백엔드가 확인하고 아니면 모두 되돌림).
 */
import { quoteIdentFor } from "./engines";

export type ColMeta = { name: string; dataType: string; nullable: boolean; default?: string | null; pk: boolean; enumValues?: string[] | null };
export type Cell = string | null;
export type EditStmt = { sql: string; params: Cell[]; expectOne: boolean };

export type FieldKind = "bool" | "enum" | "set" | "int" | "numeric" | "date" | "datetime" | "time" | "json" | "uuid" | "longtext" | "text" | "binary";

/** MySQL SET('a','b') 의 고를 수 있는 값 */
export function setValues(m: ColMeta | undefined): string[] | null {
	const t = m?.dataType ?? "";
	if (!/^set\(/i.test(t)) return null;
	return [...t.slice(4, -1).matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
}

export function fieldKind(m: ColMeta | undefined): FieldKind {
	if (!m) return "text";
	if (m.enumValues?.length) return "enum";
	const t = m.dataType.toLowerCase();
	if (/^set\(/.test(t)) return "set";
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

/** 정수 형식의 범위(넘으면 까닭) — smallint·integer·bigint·tinyint·mediumint, unsigned */
function intRange(type: string): [bigint, bigint] | null {
	const t = type.toLowerCase();
	const uns = /unsigned/.test(t);
	const bits = /^tinyint/.test(t) ? 8 : /^(smallint|int2|smallserial)/.test(t) ? 16 : /^mediumint/.test(t) ? 24 : /^(bigint|int8|bigserial)/.test(t) ? 64 : /^(int|integer|int4|serial)/.test(t) ? 32 : 0;
	if (!bits) return null;
	const n = BigInt(bits);
	return uns ? [0n, 2n ** n - 1n] : [-(2n ** (n - 1n)), 2n ** (n - 1n) - 1n];
}

/** decimal(p,s)·numeric(p,s) — 정수부 p-s 자리, 소수부 s 자리 */
function decimalSpec(type: string): [number, number] | null {
	const m = /^(?:numeric|decimal|number)\s*\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/i.exec(type.trim());
	return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** 입력 검사 — 틀리면 까닭 */
export function validate(kind: FieldKind, v: Cell, m?: ColMeta): string | null {
	if (v === null) return m && !m.nullable ? "NULL 을 넣을 수 없는 열입니다" : null;
	if (kind === "int" && !/^-?\d+$/.test(v.trim())) return "정수가 아닙니다";
	if (kind === "int" && m) {
		const r = intRange(m.dataType);
		const n = BigInt(v.trim());
		if (r && (n < r[0] || n > r[1])) return `${m.dataType} 범위(${r[0]} ~ ${r[1]})를 넘습니다`;
	}
	if (kind === "numeric" && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return "숫자가 아닙니다";
	if (kind === "numeric" && m) {
		const d = decimalSpec(m.dataType);
		if (d && !/[eE]/.test(v)) {
			const [ip, fp = ""] = v.trim().replace(/^-/, "").split(".");
			const intDigits = ip.replace(/^0+(?=\d)/, "").length;
			if (intDigits > d[0] - d[1] && !(ip === "0" && d[0] === d[1])) return `정수부는 ${Math.max(0, d[0] - d[1])}자리까지입니다(${m.dataType})`;
			if (fp.length > d[1]) return `소수부는 ${d[1]}자리까지입니다(${m.dataType}) — 넘으면 서버가 반올림하거나 거절합니다`;
		}
	}
	if (kind === "set") {
		const allowed = setValues(m) ?? [];
		const bad = v.split(",").filter((x) => x && !allowed.includes(x));
		if (bad.length) return `고를 수 없는 값: ${bad.join(", ")}`;
	}
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

/** 여러 행 INSERT(가져오기용) — 한 문장에 여러 행, 매개변수 상한(SQL Server 2100)을 넘지 않게 나눈다 */
export function buildInsertMany(engine: string, table: string, metas: ColMeta[], cols: string[], rows: Cell[][]): EditStmt[] {
	const per = Math.max(1, Math.min(200, Math.floor((engine === "mssql" ? 2000 : 30000) / Math.max(1, cols.length))));
	const typeOf = (n: string) => metas.find((m) => m.name === n)?.dataType ?? "text";
	const head = `INSERT INTO ${table} (${cols.map((c) => quoteIdentFor(engine, c)).join(", ")}) VALUES `;
	const out: EditStmt[] = [];
	for (let i = 0; i < rows.length; i += per) {
		const params: Cell[] = [];
		const tuples = rows.slice(i, i + per).map(
			(r) =>
				`(${cols
					.map((c, j) => {
						const v = r[j];
						if (v === null) return "NULL";
						params.push(v);
						return ph(engine, params.length, typeOf(c));
					})
					.join(", ")})`,
		);
		out.push({ sql: head + tuples.join(", "), params, expectOne: false });
	}
	return out;
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
