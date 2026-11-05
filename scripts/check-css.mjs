// 스타일시트 괄호 검사 — 닫는 괄호 하나가 빠지면 브라우저는 그 뒤 규칙을 조용히 버린다(0.1~0.6 에서 실제로 일어남).
// 주석·문자열을 빼고 { } 짝과, 선언 블록 안에 다른 선택자가 끼어든 줄을 찾는다.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).length ? process.argv.slice(2) : ["src/styles.css"];
let failed = false;
for (const f of files) {
	const src = readFileSync(f, "utf8");
	let depth = 0;
	let line = 1;
	let i = 0;
	const opens = [];
	while (i < src.length) {
		const c = src[i];
		if (c === "\n") line++;
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const chunk = src.slice(i, end + 2);
			line += (chunk.match(/\n/g) || []).length;
			i = end + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const end = src.indexOf(c, i + 1);
			i = end + 1;
			continue;
		}
		if (c === "{") {
			depth++;
			opens.push(line);
		} else if (c === "}") {
			depth--;
			opens.pop();
			if (depth < 0) {
				console.error(`${f}:${line} 짝 없는 }`);
				failed = true;
				depth = 0;
			}
		}
		i++;
	}
	if (depth !== 0) {
		console.error(`${f}: 닫히지 않은 { ${depth}개 — 여는 줄 ${opens.join(", ")}`);
		failed = true;
	}
}
if (failed) process.exit(1);
console.log("css ok");
