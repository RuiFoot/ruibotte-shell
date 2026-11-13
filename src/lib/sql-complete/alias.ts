/**
 * 표 별칭 제안 — 이름 조각의 머리글자(TB_BOARD_ARTICLE → tba, orderItem → oi).
 * 이 문장이 이미 쓰는 별칭·표 이름이나 SQL 예약어와 겹치면 숫자를 붙인다(tba2).
 */
const AVOID = new Set(
	(
		"as at by do go if in is no of on or to up all and any are asc but end for get key new not off old one out row set top use add " +
		"desc from into join left like null only over then user view when with case cast drop full last next open rows show some sum " +
		"min max avg each else exit fast file find form free goto hash help high hour int less lock long loop low mod mode more name"
	).split(" "),
);

/** 이름 조각 — 밑줄·숫자·대소문자 경계로 자른다 */
export function nameParts(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.split(/[^A-Za-z0-9\u0080-\uffff]+/)
		.filter((p) => p && !/^\d+$/.test(p));
}

/** used: 이미 쓴 이름(소문자 Set 이면 그대로 쓴다 — 표 수천 개 목록에서 매번 복사하지 않게) */
export function suggestAlias(table: string, used: Iterable<string>): string {
	const taken = used instanceof Set ? (used as Set<string>) : new Set([...used].map((u) => u.toLowerCase()));
	const parts = nameParts(table);
	let base = parts
		.slice(0, 5)
		.map((p) => p[0])
		.join("")
		.toLowerCase();
	if (!base) base = "t";
	if (!/^[a-z_]/.test(base)) base = `t${base}`;
	// 조각이 하나뿐인 짧은 이름(users → u)은 머리글자 하나 — 그것이 예약어면(as·in…) 두 글자로
	if (parts.length === 1 && AVOID.has(base)) base = parts[0].slice(0, 2).toLowerCase();
	const ok = (a: string) => !taken.has(a) && !AVOID.has(a) && a !== table.toLowerCase();
	if (ok(base)) return base;
	for (let i = 2; i < 100; i++) if (ok(`${base}${i}`)) return `${base}${i}`;
	return `${base}_x`;
}
