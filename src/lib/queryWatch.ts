/**
 * SQL 편집기 ↔ 쿼리 지도·튜닝 칸 잇기 — 편집기는 바뀔 때 "건드렸다"만 알리고(할 일 없음),
 * 보고 있는 칸이 있을 때만 그 칸이 멈춤 뒤에 문장을 읽는다. 입력 지연이 생기지 않게 여기서는 아무 계산도 하지 않는다.
 */
import type { EditorView } from "@codemirror/view";
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
}

/** 같은 문장인지(공백·끝 ; 차이 무시) */
export const sameSql = (a: string, b: string) => a.replace(/\s+/g, " ").replace(/;\s*$/, "").trim() === b.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
