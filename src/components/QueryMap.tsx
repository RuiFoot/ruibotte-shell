import { Background, ControlButton, Controls, type Edge, Handle, type Node, type NodeProps, Position, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/querymap.css";
import { AlertTriangle, ArrowDownWideNarrow, ArrowRightLeft, Combine, CopyMinus, Funnel, GitMerge, Info, ListTree, Maximize, RefreshCw, Sheet, Sigma, SquareFunction, Stethoscope, Table2 } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ColMeta } from "../lib/edits";
import { type AnalyzeDeps, type Snapshot, useAnalysis } from "../lib/queryAnalysis";
import type { Finding, MapIn, MapOut, Pos, QueryMap } from "../lib/queryLint";
import { currentView, markEditor, subscribeEditor } from "../lib/queryWatch";

/** 문장 안 위치 → 편집기로(선택 + 포커스 — 튜닝 칸이 쓴다) */
export function jumpTo(conn: number, snap: Snapshot | null, pos: Pos | undefined) {
	const v = currentView(conn);
	if (!v || !snap || !pos) return;
	const a = snap.stmt.from + pos[0];
	const b = snap.stmt.from + pos[1];
	if (b > v.state.doc.length) return;
	// 지도가 그린 뒤 글이 바뀌었으면(다음 읽기 전) 엉뚱한 곳으로 가지 않게
	if (v.state.doc.sliceString(snap.stmt.from, snap.stmt.from + snap.stmt.text.length) !== snap.stmt.text) return;
	v.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
	v.focus();
}

/** 편집기가 아직 그 문장 그대로인가(그린 뒤 글을 고쳤으면 위치가 낡았다) */
function sameText(conn: number, snap: Snapshot): boolean {
	const v = currentView(conn);
	if (!v) return false;
	const end = snap.stmt.from + snap.stmt.text.length;
	return end <= v.state.doc.length && v.state.doc.sliceString(snap.stmt.from, end) === snap.stmt.text;
}

/** 문장 안 범위들 → 편집기 배경 강조(선택이 아니다) */
function markIn(conn: number, snap: Snapshot | null, ranges: R[]) {
	if (!snap || !sameText(conn, snap)) return;
	markEditor(
		conn,
		ranges.map(([a, b]) => ({ from: snap.stmt.from + a, to: snap.stmt.from + b })),
	);
}

// ── 그래프 모형 ───────────────────────────────────────────────

type R = [number, number];
type ColRow = { name: string; roles: string; pk: boolean; fk: boolean; type?: string; missing: boolean; col: number };
/** 결과·출력 열 한 줄 — k: 그 묶음 안 순번(UNION 갈래끼리 맞추는 자리) */
type OutRow = { k: number; label: string; hint: string | null; agg: boolean; win: boolean; sub: boolean; star: boolean; pos: Pos };
type Kind = "table" | "join" | "where" | "group" | "window" | "distinct" | "order" | "union" | "out" | "result";
type FNode = {
	id: string;
	kind: Kind;
	scope: number;
	title: string;
	code: string | null;
	sub: string | null;
	badge: string | null;
	/** 눌렀을 때 편집기에서 칠할 범위(문장 안 위치) */
	ranges: R[];
	/** 들어오는 단계 — 첫째가 본줄기, 나머지는 곁가지(오른쪽 표·서브쿼리) */
	inputs: string[];
	w: number;
	h: number;
	table?: number;
	cols?: ColRow[];
	more?: number;
	missing?: boolean;
	rows?: OutRow[];
	rowsMore?: number;
	warns: Finding[];
	bad?: boolean;
};
type Flow = {
	nodes: Map<string, FNode>;
	roots: string[];
	/** 나무 밖의 선(CTE 를 두 번째로 쓰는 곳 · 상관 서브쿼리) */
	cross: { from: string; to: string; label: string | null; kind: "cte" | "corr" }[];
	scopeOut: Map<number, string>;
	tableNode: Map<number, string>;
	parent: Map<string, string>;
	badEdges: Set<string>;
};

const TW = 200;
const SW = 214;
const OW = 196;
const RW = 276;
const ROWH = 18;
const RROWH = 22;
const MAX_TROWS = 8;
const MAX_OROWS = 8;
const MAX_RROWS = 14;
const tableH = (rows: number, sub: boolean) => 34 + (sub ? 16 : 0) + Math.max(1, Math.min(rows, MAX_TROWS)) * ROWH + (rows > MAX_TROWS ? 16 : 0) + 8;
const stageH = (code: boolean, sub: boolean) => 36 + (code ? 34 : 0) + (sub ? 18 : 0) + 4;
const outH = (rows: number) => 34 + Math.max(1, Math.min(rows, MAX_OROWS)) * ROWH + (rows > MAX_OROWS ? 16 : 0) + 8;
const resultH = (rows: number, code: boolean) => 50 + (code ? 40 : Math.max(1, Math.min(rows, MAX_RROWS)) * RROWH + (rows > MAX_RROWS ? 18 : 0)) + 10;

const ROLE_ORDER = "SWJGHOUI";
const ROLE_OF: Record<string, string> = { select: "S", where: "W", on: "J", group: "G", having: "H", order: "O", set: "U", insert: "I" };
const ROLE_TIP: Record<string, string> = { S: "SELECT", W: "WHERE", J: "JOIN ON", G: "GROUP BY", H: "HAVING", O: "ORDER BY", U: "SET", I: "INSERT" };
const JOIN_TITLE: Record<string, string> = { inner: "INNER JOIN", left: "LEFT JOIN", right: "RIGHT JOIN", full: "FULL JOIN", cross: "CROSS JOIN", semi: "SEMI JOIN", anti: "ANTI JOIN", apply: "APPLY", asof: "ASOF JOIN", comma: "쉼표 조인" };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const snip = (text: string, p: Pos | undefined | null, max = 140) => (p ? clip(text.slice(p[0], p[1]).replace(/\s+/g, " ").trim(), max) : "");
const isR = (p: Pos | undefined | null): p is R => !!p;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function groupLabel(map: QueryMap, sid: number): string {
	const s = map.scopes[sid];
	if (s.kind === "cte") return `WITH ${s.name ?? ""} AS (…)`;
	if (s.kind === "derived") return `FROM (서브쿼리) ${s.name ?? ""}`.trim();
	if (s.kind === "union") return `갈래 ${map.scopes.filter((x) => x.parent === s.parent && x.kind === "union").findIndex((x) => x.id === sid) + 1}`;
	if (s.name === "SELECT") return "넣을 행(SELECT)";
	return s.name ? `${s.name} (서브쿼리)` : "스칼라 서브쿼리";
}

/** 문장 하나 → 단계 그래프(결과가 뿌리, 원본 표가 잎) */
function buildFlow(snap: Snapshot, findings: Finding[]): Flow {
	const { map, resolved } = snap;
	const text = snap.stmt.text;
	const meta = resolved?.meta ?? map.tables.map(() => undefined);
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const clauses = map.clauses ?? [];
	const outs = map.outs ?? [];
	const nodes = new Map<string, FNode>();
	const cross: Flow["cross"] = [];
	const scopeOut = new Map<number, string>();
	const tableNode = new Map<number, string>();
	const badEdges = new Set<string>();
	const cl = (s: number, k: string) => clauses.filter((c) => c.scope === s && c.kind === k && c.pos);
	const one = (s: number, k: string) => cl(s, k)[0]?.pos ?? null;
	const kids = (s: number, kind: string) => map.scopes.filter((x) => x.parent === s && x.kind === kind);
	const within = (outer: number, s: number) => {
		let c: number | null = s;
		while (c !== null) {
			if (c === outer) return true;
			c = map.scopes[c]?.parent ?? null;
		}
		return false;
	};
	const add = (n: Omit<FNode, "warns">) => {
		nodes.set(n.id, { ...n, warns: [] });
		return n.id;
	};
	const cn = (c: number) => `${map.cols[c].qual ? `${map.cols[c].qual}.` : ""}${map.cols[c].name}`;

	// 표마다 쓰인 열(역할 글자)
	const fkCols = new Map<number, Set<string>>();
	if (resolved)
		for (const t of map.tables) {
			const m = meta[t.id];
			if (!m) continue;
			const list = resolved.fks.get((m.schema ?? "").toLowerCase()) ?? [];
			fkCols.set(t.id, new Set(list.filter((f) => f.table.toLowerCase() === m.name.toLowerCase()).map((f) => f.column.toLowerCase())));
		}
	const missingTables = new Set(findings.filter((f) => f.key.startsWith("nt")).map((f) => Number(f.key.slice(2))));
	const rows = new Map<number, ColRow[]>();
	for (const c of map.cols) {
		const tid = colTable[c.id];
		if (tid === null || tid === undefined) continue;
		const list = rows.get(tid) ?? [];
		rows.set(tid, list);
		const r = ROLE_OF[c.role] ?? "";
		const ex = list.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
		const cm: ColMeta | undefined = meta[tid]?.cols?.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
		if (ex) {
			if (r && !ex.roles.includes(r)) ex.roles += r;
		} else list.push({ name: cm?.name ?? c.name, roles: r, pk: !!cm?.pk, fk: fkCols.get(tid)?.has(c.name.toLowerCase()) ?? false, type: cm?.dataType, missing: !cm && !!meta[tid]?.cols, col: c.id });
	}
	for (const l of rows.values()) for (const r of l) r.roles = [...r.roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).join("");

	const outRow = (o: MapOut, k: number): OutRow => {
		let expr = snip(text, o.pos, 90);
		const star = o.star !== undefined;
		const label = o.name ?? (star ? (o.star ? `${o.star}.*` : "*") : expr);
		if (o.name) expr = expr.replace(new RegExp(`\\s+(as\\s+)?["\`[]?${esc(o.name)}["\`\\]]?$`, "i"), "");
		let hint: string | null = null;
		if (star) hint = "모든 열";
		else if (o.name && expr.toLowerCase() !== o.name.toLowerCase()) {
			// a.col → 한정자만, 식은 식 그대로
			const dot = expr.lastIndexOf(".");
			hint = dot > 0 && /^[\w$"`[\]]+\.[\w$"`[\]]+$/.test(expr) && expr.slice(dot + 1).replace(/["`[\]]/g, "").toLowerCase() === o.name.toLowerCase() ? expr.slice(0, dot) : expr;
		}
		return { k, label: clip(label, 44), hint: hint ? clip(hint, 64) : null, agg: !!o.agg, win: !!o.win, sub: !!o.subs?.length, star, pos: o.pos };
	};
	/** 묶음이 내놓는 열 — UNION 묶음이면 첫 갈래의 열 */
	const outsOf = (sid: number): MapOut[] => {
		const own = outs.filter((o) => o.scope === sid);
		if (own.length) return own;
		const b = kids(sid, "union")[0];
		return b ? outsOf(b.id) : [];
	};

	const inFor = (h: MapIn | undefined | null): string | null => (!h ? null : "t" in h ? tableFor(h.t) : joinFor(h.j));

	const tableFor = (tid: number): string => {
		const done = tableNode.get(tid);
		if (done) return done;
		const t = map.tables[tid];
		// FROM (서브쿼리) 별칭, 한 곳에서만 쓰는 CTE — 그 묶음의 출력이 곧 표다
		const single = t.cte !== null && !within(t.cte, t.scope) && map.tables.filter((x) => x.cte === t.cte && !within(t.cte as number, x.scope)).length === 1;
		const inner = t.derived ?? (single ? t.cte : null);
		if (inner !== null) {
			const id = scopeFor(inner);
			tableNode.set(tid, id);
			return id;
		}
		const id = `t${tid}`;
		tableNode.set(tid, id);
		const m = meta[tid];
		const list = rows.get(tid) ?? [];
		const inputs: string[] = [];
		let badge = t.target ? "대상" : t.virt ? "함수" : m?.kind === "view" ? "뷰" : null;
		if (t.cte !== null) {
			if (within(t.cte, t.scope)) badge = "재귀";
			else {
				badge = "CTE";
				const o = scopeOut.get(t.cte);
				if (o) cross.push({ from: o, to: id, label: null, kind: "cte" });
				else inputs.push(scopeFor(t.cte));
			}
		}
		const pkUnused = m?.cols?.filter((c) => c.pk && !list.some((r) => r.name.toLowerCase() === c.name.toLowerCase())).map((c) => c.name);
		const sub = [t.alias && t.alias !== t.name ? `별칭 ${t.alias}` : null, pkUnused?.length ? `PK ${pkUnused.join(", ")}` : null].filter(Boolean).join(" · ") || null;
		add({
			id,
			kind: "table",
			scope: t.scope,
			title: `${t.schema ? `${t.schema}.` : ""}${t.name}`,
			code: null,
			sub,
			badge,
			ranges: [t.span ?? t.pos].filter(isR),
			inputs,
			w: TW,
			h: tableH(list.length, !!sub),
			table: tid,
			cols: list.slice(0, MAX_TROWS),
			more: Math.max(0, list.length - MAX_TROWS),
			missing: missingTables.has(tid),
		});
		return id;
	};

	const joinFor = (ji: number): string => {
		const id = `j${ji}`;
		if (nodes.has(id)) return id;
		const j = map.joins[ji];
		const inputs = [inFor(j.ia), inFor(j.ib)].filter((x): x is string => !!x);
		const rt = j.right !== null ? map.tables[j.right] : null;
		const rspan = rt ? (rt.derived !== null ? (map.scopes[rt.derived]?.range ?? rt.span) : (rt.span ?? rt.pos)) : null;
		let title = JOIN_TITLE[j.kind] ?? j.kind.toUpperCase();
		// 쓴 그대로의 키워드(JOIN · LEFT OUTER JOIN …)
		if (j.clause && rspan && rspan[0] > j.clause[0]) {
			const kw = text.slice(j.clause[0], rspan[0]).replace(/[\s(]+/g, " ").trim().toUpperCase();
			if (kw && kw.length <= 28 && /^[A-Z_ ]+$/.test(kw)) title = kw;
		}
		let code: string | null = null;
		let sub: string | null = null;
		let bad = false;
		if (j.kind === "comma") {
			bad = map.facts.some((f) => f.kind === "cartesian" && f.table === j.right && f.scope === j.scope);
			const linked = map.joins.filter((x) => x.kind === "where" && x.scope === j.scope && j.right !== null && (x.left === j.right || x.right === j.right));
			if (linked.length) {
				code = linked.flatMap((x) => x.on.map((p) => `${cn(p.a)} = ${cn(p.b)}`)).join(" AND ");
				sub = "WHERE 에서 잇는다";
			} else if (bad) {
				code = "잇는 조건 없음";
				sub = "행 수가 곱해진다(데카르트 곱)";
			}
		} else if (j.hasOn) code = j.using.length ? `USING (${j.using.join(", ")})` : j.natural ? "같은 이름 열끼리(NATURAL)" : snip(text, j.pos, 160);
		else if (j.kind === "cross") sub = "모든 행 짝";
		else if (j.kind !== "apply") {
			bad = true;
			code = "ON 없음";
			sub = "모든 행 짝(데카르트 곱)";
		}
		if (bad && inputs[1]) badEdges.add(`${inputs[1]}->${id}`);
		add({ id, kind: "join", scope: j.scope, title, code, sub, badge: null, ranges: [j.clause ?? j.pos].filter(isR), inputs, w: SW, h: stageH(!!code, !!sub), bad });
		return id;
	};

	const scopeFor = (sid: number): string => {
		const done = scopeOut.get(sid);
		if (done) return done;
		const sc = map.scopes[sid];
		const main = sc.kind === "main";
		const outId = main ? "result" : `o${sid}`;
		// 먼저 적어 둔다(재귀 CTE 가 자기를 다시 부르지 않게)
		scopeOut.set(sid, outId);
		let prev: string | null = null;
		const branches = kids(sid, "union");
		if (branches.length) {
			const ops = cl(sid, "setop");
			const names = [...new Set(ops.map((o) => snip(text, o.pos, 30).toUpperCase()))];
			const inputs = branches.map((b) => scopeFor(b.id));
			const dedupe = names.some((n) => !/\bALL\b/.test(n));
			prev = add({
				id: `u${sid}`,
				kind: "union",
				scope: sid,
				title: names.join(" · ") || "UNION",
				code: null,
				sub: `갈래 ${branches.length}개${dedupe ? " · 같은 행은 하나로" : " · 그대로 이어 붙임"}`,
				badge: null,
				ranges: ops.map((o) => o.pos).filter(isR),
				inputs,
				w: SW,
				h: stageH(false, true),
			});
		} else if (sc.src) prev = inFor(sc.src);
		const stage = (id: string, kind: Kind, title: string, ranges: Pos[], code: string | null, sub: string | null) => {
			const rs = ranges.filter(isR);
			if (!rs.length) return;
			prev = add({ id, kind, scope: sid, title, code: code || null, sub: sub || null, badge: null, ranges: rs, inputs: prev ? [prev] : [], w: SW, h: stageH(!!code, !!sub) });
		};
		const where = one(sid, "where");
		stage(`w${sid}`, "where", "WHERE", [where], snip(text, where).replace(/^where\s+/i, ""), "조건에 맞는 행만");
		const group = one(sid, "group");
		const having = one(sid, "having");
		const mine = outs.filter((o) => o.scope === sid);
		const aggs = mine.filter((o) => o.agg);
		const aggNames = aggs.map((o) => o.name ?? snip(text, o.pos, 24)).join(", ");
		if (group || having)
			stage(`g${sid}`, "group", group ? "GROUP BY" : "집계", [group, having], group ? snip(text, group).replace(/^group\s+by\s+/i, "") : "전체를 한 묶음으로", having ? snip(text, having, 90) : aggs.length ? `묶음마다 ${clip(aggNames, 40)}` : null);
		else if (aggs.length) stage(`g${sid}`, "group", "집계", aggs.map((o) => o.pos), "전체를 한 행으로", clip(aggNames, 48));
		const wins = cl(sid, "window");
		stage(`x${sid}`, "window", "창 함수", wins.map((c) => c.pos), snip(text, wins[0]?.pos, 140), wins.length > 1 ? `외 ${wins.length - 1}개 · 행은 그대로` : "행은 그대로, 값만 더함");
		const dis = one(sid, "distinct");
		stage(`d${sid}`, "distinct", "DISTINCT", [dis], /\bon\b/i.test(snip(text, dis)) ? snip(text, dis).replace(/^distinct\s+/i, "") : null, "같은 행은 하나만");
		const order = one(sid, "order");
		const limit = one(sid, "limit");
		const lim = snip(text, limit);
		const limWord = lim.split(/[\s(]/)[0]?.toUpperCase() || "LIMIT";
		stage(`s${sid}`, "order", order ? (limit ? `ORDER BY · ${limWord}` : "ORDER BY") : limWord, [order, limit], order ? snip(text, order).replace(/^order\s+by\s+/i, "") : lim.slice(limWord.length).trim() || lim, order && limit ? lim : null);

		// 출력 — 바깥 문장은 결과(가운데 주인공), 안쪽 묶음은 작은 출력
		const rowsOut = outsOf(sid).map((o, k) => outRow(o, k));
		if (main) {
			let title = "결과";
			let code: string | null = null;
			let ranges: Pos[] = [];
			let list = rowsOut;
			const target = one(sid, "target");
			if (map.kind === "select") {
				ranges = branches.length ? branches.flatMap((b) => cl(b.id, "select").map((c) => c.pos)) : cl(sid, "select").map((c) => c.pos);
			} else if (map.kind === "insert") {
				title = snip(text, target, 40) || "INSERT";
				ranges = [target];
				list = map.cols.filter((c) => c.scope === sid && c.role === "insert").map((c, k) => ({ k, label: c.name, hint: null, agg: false, win: false, sub: false, star: false, pos: c.pos }));
				if (!list.length) code = "모든 열에 넣는다";
			} else {
				title = snip(text, target, 40) || map.kind.toUpperCase();
				const set = one(sid, "set");
				ranges = [target, set];
				code = map.kind === "update" ? snip(text, set, 160) : "조건에 맞는 행을 지운다";
				list = [];
			}
			add({ id: outId, kind: "result", scope: sid, title, code, sub: list.length ? `열 ${list.length}개` : null, badge: null, ranges: ranges.filter(isR), inputs: prev ? [prev] : [], w: RW, h: resultH(list.length, !!code), rows: list.slice(0, MAX_RROWS), rowsMore: Math.max(0, list.length - MAX_RROWS) });
		} else {
			const title = sc.kind === "derived" ? (sc.name ?? "(서브쿼리)") : sc.kind === "cte" ? (sc.name ?? "CTE") : sc.kind === "union" ? "출력" : sc.name === "SELECT" ? "넣을 행" : sc.name?.includes("EXISTS") ? "있는지 / 없는지" : sc.name?.includes("IN") ? "값 목록" : "값 하나";
			add({
				id: outId,
				kind: "out",
				scope: sid,
				title,
				code: null,
				sub: null,
				badge: sc.kind === "derived" ? "서브쿼리" : sc.kind === "cte" ? "CTE" : null,
				ranges: [sc.range ?? sc.pos].filter(isR),
				inputs: prev ? [prev] : [],
				w: OW,
				h: outH(rowsOut.length),
				rows: rowsOut.slice(0, MAX_OROWS),
				rowsMore: Math.max(0, rowsOut.length - MAX_OROWS),
			});
		}
		// 이 묶음 안의 서브쿼리(IN · EXISTS · 스칼라) — 그 서브쿼리가 놓인 절의 단계로 흘러 들어간다
		for (const c of kids(sid, "subquery")) {
			if (scopeOut.has(c.id)) continue;
			const at = (c.range ?? c.pos)?.[0];
			const host = (at !== undefined && smallest(at, (n) => n.scope === sid && n.kind !== "table")) || outId;
			const sub = scopeFor(c.id);
			nodes.get(host)?.inputs.push(sub);
		}
		// FROM 에 있는데 이어지지 않은 표(UPDATE … FROM · DELETE … USING 등)
		for (const t of map.tables) if (t.scope === sid && !tableNode.has(t.id)) nodes.get(outId)?.inputs.push(tableFor(t.id));
		return outId;
	};

	/** 위치를 품은 가장 작은 단계 */
	const smallest = (at: number, ok: (n: FNode) => boolean): string | null => {
		let best: FNode | null = null;
		let bestLen = Number.POSITIVE_INFINITY;
		for (const n of nodes.values()) {
			if (!ok(n)) continue;
			for (const [a, b] of n.ranges) {
				const len = b - a;
				// 같은 크기면 표보다 단계(데카르트 곱 표지는 조인에)
				if (at >= a && at <= b && (len < bestLen || (len === bestLen && best?.kind === "table" && n.kind !== "table"))) {
					best = n;
					bestLen = len;
				}
			}
		}
		return best?.id ?? null;
	};

	const roots: string[] = [];
	const main = map.scopes.find((s) => s.kind === "main");
	if (main) roots.push(scopeFor(main.id));
	// 아무도 쓰지 않은 CTE 는 따로
	for (const s of map.scopes) if (s.kind === "cte" && !scopeOut.has(s.id)) roots.push(scopeFor(s.id));

	// 상관 서브쿼리 — 바깥 표의 값이 서브쿼리로
	for (const f of map.facts)
		if (f.kind === "correlated" && f.sub !== null && f.table !== null) {
			const from = tableNode.get(f.table);
			const to = scopeOut.get(f.sub);
			if (from && to && from !== to) cross.push({ from, to, label: "상관", kind: "corr" });
		}
	// 경고 표지 — 그 위치를 품은 가장 작은 단계에
	for (const f of findings) {
		if (f.layer !== "map" || !f.pos) continue;
		const id = smallest(f.pos[0], () => true);
		if (id) nodes.get(id)?.warns.push(f);
	}
	const parent = new Map<string, string>();
	for (const n of nodes.values()) for (const k of n.inputs) if (!parent.has(k)) parent.set(k, n.id);
	return { nodes, roots, cross, scopeOut, tableNode, parent, badEdges };
}

// ── 배치: 결과를 뿌리로 한 물고기뼈 — 본줄기는 한 줄, 곁가지는 위·아래(또는 좌·우)로 번갈아 ──

const GAP_D = 58;
const GAP_B = 20;
const PAD = 12;
const HEAD = 22;

type Laid = { pos: Map<string, { x: number; y: number }>; groups: { sid: number; id: string; x: number; y: number; w: number; h: number }[]; bounds: { x: number; y: number; w: number; h: number } };

function layout(flow: Flow, horizontal: boolean): Laid {
	const { nodes } = flow;
	const dsz = (n: FNode) => (horizontal ? n.w : n.h);
	const bsz = (n: FNode) => (horizontal ? n.h : n.w);
	const rel = new Map<string, { d: number; b: number }>();
	const ext = new Map<string, { top: number; bottom: number; dmin: number }>();
	const seen = new Set<string>();
	const measure = (id: string, depth: number) => {
		seen.add(id);
		const n = nodes.get(id) as FNode;
		let top = -bsz(n) / 2;
		let bottom = bsz(n) / 2;
		let dmin = -dsz(n);
		let side = 0;
		for (const k of n.inputs) {
			if (seen.has(k) || !nodes.has(k)) continue;
			const kb = measure(k, depth + 1);
			const d = -dsz(n) - GAP_D;
			let b = 0;
			if (k !== n.inputs[0]) {
				const below = (side + depth) % 2 === 0;
				side++;
				b = below ? bottom + GAP_B - kb.top : top - GAP_B - kb.bottom;
			}
			rel.set(k, { d, b });
			top = Math.min(top, b + kb.top);
			bottom = Math.max(bottom, b + kb.bottom);
			dmin = Math.min(dmin, d + kb.dmin);
		}
		// 안쪽 묶음(CTE·서브쿼리·UNION 갈래)은 상자 — 그 몫의 여백
		if (n.kind === "out") {
			top -= PAD + (horizontal ? HEAD : 0);
			bottom += PAD;
			dmin -= PAD + (horizontal ? 0 : HEAD);
		}
		const e = { top, bottom, dmin };
		ext.set(id, e);
		return e;
	};
	const abs = new Map<string, { d: number; b: number }>();
	const place = (id: string, d: number, b: number) => {
		abs.set(id, { d, b });
		const n = nodes.get(id) as FNode;
		for (const k of n.inputs) {
			const r = rel.get(k);
			if (r && !abs.has(k)) place(k, d + r.d, b + r.b);
		}
	};
	let offset = 0;
	for (const r of flow.roots) {
		const e = measure(r, 0);
		const b = offset - e.top;
		place(r, 0, b);
		offset = b + e.bottom + GAP_B * 3;
	}
	const pos = new Map<string, { x: number; y: number }>();
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [id, p] of abs) {
		const n = nodes.get(id) as FNode;
		const x = horizontal ? p.d - n.w : p.b - n.w / 2;
		const y = horizontal ? p.b - n.h / 2 : p.d - n.h;
		pos.set(id, { x, y });
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + n.w);
		maxY = Math.max(maxY, y + n.h);
	}
	const groups: Laid["groups"] = [];
	for (const [sid, id] of flow.scopeOut) {
		const n = nodes.get(id);
		const p = abs.get(id);
		const e = ext.get(id);
		if (!n || !p || !e || n.kind !== "out") continue;
		const g = horizontal ? { x: p.d + e.dmin, y: p.b + e.top, w: PAD - e.dmin, h: e.bottom - e.top } : { x: p.b + e.top, y: p.d + e.dmin, w: e.bottom - e.top, h: PAD - e.dmin };
		groups.push({ sid, id: `g${sid}`, ...g });
		minX = Math.min(minX, g.x);
		minY = Math.min(minY, g.y);
		maxX = Math.max(maxX, g.x + g.w);
		maxY = Math.max(maxY, g.y + g.h);
	}
	return { pos, groups, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

// ── 계보: 결과 열 하나가 어느 표의 어느 열에서 왔나 ──

type Lit = { nodes: Set<string>; edges: Set<string>; cols: Set<string> };

function lineage(flow: Flow, snap: Snapshot, sid: number, k: number): Lit {
	const { map, resolved } = snap;
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const outs = map.outs ?? [];
	const L: Lit = { nodes: new Set(), edges: new Set(), cols: new Set() };
	const up = (from: string, stop: string) => {
		let n = from;
		L.nodes.add(n);
		for (let i = 0; i < 400 && n !== stop; i++) {
			const p = flow.parent.get(n);
			if (!p) break;
			L.edges.add(`${n}->${p}`);
			n = p;
			L.nodes.add(n);
		}
	};
	const own = (s: number) => outs.filter((o) => o.scope === s);
	const within = (outer: number, s: number) => {
		let c: number | null = s;
		while (c !== null) {
			if (c === outer) return true;
			c = map.scopes[c]?.parent ?? null;
		}
		return false;
	};
	const branchesOf = (s: number) => map.scopes.filter((x) => x.parent === s && x.kind === "union");
	const outsOf = (s: number): MapOut[] => {
		const o = own(s);
		if (o.length) return o;
		const b = branchesOf(s)[0];
		return b ? outsOf(b.id) : [];
	};
	const traceTable = (tid: number, col: string, stop: string, depth: number) => {
		const nid = flow.tableNode.get(tid);
		if (!nid) return;
		L.cols.add(`${nid}:${col.toLowerCase()}`);
		up(nid, stop);
		const t = map.tables[tid];
		// 재귀 CTE 의 자기 참조는 따라 들어가지 않는다
		const inner = t.derived ?? (t.cte !== null && !within(t.cte, t.scope) ? t.cte : null);
		if (inner === null || depth > 10) return;
		const so = flow.scopeOut.get(inner);
		if (!so || so === flow.scopeOut.get(t.scope)) return;
		if (t.cte !== null) L.edges.add(`${so}->${nid}`);
		const list = outsOf(inner);
		let i = col === "*" ? -1 : list.findIndex((o) => o.name?.toLowerCase() === col.toLowerCase());
		if (i < 0 && col !== "*") i = list.findIndex((o) => o.star !== undefined);
		if (col === "*") list.forEach((_, j) => traceCol(inner, j, depth + 1));
		else if (i >= 0) traceCol(inner, i, depth + 1);
	};
	const traceCol = (s: number, kk: number, depth: number) => {
		const stop = flow.scopeOut.get(s);
		if (!stop || depth > 10) return;
		L.nodes.add(stop);
		const br = branchesOf(s);
		if (br.length && !own(s).length) {
			for (const b of br) {
				const bo = flow.scopeOut.get(b.id);
				if (bo) up(bo, stop);
				traceCol(b.id, kk, depth + 1);
			}
			return;
		}
		const o = own(s)[kk];
		if (!o) return;
		if (stop !== "result") L.cols.add(`${stop}:#${kk}`);
		for (let c = o.cols[0]; c < o.cols[1]; c++) {
			const col = map.cols[c];
			if (!col || col.scope !== s) continue;
			const t = colTable[c];
			if (t !== null && t !== undefined) traceTable(t, col.name, stop, depth);
		}
		if (o.star !== undefined)
			for (const t of map.tables)
				if (t.scope === s && (!o.star || (t.alias ?? t.name).toLowerCase() === o.star.toLowerCase() || t.name.toLowerCase() === o.star.toLowerCase())) traceTable(t.id, "*", stop, depth);
		for (const sub of o.subs ?? []) {
			const so = flow.scopeOut.get(sub);
			if (!so) continue;
			up(so, stop);
			if (outsOf(sub).length) traceCol(sub, 0, depth + 1);
		}
	};
	traceCol(sid, k, 0);
	return L;
}

// ── 그리기 ─────────────────────────────────────────────────

type Ui = {
	lit: Lit | null;
	cursor: string | null;
	picked: string | null;
	horizontal: boolean;
	hover: (scope: number, k: number | null) => void;
	pickRow: (n: FNode, row: OutRow) => void;
	pickCol: (n: FNode, c: ColRow) => void;
};
const UiCtx = createContext<Ui>({ lit: null, cursor: null, picked: null, horizontal: true, hover: () => {}, pickRow: () => {}, pickCol: () => {} });
type ND = { n: FNode };
type GD = { label: string; kind: string; sid: number };

function useNodeClass(n: FNode) {
	const ui = useContext(UiCtx);
	const dim = ui.lit && !ui.lit.nodes.has(n.id);
	const lit = ui.lit?.nodes.has(n.id);
	return {
		ui,
		cls: `qf-node k-${n.kind}${n.bad ? " bad" : ""}${n.warns.some((f) => f.level === "warn") ? " warned" : ""}${ui.picked === n.id ? " picked" : ""}${ui.cursor === n.id ? " at-cursor" : ""}${dim ? " dim" : ""}${lit ? " lit" : ""}`,
	};
}

function Ports() {
	const { horizontal } = useContext(UiCtx);
	return (
		<>
			<Handle type="target" position={horizontal ? Position.Left : Position.Top} isConnectable={false} />
			<Handle type="source" position={horizontal ? Position.Right : Position.Bottom} isConnectable={false} />
		</>
	);
}

function Warns({ list }: { list: Finding[] }) {
	if (!list.length) return null;
	const warn = list.some((f) => f.level === "warn");
	return (
		<span className={`qf-warn${warn ? " warn" : ""}`} title={list.map((f) => `${f.title} — ${f.why}`).join("\n")}>
			{warn ? <AlertTriangle size={11} /> : <Info size={11} />}
			{list.length > 1 ? list.length : null}
		</span>
	);
}

const ICON: Record<string, typeof Table2> = { table: Table2, join: GitMerge, where: Funnel, group: Sigma, window: SquareFunction, distinct: CopyMinus, order: ArrowDownWideNarrow, union: Combine, out: ListTree, result: Sheet };

const TableNode = memo(function TableNode({ data }: NodeProps<Node<ND>>) {
	const n = data.n;
	const { ui, cls } = useNodeClass(n);
	return (
		<div className={`${cls}${n.missing ? " missing" : ""}`}>
			<Ports />
			<div className="qf-head">
				<span className="qf-ico">
					<Table2 size={12} />
				</span>
				<b title={n.title}>{n.title}</b>
				{n.badge && <span className="qf-badge">{n.badge}</span>}
				<Warns list={n.warns} />
			</div>
			{n.sub && <div className="qf-tsub">{n.sub}</div>}
			<div className="qf-cols">
				{n.cols?.length ? (
					n.cols.map((c) => {
						const on = ui.lit && (ui.lit.cols.has(`${n.id}:${c.name.toLowerCase()}`) || ui.lit.cols.has(`${n.id}:*`));
						return (
							<button
								type="button"
								key={c.name}
								className={`qm-col${c.pk ? " pk" : ""}${c.fk ? " fk" : ""}${c.missing ? " missing" : ""}${/[WGO]/.test(c.roles) ? " hot" : ""}${on ? " lit" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									ui.pickCol(n, c);
								}}
								title={`${c.name}${c.type ? ` · ${c.type}` : ""}${c.pk ? " · PK" : ""}${c.fk ? " · FK" : ""}${c.missing ? " · 표에 없는 열" : ""} — ${[...c.roles].map((r) => ROLE_TIP[r]).join(", ")}`}
							>
								<span className="qm-cname">
									{c.pk ? "🔑 " : c.fk ? "↗ " : ""}
									{c.name}
								</span>
								<span className="qm-roles">
									{[...c.roles].map((r) => (
										<i key={r} className={`r-${r}`}>
											{r}
										</i>
									))}
								</span>
							</button>
						);
					})
				) : (
					<div className="qf-none">쓴 열 없음</div>
				)}
				{(n.more ?? 0) > 0 && <div className="qm-more">열 {n.more}개 더</div>}
			</div>
		</div>
	);
});

const StageNode = memo(function StageNode({ data }: NodeProps<Node<ND>>) {
	const n = data.n;
	const { cls } = useNodeClass(n);
	const Icon = ICON[n.kind] ?? Funnel;
	return (
		<div className={cls}>
			<Ports />
			<div className="qf-head">
				<span className="qf-ico">
					<Icon size={12} />
				</span>
				<b>{n.title}</b>
				<Warns list={n.warns} />
			</div>
			{n.code && (
				<code className="qf-code" title={n.code}>
					{n.code}
				</code>
			)}
			{n.sub && <div className="qf-sub">{n.sub}</div>}
		</div>
	);
});

function Rows({ n, big }: { n: FNode; big: boolean }) {
	const { ui } = useNodeClass(n);
	return (
		<div className="qf-rows">
			{(n.rows ?? []).map((r) => {
				const on = ui.lit && (ui.lit.cols.has(`${n.id}:#${r.k}`) || (big && ui.lit.cols.has(`row:${n.scope}:${r.k}`)));
				return (
					<button
						type="button"
						key={r.k}
						className={`qf-row${on ? " lit" : ""}`}
						onMouseEnter={() => ui.hover(n.scope, r.k)}
						onMouseLeave={() => ui.hover(n.scope, null)}
						onClick={(e) => {
							e.stopPropagation();
							ui.pickRow(n, r);
						}}
						title={`${r.label}${r.hint ? ` ← ${r.hint}` : ""} — 올리면 어디서 왔는지, 누르면 편집기에서 그 항목`}
					>
						<span className="qf-rname">{r.label}</span>
						{r.hint && <span className="qf-rhint">{r.hint}</span>}
						{(r.agg || r.win || r.sub) && <span className="qf-rtag">{r.win ? "창" : r.agg ? "집계" : "서브쿼리"}</span>}
					</button>
				);
			})}
			{!n.rows?.length && !n.code && <div className="qf-none">열 없음</div>}
			{(n.rowsMore ?? 0) > 0 && <div className="qm-more">열 {n.rowsMore}개 더</div>}
		</div>
	);
}

const OutNode = memo(function OutNode({ data }: NodeProps<Node<ND>>) {
	const n = data.n;
	const { cls } = useNodeClass(n);
	return (
		<div className={cls}>
			<Ports />
			<div className="qf-head">
				<span className="qf-ico">
					<ListTree size={12} />
				</span>
				<b title={n.title}>{n.title}</b>
				{n.badge && <span className="qf-badge">{n.badge}</span>}
				<Warns list={n.warns} />
			</div>
			<Rows n={n} big={false} />
		</div>
	);
});

const ResultNode = memo(function ResultNode({ data }: NodeProps<Node<ND>>) {
	const n = data.n;
	const { cls } = useNodeClass(n);
	return (
		<div className={cls}>
			<Ports />
			<div className="qf-rhead">
				<span className="qf-ico big">
					<Sheet size={15} />
				</span>
				<div>
					<b title={n.title}>{n.title}</b>
					<small>{n.sub ?? "이 문장이 내놓는 것"}</small>
				</div>
				<Warns list={n.warns} />
			</div>
			{n.code && (
				<code className="qf-code" title={n.code}>
					{n.code}
				</code>
			)}
			<Rows n={n} big />
		</div>
	);
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GD>>) {
	return (
		<div className={`qf-group k-${data.kind}`}>
			<div className="qf-group-head">{data.label}</div>
		</div>
	);
});

const nodeTypes = { qtable: TableNode, qstage: StageNode, qout: OutNode, qresult: ResultNode, qgroup: GroupNode };
const TYPE_OF: Record<Kind, keyof typeof nodeTypes> = { table: "qtable", join: "qstage", where: "qstage", group: "qstage", window: "qstage", distinct: "qstage", order: "qstage", union: "qstage", out: "qout", result: "qresult" };

type Drawn = { flow: Flow; nodes: Node[]; edges: Edge[]; bounds: Laid["bounds"]; result: { x: number; y: number; w: number; h: number } | null; key: string };

/** 그래프와 두 방향 배치 — 방향은 칸 모양에 더 크게 들어가는 쪽을 고른다 */
type Prepared = { flow: Flow; map: QueryMap; h: Laid; v: Laid };
function prepare(snap: Snapshot, findings: Finding[]): Prepared {
	const flow = buildFlow(snap, findings);
	return { flow, map: snap.map, h: layout(flow, true), v: layout(flow, false) };
}
const fitZoom = (b: Laid["bounds"], w: number, h: number) => Math.min((w - 56) / Math.max(1, b.w), (h - 56) / Math.max(1, b.h));

function draw(prep: Prepared, horizontal: boolean): Drawn {
	const { flow, map } = prep;
	const laid = horizontal ? prep.h : prep.v;
	const nodes: Node[] = [];
	for (const g of laid.groups) {
		const kind = map.scopes[g.sid]?.kind ?? "subquery";
		nodes.push({ id: g.id, type: "qgroup", position: { x: g.x, y: g.y }, data: { label: groupLabel(map, g.sid), kind, sid: g.sid } satisfies GD, style: { width: g.w, height: g.h }, zIndex: 0, selectable: false });
	}
	let result: Drawn["result"] = null;
	for (const [id, n] of flow.nodes) {
		const p = laid.pos.get(id);
		if (!p) continue;
		if (id === "result") result = { x: p.x, y: p.y, w: n.w, h: n.h };
		nodes.push({ id, type: TYPE_OF[n.kind], position: p, data: { n } satisfies ND, style: { width: n.w, height: n.h }, zIndex: 1 });
	}
	const edges: Edge[] = [];
	for (const n of flow.nodes.values())
		n.inputs.forEach((k, i) => {
			if (!laid.pos.has(k)) return;
			const id = `${k}->${n.id}`;
			const kn = flow.nodes.get(k);
			const spine = i === 0 && n.scope === kn?.scope;
			edges.push({ id, source: k, target: n.id, className: `qf-edge${spine ? " spine" : " side"}${flow.badEdges.has(id) ? " bad" : ""}`, data: {} });
		});
	for (const c of flow.cross) {
		if (!laid.pos.has(c.from) || !laid.pos.has(c.to)) continue;
		edges.push({ id: `${c.from}->${c.to}`, source: c.from, target: c.to, className: `qf-edge cross k-${c.kind}`, label: c.label ?? undefined, labelBgPadding: [4, 2], labelBgBorderRadius: 4, data: {} });
	}
	const key = `${horizontal ? "h" : "v"}|${[...flow.nodes.keys()].join(",")}`;
	return { flow, nodes, edges, bounds: laid.bounds, result, key };
}

const mapWarnsOf = (snap: Snapshot) => snap.findings.filter((f) => f.layer === "map");

/** 쿼리 지도 — 결과(출력 열)를 가운데 주인공으로, 그 결과를 만드는 단계를 흐름으로 그린다. 서버에는 묻지 않는다 */
export function QueryMapPanel({ deps, visible, onTuning }: { deps: AnalyzeDeps; visible: boolean; onTuning: () => void }) {
	const { state, refresh } = useAnalysis(deps, visible);
	const snap = state.snap;
	const snapRef = useRef(snap);
	snapRef.current = snap;
	const rf = useRef<ReactFlowInstance | null>(null);
	const host = useRef<HTMLDivElement>(null);
	const conn = deps.conn;
	const [size, setSize] = useState({ w: 0, h: 0 });
	const [dirPref, setDirPref] = useState<"auto" | "h" | "v">("auto");
	// biome-ignore lint/correctness/useExhaustiveDependencies: 구조·글이 바뀔 때만 다시 만든다
	const prep = useMemo(() => (snap ? prepare(snap, mapWarnsOf(snap)) : null), [snap?.shape, snap?.stmt.text, snap?.findings.length]);
	// 자동 — 칸에 더 크게 들어가는 방향(비슷하면 가로)
	const horizontal = dirPref !== "auto" ? dirPref === "h" : !prep || !size.w || !size.h || fitZoom(prep.h.bounds, size.w, size.h) >= fitZoom(prep.v.bounds, size.w, size.h) * 0.92;
	const mapWarns = useMemo(() => (snap ? mapWarnsOf(snap) : []), [snap]);
	const drawn = useMemo(() => (prep ? draw(prep, horizontal) : null), [prep, horizontal]);
	const drawnRef = useRef(drawn);
	drawnRef.current = drawn;

	const [hover, setHover] = useState<{ scope: number; k: number } | null>(null);
	const [pinned, setPinned] = useState<{ scope: number; k: number } | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const focusRow = hover ?? pinned;
	const lit = useMemo(() => {
		if (!focusRow || !drawn || !snap) return null;
		const L = lineage(drawn.flow, snap, focusRow.scope, focusRow.k);
		L.cols.add(`row:${focusRow.scope}:${focusRow.k}`);
		return L;
	}, [focusRow, drawn, snap]);

	// 새 그림(다른 문장·구조)이면 고른 것·계보·편집기 강조를 버린다
	// biome-ignore lint/correctness/useExhaustiveDependencies: 그림이 바뀔 때만
	useEffect(() => {
		setPicked(null);
		setPinned(null);
		setHover(null);
		markEditor(conn, [], false);
	}, [drawn?.key.slice(2)]);

	/** 사용자가 그림을 옮기거나 키웠나(그 뒤로는 칸 크기가 바뀌어도 그대로) */
	const moved = useRef(false);
	/** 결과가 잘 보이게 맞추기 — 다 들어가면 전체, 너무 작아지면 결과 쪽(끝)을 붙잡는다 */
	const fit = useCallback(() => {
		const inst = rf.current;
		const el = host.current;
		const d = drawnRef.current;
		if (!inst || !el || !d) return;
		const W = el.clientWidth;
		const H = el.clientHeight;
		if (!W || !H) return;
		const b = d.bounds;
		const pad = 28;
		const z = Math.min(1.05, (W - pad * 2) / Math.max(1, b.w), (H - pad * 2) / Math.max(1, b.h));
		const MINZ = 0.6;
		if (z >= MINZ || !d.result) {
			const zz = Math.max(0.12, z);
			void inst.setViewport({ zoom: zz, x: (W - b.w * zz) / 2 - b.x * zz, y: (H - b.h * zz) / 2 - b.y * zz });
			return;
		}
		const r = d.result;
		const hz = d.key.startsWith("h");
		// 가로 흐름이면 결과를 오른쪽 끝 안쪽에, 세로면 아래쪽 안쪽에 — 다른 축은 결과 가운데
		const x = hz ? W - pad - (r.x + r.w) * MINZ : W / 2 - (r.x + r.w / 2) * MINZ;
		const y = hz ? H / 2 - (r.y + r.h / 2) * MINZ : H - pad - (r.y + r.h) * MINZ;
		void inst.setViewport({ zoom: MINZ, x, y });
	}, []);

	// 크기 — 숨었다 보이면(0 → N) 다시 맞춘다, 가로·세로 흐름도 여기서 고른다
	useLayoutEffect(() => {
		const el = host.current;
		if (!el) return;
		let was = el.clientWidth > 0 && el.clientHeight > 0;
		let refit = 0;
		setSize({ w: el.clientWidth, h: el.clientHeight });
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			const now = w > 0 && h > 0;
			setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
			// 숨었다 보이면, 또는 사용자가 아직 옮기지 않았으면 칸 크기에 다시 맞춘다
			if ((now && !was) || (now && !moved.current)) {
				cancelAnimationFrame(refit);
				refit = requestAnimationFrame(fit);
			}
			was = now;
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(refit);
		};
	}, [fit]);
	const fitKey = drawn?.key ?? "";
	useEffect(() => {
		if (!fitKey) return;
		moved.current = false;
		const id = requestAnimationFrame(fit);
		return () => cancelAnimationFrame(id);
	}, [fitKey, fit]);
	useEffect(() => {
		if (visible) {
			const id = requestAnimationFrame(fit);
			return () => cancelAnimationFrame(id);
		}
	}, [visible, fit]);

	// 편집기 커서 → 그 절의 단계를 그래프에서 강조(멈춤 없이, 한 프레임에 한 번)
	useEffect(() => {
		if (!visible || !snap || !drawn) {
			setCursor(null);
			return;
		}
		if (snap.stmt.text.length > 60_000) return;
		let raf = 0;
		let checkedDoc: unknown = null;
		let docOk = false;
		const run = () => {
			raf = 0;
			const v = currentView(conn);
			if (!v) return setCursor(null);
			if (v.state.doc !== checkedDoc) {
				checkedDoc = v.state.doc;
				docOk = sameText(conn, snap);
			}
			if (!docOk) return;
			const off = v.state.selection.main.head - snap.stmt.from;
			if (off < 0 || off > snap.stmt.text.length) return setCursor(null);
			let best: string | null = null;
			let bestLen = Number.POSITIVE_INFINITY;
			for (const n of drawn.flow.nodes.values())
				for (const [a, b] of n.ranges)
					if (off >= a && off <= b && b - a < bestLen) {
						best = n.id;
						bestLen = b - a;
					}
			setCursor(best);
		};
		const off = subscribeEditor(conn, () => {
			if (!raf) raf = requestAnimationFrame(run);
		});
		run();
		return () => {
			off();
			cancelAnimationFrame(raf);
		};
	}, [conn, visible, snap, drawn]);

	// 숨으면 편집기 강조를 지운다
	useEffect(() => {
		if (!visible) markEditor(conn, [], false);
	}, [visible, conn]);
	useEffect(() => () => markEditor(conn, [], false), [conn]);

	const pick = useCallback(
		(id: string, ranges: R[]) => {
			setPicked((p) => {
				if (p === id) {
					markEditor(conn, [], false);
					return null;
				}
				markIn(conn, snapRef.current, ranges);
				return id;
			});
		},
		[conn],
	);
	const ui = useMemo<Ui>(
		() => ({
			lit,
			cursor,
			picked,
			horizontal,
			hover: (scope, k) => setHover(k === null ? null : { scope, k }),
			pickRow: (n, row) => {
				setPinned((p) => (p && p.scope === n.scope && p.k === row.k ? null : { scope: n.scope, k: row.k }));
				pick(`${n.id}#${row.k}`, row.pos ? [row.pos] : n.ranges);
			},
			pickCol: (n, c) => {
				const s = snapRef.current;
				if (!s) return;
				const colTable = s.resolved?.colTable ?? s.map.cols.map((x) => x.table);
				const tid = n.table;
				const ranges = s.map.cols.filter((x) => colTable[x.id] === tid && x.name.toLowerCase() === c.name.toLowerCase()).map((x) => x.pos).filter(isR);
				pick(`${n.id}:${c.name}`, ranges.length ? ranges : n.ranges);
			},
		}),
		[lit, cursor, picked, horizontal, pick],
	);

	const edges = useMemo(() => {
		if (!drawn) return [];
		if (!lit) return drawn.edges;
		return drawn.edges.map((e) => ({ ...e, className: `${e.className}${lit.edges.has(e.id) ? " lit" : " dim"}`, animated: lit.edges.has(e.id) }));
	}, [drawn, lit]);

	const others = (snap?.findings ?? []).filter((f) => f.layer !== "map").length;
	return (
		<div className="panel-fill qmap-panel">
			<div className={`qm-host${snap?.stale ? " stale" : ""}`} ref={host}>
				{snap && drawn && drawn.nodes.length > 0 ? (
					<UiCtx.Provider value={ui}>
						<ReactFlow
							key={horizontal ? "h" : "v"}
							nodes={drawn.nodes}
							edges={edges}
							nodeTypes={nodeTypes}
							onInit={(i) => {
								rf.current = i;
								requestAnimationFrame(fit);
							}}
							onNodeClick={(_, node) => {
								const d = node.data as Partial<ND> & Partial<GD>;
								if (d.n) pick(d.n.id, d.n.ranges);
								else if (d.sid !== undefined) {
									const sc = snapRef.current?.map.scopes[d.sid];
									const r = sc?.range ?? sc?.pos;
									if (r) pick(node.id, [r]);
								}
							}}
							onMoveStart={(e) => {
								if (e) moved.current = true;
							}}
							onPaneClick={() => {
								setPicked(null);
								setPinned(null);
								markEditor(conn, [], false);
							}}
							nodesConnectable={false}
							nodesDraggable={false}
							elementsSelectable={false}
							zoomOnDoubleClick={false}
							minZoom={0.12}
							maxZoom={2}
							proOptions={{ hideAttribution: true }}
						>
							<Background gap={18} size={1} />
							<Controls showInteractive={false} showFitView={false}>
								<ControlButton onClick={fit} title="결과에 맞추기" aria-label="결과에 맞추기">
									<Maximize size={12} />
								</ControlButton>
							</Controls>
						</ReactFlow>
					</UiCtx.Provider>
				) : (
					<div className="panel-hint qm-empty">{state.off ?? (snap ? "그릴 것이 없습니다" : "SQL 편집기에서 쿼리를 치면 결과와 그 결과를 만드는 단계가 여기에 그려집니다")}</div>
				)}
				{snap?.stale && <div className="qm-stale">치는 중 — 마지막으로 읽은 그림 · {snap.error?.replace(/ at Line: \d+, Column: \d+$/, "")}</div>}
			</div>
			{mapWarns.length > 0 && (
				<div className="qm-warns">
					{mapWarns.slice(0, 6).map((f) => (
						<button type="button" key={f.key} className={`qm-warn ${f.level}`} onClick={() => f.pos && markIn(conn, snapRef.current, [f.pos])} title={f.why}>
							{f.level === "warn" ? <AlertTriangle size={12} /> : <Info size={12} />}
							<span>{f.title}</span>
						</button>
					))}
					{mapWarns.length > 6 && <span className="qm-warn-more">외 {mapWarns.length - 6}개</span>}
				</div>
			)}
			<div className="statusbar">
				<span className="qm-legend" title="표 안의 열 — 어디에 쓰였나">
					<i className="r-W">W</i> WHERE <i className="r-J">J</i> 조인 <i className="r-G">G</i> GROUP <i className="r-O">O</i> ORDER <i className="r-S">S</i> SELECT
				</span>
				<span className="qf-hint">결과 열에 올리면 어디서 왔는지 · 단계를 누르면 편집기에서 그 절</span>
				{snap?.note && <span title={snap.note}>{snap.note}</span>}
				{state.busy && <span>맞추는 중…</span>}
				<span style={{ marginLeft: "auto" }} />
				{snap && snap.map.dialect === "generic" && deps.engine !== "cubrid" && deps.engine !== "altibase" && <span title="엔진 방언이 못 읽어 일반 방언으로 읽었습니다">일반 방언</span>}
				<button
					type="button"
					className="btn ghost"
					style={{ height: 20 }}
					onClick={() => setDirPref((d) => (d === "auto" ? (horizontal ? "v" : "h") : d === "h" ? "v" : "auto"))}
					title={`흐름 방향 — ${dirPref === "auto" ? "칸 모양 따라" : dirPref === "h" ? "왼쪽 → 오른쪽" : "위 → 아래"} (누르면 바꾼다)`}
				>
					<ArrowRightLeft size={12} style={horizontal ? undefined : { transform: "rotate(90deg)" }} />
					{dirPref === "auto" ? "자동" : horizontal ? "가로" : "세로"}
				</button>
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={onTuning} title="정적 검사·인덱스 초안·실행 계획 규칙">
					<Stethoscope size={12} /> 튜닝{others ? ` ${others}` : ""}
				</button>
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={refresh} title="다시 읽기">
					<RefreshCw size={12} />
				</button>
			</div>
		</div>
	);
}
