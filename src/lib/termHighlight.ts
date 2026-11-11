import type { IBufferCell, IDecoration, IMarker, Terminal } from "@xterm/xterm";
import type { HiRule } from "./termPrefs";

/** 기본 규칙 — 대문자 그대로(로그 수준 표기) */
const DEFAULTS: { re: RegExp; color: string }[] = [
	{ re: /\b(?:ERROR|FATAL)\b|\b[A-Za-z_$][\w$]*Exception\b/g, color: "#ff453a" },
	{ re: /\bWARN(?:ING)?\b/g, color: "#ff9f0a" },
	{ re: /\bINFO\b/g, color: "#0a84ff" },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(user: HiRule[]) {
	const rules = user
		.filter((r) => r.word.trim())
		.map((r) => {
			const w = r.word.trim();
			const pre = /^\w/.test(w) ? "\\b" : "";
			const post = /\w$/.test(w) ? "\\b" : "";
			return { re: new RegExp(`${pre}${esc(w)}${post}`, "gi"), color: r.color };
		});
	// 사용자 단어가 먼저(같은 자리면 사용자 색)
	return [...rules, ...DEFAULTS];
}

/**
 * 터미널 출력 단어 색칠 — xterm 버퍼(글자·색)는 건드리지 않고 꾸밈(decoration)으로 글자색만 덧입힌다.
 * - 화면에 보이는 줄만 칠한다(출력·스크롤이 멈춘 뒤 묶어서). 꾸밈은 늘 화면 한 장 분량이라 쌓이지 않는다
 *   (꾸밈은 렌더마다 전부 다시 놓이므로, 스크롤백 전체에 수천 개를 달아 두면 타이핑 에코마다 비용이 붙는다)
 * - 끝난 줄만(커서 줄은 아직 쓰는 중) · 전체 화면 앱(vim·less 등 대체 화면)에서는 하지 않는다
 * - 프로그램이 이미 색을 준 글자(기본색이 아닌 칸)는 그대로 둔다
 */
export function attachHighlighter(term: Terminal) {
	let rules: { re: RegExp; color: string }[] = [];
	let decos: { d: IDecoration; m: IMarker }[] = [];
	let timer: number | undefined;
	let cell: IBufferCell | undefined;
	/** 지난번에 칠한 화면(같으면 다시 칠하지 않는다) */
	let lastKey = "";

	const clear = () => {
		for (const x of decos) {
			x.d.dispose();
			x.m.dispose();
		}
		decos = [];
		lastKey = "";
	};

	const scan = () => {
		timer = undefined;
		if (!rules.length) return;
		const buf = term.buffer.active;
		if (buf.type !== "normal") return clear();
		const cursor = buf.baseY + buf.cursorY;
		const from = buf.viewportY;
		const to = Math.min(cursor - 1, buf.viewportY + term.rows - 1); // 끝난 줄까지만
		const key = `${from}:${to}:${buf.length}:${buf.getLine(to)?.translateToString(true) ?? ""}`;
		if (key === lastKey) return;
		clear();
		lastKey = key;
		for (let y = from; y <= to; y++) {
			const line = buf.getLine(y);
			if (!line) continue;
			const text = line.translateToString(true);
			if (!text) continue;
			let hits: { s: number; e: number; color: string }[] | null = null;
			for (const r of rules) {
				r.re.lastIndex = 0;
				for (const m of text.matchAll(r.re)) {
					const s = m.index ?? 0;
					const e = s + m[0].length;
					hits ??= [];
					if (hits.some((h) => s < h.e && e > h.s)) continue;
					hits.push({ s, e, color: r.color });
				}
			}
			if (!hits) continue;
			// 글자 자리 → 칸 자리(한글 등 두 칸 글자 때문에 다르다)
			const colOf: number[] = [];
			for (let x = 0; x < line.length; x++) {
				cell = line.getCell(x, cell);
				if (!cell || cell.getWidth() === 0) continue;
				const ch = cell.getChars() || " ";
				for (let k = 0; k < ch.length; k++) colOf.push(x);
			}
			colOf.push(line.length);
			for (const h of hits) {
				const x0 = colOf[h.s];
				const x1 = colOf[h.e] ?? line.length;
				if (x0 == null || x1 <= x0) continue;
				cell = line.getCell(x0, cell);
				if (!cell || !cell.isFgDefault() || cell.isInverse()) continue;
				const m = term.registerMarker(y - cursor);
				if (!m) continue;
				const d = term.registerDecoration({ marker: m, x: x0, width: x1 - x0, foregroundColor: h.color });
				if (!d) {
					m.dispose();
					continue;
				}
				decos.push({ d, m });
			}
		}
	};
	const later = (ms: number) => {
		if (rules.length && timer === undefined) timer = window.setTimeout(scan, ms);
	};

	const sub = term.onWriteParsed(() => later(120));
	const subScroll = term.onScroll(() => later(60));
	const subResize = term.onResize(() => later(60));

	return {
		/** null = 끔 */
		setRules(user: HiRule[] | null) {
			clear();
			rules = user ? compile(user) : [];
			if (rules.length && timer === undefined) timer = window.setTimeout(scan, 0);
		},
		dispose() {
			window.clearTimeout(timer);
			sub.dispose();
			subScroll.dispose();
			subResize.dispose();
			clear();
		},
	};
}
