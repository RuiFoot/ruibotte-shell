import { useEffect, useRef } from "react";
import { initials, isCho } from "./hangul";
import { api } from "./ipc";

/**
 * 명령 팔레트(Ctrl+Shift+P · ⌘⇧P) 등록소.
 * 화면마다 자기 명령을 scope 이름으로 등록하고, 사라지거나 가려지면 해제한다.
 * 같은 scope 로 다시 등록하면 앞의 것을 바꾼다. 목록 대신 함수를 주면 팔레트를 열 때마다 새로 부른다(지금 상태를 반영).
 */

export type CommandGroup = "conn" | "tabs" | "work" | "db" | "app" | "files";

export const GROUP_LABEL: Record<CommandGroup, string> = {
	conn: "서버·DB 연결",
	tabs: "열린 탭",
	work: "지금 작업대",
	db: "DB 작업대",
	app: "앱",
	files: "최근 파일",
};
/** 결과 묶음 순서 */
export const GROUP_ORDER: CommandGroup[] = ["work", "db", "conn", "tabs", "files", "app"];

export type Command = {
	/** 최근 실행 기록에 쓰는 고정 이름 — 예: "wb.newTerminal", "conn.card.12" */
	id: string;
	title: string;
	group: CommandGroup;
	/** 제목 옆 흐린 설명 */
	hint?: string;
	/** 단축키 — "Mod+Shift+P" 처럼(Mod = Ctrl, 맥은 ⌘) */
	keys?: string;
	/** 찾기에만 쓰는 낱말(보이지 않음) */
	keywords?: string;
	/** 지금 쓸 수 없으면 흐리게(누르면 이유를 hint 로) */
	disabled?: boolean;
	run: () => void | Promise<void>;
};

type Provider = Command[] | (() => Command[]);
const registry = new Map<string, Provider>();

/** 명령 등록 — 해제 함수를 돌려준다. 같은 scope 를 다시 등록하면 바꾼다 */
export function registerCommands(scope: string, list: Provider): () => void {
	registry.set(scope, list);
	return () => {
		if (registry.get(scope) === list) registry.delete(scope);
	};
}

export function unregisterCommands(scope: string) {
	registry.delete(scope);
}

/** 지금 등록된 명령 전부(팔레트를 열 때 부른다) */
export function allCommands(): Command[] {
	const out: Command[] = [];
	const seen = new Set<string>();
	for (const p of registry.values()) {
		let list: Command[] = [];
		try {
			list = typeof p === "function" ? p() : p;
		} catch {
			list = [];
		}
		for (const c of list) {
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			out.push(c);
		}
	}
	return out;
}

/**
 * 화면 컴포넌트용 — enabled 인 동안만 등록(작업대가 앞에 보일 때만 그 작업대 명령).
 * build 는 그릴 때마다 바뀌어도 되며, 팔레트를 열 때 마지막 것을 부른다.
 */
export function useCommands(scope: string, enabled: boolean, build: () => Command[]) {
	const ref = useRef(build);
	ref.current = build;
	useEffect(() => {
		if (!enabled) return;
		return registerCommands(scope, () => ref.current());
	}, [scope, enabled]);
}

/** 팔레트 열기(단추·다른 화면에서) */
export const OPEN_PALETTE_EVENT = "rb-open-palette";
export function openPalette(query = "") {
	window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: query }));
}

/** "Mod+Shift+P" → 맥 ⌘⇧P, 그 밖 Ctrl+Shift+P */
export function fmtKeys(keys: string): string {
	const mac = document.documentElement.dataset.os === "macos";
	if (!mac) return keys.replaceAll("Mod+", "Ctrl+");
	return keys
		.split(" · ")
		.map((k) =>
			k
				.replace(/Mod\+/g, "⌘")
				.replace(/Ctrl\+/g, "⌃")
				.replace(/Shift\+/g, "⇧")
				.replace(/Alt\+/g, "⌥"),
		)
		.join(" · ");
}

/** 찾기 점수(0 이면 안 맞음) — 낱말마다 제목·설명·숨은 낱말, 초성 */
export function scoreCommand(c: Command, words: string[]): number {
	if (!words.length) return 1;
	const title = c.title.toLowerCase();
	const rest = `${c.hint ?? ""} ${c.keywords ?? ""} ${GROUP_LABEL[c.group]}`.toLowerCase();
	let s = 0;
	for (const w of words) {
		let hit = 0;
		if (title.startsWith(w)) hit = 40;
		else if (title.split(/[\s›·@:()/-]+/).some((x) => x.startsWith(w))) hit = 30;
		else if (title.includes(w)) hit = 22;
		else if (rest.includes(w)) hit = 10;
		else if (isCho(w)) {
			if (initials(title).replace(/\s+/g, "").includes(w)) hit = 18;
			else if (initials(rest).replace(/\s+/g, "").includes(w)) hit = 6;
		}
		if (!hit) return 0;
		s += hit;
	}
	return s;
}

/** 최근 실행한 명령(위로 올린다) — 앱 설정에 id 만 */
const RECENT_KEY = "palette.recent";
let recent: string[] = [];
let recentLoaded = false;
export async function loadRecentCommands(): Promise<string[]> {
	if (recentLoaded) return recent;
	try {
		const v = await api.settingGet(RECENT_KEY);
		const a = v ? (JSON.parse(v) as unknown) : [];
		recent = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
	} catch {
		recent = [];
	}
	recentLoaded = true;
	return recent;
}
export function noteCommandRun(id: string) {
	recent = [id, ...recent.filter((x) => x !== id)].slice(0, 20);
	void api.settingSet(RECENT_KEY, JSON.stringify(recent));
}

/** 설정의 한 묶음으로 바로 — 설정 화면이 아직 안 열렸으면 열릴 때 가져간다 */
export type SettingsSection = "update" | "appearance" | "editor" | "terminal" | "termlog" | "highlight" | "start" | "help";
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; keywords: string }[] = [
	{ id: "appearance", label: "화면(테마·색·글꼴)", keywords: "테마 다크 밝게 어둡게 색 구성 글꼴 폰트 theme font color" },
	{ id: "update", label: "업데이트", keywords: "버전 update" },
	{ id: "editor", label: "편집기", keywords: "자동 저장 editor" },
	{ id: "terminal", label: "터미널", keywords: "셸 자동완성 스크롤백 rz sz zmodem" },
	{ id: "termlog", label: "터미널 기록", keywords: "로그 log 세션 기록" },
	{ id: "highlight", label: "터미널 단어 색칠", keywords: "강조 error warn highlight" },
	{ id: "start", label: "시작", keywords: "자동 실행 autostart" },
	{ id: "help", label: "문제 해결", keywords: "데이터 폴더 문제 보고 릴리스" },
];
export const SETTINGS_GOTO_EVENT = "rb-settings-goto";
let pendingSection: SettingsSection | null = null;
export function requestSettingsSection(id: SettingsSection) {
	pendingSection = id;
	window.dispatchEvent(new CustomEvent(SETTINGS_GOTO_EVENT, { detail: id }));
}
export function takeSettingsSection(): SettingsSection | null {
	const s = pendingSection;
	pendingSection = null;
	return s;
}
