import type { ITheme } from "@xterm/xterm";
import { api } from "./ipc";

/**
 * 화면 설정 — 앱 테마(시스템 따라·밝게·어둡게), 터미널 색 구성, 글꼴.
 * 앱 테마는 html[data-theme] 로 CSS 변수(밝은·어두운 짝)를 고른다. 편집기 강조 색(--syn-*)도 같은 짝을 따른다.
 * 바꾸면 APPEARANCE_EVENT 로 알리고, 열린 터미널은 options.theme·글꼴을, 편집기는 다시 재기를 한다.
 */

export type AppTheme = "system" | "light" | "dark";

export type Appearance = {
	app: AppTheme;
	/** 터미널 색 구성 id(TERM_SCHEMES) — "default" 는 앱 테마를 따른다 */
	termScheme: string;
	/** 터미널 글꼴 이름(비우면 앱 기본 고정폭) */
	termFont: string;
	termSize: number;
	termLine: number;
	/** 편집기 글꼴 이름(비우면 앱 기본 고정폭) */
	editorFont: string;
	editorSize: number;
	editorLine: number;
	/** 서버(프로필)별 터미널 색 덮어쓰기 — 프로필 번호 → 색 구성 id */
	byProfile: Record<string, string>;
};

export const APPEARANCE_EVENT = "rb-appearance";

export const APPEARANCE_KEYS = {
	app: "ui.theme",
	termScheme: "term.scheme",
	termFont: "term.fontFamily",
	termSize: "term.fontSize",
	termLine: "term.lineHeight",
	editorFont: "editor.fontFamily",
	editorSize: "editor.fontSize",
	editorLine: "editor.lineHeight",
	byProfile: "term.scheme.byProfile",
} as const;

const DEFAULTS: Appearance = { app: "system", termScheme: "default", termFont: "", termSize: 13, termLine: 1.15, editorFont: "", editorSize: 13, editorLine: 1.55, byProfile: {} };

export type TermScheme = { id: string; label: string; dark: boolean; theme?: ITheme };

const ansi = (a: string[]) => ({
	black: a[0],
	red: a[1],
	green: a[2],
	yellow: a[3],
	blue: a[4],
	magenta: a[5],
	cyan: a[6],
	white: a[7],
	brightBlack: a[8],
	brightRed: a[9],
	brightGreen: a[10],
	brightYellow: a[11],
	brightBlue: a[12],
	brightMagenta: a[13],
	brightCyan: a[14],
	brightWhite: a[15],
});

const SOLARIZED = ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"];

/** 터미널 색 구성 — 색 값은 각 테마가 공개한 표준 팔레트 */
export const TERM_SCHEMES: TermScheme[] = [
	{ id: "default", label: "기본(앱 테마 따라)", dark: false },
	{
		id: "solarized-dark",
		label: "Solarized Dark",
		dark: true,
		theme: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#073642", ...ansi(SOLARIZED) },
	},
	{
		id: "solarized-light",
		label: "Solarized Light",
		dark: false,
		theme: { background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", cursorAccent: "#fdf6e3", selectionBackground: "#eee8d5", ...ansi(SOLARIZED) },
	},
	{
		id: "one-dark",
		label: "One Dark",
		dark: true,
		theme: {
			background: "#282c34",
			foreground: "#abb2bf",
			cursor: "#528bff",
			cursorAccent: "#282c34",
			selectionBackground: "#3e4451",
			...ansi(["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]),
		},
	},
	{
		id: "dracula",
		label: "Dracula",
		dark: true,
		theme: {
			background: "#282a36",
			foreground: "#f8f8f2",
			cursor: "#f8f8f2",
			cursorAccent: "#282a36",
			selectionBackground: "#44475a",
			...ansi(["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
		},
	},
	{
		id: "nord",
		label: "Nord",
		dark: true,
		theme: {
			background: "#2e3440",
			foreground: "#d8dee9",
			cursor: "#d8dee9",
			cursorAccent: "#2e3440",
			selectionBackground: "#434c5e",
			...ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
		},
	},
	{
		id: "gruvbox-dark",
		label: "Gruvbox Dark",
		dark: true,
		theme: {
			background: "#282828",
			foreground: "#ebdbb2",
			cursor: "#ebdbb2",
			cursorAccent: "#282828",
			selectionBackground: "#504945",
			...ansi(["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
		},
	},
	{
		id: "github-light",
		label: "GitHub Light",
		dark: false,
		theme: {
			background: "#ffffff",
			foreground: "#24292f",
			cursor: "#0969da",
			cursorAccent: "#ffffff",
			selectionBackground: "rgba(9,105,218,0.2)",
			...ansi(["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
		},
	},
];

/** 고를 수 있는 고정폭 글꼴(내 PC 에 없으면 다음 글꼴로 넘어간다) */
export const MONO_FONTS = ["D2Coding", "JetBrains Mono", "Cascadia Mono", "Cascadia Code", "Consolas", "SF Mono", "Menlo", "Fira Code", "Source Code Pro", "Ubuntu Mono"];

let current: Appearance = { ...DEFAULTS };

// 앱 DB 를 읽기 전(첫 화면)에도 고른 밝기로 — 시작할 때 반대 밝기로 번쩍이지 않게 지난 값을 웹 저장소에서 바로 쓴다
const EARLY_KEY = "rb.theme";
try {
	const early = localStorage.getItem(EARLY_KEY);
	if (early === "light" || early === "dark") {
		document.documentElement.dataset.theme = early;
		current = { ...current, app: early };
	}
} catch {
	// 무시
}
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export const getAppearance = () => current;

/** 지금 앱이 어두운 화면인지(시스템 따라면 OS 설정) */
export function isDark(a: Appearance = current): boolean {
	if (a.app === "dark") return true;
	if (a.app === "light") return false;
	return !!mq?.matches;
}

/** 글꼴 이름 → CSS font-family(앱 기본 고정폭을 뒤에 받쳐 둔다) */
function fontStack(name: string): string {
	const base = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
	const n = name.trim().replace(/["\\;{}]/g, "");
	return n ? `"${n}", ${base}` : base;
}
export const termFontFamily = (a: Appearance = current) => fontStack(a.termFont);

/** 이 서버(없으면 앱 설정)의 터미널 색 구성 */
export function schemeFor(profileId?: number | null, a: Appearance = current): TermScheme {
	const id = (profileId != null && a.byProfile[String(profileId)]) || a.termScheme;
	return TERM_SCHEMES.find((s) => s.id === id) ?? TERM_SCHEMES[0];
}

/** xterm 색 — 기본은 CSS 변수(앱 테마의 밝은·어두운 짝), 그 밖은 프리셋 */
export function termTheme(profileId?: number | null, a: Appearance = current): ITheme {
	const s = schemeFor(profileId, a);
	if (s.theme) return s.theme;
	const cs = getComputedStyle(document.documentElement);
	const v = (n: string) => cs.getPropertyValue(n).trim();
	return { background: v("--term-bg"), foreground: v("--term-fg"), cursor: v("--accent"), selectionBackground: "rgba(10,132,255,0.28)" };
}

function num(v: string | null, def: number, min: number, max: number) {
	const n = Number(v);
	return v && Number.isFinite(n) && n >= min && n <= max ? n : def;
}

function parseMap(v: string | null): Record<string, string> {
	try {
		const o = v ? JSON.parse(v) : {};
		return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** html 에 반영 — data-theme·편집기 글꼴 변수, 창(OS 바탕)의 밝기 */
function applyDom(a: Appearance) {
	const root = document.documentElement;
	if (a.app === "system") delete root.dataset.theme;
	else root.dataset.theme = a.app;
	try {
		localStorage.setItem(EARLY_KEY, a.app);
	} catch {
		// 저장소를 못 쓰면 다음 시작 때 잠깐 시스템 밝기로 보였다가 바뀐다
	}
	root.style.setProperty("--editor-font", fontStack(a.editorFont));
	root.style.setProperty("--editor-size", `${a.editorSize}px`);
	root.style.setProperty("--editor-line", String(a.editorLine));
	// OS 가 그리는 창 바탕(Mica·vibrancy)과 기본 창 단추도 같은 밝기로 — 안 되는 환경이면 조용히 넘어간다
	void import("@tauri-apps/api/window")
		.then(({ getCurrentWindow }) => getCurrentWindow().setTheme(a.app === "system" ? null : a.app))
		.catch(() => undefined);
}

/** 열린 편집기(CodeMirror)가 글꼴·줄 간격 바뀐 것을 다시 재게 */
function remeasureEditors() {
	const els = document.querySelectorAll<HTMLElement>(".cm-editor");
	if (!els.length) return;
	// 편집기 코드는 처음 열 때 받는다 — 첫 화면에 싣지 않게 그때 가져온다
	void import("@codemirror/view").then(({ EditorView }) => {
		for (const el of els) EditorView.findFromDOM(el)?.requestMeasure();
	});
}

function notify() {
	window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
	requestAnimationFrame(remeasureEditors);
}

/** 앱을 켤 때 한 번 — 저장한 화면 설정을 읽어 반영 */
export async function loadAppearance(): Promise<Appearance> {
	const g = (k: string) => api.settingGet(k).catch(() => null);
	const [app, ts, tf, tz, tl, ef, es, el, bp] = await Promise.all([
		g(APPEARANCE_KEYS.app),
		g(APPEARANCE_KEYS.termScheme),
		g(APPEARANCE_KEYS.termFont),
		g(APPEARANCE_KEYS.termSize),
		g(APPEARANCE_KEYS.termLine),
		g(APPEARANCE_KEYS.editorFont),
		g(APPEARANCE_KEYS.editorSize),
		g(APPEARANCE_KEYS.editorLine),
		g(APPEARANCE_KEYS.byProfile),
	]);
	current = {
		app: app === "light" || app === "dark" ? app : "system",
		termScheme: TERM_SCHEMES.some((s) => s.id === ts) ? (ts as string) : "default",
		termFont: tf ?? "",
		termSize: num(tz, DEFAULTS.termSize, 8, 32),
		termLine: num(tl, DEFAULTS.termLine, 1, 2),
		editorFont: ef ?? "",
		editorSize: num(es, DEFAULTS.editorSize, 9, 28),
		editorLine: num(el, DEFAULTS.editorLine, 1, 2.4),
		byProfile: parseMap(bp),
	};
	applyDom(current);
	notify();
	return current;
}

/** 화면 설정 바꾸기 — 저장하고 바로 반영 */
export function setAppearance(patch: Partial<Appearance>) {
	current = { ...current, ...patch };
	for (const [k, v] of Object.entries(patch) as [keyof Appearance, Appearance[keyof Appearance]][]) {
		void api.settingSet(APPEARANCE_KEYS[k], typeof v === "object" ? JSON.stringify(v) : String(v));
	}
	applyDom(current);
	notify();
}

/** 서버 하나의 터미널 색 덮어쓰기(빈 값이면 앱 설정 따름) */
export function setProfileScheme(profileId: number, scheme: string) {
	const byProfile = { ...current.byProfile };
	if (scheme && scheme !== "inherit") byProfile[String(profileId)] = scheme;
	else delete byProfile[String(profileId)];
	setAppearance({ byProfile });
}

/** 바뀔 때마다 부르기 — 해제 함수를 돌려준다 */
export function onAppearance(fn: () => void): () => void {
	window.addEventListener(APPEARANCE_EVENT, fn);
	return () => window.removeEventListener(APPEARANCE_EVENT, fn);
}

// 시스템 따라일 때 OS 가 밝기를 바꾸면 그대로 알린다
mq?.addEventListener("change", () => {
	if (current.app === "system") notify();
});
