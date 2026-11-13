/**
 * 저장·반영 안 한 기록 — 탭 닫기·작업대(앱 탭) 닫기·앱 끄기 전에 묻기 위해.
 * 주인(owner)은 작업대 하나, 값은 그 안의 고친 칸 이름. 편집기 파일(저장 안 함)과 DB 결과 표 편집(`db:<연결>` 주인,
 * 칸 이름 `db-edit-<결과 칸>`, 반영 안 함)이 같은 곳에 올라온다.
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

/** 칸 하나의 기록 이름(없으면 undefined) */
export function dirtyTitleOf(owner: string, panelId: string): string | undefined {
	return reg.get(owner)?.get(panelId);
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

/**
 * 저장·반영 안 한 것이 있으면 묻는다 — 계속하면 true.
 * 항목은 편집기 파일(저장 안 함)과 DB 표 편집(반영 안 함) 둘 다다. 파일은 초안으로 남지만 표 편집은 사라진다.
 */
export function confirmDiscard(titles: string[], what: string): boolean {
	// 묻지 않고 끝나는 경우(앱 끄기에 다른 항목이 없을 때)에도 대기 중인 초안은 쓴다
	flushDrafts();
	if (!titles.length) return true;
	const list = titles.slice(0, 8).join("\n· ");
	return confirm(
		`저장·반영하지 않은 항목이 ${titles.length}개 있습니다.\n· ${list}${titles.length > 8 ? "\n…" : ""}\n\n${what} 계속할까요?\n(편집기 글은 초안으로 남아 다음에 열 때 되살릴 수 있지만, DB 표 편집은 반영하지 않으면 사라집니다.)`,
	);
}

/** Ctrl+W — 앱이 보내고, 문서 칸에 초점이 있는 작업대가 그 칸만 닫고 preventDefault(서버 탭은 그대로) */
export const CLOSE_DOC_EVENT = "rb-close-doc";
