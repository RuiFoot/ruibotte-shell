import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/querymap.css";
import { type AnalyzeDeps, tableMetaFor, useAnalysis } from "../lib/queryAnalysis";
import { currentView, markEditor } from "../lib/queryWatch";
import { QueryCleanup } from "./QueryCleanup";
import { QueryMapPanel } from "./QueryMap";
import { QueryTuningPanel, type TuningActions } from "./QueryTuning";

export type AnalysisTab = "map" | "diag" | "index" | "cleanup";

const TABS: { id: AnalysisTab; label: string; tip: string }[] = [
	{ id: "map", label: "구조", tip: "쿼리 지도 — 표·조인·조건 열을 그림으로" },
	{ id: "diag", label: "진단", tip: "구조·정적 검사·실행 계획 규칙의 지적 목록" },
	{ id: "index", label: "인덱스", tip: "WHERE·JOIN·ORDER 열에 맞춘 인덱스 초안(실행하지 않음)" },
	{ id: "cleanup", label: "다듬기", tip: "지저분한 쿼리를 구조째 정리 — 쉼표 조인·(+)·중첩 서브쿼리·중복 조건 등, 바꾼 곳마다 켜고 끄기·결과 같은지 확인" },
];

/**
 * 쿼리 분석 칸 — 쿼리 지도(구조)·튜닝 지적(진단)·인덱스 초안(인덱스)을 한 칸의 탭으로.
 *
 * 탭 내용은 겹쳐 두고 안 보이는 쪽은 visibility 로만 숨긴다 — display:none·떼어 내기로 숨기면
 * 크기 0 에서 지도를 맞춘 뒤 다시 보일 때 고치지 않아 잘리고 겹쳤다(0.14.0). 칸 자체가 가려져
 * 크기 0 이 됐다 돌아올 때는, 그 사이 문장 구조가 바뀌었으면 지도를 새로 그려 다시 맞춘다.
 */
export function QueryAnalysisPanel({ deps, visible, actions, tab, onTab, database }: { deps: AnalyzeDeps; visible: boolean; actions: TuningActions; tab: AnalysisTab; onTab: (t: AnalysisTab) => void; database: string }) {
	// 세 탭이 같은 분석기를 함께 본다(연결마다 하나) — 칸이 보이면 탭과 상관없이 편집기를 듣는다
	const { state, refresh } = useAnalysis(deps, visible);
	const snap = state.snap;
	const shapeRef = useRef<string | null>(null);
	shapeRef.current = snap?.shape ?? null;

	// 한 번 연 탭은 계속 붙여 둔다(비교 화면·지도 확대가 탭을 오가도 남게)
	const [mounted, setMounted] = useState<Record<AnalysisTab, boolean>>(() => ({ map: tab === "map", diag: tab === "diag" || tab === "index", index: false, cleanup: tab === "cleanup" }));
	useEffect(() => {
		const k = tab === "index" ? "diag" : tab;
		setMounted((m) => (m[k] ? m : { ...m, [k]: true }));
	}, [tab]);

	// 칸이 크기 0 이 됐다(가려짐) 돌아올 때 — 그 사이 구조가 바뀌었으면 지도를 다시 그린다
	const [mapKey, setMapKey] = useState(0);
	const hiddenShape = useRef<string | null>(visible ? null : "");
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const hide = () => {
			if (hiddenShape.current === null) hiddenShape.current = shapeRef.current ?? "";
		};
		const show = () => {
			const was = hiddenShape.current;
			if (was === null) return;
			hiddenShape.current = null;
			if (shapeRef.current !== null && shapeRef.current !== was) setMapKey((k) => k + 1);
		};
		if (!visible) return hide();
		const el = body.current;
		if (!el) return;
		if (el.clientWidth > 0 && el.clientHeight > 0) show();
		const ro = new ResizeObserver(([e]) => {
			const r = e.contentRect;
			if (r.width < 1 || r.height < 1) hide();
			else show();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [visible]);

	const meta = useMemo(() => {
		if (!snap) return null;
		const real = snap.map.tables.filter((t) => !t.virt && t.cte === null && t.derived === null);
		const names = new Set(real.map((t) => `${t.schema ?? ""}.${t.name}`.toLowerCase()));
		const metas = snap.resolved?.meta ?? [];
		const seen = new Set<string>();
		const schemas = new Set<string>();
		let indexes = 0;
		let known = false;
		for (const m of metas) {
			if (!m) continue;
			if (m.schema && m.schema !== "(기본)") schemas.add(m.schema);
			const k = `${m.schema}.${m.name}`.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			if (m.indexes) {
				known = true;
				indexes += m.indexes.length;
			}
		}
		return { tables: names.size, indexes: known ? indexes : null, schemas: [...schemas] };
		// biome 없음 — 구조(shape)가 바뀔 때만 다시 센다
	}, [snap?.shape]);
	const counts = useMemo(() => {
		const f = snap?.findings ?? [];
		const diag = f.filter((x) => x.layer === "map" || x.layer === "static");
		const idx = f.filter((x) => x.layer === "index");
		return { diag: diag.length, diagWarn: diag.some((x) => x.level === "warn"), index: idx.length };
	}, [snap?.findings]);

	// 다듬기 — 커서 문장을 바꿔 넣고(트랜잭션 하나, Ctrl+Z 로 되돌림) 원문 범위를 편집기에 칠한다
	const stmt = snap?.stmt ?? null;
	const stmtRef = useRef(stmt);
	stmtRef.current = stmt;
	const applyCleanup = useCallback(
		(text: string, original: string) => {
			const v = currentView(deps.conn);
			const s = stmtRef.current;
			// 넣기 직전 한 번 더 — 편집기의 그 범위 글이 다듬기가 받은 원문 그대로일 때만(그사이 고쳤거나 커서가 다른 문장이면 덮지 않는다)
			if (!v || !s || s.text !== original || v.state.sliceDoc(s.from, s.to) !== original) return;
			v.dispatch({ changes: { from: s.from, to: s.to, insert: text }, userEvent: "input.cleanup", scrollIntoView: true });
			v.focus();
		},
		[deps.conn],
	);
	const highlightCleanup = useCallback(
		(r: [number, number] | null) => {
			const s = stmtRef.current;
			markEditor(deps.conn, r && s ? [{ from: s.from + r[0], to: s.from + r[1] }] : [], !!r);
		},
		[deps.conn],
	);
	// 메타 조회는 같은 연결·epoch·엔진이면 같은 함수 — 실행·트랜잭션 상태는 부를 때 ref 로 읽는다(바뀔 때마다 다듬기가 처음부터 다시 하지 않게)
	const depsRef = useRef(deps);
	depsRef.current = deps;
	const { conn, epoch, engine, defaultSchema } = deps;
	// biome 없음 — conn·epoch·engine·defaultSchema 가 바뀔 때만 새 함수(running·inTx 는 depsRef 로)
	const getMeta = useCallback((schema: string | null, table: string) => tableMetaFor(depsRef.current, schema, table), [conn, epoch, engine, defaultSchema]);
	const serverBlocked = deps.inTx && deps.engine === "postgres" ? "열린 트랜잭션이 있어 서버에 묻지 않습니다(PostgreSQL — 오류 하나가 트랜잭션을 깨뜨립니다) — 커밋·되돌리기 뒤에 하세요" : null;

	const dbLabel = database || (meta?.schemas.length === 1 ? meta.schemas[0] : meta?.schemas.length ? `${meta.schemas[0]} 외 ${meta.schemas.length - 1}` : "");
	const metaText = [dbLabel || null, meta ? `표 ${meta.tables}` : null, meta?.indexes != null ? `인덱스 ${meta.indexes}` : null].filter(Boolean).join(" · ");

	return (
		<div className="panel-fill qa-panel">
			<div className="qa-head">
				<div className="qa-tabs" role="tablist" aria-label="쿼리 분석">
					{TABS.map((t) => {
						const n = t.id === "diag" ? counts.diag : t.id === "index" ? counts.index : 0;
						return (
							<button
								type="button"
								role="tab"
								key={t.id}
								aria-selected={tab === t.id}
								className={`qa-tab${tab === t.id ? " on" : ""}`}
								onClick={() => onTab(t.id)}
								title={t.tip}
							>
								{t.label}
								{n > 0 && <i className={t.id === "diag" && counts.diagWarn ? "warn" : ""}>{n}</i>}
							</button>
						);
					})}
				</div>
				<span className="qa-meta" title={snap ? `커서 문장 기준${state.busy ? " · 메타데이터 맞추는 중" : ""}` : undefined}>
					{metaText || (state.busy ? "맞추는 중…" : "")}
				</span>
				<button type="button" className="btn ghost icon qa-refresh" onClick={refresh} title="다시 읽기">
					<RefreshCw size={13} />
				</button>
			</div>
			<div className="qa-body" ref={body}>
				{mounted.map && (
					<div className={`qa-layer${tab === "map" ? " on" : ""}`} aria-hidden={tab !== "map"}>
						<QueryMapPanel key={mapKey} deps={deps} visible={visible && tab === "map"} onTuning={() => onTab("diag")} />
					</div>
				)}
				{mounted.diag && (
					<div className={`qa-layer${tab === "diag" || tab === "index" ? " on" : ""}`} aria-hidden={tab !== "diag" && tab !== "index"}>
						<QueryTuningPanel deps={deps} visible={visible && (tab === "diag" || tab === "index")} actions={actions} view={tab === "index" ? "index" : "diag"} />
					</div>
				)}
				{mounted.cleanup && (
					<div className={`qa-layer qa-cleanup${tab === "cleanup" ? " on" : ""}`} aria-hidden={tab !== "cleanup"}>
						{stmt ? (
							<QueryCleanup
								sql={stmt.text}
								engine={deps.engine}
								conn={deps.conn}
								getMeta={getMeta}
								onApply={applyCleanup}
								onHighlight={highlightCleanup}
								serverBlocked={serverBlocked}
							/>
						) : (
							<div className="qa-empty">SQL 편집기에서 다듬을 문장에 커서를 두세요.</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
