import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/querymap.css";
import { AlertTriangle, Info, RefreshCw, Stethoscope } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { ColMeta } from "../lib/edits";
import { type AnalyzeDeps, type Snapshot, useAnalysis } from "../lib/queryAnalysis";
import type { Finding, MapTable, Pos, QueryMap } from "../lib/queryLint";
import { currentView } from "../lib/queryWatch";

const W = 214;
const ROW = 18;
const HEAD = 34;
const GAP_X = 120;
const GAP_Y = 46;
const PAD = 14;
const GROUP_HEAD = 26;
const MAX_ROWS = 14;
const PER_ROW = 3;

/** 문장 안 위치 → 편집기로 */
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

/** 열 줄 — 위치는 그릴 때가 아니라 누를 때 지금 그림에서 id 로 찾는다(구조가 같아도 위치는 바뀐다) */
type ColRow = { name: string; roles: string; pk: boolean; fk: boolean; type?: string; missing: boolean; col: number };
type TData = { t: MapTable; label: string; badge: string | null; sub: string | null; cols: ColRow[]; more: number; missing: boolean; onCol: (col: number) => void };
type GData = { label: string; kind: string; w: number; h: number };

const ROLE_ORDER = "SWJGHOUI";
const ROLE_OF: Record<string, string> = { select: "S", where: "W", on: "J", group: "G", having: "H", order: "O", set: "U", insert: "I" };
const ROLE_TIP: Record<string, string> = { S: "SELECT", W: "WHERE", J: "JOIN ON", G: "GROUP BY", H: "HAVING", O: "ORDER BY", U: "SET", I: "INSERT" };

const TableNode = memo(function TableNode({ data }: NodeProps<Node<TData>>) {
	return (
		<div className={`qm-node${data.missing ? " missing" : ""}`}>
			<Handle type="target" position={Position.Left} />
			<div className="qm-head">
				<b>{data.label}</b>
				{data.badge && <span className="qm-badge">{data.badge}</span>}
			</div>
			{data.sub && <div className="qm-sub">{data.sub}</div>}
			{data.cols.map((c) => (
				<button
					type="button"
					key={c.name}
					className={`qm-col${c.pk ? " pk" : ""}${c.fk ? " fk" : ""}${c.missing ? " missing" : ""}${/[WGO]/.test(c.roles) ? " hot" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						data.onCol(c.col);
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
			))}
			{data.more > 0 && <div className="qm-more">열 {data.more}개 더</div>}
			<Handle type="source" position={Position.Right} />
		</div>
	);
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GData>>) {
	return (
		<div className={`qm-group k-${data.kind}`} style={{ width: data.w, height: data.h }}>
			<Handle type="target" position={Position.Left} />
			<div className="qm-group-head">{data.label}</div>
			<Handle type="source" position={Position.Right} />
		</div>
	);
});

const nodeTypes = { qtable: TableNode, qgroup: GroupNode };

const KIND_LABEL: Record<string, string> = { inner: "INNER", left: "LEFT", right: "RIGHT", full: "FULL", cross: "CROSS", semi: "SEMI", anti: "ANTI", apply: "APPLY", asof: "ASOF", where: "WHERE", comma: "," };

function scopeLabel(s: QueryMap["scopes"][number]) {
	if (s.kind === "cte") return `WITH ${s.name ?? ""}`;
	if (s.kind === "derived") return `서브쿼리 ${s.name ?? ""}`.trim();
	if (s.kind === "union") return "UNION 갈래";
	return s.name ? `${s.name} (…)` : "서브쿼리";
}

/** 지도 그림 — 묶음(CTE·서브쿼리)을 상자로 겹쳐, 표는 FROM 순서대로 왼쪽 → 오른쪽 */
function build(snap: Snapshot, findings: Finding[], onCol: (col: number) => void): { nodes: Node[]; edges: Edge[] } {
	const { map, resolved } = snap;
	const meta = resolved?.meta ?? map.tables.map(() => undefined);
	const colTable = resolved?.colTable ?? map.cols.map((c) => c.table);
	const fkCols = new Map<number, Set<string>>();
	if (resolved)
		for (const t of map.tables) {
			const m = meta[t.id];
			if (!m) continue;
			const list = resolved.fks.get((m.schema ?? "").toLowerCase()) ?? [];
			fkCols.set(t.id, new Set(list.filter((f) => f.table.toLowerCase() === m.name.toLowerCase()).map((f) => f.column.toLowerCase())));
		}
	const missingTables = new Set(findings.filter((f) => f.key.startsWith("nt")).map((f) => Number(f.key.slice(2))));

	// 표마다 쓰인 열
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

	const tableH = (id: number) => {
		const n = Math.min(MAX_ROWS, rows.get(id)?.length ?? 0);
		const t = map.tables[id];
		const sub = t.alias || meta[id] ? 1 : 0;
		return HEAD + sub * 16 + Math.max(1, n) * ROW + ((rows.get(id)?.length ?? 0) > MAX_ROWS ? 16 : 0) + 8;
	};

	const nodes: Node[] = [];
	const kids = (sid: number) => map.scopes.filter((s) => s.parent === sid);
	/** 묶음 하나 배치 — 크기를 돌려준다. origin 은 부모 상자 안 좌표 */
	const place = (sid: number, parentNode: string | undefined, ox: number, oy: number): { w: number; h: number } => {
		const isGroup = map.scopes[sid].kind !== "main";
		const top = isGroup ? GROUP_HEAD : 0;
		const left = isGroup ? PAD : 0;
		const own = map.tables.filter((t) => t.scope === sid);
		let x = left;
		let rowY = top;
		let rowH = 0;
		let maxX = left;
		const gid = isGroup ? `g${sid}` : parentNode;
		const tableNodes: Node[] = [];
		own.forEach((t, i) => {
			// 한 줄에 PER_ROW 개 — 좁은 칸에서도 글이 읽히게
			if (i > 0 && i % PER_ROW === 0) {
				rowY += rowH + GAP_Y;
				rowH = 0;
				x = left;
			}
			const h = tableH(t.id);
			const m = meta[t.id];
			const pkUnused = m?.cols?.filter((c) => c.pk && !rows.get(t.id)?.some((r) => r.name.toLowerCase() === c.name.toLowerCase())).map((c) => c.name);
			tableNodes.push({
				id: `t${t.id}`,
				type: "qtable",
				position: { x, y: rowY },
				...(gid ? { parentId: gid, extent: "parent" as const } : {}),
				data: {
					t,
					label: `${t.schema ? `${t.schema}.` : ""}${t.name}`,
					badge: t.target ? "대상" : t.cte !== null ? "CTE" : t.derived !== null ? "서브쿼리" : t.virt ? "함수" : m?.kind === "view" ? "뷰" : null,
					sub: [t.alias && t.alias !== t.name ? `별칭 ${t.alias}` : null, pkUnused?.length ? `PK ${pkUnused.join(", ")}` : null].filter(Boolean).join(" · ") || null,
					cols: (rows.get(t.id) ?? []).slice(0, MAX_ROWS),
					more: Math.max(0, (rows.get(t.id)?.length ?? 0) - MAX_ROWS),
					missing: missingTables.has(t.id),
					onCol,
				} satisfies TData,
				style: { width: W },
			});
			maxX = Math.max(maxX, x + W);
			x += W + GAP_X;
			rowH = Math.max(rowH, h);
		});
		let width = own.length ? maxX : left;
		let y = rowY + rowH + (own.length ? GAP_Y : 0);
		// 아래 묶음 — 먼저 자리를 재고 그 뒤 상자를 만든다(부모가 자식보다 앞에 와야 한다)
		const placed: { id: number; w: number; h: number; x: number; y: number }[] = [];
		let cx = left;
		let childH = 0;
		const groupNode: Node | null = isGroup ? { id: `g${sid}`, type: "qgroup", position: { x: ox, y: oy }, data: { label: scopeLabel(map.scopes[sid]), kind: map.scopes[sid].kind, w: 0, h: 0 }, ...(parentNode ? { parentId: parentNode, extent: "parent" as const } : {}), selectable: false } : null;
		if (groupNode) nodes.push(groupNode);
		nodes.push(...tableNodes);
		for (const k of kids(sid)) {
			const sz = place(k.id, isGroup ? `g${sid}` : parentNode, isGroup ? cx : ox + cx, isGroup ? y : oy + y);
			placed.push({ id: k.id, ...sz, x: cx, y });
			cx += sz.w + GAP_X / 2;
			childH = Math.max(childH, sz.h);
		}
		width = Math.max(width, placed.length ? cx - GAP_X / 2 : 0);
		y += childH;
		const w = Math.max(width + (isGroup ? PAD : 0), isGroup ? 160 : 0);
		const h = (placed.length ? y : y - (own.length ? GAP_Y : 0)) + (isGroup ? PAD : 0);
		if (groupNode) {
			(groupNode.data as GData).w = w;
			(groupNode.data as GData).h = Math.max(h, GROUP_HEAD + 30);
			groupNode.style = { width: w, height: Math.max(h, GROUP_HEAD + 30) };
		}
		return { w, h: Math.max(h, isGroup ? GROUP_HEAD + 30 : 0) };
	};
	const main = map.scopes.find((s) => s.kind === "main");
	if (main) place(main.id, undefined, 0, 0);

	// 선
	const edges: Edge[] = [];
	const fkLess = new Set(findings.filter((f) => f.key.startsWith("fk")).map((f) => f.key.slice(2)));
	const name = (c: number) => `${map.cols[c].qual ? `${map.cols[c].qual}.` : ""}${map.cols[c].name}`;
	map.joins.forEach((j, i) => {
		let a = j.left;
		let b = j.right;
		if ((a === null || b === null) && j.on.length) {
			const p = j.on[0];
			a ??= colTable[p.a] ?? null;
			b ??= colTable[p.b] ?? null;
			if (a === b) b = colTable[p.b] ?? null;
		}
		if (a === null || b === null || a === b || j.kind === "comma") return;
		const cond = j.on.length ? `${name(j.on[0].a)} = ${name(j.on[0].b)}${j.on.length > 1 ? ` 외 ${j.on.length - 1}` : ""}` : j.using.length ? `USING ${j.using.join(", ")}` : j.natural ? "NATURAL" : j.hasOn ? "ON …" : "조건 없음";
		const noFk = j.on.some((p) => fkLess.has(`${p.a}:${p.b}`));
		const bad = !j.hasOn && j.kind !== "cross" && j.kind !== "apply";
		const dash = j.kind === "where" ? "2 4" : j.kind === "cross" || bad ? "6 4" : noFk ? "5 3" : undefined;
		edges.push({
			id: `j${i}`,
			source: `t${a}`,
			target: `t${b}`,
			label: `${KIND_LABEL[j.kind] ?? j.kind.toUpperCase()} · ${cond}${noFk ? " · FK 없음" : ""}`,
			className: `qm-edge k-${j.kind}${bad || j.kind === "cross" ? " bad" : ""}`,
			markerEnd: j.kind === "left" || j.kind === "inner" || j.kind === "full" ? { type: MarkerType.ArrowClosed } : undefined,
			markerStart: j.kind === "right" || j.kind === "full" ? { type: MarkerType.ArrowClosed } : undefined,
			style: { strokeWidth: j.kind === "where" ? 1.2 : 1.6, strokeDasharray: dash },
			data: { join: i },
			labelBgPadding: [4, 2],
			labelBgBorderRadius: 4,
		});
	});
	// CTE·서브쿼리 표 ← 그 묶음
	for (const t of map.tables) {
		const g = t.cte ?? t.derived;
		if (g === null) continue;
		edges.push({ id: `c${t.id}`, source: `g${g}`, target: `t${t.id}`, className: "qm-edge k-scope", style: { strokeDasharray: "2 3", strokeWidth: 1 }, data: { table: t.id } });
	}
	// 상관 서브쿼리 → 바깥 표
	for (const f of map.facts)
		if (f.kind === "correlated" && f.sub !== null && f.table !== null)
			edges.push({ id: `k${f.sub}`, source: `g${f.sub}`, target: `t${f.table}`, label: "상관", className: "qm-edge k-corr", style: { strokeDasharray: "2 3", strokeWidth: 1 }, data: { scope: f.sub } });
	return { nodes, edges };
}

/** 쿼리 지도 — 치는 동안 커서 문장의 표·조인·조건 열을 서버에 묻지 않고 그린다 */
export function QueryMapPanel({ deps, visible, onTuning }: { deps: AnalyzeDeps; visible: boolean; onTuning: () => void }) {
	const { state, refresh } = useAnalysis(deps, visible);
	const snap = state.snap;
	const snapRef = useRef(snap);
	snapRef.current = snap;
	const rf = useRef<ReactFlowInstance | null>(null);
	const conn = deps.conn;
	const onCol = useMemo(() => (col: number) => jumpTo(conn, snapRef.current, snapRef.current?.map.cols[col]?.pos), [conn]);
	const mapWarns = useMemo(() => (snap?.findings ?? []).filter((f) => f.layer === "map"), [snap?.findings]);
	// 구조가 바뀔 때만 다시 그린다(위치만 옮긴 입력은 그대로)
	const graph = useMemo(() => (snap ? build(snap, mapWarns, onCol) : { nodes: [], edges: [] }), [snap?.shape, mapWarns.length, onCol]);
	const tableKey = snap ? snap.map.tables.map((t) => `${t.scope}:${t.name}`).join("|") + snap.map.scopes.length : "";
	useEffect(() => {
		if (!tableKey) return;
		const id = requestAnimationFrame(() => rf.current?.fitView({ padding: 0.15, maxZoom: 1.1, duration: 0 }));
		return () => cancelAnimationFrame(id);
	}, [tableKey]);

	const others = (snap?.findings ?? []).filter((f) => f.layer !== "map").length;
	return (
		<div className="panel-fill qmap-panel">
			<div className={`qm-host${snap?.stale ? " stale" : ""}`}>
				{snap && graph.nodes.length > 0 ? (
					<ReactFlow
						nodes={graph.nodes}
						edges={graph.edges}
						nodeTypes={nodeTypes}
						onInit={(i) => {
							rf.current = i;
							i.fitView({ padding: 0.15, maxZoom: 1.1 });
						}}
						onNodeClick={(_, n) => {
							const d = n.data as Partial<TData>;
							if (d.t) jumpTo(conn, snapRef.current, snapRef.current?.map.tables[d.t.id]?.pos);
							else {
								const sid = Number(n.id.slice(1));
								jumpTo(conn, snapRef.current, snapRef.current?.map.scopes[sid]?.pos);
							}
						}}
						onEdgeClick={(_, e) => {
							const d = (e.data ?? {}) as { join?: number; table?: number; scope?: number };
							const m = snapRef.current?.map;
							jumpTo(conn, snapRef.current, d.join !== undefined ? m?.joins[d.join]?.pos : d.table !== undefined ? m?.tables[d.table]?.pos : d.scope !== undefined ? m?.scopes[d.scope]?.pos : undefined);
						}}
						nodesConnectable={false}
						nodesDraggable={false}
						elementsSelectable
						minZoom={0.2}
						proOptions={{ hideAttribution: true }}
					>
						<Background gap={18} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				) : (
					<div className="panel-hint qm-empty">{state.off ?? (snap ? "그릴 표가 없습니다" : "SQL 편집기에서 쿼리를 치면 표·조인·조건이 여기에 그려집니다")}</div>
				)}
				{snap?.stale && <div className="qm-stale">치는 중 — 마지막으로 읽은 그림 · {snap.error?.replace(/ at Line: \d+, Column: \d+$/, "")}</div>}
			</div>
			{mapWarns.length > 0 && (
				<div className="qm-warns">
					{mapWarns.slice(0, 6).map((f) => (
						<button type="button" key={f.key} className={`qm-warn ${f.level}`} onClick={() => jumpTo(conn, snapRef.current, f.pos)} title={f.why}>
							{f.level === "warn" ? <AlertTriangle size={12} /> : <Info size={12} />}
							<span>{f.title}</span>
						</button>
					))}
					{mapWarns.length > 6 && <span className="qm-warn-more">외 {mapWarns.length - 6}개</span>}
				</div>
			)}
			<div className="statusbar">
				<span className="qm-legend">
					<i className="r-W">W</i> WHERE <i className="r-J">J</i> 조인 <i className="r-G">G</i> GROUP <i className="r-O">O</i> ORDER <i className="r-S">S</i> SELECT
				</span>
				{snap?.note && <span title={snap.note}>{snap.note}</span>}
				{state.busy && <span>맞추는 중…</span>}
				<span style={{ marginLeft: "auto" }} />
				{snap && snap.map.dialect === "generic" && deps.engine !== "cubrid" && deps.engine !== "altibase" && <span title="엔진 방언이 못 읽어 일반 방언으로 읽었습니다">일반 방언</span>}
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
