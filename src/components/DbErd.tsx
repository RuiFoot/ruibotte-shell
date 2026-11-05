import { invoke } from "@tauri-apps/api/core";
import { Background, Controls, type Edge, MarkerType, MiniMap, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState } from "react";
import { type Fk, fkSql, queryRows } from "../lib/dbtools";
import type { ColMeta } from "../lib/edits";

/** ERD — 스키마의 표·열·외래 키. 참조되는 표를 왼쪽에 층으로 놓는다 */
export function ErdPanel({ conn, engine, schema }: { conn: number; engine: string; schema: string }) {
	const [state, setState] = useState("읽는 중…");
	const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
	useEffect(() => {
		let gone = false;
		(async () => {
			const tables = (await invoke<{ name: string; kind: string }[]>("db_tree", { conn, path: [schema] })).filter((t) => t.kind === "table").slice(0, 120);
			const sql = fkSql(engine, schema);
			const fks: Fk[] = sql ? (await queryRows(conn, sql)).map((r) => ({ table: r[0] ?? "", column: r[1] ?? "", refTable: r[2] ?? "", refColumn: r[3] ?? "" })) : [];
			const metas = new Map<string, ColMeta[]>();
			for (const t of tables) {
				try {
					metas.set(t.name, await invoke<ColMeta[]>("db_table_meta", { conn, schema: schema === "(기본)" ? null : schema, table: t.name }));
				} catch {
					metas.set(t.name, []);
				}
				if (gone) return;
			}
			// 층: 아무도 참조하지 않는(= 참조되기만 하는) 표가 0층
			const level = new Map<string, number>(tables.map((t) => [t.name, 0]));
			for (let pass = 0; pass < 8; pass++) {
				for (const f of fks) {
					if (f.table === f.refTable) continue;
					const want = (level.get(f.refTable) ?? 0) + 1;
					if ((level.get(f.table) ?? 0) < want) level.set(f.table, Math.min(want, 6));
				}
			}
			const cols = new Map<number, number>();
			const nodes: Node[] = tables.map((t) => {
				const lv = level.get(t.name) ?? 0;
				const row = cols.get(lv) ?? 0;
				const ms = metas.get(t.name) ?? [];
				cols.set(lv, row + Math.max(2, ms.length) * 20 + 50);
				const fkCols = new Set(fks.filter((f) => f.table === t.name).map((f) => f.column));
				return {
					id: t.name,
					position: { x: lv * 300, y: row },
					data: {
						label: (
							<div className="erd-node">
								<b>{t.name}</b>
								{ms.slice(0, 24).map((c) => (
									<div key={c.name} className={c.pk ? "pk" : fkCols.has(c.name) ? "fk" : undefined}>
										<span>{c.pk ? "🔑 " : fkCols.has(c.name) ? "↗ " : ""}{c.name}</span>
										<small>{c.dataType}</small>
									</div>
								))}
								{ms.length > 24 && <small>… {ms.length - 24}개 더</small>}
							</div>
						),
					},
					style: { width: 250, padding: 0, borderRadius: 10 },
				};
			});
			const names = new Set(tables.map((t) => t.name));
			const edges: Edge[] = fks
				.filter((f) => names.has(f.table) && names.has(f.refTable))
				.map((f, i) => ({ id: `e${i}`, source: f.refTable, target: f.table, label: `${f.column} → ${f.refColumn}`, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.4 } }));
			if (!gone) {
				setGraph({ nodes, edges });
				setState(`표 ${tables.length} · 관계 ${edges.length}${sql ? "" : " (이 엔진은 관계 정보를 아직 읽지 않습니다)"}`);
			}
		})().catch((e) => !gone && setState(String(e?.message ?? e)));
		return () => {
			gone = true;
		};
	}, [conn, engine, schema]);
	return (
		<div className="panel-fill">
			<div className="erd-host">
				{graph && (
					<ReactFlow nodes={graph.nodes} edges={graph.edges} fitView minZoom={0.1} proOptions={{ hideAttribution: true }} nodesConnectable={false}>
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

