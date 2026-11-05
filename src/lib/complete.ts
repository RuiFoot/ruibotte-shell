/**
 * 터미널 자동완성 — 프롬프트에 친 줄을 낱말로 나눠 후보를 만든다(Orbit D7·D23·D24 와 같은 규칙).
 * - 첫 낱말: 명령(사전 + 서버 compgen + 지난 명령)
 * - '-' 로 시작: 그 명령(·하위 명령)의 옵션과 한국어 설명
 * - 하위 명령이 있는 명령의 둘째 낱말: 하위 명령
 * - 그 밖: 경로(트리와 같은 파일 목록, cd 는 폴더만)
 * 퍼지(앞부분 우선 → 포함 → 글자 순서) 정렬. 계산은 동기, 경로·명령 목록은 미리 받아 둔 캐시.
 */
import { dictNow } from "./dict";
import type { FsEntry } from "./ipc";

export type Candidate = { insert: string; label: string; desc?: string; kind: "cmd" | "sub" | "opt" | "path" | "hist" };

export type CompleteCtx = {
	/** 서버(또는 내 PC) 명령 목록 — compgen -c */
	commands: string[];
	/** 지난 명령(최근 먼저) */
	history: string[];
	/** 경로 목록 — 캐시에 있으면 바로, 없으면 null(받는 중) */
	listDir: (dir: string) => FsEntry[] | null;
	cwd: string | null;
	home: string | null;
};

/** 셸 낱말 나누기 — 따옴표·역슬래시 존중, 마지막 낱말은 끝까지(빈 낱말 포함) */
export function words(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === q) q = null;
			else cur += c;
		} else if (c === "'" || c === '"') q = c;
		else if (c === "\\" && i + 1 < line.length) cur += line[++i];
		else if (c === " ") {
			if (cur) out.push(cur);
			cur = "";
			if (i === line.length - 1) out.push("");
		} else cur += c;
	}
	if (cur || out.length === 0) out.push(cur);
	return out;
}

function score(label: string, q: string): number {
	if (!q) return 1;
	const l = label.toLowerCase();
	const s = q.toLowerCase();
	if (l.startsWith(s)) return 100 - Math.min(50, l.length - s.length);
	if (l.includes(s)) return 40;
	let i = 0;
	for (const ch of l) if (ch === s[i]) i++;
	return i === s.length ? 10 : 0;
}

function rank(list: Candidate[], q: string, limit = 60): Candidate[] {
	return list
		.map((c) => [c, score(c.label, q)] as const)
		.filter(([, s]) => s > 0)
		.sort((a, b) => b[1] - a[1] || a[0].label.localeCompare(b[0].label))
		.slice(0, limit)
		.map(([c]) => c);
}

const esc = (s: string) => s.replace(/([ '"\\$`!*?&;|<>(){}[\]])/g, "\\$1");

/** 후보 계산 — line 은 프롬프트 뒤 입력(커서까지). 바꿀 낱말 길이(replace)와 후보 */
export function complete(line: string, ctx: CompleteCtx): { replace: number; items: Candidate[]; pending?: string } {
	const ws = words(line);
	const cur = ws[ws.length - 1] ?? "";
	const dict = dictNow();
	const cmdName = ws[0] ?? "";
	const cmd = dict?.c[cmdName];
	// 1) 명령
	if (ws.length === 1) {
		const seen = new Set<string>();
		const items: Candidate[] = [];
		for (const h of ctx.history) {
			if (h.startsWith(cur) && h !== cur && !seen.has(h)) {
				seen.add(h);
				items.push({ insert: h, label: h, kind: "hist", desc: "지난 명령" });
				if (items.length >= 5) break;
			}
		}
		const names = new Set<string>([...Object.keys(dict?.c ?? {}), ...ctx.commands]);
		const cmds: Candidate[] = [];
		for (const n of names) cmds.push({ insert: n, label: n, desc: dict?.c[n]?.d, kind: "cmd" });
		return { replace: cur.length, items: [...items, ...rank(cmds, cur)].slice(0, 60) };
	}
	// 2) 옵션
	const sub = cmd?.s && ws.length > 2 ? cmd.s[ws[1]] : undefined;
	if (cur.startsWith("-") && cmd) {
		const opts = [...(sub?.o ?? []), ...(cmd.o ?? [])];
		const items: Candidate[] = [];
		for (const [flags, desc] of opts) for (const f of flags.split("|")) items.push({ insert: f, label: f, desc, kind: "opt" });
		return { replace: cur.length, items: rank(items, cur) };
	}
	// 3) 하위 명령
	if (ws.length === 2 && cmd?.s) {
		const items = Object.entries(cmd.s).map(([n, s]) => ({ insert: n, label: n, desc: s.d, kind: "sub" as const }));
		const ranked = rank(items, cur);
		if (ranked.length || !cur) return { replace: cur.length, items: ranked };
	}
	// 4) 경로
	const onlyDirs = cmdName === "cd" || cmdName === "pushd" || cmd?.a === "dir" || sub?.a === "dir";
	const slash = cur.lastIndexOf("/");
	const dirPart = slash >= 0 ? cur.slice(0, slash + 1) : "";
	const namePart = slash >= 0 ? cur.slice(slash + 1) : cur;
	let base = dirPart;
	if (base.startsWith("~")) base = (ctx.home ?? "") + base.slice(1);
	if (!base.startsWith("/")) base = `${ctx.cwd ?? ""}/${base}`;
	const dir = base.replace(/\/+$/, "") || "/";
	const list = ctx.listDir(dir);
	if (!list) return { replace: namePart.length, items: [], pending: dir };
	const items: Candidate[] = list
		.filter((e) => !onlyDirs || e.kind === "dir")
		.filter((e) => namePart.startsWith(".") || !e.name.startsWith("."))
		.map((e) => ({ insert: esc(e.name) + (e.kind === "dir" ? "/" : " "), label: e.name + (e.kind === "dir" ? "/" : ""), kind: "path" as const }));
	return { replace: namePart.length, items: rank(items, namePart, 80) };
}

/** 흐린 제안 — 지난 명령 가운데 지금 줄로 시작하는 가장 최근 것의 나머지 */
export function ghost(line: string, history: string[]): string {
	if (!line.trim()) return "";
	const h = history.find((x) => x.startsWith(line) && x.length > line.length);
	return h ? h.slice(line.length) : "";
}
