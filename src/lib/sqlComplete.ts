import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";

type Node = { name: string; kind: "schema" | "table" | "view" | "column"; detail?: string | null };

/** 시스템 스키마는 후보에서 뺀다(직접 쳐서 고르면 그 안은 보인다) */
const SYSTEM = /^(pg_catalog|information_schema|pg_toast|mysql|performance_schema|sys|sysibm|ctxsys|mdsys|xdb|system|outln|dbsnmp|appqossys|wmsys|olapsys|ordsys|ordplugins|lbacsys|dvsys|gsmadmin_internal)$/i;
/** 처음에 표를 미리 읽어 둘 스키마 수 상한(아주 큰 서버에서 첫 완성이 느려지지 않게) */
const PRELOAD_SCHEMAS = 12;

const unq = (s: string) => s.replace(/^["`[]|["`\]]$/g, "");

/**
 * SQL 편집기의 DB 이름 완성 — 객체 트리(db_tree)를 그대로 써서 스키마·표·열을 후보로 낸다.
 * - 그냥 칠 때: 표·뷰(+스키마)
 * - `스키마.` 뒤: 그 스키마의 표
 * - `표.` 또는 `별칭.` 뒤: 그 표의 열(FROM·JOIN·UPDATE·INTO 의 별칭을 읽는다)
 * 결과는 연결마다 기억한다. 키워드 완성은 언어(lang-sql)가 따로 낸다.
 */
export function dbCompletionSource(tree: (path: string[]) => Promise<Node[]>): CompletionSource {
	let schemas: Promise<string[]> | null = null;
	const tables = new Map<string, Promise<Node[]>>();
	const columns = new Map<string, Promise<Node[]>>();

	const loadSchemas = () => {
		schemas ??= tree([])
			.then((l) => l.filter((n) => n.kind === "schema").map((n) => n.name))
			.catch(() => []);
		return schemas;
	};
	const loadTables = (schema: string) => {
		let p = tables.get(schema.toLowerCase());
		if (!p) {
			p = tree([schema]).catch(() => []);
			tables.set(schema.toLowerCase(), p);
		}
		return p;
	};
	const findTable = async (name: string, schema?: string): Promise<[string, string] | null> => {
		const all = await loadSchemas();
		const cands = schema ? all.filter((s) => s.toLowerCase() === schema.toLowerCase()) : all;
		for (const s of cands.slice(0, schema ? 1 : 40)) {
			const t = (await loadTables(s)).find((n) => n.name.toLowerCase() === name.toLowerCase() && n.kind !== "column");
			if (t) return [s, t.name];
		}
		return null;
	};
	const loadColumns = (schema: string, table: string) => {
		const key = `${schema}.${table}`.toLowerCase();
		let p = columns.get(key);
		if (!p) {
			p = tree([schema, table]).catch(() => []);
			columns.set(key, p);
		}
		return p;
	};

	/** 문서에서 별칭 읽기: FROM a.b x, JOIN c AS y, UPDATE d z … */
	const aliases = (doc: string) => {
		const m = new Map<string, string>();
		const re = /\b(?:from|join|update|into)\s+([\w$."`[\]]+)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
		for (const x of doc.matchAll(re)) {
			const target = x[1];
			const alias = x[2];
			if (alias && !/^(where|on|set|values|select|inner|left|right|full|cross|join|group|order|limit|using|natural)$/i.test(alias)) m.set(alias.toLowerCase(), target);
			const last = target.split(".").pop();
			if (last) m.set(unq(last).toLowerCase(), target);
		}
		return m;
	};

	return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
		const w = ctx.matchBefore(/[\w$"`[\]]+(?:\.[\w$"`[\]]*)*\.?$/);
		if (!w && !ctx.explicit) return null;
		const text = w?.text ?? "";
		const from = w?.from ?? ctx.pos;
		const dot = text.lastIndexOf(".");

		if (dot >= 0) {
			const qual = text.slice(0, dot);
			const partFrom = from + dot + 1;
			const parts = qual.split(".").map(unq);
			const all = await loadSchemas();
			// 스키마.  → 표
			if (parts.length === 1) {
				const sch = all.find((s) => s.toLowerCase() === parts[0].toLowerCase());
				const al = aliases(ctx.state.doc.toString()).get(parts[0].toLowerCase());
				if (sch && !al) {
					const opts = (await loadTables(sch)).map<Completion>((n) => ({ label: n.name, type: n.kind === "view" ? "interface" : "class", detail: n.detail ?? n.kind }));
					return { from: partFrom, options: opts, validFor: /^[\w$]*$/ };
				}
				// 별칭·표.  → 열
				const target = al ? al.split(".").map(unq) : parts;
				const hit = target.length >= 2 ? await findTable(target[target.length - 1], target[target.length - 2]) : await findTable(target[0]);
				if (!hit) return null;
				const cols = await loadColumns(hit[0], hit[1]);
				return { from: partFrom, options: cols.map((c) => ({ label: c.name, type: "property", detail: c.detail ?? "" })), validFor: /^[\w$]*$/ };
			}
			// 스키마.표.  → 열
			const hit = await findTable(parts[parts.length - 1], parts[parts.length - 2]);
			if (!hit) return null;
			const cols = await loadColumns(hit[0], hit[1]);
			return { from: partFrom, options: cols.map((c) => ({ label: c.name, type: "property", detail: c.detail ?? "" })), validFor: /^[\w$]*$/ };
		}

		if (!ctx.explicit && text.length < 1) return null;
		const all = await loadSchemas();
		const user = all.filter((s) => !SYSTEM.test(s));
		const lists = await Promise.all(user.slice(0, PRELOAD_SCHEMAS).map(async (s) => [s, await loadTables(s)] as const));
		const many = user.length > 1;
		const opts: Completion[] = [];
		for (const [s, l] of lists)
			for (const n of l) {
				if (n.kind === "column") continue;
				opts.push({ label: n.name, type: n.kind === "view" ? "interface" : "class", detail: many ? `${s} · ${n.kind === "view" ? "뷰" : "표"}` : n.kind === "view" ? "뷰" : "표", boost: -1 });
			}
		for (const s of user) opts.push({ label: s, type: "namespace", detail: "스키마", boost: -2 });
		return { from, options: opts, validFor: /^[\w$]*$/ };
	};
}
