import { MergeView } from "@codemirror/merge";
import { sql } from "@codemirror/lang-sql";
import { EditorView, lineNumbers } from "@codemirror/view";
import { AlertTriangle, ArrowLeftRight, Copy, CornerDownLeft, FilePlus, Info, Lightbulb, LocateFixed, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/querymap.css";
import { codeHighlight } from "../lib/cmTheme";
import { type AnalyzeDeps, useAnalysis } from "../lib/queryAnalysis";
import type { Finding } from "../lib/queryLint";
import { currentView, lastPlan, sameSql, subscribePlan } from "../lib/queryWatch";
import { type ExplainOk, planFindings, planTotals } from "./DbExplain";
import { wsConfig } from "./DiffView";
import { jumpTo } from "./QueryMap";

export type TuningActions = {
	/** 실행 계획(커서 문장) — 작업대의 실행 계획 칸이 열리고, 끝나면 여기 계획 규칙이 붙는다 */
	explain: () => void;
	/** 두 문장의 계획을 차례로(ANALYZE 는 묻고) — 실패하면 던진다 */
	explainPair: (a: string, b: string, analyze: boolean) => Promise<[ExplainOk, ExplainOk] | null>;
	openSql: (text: string, title: string) => void;
	canAnalyze: boolean;
};

const LAYERS: { key: Finding["layer"]; title: string }[] = [
	{ key: "map", title: "구조" },
	{ key: "static", title: "정적 검사" },
	{ key: "index", title: "인덱스" },
];

const fmt = (n?: number) => (n === undefined ? "—" : n >= 100 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** 원문 ↔ 제안 비교 — 오른쪽은 고칠 수 있다 */
function Compare({ a, b, actions, onClose, onReplace }: { a: string; b: string; actions: TuningActions; onClose: () => void; onReplace: (text: string) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const mv = useRef<MergeView | null>(null);
	const [res, setRes] = useState<{ a: ExplainOk; b: ExplainOk; analyze: boolean } | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!host.current) return;
		const ext = [lineNumbers(), codeHighlight, sql(), EditorView.lineWrapping, EditorView.theme({ "&": { fontSize: "12.5px", backgroundColor: "var(--surface)", color: "var(--text)" }, ".cm-scroller": { fontFamily: "var(--font-mono)" }, ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" } })];
		mv.current = new MergeView({
			parent: host.current,
			a: { doc: a, extensions: [...ext, EditorView.editable.of(false)] },
			b: { doc: b, extensions: ext },
			highlightChanges: true,
			gutter: true,
			diffConfig: wsConfig(false),
		});
		return () => {
			mv.current?.destroy();
			mv.current = null;
		};
	}, [a, b]);
	const right = () => mv.current?.b.state.doc.toString() ?? b;
	const run = async (analyze: boolean) => {
		setErr(null);
		setBusy(true);
		try {
			const r = await actions.explainPair(a, right(), analyze);
			if (r) setRes({ a: r[0], b: r[1], analyze });
		} catch (e) {
			setErr((e as { message?: string }).message ?? String(e));
		} finally {
			setBusy(false);
		}
	};
	const ta = res ? planTotals(res.a) : null;
	const tb = res ? planTotals(res.b) : null;
	const wa = res ? planFindings(res.a).length : 0;
	const wb = res ? planFindings(res.b).length : 0;
	const better = (x?: number, y?: number) => (x !== undefined && y !== undefined && x > 0 ? Math.round(((x - y) / x) * 100) : null);
	const dc = better(ta?.cost, tb?.cost);
	const dm = better(ta?.ms, tb?.ms);
	return (
		<div className="tn-compare">
			<div className="tn-compare-bar">
				<b>원문</b>
				<span style={{ flex: 1 }} />
				<b>제안(고칠 수 있음)</b>
			</div>
			<div className="tn-merge" ref={host} />
			{res && (
				<div className="tn-cmp-res">
					<span>
						{res.analyze ? "실제 계획" : "예상 계획"} — 비용 {fmt(ta?.cost)} → <b>{fmt(tb?.cost)}</b>
						{dc !== null && <em className={dc > 0 ? "good" : dc < 0 ? "bad" : ""}> ({dc > 0 ? `${dc}% 낮음` : dc < 0 ? `${-dc}% 높음` : "같음"})</em>}
					</span>
					{(ta?.ms !== undefined || tb?.ms !== undefined) && (
						<span>
							시간 {fmt(ta?.ms)} → <b>{fmt(tb?.ms)}</b> ms{dm !== null && <em className={dm > 0 ? "good" : dm < 0 ? "bad" : ""}> ({dm > 0 ? `${dm}% 빠름` : dm < 0 ? `${-dm}% 느림` : "같음"})</em>}
						</span>
					)}
					<span>
						계획 경고 {wa} → {wb}
					</span>
					{(res.a.rolledBack || res.b.rolledBack) && <span>쓰기 문장은 실행 뒤 되돌렸습니다</span>}
				</div>
			)}
			{err && <div className="tn-err">{err}</div>}
			<div className="statusbar">
				<button type="button" className="btn ghost" style={{ height: 20 }} disabled={busy} onClick={() => void run(false)} title="두 문장의 예상 계획을 차례로 봅니다(실행하지 않음)">
					<Play size={12} /> 둘 다 EXPLAIN
				</button>
				{actions.canAnalyze && (
					<button type="button" className="btn ghost" style={{ height: 20 }} disabled={busy} onClick={() => void run(true)} title="두 문장을 실제로 실행해 잽니다(쓰기 문장은 되돌림) — 묻고 실행">
						둘 다 ANALYZE…
					</button>
				)}
				{busy && <span>재는 중…</span>}
				<span style={{ marginLeft: "auto" }} />
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => onReplace(right())} title="편집기의 원래 문장을 제안으로 바꿉니다(Ctrl+Z 로 되돌림)">
					<CornerDownLeft size={12} /> 편집기 문장 바꾸기
				</button>
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={() => actions.openSql(right(), "튜닝 제안")}>
					<FilePlus size={12} /> 새 탭
				</button>
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={onClose}>
					<X size={12} /> 닫기
				</button>
			</div>
		</div>
	);
}

/** 튜닝 도우미 — 정적 검사 · 인덱스 초안 · 실행 계획 규칙을 한 목록으로 */
export function QueryTuningPanel({ deps, visible, actions }: { deps: AnalyzeDeps; visible: boolean; actions: TuningActions }) {
	const { state, refresh } = useAnalysis(deps, visible);
	const snap = state.snap;
	const snapRef = useRef(snap);
	snapRef.current = snap;
	const conn = deps.conn;
	const [planTick, setPlanTick] = useState(0);
	useEffect(() => subscribePlan(conn, () => setPlanTick((x) => x + 1)), [conn]);
	const [cmp, setCmp] = useState<{ a: string; b: string } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	// biome 없음 — planTick 은 다시 읽기 신호
	const plan = useMemo(() => {
		void planTick;
		const p = lastPlan(conn);
		return p && snap && sameSql(p.sql, snap.stmt.text) ? p : null;
	}, [conn, snap, planTick]);
	const planList = useMemo(() => (plan ? planFindings(plan.ok) : []), [plan]);

	const findings = snap?.findings ?? [];
	const replaceInEditor = (text: string) => {
		const v = currentView(conn);
		const s = snapRef.current;
		if (!v || !s) return;
		const cur = v.state.doc.sliceString(s.stmt.from, s.stmt.from + s.stmt.text.length);
		if (cur !== s.stmt.text) return alert("편집기의 문장이 그 사이 바뀌었습니다 — 다시 읽은 뒤 해 보세요");
		v.dispatch({ changes: { from: s.stmt.from, to: s.stmt.from + s.stmt.text.length, insert: text }, scrollIntoView: true });
		v.focus();
		setCmp(null);
	};
	const copy = (k: string, t: string) => {
		void navigator.clipboard.writeText(t);
		setCopied(k);
		window.setTimeout(() => setCopied((c) => (c === k ? null : c)), 1200);
	};

	const item = (f: Finding) => (
		<div key={f.key} className={`tn-item ${f.level}`}>
			<div className="tn-title">
				{f.level === "warn" ? <AlertTriangle size={13} /> : f.level === "info" ? <Info size={13} /> : <Lightbulb size={13} />}
				<b>{f.title}</b>
			</div>
			<div className="tn-why">{f.why}</div>
			{f.fix && <div className="tn-fix">{f.fix}</div>}
			{f.ddl && <pre className="tn-ddl selectable">{f.ddl}</pre>}
			<div className="tn-acts">
				{f.pos && (
					<button type="button" className="btn ghost" onClick={() => jumpTo(conn, snapRef.current, f.pos ?? undefined)}>
						<LocateFixed size={12} /> 위치
					</button>
				)}
				{f.rewrite && snap && (
					<button type="button" className="btn ghost" onClick={() => setCmp({ a: snap.stmt.text, b: f.rewrite as string })}>
						<ArrowLeftRight size={12} /> 바꿔 쓰기 비교
					</button>
				)}
				{f.ddl && (
					<>
						<button type="button" className="btn ghost" onClick={() => copy(f.key, f.ddl as string)} title="복사만 합니다 — 실행하지 않습니다">
							<Copy size={12} /> {copied === f.key ? "복사함" : "복사"}
						</button>
						<button type="button" className="btn ghost" onClick={() => actions.openSql(`-- 인덱스 초안: 확인한 뒤 직접 실행하세요(자동 실행하지 않음)\n${f.ddl}\n`, "인덱스 초안")} title="새 SQL 탭에 넣기만 합니다">
							<FilePlus size={12} /> 새 탭에 넣기
						</button>
					</>
				)}
			</div>
		</div>
	);

	if (cmp) return <Compare a={cmp.a} b={cmp.b} actions={actions} onClose={() => setCmp(null)} onReplace={replaceInEditor} />;

	return (
		<div className="panel-fill tuning-panel">
			<div className="tn-body selectable">
				{!snap && <div className="panel-hint">{state.off ?? "SQL 편집기에서 쿼리를 치면 튜닝 지적이 여기에 모입니다"}</div>}
				{snap?.stale && <div className="tn-stale">치는 중 — 마지막으로 읽은 문장의 지적입니다</div>}
				{snap &&
					LAYERS.map((l) => {
						const list = findings.filter((f) => f.layer === l.key);
						if (!list.length) return null;
						return (
							<section key={l.key}>
								<h4>
									{l.title} <small>{list.length}</small>
								</h4>
								{list.map(item)}
							</section>
						);
					})}
				{snap && (
					<section>
						<h4>
							실행 계획 <small>{plan ? planList.length : ""}</small>
						</h4>
						{!plan ? (
							<div className="tn-plan-empty">
								<span>이 문장의 실행 계획을 보면 계획 규칙(큰 표 전체 읽기, 예상·실제 행 차이, 디스크로 넘친 정렬·해시, filesort…)이 여기에 붙습니다.</span>
								<button type="button" className="btn ghost" onClick={actions.explain}>
									<Play size={12} /> 실행 계획 보기 Ctrl+E
								</button>
							</div>
						) : planList.length ? (
							planList.map((p, i) => (
								<div key={i} className="tn-item warn">
									<div className="tn-title">
										<AlertTriangle size={13} />
										<b>{p.node}</b>
									</div>
									<div className="tn-why">{p.text}</div>
								</div>
							))
						) : (
							<div className="tn-plan-empty">
								<span>{plan.analyze ? "실제 계획" : "예상 계획"}에서 걸리는 규칙이 없습니다.</span>
							</div>
						)}
					</section>
				)}
				{snap && !findings.length && !state.busy && <div className="panel-hint">지적할 것이 없습니다.</div>}
			</div>
			<div className="statusbar">
				<span>{snap ? `지적 ${findings.length + planList.length}개` : ""}</span>
				{snap?.note && <span title={snap.note}>{snap.note}</span>}
				{state.busy && <span>맞추는 중…</span>}
				<span style={{ marginLeft: "auto" }} title="SQL·스키마를 밖으로 보내지 않습니다 — 검사는 이 PC 에서, 메타데이터는 표마다 한 번만 읽어 둡니다">
					외부 전송 없음 · 인덱스는 초안만
				</span>
				<button type="button" className="btn ghost" style={{ height: 20 }} onClick={refresh} title="다시 읽기">
					<RefreshCw size={12} />
				</button>
			</div>
		</div>
	);
}
