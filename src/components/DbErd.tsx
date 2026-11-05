import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Background, Controls, type Edge, MarkerType, MiniMap, type Node, type NodeChange, ReactFlow, type ReactFlowInstance, applyNodeChanges, getNodesBounds, getViewportForBounds } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Download, LayoutGrid, RefreshCw, Rows3, Search, Share2, Spline } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Fk, fkSql, queryRows } from "../lib/dbtools";
import type { ColMeta } from "../lib/edits";
import { api } from "../lib/ipc";

type Table = { name: string; cols: ColMeta[] };

/**
 * ERD — 스키마의 표·열·외래 키. 참조되는 표를 왼쪽에 층으로 놓는다(관계 없는 표는 격자로 따로).
 * 끌어 옮긴 자리는 기억(다시 배치로 되돌림), 표 찾기·이웃만 보기·열 접기, FK 가 없는 옛 스키마는 이름으로 짐작한 관계(점선), PNG 저장.
 */
export function ErdPanel({ conn, engine, schema, storeKey }: { conn: number; engine: string; schema: string; storeKey?: string }) {
	const [state, setState] = useState("읽는 중…");
	const [data, setData] = useState<{ tables: Table[]; fks: Fk[] } | null>(null);
	const [nodes, setNodes] = useState<Node[]>([]);
	const [nonce, setNonce] = useState(0);
	const [find, setFind] = useState("");
	const [focus, setFocus] = useState<string | null>(null);
	const [neighbors, setNeighbors] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [inferred, setInferred] = useState(true);
	const rf = useRef<ReactFlowInstance | null>(null);
	const host = useRef<HTMLDivElement>(null);
	const posKey = `erd.pos.${storeKey ?? conn}.${schema}`;

	// 표·열·FK 읽기
	useEffect(() => {
		let gone = false;
		setData(null);
		(async () => {
			const list = (await invoke<{ name: string; kind: string }[]>("db_tree", { conn, path: [schema] })).filter((t) => t.kind === "table").slice(0, 200);
			const sql = fkSql(engine, schema);
			const fks: Fk[] = sql ? (await queryRows(conn, sql)).map((r) => ({ table: r[0] ?? "", column: r[1] ?? "", refTable: r[2] ?? "", refColumn: r[3] ?? "" })) : [];
			const tables: Table[] = [];
			for (const t of list) {
				let cols: ColMeta[] = [];
				try {
					cols = await invoke<ColMeta[]>("db_table_meta", { conn, schema: schema === "(기본)" ? null : schema, table: t.name });
				} catch {
					cols = [];
				}
				if (gone) return;
				tables.push({ name: t.name, cols });
				if (tables.length % 20 === 0) setState(`표 읽는 중… ${tables.length}/${list.length}`);
			}
			if (!gone) setData({ tables, fks });
		})().catch((e) => !gone && setState(String(e?.message ?? e)));
		return () => {
			gone = true;
		};
	}, [conn, engine, schema, nonce]);

	/** FK 가 없을 때 이름으로 짐작: 열 이름이 <표>_id·<표>id 이고 그 표에 id(또는 PK 하나)가 있으면 */
	const guessed = useMemo<Fk[]>(() => {
		if (!data) return [];
		const byName = new Map(data.tables.map((t) => [t.name.toLowerCase(), t]));
		const real = new Set(data.fks.map((f) => `${f.table}.${f.column}`));
		const out: Fk[] = [];
		for (const t of data.tables) {
			for (const c of t.cols) {
				if (c.pk || real.has(`${t.name}.${c.name}`)) continue;
				const m = /^(.+?)_?(id|no|seq|cd|code)$/i.exec(c.name);
				if (!m) continue;
				const base = m[1].toLowerCase();
				const ref = byName.get(base) ?? byName.get(`${base}s`) ?? byName.get(`tb_${base}`) ?? byName.get(`t_${base}`);
				if (!ref || ref.name === t.name) continue;
				const pk = ref.cols.filter((x) => x.pk);
				if (pk.length !== 1) continue;
				out.push({ table: t.name, column: c.name, refTable: ref.name, refColumn: pk[0].name });
			}
		}
		return out;
	}, [data]);

	// 자리: 기억한 것 → 없으면 층 배치(관계 없는 표는 오른쪽 격자)
	useEffect(() => {
		if (!data) return;
		let gone = false;
		void api.settingGet(posKey).then((v) => {
			if (gone) return;
			let saved: Record<string, { x: number; y: number }> = {};
			try {
				saved = v ? JSON.parse(v) : {};
			} catch {
				saved = {};
			}
			const all = [...data.fks, ...(inferred ? guessed : [])];
			const linked = new Set(all.flatMap((f) => [f.table, f.refTable]));
			const level = new Map<string, number>(data.tables.map((t) => [t.name, 0]));
			for (let pass = 0; pass < 8; pass++)
				for (const f of all) {
					if (f.table === f.refTable) continue;
					const want = (level.get(f.refTable) ?? 0) + 1;
					if ((level.get(f.table) ?? 0) < want) level.set(f.table, Math.min(want, 6));
				}
			const colY = new Map<number, number>();
			let maxLv = 0;
			for (const t of data.tables) if (linked.has(t.name)) maxLv = Math.max(maxLv, level.get(t.name) ?? 0);
			let gi = 0;
			const loose = data.tables.filter((t) => !linked.has(t.name));
			const gridCols = Math.max(2, Math.ceil(Math.sqrt(loose.length)));
			const height = (t: Table) => (collapsed ? 44 : Math.min(25, Math.max(2, t.cols.length)) * 20 + 50);
			const next: Node[] = data.tables.map((t) => {
				let pos = saved[t.name];
				if (!pos) {
					if (linked.has(t.name)) {
						const lv = level.get(t.name) ?? 0;
						const y = colY.get(lv) ?? 0;
						colY.set(lv, y + height(t) + 30);
						pos = { x: lv * 300, y };
					} else {
						pos = { x: (maxLv + 1) * 300 + 80 + (gi % gridCols) * 280, y: Math.floor(gi / gridCols) * (collapsed ? 70 : 260) };
						gi++;
					}
				}
				return { id: t.name, position: pos, data: { t }, type: "default", style: { width: 250, padding: 0, borderRadius: 10 } };
			});
			setNodes(next);
			setState(`표 ${data.tables.length} · 관계 ${data.fks.length}${inferred && guessed.length ? ` · 짐작 ${guessed.length}` : ""}${fkSql(engine, schema) ? "" : " (이 엔진은 FK 를 아직 읽지 않습니다)"}`);
		});
		return () => {
			gone = true;
		};
	}, [data, guessed, inferred, collapsed, posKey, engine, schema]);

	const savePositions = useCallback(
		(ns: Node[]) => {
			void api.settingSet(posKey, JSON.stringify(Object.fromEntries(ns.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]))));
		},
		[posKey],
	);
	const onNodesChange = useCallback(
		(ch: NodeChange[]) => {
			setNodes((ns) => {
				const out = applyNodeChanges(ch, ns);
				if (ch.some((c) => c.type === "position" && c.dragging === false)) savePositions(out);
				return out;
			});
		},
		[savePositions],
	);

	const fkCols = useMemo(() => {
		const m = new Map<string, Set<string>>();
		for (const f of data?.fks ?? []) (m.get(f.table) ?? m.set(f.table, new Set()).get(f.table))?.add(f.column);
		return m;
	}, [data]);

	const edges = useMemo<Edge[]>(() => {
		if (!data) return [];
		const names = new Set(data.tables.map((t) => t.name));
		const real = data.fks.filter((f) => names.has(f.table) && names.has(f.refTable));
		const out: Edge[] = real.map((f, i) => ({
			id: `e${i}`,
			source: f.refTable,
			target: f.table,
			label: `${f.column} → ${f.refColumn}`,
			markerEnd: { type: MarkerType.ArrowClosed },
			style: { strokeWidth: 1.4 },
		}));
		if (inferred)
			guessed.forEach((f, i) =>
				out.push({ id: `g${i}`, source: f.refTable, target: f.table, label: `${f.column} ?→ ${f.refColumn}`, markerEnd: { type: MarkerType.Arrow }, style: { strokeWidth: 1, strokeDasharray: "5 4", opacity: 0.7 } }),
			);
		return out;
	}, [data, guessed, inferred]);

	// 이웃만: 고른 표와 그 표에 이어진 표만
	const visible = useMemo(() => {
		if (!neighbors || !focus) return null;
		const s = new Set([focus]);
		for (const e of edges) {
			if (e.source === focus) s.add(e.target);
			if (e.target === focus) s.add(e.source);
		}
		return s;
	}, [neighbors, focus, edges]);

	const shownNodes = useMemo(
		() =>
			nodes.map((n) => {
				const t = (n.data as { t: Table }).t;
				const fk = fkCols.get(t.name) ?? new Set<string>();
				return {
					...n,
					hidden: visible ? !visible.has(n.id) : false,
					selected: n.id === focus,
					data: {
						...n.data,
						label: (
							<div className={`erd-node${n.id === focus ? " focus" : ""}`}>
								<b>{t.name}</b>
								{!collapsed &&
									t.cols.slice(0, 24).map((c) => (
										<div key={c.name} className={c.pk ? "pk" : fk.has(c.name) ? "fk" : undefined}>
											<span>
												{c.pk ? "🔑 " : fk.has(c.name) ? "↗ " : ""}
												{c.name}
											</span>
											<small>{c.dataType}</small>
										</div>
									))}
								{!collapsed && t.cols.length > 24 && <small>… {t.cols.length - 24}개 더</small>}
							</div>
						),
					},
				};
			}),
		[nodes, fkCols, visible, focus, collapsed],
	);
	const shownEdges = useMemo(() => (visible ? edges.filter((e) => visible.has(e.source) && visible.has(e.target)) : edges), [edges, visible]);

	const goFind = (name: string) => {
		const n = nodes.find((x) => x.id.toLowerCase() === name.toLowerCase()) ?? nodes.find((x) => x.id.toLowerCase().includes(name.toLowerCase()));
		if (!n) return;
		setFocus(n.id);
		rf.current?.fitView({ nodes: [{ id: n.id }], duration: 300, maxZoom: 1.2 });
	};

	const exportPng = async () => {
		const el = host.current?.querySelector<HTMLElement>(".react-flow__viewport");
		if (!el || !nodes.length) return;
		const path = await saveDialog({ defaultPath: `erd-${schema}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
		if (!path) return;
		const { toPng } = await import("html-to-image");
		const b = getNodesBounds(shownNodes.filter((n) => !n.hidden));
		const w = Math.min(8000, Math.ceil(b.width + 80));
		const h = Math.min(8000, Math.ceil(b.height + 80));
		const vp = getViewportForBounds(b, w, h, 0.1, 2, 0.04);
		const url = await toPng(el, {
			backgroundColor: getComputedStyle(document.body).getPropertyValue("--surface") || "#fff",
			width: w,
			height: h,
			style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
		});
		const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
		await invoke("local_write_bytes", bytes, { headers: { "x-path": encodeURIComponent(path) } });
		setState(`그림을 저장했습니다 — ${path}`);
	};

	return (
		<div className="panel-fill">
			<div className="wb-bar">
				<label className="res-filter" title="표 찾기 — Enter 로 그 표로">
					<Search size={11} />
					<input
						value={find}
						onChange={(e) => setFind(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && goFind(find)}
						placeholder="표 찾기"
						list={`erd-tables-${schema}`}
						spellCheck={false}
					/>
				</label>
				<datalist id={`erd-tables-${schema}`}>
					{data?.tables.map((t) => (
						<option key={t.name} value={t.name} />
					))}
				</datalist>
				<button type="button" className={`btn ghost${neighbors ? " on" : ""}`} title="고른 표와 이어진 표만" onClick={() => setNeighbors((x) => !x)} disabled={!focus}>
					<Share2 size={13} /> <span className="lbl">이웃만</span>
				</button>
				<button type="button" className={`btn ghost${collapsed ? " on" : ""}`} title="열 접기(표 이름만)" onClick={() => setCollapsed((x) => !x)}>
					<Rows3 size={13} /> <span className="lbl">접기</span>
				</button>
				<button type="button" className={`btn ghost${inferred ? " on" : ""}`} title="FK 가 없는 옛 스키마 — 열 이름(<표>_id 등)으로 짐작한 관계를 점선으로" onClick={() => setInferred((x) => !x)}>
					<Spline size={13} /> <span className="lbl">짐작 관계</span>
				</button>
				<span style={{ flex: 1 }} />
				<button
					type="button"
					className="btn ghost"
					title="다시 배치(옮긴 자리 잊기)"
					onClick={() => {
						void api.settingSet(posKey, "");
						setData((d) => (d ? { ...d } : d));
					}}
				>
					<LayoutGrid size={13} /> <span className="lbl">다시 배치</span>
				</button>
				<button type="button" className="btn ghost" title="새로 읽기" onClick={() => setNonce((n) => n + 1)}>
					<RefreshCw size={13} />
				</button>
				<button type="button" className="btn ghost" title="PNG 로 저장" onClick={() => void exportPng().catch((e) => setState(String(e)))}>
					<Download size={13} /> <span className="lbl">PNG</span>
				</button>
			</div>
			<div className="erd-host" ref={host}>
				{nodes.length > 0 && (
					<ReactFlow
						nodes={shownNodes}
						edges={shownEdges}
						onNodesChange={onNodesChange}
						onNodeClick={(_, n) => setFocus(n.id)}
						onPaneClick={() => setFocus(null)}
						onInit={(i) => {
							rf.current = i as unknown as ReactFlowInstance;
						}}
						fitView
						minZoom={0.05}
						proOptions={{ hideAttribution: true }}
						nodesConnectable={false}
					>
						<Background gap={20} />
						<MiniMap pannable zoomable />
						<Controls showInteractive={false} />
					</ReactFlow>
				)}
			</div>
			<div className="statusbar">
				<span>{state}</span>
				<span style={{ marginLeft: "auto" }}>스키마 {schema}</span>
			</div>
		</div>
	);
}
