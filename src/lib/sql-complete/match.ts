/**
 * 후보 거르기·줄 세우기 — CodeMirror 의 퍼지 점수는 대소문자가 다르면 -200 을 깎아(boost 는 ±99 까지)
 * 소문자로 치면 대문자 표·열(레거시 DB 대부분)이 소문자 키워드·문서 낱말 밑으로 밀린다.
 * 그래서 SQL 편집기는 직접 거른다: 대소문자 무시, 맞는 정도(머리 > 조각 머리·머리글자 > 중간 > 띄엄띄엄) 다음에 문맥 등급.
 */
import type { Completion } from "@codemirror/autocomplete";

export type Cand = Completion & {
	/** 문맥 등급 — 작을수록 위(0 조인 조건·열, 1 표·별칭, 2 바깥 열 …) */
	rank: number;
};

type Hit = { tier: number; ranges: number[] };

function parts(label: string): number[] {
	// 조각 시작 위치 — 밑줄·점 뒤, 소문자→대문자 경계
	const out = [0];
	for (let i = 1; i < label.length; i++) {
		const p = label[i - 1];
		const c = label[i];
		if ((p === "_" || p === "." || p === " ") && c !== "_") out.push(i);
		else if (/[a-z0-9]/.test(p) && /[A-Z]/.test(c)) out.push(i);
	}
	return out;
}

export function matchLabel(label: string, typed: string): Hit | null {
	if (!typed) return { tier: 0, ranges: [] };
	const L = label.toLowerCase();
	const T = typed.toLowerCase();
	if (L.startsWith(T)) return { tier: L.length === T.length ? -1 : 0, ranges: [0, T.length] };
	const ps = parts(label);
	for (const p of ps) if (p > 0 && L.startsWith(T, p)) return { tier: 1, ranges: [p, p + T.length] };
	// 머리글자(frd → FIRST_REG_DATE)
	if (T.length >= 2 && ps.length >= T.length) {
		let ok = true;
		for (let i = 0; i < T.length && ok; i++) ok = L[ps[i]] === T[i];
		if (ok) return { tier: 1, ranges: ps.slice(0, T.length).flatMap((p) => [p, p + 1]) };
	}
	if (T.length >= 2) {
		const at = L.indexOf(T);
		if (at >= 0) return { tier: 2, ranges: [at, at + T.length] };
	}
	if (T.length >= 3) {
		const r: number[] = [];
		let j = 0;
		for (let i = 0; i < L.length && j < T.length; i++)
			if (L[i] === T[j]) {
				r.push(i, i + 1);
				j++;
			}
		if (j === T.length && L[0] === T[0]) return { tier: 3, ranges: r };
	}
	return null;
}

/** 거르고 세운 후보 + 강조 범위(getMatch 용) */
export function rankFilter(cands: Cand[], typed: string, limit = 400): { options: Completion[]; ranges: WeakMap<Completion, number[]> } {
	const hits: { c: Cand; h: Hit; i: number }[] = [];
	for (let i = 0; i < cands.length; i++) {
		const h = matchLabel(cands[i].label, typed);
		if (h) hits.push({ c: cands[i], h, i });
	}
	// 갈래: 꼭 같은 이름 > 머리 > 조각 머리·머리글자 > 중간 > 띄엄띄엄. 같은 갈래 안에서는 문맥 등급이 먼저
	hits.sort((a, b) => a.h.tier - b.h.tier || a.c.rank - b.c.rank || (b.c.boost ?? 0) - (a.c.boost ?? 0) || a.i - b.i);
	const ranges = new WeakMap<Completion, number[]>();
	const options: Completion[] = [];
	for (const x of hits.slice(0, limit)) {
		options.push(x.c);
		if (!x.c.displayLabel) ranges.set(x.c, x.h.ranges);
	}
	return { options, ranges };
}
