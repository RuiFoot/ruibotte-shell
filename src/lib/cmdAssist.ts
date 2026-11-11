/**
 * 명령 입력 보조(D25)를 앱에 잇는 곳 — 규칙·데이터(cmd-assist/assist.ts·assist.json)는 웹 Orbit 과 같은 판을 그대로 쓰고(고치지 않음),
 * 여기서는 옵션 설명 출처(손 스펙 > D24 사전 > 서버 man)·후보 출처(SFTP/로컬 목록·읽기 전용 명령)·위험 표시만 붙인다.
 */
import { DANGER } from "./activeTerm";
import { ASSIST, type AssistForm, allForms, type FieldSource, type OptLookup, parseTemplate, type SubLookup } from "./cmd-assist/assist";
import { dictNow, loadDict } from "./dict";
import type { FsEntry } from "./ipc";
import { SPECS } from "./specs";

export {
	ASSIST,
	allForms,
	buildForm,
	explainLine,
	hasTemplateFields,
	initialValues,
	parseTemplate,
	signatureAt,
} from "./cmd-assist/assist";
export type { AssistField, AssistForm, ExplainPart, FieldSource, FormValues, SigView, TplField } from "./cmd-assist/assist";

/** 바로 실행(스니펫 Ctrl+Enter 등) — 빈칸을 기본값으로 채운 글자 */
export const fillTemplate = (raw: string) => parseTemplate(raw).text;

/** 폼 전부(명령 이름과 함께) — assist.json 판에 따라 수가 바뀐다 */
export const FORMS: { cmd: string; form: AssistForm }[] = allForms();
export const formById = (id: string) => FORMS.find((x) => x.form.id === id)?.form ?? null;
/** 이 명령의 폼·템플릿(사전 상세) */
export const assistOf = (cmd: string) => ASSIST.commands[cmd] ?? null;

/** 서버(원격 셸)에서 읽기 전용 명령 하나 — 원격 작업대만 */
export type Exec = (cmd: string) => Promise<string>;

// ── 서버 man(원격, 백그라운드 한 번·캐시) ──

type ManInfo = { whatis: string | null; opts: Map<string, { desc: string; arg?: string }> };
const manCache = new Map<string, ManInfo | null | "pending">();
let lookupVersion = 0;
const bump = () => {
	lookupVersion++;
	optCache.clear();
};

/** man 출력에서 옵션과 한 줄 설명을 뽑는다(가볍게 — 들여 쓴 줄 첫머리의 -x, --long) */
export function parseMan(text: string): ManInfo {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: man 의 겹쳐 쓰기(글자+백스페이스) 굵게 표시를 지운다
	const clean = text.replace(/.\x08/g, "");
	const lines = clean.split("\n");
	const opts = new Map<string, { desc: string; arg?: string }>();
	let whatis: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i] ?? "";
		if (!whatis && /^NAME\s*$/.test(l)) {
			const n = (lines[i + 1] ?? "").trim();
			const m = /\s[-—]\s(.+)$/.exec(n);
			if (m?.[1]) whatis = m[1].trim();
		}
		// 옵션 머리 줄: "-n, --quiet" · "-e script, --expression=script" · "-i[SUFFIX]" (설명이 같은 줄 두 칸 뒤에 올 수도)
		const head = /^( {2,12})(-.*)$/.exec(l);
		if (!head) continue;
		const indent = head[1]?.length ?? 0;
		const hm = /^(.*?)(?: {2,}(\S.*))?$/.exec(head[2] ?? "");
		const segs = (hm?.[1] ?? "").split(/,\s+/);
		const flags: string[] = [];
		let hasArg = false;
		let ok = true;
		for (const seg of segs) {
			const fm = /^(-{1,2}[A-Za-z0-9?][\w-]*)(.*)$/.exec(seg.trim());
			if (!fm?.[1] || (fm[2] && !/^[=[ ]/.test(fm[2]))) {
				ok = false;
				break;
			}
			flags.push(fm[1]);
			// 값은 띄어 쓰거나 = 로 붙는 것만(-i[SUFFIX] 처럼 붙여 쓰는 선택 값은 다음 낱말을 먹지 않는다)
			if (/^(=[^[]| \S)/.test(fm[2] ?? "")) hasArg = true;
		}
		if (!ok || !flags.length) continue;
		let desc = (hm?.[2] ?? "").trim();
		for (let k = i + 1; !desc && k < Math.min(lines.length, i + 4); k++) {
			const nx = lines[k] ?? "";
			if (!nx.trim()) continue;
			const ni = nx.length - nx.trimStart().length;
			if (ni <= indent || nx.trimStart().startsWith("-")) break;
			desc = nx.trim();
		}
		if (!desc) continue;
		desc = desc.replace(/\s+/g, " ").slice(0, 120);
		for (const f of flags) if (!opts.has(f)) opts.set(f, { desc, arg: hasArg ? "값" : undefined });
	}
	return { whatis, opts };
}

/**
 * 원격이면 그 명령 man 을 한 번 받는다(캐시) — 조각 풀이를 열 때만 부른다.
 * 입력 중에 자동으로 받지 않는다: 같은 SSH 연결로 수백 KB 가 흐르면 에코가 그 뒤로 밀린다.
 */
export function requestMan(exec: Exec | undefined, cmd: string): Promise<void> {
	if (!exec || !/^[A-Za-z0-9._+-]+$/.test(cmd) || manCache.has(cmd)) return Promise.resolve();
	manCache.set(cmd, "pending");
	return exec(`MANWIDTH=160 man -P cat -- ${cmd} 2>/dev/null | head -c 200000`)
		.then((out) => {
			manCache.set(cmd, out.trim() ? parseMan(out) : null);
			bump();
		})
		.catch(() => {
			manCache.set(cmd, null);
		});
}
const manOf = (cmd: string) => {
	const m = manCache.get(cmd);
	return m && m !== "pending" ? m : null;
};

// ── 옵션·하위 명령·명령 설명 ──

const optCache = new Map<string, Map<string, { desc: string; arg?: string }>>();
let dictSeen = false;

/** 옵션 설명 표 — 손 스펙(하위 → 명령) > D24 사전(하위 → 명령) > man. assist.json opts 는 assist.ts 가 먼저 본다 */
export const optLookup: OptLookup = (cmd, sub) => {
	const dict = dictNow();
	if (dict && !dictSeen) {
		dictSeen = true;
		optCache.clear();
	}
	const key = `${cmd}\u0000${sub ?? ""}`;
	const hit = optCache.get(key);
	if (hit) return hit;
	const out = new Map<string, { desc: string; arg?: string }>();
	const add = (flags: string, desc: string, arg?: string) => {
		for (const f of flags.split("|")) if (f && !out.has(f)) out.set(f, { desc, arg: arg || undefined });
	};
	const spec = SPECS[cmd];
	if (sub) for (const [f, d] of spec?.subs?.[sub]?.opts ?? []) add(f, d);
	for (const [f, d] of spec?.opts ?? []) add(f, d);
	const dc = dict?.c[cmd];
	if (sub) for (const [f, d, a] of dc?.s?.[sub]?.o ?? []) add(f, d, a);
	for (const [f, d, a] of dc?.o ?? []) add(f, d, a);
	for (const [f, v] of manOf(cmd)?.opts ?? []) if (!out.has(f)) out.set(f, v);
	optCache.set(key, out);
	return out;
};

export const subsOf: SubLookup = (c) => {
	const d = dictNow()?.c[c]?.s;
	if (d) return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.d]));
	const sp = SPECS[c]?.subs;
	return sp ? Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, v.desc])) : null;
};
export const cmdDesc = (c: string) => dictNow()?.c[c]?.d ?? SPECS[c]?.desc ?? manOf(c)?.whatis ?? null;
export const subDesc = (c: string, sub: string) => dictNow()?.c[c]?.s?.[sub]?.d ?? SPECS[c]?.subs?.[sub]?.desc ?? null;
export const knownCmd = (c: string) => !!dictNow()?.c[c] || !!SPECS[c] || !!ASSIST.commands[c];
export const ensureDict = () => loadDict().catch(() => null);
/** 옵션 표가 바뀐 판(man 이 늦게 오면 오른다) */
export const assistVersion = () => lookupVersion;

// ── 위험 표시 ──

/** 폼 결과의 위험 — 폼 danger + 공통 위험 규칙(DANGER) */
export function dangersOf(text: string, formDangers: string[]): string[] {
	const out = [...formDangers];
	if (DANGER.test(text)) out.push("되돌리기 어려운 명령이 들어 있습니다(지우기·디스크 쓰기·전원·권한 777 등) — 대상을 한 번 더 보세요");
	return out;
}

// ── 후보 출처(③ 폼) — 서버 조회는 읽기 전용, 30초 캐시 ──

export type CandidateCtx = {
	/** 원격 셸이면 읽기 전용 명령 실행 */
	exec?: Exec;
	listDir?: (dir: string) => Promise<FsEntry[]>;
	/** 지금 터미널 폴더(OSC 7) */
	cwd?: string | null;
	/** 캐시 열쇠(서버별) */
	key: string;
};

/** 문서 표의 읽기 전용 명령 그대로 */
const SRC_CMD: Partial<Record<FieldSource, string>> = {
	services: "systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null",
	timers: "systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null",
	containers: "docker ps -a --format '{{.Names}}' 2>/dev/null",
	images: "docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null",
	users: "getent passwd 2>/dev/null",
	groups: "getent group 2>/dev/null",
	interfaces: "ls -1 /sys/class/net 2>/dev/null",
};

function parseSrc(src: FieldSource, out: string): string[] {
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	switch (src) {
		case "services":
		case "timers":
			return lines.map((l) => l.split(/\s+/)[0] ?? "").filter((x) => /^[\w@.:-]+$/.test(x));
		case "users":
		case "groups":
			return lines.map((l) => l.split(":")[0] ?? "").filter(Boolean);
		case "images":
			return lines.filter((l) => !l.includes("<none>"));
		default:
			return lines;
	}
}

const srcCache = new Map<string, { at: number; list: Promise<string[]> }>();

export function candidatesFor(src: FieldSource, ctx: CandidateCtx): Promise<string[]> {
	const fsSrc = src === "files" || src === "dirs" || src === "paths";
	const k = `${ctx.key}\u0000${src}\u0000${fsSrc ? (ctx.cwd ?? "") : ""}`;
	const hit = srcCache.get(k);
	if (hit && Date.now() - hit.at < 30_000) return hit.list;
	let list: Promise<string[]>;
	if (fsSrc) {
		const cwd = ctx.cwd;
		list =
			cwd && ctx.listDir
				? ctx
						.listDir(cwd)
						.then((es) =>
							es
								.filter((e) => !e.name.startsWith(".") && (src === "paths" || (src === "dirs") === (e.kind === "dir")))
								.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
								.slice(0, 300)
								.map((e) => (e.kind === "dir" ? `${e.name}/` : e.name)),
						)
						.catch(() => [])
				: Promise.resolve([]);
	} else {
		const cmd = SRC_CMD[src];
		list =
			cmd && ctx.exec
				? ctx
						.exec(cmd)
						.then((out) => [...new Set(parseSrc(src, out))].slice(0, 500))
						.catch(() => [])
				: Promise.resolve([]);
	}
	srcCache.set(k, { at: Date.now(), list });
	return list;
}
