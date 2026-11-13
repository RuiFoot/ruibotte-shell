/**
 * SQL 편집기 완성 소스 — 문맥(context.ts)을 읽어 그 자리에 맞는 후보만, 정해진 순서로 낸다.
 * 순서: 조인 조건 > 이 문장 표의 열 > 표·별칭 > 바깥 문장 열 > 함수 > 키워드 > 문서 낱말.
 * 거르기는 직접 한다(match.ts) — 결과는 filter:false + update 로, 이어 치는 동안 다시 묻지 않고 그 자리에서 다시 거른다.
 */
import { type Completion, type CompletionContext, type CompletionResult, pickedCompletion } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { splitSql } from "../sql";
import { suggestAlias } from "./alias";
import { type Analysis, analyze, columnRefs, isReserved, statementRange, type TableRef } from "./context";
import { familyOf, functionsFor } from "./functions";
import { type ColInfo, suggestJoins } from "./joins";
import { caseHabit, keywordsFor } from "./keywords";
import { type Cand, rankFilter } from "./match";
import { type Meta, SYSTEM_SCHEMA, type TableInfo } from "./meta";
import { type Look, rowsText } from "./render";

export type CompleteSettings = {
	/** 표를 고르면 별칭 붙이기 */
	alias: boolean;
	/** 별칭(·표 여럿)이 있으면 열을 a.열 로 넣기 — 이름이 겹치는 열은 이것과 상관없이 붙인다 */
	qualify: boolean;
	/** 문서 낱말(맨 뒤) */
	words: boolean;
};

type C = Cand & { look?: Look };

const WORDCH = /^[\w$#\u0080-\uffff]*$/;
/** 한 번에 읽는 문서 범위(커서 앞뒤) — 아주 긴 문서에서도 문장 찾기가 빠르게 */
const WINDOW = 40000;
const MAX_TABLES = 4000;

/** 인용이 필요한 이름인가 */
function needsQuote(name: string, engine: string): boolean {
	if (!/^[A-Za-z_][\w$#]*$/.test(name)) return true;
	const fam = familyOf(engine);
	if (fam === "pg" && name !== name.toLowerCase()) return true;
	if (fam === "oracle" && name !== name.toUpperCase()) return true;
	return isReserved(name) || /^(USER|INDEX|KEY|ORDER|GROUP|TABLE|DESC|CHECK|COLUMN|LEVEL|SIZE|COMMENT|DATE|NUMBER|ROWS|RANK)$/i.test(name);
}
function quoteIdent(name: string, engine: string): string {
	const fam = familyOf(engine);
	if (fam === "mysql") return `\`${name.replaceAll("`", "``")}\``;
	if (fam === "mssql") return `[${name.replaceAll("]", "]]")}]`;
	return `"${name.replaceAll('"', '""')}"`;
}
export type SqlSource = {
	(cx: CompletionContext): Promise<CompletionResult | null>;
	meta: Meta;
	/** 커서 자리 문맥(문서 위치 off = 문장 시작) */
	read: (state: EditorState, pos: number) => { a: Analysis; off: number };
	starColumns: (a: Analysis) => Promise<{ text: string; count: number } | null>;
};

export function createSource(meta: Meta, settings: () => CompleteSettings): SqlSource {
	const engine = meta.engine;
	const fam = familyOf(engine);
	const tokOpts = { mysql: fam === "mysql", brackets: fam === "mssql" };

	/** 이름은 DB 에 있는 대소문자 그대로(MySQL 표 이름은 대소문자를 가린다) — 인용이 필요하면 감싼다 */
	const ident = (name: string, a: Analysis) => (a.quote || !needsQuote(name, engine) ? name : quoteIdent(name, engine));
	const qualName = (r: TableRef) => r.alias ?? r.name;

	/** 표 참조 → 실제 표·열 */
	const columnsOf = async (r: TableRef): Promise<{ table?: TableInfo; cols: ColInfo[] }> => {
		if (r.kind !== "table") return { cols: (r.cols ?? []).map((name) => ({ name, type: "", pk: false, idx: false, notNull: false })) };
		const t = await meta.resolve(r.name, r.schema);
		if (!t) return { cols: [] };
		return { table: t, cols: await meta.columns(t.schema, t.name) };
	};

	const colLook = (c: ColInfo, src: string | undefined): Look => ({
		icon: c.pk ? "key" : "column",
		src,
		badges: [...(c.pk ? (["PK"] as const) : c.idx ? (["IDX"] as const) : []), ...(!c.notNull && c.type ? (["NULL"] as const) : [])],
	});

	/** 열 후보 — 커서 범위 표 먼저, 바깥 범위(상관 서브쿼리)는 별칭을 붙여 뒤에 */
	const columnCands = async (a: Analysis, refs: TableRef[], qualifyMode: "auto" | "never"): Promise<C[]> => {
		const loaded = await Promise.all(refs.map(columnsOf));
		const own = refs.filter((r) => r.scope === a.scope);
		const count = new Map<string, number>();
		for (const [i, r] of refs.entries()) if (r.scope === a.scope) for (const c of loaded[i].cols) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);
		const out: C[] = [];
		const s = settings();
		for (const [i, r] of refs.entries()) {
			const outer = r.scope !== a.scope;
			for (const c of loaded[i].cols) {
				const ambiguous = (count.get(c.name.toLowerCase()) ?? 0) > 1;
				const qualify = qualifyMode !== "never" && !a.quote && (outer || ambiguous || (s.qualify && (!!r.alias || own.length > 1)));
				const name = ident(c.name, a);
				const q = qualName(r);
				out.push({
					label: name,
					apply: qualify ? `${ident(q, a)}.${name}` : name,
					detail: c.type,
					rank: outer ? 3 : 0,
					boost: c.pk ? 2 : c.idx ? 1 : 0,
					look: colLook(c, own.length > 1 || outer || qualify ? q : undefined),
				});
			}
		}
		return out;
	};

	/** 표 후보 — 기본 스키마 표, 읽어 둔 다른 스키마 표(스키마.표), 스키마 이름, 이 문장의 WITH 이름 */
	const tableCands = async (a: Analysis, schema?: string, withAlias = true): Promise<C[]> => {
		const s = settings();
		const def = await meta.defaultSchema();
		const out: C[] = [];
		const used = new Set(a.used);
		const addTable = (t: TableInfo, qualifySchema: boolean, rank: number) => {
			const name = ident(t.name, a);
			const full = qualifySchema ? `${ident(t.schema, a)}.${name}` : name;
			const alias = withAlias && a.aliasOk && s.alias && !a.nextIsName ? suggestAlias(t.name, used) : undefined;
			out.push({
				label: name,
				apply: alias ? `${full} ${alias}` : full,
				detail: rowsText(t.rows),
				rank,
				boost: t.view ? -1 : 0,
				info: `${t.schema}.${t.name}${t.view ? " · 뷰" : ""}${t.note ? ` · ${t.note}` : ""}${t.rows !== undefined ? ` · 약 ${t.rows.toLocaleString("en-US")}행(통계 추정)` : ""}${alias ? `\n별칭 ${alias} 를 함께 넣습니다(설정에서 끌 수 있음)` : ""}`,
				look: { icon: t.view ? "view" : "table", src: [qualifySchema ? t.schema : "", t.view ? "뷰" : t.note ?? "", alias ? `→ ${alias}` : ""].filter(Boolean).join(" · ") || undefined },
			});
		};
		if (schema) {
			const l = await meta.tables(schema);
			await meta.rowsSoon(schema);
			for (const t of l.slice(0, MAX_TABLES)) addTable(t, false, 1);
			return out;
		}
		// WITH 이름
		for (const r of a.refs) if (r.kind === "cte" && !out.some((o) => o.label === r.name)) out.push({ label: r.name, rank: 0, detail: "WITH", look: { icon: "cte" } });
		const all = await meta.schemas();
		const users = all.filter((x) => !SYSTEM_SCHEMA.test(x));
		if (def) {
			const l = await meta.tables(def);
			await meta.rowsSoon(def);
			for (const t of l.slice(0, MAX_TABLES)) addTable(t, false, 1);
		}
		// 다른 사용자 스키마 — 몇 개 안 되면 읽어 두고, 이미 읽은 것은 스키마.표 로
		const others = users.filter((x) => x !== def);
		if (others.length <= 4) for (const o of others) void meta.tables(o);
		let n = out.length;
		for (const o of others) {
			const l = meta.tablesNow(o);
			if (!l) continue;
			for (const t of l) {
				if (n++ > MAX_TABLES) break;
				addTable(t, true, 2);
			}
		}
		for (const x of users) if (x !== def) out.push({ label: ident(x, a), rank: 2, detail: "스키마", look: { icon: "schema" } });
		return out;
	};

	const fnCands = (a: Analysis, habit: "upper" | "lower"): C[] =>
		functionsFor(engine).map((f) => {
			const name = habit === "lower" ? f.name.toLowerCase() : f.name;
			const paren = !!f.args;
			return {
				label: name,
				detail: f.ret,
				rank: 5,
				boost: f.agg && (a.clause === "select" || a.clause === "having") ? 1 : 0,
				info: `${f.name}${f.args}${f.ret ? ` → ${f.ret}` : ""}`,
				look: { icon: "function", src: f.args.length > 28 ? `${f.args.slice(0, 27)}…)` : f.args || undefined },
				apply: paren
					? (view: EditorView, c: Completion, from: number, to: number) => {
							const text = `${name}()`;
							// 인자가 있으면 괄호 안에, 없으면 괄호 뒤에
							const at = from + name.length + (f.args === "()" ? 2 : 1);
							view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: at }, annotations: pickedCompletion.of(c), userEvent: "input.complete" });
						}
					: name,
			};
		});

	const kwCands = (a: Analysis, habit: "upper" | "lower", rank = 6): C[] =>
		keywordsFor(a, engine).map((k) => {
			const label = habit === "lower" ? k.toLowerCase() : k;
			return { label, rank, look: { icon: "keyword" } };
		});

	/** 문서 낱말 — 맨 뒤, 이미 후보에 있는 이름은 빼고 */
	const wordCands = (text: string, have: C[], at: number, a: Analysis): C[] => {
		const seen = new Set([...have.map((h) => h.label.toLowerCase()), ...a.used]);
		const out: C[] = [];
		const re = /[A-Za-z_\u0080-\uffff][\w$#\u0080-\uffff]{2,}/g;
		for (let m = re.exec(text); m && out.length < 300; m = re.exec(text)) {
			if (m.index <= at && at <= m.index + m[0].length) continue;
			const k = m[0].toLowerCase();
			if (seen.has(k) || isReserved(m[0])) continue;
			seen.add(k);
			out.push({ label: m[0], rank: 9, detail: "문서", look: { icon: "word" } });
		}
		return out;
	};

	/** * 펼치기 후보 */
	const starCand = async (a: Analysis, off: number): Promise<C | null> => {
		if (!a.star) return null;
		const list = await starColumns(a);
		if (!list) return null;
		const { from, to } = a.star;
		return {
			label: "",
			displayLabel: `* → 열 ${list.count}개 펼치기`,
			rank: -2,
			look: { icon: "star", src: list.text.length > 40 ? `${list.text.slice(0, 39)}…` : list.text },
			apply: (view: EditorView, c: Completion) => view.dispatch({ changes: { from: off + from, to: off + to, insert: list.text }, annotations: pickedCompletion.of(c), userEvent: "input.complete" }),
		};
	};
	/** * 자리에 넣을 열 목록 — 표가 여럿이면 별칭.열, a.* 는 그 표만 */
	const starColumns = async (a: Analysis): Promise<{ text: string; count: number } | null> => {
		let refs = columnRefs(a).filter((r) => r.scope === a.scope);
		const q = a.star?.qualifier?.toLowerCase();
		if (q) refs = refs.filter((r) => (r.alias ?? r.name).toLowerCase() === q || r.name.toLowerCase() === q);
		if (!refs.length) return null;
		const loaded = await Promise.all(refs.map(columnsOf));
		const multi = refs.length > 1 || !!q;
		const parts: string[] = [];
		for (const [i, r] of refs.entries()) for (const c of loaded[i].cols) parts.push(multi ? `${qualName(r)}.${ident(c.name, a)}` : ident(c.name, a));
		if (!parts.length) return null;
		return { text: parts.join(", "), count: parts.length };
	};

	const read = (state: EditorState, pos: number) => {
		const doc = state.doc;
		const wFrom = Math.max(0, pos - WINDOW);
		const wTo = Math.min(doc.length, pos + WINDOW);
		const text = doc.sliceString(wFrom, wTo);
		const r = statementRange(splitSql(text), text, pos - wFrom);
		const stmt = text.slice(r.from, Math.max(r.to, pos - wFrom));
		return { a: analyze(stmt, pos - wFrom - r.from, tokOpts), off: wFrom + r.from, stmt, text, wFrom };
	};

	const source = (async (cx: CompletionContext): Promise<CompletionResult | null> => {
		const { a, off, stmt, text, wFrom } = read(cx.state, cx.pos);
		if (a.kind === "none") return null;
		if (!cx.explicit && !a.prefix) {
			// 친 낱말이 없을 때 저절로 여는 자리: 점 뒤, FROM·JOIN 뒤 빈칸, ON 뒤 빈칸, INSERT 열 괄호
			const ch = cx.state.sliceDoc(cx.pos - 1, cx.pos);
			const ok = (a.kind === "member" && ch === ".") || ((a.kind === "table" || a.join) && /\s/.test(ch)) || (a.kind === "insertColumns" && (ch === "(" || /\s/.test(ch)));
			if (!ok) return null;
		}
		const habit = caseHabit(a.prefix, stmt);
		const s = settings();
		let cands: C[] = [];

		if (a.kind === "member" && a.qualifier) {
			const q = a.qualifier;
			const last = q[q.length - 1].toLowerCase();
			const ref = q.length === 1 ? a.refs.find((r) => r.alias?.toLowerCase() === last) ?? a.refs.find((r) => !r.alias && r.name.toLowerCase() === last) ?? a.refs.find((r) => r.name.toLowerCase() === last) : undefined;
			if (ref) cands = await columnCands(a, [ref], "never");
			else {
				const sch = q.length === 1 ? (await meta.schemas()).find((x) => x.toLowerCase() === last) : undefined;
				// 스키마. → 그 스키마의 표(FROM·JOIN·UPDATE 자리면 별칭도)
				if (sch) cands = await tableCands(a, sch, !!a.aliasOk);
				else {
					const t = await meta.resolve(q[q.length - 1], q.length > 1 ? q[q.length - 2] : undefined);
					if (t) cands = await columnCands(a, [{ name: t.name, schema: t.schema, at: 0, scope: a.scope, kind: "table", role: "from" }], "never");
				}
			}
			// a.* 를 넣을 수 있게(SELECT 목록)
			if (ref && a.clause === "select") cands.unshift({ label: "*", rank: -1, detail: "모든 열", look: { icon: "star" } });
		} else if (a.kind === "table") {
			cands = await tableCands(a);
		} else if (a.kind === "insertColumns" && a.insertTable) {
			cands = await columnCands(a, [a.insertTable], "never");
			if (!a.prefix && cands.length > 1)
				cands.unshift({ label: "", displayLabel: `열 ${cands.length}개 모두`, apply: cands.map((c) => c.label).join(", "), rank: -1, look: { icon: "star" } });
		} else if (a.kind === "afterTable" || a.kind === "keyword") {
			cands = kwCands(a, habit, 6);
		} else {
			// 열 문맥
			const refs = columnRefs(a);
			if (a.join) {
				const sides = await Promise.all([a.join.right, ...a.join.left].map(async (r) => ({ r, ...(await columnsOf(r)) })));
				const [right, ...lefts] = sides;
				const fks = right.table ? await meta.fks(right.table.schema) : [];
				const hints = suggestJoins(
					{ name: right.table?.name ?? right.r.name, alias: right.r.alias ?? (right.r.kind === "table" ? right.r.name : undefined), cols: right.cols },
					lefts.map((l) => ({ name: l.table?.name ?? l.r.name, alias: l.r.alias ?? (l.r.kind === "table" ? l.r.name : undefined), cols: l.cols })),
					fks,
				);
				for (const [i, h] of hints.entries()) cands.push({ label: h.text, rank: -1, boost: 20 - i, detail: h.why, look: { icon: "join" } });
			}
			const star = await starCand(a, off);
			if (star && cx.explicit) cands.push(star);
			if (a.clause !== "values" && a.clause !== "limit") {
				cands.push(...(await columnCands(a, refs, a.clause === "set" || a.clause === "into" ? "never" : "auto")));
				// 별칭·표 이름(점을 찍으려고 치는 중일 때)
				for (const r of refs) if (r.scope === a.scope) cands.push({ label: qualName(r), rank: 1, detail: r.alias ? r.name : "표", look: { icon: "alias" } });
				if (!refs.length) cands.push(...(await tableCands({ ...a, aliasOk: false }, undefined, false)).map((c) => ({ ...c, rank: 4 })));
			}
			cands.push(...fnCands(a, habit));
			cands.push(...kwCands(a, habit));
		}
		if (cx.aborted) return null;
		if (s.words && a.kind !== "table" && a.kind !== "member" && a.kind !== "insertColumns" && (a.prefix.length >= 2 || cx.explicit)) cands.push(...wordCands(text, cands, cx.pos - wFrom, a));

		const from = off + a.from;
		const make = (typed: string): CompletionResult | null => {
			const { options, ranges } = rankFilter(cands, typed);
			if (!options.length) return null;
			return { from, options, filter: false, getMatch: (c) => ranges.get(c) ?? [], update: (_cur, f, _to, ncx) => (f === from && WORDCH.test(ncx.state.sliceDoc(f, ncx.pos)) ? make(ncx.state.sliceDoc(f, ncx.pos)) : null) };
		};
		return make(a.prefix);
	}) as SqlSource;
	source.meta = meta;
	source.read = read;
	source.starColumns = starColumns;
	return source;
}

/** SELECT 목록의 * (또는 a.*) 를 열 목록으로 펼치기 — 명령(단축키)용. 커서 옆에 펼칠 * 가 없으면 false(다른 키 몫) */
export function expandStarAt(view: EditorView, src: SqlSource): boolean {
	const pos = view.state.selection.main.head;
	const doc = view.state.doc;
	// 커서가 * 바로 뒤이거나 바로 앞
	const at = doc.sliceString(pos - 1, pos) === "*" ? pos : doc.sliceString(pos, pos + 1) === "*" ? pos + 1 : -1;
	if (at < 0) return false;
	const { a, off } = src.read(view.state, at);
	const star = a.star;
	if (!star) return false;
	const before = doc.sliceString(off + star.from, off + star.to);
	void src.starColumns(a).then((list) => {
		// 기다리는 동안 글이 바뀌었으면 그만
		if (!list || view.state.doc.sliceString(off + star.from, off + star.to) !== before) return;
		view.dispatch({ changes: { from: off + star.from, to: off + star.to, insert: list.text }, userEvent: "input.complete" });
	});
	return true;
}
