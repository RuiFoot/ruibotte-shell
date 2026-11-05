// 버전 올리기 — tauri.conf.json(정본)·package.json·Cargo.toml 을 한 번에 같은 값으로.
// 사용: node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
	console.error("사용: node scripts/set-version.mjs X.Y.Z");
	process.exit(1);
}
const json = (p, f) => {
	const o = JSON.parse(readFileSync(p, "utf8"));
	f(o);
	writeFileSync(p, `${JSON.stringify(o, null, p === "package.json" ? "\t" : 2)}\n`);
};
json("src-tauri/tauri.conf.json", (o) => (o.version = v));
json("package.json", (o) => (o.version = v));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").replace(/^version\s*=\s*"[^"]+"/m, `version = "${v}"`);
writeFileSync("src-tauri/Cargo.toml", cargo);
console.log(`version → ${v} (Cargo.lock 은 다음 cargo 빌드 때 따라옴)`);
