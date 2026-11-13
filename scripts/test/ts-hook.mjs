// node 로 src/*.ts 를 바로 돌리는 작은 도우미 — 확장자 없는 상대 경로에 .ts 를 붙이고, .css 가져오기는 빈 모듈로.
// 쓰기: node --import ./scripts/test/ts-hook.mjs scripts/test/sql-complete.test.ts
import { register } from "node:module";

register(
	"data:text/javascript," +
		encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
	if (spec.endsWith(".css")) return { url: "data:text/javascript,export default {}", shortCircuit: true };
	if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL) {
		for (const ext of [".ts", ".tsx", "/index.ts"]) {
			const u = new URL(spec + ext, ctx.parentURL);
			if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true };
		}
	}
	return next(spec, ctx);
}`),
	import.meta.url,
);
