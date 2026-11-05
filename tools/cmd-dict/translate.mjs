// 명령어 사전 2단계(D24) — raw.json 의 영어 설명을 OpenAI 호환 LLM(처음 번역은 gemma-4-12b-it)으로 한국어로. 유료 Claude 는 쓰지 않는다.
// 결과는 캐시(translations.json: 영어 → 한국어, intents.json: 명령 → {d, k})에 쌓아 두고 다시 돌리면 없는 것만 묻는다.
//   VLLM_KEY_FILE=<키 파일> node translate.mjs --raw raw.json --base <OpenAI 호환 주소> [--model google/gemma-4-12b-it]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const here = dirname(fileURLToPath(import.meta.url));
const RAW = arg("--raw");
const BASE = arg("--base", process.env.LLM_BASE_URL ?? "");
if (!BASE) throw new Error("--base 또는 LLM_BASE_URL 로 OpenAI 호환 엔드포인트를 지정하세요");
const MODEL = arg("--model", "google/gemma-4-12b-it");
const KEY = readFileSync(process.env.VLLM_KEY_FILE, "utf8")
	.split(/\r?\n/)
	.find((l) => l.trim() && !l.startsWith("#"))
	.trim();
const TR = join(here, "translations.json");
const IN = join(here, "intents.json");
const raw = JSON.parse(readFileSync(RAW, "utf8"));
const tr = existsSync(TR) ? JSON.parse(readFileSync(TR, "utf8")) : {};
// 비었거나 깨진 항목은 다시 만든다
const intents = Object.fromEntries(
	Object.entries(existsSync(IN) ? JSON.parse(readFileSync(IN, "utf8")) : {}).filter(
		([, v]) => v?.d && Array.isArray(v.k),
	),
);
const save = () => {
	// 키 정렬은 새 객체로 — JSON.stringify 의 배열 replacer 는 안쪽 키(d·k)까지 걸러 지운다
	const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
	writeFileSync(TR, `${JSON.stringify(sorted(tr), null, 1)}\n`);
	writeFileSync(IN, `${JSON.stringify(sorted(intents), null, 1)}\n`);
};

async function chat(system, user, maxTokens = 6000) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const r = await fetch(`${BASE}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
				signal: AbortSignal.timeout(180_000),
				body: JSON.stringify({
					model: MODEL,
					temperature: 0,
					max_tokens: maxTokens,
					// gemma 는 긴 목록에서 같은 말을 되풀이하다 상한까지 간다 — 반복 벌점과 묶음 크기에 맞춘 상한으로 막는다
					repetition_penalty: 1.05,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
				}),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const j = await r.json();
			return j.choices[0].message.content;
		} catch (e) {
			if (attempt === 2) throw e;
			await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
		}
	}
}
function jsonOf(text) {
	const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (m ? m[1] : text).trim();
	const a = body.indexOf(body.trim().startsWith("[") ? "[" : "{");
	try {
		return JSON.parse(body.slice(a));
	} catch {
		// \pset 처럼 홀로 선 역슬래시 — 이스케이프로 고쳐 한 번 더
		// 문자열 안 날 줄바꿈 같은 제어 문자도 공백으로
		return JSON.parse(
			body
				.slice(a)
				.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자 지우기
				.replace(/[\u0000-\u001f]+/g, " "),
		);
	}
}

// ── 1) 옵션·하위 명령·명령 설명, tldr 영어 페이지 ──
const strings = new Set();
const add = (s) => s && !tr[s] && strings.add(s);
for (const e of Object.values(raw)) {
	add(e.fig?.d);
	for (const o of e.fig?.o ?? []) add(o.d);
	for (const s of Object.values(e.fig?.s ?? {})) {
		add(s.d);
		for (const o of s.o ?? []) add(o.d);
	}
	if (e.tldr?.lang === "en") {
		add(e.tldr.d);
		for (const [d] of e.tldr.x) add(d);
	}
}
const SYS_TR = [
	"너는 리눅스 명령 도움말 번역가다. 영어 설명을 짧은 한국어로 옮긴다.",
	"- 옵션 글자(-a, --all), 명령·프로그램 이름, 파일·변수 이름, 약어·고유 기술 용어(regex, stdin, UTF-8, PID, TCP, SSH 등)는 원문 그대로 둔다.",
	"- 일반 낱말은 한국어로: hidden→숨김, directory/folder→폴더, symbolic link→심볼릭 링크, recursively→하위까지, verbose→자세히, quiet→조용히.",
	"- 문장체 대신 간결한 명사형·종결 없이(예: '숨김 파일 포함', '하위 폴더까지 복사', '줄 번호 표시').",
	"- 백틱(`)으로 감싼 낱말은 원문 그대로 두되 백틱은 지운다. 뜻을 더하거나 빼지 않는다.",
	'- 입력은 [{"i":번호,"t":"영어"}] JSON, 출력은 [{"i":번호,"ko":"한국어"}] JSON 하나만.',
].join("\n");
const list = [...strings];
let done = 0;
const BATCH = 15;
const CONC = 6;
async function worker(start) {
	for (let b = start; b < list.length; b += BATCH * CONC) {
		const chunk = list.slice(b, b + BATCH);
		// 한 묶음이 깨지면(JSON 오류) 반씩 나눠 다시
		const run = async (part) => {
			try {
				const out = jsonOf(
					await chat(
						SYS_TR,
						JSON.stringify(part.map((t, i) => ({ i, t }))),
						part.reduce((n, t) => n + Math.ceil(t.length * 0.9) + 24, 80),
					),
				);
				for (const r of out) if (part[r.i] && typeof r.ko === "string" && r.ko.trim()) tr[part[r.i]] = r.ko.trim();
			} catch (e) {
				if (part.length > 1) {
					const h = Math.ceil(part.length / 2);
					await run(part.slice(0, h));
					await run(part.slice(h));
				} else console.log(`실패 — ${part[0].slice(0, 60)} (${e.message})`);
			}
		};
		await run(chunk);
		done += chunk.length;
		save();
		console.log(`번역 ${done}/${list.length}`);
	}
}
await Promise.all([...Array(CONC).keys()].map((k) => worker(k * BATCH)));
save();
console.log(`번역 끝 — 새 ${list.length}개 중 캐시 ${Object.keys(tr).length}`);

// ── 2) 명령마다 한 줄 설명 + 한국어 의도 낱말(사전 검색용) ──
const SYS_IN = [
	"너는 리눅스 명령 사전 편집자다. 명령마다 한국어로",
	'  "d": 무엇을 하는 명령인지 한 줄(25자 안팎, 명사형),',
	'  "k": 사람이 이 명령을 찾을 때 칠 만한 한국어 의도 낱말 6~12개(동의어 포함, 예: 교체·바꾸기·치환, 찾기·검색, 압축·묶기, 압축 풀기, 용량·크기, 포트·연결, 권한, 프로세스 종료).',
	"를 만든다. 낱말은 짧은 명사·동사 어간으로, 영어 명령 이름은 넣지 않는다.",
	'출력은 {"명령": {"d": "...", "k": ["..."]}} JSON 하나만.',
].join("\n");
const todo = Object.keys(raw).filter((n) => !intents[n]);
// 의도 낱말은 작은 묶음(5개)·짧은 상한으로 — 긴 묶음은 gemma 가 되풀이하다 시간이 넘었다
const IN_BATCH = 5;
let inDone = 0;
async function intentWorker(start) {
	for (let b = start; b < todo.length; b += IN_BATCH * CONC) {
		const chunk = todo.slice(b, b + IN_BATCH);
		const input = chunk.map((n) => {
			const e = raw[n];
			return {
				name: n,
				en: e.enDesc ?? e.fig?.d ?? "",
				ko: e.tldr?.lang === "ko" ? e.tldr.d : "",
				examples: (e.tldr?.x ?? []).slice(0, 4).map(([d]) => d),
			};
		});
		try {
			const out = jsonOf(await chat(SYS_IN, JSON.stringify(input), 220 * chunk.length + 100));
			for (const n of chunk)
				if (out[n]?.d && Array.isArray(out[n].k))
					intents[n] = { d: String(out[n].d), k: out[n].k.map(String).slice(0, 12) };
		} catch (e) {
			console.log(`의도 묶음 ${chunk.join(",")} 실패 — ${e.message}`);
		}
		inDone += chunk.length;
		save();
		console.log(`의도 ${inDone}/${todo.length}`);
	}
}
await Promise.all([...Array(CONC).keys()].map((k) => intentWorker(k * IN_BATCH)));
console.log(`끝 — 의도 ${Object.keys(intents).length}`);
