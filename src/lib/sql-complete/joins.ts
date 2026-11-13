/**
 * JOIN … ON 뒤 조인 조건 제안.
 * 1) 외래 키가 있으면 그것으로
 * 2) 없으면(레거시 DB 대부분) 이름 규칙 — 한쪽 PK 를 다른 쪽이 같은 이름으로 가짐, <표>_ID ↔ ID, PARENT_ID ↔ 같은 표 PK
 * 3) 같은 이름·같은 형식 열(등록일·사용 여부 같은 공통 감사 열은 뺀다)
 */
import { nameParts } from "./alias";

export type ColInfo = { name: string; type: string; pk: boolean; idx: boolean; notNull: boolean };
export type JoinSide = { name: string; alias?: string; cols: ColInfo[] };
export type FkRow = { table: string; column: string; refTable: string; refColumn: string };
export type JoinHint = { text: string; score: number; why: "FK" | "키" | "이름 규칙" | "같은 이름" };

/** 어느 표에나 있는 감사·상태 열 — 같은 이름이어도 조인 열이 아니다 */
const COMMON =
	/^(REG|RGST|REGIST|FRST_REGIST|LAST_UPDT|UPD|UPDT|MOD|MODIFY|CREATE|CREATED|UPDATE|UPDATED|DELETED|INS|CHG)_?(DT|DATE|DTTM|TIME|TM|PNTTM|ID|USER|USR|BY|AT|ON|NM)?$|_(DT|DATE|DTTM|PNTTM|YN|AT|TIME|NM|NAME|CN|DC|DESC|SJ|TITLE|CONTENT|URL|PATH|EXT|SIZE|CNT|AMT|PRICE|QTY)$|^(USE_YN|DEL_YN|DELETE_YN|SORT_ORDR|SORT_ORDN|SORT|ORDER|SEQ|DESCRIPTION|REMARK|NOTE|NAME|TITLE|STATUS|STATE|TYPE|CONTENT|CREATED_AT|UPDATED_AT|DELETED_AT|VERSION|URL|PATH|HIT|SCORE|DEPTH|LEVEL|LANG|CATEGORY|EMAIL|PHONE|ADDRESS)$/i;
/** 식별자 같은 이름(…_ID·…_NO·…_CD·…_SN·…_SEQ·…_IDX·…Id) — 같은 이름이면 조인 열일 가능성이 높다 */
const ID_LIKE = /(^|_)(ID|NO|CD|CODE|SN|SEQ|KEY|IDX)$|[a-z]Id$/i;

/** 형식 갈래 — 같은 갈래끼리만 같은 열로 본다 */
export function typeFamily(t: string): string {
	const x = t.toLowerCase().replace(/\s+unsigned|\s+signed|\s+zerofill/g, "");
	if (/^(tiny|small|medium|big)?int|^integer|^serial|^bigserial|^int[248]|^number\(\d+(,\s*0)?\)$|^number$|^numeric\(\d+(,\s*0)?\)$/.test(x)) return "int";
	if (/^(n?var)?char|^varchar2|^nvarchar2|^character|^text|^string|^uniqueidentifier|^uuid|^citext|^tinytext|^mediumtext|^longtext|^clob|^nclob/.test(x)) return "str";
	if (/^(date|time|timestamp|datetime|smalldatetime|year)/.test(x)) return "time";
	if (/^(decimal|numeric|number|float|double|real|money)/.test(x)) return "num";
	return x.replace(/\(.*$/, "");
}

const q = (s: JoinSide) => s.alias ?? s.name;
const lc = (s: string) => s.toLowerCase();
/** 표 이름의 줄기 — TB_ORDERS → order, customer → customer */
function stems(table: string): string[] {
	const parts = nameParts(table).map(lc);
	// 흔한 머리말(TB_·T_·TBL_·RC_ 같은 두세 글자) 은 뺀다
	while (parts.length > 1 && /^(tb|tbl|t|rc|tn|tm|th|mst|dt|v|vw)$/.test(parts[0])) parts.shift();
	const out = new Set<string>();
	const last = parts[parts.length - 1] ?? lc(table);
	const whole = parts.join("_");
	for (const w of [whole, last]) {
		out.add(w);
		if (w.endsWith("ies")) out.add(`${w.slice(0, -3)}y`);
		else if (w.endsWith("ses") || w.endsWith("xes")) out.add(w.slice(0, -2));
		else if (w.endsWith("s") && w.length > 3) out.add(w.slice(0, -1));
	}
	return [...out];
}
const sameFamily = (a: ColInfo, b: ColInfo) => !a.type || !b.type || typeFamily(a.type) === typeFamily(b.type);

export function suggestJoins(right: JoinSide, lefts: JoinSide[], fks: FkRow[], limit = 8): JoinHint[] {
	const out = new Map<string, JoinHint>();
	const add = (text: string, score: number, why: JoinHint["why"]) => {
		const k = lc(text);
		const cur = out.get(k);
		if (!cur || cur.score < score) out.set(k, { text, score, why });
	};
	const eq = (r: JoinSide, rc: string, l: JoinSide, lcn: string) => `${q(r)}.${rc} = ${q(l)}.${lcn}`;

	for (const [li, left] of lefts.entries()) {
		// 가까운(나중에 붙은) 표를 조금 더 위로
		const near = (li + 1) / (lefts.length + 1);
		const self = lc(left.name) === lc(right.name);
		const rcols = new Map(right.cols.map((c) => [lc(c.name), c]));
		const lcols = new Map(left.cols.map((c) => [lc(c.name), c]));

		// 1) 외래 키 — 같은 두 표 사이 열이 여럿이면 AND 로 묶은 것도
		const fwd = fks.filter((f) => lc(f.table) === lc(right.name) && lc(f.refTable) === lc(left.name));
		const back = fks.filter((f) => lc(f.table) === lc(left.name) && lc(f.refTable) === lc(right.name));
		for (const f of fwd) add(eq(right, f.column, left, f.refColumn), 100 + near, "FK");
		for (const f of back) add(eq(right, f.refColumn, left, f.column), 100 + near, "FK");
		if (fwd.length > 1) add(fwd.map((f) => eq(right, f.column, left, f.refColumn)).join(" AND "), 101 + near, "FK");
		if (back.length > 1) add(back.map((f) => eq(right, f.refColumn, left, f.column)).join(" AND "), 101 + near, "FK");

		// 2) 한쪽 PK 열을 다른 쪽이 모두 같은 이름으로 가지면 — 복합 키면 AND 로
		for (const [a, flip] of [[left, false], [right, true]] as const) {
			const pk = a.cols.filter((c) => c.pk);
			if (!pk.length || self) continue;
			const bmap = flip ? lcols : rcols;
			if (!pk.every((c) => bmap.has(lc(c.name)) && sameFamily(c, bmap.get(lc(c.name)) as ColInfo))) continue;
			const conds = pk.map((c) => {
				const other = (bmap.get(lc(c.name)) as ColInfo).name;
				return flip ? eq(right, c.name, left, other) : eq(right, other, left, c.name);
			});
			const generic = pk.length === 1 && /^(id|seq|no|idx|sn|key)$/i.test(pk[0].name);
			// 양쪽 다 제 PK 인 id·seq — 서로 다른 표의 id = id 는 거의 언제나 틀린 조인
			if (generic && (bmap.get(lc(pk[0].name)) as ColInfo).pk) continue;
			add(conds.join(" AND "), (generic ? 55 : 90) + near, "키");
		}

		// 3) 이름 규칙 — <표>_ID ↔ ID(PK) 같은 것
		for (const [a, b, flip] of [[left, right, false], [right, left, true]] as const) {
			const pk = a.cols.filter((c) => c.pk);
			if (pk.length !== 1) continue;
			const key = pk[0];
			const keyName = lc(key.name);
			for (const stem of stems(a.name)) {
				const variants = /^(id|no|seq|sn|cd|code|idx|key)$/.test(keyName)
					? [`${stem}_${keyName}`, `${stem}${keyName}`]
					: [];
				for (const v of variants) {
					const hit = b.cols.find((c) => lc(c.name).replace(/_/g, "") === v.replace(/_/g, "") && sameFamily(c, key));
					if (hit) add(flip ? eq(right, key.name, left, hit.name) : eq(right, hit.name, left, key.name), 85 + near, "이름 규칙");
				}
			}
			// 같은 표(자기 조인) — PARENT_ID·UPPER_ID·UP_MENU_ID ↔ PK
			if (self) {
				for (const c of b.cols) {
					if (c.pk || !sameFamily(c, key)) continue;
					if (/^(parent|upper|up|prnt|high|super|p)_?/i.test(c.name) && (lc(c.name).endsWith(keyName.replace(/^.*_/, "")) || /^(parent|upper|up)_?(id|no|cd|seq)$/i.test(c.name))) {
						// 붙이는 표(오른쪽)가 부모인 쪽(p.ID = c.PARENT_ID)을 조금 위로
						add(flip ? eq(right, key.name, left, c.name) : eq(right, c.name, left, key.name), (flip ? 88.2 : 88) + near, "이름 규칙");
					}
				}
			}
		}

		// 4) 같은 이름·같은 형식 — 식별자 같은 이름·키·인덱스 열이면 높게, 공통 감사·설명 열은 뺀다
		if (!self) {
			const ids: string[] = [];
			let best = 0;
			for (const rc of right.cols) {
				const lcol = lcols.get(lc(rc.name));
				if (!lcol || !sameFamily(rc, lcol)) continue;
				const keyed = rc.pk || lcol.pk || rc.idx || lcol.idx;
				if (COMMON.test(rc.name) && !(rc.pk || lcol.pk)) continue;
				// 양쪽 다 id·seq 같은 제 PK — 서로 다른 표의 id = id 는 거의 언제나 틀린 조인
				if (rc.pk && lcol.pk && /^(id|seq|no|idx|sn|key)$/i.test(rc.name)) continue;
				const idLike = ID_LIKE.test(rc.name);
				// …_ID·_NO·_CD 가 …_SN·_SEQ·_IDX(순번) 보다 조금 위
				const idScore = /(SN|SEQ|IDX)$/i.test(rc.name) ? 64 : 66;
				const score = (keyed && idLike ? 75 : keyed ? 62 : idLike ? idScore : 40) + near;
				best = Math.max(best, score);
				add(eq(right, rc.name, left, lcol.name), score, "같은 이름");
				if (idLike) ids.push(eq(right, rc.name, left, lcol.name));
			}
			// 식별자 같은 열이 꼭 둘 같으면(첨부 ID + 순번) 묶은 한 줄도 — 가장 좋은 한 열 바로 아래
			if (ids.length === 2) add(ids.join(" AND "), best - 0.1, "같은 이름");
		}
	}
	return [...out.values()].sort((a, b) => b.score - a.score || a.text.length - b.text.length).slice(0, limit);
}
