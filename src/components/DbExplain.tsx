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
	warn?: string;
	props: [string, string][];
	kids: PlanNode[];
};

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

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
		let warn: string | undefined;
		if (actualRows !== undefined && planRows !== undefined && planRows > 0 && (actualRows / planRows > 10 || (actualRows > 0 && planRows / actualRows > 10)))
			warn = `예상 행(${planRows.toLocaleString()})과 실제 행(${actualRows.toLocaleString()})이 크게 다릅니다 — 통계(ANALYZE)를 새로 하세요`;
		else if (p["Node Type"] === "Seq Scan" && (planRows ?? 0) > 100_000) warn = "큰 표 전체 읽기(Seq Scan) — 조건 열에 인덱스가 있는지 보세요";
		return {
			label: String(p["Node Type"] ?? "?") + (p["Join Type"] ? ` ${p["Join Type"]}` : ""),
			sub: [rel && `on ${rel}`, p["Index Name"] && `index ${p["Index Name"]}`].filter(Boolean).join(" · ") || undefined,
			cost,
			rows: planRows,
			actualMs,
			actualRows,
			loops: num(p["Actual Loops"]),
			self,
			warn,
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
			warn: access === "ALL" && (rows ?? 0) > 1000 ? "표 전체 읽기(ALL) — 조건 열에 인덱스가 있는지 보세요" : undefined,
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
		if (n.warn)
			rows.push(
				<div key={`${path}#w`} className="plan-warn" style={{ paddingLeft: 30 + depth * 18 }}>
					{n.warn}
				</div>,
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
