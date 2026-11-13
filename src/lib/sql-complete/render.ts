/**
 * 완성 목록 한 줄 꾸미기 — 종류 아이콘(lucide 모양을 그대로 그린 SVG), 출처(별칭·스키마·서명), 오른쪽 형식·행 수, PK·인덱스·NULL 표지.
 * React 를 쓰지 않는다(목록은 칠 때마다 다시 그려진다 — DOM 몇 개로 끝낸다).
 */
import type { Completion } from "@codemirror/autocomplete";
import "../../styles/sql-complete.css";

export type IconKind = "table" | "view" | "column" | "key" | "schema" | "function" | "keyword" | "join" | "alias" | "star" | "word" | "cte";
export type Look = {
	icon: IconKind;
	/** 이름 옆 흐린 글 — 별칭·표·스키마·인자 */
	src?: string;
	/** 표지 */
	badges?: ("PK" | "IDX" | "NULL")[];
};
export type LookCompletion = Completion & { look?: Look };

const P = (d: string) => `<path d="${d}"/>`;
// lucide 아이콘 모양(24 격자, 선 2) — table·eye·columns-3·key-round·database·square-function·type·link·at-sign·asterisk·text·layers
const SHAPES: Record<IconKind, string> = {
	table: `${P("M12 3v18")}<rect width="18" height="18" x="3" y="3" rx="2"/>${P("M3 9h18")}${P("M3 15h18")}`,
	view: `${P("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0")}<circle cx="12" cy="12" r="3"/>`,
	column: `<rect width="18" height="18" x="3" y="3" rx="2"/>${P("M9 3v18")}${P("M15 3v18")}`,
	key: `${P("M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z")}<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>`,
	schema: `<ellipse cx="12" cy="5" rx="9" ry="3"/>${P("M3 5V19A9 3 0 0 0 21 19V5")}${P("M3 12A9 3 0 0 0 21 12")}`,
	function: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>${P("M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3")}${P("M9 11.2h5.7")}`,
	keyword: `${P("M4 7V4h16v3")}${P("M9 20h6")}${P("M12 4v16")}`,
	join: `${P("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71")}${P("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")}`,
	alias: `<circle cx="12" cy="12" r="4"/>${P("M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8")}`,
	star: `${P("M12 6v12")}${P("M17.196 9 6.804 15")}${P("m6.804 9 10.392 6")}`,
	word: `${P("M15 18H3")}${P("M17 6H3")}${P("M21 12H3")}`,
	cte: `${P("m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z")}${P("m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65")}${P("m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65")}`,
};
const svgCache = new Map<IconKind, string>();
const svgOf = (k: IconKind) => {
	let s = svgCache.get(k);
	if (!s) {
		s = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHAPES[k]}</svg>`;
		svgCache.set(k, s);
	}
	return s;
};

/** autocompletion({ addToOptions }) 에 넣을 것 — icons 는 끈다 */
export const lookOptions = [
	{
		position: 20,
		render: (c: Completion) => {
			const look = (c as LookCompletion).look;
			const el = document.createElement("span");
			el.className = `sqlc-ic sqlc-ic-${look?.icon ?? "word"}`;
			el.innerHTML = svgOf(look?.icon ?? "word");
			return el;
		},
	},
	{
		position: 60,
		render: (c: Completion) => {
			const src = (c as LookCompletion).look?.src;
			if (!src) return null;
			const el = document.createElement("span");
			el.className = "sqlc-src";
			el.textContent = src;
			return el;
		},
	},
	{
		position: 90,
		render: (c: Completion) => {
			const b = (c as LookCompletion).look?.badges;
			if (!b?.length) return null;
			const el = document.createElement("span");
			el.className = "sqlc-badges";
			for (const x of b) {
				const s = document.createElement("span");
				s.className = `sqlc-badge sqlc-badge-${x.toLowerCase()}`;
				s.textContent = x;
				el.append(s);
			}
			return el;
		},
	},
];

/** 행 수 줄여 쓰기 — 1,234행 · 12.3만 행 · 1.2억 행 */
export function rowsText(n: number | undefined): string {
	if (n === undefined || n < 0) return "";
	if (n < 10000) return `${n.toLocaleString("en-US")}행`;
	if (n < 1e8) {
		const m = n / 1e4;
		return `${m < 100 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m).toLocaleString("en-US")}만 행`;
	}
	const e = n / 1e8;
	return `${e < 100 ? e.toFixed(1).replace(/\.0$/, "") : Math.round(e).toLocaleString("en-US")}억 행`;
}
