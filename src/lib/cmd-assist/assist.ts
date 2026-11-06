/**
 * 명령 입력 보조(D25) — 빈칸 Tab 템플릿·서명 힌트·빈칸 채우기 폼·조각 풀이. 데이터는 assist.json(스키마 orbit-api docs/cmd-assist-schema.md, v1)이고
 * 이 파일은 React 없는 순수 함수만 둔다 — 웹 Orbit 작업대와 데스크톱 앱(RuiBotte Shell)이 같은 JSON·같은 규칙을 쓴다.
 * 옵션 설명은 assist.json(손으로 적은 한국어) > 사전(dict.json)·서버 man 순으로 고른다.
 */
import data from "./assist.json";

export type AssistArg = { name: string; d?: string; opt?: boolean; many?: boolean; flag?: boolean };
export type AssistSig = { sub?: string; args: AssistArg[] };
export type AssistTemplate = { label: string; t: string };
export type AssistRule = { re: string; d: string };
export type FieldEsc = "shell" | "raw" | "sed" | "squote";
export type FieldSource =
	| "files"
	| "dirs"
	| "paths"
	| "services"
	| "timers"
	| "containers"
	| "images"
	| "users"
	| "groups"
	| "interfaces";
export type AssistField = {
	name: string;
	label: string;
	kind: "text" | "select" | "flag";
	src?: FieldSource;
	def?: string;
	d?: string;
	req?: boolean;
	esc?: FieldEsc;
	/** flag 가 켜졌을 때 넣는 글자 */
	on?: string;
	/** select 의 값·이름, text 의 추천 값 */
	options?: [string, string][];
};
export type AssistDerive = {
	if?: string;
	then?: string;
	else?: string;
	join?: string[];
	head?: string;
	tail?: string;
	cols?: string;
};
export type AssistForm = {
	id: string;
	label: string;
	d?: string;
	fields: AssistField[];
	build: string;
	derive?: Record<string, AssistDerive>;
	danger?: { when?: string; d: string }[];
};
export type AssistCmd = {
	sig?: AssistSig[];
	/** 값을 받는 옵션(다음 낱말이 그 값) */
	takes?: string[];
	opts?: Record<string, string>;
	explain?: AssistRule[];
	templates?: AssistTemplate[];
	forms?: AssistForm[];
};
export type Assist = {
	schema: "orbit-cmd-assist";
	v: number;
	/** 데이터 판(날짜) — 내용만 바뀌면 이것만 올린다 */
	dataVersion: string;
	glossary: Record<string, string>;
	generic: AssistRule[];
	commands: Record<string, AssistCmd>;
};

export const ASSIST = data as unknown as Assist;

/** 폼이 있는 명령·폼 목록(사전 첫 화면) */
export function allForms(a: Assist = ASSIST): { cmd: string; form: AssistForm }[] {
	const out: { cmd: string; form: AssistForm }[] = [];
	for (const [cmd, c] of Object.entries(a.commands))
		for (const form of c.forms ?? []) out.push({ cmd, form });
	return out;
}

// ── ① 빈칸 템플릿 ──

export type TplField = {
	name: string;
	/** 설명(용어집·tldr 갈래) */
	d: string;
	/** 채운 글자 안의 위치·길이(코드 포인트 — 셸 줄 편집의 ←→ 한 번이 한 글자) */
	start: number;
	len: number;
};

const TPL = /\{\{(.*?)\}\}/g;
const TLDR_HINT: [RegExp, string][] = [
	[/^path\/to\/(file|.*_file)$/, "파일 경로"],
	[/^path\/to\/(directory|folder|dir)$/, "폴더 경로"],
	[/^path\/to\/.+/, "경로"],
	[/^(user(name)?)$/, "계정 이름"],
	[/^(host(name)?|remote_host|server)$/, "서버 주소"],
	[/^port$/, "포트 번호"],
	[/^(pattern|search_pattern|regex)$/, "찾을 패턴"],
	[/^(replace|replacement)$/, "바꿀 글자"],
	[/^container(_name|_id)?$/, "컨테이너"],
	[/^(unit|service)(_name)?$/, "서비스"],
	[/^url$|^https?:/, "주소(URL)"],
	[/^(command|cmd)$/, "명령"],
];

/** {{이름}}·{{이름=기본값}}·tldr {{[-r|--recursive]}} 를 기본값으로 채우고 빈칸 자리를 돌려준다 */
export function parseTemplate(
	template: string,
	glossary: Record<string, string> = ASSIST.glossary,
): { text: string; fields: TplField[] } {
	let text = "";
	let at = 0;
	let last = 0;
	const fields: TplField[] = [];
	const cp = (s: string) => [...s].length;
	for (const m of template.matchAll(TPL)) {
		const before = template.slice(last, m.index ?? 0);
		text += before;
		at += cp(before);
		const inner = m[1] ?? "";
		let name = inner;
		let def = inner;
		let d = "";
		const alt = /^\[([^\]]+)\]$/.exec(inner);
		if (alt?.[1]) {
			const ways = alt[1].split("|");
			name = ways.join(" / ");
			def = ways[0] ?? "";
			d = `${ways.join(" 또는 ")} 가운데 하나`;
		} else {
			const eq = inner.indexOf("=");
			if (eq > 0) {
				name = inner.slice(0, eq);
				def = inner.slice(eq + 1);
			}
			d = glossary[name] ?? TLDR_HINT.find(([re]) => re.test(name))?.[1] ?? "";
		}
		text += def;
		fields.push({ name, d, start: at, len: cp(def) });
		at += cp(def);
		last = (m.index ?? 0) + m[0].length;
	}
	text += template.slice(last);
	return { text, fields };
}

export const hasTemplateFields = (s: string) => /\{\{.*?\}\}/.test(s);

// ── ③ 폼 ──

export type FormValues = Record<string, string>;

/** 처음 값 — 기본값, flag 는 def 가 있으면 켠 상태 */
export function initialValues(form: AssistForm): FormValues {
	const v: FormValues = {};
	for (const f of form.fields)
		v[f.name] = f.kind === "flag" ? (f.def ? (f.on ?? "") : "") : (f.def ?? "");
	return v;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./*?~\u00a0-\uffff-]+$/;
export function escapeValue(v: string, esc: FieldEsc = "shell"): string {
	if (!v) return v;
	switch (esc) {
		case "raw":
			return v;
		case "squote":
			return v.replace(/'/g, "'\\''");
		case "sed":
			return v.replace(/\//g, "\\/").replace(/'/g, "'\\''");
		default:
			return SAFE.test(v) && !v.startsWith("-") ? v : `'${v.replace(/'/g, "'\\''")}'`;
	}
}

function cond(expr: string, values: FormValues): boolean {
	const tilde = expr.indexOf("~");
	if (tilde > 0) {
		try {
			return new RegExp(expr.slice(tilde + 1)).test(values[expr.slice(0, tilde)] ?? "");
		} catch {
			return false;
		}
	}
	const eq = expr.indexOf("=");
	if (eq > 0) return (values[expr.slice(0, eq)] ?? "") === expr.slice(eq + 1);
	return !!values[expr];
}

/**
 * 폼 값으로 명령을 만든다 — {{칸}} 은 칸의 esc 대로, [[ … ]] 는 안의 칸이 하나라도 비면 통째로 뺀다. 필수 칸이 비면 {{칸 이름}} 을 남겨
 * 터미널에서 빈칸 템플릿(①)으로 이어 채운다.
 */
export function buildForm(
	form: AssistForm,
	values: FormValues,
): { text: string; missing: string[]; dangers: string[] } {
	const fields = new Map(form.fields.map((f) => [f.name, f]));
	const missing: string[] = [];
	const value = (name: string, depth = 0): string => {
		const der = form.derive?.[name];
		if (der && depth < 4) {
			if (der.join) return der.join.map((n) => values[n] ?? "").join("");
			if (der.head)
				return escapeValue([...(values[der.head] ?? "")][0] ?? "", fields.get(der.head)?.esc);
			if (der.tail)
				return escapeValue(
					[...(values[der.tail] ?? "")].slice(1).join(""),
					fields.get(der.tail)?.esc,
				);
			if (der.cols)
				return (values[der.cols] ?? "")
					.split(/[\s,]+/)
					.filter(Boolean)
					.map((c) => (c.startsWith("$") ? c : `$${c}`))
					.join(", ");
			if (der.if !== undefined) {
				const t = cond(der.if, values) ? (der.then ?? "") : (der.else ?? "");
				return t.replace(TPL, (_, n: string) => value(n, depth + 1) || "");
			}
		}
		const f = fields.get(name);
		const v = values[name] ?? "";
		if (!f || f.kind !== "text") return v;
		return escapeValue(v, f.esc);
	};
	const fill = (part: string, optional: boolean): string | null => {
		let empty = false;
		const out = part.replace(TPL, (_, name: string) => {
			const v = value(name);
			if (!v) {
				empty = true;
				const f = fields.get(name);
				if (!optional && f?.req) {
					missing.push(f.label);
					return `{{${f.label}}}`;
				}
			}
			return v;
		});
		return optional && empty ? null : out;
	};
	let text = "";
	let last = 0;
	for (const m of form.build.matchAll(/\[\[(.*?)\]\]/g)) {
		text += fill(form.build.slice(last, m.index ?? 0), false);
		text += fill(m[1] ?? "", true) ?? "";
		last = (m.index ?? 0) + m[0].length;
	}
	text += fill(form.build.slice(last), false);
	const dangers = (form.danger ?? [])
		.filter((x) => !x.when || cond(x.when, values))
		.map((x) => x.d);
	return { text: text.replace(/ {2,}/g, " ").trim(), missing, dangers };
}

// ── 낱말 나누기(따옴표·연산자) ──

export type Lexeme = { raw: string; text: string; start: number; op?: boolean };
const OPS = ["2>&1", "&>", "||", "&&", ">>", "2>", ">", "<", "|", ";", "&"];

/** 셸 한 줄을 낱말·연산자로 — 따옴표 안은 한 낱말, $( ) 는 괄호째 한 낱말 */
export function lex(line: string): Lexeme[] {
	const out: Lexeme[] = [];
	let cur: Lexeme | null = null;
	let quote: string | null = null;
	let paren = 0;
	const push = () => {
		if (cur) out.push(cur);
		cur = null;
	};
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (cur) cur.raw += ch;
			if (ch === quote) quote = null;
			else if (cur) cur.text += ch;
			continue;
		}
		if (paren) {
			if (cur) {
				cur.raw += ch;
				cur.text += ch;
			}
			if (ch === "(") paren++;
			else if (ch === ")") paren--;
			continue;
		}
		if (ch === " " || ch === "\t") {
			push();
			continue;
		}
		const op = OPS.find((o) => line.startsWith(o, i));
		// 2> · 2>&1 은 낱말 첫머리일 때만(file2>x 의 2 는 낱말)
		if (op && !(op.startsWith("2") && cur)) {
			push();
			out.push({ raw: op, text: op, start: i, op: true });
			i += op.length - 1;
			continue;
		}
		if (!cur) cur = { raw: "", text: "", start: i };
		cur.raw += ch;
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			cur.raw += "(";
			cur.text += "$(";
			paren = 1;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < line.length) {
			i++;
			cur.raw += line[i];
			cur.text += line[i];
			continue;
		}
		cur.text += ch;
	}
	push();
	return out;
}

const WRAP = new Set(["sudo", "time", "nohup", "env", "watch", "nice", "timeout", "exec"]);
const REDIRECT = new Set([">", ">>", "<", "2>", "&>"]);

// ── 옵션 설명 ──

export type OptLookup = (
	cmd: string,
	sub: string | null,
) => Map<string, { desc: string; arg?: string }>;

function optDesc(cmd: string, sub: string | null, flag: string, base: OptLookup): string | null {
	const own = ASSIST.commands[cmd]?.opts?.[flag];
	if (own) return own;
	return base(cmd, sub).get(flag)?.desc ?? null;
}
function takesValue(cmd: string, sub: string | null, flag: string, base: OptLookup): boolean {
	// assist.json 에 takes 가 있으면 그것이 정본 — 사전(Fig, BSD 기준)은 GNU 와 달라(sed -i 확장자) 값 자리를 잘못 센다
	const own = ASSIST.commands[cmd]?.takes;
	if (own && !sub) return own.includes(flag);
	return !!base(cmd, sub).get(flag)?.arg;
}

// ── ② 서명 힌트 ──

export type SigPart = { text: string; active: boolean };
export type SigView = { parts: SigPart[]; desc: string | null; label: string | null };
export type SubLookup = (cmd: string) => Record<string, string> | null;

function sigOf(
	cmd: string,
	sub: string | null,
	subs: SubLookup,
): { sig: AssistSig; sub: string | null } | null {
	const sigs = ASSIST.commands[cmd]?.sig;
	if (sigs?.length) {
		const s = sub ? sigs.find((x) => x.sub === sub) : null;
		if (s) return { sig: s, sub };
		const base = sigs.find((x) => !x.sub);
		if (base) return { sig: base, sub: null };
	}
	const known = subs(cmd);
	if (known && Object.keys(known).length && !sub)
		return {
			sig: {
				args: [
					{ name: "하위 명령", d: Object.keys(known).slice(0, 8).join(" · ") },
					{ name: "인자", opt: true, many: true },
				],
			},
			sub: null,
		};
	return null;
}

/**
 * 지금 입력(커서까지)의 서명 — 명령 이름을 다 친 뒤(공백 하나 뒤)부터. 지금 치는 자리를 굵게, 그 자리 설명을 한 줄로. 옵션을 치는 중이면 그 옵션 설명.
 * 서명이 없는 명령은 사전이 아는 명령만 "명령 [옵션] [인자…]" 로.
 */
export function signatureAt(
	input: string,
	base: OptLookup,
	subs: SubLookup,
	known: (cmd: string) => boolean,
): SigView | null {
	const all = lex(input);
	let from = 0;
	all.forEach((l, i) => {
		if (l.op && !REDIRECT.has(l.text)) from = i + 1;
	});
	// 리디렉션(> 파일, 2>/dev/null) 뒤 낱말은 인자가 아니다 — 지금 그 자리를 치는 중이면 힌트를 띄우지 않는다
	const seg = all.slice(from);
	const last = seg.at(-1);
	if (last?.op && REDIRECT.has(last.text)) return null;
	if (
		seg.length > 1 &&
		REDIRECT.has(seg.at(-2)?.text ?? "") &&
		seg.at(-2)?.op &&
		!input.endsWith(" ")
	)
		return null;
	const words = seg.filter(
		(l, i) => !l.op && !(i > 0 && seg[i - 1]?.op && REDIRECT.has(seg[i - 1]?.text ?? "")),
	);
	while (words.length > 1 && WRAP.has(words[0]?.text ?? "")) words.shift();
	if (input.endsWith(" ")) words.push({ raw: "", text: "", start: input.length });
	if (words.length < 2) return null;
	const cmd = words[0]?.text ?? "";
	if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) return null;
	const sub = words.length > 2 ? (words[1]?.text ?? null) : null;
	const found = sigOf(cmd, sub, subs) ?? (known(cmd) ? { sig: genericSig(), sub: null } : null);
	if (!found) return null;
	const { sig } = found;
	const startAt = found.sub ? 2 : 1;
	const head = found.sub ? `${cmd} ${found.sub}` : cmd;
	const positional = sig.args.filter((a) => !a.flag);
	const flagArg = sig.args.find((a) => a.flag);
	// 끝난 낱말로 자리 세기
	let pos = 0;
	let wantValue: string | null = null;
	for (let i = startAt; i < words.length - 1; i++) {
		const w = words[i]?.text ?? "";
		if (wantValue) {
			wantValue = null;
			continue;
		}
		if (w.startsWith("-") && w.length > 1) {
			if (!w.includes("=") && takesValue(cmd, found.sub, w, base)) wantValue = w;
			continue;
		}
		pos++;
	}
	const curWord = words[words.length - 1]?.text ?? "";
	let active: AssistArg | null = null;
	let desc: string | null = null;
	let label: string | null = null;
	if (wantValue) {
		active = flagArg ?? null;
		label = `${wantValue} 의 값`;
		desc = optDesc(cmd, found.sub, wantValue, base);
	} else if (curWord.startsWith("-")) {
		active = flagArg ?? null;
		const flag = curWord.split("=")[0] ?? curWord;
		const d = flag.length > 1 ? optDesc(cmd, found.sub, flag, base) : null;
		label = d ? flag : (flagArg?.name ?? "옵션");
		desc = d ?? flagArg?.d ?? null;
	} else {
		const manyAt = positional.findIndex((a) => a.many);
		active =
			positional[pos] ??
			(manyAt >= 0 ? (positional[manyAt + 1] ?? positional[manyAt] ?? null) : null);
		if (active) {
			label = active.name;
			desc = active.d ?? ASSIST.glossary[active.name] ?? null;
		}
	}
	const parts: SigPart[] = [{ text: head, active: false }];
	for (const a of sig.args) {
		const t = a.flag
			? `[${a.name}]`
			: a.opt
				? `[${a.name}${a.many ? "…" : ""}]`
				: `${a.name}${a.many ? "…" : ""}`;
		parts.push({ text: t, active: a === active });
	}
	return { parts, desc, label };
}
const genericSig = (): AssistSig => ({
	args: [
		{ name: "옵션", flag: true, opt: true },
		{ name: "인자", opt: true, many: true },
	],
});

// ── ④ 조각 풀이 ──

export type ExplainPart = {
	tok: string;
	kind: "cmd" | "sub" | "opt" | "val" | "arg" | "op" | "wrap";
	d: string | null;
};

function applyRules(rules: AssistRule[] | undefined, text: string): string | null {
	for (const r of rules ?? []) {
		let m: RegExpExecArray | null;
		try {
			m = new RegExp(r.re).exec(text);
		} catch {
			continue;
		}
		if (m) {
			const groups = m;
			return r.d.replace(/\$(&|\d)/g, (_, g: string) =>
				g === "&" ? groups[0] : (groups[Number(g)] ?? ""),
			);
		}
	}
	return null;
}

/**
 * 명령 줄을 조각마다 풀이 — 명령·하위 명령은 사전 설명, 옵션은 assist > 사전·man, 묶은 짧은 옵션(-xzvf)은 하나씩, 값·인자는 명령 규칙 >
 * 공통 규칙 > 서명 자리 이름. 아무 데도 없으면 d=null("설명 없음").
 */
export function explainLine(
	line: string,
	base: OptLookup,
	cmdDesc: (cmd: string) => string | null,
	subDesc: (cmd: string, sub: string) => string | null,
): ExplainPart[] {
	const out: ExplainPart[] = [];
	const lx = lex(line.trim());
	let cmd: string | null = null;
	let sub: string | null = null;
	let pos = 0;
	let wantValue: string | null = null;
	let redirect = false;
	let sigArgs: AssistArg[] = [];
	for (const l of lx) {
		if (l.op) {
			out.push({ tok: l.raw, kind: "op", d: applyRules(ASSIST.generic, l.text) });
			if (REDIRECT.has(l.text)) redirect = true;
			else {
				cmd = null;
				sub = null;
				pos = 0;
				wantValue = null;
			}
			continue;
		}
		const t = l.text;
		if (redirect) {
			redirect = false;
			out.push({
				tok: l.raw,
				kind: "arg",
				d: applyRules(ASSIST.generic, t) ?? "리디렉션 대상 파일",
			});
			continue;
		}
		if (!cmd) {
			if (WRAP.has(t)) {
				out.push({ tok: l.raw, kind: "wrap", d: applyRules(ASSIST.generic, t) ?? cmdDesc(t) });
				continue;
			}
			cmd = t;
			out.push({ tok: l.raw, kind: "cmd", d: cmdDesc(t) });
			const sigs = ASSIST.commands[t]?.sig;
			sigArgs = (sigs?.find((s) => !s.sub)?.args ?? []).filter((a) => !a.flag);
			continue;
		}
		if (wantValue) {
			const flag = wantValue;
			wantValue = null;
			out.push({
				tok: l.raw,
				kind: "val",
				d:
					applyRules(ASSIST.commands[cmd]?.explain, t) ??
					applyRules(ASSIST.generic, t) ??
					`${flag} 의 값`,
			});
			continue;
		}
		if (!sub && pos === 0 && !t.startsWith("-")) {
			const sd = subDesc(cmd, t);
			if (sd) {
				sub = t;
				out.push({ tok: l.raw, kind: "sub", d: sd });
				const s = ASSIST.commands[cmd]?.sig?.find((x) => x.sub === t);
				if (s) sigArgs = s.args.filter((a) => !a.flag);
				continue;
			}
		}
		if (t.startsWith("-") && t.length > 1 && t !== "--") {
			const own = applyRules(ASSIST.commands[cmd]?.explain, t);
			if (own) {
				out.push({ tok: l.raw, kind: "opt", d: own });
				continue;
			}
			const eq = t.indexOf("=");
			const flag = eq > 0 ? t.slice(0, eq) : t;
			const d = optDesc(cmd, sub, flag, base);
			if (d) {
				out.push({ tok: l.raw, kind: "opt", d: eq > 0 ? `${d} = ${t.slice(eq + 1)}` : d });
				if (eq < 0 && takesValue(cmd, sub, flag, base)) wantValue = flag;
				continue;
			}
			// 묶은 짧은 옵션 -xzvf, 값이 붙은 -n100·-F:
			if (/^-[A-Za-z0-9]{2,}$/.test(t) || /^-[A-Za-z]./.test(t)) {
				const pieces: string[] = [];
				let ok = true;
				const chars = [...t.slice(1)];
				for (let i = 0; i < chars.length; i++) {
					const f = `-${chars[i]}`;
					const fd = optDesc(cmd, sub, f, base);
					if (!fd) {
						ok = false;
						break;
					}
					if (takesValue(cmd, sub, f, base) && i < chars.length - 1) {
						pieces.push(`${f} ${fd} = ${chars.slice(i + 1).join("")}`);
						break;
					}
					pieces.push(`${f} ${fd}`);
					if (i === chars.length - 1 && takesValue(cmd, sub, f, base)) wantValue = f;
				}
				if (ok && pieces.length) {
					out.push({ tok: l.raw, kind: "opt", d: pieces.join(" · ") });
					continue;
				}
			}
			out.push({ tok: l.raw, kind: "opt", d: null });
			continue;
		}
		// tar xzvf 같은 대시 없는 옛 옵션
		if (cmd === "tar" && pos === 0 && /^[A-Za-z]+$/.test(t) && !sub) {
			const ds = [...t].map((ch) => optDesc(cmd as string, null, `-${ch}`, base));
			if (ds.every(Boolean)) {
				out.push({
					tok: l.raw,
					kind: "opt",
					d: [...t].map((ch, i) => `${ch} ${ds[i]}`).join(" · "),
				});
				if (t.endsWith("f")) wantValue = "-f";
				continue;
			}
		}
		const arg = sigArgs[Math.min(pos, sigArgs.length - 1)];
		pos++;
		const rule = applyRules(ASSIST.commands[cmd]?.explain, t) ?? applyRules(ASSIST.generic, t);
		out.push({
			tok: l.raw,
			kind: "arg",
			d: rule ?? (arg ? `${arg.name}${arg.d ? ` — ${arg.d}` : ""}` : null),
		});
	}
	return out;
}
