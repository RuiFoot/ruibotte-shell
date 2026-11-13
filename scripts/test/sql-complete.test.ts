// SQL 편집기 완성 단위 시험 — 문맥 판정·별칭·조인 제안·거르기·소스 순서.
// 쓰기: pnpm test:sql   (node --import ./scripts/test/ts-hook.mjs scripts/test/sql-complete.test.ts)
// 표 이름은 일반 예시(게시판·메뉴·주문) — 실제 서비스 이름을 쓰지 않는다.
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { suggestAlias } from "../../src/lib/sql-complete/alias.ts";
import { analyze, type Analysis, statementRange } from "../../src/lib/sql-complete/context.ts";
import { type ColInfo, suggestJoins } from "../../src/lib/sql-complete/joins.ts";
import { matchLabel, rankFilter } from "../../src/lib/sql-complete/match.ts";
import { createMeta, parseColumn, type TreeNode } from "../../src/lib/sql-complete/meta.ts";
import { createSource } from "../../src/lib/sql-complete/source.ts";
import { splitSql } from "../../src/lib/sql.ts";

let pass = 0;
let fail = 0;
function ok(cond: unknown, name: string, extra?: unknown) {
	if (cond) pass++;
	else {
		fail++;
		console.error(`✗ ${name}`, extra === undefined ? "" : JSON.stringify(extra));
	}
}
/** | 자리가 커서 */
function at(sql: string, mysql = true): Analysis {
	const pos = sql.indexOf("|");
	return analyze(sql.replace("|", ""), pos, { mysql });
}
const refNames = (a: Analysis) => a.refs.map((r) => `${r.schema ? `${r.schema}.` : ""}${r.name}${r.alias ? ` ${r.alias}` : ""}`);

// ── 문맥 판정 ──
{
	const a = at("SELECT a.POST_ID, | FROM TB_BOARD_POST a WHERE a.HIT > 1");
	ok(a.kind === "column" && a.clause === "select", "SELECT 목록 = 열", a);
	ok(refNames(a).join() === "TB_BOARD_POST a", "SELECT 목록: FROM 이 커서 뒤에 있어도 표를 읽는다", refNames(a));
}
{
	const a = at("SELECT * FROM |");
	ok(a.kind === "table" && a.aliasOk === true, "FROM 뒤 = 표(별칭 가능)", a.kind);
}
{
	const a = at("SELECT * FROM TB_BOARD_POST a, |");
	ok(a.kind === "table", "FROM a, 뒤 = 표");
}
{
	const a = at("SELECT * FROM TB_BOARD_POST a LEFT JOIN BOARD b ON |");
	ok(a.kind === "column" && a.clause === "on", "ON 뒤 = 열", a.clause);
	ok(a.join?.right.name === "BOARD" && a.join.right.alias === "b" && a.join.left.map((r) => r.alias).join() === "a", "ON 뒤 조인 양쪽", a.join);
}
{
	const a = at("SELECT * FROM TB_BOARD_POST a JOIN BOARD b ON b.BOARD_ID = a.BOARD_ID AND |");
	ok(a.kind === "column" && !a.join, "ON … AND 뒤 = 열(조인 제안은 ON 바로 뒤만)");
}
{
	const a = at("SELECT a.| FROM TB_BOARD_POST a");
	ok(a.kind === "member" && a.qualifier?.join() === "a", "별칭. 뒤", a.qualifier);
}
{
	const a = at("SELECT * FROM shop.|");
	ok(a.kind === "member" && a.qualifier?.join() === "shop" && a.aliasOk, "스키마. 뒤(FROM)", a);
}
{
	const a = at("SELECT shop.TB_BOARD_POST.| FROM shop.TB_BOARD_POST");
	ok(a.kind === "member" && a.qualifier?.join() === "shop,TB_BOARD_POST", "스키마.표. 뒤", a.qualifier);
	ok(refNames(a).join() === "shop.TB_BOARD_POST", "스키마.표 참조", refNames(a));
}
{
	const a = at("INSERT INTO BOARD (BOARD_ID, |) VALUES ('a', 'b')");
	ok(a.kind === "insertColumns" && a.insertTable?.name === "BOARD", "INSERT INTO t ( = t 의 열", a.kind);
}
{
	const a = at("INSERT INTO BOARD (BOARD_ID) VALUES (|)");
	ok(a.kind === "column" && a.clause === "values", "VALUES 안 = 값 자리", a.clause);
}
{
	const a = at("UPDATE BOARD b SET |");
	ok(a.kind === "column" && a.clause === "set" && refNames(a).join() === "BOARD b", "UPDATE … SET = 그 표 열", refNames(a));
}
{
	const a = at("UPDATE |");
	ok(a.kind === "table" && a.aliasOk, "UPDATE 뒤 = 표");
}
{
	const a = at("DELETE FROM |");
	ok(a.kind === "table" && !a.aliasOk, "DELETE FROM 뒤 = 표(별칭 안 붙임)");
}
{
	const a = at("TRUNCATE TABLE |");
	ok(a.kind === "table", "TRUNCATE TABLE 뒤 = 표");
}
{
	const a = at("SELECT * FROM TB_BOARD_POST |");
	ok(a.kind === "afterTable", "표 이름 뒤 = 다음 절 키워드", a.kind);
	const b = at("SELECT * FROM TB_BOARD_POST a |");
	ok(b.kind === "afterTable" && refNames(b).join() === "TB_BOARD_POST a", "별칭 뒤 = 다음 절 키워드", refNames(b));
	const c = at("SELECT * FROM TB_BOARD_POST wh|");
	ok(c.kind === "afterTable" && c.prefix === "wh" && refNames(c).join() === "TB_BOARD_POST", "치는 중인 낱말은 별칭으로 읽지 않는다", refNames(c));
}
{
	ok(at("SEL|").kind === "keyword", "문장 머리 = 키워드");
	ok(at("|").kind === "keyword", "빈 문장 = 키워드");
}
{
	ok(at("SELECT * FROM t WHERE x = 'ab|c'").kind === "none", "문자열 안 = 완성 안 함");
	ok(at("SELECT * FROM t -- 주석 |").kind === "none", "줄 주석 안");
	ok(at("SELECT * FROM t /* 열| */").kind === "none", "블록 주석 안");
	ok(at("SELECT * FROM t # 주석 |").kind === "none", "MySQL # 주석 안");
	ok(at("SELECT * FROM t WHERE x = '' AND |").kind === "column", "닫힌 문자열 뒤는 그대로");
}
{
	const a = at("SELECT d.TITLE FROM DOCS d WHERE d.DOC_ID IN (SELECT | FROM DOC_LANG l WHERE l.DOC_ID = d.DOC_ID)");
	ok(a.kind === "column" && refNames(a).join("|") === "DOC_LANG l|DOCS d", "서브쿼리: 안쪽 표 먼저, 바깥 표 뒤", refNames(a));
	ok(a.refs[0].scope === a.scope && a.refs[1].scope !== a.scope, "서브쿼리: 바깥 표는 다른 범위");
}
{
	const a = at("WITH recent AS (SELECT POST_ID, TITLE AS t FROM TB_BOARD_POST) SELECT r.| FROM recent r");
	ok(a.kind === "member" && a.refs[0]?.kind === "cte" && a.refs[0].cols?.join() === "POST_ID,t", "WITH 이름 = 그 SELECT 의 열", a.refs);
}
{
	const a = at("SELECT x.| FROM (SELECT POST_ID AS pid, b.HIT, COUNT(*) cnt FROM TB_BOARD_POST b GROUP BY 1, 2) x");
	ok(a.refs[0]?.kind === "derived" && a.refs[0].cols?.join() === "pid,HIT,cnt", "(SELECT …) 별칭 = 그 열", a.refs);
}
{
	const a = at("SELECT EXTRACT(YEAR FROM REG_DT), | FROM TB_BOARD_POST p");
	ok(refNames(a).join() === "TB_BOARD_POST p", "함수 안 FROM(EXTRACT) 은 표가 아니다", refNames(a));
}
{
	const a = at("SELECT `p`.| FROM `TB_BOARD_POST` `p`");
	ok(a.kind === "member" && a.qualifier?.join() === "p" && refNames(a).join() === "TB_BOARD_POST p", "백틱 이름", refNames(a));
}
{
	const a = at("SELECT *| FROM BOARD");
	ok(!!a.star && !a.star.qualifier, "* 바로 뒤 = 펼치기 자리", a.star);
	const b = at("SELECT b.*| FROM BOARD b");
	ok(b.star?.qualifier === "b", "b.* 바로 뒤", b.star);
}
{
	const a = at("SELECT p.TITLE FROM TB_BOARD_POST p ORDER BY |");
	ok(a.clause === "order" && a.kind === "column", "ORDER BY = 열");
	const b = at("SELECT ROW_NUMBER() OVER (PARTITION BY p.BOARD_ID ORDER BY |) FROM TB_BOARD_POST p");
	ok(b.kind === "column" && refNames(b).join() === "TB_BOARD_POST p", "OVER(… ORDER BY) 안 = 열", refNames(b));
}
{
	const a = at("SELECT p.TITLE FROM TB_BOARD_POST p GROUP BY p.TITLE HAVING |");
	ok(a.clause === "having", "HAVING = 열");
}
{
	const used = at("SELECT * FROM TB_BOARD_POST tbp JOIN BOARD b ON |").used;
	ok(used.has("tbp") && used.has("board") && used.has("b"), "쓴 별칭·표 이름", [...used]);
}

// ── 문장 범위 ──
{
	const doc = "SELECT 1;\nSELECT * FROM BOARD \n";
	const stmts = splitSql(doc);
	const r = statementRange(stmts, doc, doc.length - 1);
	ok(doc.slice(r.from, r.to).startsWith("SELECT * FROM BOARD"), "문장 끝 뒤 빈칸도 그 문장", doc.slice(r.from, r.to));
	const doc2 = "SELECT 1;\n";
	const r2 = statementRange(splitSql(doc2), doc2, doc2.length);
	ok(r2.from === r2.to, "; 뒤 빈 자리 = 새 문장", r2);
}

// ── 별칭 ──
ok(suggestAlias("TB_BOARD_ARTICLE", []) === "tba", "TB_BOARD_ARTICLE → tba");
ok(suggestAlias("TB_BOARD_POST", ["tbp"]) === "tbp2", "겹치면 숫자", suggestAlias("TB_BOARD_POST", ["tbp"]));
ok(suggestAlias("orders", []) === "o", "orders → o");
ok(suggestAlias("orderItem", []) === "oi", "orderItem → oi");
ok(suggestAlias("INDEX_NOTE", []) === "in2", "예약어(in)는 피한다", suggestAlias("INDEX_NOTE", []));
ok(suggestAlias("BOARD", ["b"]) === "b2", "BOARD(b 사용 중) → b2");

// ── 열 detail 읽기 ──
{
	const c = parseColumn({ name: "POST_ID", kind: "column", detail: "bigint(20) · NOT NULL · PK" });
	ok(c.type === "bigint(20)" && c.pk && c.notNull && !c.idx, "열 detail: PK", c);
	const d = parseColumn({ name: "BOARD_ID", kind: "column", detail: "varchar(20) · 인덱스" });
	ok(d.type === "varchar(20)" && d.idx && !d.notNull, "열 detail: 인덱스·NULL", d);
	const e = parseColumn({ name: "id", kind: "column", detail: "bigint PK" });
	ok(e.type === "bigint" && e.pk, "열 detail: 붙어 온 PK", e);
}

// ── 조인 제안 ──
const col = (name: string, type: string, k = ""): ColInfo => ({ name, type, pk: k === "PK", idx: k === "IDX", notNull: k === "PK" });
const POST = [col("POST_ID", "bigint", "PK"), col("BOARD_ID", "varchar(20)", "IDX"), col("TITLE", "varchar(300)"), col("HIT", "int"), col("REG_DT", "datetime"), col("USE_YN", "char(1)")];
const BOARD = [col("BOARD_ID", "varchar(20)", "PK"), col("BOARD_NM", "varchar(100)"), col("REG_DT", "datetime"), col("USE_YN", "char(1)")];
const FILE = [col("FILE_ID", "varchar(20)", "PK"), col("FILE_SN", "int", "PK"), col("POST_ID", "bigint", "IDX"), col("FILE_NM", "varchar(200)")];
const FILE2 = [col("FILE_ID", "varchar(20)", "IDX"), col("FILE_SN", "int"), col("NOTE", "varchar(10)")];
const MENU = [col("MENU_ID", "varchar(20)", "PK"), col("PARENT_ID", "varchar(20)"), col("MENU_NM", "varchar(100)"), col("SORT_NO", "int")];
const CUSTOMER = [col("id", "bigint", "PK"), col("name", "varchar(100)"), col("created_at", "timestamp")];
const ORDERS = [col("id", "bigint", "PK"), col("customer_id", "bigint"), col("status", "varchar(20)"), col("created_at", "timestamp")];
{
	const h = suggestJoins({ name: "BOARD", alias: "b", cols: BOARD }, [{ name: "TB_BOARD_POST", alias: "a", cols: POST }], []);
	ok(h[0]?.text === "b.BOARD_ID = a.BOARD_ID", "PK 이름이 같은 열 → 첫 제안", h);
	ok(!h.some((x) => /REG_DT|USE_YN/.test(x.text)), "공통 감사 열(REG_DT·USE_YN)은 빼기", h);
}
{
	const h = suggestJoins({ name: "BOARD_FILE", alias: "f", cols: FILE }, [{ name: "TB_BOARD_POST", alias: "a", cols: POST }], []);
	ok(h[0]?.text === "f.POST_ID = a.POST_ID", "한쪽 PK 를 다른 쪽이 같은 이름으로", h);
}
{
	const h = suggestJoins({ name: "FILE_COPY", alias: "c", cols: FILE2 }, [{ name: "BOARD_FILE", alias: "f", cols: FILE }], []);
	ok(h[0]?.text === "c.FILE_ID = f.FILE_ID AND c.FILE_SN = f.FILE_SN", "복합 PK → AND 로 한 줄", h);
}
{
	const h = suggestJoins({ name: "MENU", alias: "p", cols: MENU }, [{ name: "MENU", alias: "c", cols: MENU }], []);
	ok(h.length > 0 && h.slice(0, 2).some((x) => x.text === "p.MENU_ID = c.PARENT_ID"), "자기 조인: PARENT_ID ↔ PK", h);
	ok(!h.some((x) => x.text === "p.MENU_ID = c.MENU_ID"), "자기 조인: 같은 PK 끼리는 내지 않는다", h);
}
{
	const h = suggestJoins({ name: "customer", alias: "c", cols: CUSTOMER }, [{ name: "orders", alias: "o", cols: ORDERS }], []);
	ok(h[0]?.text === "c.id = o.customer_id", "<표>_id ↔ id 이름 규칙", h);
	ok(!h.some((x) => x.text === "c.id = o.id"), "id = id 는 맨 위가 아니다(있어도 아래)", h);
}
{
	const h = suggestJoins({ name: "orders", alias: "o", cols: ORDERS }, [{ name: "customer", alias: "c", cols: CUSTOMER }], [{ table: "orders", column: "customer_id", refTable: "customer", refColumn: "id" }]);
	ok(h[0]?.text === "o.customer_id = c.id" && h[0].why === "FK", "FK 가 있으면 FK 가 첫 제안", h);
}
{
	const h = suggestJoins({ name: "orders", cols: ORDERS }, [{ name: "customer", cols: CUSTOMER }], []);
	ok(h[0]?.text === "orders.customer_id = customer.id", "별칭이 없으면 표 이름으로", h);
}

// ── 거르기 ──
{
	ok(matchLabel("FIRST_REG_DATE", "fi")?.tier === 0, "머리");
	ok(matchLabel("FIRST_REG_DATE", "reg")?.tier === 1, "조각 머리");
	ok(matchLabel("FIRST_REG_DATE", "frd")?.tier === 1, "머리글자");
	ok(matchLabel("FIRST_REG_DATE", "dat")?.tier === 1, "조각 머리(뒤)");
	ok(matchLabel("BOARD_ID", "rd")?.tier === 2, "중간");
	ok(matchLabel("BOARD_ID", "zz") === null, "안 맞음");
	const r = rankFilter(
		[
			{ label: "select", rank: 6 },
			{ label: "SEQ_NO", rank: 0 },
			{ label: "USER_SEQ", rank: 0 },
			{ label: "SUM", rank: 5 },
		],
		"se",
	);
	ok(r.options.map((o) => o.label).join() === "SEQ_NO,select,USER_SEQ", "소문자로 쳐도 대문자 열이 키워드보다 위", r.options.map((o) => o.label));
}

// ── 소스(끝까지): 가짜 DB 로 실제 후보 목록 ──
const TABLES: Record<string, { view?: boolean; rows: number; cols: [string, string, string?][] }> = {
	TB_BOARD_POST: { rows: 100001, cols: [["POST_ID", "bigint(20)", "PK"], ["BOARD_ID", "varchar(20)", "IDX"], ["TITLE", "varchar(300)"], ["HIT", "int(11)"], ["REG_DT", "datetime"]] },
	TB_BOARD_POST_BAK: { rows: 100001, cols: [["POST_ID", "bigint(20)", "IDX"], ["BOARD_ID", "varchar(20)"], ["HIT", "int(11)"]] },
	BOARD: { rows: 120, cols: [["BOARD_ID", "varchar(20)", "PK"], ["BOARD_NM", "varchar(100)"], ["REG_DT", "datetime"]] },
	BOARD_FILE: { rows: 9800, cols: [["FILE_ID", "varchar(20)", "PK"], ["FILE_SN", "int(11)", "PK"], ["POST_ID", "bigint(20)", "IDX"], ["FILE_NM", "varchar(200)"]] },
	V_POST_SUMMARY: { view: true, rows: 0, cols: [["BOARD_ID", "varchar(20)"], ["CNT", "bigint(21)"]] },
};
let queries = 0;
const meta = createMeta({
	engine: "mariadb",
	tree: async (path): Promise<TreeNode[]> => {
		queries++;
		if (!path.length) return ["shop", "archive"].map((name) => ({ name, kind: "schema" }));
		if (path.length === 1) return path[0] === "shop" ? Object.entries(TABLES).map(([name, t]) => ({ name, kind: t.view ? "view" : "table" })) : [{ name: "OLD_POST", kind: "table" }];
		const t = TABLES[path[1]];
		return (t?.cols ?? []).map(([name, type, k]) => ({ name, kind: "column", detail: `${type}${k === "PK" ? " · NOT NULL · PK" : k === "IDX" ? " · 인덱스" : ""}` }));
	},
	query: async (sql) => {
		if (/DATABASE\(\)/.test(sql)) return [["shop"]];
		if (/table_rows/.test(sql)) return Object.entries(TABLES).map(([n, t]) => [n, String(t.rows)]);
		return [];
	},
});
const settings = { alias: true, qualify: true, words: true };
const src = createSource(meta, () => settings);
async function complete(sql: string, explicit = false): Promise<CompletionResult | null> {
	const pos = sql.indexOf("|");
	const state = EditorState.create({ doc: sql.replace("|", "") });
	return src(new CompletionContext(state, pos, explicit));
}
const labels = (r: CompletionResult | null, n = 6) => (r?.options ?? []).slice(0, n).map((o) => o.displayLabel ?? o.label);
const applyOf = (r: CompletionResult | null, label: string) => {
	const o = r?.options.find((x) => x.label === label);
	return typeof o?.apply === "string" ? o.apply : o?.label;
};

{
	const r = await complete("SELECT po| FROM TB_BOARD_POST a");
	ok(labels(r, 1)[0] === "POST_ID", "SELECT 목록에서 po → 열 POST_ID 가 첫째", labels(r));
	ok(applyOf(r, "POST_ID") === "a.POST_ID", "별칭이 있으면 a.열 로 넣는다", applyOf(r, "POST_ID"));
}
{
	settings.qualify = false;
	const r = await complete("SELECT ti| FROM TB_BOARD_POST a");
	ok(applyOf(r, "TITLE") === "TITLE", "a.열 끄면 이름만", applyOf(r, "TITLE"));
	const r2 = await complete("SELECT b| FROM TB_BOARD_POST a JOIN BOARD b ON b.BOARD_ID = a.BOARD_ID");
	const both = (r2?.options ?? []).filter((o) => o.label === "BOARD_ID").map((o) => o.apply);
	ok(both.length === 2 && both.includes("a.BOARD_ID") && both.includes("b.BOARD_ID"), "겹치는 열은 끄더라도 별칭을 붙인다", both);
	settings.qualify = true;
}
{
	const r = await complete("SELECT * FROM |");
	ok(r !== null && labels(r, 10).includes("TB_BOARD_POST"), "FROM 뒤 빈칸 → 표 목록이 저절로", labels(r, 10));
	ok(applyOf(r, "TB_BOARD_POST") === "TB_BOARD_POST tbp", "표를 고르면 별칭(tbp)도", applyOf(r, "TB_BOARD_POST"));
	const o = r?.options.find((x) => x.label === "TB_BOARD_POST");
	ok(o?.detail === "10만 행", "표 행 수(추정)", o?.detail);
	ok(labels(r, 50).includes("archive"), "다른 스키마 이름도 후보", labels(r, 50));
}
{
	const r = await complete("SELECT * FROM TB_BOARD_POST tbp JOIN |");
	ok(applyOf(r, "TB_BOARD_POST_BAK") === "TB_BOARD_POST_BAK tbpb", "별칭이 쓴 것과 겹치지 않게", applyOf(r, "TB_BOARD_POST_BAK"));
	settings.alias = false;
	const r2 = await complete("SELECT * FROM |");
	ok(applyOf(r2, "BOARD") === "BOARD", "별칭 끄면 이름만", applyOf(r2, "BOARD"));
	settings.alias = true;
	const r3 = await complete("SELECT * FROM | x");
	ok(applyOf(r3, "BOARD") === "BOARD", "뒤에 이미 별칭이 있으면 붙이지 않는다", applyOf(r3, "BOARD"));
}
{
	const r = await complete("SELECT * FROM TB_BOARD_POST a JOIN BOARD_FILE f ON |");
	ok(labels(r, 1)[0] === "f.POST_ID = a.POST_ID", "ON 뒤 빈칸 → 조인 조건이 첫째", labels(r));
}
{
	const r = await complete("SELECT a.| FROM TB_BOARD_POST a");
	ok(labels(r, 3).join() === "*,POST_ID,BOARD_ID", "별칭. 뒤 → 그 표의 열(* 먼저)", labels(r));
	ok(applyOf(r, "POST_ID") === "POST_ID", "점 뒤 열은 이름만");
}
{
	const r = await complete("SELECT * FROM archive.|");
	ok(labels(r).join() === "OLD_POST" && applyOf(r, "OLD_POST") === "OLD_POST op", "스키마. 뒤 → 그 스키마 표(+별칭)", [labels(r), applyOf(r, "OLD_POST")]);
}
{
	const r = await complete("INSERT INTO BOARD (|");
	ok(labels(r, 2).join() === "열 3개 모두,BOARD_ID", "INSERT INTO t ( → 열(모두 먼저)", labels(r));
	ok((r?.options[0].apply as string) === "BOARD_ID, BOARD_NM, REG_DT", "열 모두 넣기", r?.options[0].apply);
}
{
	const r = await complete("UPDATE BOARD b SET |", true);
	ok(applyOf(r, "BOARD_NM") === "BOARD_NM", "SET 의 열은 별칭 없이(PostgreSQL 은 SET b.열 이 오류)", applyOf(r, "BOARD_NM"));
}
{
	const r = await complete("SELECT co| FROM TB_BOARD_POST p");
	const l = labels(r, 20);
	ok(l.indexOf("COUNT") >= 0 && l.indexOf("COUNT") < l.indexOf("COALESCE") + 5, "함수 후보(COUNT)", l);
	const r2 = await complete("select co| from TB_BOARD_POST p");
	ok(labels(r2, 20).includes("count"), "소문자로 치면 함수·키워드도 소문자", labels(r2, 20));
}
{
	const r = await complete("SELECT * FROM TB_BOARD_POST p wh|");
	ok(labels(r, 1)[0] === "WHERE", "표 뒤 wh → WHERE", labels(r));
}
{
	const r = await complete("SELECT p.TITLE FROM TB_BOARD_POST p WHERE p.HIT > 10 AND ti|");
	ok(labels(r, 1)[0] === "TITLE", "WHERE 에서 열이 먼저", labels(r));
}
{
	const r = await complete("SELECT MY_SPECIAL_WORD FROM BOARD;\nSELECT * FROM BOARD b WHERE MY_SP|");
	const l = labels(r, 50);
	ok(l[l.length - 1] === "MY_SPECIAL_WORD", "문서 낱말은 맨 뒤", l);
	settings.words = false;
	const r2 = await complete("SELECT MY_SPECIAL_WORD FROM BOARD;\nSELECT * FROM BOARD b WHERE MY_SP|");
	ok(!labels(r2, 50).includes("MY_SPECIAL_WORD"), "문서 낱말 끄기", labels(r2, 50));
	settings.words = true;
}
{
	const r = await complete("SELECT *| FROM BOARD b JOIN TB_BOARD_POST p ON p.BOARD_ID = b.BOARD_ID", true);
	const s = r?.options.find((o) => o.displayLabel?.startsWith("*"));
	ok(s?.displayLabel === "* → 열 8개 펼치기", "* 뒤 Ctrl+Space → 열 펼치기 후보", s?.displayLabel);
	const list = await src.starColumns(src.read(EditorState.create({ doc: "SELECT b.* FROM BOARD b JOIN TB_BOARD_POST p ON p.BOARD_ID = b.BOARD_ID" }), 10).a);
	ok(list?.text === "b.BOARD_ID, b.BOARD_NM, b.REG_DT", "b.* 펼치기는 그 표만", list);
}
{
	const r = await complete("SELECT * FROM BOARD WHERE x = '|'");
	ok(r === null, "문자열 안은 목록 없음");
	const r2 = await complete("SELECT * FROM BOARD WHERE |");
	ok(r2 === null, "WHERE 뒤 빈칸만으로는 저절로 열지 않는다(Ctrl+Space 로)");
}
{
	const before = queries;
	await complete("SELECT * FROM |");
	await complete("SELECT a.| FROM TB_BOARD_POST a");
	ok(queries === before, "같은 연결은 다시 읽지 않는다(캐시)", queries - before);
}
{
	// update — 이어 치면 다시 묻지 않고 그 자리에서 거른다
	const doc = "SELECT * FROM BOARD b WHERE b";
	const state = EditorState.create({ doc });
	const r = await src(new CompletionContext(state, doc.length, false));
	const next = state.update({ changes: { from: doc.length, insert: "oard_n" } }).state;
	const u = r?.update?.(r, r.from, next.doc.length, new CompletionContext(next, next.doc.length, false));
	ok(u?.options[0]?.label === "BOARD_NM", "이어 친 글자로 다시 거르기(update)", u?.options.slice(0, 3).map((o) => o.label));
}
{
	// 큰 스키마 — 표 5천 개에서도 첫 목록이 빠르게
	const many = createMeta({
		engine: "postgres",
		tree: async (path) => (path.length === 0 ? [{ name: "public", kind: "schema" as const }] : Array.from({ length: 5000 }, (_, i) => ({ name: `table_${i}`, kind: "table" as const }))),
	});
	const s2 = createSource(many, () => settings);
	const st = EditorState.create({ doc: "select * from tab" });
	await s2(new CompletionContext(st, st.doc.length, false));
	const t0 = performance.now();
	const r = await s2(new CompletionContext(st, st.doc.length, false));
	const ms = performance.now() - t0;
	// 기준은 넉넉히(다른 일로 바쁜 PC 에서도) — 실제 값은 아래 줄에 찍는다
	console.log(`  표 5천 개 목록(두 번째 호출): ${ms.toFixed(1)}ms`);
	ok((r?.options.length ?? 0) > 50 && ms < 150, `표 5천 개 목록 ${ms.toFixed(1)}ms`, ms);
}

console.log(`${fail ? "실패" : "통과"} — ${pass} 통과, ${fail} 실패`);
if (fail) process.exit(1);
