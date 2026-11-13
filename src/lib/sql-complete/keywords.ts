/**
 * 문맥별 키워드 — lang-sql 의 낱말 목록(수백 개, 대부분 안 쓰는 것)을 통째로 섞지 않고 그 자리에 올 만한 것만.
 * 여러 낱말 묶음(GROUP BY·LEFT JOIN·IS NOT NULL)은 한 후보로 낸다.
 */
import type { Analysis } from "./context";
import { familyOf } from "./functions";

const w = (s: string) => s.trim().split(/\s*,\s*/).filter(Boolean);

const START = w("SELECT, INSERT INTO, UPDATE, DELETE FROM, WITH, EXPLAIN, CREATE TABLE, CREATE INDEX, CREATE VIEW, ALTER TABLE, DROP TABLE, TRUNCATE TABLE, BEGIN, COMMIT, ROLLBACK, SHOW, DESCRIBE, GRANT, REVOKE, CALL, SET");
const AFTER_TABLE = w("WHERE, JOIN, LEFT JOIN, INNER JOIN, RIGHT JOIN, CROSS JOIN, ON, AS, GROUP BY, ORDER BY, HAVING, LIMIT, UNION, UNION ALL, SET, VALUES");
const EXPR = w(
	"AND, OR, NOT, IN, NOT IN, IS NULL, IS NOT NULL, LIKE, NOT LIKE, BETWEEN, EXISTS, NOT EXISTS, CASE, WHEN, THEN, ELSE, END, AS, DISTINCT, NULL, TRUE, FALSE, " +
		"FROM, WHERE, GROUP BY, ORDER BY, HAVING, LIMIT, OFFSET, UNION, UNION ALL, JOIN, LEFT JOIN, INNER JOIN, ON, ASC, DESC, OVER, PARTITION BY, ANY, ALL, SOME",
);
const AFTER_ON = w("AND, OR, WHERE, JOIN, LEFT JOIN, INNER JOIN, GROUP BY, ORDER BY");

/** 이 자리의 키워드 — 엔진 갈래별 덧붙임 */
export function keywordsFor(a: Analysis, engine: string): string[] {
	const fam = familyOf(engine);
	const extra =
		fam === "pg"
			? w("ILIKE, NOT ILIKE, RETURNING, ON CONFLICT, DO NOTHING, FETCH FIRST, LATERAL, FILTER, NULLS FIRST, NULLS LAST, IS DISTINCT FROM")
			: fam === "mysql"
				? w("REGEXP, ON DUPLICATE KEY UPDATE, STRAIGHT_JOIN, FOR UPDATE, LOCK IN SHARE MODE, INTERVAL, DIV")
				: fam === "mssql"
					? w("TOP, OUTER APPLY, CROSS APPLY, WITH (NOLOCK), OUTPUT, OFFSET, FETCH NEXT")
					: fam === "oracle"
						? w("ROWNUM, FETCH FIRST, CONNECT BY, START WITH, PRIOR, MINUS, NVL, DUAL")
						: [];
	if (a.kind === "keyword") return a.head === "WITH" ? ["SELECT", "AS", "RECURSIVE", ...START] : START;
	if (a.kind === "afterTable") {
		if (a.clause === "join") return ["ON", "USING", "AS", ...AFTER_TABLE.filter((k) => k !== "ON")];
		if (a.clause === "into") return w("VALUES, SELECT, SET, DEFAULT VALUES");
		if (a.clause === "update") return w("SET, AS, JOIN, LEFT JOIN");
		return [...AFTER_TABLE, ...extra.filter((k) => /JOIN|APPLY|FOR UPDATE|LOCK|FETCH|RETURNING/.test(k))];
	}
	if (a.clause === "on") return [...AFTER_ON, ...EXPR, ...extra];
	if (a.clause === "values") return w("DEFAULT, NULL, TRUE, FALSE, SELECT");
	if (a.clause === "select" && !a.prefix && !a.refs.length) return ["FROM", "DISTINCT", "*", ...EXPR];
	return [...EXPR, ...extra];
}

/**
 * 키워드·함수를 넣을 대소문자 — 이 문장이 이미 쓰는 키워드 쪽(습관)을 따르고, 키워드가 아직 없으면 친 글자 쪽.
 * (완성을 부르려고 소문자로 대충 쳐도 대문자로 써 온 문장이면 대문자로 넣는다)
 */
export function caseHabit(prefix: string, stmt: string): "upper" | "lower" {
	const m = stmt.match(/\b(select|from|where|join|and|or|on|order|group|by|update|insert|into|values|set|delete|as|left|inner|limit|having)\b/gi) ?? [];
	const words = m.filter((x) => x.toLowerCase() !== prefix.toLowerCase());
	if (words.length) {
		let lo = 0;
		for (const x of words) if (x === x.toLowerCase()) lo++;
		return lo * 2 > words.length ? "lower" : "upper";
	}
	return /[a-z]/.test(prefix) && !/[A-Z]/.test(prefix) ? "lower" : "upper";
}
