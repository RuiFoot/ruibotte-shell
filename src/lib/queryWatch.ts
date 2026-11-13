/**
 * SQL 편집기 ↔ 쿼리 지도·튜닝 칸 잇기 — 편집기는 바뀔 때 "건드렸다"만 알리고(할 일 없음),
 * 보고 있는 칸이 있을 때만 그 칸이 멈춤 뒤에 문장을 읽는다. 입력 지연이 생기지 않게 여기서는 아무 계산도 하지 않는다.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { ExplainOk } from "../components/DbExplain";

type Plan = { sql: string; ok: ExplainOk; analyze: boolean; at: number };
type W = { view: EditorView | null; listeners: Set<() => void>; plan: Plan | null; planListeners: Set<() => void> };

const watches = new Map<number, W>();
function w(conn: number): W {
	let x = watches.get(conn);
	if (!x) {
		x = { view: null, listeners: new Set(), plan: null, planListeners: new Set() };
		watches.set(conn, x);
	}
	return x;
}

/** 편집기가 글·커서·포커스가 바뀌었다고 알린다 — 듣는 칸이 없으면 기억만 */
export function touchEditor(conn: number, view: EditorView) {
	const x = watches.get(conn) ?? w(conn);
	x.view = view;
	for (const f of x.listeners) f();
}

/** 편집기가 사라질 때 */
export function dropEditor(conn: number, view: EditorView) {
	const x = watches.get(conn);
	if (x?.view === view) {
		x.view = null;
		for (const f of x.listeners) f();
	}
}

export function currentView(conn: number): EditorView | null {
	return watches.get(conn)?.view ?? null;
}

export function subscribeEditor(conn: number, f: () => void): () => void {
	const x = w(conn);
	x.listeners.add(f);
	return () => x.listeners.delete(f);
}

/** 실행 계획을 본 뒤 — 튜닝 칸이 같은 문장이면 계획 규칙을 함께 보여 준다 */
export function publishPlan(conn: number, sql: string, ok: ExplainOk, analyze: boolean) {
	const x = w(conn);
	x.plan = { sql, ok, analyze, at: Date.now() };
	for (const f of x.planListeners) f();
}

export function lastPlan(conn: number): Plan | null {
	return watches.get(conn)?.plan ?? null;
}

export function subscribePlan(conn: number, f: () => void): () => void {
	const x = w(conn);
	x.planListeners.add(f);
	return () => x.planListeners.delete(f);
}

/** 연결이 닫히면 */
export function forgetWatch(conn: number) {
	watches.delete(conn);
	bg.delete(conn);
	held.delete(conn);
}

/**
 * 뒤에서 도는 메타데이터 조회(인덱스·FK) — 같은 연결의 db_query 는 한 번에 하나라(BUSY),
 * 연결마다 한 줄로 세우고, 사용자 실행은 waitBackground 로 그 줄이 빌 때까지(상한) 기다렸다 나간다.
 */
const bg = new Map<number, Promise<unknown>>();
/** 사용자 실행이 이 연결을 쓰는 중(실행 직전부터 끝까지) — 그동안 뒤 조회는 나가지 않는다 */
const held = new Set<number>();
export function holdBackground(conn: number, on: boolean) {
	if (on) held.add(conn);
	else held.delete(conn);
}
export function runBackground<T>(conn: number, f: () => Promise<T>): Promise<T> {
	const prev = bg.get(conn) ?? Promise.resolve();
	const next = prev
		.catch(() => undefined)
		.then(() => {
			if (held.has(conn)) throw new Error("BUSY");
			return f();
		});
	const tail = next.catch(() => undefined);
	bg.set(conn, tail);
	void tail.then(() => {
		if (bg.get(conn) === tail) bg.delete(conn);
	});
	return next;
}
/** 뒤 조회가 끝나기를 기다린다(최대 ms) — 끝났으면 바로 */
export async function waitBackground(conn: number, ms = 4000): Promise<void> {
	const p = bg.get(conn);
	if (!p) return;
	await Promise.race([p, new Promise((r) => window.setTimeout(r, ms))]);
}
/** 지금 뒤 조회가 도는가 */
export const backgroundBusy = (conn: number) => bg.has(conn);

/** 같은 문장인지(공백·끝 ; 차이 무시) */
export const sameSql = (a: string, b: string) => a.replace(/\s+/g, " ").replace(/;\s*$/, "").trim() === b.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();

/*
 * 쿼리 지도 → 편집기 강조 — 그래프에서 단계를 누르면 그 절(WHERE …, JOIN … ON …)의 배경을 칠하고 그곳으로 굴린다.
 * 선택·커서는 건드리지 않는다. 글을 고치면 지운다(위치가 낡으니).
 */
const setMarks = StateEffect.define<{ from: number; to: number }[]>();
const markDeco = Decoration.mark({ class: "cm-qm-mark" });
const markTheme = EditorView.baseTheme({
	".cm-qm-mark": { backgroundColor: "color-mix(in srgb, var(--accent, #0a84ff) 22%, transparent)", borderRadius: "2px", boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent, #0a84ff) 30%, transparent)" },
});
const markField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(v, tr) {
		for (const e of tr.effects)
			if (e.is(setMarks)) {
				const len = tr.state.doc.length;
				const list = e.value
					.filter((r) => r.to > r.from && r.from >= 0 && r.to <= len)
					.sort((a, b) => a.from - b.from)
					.map((r) => markDeco.range(r.from, r.to));
				return Decoration.set(list, true);
			}
		return tr.docChanged ? Decoration.none : v;
	},
	provide: (f) => EditorView.decorations.from(f),
});
/** SQL 편집기에 붙이는 확장(쿼리 지도 강조) */
export const queryMapMarks = [markField, markTheme];

/** 편집기의 범위를 칠한다(빈 목록이면 지운다) — 첫 범위로 굴린다 */
export function markEditor(conn: number, ranges: { from: number; to: number }[], scroll = true) {
	const v = currentView(conn);
	if (!v) return;
	// 확장을 붙이지 않은 편집기여도 동작하게
	if (v.state.field(markField, false) === undefined) v.dispatch({ effects: StateEffect.appendConfig.of(queryMapMarks) });
	const effects: StateEffect<unknown>[] = [setMarks.of(ranges)];
	if (scroll && ranges.length) effects.push(EditorView.scrollIntoView(ranges[0].from, { y: "nearest", yMargin: 40 }));
	v.dispatch({ effects });
}
