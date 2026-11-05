/** 마지막으로 포커스를 받은 터미널에 글 넣기(명령어 사전 → 터미널) */
let current: { write: (s: string) => void; label: string } | null = null;

export function setActiveTerminal(t: { write: (s: string) => void; label: string } | null) {
	current = t;
}

export function activeTerminal() {
	return current;
}

/** 붙여넣기 전에 한 번 더 보게 할 명령 */
export const DANGER = /(\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/?(\s|$|\*)|\brm\s+-[a-z]*r[a-z]*f|\bmkfs\b|\bdd\s+[^|]*of=\/dev\/|>\s*\/dev\/sd|\b(shutdown|reboot|poweroff|halt|init\s+0)\b|\bchmod\s+-R\s+777\s+\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bDROP\s+(DATABASE|TABLE)\b|\btruncate\s+table\b|\bkill\s+-9\s+-1\b|\bcrontab\s+-r\b|\biptables\s+-F\b)/i;
