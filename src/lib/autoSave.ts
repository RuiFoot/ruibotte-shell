import { api } from "./ipc";

/**
 * 편집기 자동 저장 설정 — 앱 전체 한 벌(설정 › 편집기, 편집기 상태 줄 스위치가 같은 값을 바꾼다).
 * when: delay = 고치다 멈추고 delayMs 뒤 · blur = 편집기나 앱 창에서 포커스가 떠날 때 · both = 둘 다.
 * 확인 창 없이 저장하되 열고 나서 서버 파일이 바뀌었으면(mtime) 저장하지 않고 멈춘다(충돌 → 비교·덮어쓰기는 사람이).
 */
export type AutoSave = { on: boolean; when: "delay" | "blur" | "both"; delayMs: number };

export const AUTO_SAVE_DEFAULT: AutoSave = { on: false, when: "delay", delayMs: 1500 };
const EVENT = "rb-autosave";
let cur: AutoSave = AUTO_SAVE_DEFAULT;
let loaded: Promise<AutoSave> | null = null;

export function loadAutoSave(): Promise<AutoSave> {
	loaded ??= Promise.all([api.settingGet("editor.autosave"), api.settingGet("editor.autosave.when"), api.settingGet("editor.autosave.delay")])
		.then(([on, when, delay]) => {
			const d = Number(delay);
			cur = {
				on: on === "1",
				when: when === "blur" || when === "both" ? when : "delay",
				delayMs: Number.isFinite(d) && d >= 300 && d <= 60_000 ? d : AUTO_SAVE_DEFAULT.delayMs,
			};
			return cur;
		})
		.catch(() => cur);
	return loaded;
}

export function setAutoSave(next: AutoSave) {
	cur = next;
	loaded = Promise.resolve(next);
	void api.settingSet("editor.autosave", next.on ? "1" : "0");
	void api.settingSet("editor.autosave.when", next.when);
	void api.settingSet("editor.autosave.delay", String(next.delayMs));
	window.dispatchEvent(new CustomEvent<AutoSave>(EVENT, { detail: next }));
}

/** 다른 편집기·설정 화면에서 바뀌면 알림 */
export function onAutoSave(fn: (a: AutoSave) => void): () => void {
	const h = (e: Event) => fn((e as CustomEvent<AutoSave>).detail);
	window.addEventListener(EVENT, h);
	return () => window.removeEventListener(EVENT, h);
}

export function autoSaveWhenLabel(a: AutoSave): string {
	const s = `${a.delayMs / 1000}초`;
	return a.when === "delay" ? `멈추고 ${s} 뒤` : a.when === "blur" ? "포커스가 떠날 때" : `멈추고 ${s} 뒤·포커스가 떠날 때`;
}
