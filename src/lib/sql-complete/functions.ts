/**
 * 엔진별 함수 목록 — 이름·인자 한 줄·돌려주는 형식. 완성 목록에 서명 한 줄로 보인다.
 * 다 담지 않는다: 손으로 자주 치는 것만(모르는 함수는 문서 낱말·직접 입력으로).
 */
export type Fn = { name: string; args: string; ret: string; agg?: boolean };
export type FnFamily = "mysql" | "pg" | "mssql" | "oracle" | "other";

export function familyOf(engine: string): FnFamily {
	if (engine === "mysql" || engine === "mariadb" || engine === "cubrid") return "mysql";
	if (engine === "postgres") return "pg";
	if (engine === "mssql") return "mssql";
	if (engine === "oracle" || engine === "tibero" || engine === "altibase") return "oracle";
	return "other";
}

const f = (spec: string): Fn[] =>
	spec
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			// 이름(인자) → 형식 [집계]
			const m = /^([A-Za-z_][\w$]*)(\(.*?\))?\s*(?:→\s*([^|]+))?(\|agg)?$/.exec(l);
			if (!m) throw new Error(`함수 목록 형식: ${l}`);
			return { name: m[1], args: m[2] ?? "", ret: (m[3] ?? "").trim(), agg: !!m[4] };
		});

const COMMON = f(`
COUNT(expr | *) → bigint|agg
SUM(expr) → numeric|agg
AVG(expr) → numeric|agg
MIN(expr) → 같은 형식|agg
MAX(expr) → 같은 형식|agg
COALESCE(a, b, …) → 첫 NULL 아닌 값
NULLIF(a, b) → a 또는 NULL
CAST(expr AS type) → type
ABS(n) → numeric
ROUND(n, digits) → numeric
FLOOR(n) → numeric
CEILING(n) → numeric
UPPER(s) → text
LOWER(s) → text
TRIM(s) → text
LTRIM(s) → text
RTRIM(s) → text
REPLACE(s, from, to) → text
ROW_NUMBER() → bigint
RANK() → bigint
DENSE_RANK() → bigint
LAG(expr, offset, default) → 같은 형식
LEAD(expr, offset, default) → 같은 형식
FIRST_VALUE(expr) → 같은 형식
LAST_VALUE(expr) → 같은 형식
`);

const MYSQL = f(`
IFNULL(a, b) → a 또는 b
IF(cond, then, else) → 값
CONCAT(s1, s2, …) → varchar
CONCAT_WS(sep, s1, s2, …) → varchar
GROUP_CONCAT(expr ORDER BY … SEPARATOR ',') → text|agg
SUBSTRING(s, pos, len) → varchar
SUBSTRING_INDEX(s, delim, count) → varchar
LEFT(s, n) → varchar
RIGHT(s, n) → varchar
LENGTH(s) → int (바이트)
CHAR_LENGTH(s) → int (글자)
LPAD(s, len, pad) → varchar
RPAD(s, len, pad) → varchar
INSTR(s, sub) → int
LOCATE(sub, s, pos) → int
FIND_IN_SET(s, list) → int
NOW() → datetime
CURDATE() → date
CURTIME() → time
SYSDATE() → datetime
DATE(expr) → date
DATE_FORMAT(date, '%Y-%m-%d') → varchar
STR_TO_DATE(s, '%Y-%m-%d') → datetime
DATE_ADD(date, INTERVAL n DAY) → datetime
DATE_SUB(date, INTERVAL n DAY) → datetime
DATEDIFF(a, b) → int (일)
TIMESTAMPDIFF(unit, a, b) → bigint
UNIX_TIMESTAMP(date) → bigint
FROM_UNIXTIME(n) → datetime
YEAR(date) → int
MONTH(date) → int
DAY(date) → int
LAST_DAY(date) → date
CONVERT(expr, type) → type
FORMAT(n, decimals) → varchar
MOD(a, b) → numeric
TRUNCATE(n, digits) → numeric
JSON_EXTRACT(doc, '$.path') → json
JSON_UNQUOTE(json) → text
JSON_OBJECT(k, v, …) → json
JSON_ARRAYAGG(expr) → json|agg
REGEXP_REPLACE(s, pattern, repl) → varchar
UUID() → char(36)
LAST_INSERT_ID() → bigint
FOUND_ROWS() → bigint
DATABASE() → varchar
GREATEST(a, b, …) → 값
LEAST(a, b, …) → 값
`);

const PG = f(`
CONCAT(s1, s2, …) → text
STRING_AGG(expr, ',' ORDER BY …) → text|agg
ARRAY_AGG(expr ORDER BY …) → array|agg
JSONB_AGG(expr) → jsonb|agg
JSON_AGG(expr) → json|agg
BOOL_AND(expr) → boolean|agg
BOOL_OR(expr) → boolean|agg
SUBSTRING(s FROM pos FOR len) → text
LEFT(s, n) → text
RIGHT(s, n) → text
LENGTH(s) → int
POSITION(sub IN s) → int
SPLIT_PART(s, delim, n) → text
LPAD(s, len, pad) → text
RPAD(s, len, pad) → text
REGEXP_REPLACE(s, pattern, repl, flags) → text
REGEXP_MATCHES(s, pattern) → setof text[]
TO_CHAR(value, 'YYYY-MM-DD') → text
TO_DATE(s, 'YYYY-MM-DD') → date
TO_TIMESTAMP(s, 'YYYY-MM-DD HH24:MI:SS') → timestamptz
TO_NUMBER(s, '999') → numeric
NOW() → timestamptz
CURRENT_DATE → date
CURRENT_TIMESTAMP → timestamptz
DATE_TRUNC('day', ts) → timestamp
DATE_PART('year', ts) → double
EXTRACT(field FROM ts) → numeric
AGE(a, b) → interval
MAKE_DATE(y, m, d) → date
GENERATE_SERIES(start, stop, step) → setof
UNNEST(array) → setof
ARRAY_LENGTH(array, dim) → int
JSONB_BUILD_OBJECT(k, v, …) → jsonb
JSONB_EXTRACT_PATH_TEXT(doc, k, …) → text
JSONB_ARRAY_ELEMENTS(doc) → setof jsonb
TO_JSONB(value) → jsonb
GEN_RANDOM_UUID() → uuid
GREATEST(a, b, …) → 값
LEAST(a, b, …) → 값
PG_SIZE_PRETTY(bytes) → text
PG_TOTAL_RELATION_SIZE(rel) → bigint
CURRENT_SETTING(name) → text
`);

const MSSQL = f(`
ISNULL(a, b) → a 또는 b
IIF(cond, then, else) → 값
CONCAT(s1, s2, …) → nvarchar
CONCAT_WS(sep, s1, …) → nvarchar
STRING_AGG(expr, ',') → nvarchar|agg
SUBSTRING(s, start, len) → nvarchar
LEFT(s, n) → nvarchar
RIGHT(s, n) → nvarchar
LEN(s) → int
DATALENGTH(expr) → int (바이트)
CHARINDEX(sub, s, start) → int
STUFF(s, start, len, insert) → nvarchar
FORMAT(value, 'yyyy-MM-dd') → nvarchar
CONVERT(type, expr, style) → type
TRY_CONVERT(type, expr) → type
TRY_CAST(expr AS type) → type
GETDATE() → datetime
SYSDATETIME() → datetime2
GETUTCDATE() → datetime
DATEADD(day, n, date) → datetime
DATEDIFF(day, a, b) → int
DATEPART(part, date) → int
DATENAME(part, date) → nvarchar
EOMONTH(date) → date
YEAR(date) → int
MONTH(date) → int
DAY(date) → int
NEWID() → uniqueidentifier
SCOPE_IDENTITY() → numeric
OBJECT_ID(name) → int
OBJECT_NAME(id) → sysname
JSON_VALUE(doc, '$.path') → nvarchar
JSON_QUERY(doc, '$.path') → nvarchar
OPENJSON(doc) → 표
STRING_SPLIT(s, sep) → 표
`);

const ORACLE = f(`
NVL(a, b) → a 또는 b
NVL2(expr, notNull, isNull) → 값
DECODE(expr, search, result, …, default) → 값
CONCAT(a, b) → varchar2
LISTAGG(expr, ',') WITHIN GROUP (ORDER BY …) → varchar2|agg
SUBSTR(s, pos, len) → varchar2
INSTR(s, sub, pos, nth) → number
LENGTH(s) → number
LENGTHB(s) → number (바이트)
LPAD(s, len, pad) → varchar2
RPAD(s, len, pad) → varchar2
REGEXP_SUBSTR(s, pattern) → varchar2
REGEXP_REPLACE(s, pattern, repl) → varchar2
REGEXP_LIKE(s, pattern) → 조건
TO_CHAR(value, 'YYYY-MM-DD') → varchar2
TO_DATE(s, 'YYYY-MM-DD') → date
TO_TIMESTAMP(s, 'YYYY-MM-DD HH24:MI:SS') → timestamp
TO_NUMBER(s) → number
SYSDATE → date
SYSTIMESTAMP → timestamp with tz
TRUNC(date | n, fmt) → date 또는 number
ADD_MONTHS(date, n) → date
MONTHS_BETWEEN(a, b) → number
LAST_DAY(date) → date
EXTRACT(field FROM date) → number
MOD(a, b) → number
GREATEST(a, b, …) → 값
LEAST(a, b, …) → 값
SYS_GUID() → raw(16)
ROWNUM → number
`);

const cache = new Map<FnFamily, Fn[]>();
/** 그 엔진의 함수(공통 + 엔진 것, 이름이 겹치면 엔진 것) */
export function functionsFor(engine: string): Fn[] {
	const fam = familyOf(engine);
	let l = cache.get(fam);
	if (!l) {
		const own = fam === "mysql" ? MYSQL : fam === "pg" ? PG : fam === "mssql" ? MSSQL : fam === "oracle" ? ORACLE : [];
		const names = new Set(own.map((x) => x.name));
		l = [...own, ...COMMON.filter((x) => !names.has(x.name))];
		// SQL Server 는 CEILING, 그 밖은 CEIL 도
		if (fam !== "mssql") l.push({ name: "CEIL", args: "(n)", ret: "numeric" });
		cache.set(fam, l);
	}
	return l;
}
