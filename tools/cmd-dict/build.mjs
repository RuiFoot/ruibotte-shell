// 명령어 사전 3단계(D24) — raw.json + 번역 캐시(translations.json·intents.json) → 화면이 쓰는 src/features/workbench/cmd-dict/dict.json.
// 번역이 없는 문장은 영어 그대로 둔다. 무작위 표본 40개를 review-sample.md 로 남겨 검수 기록에 쓴다.
//   node build.mjs --raw raw.json --fig-version 2.692.3 --tldr-sha <커밋>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(arg("--raw"), "utf8"));
const tr = JSON.parse(readFileSync(join(here, "translations.json"), "utf8"));
const intents = JSON.parse(readFileSync(join(here, "intents.json"), "utf8"));
const ko = (s) => (s ? (tr[s] ?? s) : "");
const opt = (o) => (o.a ? [o.f.join("|"), ko(o.d), o.a] : [o.f.join("|"), ko(o.d)]);

const c = {};
let untranslated = 0;
let total = 0;
for (const [name, e] of Object.entries(raw)) {
	const it = intents[name];
	const d = it?.d ?? (e.tldr?.lang === "ko" ? e.tldr.d : ko(e.enDesc ?? e.fig?.d));
	const cmd = { d, k: it?.k ?? [] };
	if (e.fig?.a) cmd.a = e.fig.a;
	if (e.fig?.o?.length) cmd.o = e.fig.o.map(opt);
	if (e.fig?.s) {
		cmd.s = {};
		for (const [sn, s] of Object.entries(e.fig.s)) {
			const sub = { d: ko(s.d) };
			if (s.o?.length) sub.o = s.o.map(opt);
			if (s.a) sub.a = s.a;
			if (s.al) sub.al = s.al;
			cmd.s[sn] = sub;
		}
	}
	if (e.tldr?.x?.length)
		cmd.x = e.tldr.x.slice(0, 6).map(([xd, xc]) => [e.tldr.lang === "ko" ? xd : ko(xd), xc]);
	for (const s of [e.fig?.d, ...(e.fig?.o ?? []).map((o) => o.d)]) {
		if (!s) continue;
		total++;
		if (!tr[s]) untranslated++;
	}
	c[name] = cmd;
}
const out = { v: 1, src: { fig: arg("--fig-version"), tldr: arg("--tldr-sha") }, c };
const file = join(here, "../../src/features/workbench/cmd-dict/dict.json");
writeFileSync(file, JSON.stringify(out));
console.log(`명령 ${Object.keys(c).length} · 옵션 설명 번역 ${total - untranslated}/${total} · ${(JSON.stringify(out).length / 1024).toFixed(0)} KiB`);

// 무작위 표본(고정 씨앗) — 사람이 읽고 판정을 적는다
let seed = 20261104;
const rnd = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};
const pairs = Object.entries(tr);
const pick = new Set();
while (pick.size < Math.min(40, pairs.length)) pick.add(Math.floor(rnd() * pairs.length));
const rows = [...pick].map((i) => pairs[i]);
// 검수를 적어 둔 표본은 덮지 않는다(다시 뽑으려면 지우고 돌린다)
const sampleFile = join(here, "review-sample.md");
if (!existsSync(sampleFile) || readFileSync(sampleFile, "utf8").includes("(작성 예정)")) writeFileSync(
	sampleFile,
	`# 번역 표본 검수(D24)\n\n무작위 ${rows.length}개(씨앗 20261104) — 사내 gemma(google/gemma-4-12b-it) 번역. 판정은 아래 "검수"에.\n\n| # | 영어 | 한국어 |\n|---|---|---|\n${rows
		.map(([en, k], i) => `| ${i + 1} | ${en.replace(/\|/g, "\\|")} | ${k.replace(/\|/g, "\\|")} |`)
		.join("\n")}\n\n## 검수\n\n(작성 예정)\n`,
);
