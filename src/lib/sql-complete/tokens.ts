/**
 * SQL 완성용 토큰 나누기 — 구문 트리가 없어도(또는 문장이 반쯤 쓰인 채여도) 절을 읽을 수 있게 가볍게 낱말을 자른다.
 * 문자열·주석은 한 토큰으로 묶어 건너뛰고, 커서가 그 안에 있으면 완성하지 않는다.
 */
export type TokKind = "word" | "qid" | "str" | "num" | "comment" | "punct" | "op";
export type Tok = {
	kind: TokKind;
	/** 원문 그대로 */
	text: string;
	from: number;
	to: number;
	/** 낱말이면 대문자(키워드 비교용), 인용 식별자면 따옴표를 뺀 이름 */
	up: string;
	/** 닫히지 않은 문자열·주석·인용(문서 끝까지 이어짐) */
	open?: boolean;
};

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_CHAR = /[\w$#\u0080-\uffff]/;

/** 인용 식별자 이름(`a``b` → a`b) */
export function unquote(t: string): string {
	const q = t[0];
	if (q === "`") return t.slice(1, t.endsWith("`") && t.length > 1 ? -1 : undefined).replaceAll("``", "`");
	if (q === '"') return t.slice(1, t.endsWith('"') && t.length > 1 ? -1 : undefined).replaceAll('""', '"');
	if (q === "[") return t.slice(1, t.endsWith("]") && t.length > 1 ? -1 : undefined).replaceAll("]]", "]");
	return t;
}

export type TokOpts = {
	/** MySQL·MariaDB: "…" 는 문자열, # 는 줄 주석, \ 는 이스케이프 */
	mysql?: boolean;
	/** SQL Server: [이름] 인용 */
	brackets?: boolean;
};

export function tokenize(src: string, opts: TokOpts = {}): Tok[] {
	const out: Tok[] = [];
	const n = src.length;
	let i = 0;
	const push = (kind: TokKind, from: number, to: number, up: string, open?: boolean) => out.push({ kind, text: src.slice(from, to), from, to, up, open });
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		const start = i;
		// 주석
		if ((c === "-" && src[i + 1] === "-") || (c === "#" && opts.mysql)) {
			const e = src.indexOf("\n", i);
			i = e < 0 ? n : e;
			push("comment", start, i, "", e < 0);
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e < 0 ? n : e + 2;
			push("comment", start, i, "", e < 0);
			continue;
		}
		// 문자열 '…'(MySQL 은 "…" 도)
		if (c === "'" || (c === '"' && opts.mysql)) {
			i++;
			let closed = false;
			while (i < n) {
				if (src[i] === "\\" && opts.mysql) {
					i += 2;
					continue;
				}
				if (src[i] === c) {
					if (src[i + 1] === c) {
						i += 2;
						continue;
					}
					closed = true;
					i++;
					break;
				}
				i++;
			}
			push("str", start, Math.min(i, n), "", !closed);
			continue;
		}
		// 달러 인용(PostgreSQL)
		if (c === "$") {
			const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 64));
			if (m) {
				const e = src.indexOf(m[0], i + m[0].length);
				i = e < 0 ? n : e + m[0].length;
				push("str", start, i, "", e < 0);
				continue;
			}
		}
		// 인용 식별자
		if (c === '"' || c === "`" || (c === "[" && opts.brackets)) {
			const close = c === "[" ? "]" : c;
			i++;
			let closed = false;
			while (i < n) {
				if (src[i] === close) {
					if (src[i + 1] === close) {
						i += 2;
						continue;
					}
					closed = true;
					i++;
					break;
				}
				if (src[i] === "\n") break;
				i++;
			}
			const text = src.slice(start, i);
			push("qid", start, i, unquote(text), !closed);
			continue;
		}
		if (WORD_START.test(c)) {
			i++;
			while (i < n && WORD_CHAR.test(src[i])) i++;
			push("word", start, i, src.slice(start, i).toUpperCase());
			continue;
		}
		if (c >= "0" && c <= "9") {
			i++;
			while (i < n && /[\w.]/.test(src[i])) i++;
			push("num", start, i, "");
			continue;
		}
		if ("(),.;*".includes(c)) {
			i++;
			push("punct", start, i, c);
			continue;
		}
		// 연산자는 이어진 기호를 하나로(=, <>, ::, || …)
		i++;
		while (i < n && /[=<>!|&:+\-/%^~@?]/.test(src[i]) && !(src[i] === "-" && src[i + 1] === "-")) i++;
		push("op", start, i, src.slice(start, i));
	}
	return out;
}

/** 이름 토큰인가(낱말·인용 식별자) */
export const isName = (t: Tok | undefined): t is Tok => !!t && (t.kind === "word" || t.kind === "qid");
/** 이름 값(인용은 벗긴 것) */
export const nameOf = (t: Tok) => (t.kind === "qid" ? t.up : t.text);
