import { Background, ControlButton, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/querymap.css";
import { AlertTriangle, ArrowDown, ArrowDownWideNarrow, ArrowRight, ChevronDown, Combine, CopyMinus, Funnel, GitMerge, Info, ListTree, Maximize, RefreshCw, Sheet, Sigma, SquareFunction, Stethoscope, Table2, WandSparkles } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ColMeta } from "../lib/edits";
import { api } from "../lib/ipc";
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
const RW = 300;
const ROWH = 18;
const RROWH = 22;
const MAX_TROWS = 8;
const MAX_OROWS = 8;
const MAX_RROWS = 14;
const tableH = (rows: number, sub: boolean) => 34 + (sub ? 16 : 0) + Math.max(1, Math.min(rows, MAX_TROWS)) * ROWH + (rows > MAX_TROWS ? 16 : 0) + 8;
const stageH = (code: boolean, sub: boolean) => 36 + (code ? 34 : 0) + (sub ? 18 : 0) + 4;
const outH = (rows: number) => 34 + Math.max(1, Math.min(rows, MAX_OROWS)) * ROWH + (rows > MAX_OROWS ? 16 : 0) + 8;
const resultH = (rows: number, code: boolean) => 64 + (code ? 40 : Math.max(1, Math.min(rows, MAX_RROWS)) * RROWH + (rows > MAX_RROWS ? 18 : 0)) + 10;

const ROLE_ORDER = "SWJGHOUI";
const ROLE_OF: Record<string, string> = { select: "S", where: "W", on: "J", group: "G", having: "H", order: "O", set: "U", insert: "I" };
const ROLE_TIP: Record<string, string> = { S: "SELECT", W: "WHERE", J: "JOIN ON", G: "GROUP BY", H: "HAVING", O: "ORDER BY", U: "SET", I: "INSERT" };
const JOIN_TITLE: Record<string, string> = { inner: "INNER JOIN", left: "LEFT JOIN", right: "RIGHT JOIN", full: "FULL JOIN", cross: "CROSS JOIN", semi: "SEMI JOIN", anti: "ANTI JOIN", apply: "APPLY", asof: "ASOF JOIN", comma: "쉼표 조인" };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const snip = (text: string, p: Pos | undefined | null, max = 140) => (p ? clip(text.slice(p[0], p[1]).replace(/\s+/g, " ").trim(), max) : "");
const isR = (p: Pos | undefined | null): p is R => !!p;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 묶음 머리 — 좁으면 앞뒤 군말(pre·post)부터 줄이고 이름은 끝까지 남긴다, 전체는 툴팁 */
type GLabel = { pre: string | null; name: string; post: string | null; full: string };
function groupLabel(map: QueryMap, sid: number): GLabel {
	const s = map.scopes[sid];
	const g = (pre: string | null, name: string, post: string | null): GLabel => ({ pre, name, post, full: [pre, name, post].filter(Boolean).join(" ") });
	if (s.kind === "cte") return g("WITH", s.name ?? "CTE", "AS (…)");
	if (s.kind === "derived") return g("FROM (서브쿼리)", s.name ?? "", null);
	if (s.kind === "union") return g(null, `갈래 ${map.scopes.filter((x) => x.parent === s.parent && x.kind === "union").findIndex((x) => x.id === sid) + 1}`, null);
	if (s.name === "SELECT") return g(null, "넣을 행(SELECT)", null);
	return s.name ? g(null, s.name, "(서브쿼리)") : g(null, "스칼라 서브쿼리", null);
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
		let expr = snip(text, o.expr ?? o.pos, 90);
		const star = o.star !== undefined;
		const label = o.name ?? (star ? (o.star ? `${o.star}.*` : "*") : expr);
		// 예전 파서 결과(식 위치 없음) — 원문 끝의 별칭을 떼어 낸다
		if (o.name && !o.expr) expr = expr.replace(new RegExp(`\\s+(as\\s+)?["\`[]?${esc(o.name)}["\`\\]]?$`, "i"), "");
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
			let title = "SELECT 결과";
			let code: string | null = null;
			let ranges: Pos[] = [];
			let list = rowsOut;
			const target = one(sid, "target");
			if (map.kind === "select") {
				ranges = branches.length ? branches.flatMap((b) => cl(b.id, "select").map((c) => c.pos)) : cl(sid, "select").map((c) => c.pos);
			} else if (map.kind === "insert") {
				title = snip(text, target, 40) || "INSERT";
				ranges = [target];
				// 넣는 열 ← 넣을 행(SELECT)의 같은 자리 식
				const sel = map.scopes.find((x) => x.parent === sid && x.kind === "subquery" && x.name === "SELECT");
				const from = sel ? outsOf(sel.id) : [];
				list = map.cols.filter((c) => c.scope === sid && c.role === "insert").map((c, k) => ({ k, label: c.name, hint: from[k] ? clip(snip(text, from[k].expr ?? from[k].pos, 90), 64) : null, agg: false, win: false, sub: false, star: false, pos: c.pos }));
				if (!list.length) code = "모든 열에 넣는다";
			} else {
				title = snip(text, target, 40) || map.kind.toUpperCase();
				const set = one(sid, "set");
				ranges = [target, set];
				// UPDATE — SET 한 항목씩(바뀌는 열 ← 값), 예전 파서 결과면 SET 원문
				if (map.kind === "update" && rowsOut.length) list = rowsOut;
				else {
					code = map.kind === "update" ? snip(text, set, 160) : map.kind === "delete" ? (one(sid, "where") ? "조건에 맞는 행을 지운다" : "모든 행을 지운다") : null;
					list = [];
				}
			}
			add({ id: outId, kind: "result", scope: sid, title, code, sub: null, badge: null, ranges: ranges.filter(isR), inputs: prev ? [prev] : [], w: RW, h: resultH(list.length, !!code), rows: list.slice(0, MAX_RROWS), rowsMore: Math.max(0, list.length - MAX_RROWS) });
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

// ── 최종 결과 요약: 이 문장이 끝내 무엇을 내놓나(지도 위 띠 · 결과 노드 머리) ──

/** 띠의 열 칩 하나 — scope·k: 계보를 따라갈 출력 열(INSERT 는 넣을 행 SELECT 의 열) */
type FinalChip = { k: number; name: string; src: string; kind: "col" | "agg" | "win" | "sub" | "case" | "lit" | "expr" | "star" | "cond"; type?: string; pos: Pos; scope: number; trace: boolean };
type FinalPart = { text: string; tone?: "warn" | "key"; tip?: string };
type Final = { verb: string; parts: FinalPart[]; chips: FinalChip[]; ranges: R[]; short: string };

const PLAIN_COL = /^[^\s(),'+\-*/|<>=!]+$/;
const LITERAL = /^(N?'(?:[^']|'')*'|-?\d+(?:\.\d+)?|null|true|false)$/i;
const CHIP_KIND_TIP: Record<FinalChip["kind"], string> = { col: "열 그대로", agg: "집계", win: "창 함수", sub: "스칼라 서브쿼리", case: "CASE 식", lit: "상수", expr: "식", star: "모든 열", cond: "조건" };

function summarize(snap: Snapshot): Final {
	const { map, resolved } = snap;
	const text = snap.stmt.text;
	const meta = resolved?.meta ?? map.tables.map(() => undefined);
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const clauses = map.clauses ?? [];
	const outs = map.outs ?? [];
	const main = map.scopes.find((s) => s.kind === "main");
	const empty: Final = { verb: map.kind.toUpperCase(), parts: [], chips: [], ranges: [], short: "" };
	if (!main) return empty;
	const sid = main.id;
	const one = (s: number, k: string) => clauses.find((c) => c.scope === s && c.kind === k && c.pos)?.pos ?? null;
	const branchesOf = (s: number) => map.scopes.filter((x) => x.parent === s && x.kind === "union");
	const outsOf = (s: number): MapOut[] => {
		const own = outs.filter((o) => o.scope === s);
		if (own.length) return own;
		const b = branchesOf(s)[0];
		return b ? outsOf(b.id) : [];
	};
	const exprOf = (o: MapOut) => {
		let e = snip(text, o.expr ?? o.pos, 400);
		if (o.name && !o.expr) e = e.replace(new RegExp(`\\s+(as\\s+)?["\`[]?${esc(o.name)}["\`\\]]?$`, "i"), "");
		return e;
	};
	const colType = (tid: number | null | undefined, name: string) => (tid === null || tid === undefined ? undefined : meta[tid]?.cols?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.dataType);
	/** 열 그대로 내놓는 항목의 형식 — 서브쿼리·CTE 를 거슬러 원본 표까지 */
	const typeOf = (o: MapOut, depth = 0): string | undefined => {
		if (depth > 6 || o.star !== undefined || o.agg || o.win || o.subs?.length || !PLAIN_COL.test(exprOf(o))) return undefined;
		const own: number[] = [];
		for (let c = o.cols[0]; c < o.cols[1]; c++) if (map.cols[c]?.scope === o.scope) own.push(c);
		if (own.length !== 1) return undefined;
		const c = map.cols[own[0]];
		const tid = colTable[c.id];
		if (tid === null || tid === undefined) return undefined;
		const m = meta[tid];
		if (m?.cols) return colType(tid, c.name);
		const t = map.tables[tid];
		const inner = t.derived ?? t.cte;
		if (inner === null || inner === undefined) return undefined;
		const io = outsOf(inner).find((x) => x.name?.toLowerCase() === c.name.toLowerCase());
		return io ? typeOf(io, depth + 1) : undefined;
	};
	/** 칩 하나 — 이름(별칭)·출처·형식 */
	const chipOf = (o: MapOut, k: number, scope: number, name?: string): FinalChip => {
		const e = exprOf(o);
		const star = o.star !== undefined;
		let kind: FinalChip["kind"] = "expr";
		let src = clip(e, 34);
		if (star) {
			kind = "star";
			src = "모든 열";
		} else if (o.subs?.length && e.startsWith("(")) {
			kind = "sub";
			src = "서브쿼리";
		} else if (/^case\b/i.test(e)) {
			kind = "case";
			src = "CASE…";
		} else if (o.win) {
			kind = "win";
			src = clip(e.replace(/\s+over\s*\(.*$/is, " OVER…"), 34);
		} else if (o.agg) kind = "agg";
		else if (LITERAL.test(e)) {
			kind = "lit";
			src = `상수 ${clip(e, 24)}`;
		} else if (PLAIN_COL.test(e)) {
			kind = "col";
			// 한정 없이 쓴 열은 어느 표인지 붙여 준다
			if (!e.includes(".")) {
				const c = map.cols.slice(o.cols[0], o.cols[1]).find((x) => x.scope === o.scope);
				const tid = c ? colTable[c.id] : null;
				const t = tid !== null && tid !== undefined ? map.tables[tid] : null;
				if (t) src = `${t.alias ?? t.name}.${e}`;
			}
		}
		const label = name ?? o.name ?? (star ? (o.star ? `${o.star}.*` : "*") : clip(e, 28));
		// 이름이 곧 출처면(별칭 없는 식) 출처 칸은 비운다
		if (!o.name && !name && !star && kind !== "col") src = "";
		return { k, name: label, src, kind, type: typeOf(o), pos: o.pos, scope, trace: true };
	};
	const target = map.tables.find((t) => t.target && t.scope === sid);
	const targetName = target ? `${target.schema ? `${target.schema}.` : ""}${target.name}` : "";
	const where = one(sid, "where");

	if (map.kind === "select") {
		const list = outsOf(sid);
		const chips = list.map((o, k) => chipOf(o, k, sid));
		const parts: FinalPart[] = [{ text: `열 ${list.length}개`, tone: "key" }];
		const branches = branchesOf(sid);
		const group = one(sid, "group");
		const having = one(sid, "having");
		const dis = one(sid, "distinct");
		const own = outs.filter((o) => o.scope === sid);
		if (branches.length) {
			const ops = clauses.filter((c) => c.scope === sid && c.kind === "setop" && c.pos).map((c) => snip(text, c.pos, 30).toUpperCase());
			const dedupe = ops.some((n) => !/\bALL\b/.test(n));
			const op = [...new Set(ops)].join("·") || "UNION";
			parts.push({ text: `갈래 ${branches.length}개를 ${dedupe ? "합쳐 같은 행은 하나로" : "그대로 이어 붙임"}`, tip: op });
		} else if (group) parts.push({ text: `묶음마다 1행 · ${clip(snip(text, group).replace(/^group\s+by\s+/i, ""), 40)}`, tip: snip(text, group, 400) });
		else if (own.some((o) => o.agg && !o.win)) parts.push({ text: having ? "0~1행(전체 집계 · HAVING)" : "1행(전체 집계)" });
		else if (!dis) {
			const tabs = map.tables.filter((t) => t.scope === sid);
			parts.push({ text: !tabs.length ? "1행" : map.joins.some((j) => j.scope === sid && j.kind !== "where") ? "조인한 행마다 1행" : `${tabs[0].name} 행마다 1행` });
		}
		if (dis) {
			const d = snip(text, dis);
			const on = /\bon\b/i.test(d) ? d.replace(/^distinct\s+on\s*/i, "").replace(/^\(|\)$/g, "") : null;
			parts.push({ text: on ? `${clip(on, 30)} 마다 1행(DISTINCT ON)` : "같은 행은 하나만(DISTINCT)" });
		}
		const order = one(sid, "order");
		if (order) parts.push({ text: `정렬 ${clip(snip(text, order).replace(/^order\s+by\s+/i, ""), 30)}`, tip: snip(text, order, 400) });
		const limit = one(sid, "limit");
		if (main.limit !== undefined) parts.push({ text: `최대 ${main.limit.toLocaleString()}행`, tone: "key", tip: snip(text, limit) });
		else if (limit) parts.push({ text: clip(snip(text, limit), 28) });
		if (main.offset !== undefined && main.offset > 0) parts.push({ text: `앞 ${main.offset.toLocaleString()}행 건너뜀` });
		const ranges = (branches.length ? branches.map((b) => one(b.id, "select")) : [one(sid, "select")]).filter(isR);
		const short = parts.map((p) => p.text).join(" · ");
		return { verb: "SELECT", parts, chips, ranges, short };
	}
	if (map.kind === "update") {
		const sets = outs.filter((o) => o.scope === sid);
		const chips = sets.map((o, k) => ({ ...chipOf(o, k, sid, o.name), type: colType(target?.id, o.name ?? "") }));
		const nSet = sets.length || map.cols.filter((c) => c.scope === sid && c.role === "set").length;
		const parts: FinalPart[] = [{ text: `대상 표 ${targetName || "?"}`, tone: "key" }, { text: `바꾸는 열 ${nSet}개` }, where ? { text: "WHERE 조건에 맞는 행만" } : { text: "WHERE 없음 — 모든 행을 바꾼다", tone: "warn" }];
		return { verb: "UPDATE", parts, chips, ranges: [one(sid, "target"), one(sid, "set")].filter(isR), short: parts.map((p) => p.text).join(" · ") };
	}
	if (map.kind === "delete") {
		const parts: FinalPart[] = [{ text: `대상 표 ${targetName || "?"}`, tone: "key" }, { text: "행을 지운다" }, where ? { text: "WHERE 조건에 맞는 행만" } : { text: "WHERE 없음 — 모든 행을 지운다", tone: "warn" }];
		const chips: FinalChip[] = where ? [{ k: 0, name: "WHERE", src: clip(snip(text, where, 200).replace(/^where\s+/i, ""), 60), kind: "cond", pos: where, scope: sid, trace: false }] : [];
		return { verb: "DELETE", parts, chips, ranges: [one(sid, "target"), where].filter(isR), short: parts.map((p) => p.text).join(" · ") };
	}
	if (map.kind === "insert") {
		const sel = map.scopes.find((s) => s.parent === sid && s.kind === "subquery" && s.name === "SELECT");
		const src = sel ? outsOf(sel.id) : [];
		const cols = map.cols.filter((c) => c.scope === sid && c.role === "insert");
		const chips: FinalChip[] = cols.map((c, k) => {
			const o = src[k];
			const from = o ? chipOf(o, k, sel?.id ?? sid) : null;
			return { k, name: c.name, src: from ? from.src || from.name : "", kind: from?.kind ?? "col", type: colType(target?.id, c.name) ?? from?.type, pos: c.pos, scope: sel?.id ?? sid, trace: !!from };
		});
		const parts: FinalPart[] = [{ text: `대상 표 ${targetName || "?"}`, tone: "key" }, { text: cols.length ? `넣는 열 ${cols.length}개` : "모든 열에 넣는다" }, { text: sel ? "SELECT 결과 행마다 1행" : "VALUES 의 행" }];
		return { verb: "INSERT", parts, chips, ranges: [one(sid, "target")].filter(isR), short: parts.map((p) => p.text).join(" · ") };
	}
	return { ...empty, parts: [{ text: "이 문장은 구조를 그리지 않습니다" }] };
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

/** 강조 — dir: back 이면 결과 열이 어디서 왔나, fwd 면 열 하나가 어디로 가나 · labels: 선 위 쓰임 표지 */
type Lit = { nodes: Set<string>; edges: Set<string>; cols: Set<string>; labels: Map<string, Set<string>>; dir: "back" | "fwd" };
/** 무엇을 따라가나 — back: 결과·출력 열 k 의 출처, col: 표(또는 표 노릇 하는 묶음) 열의 쓰임, out: 안쪽 묶음 출력 열 k 의 쓰임 */
type Focus = { dir: "back"; scope: number; k: number } | { dir: "col"; node: string; tid: number; name: string } | { dir: "out"; scope: number; k: number };
const focusKey = (f: Focus) => (f.dir === "col" ? `c:${f.node}:${f.name.toLowerCase()}` : `${f.dir}:${f.scope}:${f.k}`);
const sameFocus = (a: Focus | null, b: Focus) => !!a && focusKey(a) === focusKey(b);

function lineage(flow: Flow, snap: Snapshot, sid: number, k: number): Lit {
	const { map, resolved } = snap;
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const outs = map.outs ?? [];
	const L: Lit = { nodes: new Set(), edges: new Set(), cols: new Set(), labels: new Map(), dir: "back" };
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

/** 열이 쓰인 절 → 선 위 표지 */
const USE_OF_ROLE: Record<string, string> = { on: "조인", where: "조건", having: "조건", group: "묶음", order: "정렬", select: "출력", set: "출력", insert: "출력" };
const USE_OF_KIND: Partial<Record<Kind, string>> = { join: "조인", where: "조건", group: "묶음", order: "정렬", distinct: "출력", window: "출력", out: "출력", result: "출력" };

/** 정방향 계보 — 열 하나(원본 표 열 · 안쪽 묶음 출력 열)를 쓰는 모든 곳(조인·조건·묶음·정렬·상관 서브쿼리·출력)을 따라 최종 결과까지 */
function forward(flow: Flow, snap: Snapshot, start: Exclude<Focus, { dir: "back" }>): Lit {
	const { map, resolved } = snap;
	const text = snap.stmt.text;
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const outs = map.outs ?? [];
	const L: Lit = { nodes: new Set(), edges: new Set(), cols: new Set(), labels: new Map(), dir: "fwd" };
	const tag = (edge: string, label: string) => {
		L.edges.add(edge);
		const s = L.labels.get(edge) ?? new Set<string>();
		s.add(label);
		L.labels.set(edge, s);
	};
	/** from 에서 흐름(부모)을 따라 to 까지 — 마지막 선에 표지. 닿지 못하면 두 노드만 켠다 */
	const path = (from: string, to: string, label: string | null) => {
		L.nodes.add(from);
		L.nodes.add(to);
		if (from === to) return;
		const es: string[] = [];
		let n = from;
		for (let i = 0; i < 400 && n !== to; i++) {
			const p = flow.parent.get(n);
			if (!p) return;
			es.push(`${n}->${p}`);
			n = p;
		}
		if (n !== to) return;
		for (const e of es) {
			L.edges.add(e);
			L.nodes.add(e.slice(e.indexOf("->") + 2));
		}
		if (label && es.length) tag(es[es.length - 1], label);
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
	const outsOf = (s: number): MapOut[] => {
		const o = own(s);
		if (o.length) return o;
		const b = map.scopes.find((x) => x.parent === s && x.kind === "union");
		return b ? outsOf(b.id) : [];
	};
	/** 출력 항목의 이름 — 별칭, 없으면 열 그대로 쓴 식의 열 이름 */
	const outName = (o: MapOut | undefined): string | null => {
		if (!o) return null;
		if (o.name) return o.name;
		const e = snip(text, o.expr ?? o.pos, 200);
		return PLAIN_COL.test(e) ? e.slice(e.lastIndexOf(".") + 1).replace(/["`[\]]/g, "") : null;
	};
	/** 묶음 안에서 위치를 품은 가장 작은 단계(표 제외) */
	const useNode = (scope: number, at: Pos): string | null => {
		if (!at) return null;
		let best: string | null = null;
		let bestLen = Number.POSITIVE_INFINITY;
		for (const n of flow.nodes.values()) {
			if (n.scope !== scope || n.kind === "table") continue;
			for (const [a, b] of n.ranges)
				if (at[0] >= a && at[0] <= b && b - a < bestLen) {
					best = n.id;
					bestLen = b - a;
				}
		}
		return best;
	};
	const seenCol = new Set<string>();
	const seenOut = new Set<string>();

	/** 서브쿼리(IN · EXISTS · 스칼라)의 결과가 바깥으로 — 출력 항목이면 그 열로 이어 가고, 조건이면 그 단계에서 멈춘다 */
	const fromSub = (x: number, depth: number) => {
		const so = flow.scopeOut.get(x);
		const sc = map.scopes[x];
		if (!so || !sc || sc.parent === null) return;
		L.nodes.add(so);
		if (sc.kind !== "subquery") return;
		const P = sc.parent;
		const hits = own(P)
			.map((o, k) => ({ o, k }))
			.filter(({ o }) => o.subs?.includes(x));
		if (hits.length) {
			const po = flow.scopeOut.get(P);
			for (const { k } of hits) {
				if (po) path(so, po, "출력");
				toOut(P, k, depth + 1);
			}
			return;
		}
		const host = flow.parent.get(so);
		const hn = host ? flow.nodes.get(host) : undefined;
		if (host && hn) {
			L.nodes.add(host);
			tag(`${so}->${host}`, USE_OF_KIND[hn.kind] ?? "조건");
		}
	};

	/** 열 하나를 쓰는 곳 — home: 그 표가 놓인 묶음, node: 그 표의 노드 */
	const useOf = (c: (typeof map.cols)[number], home: number, node: string, depth: number) => {
		if (c.scope === home) {
			// 출력 항목에 들었으면 그 출력 열로 이어 간다
			const list = own(home);
			const k = list.findIndex((o) => c.id >= o.cols[0] && c.id < o.cols[1]);
			const so = flow.scopeOut.get(home);
			if (k >= 0 && so) {
				path(node, so, "출력");
				toOut(home, k, depth + 1);
				return;
			}
			const u = useNode(home, c.pos) ?? so;
			if (u) path(node, u, USE_OF_ROLE[c.role] ?? "조건");
			return;
		}
		// 안쪽 서브쿼리에서 바깥 표를 부른다(상관) — 바로 아래 묶음을 찾는다
		const chain: number[] = [];
		let s: number | null = c.scope;
		while (s !== null && s !== home) {
			chain.push(s);
			s = map.scopes[s]?.parent ?? null;
		}
		if (s !== home || !chain.length) return;
		const x = chain[chain.length - 1];
		const xo = flow.scopeOut.get(x);
		for (const cs of chain) {
			const to = flow.scopeOut.get(cs);
			const e = flow.cross.find((cr) => cr.kind === "corr" && cr.from === node && cr.to === to);
			if (e && to) {
				tag(`${node}->${to}`, "상관");
				L.nodes.add(to);
			}
		}
		L.nodes.add(node);
		const u = useNode(c.scope, c.pos) ?? flow.scopeOut.get(c.scope);
		if (u && xo) path(u, xo, null);
		fromSub(x, depth + 1);
	};

	/** 표(또는 표 노릇 하는 묶음 출력)의 열 name — 그 열을 쓰는 모든 곳 */
	const fromCol = (tid: number, name: string, node: string, depth: number) => {
		const key = `${tid}:${name.toLowerCase()}`;
		if (seenCol.has(key) || depth > 14) return;
		seenCol.add(key);
		const t = map.tables[tid];
		if (!t) return;
		const nm = name.toLowerCase();
		L.nodes.add(node);
		L.cols.add(`${node}:${nm}`);
		for (const c of map.cols) if (colTable[c.id] === tid && c.name.toLowerCase() === nm) useOf(c, t.scope, node, depth);
		// * · t.* 로 그대로 내보내는 곳
		const so = flow.scopeOut.get(t.scope);
		own(t.scope).forEach((o, k) => {
			if (o.star === undefined || !so) return;
			if (o.star && o.star.toLowerCase() !== (t.alias ?? t.name).toLowerCase() && o.star.toLowerCase() !== t.name.toLowerCase()) return;
			path(node, so, "출력");
			toOut(t.scope, k, depth + 1, name);
		});
	};

	/** 묶음 s 의 출력 열 k — 바깥에서 그 열을 쓰는 곳으로(nm: * 로 나온 열의 이름) */
	const toOut = (s: number, k: number, depth: number, nm?: string) => {
		const key = `${s}:${k}:${nm ?? ""}`;
		if (seenOut.has(key) || depth > 14) return;
		seenOut.add(key);
		const so = flow.scopeOut.get(s);
		const sc = map.scopes[s];
		if (!so || !sc) return;
		L.nodes.add(so);
		if (so === "result") L.cols.add(`row:${s}:${k}`);
		else if (!nm) L.cols.add(`${so}:#${k}`);
		if (sc.kind === "main" || sc.parent === null) return;
		const P = sc.parent;
		const po = flow.scopeOut.get(P);
		if (sc.kind === "union") {
			if (po) path(so, po, null);
			toOut(P, k, depth + 1, nm);
			return;
		}
		if (sc.kind === "subquery") {
			// INSERT … SELECT — 넣을 행의 k 번째 열이 넣는 열 k 로
			if (sc.name === "SELECT" && map.scopes[P]?.kind === "main") {
				if (po) path(so, po, "출력");
				L.cols.add(`row:${P}:${k}`);
				L.cols.add(`row:${s}:${k}`);
				return;
			}
			fromSub(s, depth);
			return;
		}
		// FROM (서브쿼리) · CTE — 바깥에서 그 이름으로 쓰는 곳
		const name = nm ?? outName(outsOf(s)[k]);
		if (!name) return;
		for (const t of map.tables) {
			if (!(t.derived === s || (t.cte === s && !within(s, t.scope)))) continue;
			const tn = flow.tableNode.get(t.id);
			if (!tn) continue;
			if (tn !== so) {
				L.edges.add(`${so}->${tn}`);
				L.nodes.add(tn);
			}
			fromCol(t.id, name, tn, depth + 1);
		}
	};

	if (start.dir === "col") fromCol(start.tid, start.name, start.node, 0);
	else toOut(start.scope, start.k, 0);
	return L;
}

// ── 그리기 ─────────────────────────────────────────────────

type Ui = {
	lit: Lit | null;
	cursor: string | null;
	picked: string | null;
	horizontal: boolean;
	hover: (f: Focus | null) => void;
	pickRow: (n: FNode, row: OutRow) => void;
	pickCol: (n: FNode, c: ColRow) => void;
};
const UiCtx = createContext<Ui>({ lit: null, cursor: null, picked: null, horizontal: true, hover: () => {}, pickRow: () => {}, pickCol: () => {} });
type ND = { n: FNode };
type GD = { label: GLabel; kind: string; sid: number };

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
								onMouseEnter={() => n.table !== undefined && ui.hover({ dir: "col", node: n.id, tid: n.table, name: c.name })}
								onMouseLeave={() => ui.hover(null)}
								onClick={(e) => {
									e.stopPropagation();
									ui.pickCol(n, c);
								}}
								title={`${c.name}${c.type ? ` · ${c.type}` : ""}${c.pk ? " · PK" : ""}${c.fk ? " · FK" : ""}${c.missing ? " · 표에 없는 열" : ""} — ${[...c.roles].map((r) => ROLE_TIP[r]).join(", ")}\n올리면 이 열이 어디로 가는지, 누르면 고정하고 편집기에서 그 열`}
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
						onMouseEnter={() => ui.hover({ dir: big ? "back" : "out", scope: n.scope, k: r.k })}
						onMouseLeave={() => ui.hover(null)}
						onClick={(e) => {
							e.stopPropagation();
							ui.pickRow(n, r);
						}}
						title={`${r.label}${r.hint ? ` ← ${r.hint}` : ""} — ${big ? "올리면 어디서 왔는지" : "올리면 이 열이 어디로 가는지"}, 누르면 고정하고 편집기에서 그 항목`}
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
					<Sheet size={17} />
				</span>
				<div>
					<span className="qf-final-tag">최종 결과</span>
					<b title={n.title}>{n.title}</b>
					<small title={n.sub ?? undefined}>{n.sub ?? "이 문장이 내놓는 것"}</small>
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
	const { lit } = useContext(UiCtx);
	const { pre, name, post, full } = data.label;
	return (
		<div className={`qf-group k-${data.kind}${lit && !lit.nodes.has(`o${data.sid}`) ? " dim" : ""}`}>
			<div className="qf-group-head" title={full}>
				{pre && <span className="qg-aux">{pre}</span>}
				{name && <b className="qg-name">{name}</b>}
				{post && <span className="qg-aux">{post}</span>}
			</div>
		</div>
	);
});

const nodeTypes = { qtable: TableNode, qstage: StageNode, qout: OutNode, qresult: ResultNode, qgroup: GroupNode };
const TYPE_OF: Record<Kind, keyof typeof nodeTypes> = { table: "qtable", join: "qstage", where: "qstage", group: "qstage", window: "qstage", distinct: "qstage", order: "qstage", union: "qstage", out: "qout", result: "qresult" };

type Drawn = { flow: Flow; nodes: Node[]; edges: Edge[]; bounds: Laid["bounds"]; result: { x: number; y: number; w: number; h: number } | null; key: string };

/** 그래프와 두 방향 배치 — 방향은 칸 모양에 더 크게 들어가는 쪽을 고른다 */
type Prepared = { flow: Flow; map: QueryMap; h: Laid; v: Laid; final: Final };
function prepare(snap: Snapshot, findings: Finding[]): Prepared {
	const flow = buildFlow(snap, findings);
	const final = summarize(snap);
	const r = flow.nodes.get("result");
	if (r) r.sub = final.short || null;
	return { flow, map: snap.map, h: layout(flow, true), v: layout(flow, false), final };
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
/** 흐름 방향 — 자동은 칸 모양에 더 크게 들어가는 쪽 */
type Dir = "auto" | "h" | "v";
const DIR_KEY = "querymap.dir";
const DIRS: [Dir, typeof Table2, string, string][] = [
	["auto", WandSparkles, "자동", "흐름 방향 자동(칸 모양 따라)"],
	["v", ArrowDown, "위→아래", "흐름 방향 위 → 아래(결과가 아래)"],
	["h", ArrowRight, "왼→오른", "흐름 방향 왼쪽 → 오른쪽(결과가 오른쪽)"],
];

/** 강조한 선 끝의 화살표 — 색은 칸의 --qf-lit(역방향 주황 · 정방향 파랑)를 따른다 */
const LIT_ARROW = { type: MarkerType.ArrowClosed, color: "var(--qf-lit)", width: 11, height: 11 } as const;

/** 접었을 때 보이는 칩 줄 수 */
const BAND_ROWS = 2;

/** 지도 위 고정 띠 — 확대·이동과 상관없이 "이 문장이 끝내 무엇을 내놓나" */
const ResultBand = memo(function ResultBand({
	final,
	lit,
	pinned,
	onTitle,
	onHover,
	onPick,
}: {
	final: Final;
	lit: Lit | null;
	pinned: { scope: number; k: number } | null;
	onTitle: () => void;
	onHover: (c: FinalChip | null) => void;
	onPick: (c: FinalChip) => void;
}) {
	const [open, setOpen] = useState(false);
	const [hidden, setHidden] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	// 접은 상태에서 몇 개가 넘치나 — 칩 위치로 센다(칸 폭이 바뀌면 다시)
	useLayoutEffect(() => {
		const el = list.current;
		if (!el) return;
		const count = () => {
			if (open) return;
			// 접힌 목록은 늘 처음부터(가려진 칩으로 초점이 가며 밀린 스크롤을 되돌린다)
			el.scrollTop = 0;
			const kids = el.querySelectorAll<HTMLElement>(".qm-chip");
			if (!kids.length) return setHidden(0);
			const top = kids[0].offsetTop;
			const row = kids[0].offsetHeight + 4;
			let n = 0;
			for (const k of kids) if (k.offsetTop - top >= row * BAND_ROWS - 2) n++;
			setHidden(n);
		};
		count();
		const ro = new ResizeObserver(count);
		ro.observe(el);
		return () => ro.disconnect();
	}, [final, open]);
	const warn = final.parts.some((p) => p.tone === "warn");
	return (
		<div className={`qm-final${warn ? " warn" : ""}`}>
			<div className="qm-final-line">
				<button type="button" className="qm-final-title" onClick={onTitle} title="결과 노드로 가서 편집기의 출력 목록을 강조">
					<Sheet size={13} />
					<b>최종 결과</b>
					{final.verb !== "SELECT" && <span className="qm-final-verb">{final.verb}</span>}
				</button>
				<span className="qm-final-parts" title={final.short}>
					{final.parts.map((p) => (
						<span key={p.text} className={`qm-fp${p.tone ? ` ${p.tone}` : ""}`} title={p.tip}>
							{p.tone === "warn" && <AlertTriangle size={11} />}
							{p.text}
						</span>
					))}
				</span>
				{(open || hidden > 0) && (
					<button type="button" className="qm-final-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
						{open ? "접기" : `열 ${hidden}개 더`}
						<ChevronDown size={11} style={open ? { transform: "rotate(180deg)" } : undefined} />
					</button>
				)}
			</div>
			{final.chips.length > 0 && (
				<div
					className={`qm-chips${open ? " open" : ""}`}
					ref={list}
					// 접힌 동안은 밀리지 않게(가려진 칩은 "열 N개 더" 로 연다)
					onScroll={(e) => {
						if (!open) e.currentTarget.scrollTop = 0;
					}}
					onFocus={(e) => {
						// 키보드로 가려진 칩에 오면 펼친다
						const t = e.target as HTMLElement;
						const first = list.current?.firstElementChild as HTMLElement | null;
						if (!open && first && t.offsetTop - first.offsetTop >= (first.offsetHeight + 4) * BAND_ROWS - 2) setOpen(true);
					}}
				>
					{final.chips.map((c) => {
						const on = pinned?.scope === c.scope && pinned.k === c.k;
						const hot = c.trace && lit?.cols.has(`row:${c.scope}:${c.k}`);
						return (
							<button
								type="button"
								key={`${c.scope}:${c.k}`}
								className={`qm-chip k-${c.kind}${on ? " on" : ""}${hot ? " lit" : ""}`}
								onMouseEnter={() => c.trace && onHover(c)}
								onMouseLeave={() => c.trace && onHover(null)}
								onClick={() => onPick(c)}
								title={`${c.name}${c.src ? ` ← ${c.src}` : ""}${c.type ? ` · ${c.type}` : ""} (${CHIP_KIND_TIP[c.kind]})${c.trace ? " — 올리면 어디서 왔는지, 누르면 고정하고 편집기에서 그 항목" : " — 누르면 편집기에서"}`}
							>
								<b>{c.name}</b>
								{c.src && <span className="qm-chip-src">{c.src}</span>}
								{c.type && <i>{c.type}</i>}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
});

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
	const [dirPref, setDirPref] = useState<Dir>("auto");
	// 고른 방향은 기억한다(기본 자동)
	useEffect(() => {
		let live = true;
		void api
			.settingGet(DIR_KEY)
			.then((v) => {
				if (live && (v === "auto" || v === "h" || v === "v")) setDirPref(v);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 구조·글이 바뀔 때만 다시 만든다
	const prep = useMemo(() => (snap ? prepare(snap, mapWarnsOf(snap)) : null), [snap?.shape, snap?.stmt.text, snap?.findings.length]);
	// 자동 — 칸에 더 크게 들어가는 방향(비슷하면 가로)
	const horizontal = dirPref !== "auto" ? dirPref === "h" : !prep || !size.w || !size.h || fitZoom(prep.h.bounds, size.w, size.h) >= fitZoom(prep.v.bounds, size.w, size.h) * 0.92;
	const mapWarns = useMemo(() => (snap ? mapWarnsOf(snap) : []), [snap]);
	const drawn = useMemo(() => (prep ? draw(prep, horizontal) : null), [prep, horizontal]);
	const drawnRef = useRef(drawn);
	drawnRef.current = drawn;

	const [hover, setHover] = useState<Focus | null>(null);
	const [pinned, setPinned] = useState<Focus | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const focus = hover ?? pinned;
	const lit = useMemo(() => {
		if (!focus || !drawn || !snap) return null;
		if (focus.dir !== "back") return forward(drawn.flow, snap, focus);
		const L = lineage(drawn.flow, snap, focus.scope, focus.k);
		L.cols.add(`row:${focus.scope}:${focus.k}`);
		return L;
	}, [focus, drawn, snap]);
	/** 띠 칩의 고정 표시 — 결과 열(역방향)을 고정했을 때만 */
	const pinnedBack = pinned?.dir === "back" ? pinned : null;

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
		// 이 배율까지 줄여 다 들어가면 전체를 가운데에(작은 그래프가 세로로 길 때도 통째로),
		// 더 크면 결과 쪽을 읽을 만한 배율(MINZ)로
		const FITZ = 0.45;
		const MINZ = 0.6;
		if (z >= FITZ || !d.result) {
			const zz = Math.max(0.12, z);
			void inst.setViewport({ zoom: zz, x: (W - b.w * zz) / 2 - b.x * zz, y: (H - b.h * zz) / 2 - b.y * zz });
			return;
		}
		const r = d.result;
		const hz = d.key.startsWith("h");
		// 결과 노드는 반드시 통째로 — 칸이 아주 작으면 그만큼 더 줄인다
		const zr = Math.max(0.12, Math.min(MINZ, (W - pad * 2) / Math.max(1, r.w), (H - pad * 2) / Math.max(1, r.h)));
		// 축마다 따로: 그 축으로 그래프가 다 들어가면 가운데, 안 들어갈 때만 결과 쪽을 붙잡되
		// 그래프 바깥 빈 곳이 칸 안으로 들어오지 않게(세로 흐름에서 위가 크게 비던 것)
		const axis = (V: number, c0: number, len: number, want: number) => {
			if (len * zr <= V - pad * 2) return (V - len * zr) / 2 - c0 * zr;
			return Math.min(pad - c0 * zr, Math.max(V - pad - (c0 + len) * zr, want));
		};
		// 가로 흐름이면 결과를 오른쪽 끝 안쪽에, 세로면 아래쪽 안쪽에 — 다른 축은 결과 가운데
		const x = axis(W, b.x, b.w, hz ? W - pad - (r.x + r.w) * zr : W / 2 - (r.x + r.w / 2) * zr);
		const y = axis(H, b.y, b.h, hz ? H / 2 - (r.y + r.h / 2) * zr : H - pad - (r.y + r.h) * zr);
		void inst.setViewport({ zoom: zr, x, y });
	}, []);

	/** 방향 고르기 — 기억하고, 같은 방향으로 풀려도 화면은 다시 맞춘다 */
	const chooseDir = useCallback(
		(d: Dir) => {
			setDirPref(d);
			void api.settingSet(DIR_KEY, d).catch(() => {});
			moved.current = false;
			requestAnimationFrame(() => requestAnimationFrame(fit));
		},
		[fit],
	);

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
	// 다른 문장으로 옮겨 가도(같은 모양이어도) 다시 맞춘다
	const fitKey = drawn ? `${drawn.key}|${snap?.stmt.from ?? 0}` : "";
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
			hover: setHover,
			pickRow: (n, row) => {
				// 결과 열은 어디서 왔나(역방향), 안쪽 묶음 출력 열은 어디로 가나(정방향)
				const f: Focus = { dir: n.kind === "result" ? "back" : "out", scope: n.scope, k: row.k };
				setPinned((p) => (sameFocus(p, f) ? null : f));
				pick(`${n.id}#${row.k}`, row.pos ? [row.pos] : n.ranges);
			},
			pickCol: (n, c) => {
				const s = snapRef.current;
				if (!s) return;
				const tid = n.table;
				if (tid !== undefined) {
					const f: Focus = { dir: "col", node: n.id, tid, name: c.name };
					setPinned((p) => (sameFocus(p, f) ? null : f));
				}
				const colTable = s.resolved?.colTable ?? s.map.cols.map((x) => x.table);
				const ranges = s.map.cols.filter((x) => colTable[x.id] === tid && x.name.toLowerCase() === c.name.toLowerCase()).map((x) => x.pos).filter(isR);
				pick(`${n.id}:${c.name}`, ranges.length ? ranges : n.ranges);
			},
		}),
		[lit, cursor, picked, horizontal, pick],
	);

	// 띠 — 칩에 올리면 계보, 누르면 고정 + 편집기에서 그 항목, 제목은 결과 노드로
	const bandHover = useCallback((c: FinalChip | null) => setHover(c ? { dir: "back", scope: c.scope, k: c.k } : null), []);
	const bandPick = useCallback(
		(c: FinalChip) => {
			const f: Focus = { dir: "back", scope: c.scope, k: c.k };
			if (c.trace) setPinned((p) => (sameFocus(p, f) ? null : f));
			pick(`final#${c.scope}:${c.k}`, c.pos ? [c.pos] : []);
		},
		[pick],
	);
	const bandTitle = useCallback(() => {
		const d = drawnRef.current;
		const inst = rf.current;
		const final = prep?.final;
		if (d?.result && inst) {
			const r = d.result;
			const el = host.current;
			// 지금 배율이 너무 작거나 크면 결과가 칸에 들어가게
			const fitZ = el ? Math.min((el.clientWidth - 40) / r.w, (el.clientHeight - 40) / r.h) : 1;
			const zoom = Math.max(0.12, Math.min(fitZ, Math.max(inst.getZoom(), 0.85), 1.2));
			void inst.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom, duration: 260 });
		}
		if (final?.ranges.length) {
			setPicked("result");
			markIn(conn, snapRef.current, final.ranges);
		}
	}, [prep, conn]);

	const edges = useMemo(() => {
		if (!drawn) return [];
		if (!lit) return drawn.edges;
		// 흐르는 선만 진하게 + 끝에 화살표(흐름 방향 = 결과 쪽), 정방향이면 선 위에 쓰임 표지
		return drawn.edges.map((e): Edge => {
			if (!lit.edges.has(e.id)) return { ...e, className: `${e.className} dim` };
			const tags = lit.labels.get(e.id);
			return {
				...e,
				className: `${e.className} lit${tags ? " tagged" : ""}`,
				label: tags ? [...tags].join(" · ") : e.label,
				labelBgPadding: [5, 2],
				labelBgBorderRadius: 5,
				markerEnd: LIT_ARROW,
				zIndex: 1,
			};
		});
	}, [drawn, lit]);

	const others = (snap?.findings ?? []).filter((f) => f.layer !== "map").length;
	return (
		<div className={`panel-fill qmap-panel${lit ? ` lit-${lit.dir}` : ""}`}>
			{snap && prep && drawn && drawn.nodes.length > 0 && <ResultBand final={prep.final} lit={lit} pinned={pinnedBack} onTitle={bandTitle} onHover={bandHover} onPick={bandPick} />}
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
				<span className="qf-hint">결과 열에 올리면 어디서 왔는지 · 표 열에 올리면 어디로 가는지 · 누르면 고정</span>
				{snap?.note && <span title={snap.note}>{snap.note}</span>}
				{state.busy && <span>맞추는 중…</span>}
				<span style={{ marginLeft: "auto" }} />
				{snap && snap.map.dialect === "generic" && deps.engine !== "cubrid" && deps.engine !== "altibase" && <span title="엔진 방언이 못 읽어 일반 방언으로 읽었습니다">일반 방언</span>}
				<div className="seg tiny qm-dir" role="group" aria-label="흐름 방향">
					{DIRS.map(([k, Icon, label, tip]) => (
						<button key={k} type="button" aria-pressed={dirPref === k} onClick={() => chooseDir(k)} title={k === "auto" ? `${tip} — 지금 ${horizontal ? "왼→오른" : "위→아래"}` : tip} aria-label={label}>
							<Icon size={12} />
							<span className="qm-dir-l">{label}</span>
						</button>
					))}
				</div>
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
