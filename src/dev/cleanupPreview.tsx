/**
 * 다듬기 화면 단독 미리보기(목업) — Rust 없이 화면만 본다. 예시 결과(cleanupSample.json)는
 * sqlclean 시험(dump_preview_sample, RB_DUMP=경로)이 실제 엔진으로 찍은 것이다. ?theme=dark|light
 * 작업대에 붙이지 않는다(붙이는 일은 DB 작업대 쪽 갈래가 한다).
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { type CleanResult, QueryCleanup } from "../components/QueryCleanup";
import sample from "./cleanupSample.json";

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

const base = sample.base as unknown as CleanResult;
const variants = sample.variants as unknown as Record<string, CleanResult>;

/** 결과 id → 첫 행 */
const rows = new Map<number, (string | null)[]>();
let seq = 0;

mockIPC(async (cmd, args) => {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (cmd) {
		case "sql_cleanup": {
			const off = (a.off as string[] | null) ?? [];
			if (off.length === 1 && variants[off[0]]) return variants[off[0]];
			// 둘 이상 끈 조합은 미리 찍지 않았다 — 표시만 끈 것으로
			return { ...base, changes: base.changes.map((c) => ({ ...c, on: !off.includes(c.id) })) };
		}
		case "sql_map":
			return { ok: true };
		case "sql_compare_sql":
			return sample.compare;
		case "db_query": {
			const q = String(a.sql);
			const id = ++seq;
			rows.set(id, [/ (EXCEPT|MINUS) /.test(q) ? "0" : "1284"]);
			await new Promise((r) => setTimeout(r, 180));
			return { resultId: id, columns: [{ name: "n", kind: "int" }], rowCount: 1, truncated: false, ms: 9 };
		}
		case "db_rows":
			return [rows.get(Number(a.result)) ?? []];
		case "db_result_close":
			return null;
		case "db_explain": {
			const cleaned = /LEFT JOIN \(/i.test(String(a.sql));
			await new Promise((r) => setTimeout(r, 160));
			return { format: "my-json", plan: JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: cleaned ? "1840.20" : "5321.40" } } }), ms: 4, rolledBack: false };
		}
		default:
			return null;
	}
});

function Preview() {
	const [text, setText] = useState(sample.sql);
	const ta = useRef<HTMLTextAreaElement>(null);
	return (
		<div className="qcp-page">
			<div className="qcp-editor">
				<div className="qcp-cap">SQL 편집기(미리보기) — 커서 문장</div>
				<textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
			</div>
			<div className="qcp-panel">
				<QueryCleanup
					sql={text}
					engine={sample.engine}
					conn={1}
					serverVersion="10.4.16-MariaDB"
					getMeta={async () => null}
					onApply={(t) => setText(t)}
					onHighlight={(r) => {
						if (r && ta.current) {
							ta.current.focus();
							ta.current.setSelectionRange(r[0], r[1]);
						}
					}}
				/>
			</div>
		</div>
	);
}

const css = `
html, body, #root { height: 100%; margin: 0; }
body { background: var(--window-solid, var(--surface)); }
.qcp-page { display: flex; flex-direction: column; height: 100%; gap: 0; }
.qcp-editor { flex: none; display: flex; flex-direction: column; border-bottom: 0.5px solid var(--hairline-strong); background: var(--surface); }
.qcp-cap { padding: 6px 12px; font: 12px var(--font-ui); color: var(--text-2); border-bottom: 0.5px solid var(--hairline); }
.qcp-editor textarea { height: 168px; resize: vertical; border: 0; outline: 0; padding: 8px 12px; background: var(--surface); color: var(--text); font: 12.5px/1.55 var(--font-mono); }
.qcp-panel { flex: 1; min-height: 0; }
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<Preview />
	</StrictMode>,
);
