/**
 * 저장 안 한 편집기 기록 — 탭 닫기·작업대(앱 탭) 닫기·앱 끄기 전에 묻기 위해.
 * 주인(owner)은 작업대 하나, 값은 그 안의 고친 편집기 칸 이름.
 */
const reg = new Map<string, Map<string, string>>();

export function setDirty(owner: string, panelId: string, title: string, dirty: boolean) {
	let m = reg.get(owner);
	if (!m) {
		m = new Map();
		reg.set(owner, m);
	}
	if (dirty) m.set(panelId, title);
	else m.delete(panelId);
}

export function isDirty(owner: string, panelId: string) {
	return reg.get(owner)?.has(panelId) ?? false;
}

/** 고친 파일 이름들 — owner 를 주면 그 작업대만 */
export function dirtyTitles(owner?: string): string[] {
	if (owner) return [...(reg.get(owner)?.values() ?? [])];
	return [...reg.values()].flatMap((m) => [...m.values()]);
}

export function forgetOwner(owner: string) {
	reg.delete(owner);
}

/** 열린 편집기들의 "초안 지금 쓰기" — 묻기 전에 불러 마지막 입력까지 초안에 남긴다(0.8초 멈춤을 기다리지 않고) */
const flushers = new Set<() => void>();
export function onDraftFlush(f: () => void): () => void {
	flushers.add(f);
	return () => flushers.delete(f);
}
export function flushDrafts() {
	for (const f of flushers) {
		try {
			f();
		} catch {
			// 한 편집기가 실패해도 나머지는 쓴다
		}
	}
}

/** 저장 안 한 것이 있으면 묻는다 — 계속하면 true */
export function confirmDiscard(titles: string[], what: string): boolean {
	if (!titles.length) return true;
	flushDrafts();
	const list = titles.slice(0, 8).join("\n· ");
	return confirm(`저장하지 않은 파일이 ${titles.length}개 있습니다.\n· ${list}${titles.length > 8 ? "\n…" : ""}\n\n${what} 고친 내용은 초안으로 남아 다음에 열 때 되살릴 수 있습니다. 계속할까요?`);
}

/** Ctrl+W — 앱이 보내고, 문서 칸에 초점이 있는 작업대가 그 칸만 닫고 preventDefault(서버 탭은 그대로) */
export const CLOSE_DOC_EVENT = "rb-close-doc";
