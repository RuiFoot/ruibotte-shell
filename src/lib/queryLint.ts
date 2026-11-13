/**
 * 튜닝 도우미 — sql_map(Rust) 이 읽은 구조 + 캐시한 메타데이터(형식·PK·FK·인덱스)로
 * ① 구조 경고(없는 표·열, 데카르트 곱, 형식이 다른 비교, FK 없는 조인) ② 정적 검사 ③ 인덱스 초안을 만든다.
 * 서버에는 묻지 않는다. 인덱스 초안은 글로만 — 실행하는 길은 없다(복사·새 탭에 넣기만).
 */
import type { Fk, IndexInfo } from "./dbtools";
import type { ColMeta } from "./edits";
import { quoteIdentFor } from "./engines";

export type Pos = [number, number] | null;
/** 단계의 입력 — 표 하나 또는 앞 조인 */
export type MapIn = { t: number } | { j: number };
/** range: 편집기 강조 범위(서브쿼리는 괄호까지, CTE 는 WITH 이름 AS (…)) · src: FROM 을 다 읽은 결과 */
/** limit·offset: 숫자로 쓴 LIMIT·TOP·FETCH·OFFSET(자리표시자면 없음) */
export type MapScope = { id: number; kind: "main" | "cte" | "derived" | "subquery" | "union"; name: string | null; parent: number | null; pos: Pos; range?: Pos; src?: MapIn; limit?: number; offset?: number };
/** span: 이름 + 별칭 */
export type MapTable = { id: number; scope: number; schema: string | null; name: string; alias: string | null; cte: number | null; derived: number | null; virt: boolean; target: boolean; qualText: string; pos: Pos; span?: Pos };
export type MapPair = { a: number; b: number; op: string };
/** clause: `LEFT JOIN 표 ON …` 전체 · ia/ib: 두 입력 */
export type MapJoin = { scope: number; left: number | null; right: number | null; kind: string; on: MapPair[]; hasOn: boolean; using: string[]; natural: boolean; pos: Pos; clause?: Pos; ia?: MapIn; ib?: MapIn };
/** 묶음의 절 — select · distinct · from · where · group · having · window · order · limit · setop · target · set */
export type MapClause = { scope: number; kind: string; pos: Pos };
/** SELECT 목록 한 항목 — cols: 쓴 열 id [시작, 끝)(scope 로 거른다) · star: * 이면 "", t.* 이면 "t" */
/** expr: 식만(별칭 빼고) — UPDATE 는 SET 항목(name = 바뀌는 열, expr = 값) */
export type MapOut = { scope: number; name?: string; pos: Pos; expr?: Pos; cols: [number, number]; subs?: number[]; agg?: boolean; win?: boolean; star?: string };
export type MapCol = { id: number; scope: number; table: number | null; qual: string | null; name: string; role: string; pred: string | null; wrapped: string | null; pos: Pos };
export type MapFact = {
	kind: string;
	scope: number;
	pos: Pos;
	col: number | null;
	col2: number | null;
	sub: number | null;
	table: number | null;
	text: string | null;
	num: number | null;
	op: string | null;
	lit: string | null;
	value: string | null;
};
export type QueryMap = { ok: boolean; error: string | null; kind: string; dialect: string; scopes: MapScope[]; tables: MapTable[]; joins: MapJoin[]; cols: MapCol[]; facts: MapFact[]; clauses: MapClause[]; outs: MapOut[] };

/** 표 하나의 메타데이터 — cols/indexes 가 null 이면 못 읽음(또는 아직) */
export type TableMeta = { schema: string | null; name: string; kind: "table" | "view"; cols: ColMeta[] | null; indexes: IndexInfo[] | null };

export type Resolved = {
	map: QueryMap;
	/** 표 id → 메타(undefined: 맞춰 볼 대상이 아님 — CTE·서브쿼리·표 함수, null: 찾지 못함) */
	meta: (TableMeta | null | undefined)[];
	/** 표 찾기를 끝까지 했는지(못 했으면 "없는 표"라 하지 않는다) */
	searched: boolean;
	/** 열 id → 표 id(메타데이터로 한정 없는 열까지 맞춘 것) */
	colTable: (number | null)[];
	/** 스키마 → 외래 키 */
	fks: Map<string, Fk[]>;
};

export type Finding = {
	key: string;
	/** map: 즉시 경고(지도에도) · static: 정적 검사 · index: 인덱스 초안 · plan: 실행 계획 */
	layer: "map" | "static" | "index" | "plan";
	level: "warn" | "info" | "tip";
	title: string;
	why: string;
	fix?: string;
	/** 문장 전체를 바꿔 쓴 것(비교·편집기에 넣기) */
	rewrite?: string;
	/** CREATE INDEX 초안 — 실행하지 않는다 */
	ddl?: string;
	/** 문장 안의 위치 */
	pos?: Pos;
};

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** 열 형식 → 갈래 */
export function typeCat(t?: string | null): "num" | "str" | "date" | "bool" | "uuid" | "json" | "bin" | "other" {
	const x = lower(t).trim();
	if (!x) return "other";
	if (/^(bool|boolean)\b/.test(x) || x === "bit") return "bool";
	if (/^(uuid|uniqueidentifier)\b/.test(x)) return "uuid";
	if (/^jsonb?\b/.test(x)) return "json";
	// MySQL YEAR 는 숫자처럼 비교한다(year_col = 2024)
	if (/^(year|(tiny|small|medium|big)?int(eger)?|int[248]|(small|big)?serial|serial[248]?|numeric|decimal|dec|number|float[48]?|double|real|money|smallmoney|binary_(float|double)|fixed)\b/.test(x)) return "num";
	// timestamptz·timetz 처럼 붙여 쓰는 것까지
	if (/^(date|time|timestamp|datetime|smalldatetime|datetime2|datetimeoffset|interval)/.test(x)) return "date";
	if (/(blob|bytea|^binary|^varbinary|^raw|^long raw|^image)\b/.test(x)) return "bin";
	if (/(char|text|clob|string|^enum|^set\(|^citext|^name$|^xml|^nchar|^nvarchar|^varchar2|^nvarchar2)/.test(x)) return "str";
	return "other";
}

const RESERVED = new Set(
	"select from where order group by user table index key limit offset desc asc check column default primary references union all and or not null is in as on join to level size rows range comment date time timestamp value values option grant end case when then else having distinct both leading trailing cast constraint create foreign unique window with only natural left right full inner outer cross like between exists into set update delete insert returning fetch top".split(
		" ",
	),
);
/** 이름 쓰기 — 따옴표가 필요할 때만 */
export function ident(engine: string, name: string): string {
	const plain = /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name.toLowerCase());
	const caseOk = engine === "postgres" ? name === name.toLowerCase() : engine === "oracle" || engine === "tibero" ? name === name.toUpperCase() : true;
	return plain && caseOk ? name : quoteIdentFor(engine, name);
}

const slice = (s: string, p: Pos) => (p ? s.slice(p[0], p[1]) : "");
/** s[open] 의 ( 와 짝인 ) 위치 — 작은따옴표 안은 건너뛴다. 못 찾으면 -1 */
export function matchParen(s: string, open: number): number {
	let depth = 0;
	let quoted = false;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === "'") quoted = !quoted;
		else if (quoted) continue;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}
const replaceAt = (s: string, p: [number, number], t: string) => s.slice(0, p[0]) + t + s.slice(p[1]);

const PSEUDO = new Set(["rownum", "rowid", "level", "sysdate", "systimestamp", "user", "current_user", "session_user", "localtimestamp", "localtime", "current_time", "current_schema", "nextval", "currval", "ctid", "oid", "xmin"]);
const PSEUDO_QUAL = new Set(["excluded", "inserted", "deleted", "new", "old"]);

/** 메타데이터로 한정 없는 열의 표를 고른다(그 묶음 → 바깥 묶음 순, 그 이름을 가진 표가 하나일 때) */
export function resolveCols(map: QueryMap, meta: (TableMeta | null | undefined)[]): (number | null)[] {
	const parent = new Map(map.scopes.map((s) => [s.id, s.parent]));
	return map.cols.map((c) => {
		if (c.table !== null || c.qual) return c.table;
		let s: number | null = c.scope;
		while (s !== null) {
			const own = map.tables.filter((t) => t.scope === s);
			const hits = own.filter((t) => meta[t.id]?.cols?.some((m) => lower(m.name) === lower(c.name)));
			if (hits.length === 1) return hits[0].id;
			if (hits.length > 1) return null;
			s = parent.get(s) ?? null;
		}
		return null;
	});
}

function colMeta(r: Resolved, col: number): ColMeta | null {
	const t = r.colTable[col];
	if (t === null || t === undefined) return null;
	const m = r.meta[t];
	return m?.cols?.find((x) => lower(x.name) === lower(r.map.cols[col].name)) ?? null;
}

function tableLabel(t: MapTable) {
	return t.alias && t.alias !== t.name ? `${t.name} ${t.alias}` : t.name;
}

/** 이 열 = 저 열 이 FK 로 묶였는지 */
function hasFk(r: Resolved, a: number, b: number): boolean | null {
	const ta = r.colTable[a];
	const tb = r.colTable[b];
	if (ta === null || tb === null) return null;
	const ma = r.meta[ta];
	const mb = r.meta[tb];
	if (!ma || !mb) return null;
	const ca = lower(r.map.cols[a].name);
	const cb = lower(r.map.cols[b].name);
	const list = [...(r.fks.get(lower(ma.schema)) ?? []), ...(ma.schema !== mb.schema ? (r.fks.get(lower(mb.schema)) ?? []) : [])];
	if (!r.fks.has(lower(ma.schema))) return null;
	return list.some(
		(f) =>
			(lower(f.table) === lower(ma.name) && lower(f.column) === ca && lower(f.refTable) === lower(mb.name) && lower(f.refColumn) === cb) ||
			(lower(f.table) === lower(mb.name) && lower(f.column) === cb && lower(f.refTable) === lower(ma.name) && lower(f.refColumn) === ca),
	);
}

/** 즉시 경고 — 지도 아래 줄과 튜닝 칸 「구조」 */
export function structureFindings(r: Resolved, sql: string, engine: string): Finding[] {
	const out: Finding[] = [];
	const { map } = r;
	// 없는 표
	if (r.searched)
		for (const t of map.tables) {
			if (t.virt || t.cte !== null || t.derived !== null) continue;
			if (r.meta[t.id] === null) out.push({ key: `nt${t.id}`, layer: "map", level: "warn", title: `없는 표: ${t.schema ? `${t.schema}.` : ""}${t.name}`, why: "캐시한 객체 목록에 이 이름의 표·뷰가 없습니다(이름·스키마·대소문자 확인).", pos: t.pos });
		}
	// 없는 열 · 모르는 별칭
	const seen = new Set<string>();
	for (const c of map.cols) {
		if (PSEUDO.has(lower(c.name)) || (c.qual && PSEUDO_QUAL.has(lower(c.qual)))) continue;
		const tid = r.colTable[c.id];
		if (c.qual && tid === null) {
			const k = `q:${lower(c.qual)}`;
			if (!seen.has(k)) {
				seen.add(k);
				out.push({ key: `nq${c.id}`, layer: "map", level: "warn", title: `모르는 별칭: ${c.qual}`, why: `${c.qual}.${c.name} — FROM·JOIN 에 이 별칭(또는 표)이 없습니다.`, pos: c.pos });
			}
			continue;
		}
		if (tid !== null) {
			const m = r.meta[tid];
			if (m?.cols && !m.cols.some((x) => lower(x.name) === lower(c.name))) {
				const k = `${lower(m.schema)}.${lower(m.name)}:${lower(c.name)}`;
				if (seen.has(k)) continue;
				seen.add(k);
				out.push({ key: `nc${c.id}`, layer: "map", level: "warn", title: `없는 열: ${tableLabel(map.tables[tid])}.${c.name}`, why: `${m.name} 에 ${c.name} 열이 없습니다.`, pos: c.pos });
			}
			continue;
		}
		// 한정 없는 열 — 묶음(과 바깥)의 표가 모두 메타가 있는데 어디에도 없으면
		if (c.role === "order" || c.role === "group" || c.role === "having") continue;
		const parent = new Map(map.scopes.map((s) => [s.id, s.parent]));
		let s: number | null = c.scope;
		let all = true;
		let any = false;
		while (s !== null) {
			for (const t of map.tables.filter((x) => x.scope === s)) {
				any = true;
				if (!r.meta[t.id]?.cols) all = false;
			}
			s = parent.get(s) ?? null;
		}
		if (any && all && r.searched) {
			const k = `u:${lower(c.name)}`;
			if (!seen.has(k)) {
				seen.add(k);
				out.push({ key: `nu${c.id}`, layer: "map", level: "warn", title: `어느 표에도 없는 열: ${c.name}`, why: "FROM 의 어느 표에도 이 이름의 열이 없습니다(오타 또는 SELECT 별칭).", pos: c.pos });
			}
		}
	}
	// 데카르트 곱 · ON 없는 JOIN · CROSS JOIN
	for (const f of map.facts) {
		const t = f.table !== null ? map.tables[f.table] : null;
		if (f.kind === "cartesian")
			out.push({
				key: `ca${f.pos?.[0]}`,
				layer: "map",
				level: "warn",
				title: `데카르트 곱: ${t ? tableLabel(t) : "표"}`,
				why: "쉼표로 늘어놓은 이 표를 앞 표와 잇는 조건이 WHERE 에 없습니다 — 행 수가 곱해집니다.",
				fix: "JOIN … ON 으로 쓰거나 WHERE 에 잇는 조건(a.키 = b.키)을 넣으세요.",
				pos: f.pos,
			});
		else if (f.kind === "joinNoOn")
			out.push({ key: `jn${f.pos?.[0]}`, layer: "map", level: "warn", title: `ON 없는 JOIN: ${t ? tableLabel(t) : "표"}`, why: "조건 없는 JOIN 은 모든 행 짝(데카르트 곱)을 만듭니다.", fix: "ON 조건을 넣거나, 의도했다면 CROSS JOIN 으로 분명히 쓰세요.", pos: f.pos });
		else if (f.kind === "crossJoin") out.push({ key: `cj${f.pos?.[0]}`, layer: "map", level: "info", title: `CROSS JOIN: ${t ? tableLabel(t) : "표"}`, why: "두 표의 모든 행 짝을 만듭니다 — 한쪽이 작을 때만 괜찮습니다.", pos: f.pos });
	}
	// 형식이 다른 비교
	for (const f of map.facts) {
		if (f.kind !== "cmp" || f.col === null) continue;
		// 함수로 감싼 열(YEAR(d) = 2024)은 형식 비교가 아니다 — 정적 검사가 따로 본다
		if (map.cols[f.col].wrapped || (f.col2 !== null && map.cols[f.col2].wrapped)) continue;
		const a = colMeta(r, f.col);
		if (!a) continue;
		const ca = typeCat(a.dataType);
		const cname = `${map.cols[f.col].qual ? `${map.cols[f.col].qual}.` : ""}${map.cols[f.col].name}`;
		if (f.col2 !== null) {
			const b = colMeta(r, f.col2);
			if (!b) continue;
			const cb = typeCat(b.dataType);
			if (ca !== "other" && cb !== "other" && ca !== cb) {
				const c2 = map.cols[f.col2];
				out.push({
					key: `ty${f.pos?.[0]}`,
					layer: "map",
					level: "warn",
					title: `형식이 다른 열 비교: ${cname}(${a.dataType}) ${f.op ?? "="} ${c2.qual ? `${c2.qual}.` : ""}${c2.name}(${b.dataType})`,
					why: "서버가 한쪽을 암묵적으로 바꿔 비교합니다 — 바뀌는 쪽 열의 인덱스를 못 쓰고, 값이 맞지 않으면 오류나 틀린 결과가 납니다.",
					fix: "두 열의 형식을 맞추거나, 작은 쪽(상수·짧은 표)을 CAST 하세요.",
					pos: f.pos,
				});
			}
			continue;
		}
		if (!f.lit || f.value === null) continue;
		const conj = f.pos;
		if (ca === "str" && f.lit === "num") {
			let rewrite: string | undefined;
			if (conj) {
				const text = sql.slice(conj[0], conj[1]);
				const q = text.replace(new RegExp(`(^|[=<>!]\\s*)(${f.value.replace(/[.+-]/g, "\\$&")})(\\s*$|\\s*[=<>!])`), (_m, a1, n, b1) => `${a1}'${n}'${b1}`);
				if (q !== text) rewrite = replaceAt(sql, conj, q);
			}
			out.push({
				key: `tl${f.pos?.[0]}`,
				layer: "map",
				level: "warn",
				title: `문자 열을 숫자와 비교: ${cname}(${a.dataType}) ${f.op} ${f.value}`,
				why:
					engine === "postgres"
						? "PostgreSQL 은 형식 오류가 나거나 열을 바꿔 비교합니다."
						: "MySQL·Oracle 등은 열 쪽을 숫자로 바꿔 비교합니다 — 행마다 변환하고 인덱스를 못 씁니다. '010…' 처럼 앞자리 0도 사라집니다.",
				fix: "값을 따옴표로 감싸 문자로 비교하세요.",
				rewrite,
				pos: f.pos,
			});
		} else if (ca === "num" && f.lit === "str") {
			const numeric = /^\s*-?\d+(\.\d+)?\s*$/.test(f.value);
			out.push({
				key: `tl${f.pos?.[0]}`,
				layer: "map",
				level: numeric ? "info" : "warn",
				title: `숫자 열을 문자열과 비교: ${cname} ${f.op} '${f.value}'`,
				why: numeric ? "상수 쪽만 바뀌어 대개 괜찮지만, 형식을 맞추면 분명합니다." : "숫자로 바꿀 수 없는 값입니다 — 오류가 나거나(PostgreSQL·Oracle) 0 으로 바뀌어(MySQL) 엉뚱한 행이 나옵니다.",
				fix: numeric ? "따옴표를 빼고 숫자로 쓰세요." : "값을 확인하세요.",
				pos: f.pos,
			});
		} else if (ca === "date" && f.lit === "num") {
			out.push({ key: `tl${f.pos?.[0]}`, layer: "map", level: "warn", title: `날짜 열을 숫자와 비교: ${cname} ${f.op} ${f.value}`, why: "날짜를 숫자로 바꿔 비교합니다 — 결과가 틀리거나 인덱스를 못 씁니다.", fix: "날짜 리터럴(DATE '2024-01-31' 또는 '2024-01-31')로 쓰세요.", pos: f.pos });
		}
	}
	// FK 없는 조인(정보)
	for (const j of map.joins) {
		for (const p of j.on) {
			if (hasFk(r, p.a, p.b) !== false) continue;
			const a = map.cols[p.a];
			const b = map.cols[p.b];
			// 같은 표의 같은 열(자기 조인 아님) 은 넘어간다
			if (r.colTable[p.a] === r.colTable[p.b]) continue;
			out.push({
				key: `fk${p.a}:${p.b}`,
				layer: "map",
				level: "info",
				title: `FK 없는 조인: ${a.qual ? `${a.qual}.` : ""}${a.name} = ${b.qual ? `${b.qual}.` : ""}${b.name}`,
				why: "이 두 열 사이에 외래 키가 없습니다 — 의도한 관계인지, 두 열의 형식이 같은지, 조인 열에 인덱스가 있는지 보세요.",
				pos: j.pos ?? a.pos,
			});
			break;
		}
	}
	return out;
}

/** 정적 검사 — 서버 없이 */
export function staticFindings(r: Resolved, sql: string, engine: string): Finding[] {
	const out: Finding[] = [];
	const { map } = r;
	const scopeOf = new Map(map.scopes.map((s) => [s.id, s]));
	const idxLeads = (tid: number | null, col: string) => {
		if (tid === null) return null;
		const ix = r.meta[tid]?.indexes;
		if (!ix) return null;
		return ix.some((i) => lower(i.cols[0]) === lower(col));
	};
	for (const f of map.facts) {
		const col = f.col !== null ? map.cols[f.col] : null;
		const cname = col ? `${col.qual ? `${col.qual}.` : ""}${col.name}` : "";
		switch (f.kind) {
			case "selectStar": {
				const sc = scopeOf.get(f.scope);
				if (sc && /EXISTS/.test(sc.name ?? "")) break; // EXISTS (SELECT * …) 는 상관없다
				// 바꿔 쓰기 — 열을 아는 표만
				let rewrite: string | undefined;
				const own = map.tables.filter((t) => t.scope === f.scope);
				const pick = f.text ? own.filter((t) => lower(t.alias ?? t.name) === lower(f.text?.split(".").pop())) : own;
				if (f.pos && pick.length && pick.every((t) => r.meta[t.id]?.cols?.length)) {
					const multi = own.length > 1 || !!f.text;
					const list = pick.flatMap((t) => (r.meta[t.id]?.cols ?? []).map((c) => (multi ? `${t.qualText || t.alias || t.name}.${ident(engine, c.name)}` : ident(engine, c.name))));
					if (list.length) rewrite = replaceAt(sql, f.pos, list.join(", "));
				}
				out.push({
					key: `ss${f.pos?.[0]}`,
					layer: "static",
					level: "tip",
					title: `SELECT ${f.text ? `${f.text}.*` : "*"} — 필요한 열만`,
					why: "모든 열을 읽고 보냅니다 — 망·메모리를 더 쓰고, 인덱스만으로 끝낼 수 있는 쿼리(커버링)를 막으며, 표에 열이 늘면 결과도 바뀝니다.",
					fix: "쓰는 열만 적으세요.",
					rewrite,
					pos: f.pos,
				});
				break;
			}
			case "fnOnCol": {
				if (!col) break;
				const fn = (f.text ?? "").toUpperCase();
				const lead = idxLeads(r.colTable[col.id], col.name);
				const cmp = map.facts.find((x) => x.kind === "cmp" && x.col === col.id && x.pos && f.pos && x.pos[0] <= f.pos[0] && x.pos[1] >= f.pos[1]);
				let rewrite: string | undefined;
				let fix = "열은 그대로 두고 상수 쪽을 바꾸세요(범위 조건으로).";
				const colText = slice(sql, col.pos) || cname;
				const dateLit = (d: string) => (engine === "postgres" || engine === "oracle" || engine === "tibero" ? `DATE '${d}'` : `'${d}'`);
				if (cmp?.pos && cmp.op === "=" && cmp.value) {
					const conj = cmp.pos;
					if (fn === "YEAR" && /^\d{4}$/.test(cmp.value)) {
						const y = Number(cmp.value);
						rewrite = replaceAt(sql, conj, `${colText} >= ${dateLit(`${y}-01-01`)} AND ${colText} < ${dateLit(`${y + 1}-01-01`)}`);
					} else if ((fn === "DATE" || fn === "TRUNC" || (fn === "CAST" && /(\bas\s+date\s*\)|::\s*date)\s*$/i.test(slice(sql, f.pos)))) && /^\d{4}-\d{2}-\d{2}$/.test(cmp.value)) {
						const d = new Date(`${cmp.value}T00:00:00Z`);
						if (!Number.isNaN(d.getTime())) {
							const next = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
							rewrite = replaceAt(sql, conj, `${colText} >= ${dateLit(cmp.value)} AND ${colText} < ${dateLit(next)}`);
						}
					}
				}
				if (fn === "UPPER" || fn === "LOWER")
					fix =
						engine === "postgres"
							? `식 인덱스(CREATE INDEX … (${fn.toLowerCase()}(${col.name})))를 만들거나 citext 형식을 쓰세요.`
							: engine === "mysql" || engine === "mariadb"
								? "대소문자를 구분하지 않는 정렬(collation, 예: utf8mb4_0900_ai_ci)이면 함수 없이 비교해도 됩니다. MySQL 8 은 함수 인덱스도 됩니다."
								: "함수 기반 인덱스를 만들거나 저장할 때 대소문자를 맞춰 두세요.";
				else if (rewrite) fix = "날짜 함수 대신 범위 조건(>= 시작 AND < 다음)으로 쓰면 인덱스를 씁니다.";
				out.push({
					key: `fn${f.pos?.[0]}`,
					layer: "static",
					level: lead ? "warn" : "info",
					title: `조건 열을 ${fn === "연산" ? "연산으로" : `${fn}()로`} 감쌌습니다: ${cname}`,
					why: `열을 감싸면 그 열의 인덱스를 쓸 수 없습니다(sargable 아님)${lead ? ` — ${cname} 로 시작하는 인덱스가 있는데도 못 씁니다` : ""}. 행마다 계산하므로 표 전체를 읽게 됩니다.`,
					fix,
					rewrite,
					pos: f.pos,
				});
				break;
			}
			case "likeLeading":
				out.push({
					key: `lk${f.pos?.[0]}`,
					layer: "static",
					level: "warn",
					title: `앞이 % 인 LIKE: ${cname} LIKE '${f.text ?? ""}'`,
					why: "앞부분이 정해지지 않아 B-tree 인덱스로 범위를 좁힐 수 없습니다 — 표 전체(또는 인덱스 전체)를 읽습니다.",
					fix:
						engine === "postgres"
							? "pg_trgm 확장 + GIN 인덱스(CREATE INDEX … USING gin (열 gin_trgm_ops))나 전문 검색(tsvector)을 쓰세요. 뒷부분 검색이면 reverse(열) 식 인덱스도 됩니다."
							: engine === "mysql" || engine === "mariadb"
								? "FULLTEXT 인덱스 + MATCH … AGAINST 를 쓰거나, 앞부분이 정해진 검색('abc%')으로 바꾸세요."
								: engine === "mssql"
									? "전체 텍스트 인덱스(CONTAINS)를 쓰거나 앞부분이 정해진 검색으로 바꾸세요."
									: "Oracle Text(CONTAINS) 같은 전문 검색 인덱스를 쓰거나 앞부분이 정해진 검색으로 바꾸세요.",
					pos: f.pos,
				});
				break;
			case "notInSubquery": {
				const sub = f.sub !== null ? scopeOf.get(f.sub) : undefined;
				const subTables = sub ? map.tables.filter((t) => t.scope === sub.id) : [];
				const subSel = sub ? map.cols.filter((c) => c.scope === sub.id && c.role === "select") : [];
				let nullable: boolean | null = null;
				if (subSel.length === 1) {
					const m = colMeta(r, subSel[0].id);
					if (m) nullable = m.nullable && !m.pk;
				}
				let rewrite: string | undefined;
				const outerT = col ? r.colTable[col.id] : null;
				if (f.pos && col?.pos && outerT !== null && outerT !== undefined && subTables.length === 1 && subSel.length === 1 && !subSel[0].wrapped && !col.wrapped) {
					const conjText = slice(sql, f.pos);
					const at = /\bnot\s+in\s*\(/i.exec(conjText);
					const open = at ? f.pos[0] + at.index + at[0].length - 1 : -1;
					const close = open >= 0 ? matchParen(sql, open) : -1;
					const body = close > open ? sql.slice(open + 1, close).trim() : "";
					const m = /^select\s+(?:distinct\s+)?([\w$."`[\]]+)\s+from\s+([\w$."`[\]]+(?:\s+(?:as\s+)?[\w$]+)?)(?:\s+where\s+([\s\S]+))?$/i.exec(body);
					const t = subTables[0];
					const outerTable = map.tables[outerT];
					const outerQual = outerTable.qualText || outerTable.alias || outerTable.name;
					const innerQual = t.qualText || t.alias || t.name;
					// 바깥 한정자가 안쪽 표 이름·별칭과 같으면 안쪽으로 읽힌다 — 바꾸지 않는다
					const shadow = lower(outerQual) === lower(innerQual) || lower(outerQual) === lower(t.name);
					if (m && !shadow && !/\b(join|group|order|union|limit|having)\b|,/i.test(m[2] + (m[3] ?? ""))) {
						const selCol = m[1].includes(".") ? m[1] : `${innerQual}.${m[1]}`;
						const colText = slice(sql, col.pos);
						const outer = `${outerQual}.${colText.slice(colText.lastIndexOf(".") + 1)}`;
						rewrite = replaceAt(sql, [f.pos[0], Math.max(f.pos[1], close + 1)], `NOT EXISTS (SELECT 1 FROM ${m[2]} WHERE ${selCol} = ${outer}${m[3] ? ` AND (${m[3]})` : ""})`);
					}
				}
				out.push({
					key: `ni${f.pos?.[0]}`,
					layer: "static",
					level: nullable === false ? "tip" : "warn",
					title: `NOT IN (서브쿼리): ${cname}`,
					why:
						nullable === false
							? "서브쿼리 열이 NOT NULL 이라 결과는 맞습니다. 다만 NOT EXISTS 가 안티 조인으로 더 잘 풀리는 엔진이 많습니다."
							: "서브쿼리 결과에 NULL 이 하나라도 있으면 NOT IN 은 아무 행도 돌려주지 않습니다(NULL 비교는 참이 아님). 서브쿼리 열이 NULL 가능하거나 알 수 없습니다.",
					fix: "NOT EXISTS (SELECT 1 … WHERE 안.열 = 바깥.열) 로 바꾸세요.",
					rewrite,
					pos: f.pos,
				});
				break;
			}
			case "offset": {
				if ((f.num ?? 0) < 1000) break;
				const ord = map.cols.find((c) => c.scope === f.scope && c.role === "order");
				const o = ord ? `${ord.qual ? `${ord.qual}.` : ""}${ord.name}` : "정렬열";
				out.push({
					key: `of${f.pos?.[0]}`,
					layer: "static",
					level: "warn",
					title: `큰 OFFSET(${(f.num ?? 0).toLocaleString()})`,
					why: "OFFSET 은 건너뛸 행을 모두 읽고 버립니다 — 뒤 페이지일수록 느려집니다.",
					fix: `키셋 페이징: 앞 페이지의 마지막 값을 기억해 WHERE ${o} > :마지막_값 ORDER BY ${o} 로 다음 페이지를 읽으세요(정렬 열이 유일하지 않으면 PK 를 덧붙여 (${o}, id) > (:값, :id)).`,
					pos: f.pos,
				});
				break;
			}
			case "correlated": {
				if (f.text && /EXISTS|IN/.test(f.text)) break; // EXISTS·IN 은 대개 세미 조인으로 풀린다
				const sub = f.sub !== null ? scopeOf.get(f.sub) : undefined;
				out.push({
					key: `co${f.sub}`,
					layer: "static",
					level: "tip",
					title: `상관 서브쿼리: ${cname}`,
					why: "바깥 행마다 서브쿼리를 다시 실행할 수 있습니다(옵티마이저가 풀지 못하면 행 수 × 서브쿼리 비용).",
					fix:
						engine === "postgres"
							? "LEFT JOIN (SELECT 키, 집계 … GROUP BY 키) 로 한 번에 모으거나 LEFT JOIN LATERAL 로 바꿔 쓰세요."
							: engine === "mssql"
								? "LEFT JOIN (… GROUP BY 키) 나 OUTER APPLY 로 바꿔 쓰세요."
								: "LEFT JOIN (SELECT 키, 집계 … GROUP BY 키) 로 한 번에 모아 붙이세요.",
					pos: sub?.pos ?? f.pos,
				});
				break;
			}
			case "orderNoLimit":
				out.push({ key: `ol${f.pos?.[0]}`, layer: "static", level: "info", title: "LIMIT 없는 정렬", why: "결과 전체를 정렬합니다 — 큰 결과면 메모리를 넘쳐 디스크 정렬이 됩니다.", fix: "앞쪽 몇 행만 필요하면 LIMIT(TOP·FETCH FIRST)을 붙이세요. 정렬 열에 인덱스가 있으면 정렬 없이 읽습니다.", pos: f.pos });
				break;
			case "noWhere":
				out.push({ key: `nw${f.text}`, layer: "static", level: "warn", title: `조건 없는 ${f.text}`, why: "WHERE 가 없어 표의 모든 행을 바꿉니다/지웁니다.", fix: "WHERE 를 넣으세요. 정말 전부라면 실행 전에 SELECT COUNT(*) 로 행 수를 확인하세요(DELETE 전부는 TRUNCATE 가 빠릅니다)." });
				break;
		}
	}
	return out;
}

type Want = { eq: string[]; rest: string[] };

/** 인덱스 검사 — 조인·WHERE·ORDER BY 열에 맞는 인덱스가 없으면 CREATE INDEX 초안 */
export function indexFindings(r: Resolved, engine: string): Finding[] {
	const out: Finding[] = [];
	const { map } = r;
	const done = new Set<string>();
	for (const t of map.tables) {
		const m = r.meta[t.id];
		if (!m || m.kind !== "table" || !m.indexes || !m.cols) continue;
		// 참·거짓 같은 열은 인덱스로 좁히지 못한다
		const known = new Set(m.cols.filter((c) => typeCat(c.dataType) !== "bool").map((c) => lower(c.name)));
		const mine = map.cols.filter((c, i) => r.colTable[i] === t.id && !c.wrapped && known.has(lower(c.name)));
		const name = (c: { name: string }) => m.cols?.find((x) => lower(x.name) === lower(c.name))?.name ?? c.name;
		const uniq = (l: string[]) => [...new Set(l.map(lower))].map((x) => l.find((y) => lower(y) === x) as string);
		const where = mine.filter((c) => c.role === "where" && c.scope === t.scope);
		// 열 = 열(같은 표 안 비교·옛 쉼표 조인)은 상수 등호가 아니다
		const colPair = new Set(map.facts.filter((f) => f.kind === "cmp" && f.col2 !== null).flatMap((f) => [f.col, f.col2]));
		const eq = uniq(where.filter((c) => (c.pred === "eq" || c.pred === "in") && !colPair.has(c.id)).map(name));
		const prefixCols = new Set(where.filter((c) => c.pred === "prefix").map((c) => lower(c.name)));
		const range = uniq(where.filter((c) => (c.pred === "range" || c.pred === "prefix") && !eq.some((e) => lower(e) === lower(c.name))).map(name));
		// ORDER BY 가 모두 이 표의 열일 때만 정렬을 인덱스로 받을 수 있다
		const orders = map.cols.filter((c) => c.scope === t.scope && c.role === "order");
		const ordMine = orders.length > 0 && orders.every((c) => r.colTable[c.id] === t.id && !c.wrapped && known.has(lower(c.name))) ? uniq(orders.map(name)) : [];
		const wants: (Want & { why: string })[] = [];
		if (eq.length || range.length) {
			const rest = range.length ? [range[0]] : ordMine.filter((o) => !eq.some((e) => lower(e) === lower(o)));
			wants.push({ eq, rest: rest.slice(0, 2), why: `WHERE ${[...eq.map((e) => `${e} =`), ...range.slice(0, 1).map((x) => `${x} 범위`)].join(", ")}${!range.length && rest.length ? ` + ORDER BY ${rest.join(", ")}` : ""}` });
		} else if (ordMine.length && map.facts.some((f) => f.kind === "orderNoLimit") === false && map.scopes.find((s) => s.id === t.scope)?.kind === "main") {
			// LIMIT 이 붙은 정렬(앞 몇 행) — 정렬 열 인덱스면 정렬 없이 앞에서부터 읽는다
			wants.push({ eq: [], rest: ordMine.slice(0, 2), why: `ORDER BY ${ordMine.join(", ")} + LIMIT` });
		}
		// 조인 열 — 이 표가 안쪽(찾아 들어가는 쪽)일 때
		for (const j of map.joins) {
			if (j.kind === "cross" || j.kind === "comma") continue;
			const inner = j.kind === "right" ? j.left : j.right;
			for (const p of j.on) {
				const side = r.colTable[p.a] === t.id ? p.a : r.colTable[p.b] === t.id ? p.b : null;
				if (side === null) continue;
				const other = side === p.a ? p.b : p.a;
				if (r.colTable[other] === t.id) continue;
				// 안쪽이 아니면 넘어간다 — WHERE 조인은 어느 쪽이 안쪽인지 모르니 두 쪽 다(이미 인덱스가 있는 쪽이 있으면 생략)
				if (j.kind !== "where" && inner !== t.id) continue;
				if (j.kind === "where") {
					const ot = r.colTable[other];
					const oix = ot !== null ? r.meta[ot]?.indexes : null;
					if (oix?.some((i) => lower(i.cols[0]) === lower(map.cols[other].name))) continue;
				}
				const c = map.cols[side];
				if (c.wrapped || !known.has(lower(c.name))) continue;
				// 조인 열로 시작하는 인덱스가 있으면 조인은 받는다
				if (m.indexes.some((i) => !i.partial && lower(i.cols[0]) === lower(c.name))) continue;
				wants.push({ eq: uniq([name(c), ...eq]), rest: [], why: `JOIN ${map.cols[other].qual ? `${map.cols[other].qual}.` : ""}${map.cols[other].name} = ${c.qual ? `${c.qual}.` : ""}${c.name}` });
			}
		}
		for (const w of wants) {
			// 등호 열이 많아도 덮였는지는 전부로 보고, 초안에는 앞 3개만
			if (covered(m.indexes, w)) continue;
			const cols = [...w.eq.slice(0, 3), ...w.rest];
			if (!cols.length) continue;
			// 같은 표가 두 번 나와도(자기 조인·CTE) 같은 초안은 한 번
			const key = `${lower(m.schema)}.${lower(m.name)}:${cols.map(lower).join(",")}`;
			if (done.has(key)) continue;
			done.add(key);
			// 다른 초안이 이미 이 열들로 시작하면(더 긴 것이 있으면) 생략
			const longer = wants.some((x) => x !== w && [...x.eq, ...x.rest].length > cols.length && covered([{ name: "", cols: [...x.eq, ...x.rest], unique: false, primary: false, partial: false }], w));
			if (longer) continue;
			const near = m.indexes.find((i) => !i.partial && lower(i.cols[0]) === lower(cols[0]));
			const ora = engine === "oracle" || engine === "tibero";
			const base = `ix_${m.name}_${cols.join("_")}`.replace(/[^\p{L}\p{N}_]+/gu, "_").slice(0, ora ? 30 : 60);
			// Oracle 계열은 대문자(따옴표 없이 쓰는 이름), 나머지는 소문자
			const ixName = ora ? base.toUpperCase() : base.toLowerCase();
			// PG 접두 LIKE('abc%')는 C 정렬이 아니면 패턴 연산자 클래스가 있어야 인덱스를 쓴다
			const colDef = (c: string) => {
				const q = ident(engine, c);
				if (engine !== "postgres" || !prefixCols.has(lower(c))) return q;
				const ty = lower(m.cols?.find((x) => lower(x.name) === lower(c))?.dataType);
				return `${q} ${ty.startsWith("character varying") || ty.startsWith("varchar") ? "varchar_pattern_ops" : ty.startsWith("character") || ty.startsWith("bpchar") ? "bpchar_pattern_ops" : "text_pattern_ops"}`;
			};
			const tbl = m.schema && m.schema !== "(기본)" ? `${ident(engine, m.schema)}.${ident(engine, m.name)}` : ident(engine, m.name);
			const ddl = `CREATE INDEX ${engine === "postgres" ? "CONCURRENTLY " : ""}${ident(engine, ixName)} ON ${tbl} (${cols.map(colDef).join(", ")})${engine === "oracle" ? " ONLINE" : ""};`;
			out.push({
				key: `ix${t.id}:${key}`,
				layer: "index",
				level: "tip",
				title: `인덱스 초안: ${m.name} (${cols.join(", ")})`,
				why: `${w.why} 에 맞는 인덱스가 없습니다.${cols.length > 1 ? " 열 순서는 등호 → 범위 → 정렬." : ""}${engine === "postgres" && cols.some((c) => prefixCols.has(lower(c))) ? " LIKE 'abc%' 열에는 패턴 연산자 클래스(*_pattern_ops)를 붙였습니다 — 데이터베이스 정렬이 C 면 빼도 됩니다." : ""}${near ? ` 비슷한 인덱스 ${near.name}(${near.cols.filter(Boolean).join(", ")})가 있습니다 — 새로 만들기보다 늘리는 것도 방법입니다.` : ""}`,
				fix: `표가 작거나 조건이 대부분의 행에 맞으면 인덱스가 도움이 안 됩니다. 쓰기가 많은 표는 인덱스마다 쓰기 비용이 늡니다 — EXPLAIN 으로 확인한 뒤 직접 실행하세요.${engine === "postgres" ? " CONCURRENTLY 는 쓰기를 막지 않는 대신 트랜잭션 밖에서만 됩니다." : engine === "oracle" ? " ONLINE 은 Enterprise Edition 에서만 됩니다." : ""}`,
				ddl,
				pos: t.pos,
			});
		}
	}
	return out;
}

/** 이미 있는 인덱스의 앞부분이 원하는 열(등호는 순서 무관, 그 뒤는 순서대로)을 덮는지 — 고유 인덱스 열이 모두 등호면 한 행이라 덮은 것 */
export function covered(ix: IndexInfo[], w: Want): boolean {
	const need = w.eq.length + w.rest.length;
	const eqs = new Set(w.eq.map(lower));
	return ix.some((i) => {
		if ((i.unique || i.primary) && !i.partial && i.cols.length && i.cols.every((c) => c !== null && eqs.has(lower(c)))) return true;
		// 인덱스 앞 열들이 모두 등호 열이고, 등호 열을 다 담았거나 인덱스가 거기서 끝나면 덮인 것(등호 4개 이상도)
		if (!i.partial && w.eq.length >= 3) {
			let k = 0;
			while (k < i.cols.length && i.cols[k] !== null && eqs.has(lower(i.cols[k]))) k++;
			if (k >= 3) return true;
		}
		if (i.partial || i.cols.length < need) return false;
		const head = i.cols.slice(0, w.eq.length).map(lower);
		if (!w.eq.every((e) => head.includes(lower(e)))) return false;
		return w.rest.every((x, k) => lower(i.cols[w.eq.length + k]) === lower(x));
	});
}

/** 세 층을 한 목록으로 — 경고 → 정보 → 제안 */
export function allFindings(r: Resolved, sql: string, engine: string): Finding[] {
	const order = { warn: 0, info: 1, tip: 2 };
	return [...structureFindings(r, sql, engine), ...staticFindings(r, sql, engine), ...indexFindings(r, engine)].sort((a, b) => order[a.level] - order[b.level]);
}
