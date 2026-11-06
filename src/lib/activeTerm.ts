/** 마지막으로 포커스를 받은 터미널에 글 넣기(명령어 사전 → 터미널) */
export type ActiveTerminal = {
	write: (s: string) => void;
	label: string;
	/** 리눅스 셸이면(D25) — {{빈칸}} 템플릿으로 넣기 */
	template?: (s: string) => void;
	/** 리눅스 셸이면(D25) — 폼 칸 후보(그 터미널 폴더·서버) */
	candidates?: (src: "files" | "dirs" | "paths" | "services" | "timers" | "containers" | "images" | "users" | "groups" | "interfaces") => Promise<string[]>;
};
let current: ActiveTerminal | null = null;

export function setActiveTerminal(t: ActiveTerminal | null) {
	current = t;
}

export function activeTerminal() {
	return current;
}

/** 붙여넣기 전에 한 번 더 보게 할 명령 */
export const DANGER = /(\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/?(\s|$|\*)|\brm\s+-[a-z]*r[a-z]*f|\bmkfs\b|\bdd\s+[^|]*of=\/dev\/|>\s*\/dev\/sd|\b(shutdown|reboot|poweroff|halt|init\s+0)\b|\bchmod\s+-R\s+777\s+\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bDROP\s+(DATABASE|TABLE)\b|\btruncate\s+table\b|\bkill\s+-9\s+-1\b|\bcrontab\s+-r\b|\biptables\s+-F\b)/i;
