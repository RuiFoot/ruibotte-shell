/** 한글 초성(ㄱ~ㅎ) — "ㅇㅊ" 로 "압축" 찾기. 명령어 사전·명령 팔레트가 함께 쓴다 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 글자마다 초성으로(한글이 아닌 글자는 그대로) */
export function initials(s: string) {
	let out = "";
	for (const ch of s) {
		const c = ch.charCodeAt(0) - 0xac00;
		out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
	}
	return out;
}

/** 초성만으로 된 낱말인지 */
export const isCho = (w: string) => /^[ㄱ-ㅎ]+$/.test(w);
