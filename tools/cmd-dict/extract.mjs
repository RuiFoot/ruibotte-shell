// 명령어 사전 1단계(D24) — 받아 둔 Fig 자동완성 스펙(MIT)과 tldr-pages(CC BY 4.0)에서 commands.txt 의 명령만 뽑아 raw.json 으로.
// 실행 중 외부 호출은 없다(받기는 README 의 절차대로 미리). 화면에 쓰는 사전은 이 결과를 번역(translate.mjs)한 뒤 build.mjs 가 만든다.
//   node extract.mjs --fig <withfig-autocomplete/package> --tldr <tldr 압축 푼 폴더> --out raw.json
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const FIG = arg("--fig");
const TLDR = arg("--tldr");
const OUT = arg("--out");
const here = dirname(fileURLToPath(import.meta.url));

const names = [
	...new Set(
		readFileSync(join(here, "commands.txt"), "utf8")
			.split("\n")
			.map((l) => l.replace(/#.*/, "").trim())
			.filter(Boolean)
			.flatMap((l) => l.split(/\s+/)),
	),
];

const MAX_OPTS = 150;
const MAX_SUBS = 80;
const MAX_SUB_OPTS = 40;
const clip = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 200) : "");
const list = (n) => (Array.isArray(n) ? n : n ? [n] : []).filter((x) => typeof x === "string");

function argKind(args) {
	const a = Array.isArray(args) ? args[0] : args;
	if (!a) return undefined;
	const t = list(a.template);
	if (t.includes("folders") && !t.includes("filepaths")) return "dir";
	if (t.includes("filepaths")) return "path";
	return undefined;
}
function argHint(args) {
	const a = Array.isArray(args) ? args[0] : args;
	return a && typeof a.name === "string" ? a.name : undefined;
}
function opts(options, max) {
	const out = [];
	for (const o of options ?? []) {
		const flags = list(o.name).filter((f) => f.startsWith("-") || f.startsWith("+"));
		if (!flags.length) continue;
		const row = { f: flags, d: clip(o.description) };
		const h = argHint(o.args);
		if (h) row.a = h;
		out.push(row);
		if (out.length >= max) break;
	}
	return out;
}
/** 하위 명령으로 볼 만한가 — sed 스크립트 명령(a, b, c …)처럼 한 글자 이름이 대부분이면 하위 명령이 아니다 */
function realSubs(subs) {
	if (!Array.isArray(subs) || subs.length < 2) return false;
	const long = subs.filter((s) => list(s.name).some((n) => n.length >= 3)).length;
	return long / subs.length >= 0.6;
}

async function fig(name) {
	const file = join(FIG, "build", `${name}.js`);
	if (!existsSync(file)) return null;
	let spec;
	try {
		spec = (await import(pathToFileURL(file).href)).default;
	} catch {
		return null;
	}
	if (!spec || typeof spec !== "object") return null;
	const out = { d: clip(spec.description) };
	const o = opts(spec.options, MAX_OPTS);
	if (o.length) out.o = o;
	const k = argKind(spec.args);
	if (k) out.a = k;
	if (realSubs(spec.subcommands)) {
		out.s = {};
		for (const s of spec.subcommands.slice(0, MAX_SUBS)) {
			const n = list(s.name);
			if (!n.length || n[0].startsWith("-")) continue;
			const sub = { d: clip(s.description) };
			const so = opts(s.options, MAX_SUB_OPTS);
			if (so.length) sub.o = so;
			const sk = argKind(s.args);
			if (sk) sub.a = sk;
			if (n.length > 1) sub.al = n.slice(1);
			out.s[n[0]] = sub;
		}
	}
	return out;
}

const root = TLDR;
function page(lang, name) {
	for (const plat of ["linux", "common"]) {
		const f = join(root, lang, plat, `${name}.md`);
		if (existsSync(f)) return readFileSync(f, "utf8");
	}
	return null;
}
function parsePage(md) {
	const lines = md.split("\n");
	const desc = [];
	const ex = [];
	let pending = null;
	for (const l of lines) {
		if (l.startsWith("> ")) {
			const t = l.slice(2).trim();
			if (!/^(More information|더 많은 정보|See also|같이 보기|참고)/i.test(t) && !/<https?:/.test(t)) desc.push(t);
		} else if (l.startsWith("- ")) pending = l.slice(2).trim().replace(/:$/, "");
		else if (l.startsWith("`") && pending) {
			ex.push([pending, l.trim().replace(/^`|`$/g, "")]);
			pending = null;
		}
	}
	return { d: desc.join(" ").slice(0, 300), x: ex.slice(0, 8) };
}

const out = {};
let figN = 0;
let koN = 0;
for (const name of names) {
	const f = await fig(name);
	const ko = page("pages.ko", name);
	const en = page("pages", name);
	if (!f && !ko && !en) continue;
	const e = { fig: f ?? undefined };
	if (ko) {
		e.tldr = { lang: "ko", ...parsePage(ko) };
		koN++;
	} else if (en) e.tldr = { lang: "en", ...parsePage(en) };
	if (en) e.enDesc = parsePage(en).d;
	if (f) figN++;
	out[name] = e;
}
writeFileSync(OUT, JSON.stringify(out));
console.log(`명령 ${Object.keys(out).length}/${names.length} · Fig ${figN} · tldr 한국어 ${koN}`);
