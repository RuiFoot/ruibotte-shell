import { api } from "./ipc";

/** 터미널 출력 단어 색칠 규칙(사용자 추가분) */
export type HiRule = { word: string; color: string };

/** 터미널 설정 중 기록·색칠·rz/sz — 설정 화면이 바꾸면 TERM_PREFS_EVENT 로 열린 터미널에 알린다 */
export type TermPrefs = {
	/** 새 터미널을 열면 바로 기록 */
	logAuto: boolean;
	/** 기록 폴더(비우면 앱 데이터의 logs) */
	logDir: string;
	logStrip: boolean;
	logStamp: boolean;
	hiOn: boolean;
	hiWords: HiRule[];
	zmOn: boolean;
	/** rz/sz 기본 받기 폴더(비우면 그때그때 고르기) */
	zmDir: string;
};

export const TERM_PREFS_EVENT = "rb-term-prefs";

export const PREF_KEYS = {
	logAuto: "term.log.auto",
	logDir: "term.log.dir",
	logStrip: "term.log.stripAnsi",
	logStamp: "term.log.timestamps",
	hiOn: "term.highlight",
	hiWords: "term.highlight.words",
	zmOn: "term.zmodem",
	zmDir: "term.zmodem.dir",
} as const;

/** 고를 수 있는 색(어두운·밝은 바탕 모두에서 읽히는 것) */
export const HI_COLORS = [
	{ value: "#ff453a", label: "빨강" },
	{ value: "#ff9f0a", label: "주황" },
	{ value: "#ffd60a", label: "노랑" },
	{ value: "#30d158", label: "초록" },
	{ value: "#0a84ff", label: "파랑" },
	{ value: "#bf5af2", label: "보라" },
	{ value: "#ff375f", label: "분홍" },
];

export function parseWords(v: string | null): HiRule[] {
	if (!v) return [];
	try {
		const a = JSON.parse(v);
		return Array.isArray(a) ? a.filter((x) => x && typeof x.word === "string" && typeof x.color === "string" && x.word.trim()).slice(0, 50) : [];
	} catch {
		return [];
	}
}

export async function loadTermPrefs(): Promise<TermPrefs> {
	const g = (k: string) => api.settingGet(k).catch(() => null);
	const [la, ld, ls, lt, ho, hw, zo, zd] = await Promise.all([
		g(PREF_KEYS.logAuto),
		g(PREF_KEYS.logDir),
		g(PREF_KEYS.logStrip),
		g(PREF_KEYS.logStamp),
		g(PREF_KEYS.hiOn),
		g(PREF_KEYS.hiWords),
		g(PREF_KEYS.zmOn),
		g(PREF_KEYS.zmDir),
	]);
	return {
		logAuto: la === "1",
		logDir: ld ?? "",
		logStrip: ls !== "0",
		logStamp: lt === "1",
		hiOn: ho !== "0",
		hiWords: parseWords(hw),
		zmOn: zo !== "0",
		zmDir: zd ?? "",
	};
}

export function notifyTermPrefs() {
	window.dispatchEvent(new CustomEvent(TERM_PREFS_EVENT));
}
