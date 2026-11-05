/**
 * SQL 문장 나누기 — 따옴표('…'·"…"·`…`)·주석(-- … / /* … *\/)·달러 인용($$ / $tag$) 안의 ; 는 건너뛴다.
 * 돌려주는 범위는 원문 위치(앞뒤 공백 제외).
 */
export type Stmt = { from: number; to: number; text: string };

/** PL/SQL·T-SQL 블록(BEGIN·DECLARE·CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER) — 안의 ; 로 나누지 않고 / 줄(또는 GO·끝)까지 */
function inBlock(head: string): boolean {
	const t = head.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trimStart();
	return /^(begin\b(?!\s+(tran|transaction|work)\b)|declare\b|create\s+(or\s+replace\s+)?(editionable\s+)?(procedure|function|package|trigger|type\s+body)\b)/i.test(t);
}

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
		// 줄 머리의 GO(SQL Server)·/(Oracle) 만 있는 줄은 문장 나누기
		if (i === 0 || src[i - 1] === "\n") {
			const m = /^[ \t]*(?:go|\/)[ \t]*(?:\r?\n|$)/i.exec(src.slice(i, i + 24));
			if (m) {
				push(i);
				i += m[0].length;
				start = i;
				continue;
			}
		}
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
		} else if (c === ";" && !inBlock(src.slice(start, i))) {
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
