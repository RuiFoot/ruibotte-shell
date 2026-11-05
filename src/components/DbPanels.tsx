import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { queryRows } from "../lib/dbtools";

type HistoryItem = { id: number; sql: string; ms?: number | null; rows?: number | null; ok: boolean; at: number };

/** 쿼리 기록 — 이 프로필에서 실행한 문장(최근 2000개), 찾기, 누르면 편집기에 넣기·두 번 누르면 실행 */
export function HistoryPanel({ scope, onInsert, onRun }: { scope: string; onInsert: (sql: string) => void; onRun: (sql: string) => void }) {
	const [q, setQ] = useState("");
	const [list, setList] = useState<HistoryItem[]>([]);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const t = window.setTimeout(() => void invoke<HistoryItem[]>("history_list", { scope, q }).then(setList), 150);
		return () => window.clearTimeout(t);
	}, [scope, q, tick]);
	useEffect(() => {
		const on = () => setTick((n) => n + 1);
		window.addEventListener("rb-history", on);
		return () => window.removeEventListener("rb-history", on);
	}, []);
	return (
		<div className="panel-fill">
			<div className="wb-bar">
				<input className="path-input" placeholder="기록 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
			</div>
			<div className="hist-list">
				{list.length === 0 && <div className="sb-empty" style={{ padding: 12 }}>기록이 없습니다</div>}
				{list.map((h) => (
					<button key={h.id} type="button" className={`hist-item${h.ok ? "" : " bad"}`} onClick={() => onInsert(`${h.sql};\n`)} onDoubleClick={() => onRun(h.sql)} title="누르면 편집기에, 두 번 누르면 실행">
						<code>{h.sql.length > 300 ? `${h.sql.slice(0, 300)}…` : h.sql}</code>
						<small>
							{new Date(h.at).toLocaleString()} · {h.ok ? `${h.rows ?? 0}행 · ${h.ms ?? 0} ms` : "실패"}
						</small>
					</button>
				))}
			</div>
		</div>
	);
}

/** 스키마 비교 — 같은 연결의 두 스키마: 한쪽에만 있는 표·열, 형식·NULL 이 다른 열 */
export function ComparePanel({ conn, a, b }: { conn: number; a: string; b: string }) {
	const [report, setReport] = useState<{ kind: "only-a" | "only-b" | "diff"; text: string }[] | null>(null);
	const [state, setState] = useState("비교 중…");
	useEffect(() => {
		const q = (s: string) => `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${s.replace(/'/g, "''")}'`;
		Promise.all([queryRows(conn, q(a), 100000), queryRows(conn, q(b), 100000)])
			.then(([ra, rb]) => {
				const map = (rows: (string | null)[][]) => {
					const m = new Map<string, Map<string, string>>();
					for (const r of rows) {
						const t = r[0] ?? "";
						if (!m.has(t)) m.set(t, new Map());
						m.get(t)?.set(r[1] ?? "", `${r[2]}${r[3] === "NO" ? " NOT NULL" : ""}`);
					}
					return m;
				};
				const A = map(ra);
				const B = map(rb);
				const out: { kind: "only-a" | "only-b" | "diff"; text: string }[] = [];
				for (const [t, cols] of A) {
					const other = B.get(t);
					if (!other) {
						out.push({ kind: "only-a", text: `표 ${t}` });
						continue;
					}
					for (const [c, ty] of cols) {
						const o = other.get(c);
						if (o === undefined) out.push({ kind: "only-a", text: `${t}.${c} (${ty})` });
						else if (o !== ty) out.push({ kind: "diff", text: `${t}.${c}: ${ty} ↔ ${o}` });
					}
					for (const [c, ty] of other) if (!cols.has(c)) out.push({ kind: "only-b", text: `${t}.${c} (${ty})` });
				}
				for (const t of B.keys()) if (!A.has(t)) out.push({ kind: "only-b", text: `표 ${t}` });
				setReport(out);
				setState(out.length ? `차이 ${out.length}개` : "두 스키마의 표·열이 같습니다");
			})
			.catch((e) => setState(String(e?.message ?? e)));
	}, [conn, a, b]);
	const groups = useMemo(() => ({ a: report?.filter((x) => x.kind === "only-a") ?? [], b: report?.filter((x) => x.kind === "only-b") ?? [], d: report?.filter((x) => x.kind === "diff") ?? [] }), [report]);
	return (
		<div className="panel-fill">
			<div className="compare selectable">
				<h4>{a} 에만 ({groups.a.length})</h4>
				{groups.a.map((x) => (
					<div key={x.text} className="cmp-a">
						− {x.text}
					</div>
				))}
				<h4>{b} 에만 ({groups.b.length})</h4>
				{groups.b.map((x) => (
					<div key={x.text} className="cmp-b">
						+ {x.text}
					</div>
				))}
				<h4>다른 열 ({groups.d.length})</h4>
				{groups.d.map((x) => (
					<div key={x.text} className="cmp-d">
						~ {x.text}
					</div>
				))}
			</div>
			<div className="statusbar">
				<span>{state}</span>
				<span style={{ marginLeft: "auto" }}>
					{a} ↔ {b}
				</span>
			</div>
		</div>
	);
}
