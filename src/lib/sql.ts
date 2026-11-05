/**
 * SQL 문장 나누기 — 따옴표('…'·"…"·`…`)·주석(-- … / /* … *\/)·달러 인용($$ / $tag$) 안의 ; 는 건너뛴다.
 * 돌려주는 범위는 원문 위치(앞뒤 공백 제외).
 */
export type Stmt = { from: number; to: number; text: string };

export function splitSql(src: string): Stmt[] {
	const out: Stmt[] = [];
	let start = 0;
	let i = 0;
	const n = src.length;
	const push = (end: number) => {
		const raw = src.slice(start, end);
		const lead = raw.length - raw.trimStart().length;
		const text = raw.trim();
		if (text && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(text)) out.push({ from: start + lead, to: start + lead + text.length, text });
	};
	while (i < n) {
		const c = src[i];
		if (c === "'" || c === '"' || c === "`") {
			i++;
			while (i < n) {
				if (src[i] === "\\" && c !== '"') {
					i += 2;
					continue;
				}
				if (src[i] === c) {
					if (src[i + 1] === c) {
						i += 2;
						continue;
					}
					break;
				}
				i++;
			}
			i++;
		} else if (c === "-" && src[i + 1] === "-") {
			const e = src.indexOf("\n", i);
			i = e < 0 ? n : e + 1;
		} else if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e < 0 ? n : e + 2;
		} else if (c === "$") {
			const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
			if (m) {
				const e = src.indexOf(m[0], i + m[0].length);
				i = e < 0 ? n : e + m[0].length;
			} else i++;
		} else if (c === ";") {
			push(i);
			start = i + 1;
			i++;
		} else i++;
	}
	push(n);
	return out;
}

/** 커서가 있는(또는 바로 앞) 문장 */
export function statementAt(src: string, pos: number): Stmt | null {
	const all = splitSql(src);
	return all.find((s) => pos >= s.from && pos <= s.to + 1) ?? [...all].reverse().find((s) => s.to < pos) ?? all[0] ?? null;
}
