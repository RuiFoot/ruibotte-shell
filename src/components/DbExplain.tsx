import { ChevronRight } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

/** db_explain 결과 */
export type ExplainOk = { format: "pg-json" | "my-json" | "text"; plan: string; ms: number; rolledBack: boolean };

type PlanNode = {
	label: string;
	sub?: string;
	/** 예상 비용(누적) */
	cost?: number;
	/** 예상 행 */
	rows?: number;
	/** 실제 시간(ms, 반복 포함) · 실제 행 · 반복 */
	actualMs?: number;
	actualRows?: number;
	loops?: number;
	/** 이 노드만의 시간·비용(자식 뺀 것) */
	self?: number;
	/** 계획 규칙이 단 경고(여럿일 수 있다) */
	warns: string[];
	props: [string, string][];
	kids: PlanNode[];
};

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** 큰 표로 볼 행 수 */
const BIG = 10_000;

/** PostgreSQL 계획 노드 규칙 */
function pgRules(p: Record<string, unknown>, kids: PlanNode[], planRows: number | undefined, actualRows: number | undefined, loops: number): string[] {
	const w: string[] = [];
	const type = String(p["Node Type"] ?? "");
	if (actualRows !== undefined && planRows !== undefined && planRows > 0 && (actualRows / planRows > 10 || (actualRows > 0 && planRows / actualRows > 10)))
		w.push(`예상 행(${planRows.toLocaleString()})과 실제 행(${actualRows.toLocaleString()})이 10배 넘게 다릅니다 — 통계가 낡았을 수 있습니다. ${p["Relation Name"] ? `ANALYZE ${p["Relation Name"]}` : "관련 표를 ANALYZE"} 로 새로 하세요`);
	const removed = num(p["Rows Removed by Filter"]);
	const scanned = ((actualRows ?? 0) + (removed ?? 0)) * loops;
	if (type === "Seq Scan" && p.Filter && (scanned > BIG || (planRows ?? 0) > BIG))
		w.push(`큰 표 전체 읽기(Seq Scan) + 필터 ${String(p.Filter).slice(0, 80)}${removed ? ` — 버린 행 ${(removed * loops).toLocaleString()}` : ""}. 필터 열에 인덱스가 있는지 보세요`);
	else if (type === "Seq Scan" && (planRows ?? 0) > 100_000) w.push("큰 표 전체 읽기(Seq Scan) — 조건 열에 인덱스가 있는지 보세요");
	if (type === "Nested Loop" && kids.length >= 2) {
		// 바깥·안쪽은 Parent Relationship 으로(앞에 InitPlan·SubPlan 이 올 수 있다)
		const raw = (p.Plans as Record<string, unknown>[] | undefined) ?? [];
		const oi = raw.findIndex((x) => x["Parent Relationship"] === "Outer");
		const ii = raw.findIndex((x) => x["Parent Relationship"] === "Inner");
		const outer = kids[oi >= 0 ? oi : 0];
		const inner = kids[ii >= 0 ? ii : 1];
		const outerRows = outer.actualRows !== undefined ? outer.actualRows * (outer.loops ?? 1) : outer.rows;
		const innerSeq = /^Seq Scan/.test(inner.label);
		const innerIndex = /Index/.test(inner.label);
		// 안쪽이 인덱스 조회면 바깥이 아주 많을 때만
		if ((outerRows ?? 0) > (innerIndex ? 1_000_000 : BIG))
			w.push(`바깥 행이 많은 Nested Loop(${Math.round(outerRows ?? 0).toLocaleString()}행 × 안쪽) — 안쪽 조인 열에 인덱스가 없거나 행 수 예상이 틀렸을 수 있습니다. Hash Join 이 낫지 않은지 보세요`);
		else if (innerSeq && (outerRows ?? 0) > 100) w.push("Nested Loop 의 안쪽이 Seq Scan — 바깥 행마다 표를 다시 훑습니다. 안쪽 조인 열에 인덱스를 보세요");
	}
	const method = String(p["Sort Method"] ?? "");
	if (/external/i.test(method) || p["Sort Space Type"] === "Disk")
		w.push(`정렬이 메모리를 넘쳐 디스크로(${method || "Disk"}${p["Sort Space Used"] ? `, ${p["Sort Space Used"]}kB` : ""}) — work_mem 을 늘리거나 정렬할 행을 줄이세요(LIMIT·인덱스 정렬)`);
	const batches = num(p["Hash Batches"]) ?? 0;
	if (batches > 1) w.push(`Hash 가 ${batches}개 묶음으로 나뉘어 디스크로 넘쳤습니다 — work_mem 이 모자랍니다(작은 쪽 입력을 줄이거나 work_mem 을 늘리세요)`);
	return w;
}

/** MySQL·MariaDB JSON 계획 블록 규칙 */
function myRules(label: string, o: Record<string, unknown>, access: string | undefined, rows: number | undefined): string[] {
	const w: string[] = [];
	const yes = (v: unknown) => v === true || v === "true";
	// MariaDB 는 using_filesort 대신 filesort·temporary_table 블록
	if (label === "filesort") w.push("filesort — ORDER BY 를 인덱스로 받지 못해 따로 정렬합니다(정렬 열 인덱스·LIMIT 확인)");
	if (label === "temporary_table") w.push("임시 표 — GROUP BY·DISTINCT·UNION 에 임시 표를 씁니다(그룹 열 인덱스 확인)");
	if (access === "ALL" && (rows ?? 0) > 1000) w.push(`표 전체 읽기(type=ALL, ${Math.round(rows ?? 0).toLocaleString()}행) — 조건·조인 열에 인덱스가 있는지 보세요`);
	if (access === "index" && (rows ?? 0) > BIG) w.push("인덱스 전체 훑기(type=index) — 조건이 인덱스 앞 열에 맞지 않아 범위를 좁히지 못합니다");
	if (yes(o.using_filesort)) w.push("Using filesort — ORDER BY 를 인덱스로 받지 못해 따로 정렬합니다(정렬 열 인덱스·LIMIT 확인)");
	if (yes(o.using_temporary_table)) w.push("Using temporary — GROUP BY·DISTINCT·UNION 에 임시 표를 씁니다(그룹 열 인덱스 확인)");
	const filtered = num(o.filtered);
	if (filtered !== undefined && filtered < 10 && (rows ?? 0) > BIG) w.push(`읽은 행의 ${filtered}% 만 남깁니다 — 남기는 조건 열을 인덱스로 먼저 거르세요`);
	const est = num(o.rows);
	const act = num(o.r_rows);
	if (est !== undefined && act !== undefined && est > 0 && (act / est > 10 || (act > 0 && est / act > 10)))
		w.push(`예상 행(${est.toLocaleString()})과 실제 행(${act.toLocaleString()})이 10배 넘게 다릅니다 — ANALYZE TABLE 로 통계를 새로 하세요`);
	return w;
}

/** 글로 된 계획(MySQL EXPLAIN ANALYZE · SQL Server SHOWPLAN_TEXT) 규칙 */
function textRules(plan: string): string[] {
	const w = new Set<string>();
	for (const line of plan.split("\n")) {
		const t = /Table scan on (\S+).*?rows=(\d+(?:\.\d+)?)/.exec(line);
		if (t && Number(t[2]) > 1000) w.add(`표 전체 읽기: ${t[1]} (${Number(t[2]).toLocaleString()}행) — 조건 열에 인덱스가 있는지 보세요`);
		const e = /\(cost=[^)]*rows=(\d+(?:\.\d+)?)\) \(actual [^)]*rows=(\d+(?:\.\d+)?)/.exec(line);
		if (e) {
			const [p, a] = [Number(e[1]), Number(e[2])];
			if (p > 0 && (a / p > 10 || (a > 0 && p / a > 10))) w.add("예상 행과 실제 행이 10배 넘게 다른 단계가 있습니다 — ANALYZE TABLE 로 통계를 새로 하세요");
		}
		if (/Using filesort/i.test(line)) w.add("Using filesort — ORDER BY 를 인덱스로 받지 못합니다");
		if (/Using temporary/i.test(line)) w.add("Using temporary — 임시 표를 씁니다");
		const ms = /--Table Scan\(OBJECT:\(([^)]+)\)/.exec(line);
		if (ms) w.add(`Table Scan: ${ms[1]} — 힙 표 전체 읽기(조건 열 인덱스 확인)`);
		const cs = /--Clustered Index Scan\(OBJECT:\(([^)]+)\)/.exec(line);
		if (cs && /WHERE:/.test(line)) w.add(`Clustered Index Scan + WHERE: ${cs[1]} — 조건 열 인덱스가 없어 표 전체를 읽습니다`);
	}
	return [...w];
}

export type PlanFinding = { node: string; text: string };

/** 계획의 모든 경고를 한 목록으로(튜닝 칸) */
export function planFindings(ok: ExplainOk): PlanFinding[] {
	if (ok.format === "text") return textRules(ok.plan).map((text) => ({ node: "계획", text }));
	let parsed: { root: PlanNode } | null = null;
	try {
		const j = JSON.parse(ok.plan);
		parsed = ok.format === "pg-json" ? fromPg(j) : fromMy(j);
	} catch {
		return [];
	}
	const out: PlanFinding[] = [];
	const go = (n: PlanNode) => {
		for (const t of n.warns) out.push({ node: n.label + (n.sub ? ` · ${n.sub}` : ""), text: t });
		n.kids.forEach(go);
	};
	if (parsed) go(parsed.root);
	return out;
}

/** 계획 맨 위 비용·시간(비교용) */
export function planTotals(ok: ExplainOk): { cost?: number; ms?: number; rows?: number } {
	try {
		if (ok.format === "pg-json") {
			const r = fromPg(JSON.parse(ok.plan))?.root;
			return { cost: r?.cost, ms: r?.actualMs, rows: r?.actualRows ?? r?.rows };
		}
		if (ok.format === "my-json") {
			const r = fromMy(JSON.parse(ok.plan))?.root;
			let cost = r?.cost;
			const go = (n: PlanNode) => {
				cost = Math.max(cost ?? 0, n.cost ?? 0);
				n.kids.forEach(go);
			};
			if (r) go(r);
			return { cost, ms: r?.actualMs };
		}
	} catch {
		/* 원문만 */
	}
	const m = /actual time=[\d.]+\.\.([\d.]+)/.exec(ok.plan);
	const c = /cost=[\d.]+(?:\.\.([\d.]+))?/.exec(ok.plan);
	return { ms: m ? Number(m[1]) : undefined, cost: c?.[1] ? Number(c[1]) : undefined };
}

/** PostgreSQL EXPLAIN (FORMAT JSON) → 트리 */
function fromPg(j: unknown): { root: PlanNode; extra: [string, string][] } | null {
	const top = Array.isArray(j) ? (j[0] as Record<string, unknown>) : null;
	const plan = top?.Plan as Record<string, unknown> | undefined;
	if (!plan) return null;
	const SKIP = new Set(["Plans", "Node Type", "Relation Name", "Alias", "Index Name", "Startup Cost", "Total Cost", "Plan Rows", "Plan Width", "Actual Startup Time", "Actual Total Time", "Actual Rows", "Actual Loops", "Output", "Parallel Aware", "Async Capable"]);
	const walk = (p: Record<string, unknown>): PlanNode => {
		const kids = ((p.Plans as Record<string, unknown>[] | undefined) ?? []).map(walk);
		const loops = num(p["Actual Loops"]) ?? 1;
		const actualMs = num(p["Actual Total Time"]) !== undefined ? (num(p["Actual Total Time"]) as number) * loops : undefined;
		const cost = num(p["Total Cost"]);
		const childSum = (f: (k: PlanNode) => number | undefined) => kids.reduce((a, k) => a + (f(k) ?? 0), 0);
		const self = actualMs !== undefined ? Math.max(0, actualMs - childSum((k) => k.actualMs)) : cost !== undefined ? Math.max(0, cost - childSum((k) => k.cost)) : undefined;
		const rel = [p["Relation Name"], p.Alias && p.Alias !== p["Relation Name"] ? `(${p.Alias})` : null].filter(Boolean).join(" ");
		const props = Object.entries(p)
			.filter(([k, v]) => !SKIP.has(k) && v !== null && typeof v !== "object")
			.map(([k, v]) => [k, String(v)] as [string, string]);
		const actualRows = num(p["Actual Rows"]);
		const planRows = num(p["Plan Rows"]);
		const warns = pgRules(p, kids, planRows, actualRows, loops);
		return {
			label: String(p["Node Type"] ?? "?") + (p["Join Type"] ? ` ${p["Join Type"]}` : ""),
			sub: [rel && `on ${rel}`, p["Index Name"] && `index ${p["Index Name"]}`].filter(Boolean).join(" · ") || undefined,
			cost,
			rows: planRows,
			actualMs,
			actualRows,
			loops: num(p["Actual Loops"]),
			self,
			warns,
			props,
			kids,
		};
	};
	const extra = Object.entries(top as Record<string, unknown>)
		.filter(([k, v]) => k !== "Plan" && typeof v !== "object")
		.map(([k, v]) => [k, String(v)] as [string, string]);
	return { root: walk(plan), extra };
}

/** MySQL EXPLAIN FORMAT=JSON · MariaDB ANALYZE FORMAT=JSON → 트리(이름 붙은 블록마다 노드) */
function fromMy(j: unknown): { root: PlanNode; extra: [string, string][] } | null {
	if (!j || typeof j !== "object") return null;
	const walk = (label: string, o: Record<string, unknown>): PlanNode => {
		const kids: PlanNode[] = [];
		const props: [string, string][] = [];
		let cost: number | undefined;
		for (const [k, v] of Object.entries(o)) {
			if (k === "cost_info" && v && typeof v === "object") {
				const ci = v as Record<string, unknown>;
				cost = num(ci.query_cost) ?? num(ci.prefix_cost) ?? ((num(ci.read_cost) ?? 0) + (num(ci.eval_cost) ?? 0) || undefined);
				for (const [a, b] of Object.entries(ci)) props.push([`cost.${a}`, String(b)]);
			} else if (Array.isArray(v) && v.length && typeof v[0] === "object") {
				for (const x of v) {
					const ent = Object.entries(x as Record<string, unknown>);
					// nested_loop: [{table:{…}}] 는 바로 table 로
					if (ent.length === 1 && ent[0][1] && typeof ent[0][1] === "object" && !Array.isArray(ent[0][1])) kids.push(walk(ent[0][0], ent[0][1] as Record<string, unknown>));
					else kids.push(walk(k, x as Record<string, unknown>));
				}
			} else if (v && typeof v === "object" && !Array.isArray(v)) kids.push(walk(k, v as Record<string, unknown>));
			else props.push([k, Array.isArray(v) ? v.join(", ") : String(v)]);
		}
		// MariaDB 11 은 cost_info 없이 cost 하나
		if (cost === undefined) cost = num(o.cost);
		const t = o.table_name as string | undefined;
		const access = o.access_type as string | undefined;
		const rows = num(o.rows_examined_per_scan) ?? num(o.rows);
		const actualRows = num(o.r_rows);
		const actualMs = num(o.r_total_time_ms);
		return {
			label: t ? `${label === "table" ? "" : `${label} `}${t}${access ? ` (${access})` : ""}`.trim() : label,
			sub: (o.key as string | undefined) ? `key ${o.key}` : undefined,
			cost,
			rows,
			actualRows,
			actualMs,
			self: actualMs ?? cost,
			warns: myRules(label, o, access, rows),
			props,
			kids,
		};
	};
	return { root: walk("query", j as Record<string, unknown>), extra: [] };
}

function fmt(n?: number, digits = 2) {
	if (n === undefined) return "";
	return n >= 100 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** 실행 계획 보기 — 트리(비용·행 수, 무거운 노드 강조) / 원문 */
export function ExplainView({ ok, sql, analyze }: { ok: ExplainOk; sql: string; analyze: boolean }) {
	const [raw, setRaw] = useState(ok.format === "text");
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [closedAll, setClosedAll] = useState(false);
	const parsed = useMemo(() => {
		if (ok.format === "text") return null;
		try {
			const j = JSON.parse(ok.plan);
			return ok.format === "pg-json" ? fromPg(j) : fromMy(j);
		} catch {
			return null;
		}
	}, [ok]);
	const pretty = useMemo(() => {
		try {
			return ok.format === "text" ? ok.plan : JSON.stringify(JSON.parse(ok.plan), null, 2);
		} catch {
			return ok.plan;
		}
	}, [ok]);
	// 몫의 기준 — PostgreSQL 은 맨 위 노드, MySQL·MariaDB 는 가장 큰 노드 값
	const total = useMemo(() => {
		if (!parsed) return 0;
		if (ok.format === "pg-json") return parsed.root.actualMs ?? parsed.root.cost ?? 0;
		let m = 0;
		const go = (n: PlanNode) => {
			m = Math.max(m, n.actualMs ?? n.cost ?? 0);
			n.kids.forEach(go);
		};
		go(parsed.root);
		return m;
	}, [parsed, ok.format]);
	const rows: ReactElement[] = [];
	const walk = (n: PlanNode, path: string, depth: number) => {
		const share = total > 0 && n.self !== undefined ? n.self / total : 0;
		const hot = share >= 0.3 ? "hot" : share >= 0.1 ? "warm" : "";
		const isOpen = closedAll ? open.has(path) : !open.has(path);
		rows.push(
			<div key={path} className={`plan-row ${hot}`} style={{ paddingLeft: 8 + depth * 18 }}>
				<button
					type="button"
					className="plan-toggle"
					style={{ visibility: n.kids.length || n.props.length ? "visible" : "hidden" }}
					onClick={() =>
						setOpen((s) => {
							const x = new Set(s);
							if (x.has(path)) x.delete(path);
							else x.add(path);
							return x;
						})
					}
				>
					<ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
				</button>
				<span className="plan-label">{n.label}</span>
				{n.sub && <span className="plan-sub">{n.sub}</span>}
				<span className="plan-nums">
					{n.cost !== undefined && <span title="예상 비용(누적)">비용 {fmt(n.cost)}</span>}
					{n.rows !== undefined && <span title="예상 행 수">행 {fmt(n.rows, 0)}</span>}
					{n.actualMs !== undefined && <span title="실제 시간(반복 포함)">{fmt(n.actualMs)} ms</span>}
					{n.actualRows !== undefined && (
						<span title="실제 행 수">
							실제 {fmt(n.actualRows, 0)}
							{n.loops && n.loops > 1 ? ` ×${n.loops}` : ""}
						</span>
					)}
					{share > 0 && <span className="plan-share" title={analyze ? "이 노드만의 시간 몫" : "이 노드만의 비용 몫"}>{Math.round(share * 100)}%</span>}
				</span>
			</div>,
		);
		if (!isOpen) return;
		n.warns.forEach((w, i) =>
			rows.push(
				<div key={`${path}#w${i}`} className="plan-warn" style={{ paddingLeft: 30 + depth * 18 }}>
					{w}
				</div>,
			),
		);
		if (n.props.length)
			rows.push(
				<div key={`${path}#p`} className="plan-props" style={{ paddingLeft: 30 + depth * 18 }}>
					{n.props.map(([k, v]) => (
						<span key={k}>
							<b>{k}</b> {v}
						</span>
					))}
				</div>,
			);
		n.kids.forEach((k, i) => walk(k, `${path}.${i}`, depth + 1));
	};
	if (parsed) walk(parsed.root, "0", 0);
	return (
		<div className="panel-fill">
			{ok.rolledBack && <div className="change-bar">쓰기 문장을 실제로 실행해 계획을 잰 뒤 되돌렸습니다.</div>}
			<div className="plan-body selectable">
				{raw || !parsed ? (
					<pre className="plan-raw">{pretty}</pre>
				) : (
					<>
						{parsed.extra.length > 0 && (
							<div className="plan-props" style={{ padding: "6px 10px" }}>
								{parsed.extra.map(([k, v]) => (
									<span key={k}>
										<b>{k}</b> {v}
									</span>
								))}
							</div>
						)}
						{rows}
					</>
				)}
			</div>
			<div className="statusbar">
				<span className="ok">{analyze ? "실제 실행 계획(ANALYZE)" : "예상 계획"}</span>
				<span>{ok.ms.toLocaleString()} ms</span>
				<span style={{ marginLeft: "auto" }} />
				{parsed && (
					<>
						<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => (setClosedAll((x) => !x), setOpen(new Set()))}>
							{closedAll ? "모두 펼치기" : "모두 접기"}
						</button>
						<button type="button" className={`btn ghost${raw ? " on" : ""}`} style={{ height: 20 }} onClick={() => setRaw((x) => !x)}>
							원문
						</button>
					</>
				)}
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => void navigator.clipboard.writeText(`${sql}\n\n${pretty}`)}>
					복사
				</button>
			</div>
		</div>
	);
}
