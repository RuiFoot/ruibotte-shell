import { invoke } from "@tauri-apps/api/core";

type Col = { name: string; kind: string };
type Cell = string | null;

/** 엑셀 한 장 상한(머리 한 줄 빼고) */
export const XLSX_MAX_ROWS = 1_048_575;
const STEP = 5000;

/** 숫자 열의 값은 숫자로(정밀도를 잃지 않을 때만), 나머지는 글자 그대로 */
function toCell(v: Cell, kind: string): string | number | null {
	if (v == null) return null;
	if ((kind === "int" || kind === "numeric") && /^-?\d+(\.\d+)?$/.test(v)) {
		const digits = v.replace(/[-.]/g, "").replace(/^0+/, "").length;
		if (digits <= 15) return Number(v);
	}
	return v;
}

function sheetName(s: string) {
	return s.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet1";
}

/**
 * 결과를 xlsx 로 — 행은 fetch 로 5000행씩 받는다(보기에 정렬·거르기가 걸려 있으면 그 순서·그 행들).
 * 저장은 local_write_bytes(바이트 그대로).
 */
export async function saveXlsx(path: string, cols: Col[], total: number, fetch: (from: number, to: number) => Promise<Cell[][]>, name = "Sheet1") {
	const XLSX = await import("xlsx");
	const n = Math.min(total, XLSX_MAX_ROWS);
	const aoa: (string | number | null)[][] = [cols.map((c) => c.name)];
	for (let from = 0; from < n; from += STEP) {
		const rows = await fetch(from, Math.min(n, from + STEP));
		if (!rows.length) break;
		for (const r of rows) aoa.push(cols.map((c, i) => toCell(r[i] ?? null, c.kind)));
	}
	const ws = XLSX.utils.aoa_to_sheet(aoa);
	// 열 너비(앞 200행 기준, 8~60자)
	ws["!cols"] = cols.map((c, i) => {
		let w = c.name.length;
		for (let r = 1; r < Math.min(aoa.length, 200); r++) {
			const v = aoa[r][i];
			if (v != null) w = Math.max(w, String(v).length);
		}
		return { wch: Math.min(60, Math.max(8, w + 1)) };
	});
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, sheetName(name));
	const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
	await invoke("local_write_bytes", new Uint8Array(out), { headers: { "x-path": encodeURIComponent(path) } });
	return { rows: aoa.length - 1, capped: total > XLSX_MAX_ROWS };
}
