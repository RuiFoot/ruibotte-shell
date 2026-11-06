#!/usr/bin/env node
// 웹 Orbit SSH 작업대와 같은 데이터·규칙을 이 앱으로 복사한다(D24 명령어 사전, D25 명령 입력 보조).
// 공개 CI 는 사내 저장소에 닿지 못하므로 빌드 때 받지 않고, 웹 ui 저장소의 **고정 커밋**에서 사본을 가져와 저장소에 둔다.
//
//   node scripts/sync-orbit-data.mjs <웹 ui 저장소 경로> <커밋>
//   예) node scripts/sync-orbit-data.mjs ../repia-works/ui cd22e310
//
// 가져온 커밋은 data/orbit-source.json 에 남는다. assist.json 의 스키마 판(v)이 앱이 아는 판(KNOWN_V)과 다르면
// 복사하지 않고 실패한다 — 화면 코드를 먼저 맞춘 뒤 KNOWN_V 를 올린다(판이 오르면 웹 세션이 알려 준다).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const KNOWN_V = 1;
const BASE = "apps/orbit/src/features/workbench/cmd-dict";

const [repo, ref] = process.argv.slice(2);
if (!repo || !ref) {
	console.error("사용법: node scripts/sync-orbit-data.mjs <웹 ui 저장소> <커밋>");
	process.exit(2);
}
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const show = (path) => execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { maxBuffer: 64 << 20 });
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);
const commit = execFileSync("git", ["-C", repo, "rev-parse", "--short=8", ref]).toString().trim();

const items = [
	{ from: `${BASE}/dict.json`, to: "data/cmd-dict/dict.json" },
	{ from: `${BASE}/assist.json`, to: "src/lib/cmd-assist/assist.json", check: true },
	{ from: `${BASE}/assist.ts`, to: "src/lib/cmd-assist/assist.ts" },
];

const out = {};
for (const it of items) {
	const buf = show(it.from);
	if (it.check) {
		const j = JSON.parse(buf.toString("utf8"));
		if (j.schema !== "orbit-cmd-assist" || j.v !== KNOWN_V) {
			console.error(`assist.json: ${j.schema} v${j.v} — 앱이 아는 판은 v${KNOWN_V}. 화면 코드를 먼저 맞추세요.`);
			process.exit(1);
		}
	}
	const dest = join(root, it.to);
	const before = existsSync(dest) ? sha(readFileSync(dest)) : "(없음)";
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, buf);
	out[it.to] = sha(buf);
	console.log(`${it.to}: ${before === out[it.to] ? "같음" : `${before} → ${out[it.to]}`}`);
}
writeFileSync(
	join(root, "data", "orbit-source.json"),
	`${JSON.stringify({ repo: "repia-works/ui (사내)", commit, schemaV: KNOWN_V, files: out }, null, "\t")}\n`,
);
console.log(`출처 커밋 ${commit} 를 data/orbit-source.json 에 적었습니다`);
