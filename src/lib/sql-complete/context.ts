/**
 * 커서 자리의 SQL 문맥 — 어느 절인지, 이 문장(과 바깥 문장)이 쓰는 표·별칭은 무엇인지, 무엇을 후보로 내야 하는지.
 * lang-sql 의 구문 트리는 문장 안이 납작한 토큰 줄이라(절 노드가 없다) 토큰을 직접 읽는다. 반쯤 쓴 문장에서도 돌아야 한다.
 */
import { isName, nameOf, type Tok, type TokOpts, tokenize } from "./tokens";

export type TableRef = {
	schema?: string;
	name: string;
	alias?: string;
	/** 문장 안 이름 시작 위치 */
	at: number;
	/** 0 = 맨 바깥 문장, 그 밖은 (SELECT …) 범위 번호 */
	scope: number;
	kind: "table" | "cte" | "derived";
	/** 어디서 붙었나 — into 는 INSERT 대상(열 문맥에선 다른 표가 없을 때만) */
	role: "from" | "join" | "update" | "into" | "table" | "using";
	/** WITH 이름·(SELECT …) 별칭이면 그 SELECT 가 내는 열 이름 */
	cols?: string[];
};

export type Clause = "none" | "select" | "from" | "join" | "on" | "where" | "group" | "order" | "having" | "set" | "values" | "into" | "update" | "table" | "using" | "limit" | "returning" | "other";

export type Kind =
	/** 문자열·주석 안 — 완성하지 않는다 */
	| "none"
	/** 문장 머리 등 — 키워드만 */
	| "keyword"
	/** FROM·JOIN·UPDATE·INTO·TABLE 뒤 — 표·뷰 */
	| "table"
	/** 표 이름(·별칭) 바로 뒤 — 다음 절 키워드 */
	| "afterTable"
	/** SELECT 목록·WHERE·ON·GROUP BY·ORDER BY·HAVING·SET — 열 먼저 */
	| "column"
	/** 별칭. / 표. / 스키마. 뒤 */
	| "member"
	/** INSERT INTO t ( … ) 안 — t 의 열 */
	| "insertColumns";

export type Analysis = {
	kind: Kind;
	clause: Clause;
	/** 문장 첫 키워드(SELECT·INSERT·UPDATE·DELETE·WITH …) */
	head: string;
	/** 바꿀 범위(문장 기준) — 친 낱말 */
	from: number;
	to: number;
	prefix: string;
	/** 인용을 열고 치는 중이면 그 따옴표 */
	quote?: string;
	/** member: 점 앞 이름들(a.b. → [a, b]) */
	qualifier?: string[];
	/** 보이는 표 — 커서 범위 먼저, 그다음 바깥 범위 */
	refs: TableRef[];
	/** 커서 범위 번호 — refs 중 scope 가 이것과 다르면 바깥 문장 */
	scope: number;
	/** 이 문장이 이미 쓰는 별칭·표 이름(소문자) — 별칭 제안이 겹치지 않게 */
	used: Set<string>;
	/** table: 표 뒤에 별칭을 붙여도 되는 자리(FROM·JOIN·UPDATE, DELETE FROM 은 아님) */
	aliasOk?: boolean;
	/** 커서 뒤가 이미 이름(별칭)이면 별칭을 또 붙이지 않는다 */
	nextIsName?: boolean;
	/** ON 바로 뒤 — 이번 JOIN 의 표와 앞의 표들 */
	join?: { right: TableRef; left: TableRef[] };
	/** insertColumns: 대상 표 */
	insertTable?: TableRef;
	/** 커서 바로 앞이 SELECT 목록의 * (또는 a.*) */
	star?: { from: number; to: number; qualifier?: string };
};

/** 별칭이 될 수 없는 낱말 — 표 이름 뒤에 와도 다음 절이다 */
const RESERVED = new Set(
	(
		"WHERE ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL STRAIGHT_JOIN GROUP ORDER HAVING LIMIT OFFSET FETCH UNION INTERSECT EXCEPT MINUS " +
		"SET VALUES VALUE SELECT FROM USING WINDOW FOR LATERAL USE FORCE IGNORE PARTITION RETURNING WHEN THEN ELSE END AND OR NOT AS INTO WITH " +
		"START CONNECT TABLESAMPLE PIVOT UNPIVOT LOCK APPLY DEFAULT ORDER BY ASC DESC IS NULL IN LIKE BETWEEN EXISTS CASE QUALIFY OPTION " +
		"DUPLICATE KEY UPDATE DELETE INSERT TOP DISTINCT ALL ONLY NOLOCK WAIT NOWAIT SKIP SHARE MODE OUTPUT TABLE"
	).split(" "),
);
export const isReserved = (w: string) => RESERVED.has(w.toUpperCase());

type Group = { open: number; close: number; parent: number; query: boolean; scope: number };

/** 문장 하나 읽기 — stmt 는 문장 글, pos 는 그 안의 커서 위치 */
export function analyze(stmt: string, pos: number, opts: TokOpts = {}): Analysis {
	const toks = tokenize(stmt, opts);
	const base: Analysis = { kind: "keyword", clause: "none", head: "", from: pos, to: pos, prefix: "", refs: [], scope: 0, used: new Set() };

	// 커서가 문자열·주석 안이면 끝
	for (const t of toks) {
		if (t.from >= pos) break;
		const lineComment = t.kind === "comment" && !t.text.startsWith("/*");
		if ((t.kind === "str" || t.kind === "comment") && (pos < t.to || (pos === t.to && (t.open || lineComment)))) return { ...base, kind: "none" };
	}

	// 괄호 묶음 — 묶음마다 부모·범위(쿼리 묶음이면 새 범위). gid[i] = 토큰이 바로 속한 묶음(여는·닫는 괄호는 바깥 묶음 소속)
	const groups: Group[] = [{ open: -1, close: toks.length, parent: -1, query: true, scope: 0 }];
	const gid: number[] = new Array(toks.length);
	/** 여는 괄호 토큰 번호 → 묶음 번호 */
	const groupAt = new Map<number, number>();
	const stack = [0];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		const top = stack[stack.length - 1];
		if (t.kind === "punct" && t.up === "(") {
			gid[i] = top;
			let j = i + 1;
			while (j < toks.length && toks[j].kind === "comment") j++;
			const nx = toks[j];
			const query = !!nx && nx.kind === "word" && (nx.up === "SELECT" || nx.up === "WITH");
			const g = groups.length;
			groupAt.set(i, g);
			groups.push({ open: i, close: toks.length, parent: top, query, scope: query ? g : groups[top].scope });
			stack.push(g);
		} else if (t.kind === "punct" && t.up === ")" && stack.length > 1) {
			const g = stack.pop() as number;
			groups[g].close = i;
			gid[i] = stack[stack.length - 1];
		} else gid[i] = top;
	}
	const directs: number[][] = groups.map(() => []);
	for (let i = 0; i < toks.length; i++) if (toks[i].kind !== "comment") directs[gid[i]].push(i);
	const direct = (g: number) => directs[g];
	/** 범위(쿼리 묶음) 의 부모 범위 */
	const parentScope = (s: number) => (s === 0 ? -1 : groups[groups[s].parent].scope);

	// 친 낱말(prefix)
	let prefixTok = -1;
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.from < pos && pos <= t.to && isName(t)) prefixTok = i;
		if (t.from >= pos) break;
	}
	let from = pos;
	let prefix = "";
	let quote: string | undefined;
	if (prefixTok >= 0) {
		const t = toks[prefixTok];
		from = t.from;
		prefix = stmt.slice(t.from, pos);
		if (t.kind === "qid") {
			quote = t.text[0];
			from = t.from + 1;
			prefix = prefix.slice(1);
		}
	}
	const before: number[] = [];
	for (let i = 0; i < toks.length; i++) {
		if (toks[i].from >= (prefixTok >= 0 ? toks[prefixTok].from : pos)) break;
		if (toks[i].kind !== "comment") before.push(i);
	}
	const prevI = before.length ? before[before.length - 1] : -1;
	const prev = prevI >= 0 ? toks[prevI] : undefined;
	const after = toks.findIndex((t, i) => t.from >= pos && i !== prefixTok && t.kind !== "comment");
	const nextIsName = after >= 0 && isName(toks[after]) && !(toks[after].kind === "word" && isReserved(toks[after].up));

	// 커서가 든 묶음·범위
	let cg = 0;
	for (let g = 1; g < groups.length; g++) {
		const gr = groups[g];
		const openEnd = toks[gr.open].to;
		const closeAt = gr.close < toks.length ? toks[gr.close].from : Number.POSITIVE_INFINITY;
		if (openEnd <= (prefixTok >= 0 ? toks[prefixTok].from : pos) && pos <= closeAt && gr.open > (cg > 0 ? groups[cg].open : -1)) cg = g;
	}
	const cursorScope = groups[cg].scope;

	// 범위마다 표 읽기(+ WITH 이름)
	const ctes = new Map<string, string[]>();
	const refsByScope = new Map<number, TableRef[]>();
	const clauseAt = new Map<number, { clause: Clause; at: number }[]>();
	const used = new Set<string>();

	/** (SELECT …) 범위가 내는 열 이름 */
	const outputs = (scopeGroup: number): string[] => {
		const d = direct(scopeGroup);
		let k = d.findIndex((i) => toks[i].kind === "word" && toks[i].up === "SELECT");
		if (k < 0) return [];
		const cols: string[] = [];
		let item: Tok[] = [];
		const flush = () => {
			if (!item.length) return;
			const last = item[item.length - 1];
			if (isName(last) && !(last.kind === "word" && isReserved(last.up) && last.up !== "KEY")) cols.push(nameOf(last));
			item = [];
		};
		for (k++; k < d.length; k++) {
			const t = toks[d[k]];
			if (t.kind === "word" && (t.up === "FROM" || t.up === "INTO" || t.up === "WHERE" || t.up === "UNION")) break;
			if (t.kind === "word" && (t.up === "DISTINCT" || t.up === "ALL" || t.up === "TOP") && !item.length) continue;
			if (t.kind === "punct" && t.up === ",") flush();
			else item.push(t);
		}
		flush();
		return cols;
	};

	const scopeGroups = groups.map((g, i) => [g, i] as const).filter(([g]) => g.query);
	let head = "";
	for (const [, g] of scopeGroups) {
		const s = groups[g].scope;
		const d = direct(g);
		if (g === 0) head = d.length ? toks[d[0]].up : "";
		const refs: TableRef[] = [];
		const clauses: { clause: Clause; at: number }[] = [];
		let expect: TableRef["role"] | null = null;
		let clause = "none" as Clause;
		for (let k = 0; k < d.length; k++) {
			const i = d[k];
			const t = toks[i];
			if (t.kind === "word") {
				const w = t.up;
				let c: Clause | null = null;
				if (w === "SELECT") c = "select";
				else if (w === "FROM") c = "from";
				else if (w === "JOIN" || w === "STRAIGHT_JOIN") c = "join";
				else if (w === "APPLY") c = "join";
				else if (w === "ON") c = clause === "join" || clause === "on" || clause === "from" ? "on" : "other";
				else if (w === "WHERE") c = "where";
				else if (w === "GROUP") c = "group";
				else if (w === "ORDER") c = "order";
				else if (w === "HAVING") c = "having";
				else if (w === "SET") c = "set";
				else if (w === "VALUES" || w === "VALUE") c = "values";
				else if (w === "INTO") c = "into";
				else if (w === "UPDATE") c = d[0] === i || head === "UPDATE" ? "update" : "set";
				else if (w === "TABLE" && k > 0 && /^(TRUNCATE|ALTER|LOCK|DROP|ANALYZE|OPTIMIZE|CHECK|REPAIR|RENAME)$/.test(toks[d[k - 1]].up)) c = "table";
				else if (w === "USING" && (head === "MERGE" || head === "DELETE")) c = "using";
				else if (w === "LIMIT" || w === "OFFSET" || w === "FETCH") c = "limit";
				else if (w === "RETURNING") c = "returning";
				else if (w === "UNION" || w === "INTERSECT" || w === "EXCEPT" || w === "MINUS") c = "none";
				else if (w === "WITH" && k === 0) c = "other";
				if (c) {
					clause = c;
					clauses.push({ clause: c, at: t.from });
					expect = c === "from" ? "from" : c === "join" ? "join" : c === "update" ? "update" : c === "into" ? "into" : c === "table" ? "table" : c === "using" ? "using" : null;
					continue;
				}
				if (expect && (w === "LATERAL" || w === "ONLY")) continue;
			}
			// WITH 이름 [(열…)] AS ( … )
			if (k > 0 && isName(t) && clause === "other" && head === "WITH") {
				const nx = toks[d[k + 1]];
				let j = k + 1;
				let cols: string[] | undefined;
				if (nx && nx.kind === "punct" && nx.up === "(") {
					const g2 = (groupAt.get(d[k + 1]) ?? -1);
					cols = [];
					for (let x = d[k + 1] + 1; g2 > 0 && x < groups[g2].close; x++) if (isName(toks[x]) && gid[x] === g2) cols.push(nameOf(toks[x]));
					j = k + 2;
				}
				const as = toks[d[j]];
				if (as && as.kind === "word" && as.up === "AS") {
					let m = j + 1;
					while (toks[d[m]] && toks[d[m]].kind === "word" && (toks[d[m]].up === "NOT" || toks[d[m]].up === "MATERIALIZED")) m++;
					const op = toks[d[m]];
					if (op && op.kind === "punct" && op.up === "(") {
						const g2 = (groupAt.get(d[m]) ?? -1);
						ctes.set(nameOf(t).toLowerCase(), cols?.length ? cols : g2 > 0 ? outputs(g2) : []);
						used.add(nameOf(t).toLowerCase());
						// 그 뒤 , 이름 AS (…) 가 이어질 수 있다 — 닫는 괄호까지 건너뛴다
						const close = g2 > 0 ? groups[g2].close : d[m];
						while (k < d.length - 1 && d[k + 1] <= close) k++;
						continue;
					}
				}
			}
			if (!expect) {
				// FROM a, b — 쉼표 뒤 다시 표
				if (t.kind === "punct" && t.up === "," && (clause === "from" || clause === "update")) expect = clause === "from" ? "from" : "update";
				continue;
			}
			// 표 자리
			if (t.kind === "punct" && t.up === "(") {
				// (SELECT …) 별칭
				const g2 = (groupAt.get(i) ?? -1);
				const close = g2 > 0 ? groups[g2].close : i;
				let m = k + 1;
				while (m < d.length && d[m] <= close) m++;
				let alias: string | undefined;
				const a1 = toks[d[m]];
				if (a1 && a1.kind === "word" && a1.up === "AS" && isName(toks[d[m + 1]])) alias = nameOf(toks[d[m + 1]]);
				else if (isName(a1) && !(a1.kind === "word" && isReserved(a1.up))) alias = nameOf(a1);
				if (g2 > 0 && groups[g2].query && alias) {
					refs.push({ name: alias, alias, at: t.from, scope: s, kind: "derived", role: expect, cols: outputs(g2) });
					used.add(alias.toLowerCase());
				}
				k = m - 1;
				expect = null;
				continue;
			}
			if (!isName(t) || (t.kind === "word" && isReserved(t.up))) {
				expect = null;
				continue;
			}
			// 스키마.표 이름 잇기
			const parts = [nameOf(t)];
			let m = k + 1;
			while (m + 1 < d.length && toks[d[m]].kind === "punct" && toks[d[m]].up === "." && isName(toks[d[m + 1]]) && toks[d[m]].from === toks[d[m - 1]].to) {
				parts.push(nameOf(toks[d[m + 1]]));
				m += 2;
			}
			// 이름이 점으로 끝나면(치는 중) 표로 치지 않는다
			if (toks[d[m]] && toks[d[m]].kind === "punct" && toks[d[m]].up === "." && toks[d[m]].from === toks[d[m - 1]].to) {
				k = m;
				expect = null;
				continue;
			}
			let alias: string | undefined;
			const a1 = toks[d[m]];
			if (expect !== "into" || head === "MERGE") {
				if (a1 && a1.kind === "word" && a1.up === "AS" && isName(toks[d[m + 1]])) {
					alias = nameOf(toks[d[m + 1]]);
					m += 2;
				} else if (isName(a1) && !(a1.kind === "word" && isReserved(a1.up)) && !(a1.from === pos || (prefixTok >= 0 && d[m] === prefixTok))) {
					alias = nameOf(a1);
					m += 1;
				}
			}
			const name = parts[parts.length - 1];
			const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
			// 지금 치는 낱말은 아직 표가 아니다
			if (!(prefixTok >= 0 && i === prefixTok)) {
				const cte = !schema ? ctes.get(name.toLowerCase()) : undefined;
				refs.push({ schema, name, alias, at: t.from, scope: s, kind: cte ? "cte" : "table", role: expect, cols: cte });
				used.add(name.toLowerCase());
				if (alias) used.add(alias.toLowerCase());
			}
			k = m - 1;
			expect = null;
		}
		refsByScope.set(s, refs);
		clauseAt.set(s, clauses);
	}

	// 커서 자리 절
	const cl = clauseAt.get(cursorScope) ?? [];
	const cutAt = prefixTok >= 0 ? toks[prefixTok].from : pos;
	let clause: Clause = "none";
	for (const c of cl) if (c.at < cutAt) clause = c.clause;

	// 보이는 표 — 커서 범위 먼저, 바깥 범위(상관 서브쿼리)는 뒤에
	const refs: TableRef[] = [];
	for (let s = cursorScope; s >= 0; s = parentScope(s)) refs.push(...(refsByScope.get(s) ?? []));

	const out: Analysis = { ...base, clause, head, from, to: pos, prefix, quote, refs, scope: cursorScope, used, nextIsName };

	// 점 뒤
	if (prev && prev.kind === "punct" && prev.up === "." && (prefixTok < 0 || prev.to === toks[prefixTok].from)) {
		const q: string[] = [];
		let j = before.length - 1;
		while (j >= 1 && toks[before[j]].kind === "punct" && toks[before[j]].up === "." && isName(toks[before[j - 1]]) && toks[before[j - 1]].to === toks[before[j]].from) {
			q.unshift(nameOf(toks[before[j - 1]]));
			j -= 2;
			if (j < 1 || !(toks[before[j]].kind === "punct" && toks[before[j]].up === ".")) break;
		}
		if (q.length) return { ...out, kind: "member", qualifier: q, aliasOk: clause === "from" || clause === "join" || clause === "update" };
	}
	// * 바로 뒤(친 낱말 없음)
	if (!prefix && prev && prev.kind === "punct" && prev.up === "*" && clause === "select" && prev.to <= pos) {
		const dot = before.length >= 3 ? toks[before[before.length - 2]] : undefined;
		const qn = before.length >= 3 ? toks[before[before.length - 3]] : undefined;
		const qualified = dot && dot.kind === "punct" && dot.up === "." && isName(qn);
		return { ...out, kind: "column", star: { from: qualified && qn ? qn.from : prev.from, to: prev.to, qualifier: qualified && qn ? nameOf(qn) : undefined } };
	}

	if (clause === "from" || clause === "join" || clause === "update" || clause === "into" || clause === "table" || clause === "using") {
		// INSERT INTO t ( … ) 안
		if (cg > 0 && clause === "into") {
			const opener = groups[cg].open;
			const t = refsByScope.get(cursorScope)?.find((r) => r.role === "into");
			const beforeOpen = toks[opener - 1];
			if (t && beforeOpen && isName(beforeOpen) && groups[cg].scope === cursorScope) return { ...out, kind: "insertColumns", insertTable: t };
		}
		const kw = prev && prev.kind === "word" ? prev.up : "";
		const tablePos =
			(prev && prev.kind === "word" && (kw === "FROM" || kw === "JOIN" || kw === "STRAIGHT_JOIN" || kw === "UPDATE" || kw === "INTO" || kw === "TABLE" || kw === "USING" || kw === "LATERAL" || kw === "ONLY" || kw === "APPLY")) ||
			(prev && prev.kind === "punct" && prev.up === "," && (clause === "from" || clause === "update"));
		if (tablePos) {
			const aliasOk = (clause === "from" && head !== "DELETE") || clause === "join" || clause === "update" || clause === "using";
			return { ...out, kind: "table", aliasOk };
		}
		if (prev && prev.kind === "punct" && prev.up === "(") return { ...out, kind: "keyword" };
		return { ...out, kind: "afterTable" };
	}
	if (clause === "on") {
		const onKw = prev && prev.kind === "word" && prev.up === "ON";
		if (onKw) {
			const scopeRefs = refsByScope.get(cursorScope) ?? [];
			const before = scopeRefs.filter((r) => r.at < prev.from);
			const right = before[before.length - 1];
			if (right) return { ...out, kind: "column", join: { right, left: before.slice(0, -1) } };
		}
		return { ...out, kind: "column" };
	}
	// 문장 머리(앞에 아무것도 없음)·WITH 머리 — 키워드
	if (clause === "none") return { ...out, kind: prevI < 0 || head === "WITH" ? "keyword" : "column" };
	return { ...out, kind: "column" };
}

/** 문서 위치 → 문장 범위. 커서가 문장 끝 뒤 공백에 있어도(; 를 넘지 않으면) 그 문장으로 본다 */
export function statementRange(stmts: { from: number; to: number }[], doc: string, pos: number): { from: number; to: number } {
	let last: { from: number; to: number } | null = null;
	for (const s of stmts) {
		if (s.from > pos) break;
		last = s;
	}
	if (!last) return { from: pos, to: pos };
	if (pos <= last.to) return last;
	if (doc.slice(last.to, pos).includes(";")) return { from: pos, to: pos };
	return { from: last.from, to: pos };
}

/** 열 문맥에서 열을 낼 표 — INSERT 대상은 다른 표가 없을 때만(INSERT … SET·ON DUPLICATE KEY UPDATE) */
export function columnRefs(a: Analysis): TableRef[] {
	const own = a.refs.filter((r) => r.role !== "into");
	return own.length ? own : a.refs;
}
