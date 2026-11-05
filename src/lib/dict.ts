/** 리눅스 명령어 사전(data/cmd-dict/dict.json, Orbit D24 에서 만든 데이터 그대로) — 처음 쓸 때 받는다 */
export type DictOpt = [flags: string, desc: string, arg?: string];
export type DictSub = { d: string; o?: DictOpt[]; a?: "path" | "dir"; al?: string[] };
export type DictCmd = { d: string; k: string[]; o?: DictOpt[]; s?: Record<string, DictSub>; a?: "path" | "dir"; x?: [string, string][] };
export type Dict = { v: number; src: { fig: string; tldr: string }; c: Record<string, DictCmd> };

let cache: Promise<Dict> | null = null;
let ready: Dict | null = null;

export function loadDict(): Promise<Dict> {
	cache ??= import("../../data/cmd-dict/dict.json").then((m) => {
		ready = (m as unknown as { default: Dict }).default;
		return ready;
	});
	return cache;
}

/** 이미 받았으면 바로 */
export function dictNow(): Dict | null {
	return ready;
}
