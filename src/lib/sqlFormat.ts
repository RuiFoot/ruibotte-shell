import type { EditorView } from "@codemirror/view";

/** 엔진 → sql-formatter 방언 */
function dialect(engine: string): string {
	if (engine === "postgres") return "postgresql";
	if (engine === "mariadb") return "mariadb";
	if (engine === "mysql") return "mysql";
	if (engine === "mssql") return "transactsql";
	if (engine === "oracle" || engine === "tibero") return "plsql";
	return "sql";
}

/**
 * SQL 정렬(Shift+Alt+F) — 고른 글이 있으면 그것만, 없으면 문서 전체. 키워드는 대문자(설정으로 소문자·그대로).
 * 정렬기는 처음 쓸 때만 받는다(묶음 크기). 실패하면(방언이 못 읽는 문장) 손대지 않고 false.
 */
export async function formatSqlIn(view: EditorView, engine: string, keywordCase: "upper" | "lower" | "preserve" = "upper"): Promise<boolean> {
	const { format } = await import("sql-formatter");
	const sel = view.state.selection.main;
	const from = sel.empty ? 0 : sel.from;
	const to = sel.empty ? view.state.doc.length : sel.to;
	const text = view.state.sliceDoc(from, to);
	if (!text.trim()) return false;
	try {
		const out = format(text, { language: dialect(engine) as never, keywordCase, tabWidth: 4, linesBetweenQueries: 1 });
		if (out !== text) view.dispatch({ changes: { from, to, insert: out }, userEvent: "input.format" });
		return true;
	} catch {
		return false;
	}
}
