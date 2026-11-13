/**
 * 쿼리 다듬기 — 지저분한 레거시 문장 하나를 구조적으로 정리해(Rust sql_cleanup) 원문과 나란히 비교한다.
 * 바꾼 것마다 켜고 끌 수 있고(끄면 그 항목만 빼고 다시 만든다), safe(의미가 같음)·check(결과 확인 권장)를 표시한다.
 * "결과 같은지 확인"은 SELECT 일 때만 — 행 수와 차이 행 수(EXCEPT) 또는 열별 집계를 시간 상한을 걸어 읽는다.
 *
 * 붙이는 쪽(DB 작업대)이 넘기는 것: sql·engine·conn, 표 메타데이터 조회, 편집기에 넣기(트랜잭션 하나), 원문 범위 강조.
 * 이 화면은 서버에 쓰지 않는다 — 비교 SQL 은 읽기 문장만 만든다.
 */
import { MergeView } from "@codemirror/merge";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Check, CircleCheck, Copy, CornerDownLeft, Gauge, Info, Play, RefreshCw, Scale, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/sqlclean.css";
import { codeHighlight } from "../lib/cmTheme";
import type { IndexInfo } from "../lib/dbtools";
import type { ColMeta } from "../lib/edits";
import { runBackground } from "../lib/queryWatch";
import { formatSqlText } from "../lib/sqlFormat";
import { type ExplainOk, planFindings, planTotals } from "./DbExplain";
import { wsConfig } from "./DiffView";

export type CleanChange = {
	id: string;
	kind: string;
	safety: "safe" | "check";
	title: string;
	detail: string;
	/** 원문 안의 UTF-16 [시작, 끝) */
	pos: [number, number] | null;
	on: boolean;
};

export type CleanResult = {
	ok: boolean;
	error: string | null;
	kind: string;
	dialect: string;
	text: string;
	changed: boolean;
	changes: CleanChange[];
	comments: { total: number; kept: number; moved: number };
	tables: { schema: string | null; name: string }[];
	notes: string[];
};

type CleanMeta = { tables: { schema: string | null; name: string; cols: { name: string; pk: boolean }[]; unique: string[][] }[] };

type CompareSql = { ok: boolean; reason: string | null; mode: "except" | "hash" | "count" | ""; cols: number; steps: { key: string; label: string; sql: string }[] };

/** 표 메타데이터 한 개(못 읽었으면 null) — 튜닝 칸이 캐시한 것과 같은 모양 */
export type CleanTableMeta = { cols: ColMeta[] | null; indexes: IndexInfo[] | null } | null;

export type QueryCleanupProps = {
	/** 다듬을 문장 하나(편집기의 커서 문장) */
	sql: string;
	engine: string;
	conn: number;
	/** 표 메타데이터 조회 — 열 한정·안 쓰는 LEFT JOIN 지우기에 쓴다(없으면 그 변환만 건너뛴다) */
	getMeta?: (schema: string | null, table: string) => Promise<CleanTableMeta>;
	/**
	 * 편집기의 그 문장을 정리본으로 바꾼다 — 붙이는 쪽이 CodeMirror 트랜잭션 하나로(Ctrl+Z 로 되돌림).
	 * original 은 다듬기가 받은 원문 — 붙이는 쪽은 편집기의 그 범위 글이 이것과 같을 때만 바꾼다(다른 문장을 덮지 않게)
	 */
	onApply: (newSql: string, original: string) => void;
	/** 원문 범위 강조(UTF-16, 문장 안 위치) — null 이면 지우기 */
	onHighlight?: (range: [number, number] | null) => void;
	/** 서버 버전 문자열(EXCEPT 지원 판별 — MySQL 8.0.31·MariaDB 10.3 이상) */
	serverVersion?: string | null;
	keywordCase?: "upper" | "lower" | "preserve";
	/** 실행 계획 — 기본은 db_explain(ANALYZE 없이) */
	explain?: (sql: string) => Promise<ExplainOk>;
	/** 결과 첫 행 하나 읽기(비교용) — 기본은 db_query → db_rows. 같은 연결의 실행 줄을 붙이는 쪽이 관리하면 넘긴다 */
	queryFirstRow?: (sql: string, timeoutMs: number) => Promise<(string | null)[] | null>;
	/** 비교 문장 시간 상한(ms, 기본 15초) */
	timeoutMs?: number;
	/** 서버에 묻지 못하는 까닭(PostgreSQL 트랜잭션 중 등) — 있으면 결과 확인·EXPLAIN 을 끄고 이 글을 툴팁으로 */
	serverBlocked?: string | null;
};

/** 화면에서만 붙이는 항목 — 정렬은 sql-formatter(Shift+Alt+F 와 같은 규칙) */
const FORMAT_ID = "format";

const KIND_LABEL: Record<string, string> = {
	commaJoin: "조인",
	outerJoin: "조인",
	alias: "별칭",
	qualify: "별칭",
	trueCond: "조건",
	parens: "조건",
	dupCond: "조건",
	inOne: "조건",
	notCmp: "조건",
	orToIn: "조건",
	distinctGroup: "묶음",
	unusedCte: "CTE",
	repeatToCte: "CTE",
	flattenDerived: "서브쿼리",
	scalarToJoin: "서브쿼리",
	notInExists: "서브쿼리",
	havingToWhere: "묶음",
	dropLeftJoin: "조인",
	format: "정렬",
};

const mergeTheme = EditorView.theme({
	"&": { fontSize: "12.5px", backgroundColor: "var(--surface)", color: "var(--text)" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none" },
});

type Verify =
	| { state: "busy"; note: string }
	| { state: "error"; note: string }
	| { state: "done"; same: boolean | null; mode: string; rows: [string, string][]; note: string };

type Plans = { state: "busy" } | { state: "error"; note: string } | { state: "done"; a: ExplainOk; b: ExplainOk };

/** 다듬은 결과 — src 는 그때 받은 원문(지금 sql 과 다르면 낡은 결과) */
type Res = CleanResult & { src: string };

const fmtNum = (n?: number) => (n === undefined ? "—" : n >= 100 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function QueryCleanup({ sql, engine, conn, getMeta, onApply, onHighlight, serverVersion, keywordCase = "upper", explain, queryFirstRow, timeoutMs = 15000, serverBlocked }: QueryCleanupProps) {
	const [res, setRes] = useState<Res | null>(null);
	const [busy, setBusy] = useState(false);
	const [off, setOff] = useState<string[]>([]);
	const [fmtOn, setFmtOn] = useState(true);
	/** 왼쪽을 정렬해서 비교(구조 차이만 보이게) · 원문 그대로 */
	const [leftFmt, setLeftFmt] = useState(true);
	const [texts, setTexts] = useState<{ left: string; right: string; src: string } | null>(null);
	const [active, setActive] = useState<string | null>(null);
	const [verify, setVerify] = useState<Verify | null>(null);
	const [plans, setPlans] = useState<Plans | null>(null);
	const [copied, setCopied] = useState(false);
	const metaRef = useRef<{ sql: string; meta: CleanMeta | null } | null>(null);
	const seq = useRef(0);
	// 메타 조회 함수가 새로 와도(붙이는 쪽 다시 그리기) 처음부터 다시 하지 않는다 — 다시 하는 것은 문장·엔진이 바뀔 때만
	const getMetaRef = useRef(getMeta);
	getMetaRef.current = getMeta;

	const run = useCallback(
		async (src: string, offIds: string[], withMeta: CleanMeta | null): Promise<Res> => ({ ...(await invoke<CleanResult>("sql_cleanup", { sql: src, engine, meta: withMeta, off: offIds })), src }),
		[engine],
	);

	// 문장이 바뀌면 처음부터 — 지난 결과·비교·확인을 바로 비우고(다른 문장의 정리본을 넣지 않게), 먼저 메타데이터 없이 읽고 표 목록으로 메타데이터를 채워 한 번 더
	useEffect(() => {
		const my = ++seq.current;
		setOff([]);
		setVerify(null);
		setPlans(null);
		setActive(null);
		setRes(null);
		setTexts(null);
		if (!sql.trim()) return;
		setBusy(true);
		const t = window.setTimeout(async () => {
			try {
				const first = await run(sql, [], null);
				if (my !== seq.current) return;
				setRes(first);
				let meta: CleanMeta | null = null;
				const gm = getMetaRef.current;
				if (first.ok && gm && first.tables.length) {
					const got = await Promise.all(
						first.tables.slice(0, 40).map(async (t) => {
							try {
								const m = await gm(t.schema, t.name);
								if (!m?.cols?.length) return null;
								const unique = (m.indexes ?? []).filter((i) => (i.unique || i.primary) && !i.partial && i.cols.every((c) => c !== null)).map((i) => i.cols as string[]);
								return { schema: t.schema, name: t.name, cols: m.cols.map((c) => ({ name: c.name, pk: c.pk })), unique };
							} catch {
								return null;
							}
						}),
					);
					const tables = got.filter((x): x is NonNullable<typeof x> => !!x);
					if (tables.length) meta = { tables };
				}
				if (my !== seq.current) return;
				metaRef.current = { sql, meta };
				if (meta) {
					const second = await run(sql, [], meta);
					if (my !== seq.current) return;
					setRes(second);
				}
			} catch (e) {
				if (my === seq.current) setRes({ ok: false, error: String((e as { message?: string }).message ?? e), kind: "other", dialect: engine, text: sql, changed: false, changes: [], comments: { total: 0, kept: 0, moved: 0 }, tables: [], notes: [], src: sql });
			} finally {
				if (my === seq.current) setBusy(false);
			}
		}, 200);
		return () => window.clearTimeout(t);
	}, [sql, engine, run]);

	const toggle = async (id: string) => {
		if (id === FORMAT_ID) {
			setFmtOn((v) => !v);
			return;
		}
		const next = off.includes(id) ? off.filter((x) => x !== id) : [...off, id];
		setOff(next);
		setVerify(null);
		setPlans(null);
		const my = ++seq.current;
		setBusy(true);
		try {
			const r = await run(sql, next, metaRef.current?.sql === sql ? metaRef.current.meta : null);
			if (my === seq.current) setRes(r);
		} finally {
			if (my === seq.current) setBusy(false);
		}
	};

	// 정리본·왼쪽 글 만들기(정렬은 sql-formatter — 다시 읽히는지 sql_map 으로 확인하고 못 읽히면 정렬 전 글)
	useEffect(() => {
		if (!res) {
			setTexts(null);
			return;
		}
		let gone = false;
		const src = res.src;
		void (async () => {
			const base = res.changed ? res.text : src;
			let right = base;
			if (fmtOn) {
				const f = await formatSqlText(base, engine, keywordCase);
				if (f !== null && f !== base) {
					const chk = await invoke<{ ok: boolean }>("sql_map", { sql: f, engine }).catch(() => ({ ok: false }));
					if (chk.ok) right = f;
				}
			}
			let left = src;
			if (leftFmt) left = (await formatSqlText(src, engine, keywordCase)) ?? src;
			if (!gone) setTexts({ left: left.replace(/\r\n?/g, "\n"), right: right.replace(/\r\n?/g, "\n"), src });
		})();
		return () => {
			gone = true;
		};
	}, [res, fmtOn, leftFmt, engine, keywordCase]);

	const changes = useMemo<CleanChange[]>(() => {
		const list = res?.changes ?? [];
		if (!res?.ok) return list;
		const fmt: CleanChange = { id: FORMAT_ID, kind: "format", safety: "safe", title: "키워드 대소문자·들여쓰기 통일", detail: "포맷터(Shift+Alt+F)와 같은 규칙", pos: null, on: fmtOn };
		return [...list, fmt];
	}, [res, fmtOn]);
	const onCount = changes.filter((c) => c.on).length;
	const safeCount = changes.filter((c) => c.on && c.safety === "safe").length;
	const checkCount = changes.filter((c) => c.on && c.safety === "check").length;
	// 결과가 지금 문장의 것일 때만(문장이 바뀐 직후의 낡은 정리본으로 넣기·비교하지 않게)
	const fresh = !!texts && texts.src === sql && res?.src === sql;
	const output = fresh ? (texts?.right ?? "") : "";
	const dirty = fresh && !!res?.ok && output.trim() !== "" && output !== sql;
	const isSelect = res?.kind === "select";

	// 비교 화면
	const host = useRef<HTMLDivElement>(null);
	const mv = useRef<MergeView | null>(null);
	useEffect(() => {
		if (!host.current || !texts) return;
		const ext = [lineNumbers(), codeHighlight, sqlLang(), mergeTheme, EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
		mv.current = new MergeView({
			parent: host.current,
			a: { doc: texts.left, extensions: ext },
			b: { doc: texts.right, extensions: ext },
			highlightChanges: true,
			gutter: true,
			diffConfig: wsConfig(true),
		});
		return () => {
			mv.current?.destroy();
			mv.current = null;
		};
	}, [texts]);

	const pick = (c: CleanChange) => {
		setActive(c.id);
		onHighlight?.(c.pos);
		// 왼쪽이 원문 그대로일 때만 같은 위치를 비교 칸에서도 고른다
		if (c.pos && !leftFmt && mv.current) {
			const a = mv.current.a;
			const len = a.state.doc.length;
			const [from, to] = [Math.min(c.pos[0], len), Math.min(c.pos[1], len)];
			a.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
		}
	};

	// 기본 구현은 같은 연결의 뒤 조회 줄로(사용자 실행과 BUSY 로 부딪히지 않게 — 실행 중이면 "BUSY" 로 실패), 시간 상한 유지
	const firstRow = useCallback(
		async (q: string, ms: number): Promise<(string | null)[] | null> => {
			if (queryFirstRow) return queryFirstRow(q, ms);
			return runBackground(conn, async () => {
				const ok = await invoke<{ resultId?: number | null; rowCount: number }>("db_query", { conn, sql: q, maxRows: 2, timeoutMs: ms, stream: null });
				if (!ok.resultId) return null;
				try {
					const rows = await invoke<(string | null)[][]>("db_rows", { result: ok.resultId, from: 0, to: Math.min(1, ok.rowCount) });
					return rows[0] ?? null;
				} finally {
					void invoke("db_result_close", { result: ok.resultId });
				}
			});
		},
		[conn, queryFirstRow],
	);
	const busyNote = (e: unknown) => {
		const x = e as { message?: string; code?: string };
		const m = String(x?.message ?? e);
		return m === "BUSY" || x?.code === "BUSY" ? "쿼리가 실행 중이라 하지 않았습니다 — 끝난 뒤 다시 하세요" : m;
	};

	const runVerify = async () => {
		if (!isSelect || !output || serverBlocked) return;
		const src = sql;
		setVerify({ state: "busy", note: "비교 SQL 만드는 중…" });
		try {
			const c = await invoke<CompareSql>("sql_compare_sql", { a: src, b: output, engine, version: serverVersion ?? null });
			if (!c.ok) return setVerify({ state: "error", note: c.reason ?? "비교할 수 없는 문장입니다" });
			const got: Record<string, (string | null)[] | null> = {};
			for (const s of c.steps) {
				setVerify({ state: "busy", note: `${s.label} 읽는 중…` });
				got[s.key] = await firstRow(s.sql, timeoutMs);
			}
			const n = (k: string) => {
				const v = got[k]?.[0];
				return v === null || v === undefined ? undefined : Number(v);
			};
			const rows: [string, string][] = [];
			let same: boolean | null = null;
			if (c.mode === "except") {
				const [a, b, ab, ba] = [n("countA"), n("countB"), n("aMinusB"), n("bMinusA")];
				rows.push(["행 수", `${fmtNum(a)} → ${fmtNum(b)}`], ["원문에만 있는 행", fmtNum(ab)], ["정리본에만 있는 행", fmtNum(ba)]);
				same = a !== undefined && a === b && ab === 0 && ba === 0;
			} else if (c.mode === "hash") {
				const a = got.sumA ?? [];
				const b = got.sumB ?? [];
				rows.push(["행 수", `${fmtNum(n("sumA"))} → ${fmtNum(n("sumB"))}`], ["열별 집계", a.length && a.join("|") === b.join("|") ? `${c.cols}개 열 모두 같음` : "다름"]);
				same = a.length > 0 && a.join("|") === b.join("|");
			} else {
				const [a, b] = [n("countA"), n("countB")];
				rows.push(["행 수", `${fmtNum(a)} → ${fmtNum(b)}`]);
				same = a !== undefined && a === b ? null : false;
			}
			const note =
				c.mode === "except"
					? "순서는 보지 않습니다. 중복 행 개수 차이는 행 수로만 봅니다."
					: c.mode === "hash"
						? "이 서버는 EXCEPT 가 없어 행 수와 열별 집계(CRC 합·최솟값·최댓값)로 비교했습니다."
						: "열 목록이 * 라 행 수만 비교했습니다.";
			setVerify({ state: "done", same, mode: c.mode, rows, note });
		} catch (e) {
			setVerify({ state: "error", note: busyNote(e) });
		}
	};

	const runPlans = async () => {
		if (!output || serverBlocked) return;
		setPlans({ state: "busy" });
		const ex = explain ?? ((q: string) => runBackground(conn, () => invoke<ExplainOk>("db_explain", { conn, sql: q, analyze: false })));
		try {
			const a = await ex(sql);
			const b = await ex(output);
			setPlans({ state: "done", a, b });
		} catch (e) {
			setPlans({ state: "error", note: busyNote(e) });
		}
	};

	const copy = () => {
		void navigator.clipboard.writeText(output);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	};

	const planRow = plans?.state === "done" ? { ta: planTotals(plans.a), tb: planTotals(plans.b), wa: planFindings(plans.a).length, wb: planFindings(plans.b).length } : null;
	const better = (x?: number, y?: number) => (x !== undefined && y !== undefined && x > 0 ? Math.round(((x - y) / x) * 100) : null);
	const dc = planRow ? better(planRow.ta.cost, planRow.tb.cost) : null;

	return (
		<div className="qc-root">
			<div className="qc-head">
				<Sparkles size={14} className="qc-head-icon" />
				<b>다듬기</b>
				{res?.ok && (
					<span className="qc-sum">
						바꾼 것 {onCount}
						<span className="qc-dot" />
						<span className="qc-safe-t">안전 {safeCount}</span>
						<span className="qc-dot" />
						<span className="qc-check-t">확인 권장 {checkCount}</span>
					</span>
				)}
				{busy && <span className="qc-busy">다듬는 중…</span>}
				<span className="qc-grow" />
				<div className="qc-seg" role="group" aria-label="왼쪽 보기">
					<button type="button" className={leftFmt ? "on" : ""} onClick={() => setLeftFmt(true)} title="원문도 같은 규칙으로 정렬해 구조 차이만 보입니다">
						정렬해서 비교
					</button>
					<button type="button" className={!leftFmt ? "on" : ""} onClick={() => setLeftFmt(false)} title="원문을 손대지 않고 그대로 — 항목을 누르면 왼쪽에서도 그 자리를 고릅니다">
						원문 그대로
					</button>
				</div>
			</div>

			{res && !res.ok ? (
				<div className="qc-error">
					<AlertTriangle size={16} />
					<div>
						<b>손대지 않았습니다</b>
						<p>{res.error}</p>
						<p className="qc-sub">처리하지 못하는 문법이면 틀린 SQL 을 내지 않으려고 원문을 그대로 둡니다.</p>
					</div>
				</div>
			) : (
				<div className="qc-body">
					<div className="qc-list selectable">
						{!res && <div className="qc-empty">{sql.trim() ? "읽는 중…" : "SQL 편집기의 커서 문장을 다듬습니다"}</div>}
						{res?.ok && changes.length === 1 && !res.changed && <div className="qc-empty">구조를 고칠 곳이 없습니다 — 정렬만 할 수 있습니다.</div>}
						{changes.map((c) => (
							<div key={c.id} className={`qc-item${c.on ? "" : " off"}${active === c.id ? " active" : ""}`}>
								<input type="checkbox" checked={c.on} aria-label={`${c.title} 켜기`} onChange={() => void toggle(c.id)} />
								<button type="button" className="qc-item-main" onClick={() => pick(c)} title={c.pos ? "원문에서 이 자리 보기" : undefined}>
									<span className="qc-item-top">
										<span className={`qc-badge ${c.safety}`}>
											{c.safety === "safe" ? <ShieldCheck size={11} /> : <Scale size={11} />}
											{c.safety === "safe" ? "안전" : "확인"}
										</span>
										<span className="qc-kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
									</span>
									<span className="qc-title">{c.title}</span>
									{c.detail && <span className="qc-detail">{c.detail}</span>}
								</button>
							</div>
						))}
						{res?.ok && (res.comments.total > 0 || res.notes.length > 0) && (
							<div className="qc-notes">
								{res.comments.total > 0 && (
									<div>
										<Info size={12} />
										<span>
											원문 주석 {res.comments.total}개 —{" "}
											{res.comments.moved ? `${res.comments.kept}개는 제자리 근처에, ${res.comments.moved}개는 붙일 자리를 못 찾아 맨 앞에 모았습니다` : "모두 가까운 자리에 옮겨 붙였습니다"}
										</span>
									</div>
								)}
								{res.notes.map((n) => (
									<div key={n}>
										<Info size={12} />
										<span>{n}</span>
									</div>
								))}
							</div>
						)}
					</div>
					<div className="qc-diff">
						<div className="qc-diff-bar">
							<span>{leftFmt ? "원문(정렬만)" : "원문"}</span>
							<span>정리본</span>
						</div>
						<div className="qc-merge" ref={host} />
					</div>
				</div>
			)}

			{(verify || plans) && (
				<div className="qc-results">
					{verify && (
						<div className={`qc-res ${verify.state === "done" ? (verify.same === true ? "good" : verify.same === false ? "bad" : "") : verify.state === "error" ? "bad" : ""}`}>
							<div className="qc-res-head">
								{verify.state === "done" && verify.same === true ? <CircleCheck size={14} /> : verify.state === "busy" ? <RefreshCw size={13} className="qc-spin" /> : <Scale size={14} />}
								<b>{verify.state === "busy" ? "결과 비교 중" : verify.state === "error" ? "비교하지 못함" : verify.same === true ? "결과가 같습니다" : verify.same === false ? "결과가 다릅니다" : "행 수는 같습니다"}</b>
							</div>
							{verify.state === "done" ? (
								<>
									<dl>
										{verify.rows.map(([k, v]) => (
											<div key={k}>
												<dt>{k}</dt>
												<dd>{v}</dd>
											</div>
										))}
									</dl>
									<p>{verify.note}</p>
								</>
							) : (
								<p>{verify.note}</p>
							)}
						</div>
					)}
					{plans && (
						<div className={`qc-res ${dc !== null ? (dc > 0 ? "good" : dc < 0 ? "bad" : "") : plans.state === "error" ? "bad" : ""}`}>
							<div className="qc-res-head">
								{plans.state === "busy" ? <RefreshCw size={13} className="qc-spin" /> : <Gauge size={14} />}
								<b>{plans.state === "busy" ? "실행 계획 읽는 중" : plans.state === "error" ? "실행 계획을 못 읽음" : "예상 비용"}</b>
							</div>
							{plans.state === "error" && <p>{plans.note}</p>}
							{planRow && (
								<dl>
									<div>
										<dt>비용</dt>
										<dd>
											{fmtNum(planRow.ta.cost)} → {fmtNum(planRow.tb.cost)}
											{dc !== null && <em>{dc > 0 ? ` ${dc}% 낮음` : dc < 0 ? ` ${-dc}% 높음` : " 같음"}</em>}
										</dd>
									</div>
									<div>
										<dt>계획 경고</dt>
										<dd>
											{planRow.wa} → {planRow.wb}
										</dd>
									</div>
								</dl>
							)}
						</div>
					)}
				</div>
			)}

			<div className="statusbar qc-bar">
				<button
					type="button"
					className="btn ghost qc-btn"
					disabled={!isSelect || !dirty || verify?.state === "busy" || !!serverBlocked}
					onClick={() => void runVerify()}
					title={serverBlocked || (isSelect ? `원문과 정리본을 각각 읽어 행 수·차이 행을 셉니다(읽기만, ${Math.round(timeoutMs / 1000)}초 상한)` : "SELECT 문장만 결과를 비교합니다")}
				>
					<Check size={12} /> 결과 같은지 확인
				</button>
				<button type="button" className="btn ghost qc-btn" disabled={!dirty || plans?.state === "busy" || !!serverBlocked} onClick={() => void runPlans()} title={serverBlocked || "두 문장의 예상 계획을 차례로 봅니다(실행하지 않음)"}>
					<Play size={12} /> 둘 다 EXPLAIN
				</button>
				<span className="qc-grow" />
				<span className="qc-local" title="문장을 밖으로 보내지 않습니다 — 다듬기는 이 PC 에서">
					외부 전송 없음
				</span>
				<button type="button" className="btn ghost qc-btn" disabled={!output} onClick={copy}>
					<Copy size={12} /> {copied ? "복사함" : "복사"}
				</button>
				<button type="button" className="btn primary qc-btn" disabled={!dirty} onClick={() => texts && onApply(output, texts.src)} title="편집기의 이 문장을 정리본으로 바꿉니다(Ctrl+Z 로 되돌림)">
					<CornerDownLeft size={12} /> 편집기에 넣기
				</button>
			</div>
		</div>
	);
}
