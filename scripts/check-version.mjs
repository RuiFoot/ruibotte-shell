// 버전 한 곳 검사 — 정본은 src-tauri/tauri.conf.json 의 version.
// package.json·Cargo.toml 이 같은지, 태그(인자 또는 GITHUB_REF_NAME 이 v* 일 때)가 같은지 본다.
// 사용: node scripts/check-version.mjs [v1.2.3]
import { readFileSync } from "node:fs";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const ref = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const tag = ref.startsWith("v") ? ref : "";

const bad = [];
if (!/^\d+\.\d+\.\d+$/.test(conf)) bad.push(`tauri.conf.json version "${conf}" 은 X.Y.Z 꼴이어야 합니다`);
if (pkg !== conf) bad.push(`package.json ${pkg} ≠ tauri.conf.json ${conf}`);
if (cargo !== conf) bad.push(`Cargo.toml ${cargo} ≠ tauri.conf.json ${conf}`);
if (tag && tag !== `v${conf}`) bad.push(`태그 ${tag} ≠ v${conf}`);

if (bad.length) {
	console.error(`버전 불일치:\n- ${bad.join("\n- ")}\n고치기: node scripts/set-version.mjs ${conf}`);
	process.exit(1);
}
console.log(`version ${conf}${tag ? ` (태그 ${tag} 일치)` : ""}`);
