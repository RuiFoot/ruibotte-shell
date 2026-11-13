import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

const PAGE = 200;
const ROW_H = 26;
/** 열이 이만큼 이상이면 가로로 보이는 열만 그린다(열 100개 × 보이는 행 60 = 6천 칸을 매번 그리지 않게) */
const COL_VIRT_MIN = 60;
/** 화면 양옆으로 미리 그려 두는 폭(px) — 가로 스크롤 때 빈칸이 비치지 않게 */
const COL_OVERSCAN_PX = 480;

export type GridCol = { name: string; kind: string; pk?: boolean; hint?: string };
export type Cell = string | null;

/** 편집 덧씌우기 — 바뀐 값·행 상태(편집됨/지울 것/새 행) */
export type GridOverlay = {
	cell: (r: number, c: number) => Cell | undefined;
	rowState: (r: number) => "edited" | "deleted" | "added" | undefined;
	cellEdited: (r: number, c: number) => boolean;
	/** 새 행(rowCount 뒤에 붙음) */
	added: Cell[][];
};

export type GridApi = {
	/** 덧씌우기까지 반영한 행(받아 둔 쪽에 있을 때만) */
	row: (r: number) => Cell[] | undefined;
	selectedRows: () => number[];
	selectedCell: () => { r: number; c: number } | null;
	refresh: () => void;
};

/** 고른 칸들의 요약(숫자 칸만 합계·평균·최소·최대) */
export type SelStats = { cells: number; count: number; nums: number; sum?: string; avg?: string; min?: string; max?: string; partial?: boolean };

/** 요약할 칸 상한(넘으면 앞쪽만) */
const STATS_MAX_CELLS = 500_000;

/** 소수 자릿수를 맞춰 BigInt 로 정확히 더한다 */
function summarize(vals: string[]): Pick<SelStats, "sum" | "avg" | "min" | "max"> {
	if (!vals.length) return {};
	let scale = 0;
	for (const v of vals) {
		const i = v.indexOf(".");
		if (i >= 0) scale = Math.max(scale, v.length - i - 1);
	}
	scale = Math.min(scale, 12);
	let sum = 0n;
	let min = vals[0];
	let max = vals[0];
	for (const v of vals) {
		const [i, f = ""] = v.split(".");
		const neg = i.startsWith("-");
		const digits = `${i.replace("-", "")}${f.slice(0, scale).padEnd(scale, "0")}`;
		const n = BigInt(digits || "0");
		sum += neg ? -n : n;
		if (Number(v) < Number(min)) min = v;
		if (Number(v) > Number(max)) max = v;
	}
	const fmt = (n: bigint) => {
		const neg = n < 0n;
		const a = (neg ? -n : n).toString().padStart(scale + 1, "0");
		const t = scale ? `${a.slice(0, -scale)}.${a.slice(-scale).replace(/0+$/, "")}`.replace(/\.$/, "") : a;
		return neg ? `-${t}` : t;
	};
	const sumStr = fmt(sum);
	const avg = Number(sumStr) / vals.length;
	const avgStr = Number.isInteger(avg) ? String(avg) : avg.toFixed(Math.min(6, Math.max(2, scale + 2))).replace(/0+$/, "").replace(/\.$/, "");
	return { sum: sumStr, avg: avgStr, min, max };
}

/** 1234567.89 → 1,234,567.89 (자릿수 그대로) */
export function groupDigits(v: string) {
	const [i, f] = v.split(".");
	const sign = i.startsWith("-") ? "-" : "";
	const g = i.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return f != null ? `${sign}${g}.${f}` : sign + g;
}

function widthOf(c: GridCol) {
	const head = c.name.length * 8 + 34;
	if (c.kind === "int") return Math.max(90, head);
	if (c.kind === "numeric") return Math.max(120, head);
	if (c.kind === "date") return Math.max(110, head);
	if (c.kind === "datetime") return Math.max(180, head);
	if (c.kind === "time") return Math.max(100, head);
	if (c.kind === "bool") return Math.max(70, head);
	if (c.kind === "uuid") return 300;
	return Math.min(320, Math.max(120, head));
}

/** 받은 첫 묶음의 글자 길이로 너비 맞추기(고정폭 글꼴 기준, 60~480px) */
function fitWidths(columns: GridCol[], rows: Cell[][]) {
	return columns.map((c, i) => {
		let n = 0;
		for (let r = 0; r < Math.min(rows.length, 200); r++) {
			const v = rows[r]?.[i];
			const len = v == null ? 4 : [...v].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
			if (len > n) n = len;
		}
		return Math.round(Math.min(480, Math.max(60, c.name.length * 8 + 34, n * 7.3 + 24)));
	});
}

/**
 * 큰 결과 표 — 행은 Rust 에 두고, 보이는 쪽(200행 묶음)만 받아 그린다.
 * NULL 흐림·숫자 오른쪽 정렬, 칸 고르기(방향키)·Ctrl+C, 행 번호 누르기로 행 고르기(Shift·Ctrl 여러 행).
 * 편집: 두 번 누르기·F2·Enter 로 renderEditor(형식별 입력기), Delete 로 NULL(허용 열), 덧씌우기로 바뀐 칸 표시.
 */
export function DataGrid({
	columns,
	rowCount,
	fetchRows,
	resetKey,
	overlay,
	editable,
	renderEditor,
	onCellNull,
	onDeleteRows,
	onPaste,
	thousands,
	onContextMenu,
	apiRef,
	sort,
	onSort,
	onCopyRows,
	onBigEdit,
	onStats,
}: {
	columns: GridCol[];
	rowCount: number;
	fetchRows: (from: number, to: number) => Promise<Cell[][]>;
	resetKey: string | number;
	overlay?: GridOverlay;
	/** 이 칸을 고칠 수 있는지 */
	editable?: (r: number, c: number) => boolean;
	renderEditor?: (r: number, c: number, value: Cell, done: (v: Cell | undefined, move?: "next" | "down") => void, seeded?: boolean) => ReactNode;
	onCellNull?: (r: number, c: number) => void;
	/** Delete — 고른 행 지우기 표시(없으면 Delete 가 NULL) */
	onDeleteRows?: (rows: number[]) => void;
	/** Ctrl+V — 엑셀·TSV 붙여넣기(고른 칸부터) */
	onPaste?: (r: number, c: number, grid: string[][]) => void;
	/** 숫자 천 단위 구분 */
	thousands?: boolean;
	onContextMenu?: (e: React.MouseEvent, r: number, c: number) => void;
	apiRef?: React.Ref<GridApi>;
	/** 지금 정렬(머리에 ▲▼) */
	sort?: { col: number; desc: boolean } | null;
	/** 머리 누르기 — 정렬 바꾸기 */
	onSort?: (col: number) => void;
	/** 행을 고른 채 Ctrl+C — 받지 않은 행까지 부르는 쪽이 모아 복사(없으면 받아 둔 행만 TSV 로) */
	onCopyRows?: (rows: number[]) => void;
	/** Shift+Enter — 큰 편집기(긴 글·JSON) */
	onBigEdit?: (r: number, c: number) => void;
	/** 여러 칸(끌기·Shift+누르기·Shift+방향키)이나 여러 행을 고르면 요약, 하나면 null */
	onStats?: (s: SelStats | null) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pages = useRef(new Map<number, Cell[][]>());
	const loading = useRef(new Set<number>());
	const [, force] = useState(0);
	const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
	/** 칸 범위의 다른 끝(sel 이 시작) */
	const [rangeEnd, setRangeEnd] = useState<{ r: number; c: number } | null>(null);
	const dragging = useRef(false);
	const [rows, setRows] = useState<Set<number>>(new Set());
	const anchor = useRef<number | null>(null);
	const [editing, setEditing] = useState<{ r: number; c: number; seed?: string } | null>(null);
	const added = overlay?.added ?? [];
	const count = rowCount + added.length;

	// 세대 — resetKey(정렬·다시 실행)가 바뀌면 받아 둔 쪽을 이 그리기에서 바로 버리고 번호를 올린다.
	// 옛 요청의 늦은 응답은 번호가 달라 새 캐시에 들어가지 못한다(그리는 도중이라 effect 보다 먼저 ensure 가 불려도 옛 쪽을 안 쓴다)
	const gen = useRef({ key: resetKey, n: 0 });
	if (gen.current.key !== resetKey) {
		gen.current = { key: resetKey, n: gen.current.n + 1 };
		pages.current.clear();
		loading.current.clear();
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 가 바뀌면 고른 것을 푼다
	useEffect(() => {
		setSel(null);
		setRangeEnd(null);
		setRows(new Set());
		setEditing(null);
		force((n) => n + 1);
	}, [resetKey]);
	useEffect(() => {
		const up = () => {
			dragging.current = false;
		};
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);

	// 열 너비: 처음엔 형식으로 짐작, 첫 묶음이 오면 내용에 맞추고, 머리 경계를 끌면 그 값으로
	const [widths, setWidths] = useState<number[]>(() => columns.map(widthOf));
	const fitted = useRef(false);
	const userSized = useRef(false);
	// 열 배열은 부르는 쪽이 그릴 때마다 새로 만든다(받는 중엔 자주) — 이름·형식이 바뀔 때만 다시 짐작
	const colKey = columns.map((c) => `${c.name}${c.kind}`).join("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: 열이 바뀔 때만 다시 짐작
	useEffect(() => {
		setWidths(columns.map(widthOf));
		fitted.current = false;
		userSized.current = false;
	}, [colKey]);
	const tpl = useMemo(() => ["64px", ...widths.map((w) => `${w}px`)].join(" "), [widths]);
	const total = 64 + widths.reduce((a, b) => a + b, 0);

	// 열 가상화 — 열이 많을 때만. 칸마다 gridColumn 을 줘서 안 그린 열이 있어도 자리가 어긋나지 않는다
	const virtCols = columns.length >= COL_VIRT_MIN;
	const [colRange, setColRange] = useState<[number, number]>([0, 24]);
	const colOffs = useMemo(() => {
		const o: number[] = [];
		let x = 64;
		for (const w of widths) {
			o.push(x);
			x += w;
		}
		return o;
	}, [widths]);
	const computeRange = useCallback(() => {
		const el = scroller.current;
		if (!el || !virtCols) return;
		const l = el.scrollLeft - COL_OVERSCAN_PX;
		const r = el.scrollLeft + el.clientWidth + COL_OVERSCAN_PX;
		let first = 0;
		while (first < widths.length - 1 && colOffs[first] + widths[first] <= l) first++;
		let last = first;
		while (last < widths.length - 1 && colOffs[last + 1] < r) last++;
		setColRange((prev) => (prev[0] === first && prev[1] === last ? prev : [first, last]));
	}, [virtCols, widths, colOffs]);
	useEffect(() => {
		if (!virtCols) return;
		computeRange();
		const el = scroller.current;
		if (!el) return;
		const ro = new ResizeObserver(computeRange);
		ro.observe(el);
		return () => ro.disconnect();
	}, [virtCols, computeRange]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 열 개수가 바뀔 때만
	const allCols = useMemo(() => columns.map((_, i) => i), [columns.length]);
	const visCols = useMemo(() => {
		if (!virtCols) return allCols;
		const out: number[] = [];
		for (let i = colRange[0]; i <= Math.min(colRange[1], allCols.length - 1); i++) out.push(i);
		return out;
	}, [virtCols, allCols, colRange]);
	const cstyle = (ci: number) => (virtCols ? { gridColumn: ci + 2 } : undefined);
	/** 방향키·Tab 으로 고른 열이 화면 밖이면 가로로 따라가기 */
	const scrollColIntoView = (c: number) => {
		const el = scroller.current;
		if (!el || colOffs[c] === undefined) return;
		const left = colOffs[c];
		const right = left + widths[c];
		if (left < el.scrollLeft + 64) el.scrollLeft = Math.max(0, left - 64);
		else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
	};

	const v = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 24 });

	const ensure = useCallback(
		(page: number) => {
			if (page * PAGE >= rowCount || loading.current.has(page)) return;
			// 받는 중(rowCount 가 늘어남) — 덜 찬 채로 받아 둔 묶음은 다시 받는다
			const have = pages.current.get(page);
			if (have && (have.length >= PAGE || page * PAGE + have.length >= rowCount)) return;
			loading.current.add(page);
			const g = gen.current.n;
			void fetchRows(page * PAGE, page * PAGE + PAGE).then((r) => {
				// 그 사이 resetKey 가 바뀌었으면(정렬·다시 실행) 옛 결과의 행이라 버린다 — 캐시·loading 은 이미 새 세대 것
				if (g !== gen.current.n) return;
				pages.current.set(page, r);
				loading.current.delete(page);
				if (page === 0 && !fitted.current && !userSized.current) {
					fitted.current = true;
					setWidths(fitWidths(columns, r));
				}
				if (pages.current.size > 60) {
					const first = pages.current.keys().next().value;
					if (first !== undefined) pages.current.delete(first);
				}
				force((n) => n + 1);
			}, () => {
				// 받기 실패 — 같은 세대면 다음 그리기에서 다시 시도할 수 있게 풀어 둔다
				if (g === gen.current.n) loading.current.delete(page);
			});
		},
		[fetchRows, rowCount, columns],
	);

	const baseRow = (r: number): Cell[] | undefined => (r >= rowCount ? added[r - rowCount] : pages.current.get(Math.floor(r / PAGE))?.[r % PAGE]);
	const cellAt = (r: number, c: number): Cell | undefined => {
		const o = overlay?.cell(r, c);
		if (o !== undefined) return o;
		return baseRow(r)?.[c];
	};

	/** 고른 칸 범위(두 칸 이상일 때) */
	const range =
		sel && rangeEnd && (rangeEnd.r !== sel.r || rangeEnd.c !== sel.c)
			? { r0: Math.min(sel.r, rangeEnd.r), r1: Math.max(sel.r, rangeEnd.r), c0: Math.min(sel.c, rangeEnd.c), c1: Math.max(sel.c, rangeEnd.c) }
			: null;
	const inRange = (r: number, c: number) => !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

	/** 행들의 값(받지 않은 묶음은 받아서, 덧씌우기 반영) */
	const valuesOf = async (rs: number[], cs: number[]) => {
		const need = new Set<number>();
		for (const r of rs) if (r < rowCount && !pages.current.has(Math.floor(r / PAGE))) need.add(Math.floor(r / PAGE));
		const extra = new Map<number, Cell[][]>();
		for (const pg of need) extra.set(pg, await fetchRows(pg * PAGE, pg * PAGE + PAGE));
		return rs.map((r) =>
			cs.map((c) => {
				const o = overlay?.cell(r, c);
				if (o !== undefined) return o;
				const pg = Math.floor(r / PAGE);
				const row = r >= rowCount ? added[r - rowCount] : (pages.current.get(pg) ?? extra.get(pg))?.[r % PAGE];
				return row?.[c] ?? null;
			}),
		);
	};

	// 여러 칸 요약 — 고른 것이 바뀌면 다시(늦게 온 옛 계산은 버린다)
	const statsSeq = useRef(0);
	const rangeKey = range ? `${range.r0}:${range.r1}:${range.c0}:${range.c1}` : "";
	const rowsKey = rows.size > 1 ? [...rows].join(",") : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: 고른 범위·행이 바뀔 때만
	useEffect(() => {
		const seq = ++statsSeq.current;
		if (!onStats) return;
		let rs: number[] = [];
		const cs: number[] = [];
		if (range) {
			for (let r = range.r0; r <= range.r1; r++) rs.push(r);
			for (let c = range.c0; c <= range.c1; c++) cs.push(c);
		} else if (rows.size > 1) {
			rs = [...rows].sort((a, b) => a - b);
			for (let c = 0; c < columns.length; c++) cs.push(c);
		} else {
			onStats(null);
			return;
		}
		const partial = rs.length * cs.length > STATS_MAX_CELLS;
		if (partial) rs = rs.slice(0, Math.max(1, Math.floor(STATS_MAX_CELLS / cs.length)));
		const t = window.setTimeout(() => {
			void valuesOf(rs, cs).then((vals) => {
				if (seq !== statsSeq.current) return;
				let count = 0;
				const nums: string[] = [];
				for (const row of vals)
					for (let j = 0; j < cs.length; j++) {
						const v = row[j];
						if (v == null || v === "") continue;
						count++;
						const k = columns[cs[j]]?.kind;
						if ((k === "int" || k === "numeric") && /^-?\d+(\.\d+)?$/.test(v)) nums.push(v);
					}
				onStats({ cells: rs.length * cs.length, count, nums: nums.length, ...summarize(nums), partial });
			});
		}, 60);
		return () => window.clearTimeout(t);
	}, [rangeKey, rowsKey, resetKey]);

	useImperativeHandle(
		apiRef,
		() => ({
			row: (r) => {
				const b = baseRow(r);
				return b ? b.map((_, c) => cellAt(r, c) ?? null) : undefined;
			},
			selectedRows: () => (rows.size ? [...rows].sort((a, b) => a - b) : sel ? [sel.r] : []),
			selectedCell: () => sel,
			refresh: () => force((n) => n + 1),
		}),
		// biome-ignore lint/correctness/useExhaustiveDependencies: 고른 상태만 따라가면 된다
		[rows, sel, overlay],
	);

	const items = v.getVirtualItems();
	if (items.length) {
		ensure(Math.floor(items[0].index / PAGE));
		ensure(Math.floor(Math.min(items[items.length - 1].index, rowCount - 1) / PAGE));
	}

	const startEdit = (r: number, c: number, seed?: string) => {
		if (editable?.(r, c) && renderEditor) setEditing({ r, c, seed });
	};

	return (
		<div
			className="grid-scroll selectable"
			ref={scroller}
			tabIndex={0}
			onScroll={virtCols ? computeRange : undefined}
			onPaste={(e) => {
				if (!onPaste || !sel || editing) return;
				const t = e.clipboardData.getData("text/plain");
				if (!t) return;
				e.preventDefault();
				const grid = t.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
				onPaste(sel.r, sel.c, grid);
			}}
			onKeyDown={(e) => {
				if (editing || !sel) return;
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
					e.preventDefault();
					if (range && !rows.size) {
						// 칸 범위 — 값만 TSV(엑셀에 그대로)
						const rs: number[] = [];
						for (let r = range.r0; r <= range.r1; r++) rs.push(r);
						const cs: number[] = [];
						for (let c = range.c0; c <= range.c1; c++) cs.push(c);
						void valuesOf(rs, cs).then((vals) => navigator.clipboard.writeText(vals.map((row) => row.map((x) => (x == null ? "" : x.replace(/[\t\n]/g, " "))).join("\t")).join("\n")));
						return;
					}
					if (!rows.size) {
						void navigator.clipboard.writeText(cellAt(sel.r, sel.c) ?? "");
						return;
					}
					// 고른 행 — 머리 + 행(TSV, 엑셀에 바로 붙여 넣기)
					const picked = [...rows].sort((a, b) => a - b);
					if (onCopyRows) onCopyRows(picked);
					else {
						const esc = (v: Cell | undefined) => (v == null ? "" : v.replace(/[\t\n]/g, " "));
						const text = [columns.map((c) => c.name).join("\t"), ...picked.map((r) => columns.map((_, c) => esc(cellAt(r, c))).join("\t"))].join("\n");
						void navigator.clipboard.writeText(text);
					}
					return;
				}
				if (e.key === "Enter" && e.shiftKey && onBigEdit) {
					e.preventDefault();
					onBigEdit(sel.r, sel.c);
					return;
				}
				if (e.key === "F2" || e.key === "Enter") {
					e.preventDefault();
					startEdit(sel.r, sel.c);
					return;
				}
				// Ctrl+Delete·Ctrl+Shift+N = NULL, Delete = 행 지우기 표시(지원할 때)
				const nullKey = (e.key === "Delete" && (e.ctrlKey || e.metaKey || !onDeleteRows)) || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyN");
				if (nullKey && onCellNull && editable?.(sel.r, sel.c)) {
					e.preventDefault();
					onCellNull(sel.r, sel.c);
					return;
				}
				if (e.key === "Delete" && onDeleteRows && editable?.(sel.r, sel.c)) {
					e.preventDefault();
					onDeleteRows(rows.size ? [...rows] : [sel.r]);
					return;
				}
				// 글자를 치면 바로 고치기 시작(그 글자부터)
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && editable?.(sel.r, sel.c) && renderEditor) {
					e.preventDefault();
					startEdit(sel.r, sel.c, e.key);
					return;
				}
				const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, 1] };
				const d = mv[e.key];
				if (d && e.shiftKey && e.key !== "Tab") {
					// Shift+방향키 — 칸 범위 늘이기
					e.preventDefault();
					const end = rangeEnd ?? sel;
					const r = Math.min(count - 1, Math.max(0, end.r + d[0]));
					const c = Math.min(columns.length - 1, Math.max(0, end.c + d[1]));
					setRangeEnd({ r, c });
					setRows(new Set());
					v.scrollToIndex(r);
					scrollColIntoView(c);
					return;
				}
				if (d) {
					e.preventDefault();
					const r = Math.min(count - 1, Math.max(0, sel.r + d[0]));
					const c = Math.min(columns.length - 1, Math.max(0, sel.c + (e.shiftKey && e.key === "Tab" ? -1 : d[1])));
					setSel({ r, c });
					setRangeEnd(null);
					setRows(new Set());
					v.scrollToIndex(r);
					scrollColIntoView(c);
				}
			}}
		>
			<div style={{ width: total, minWidth: "100%" }}>
				<div className="grid-head" style={{ gridTemplateColumns: tpl, width: total }}>
					<div style={{ textAlign: "right", color: "var(--text-3)" }}>#</div>
					{visCols.map((i) => {
						const c = columns[i];
						return (
						// biome-ignore lint/suspicious/noArrayIndexKey: 같은 이름 열이 있을 수 있다
						<div
							key={`${c.name}-${i}`}
							style={cstyle(i)}
							title={`${c.kind}${onSort ? " — 눌러 정렬(오름 → 내림 → 원래대로)" : ""}`}
							className={`gh${onSort ? " sortable" : ""}`}
							onClick={(ev) => {
								if ((ev.target as HTMLElement).classList.contains("col-resize")) return;
								onSort?.(i);
							}}
						>
							{c.pk && <span className="pk-mark" title="기본 키">🔑</span>}
							{c.name}
							{c.hint && <small>{c.hint}</small>}
							{sort?.col === i && <span className="sort-mark">{sort.desc ? "▼" : "▲"}</span>}
							<span
								className="col-resize"
								onMouseDown={(e) => {
									e.preventDefault();
									e.stopPropagation();
									const x0 = e.clientX;
									const w0 = widths[i];
									const move = (ev: MouseEvent) => {
										userSized.current = true;
										setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(48, w0 + ev.clientX - x0) : w)));
									};
									const up = () => {
										window.removeEventListener("mousemove", move);
										window.removeEventListener("mouseup", up);
									};
									window.addEventListener("mousemove", move);
									window.addEventListener("mouseup", up);
								}}
								onDoubleClick={() => {
									const p = pages.current.get(0);
									if (p) setWidths((ws) => ws.map((w, j) => (j === i ? fitWidths([columns[i]], p.map((row) => [row[i]]))[0] : w)));
								}}
							/>
						</div>
						);
					})}
				</div>
				<div style={{ height: v.getTotalSize(), position: "relative" }}>
					{items.map((it) => {
						const r = it.index;
						const row = baseRow(r);
						const st = overlay?.rowState(r);
						return (
							<div
								key={it.key}
								className={`grid-row${rows.has(r) ? " picked" : ""}${st ? ` ${st}` : ""}`}
								style={{ transform: `translateY(${it.start}px)`, gridTemplateColumns: tpl, width: total }}
							>
								<div
									className="rn"
									onMouseDown={(e) => {
										const n = new Set(e.ctrlKey || e.metaKey ? rows : []);
										if (e.shiftKey && anchor.current != null) {
											for (let i = Math.min(anchor.current, r); i <= Math.max(anchor.current, r); i++) n.add(i);
										} else if (n.has(r) && (e.ctrlKey || e.metaKey)) n.delete(r);
										else n.add(r);
										if (!e.shiftKey) anchor.current = r;
										setRows(n);
										setSel({ r, c: 0 });
										setRangeEnd(null);
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										if (!rows.has(r)) {
											setRows(new Set([r]));
											anchor.current = r;
										}
										onContextMenu?.(e, r, -1);
									}}
								>
									{st === "added" ? "+" : r + 1}
								</div>
								{(virtCols && editing && editing.r === r && !visCols.includes(editing.c) ? [...visCols, editing.c] : visCols).map((ci) => {
									const c = columns[ci];
									const val = cellAt(r, ci);
									const isSel = sel?.r === r && sel?.c === ci;
									const edited = overlay?.cellEdited(r, ci);
									if (editing && editing.r === r && editing.c === ci && renderEditor) {
										return (
											// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서가 곧 정체
											<div key={ci} className="cell-editing" style={cstyle(ci)}>
												{renderEditor(r, ci, editing.seed ?? val ?? null, (nv, move) => {
													setEditing(null);
													scroller.current?.focus();
													if (move === "next") setSel({ r, c: Math.min(columns.length - 1, ci + 1) });
													if (move === "down") setSel({ r: Math.min(count - 1, r + 1), c: ci });
													void nv;
												}, editing.seed != null)}
											</div>
										);
									}
									return (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서가 곧 정체
											key={ci}
											style={cstyle(ci)}
											className={`${val === null ? "null" : c.kind === "int" || c.kind === "numeric" ? "num" : ""}${isSel ? " sel" : ""}${inRange(r, ci) ? " in-range" : ""}${edited ? " edited" : ""}`}
											onMouseDown={(e) => {
												if (e.button !== 0) return;
												setRows(new Set());
												if (e.shiftKey && sel) {
													e.preventDefault();
													scroller.current?.focus({ preventScroll: true });
													setRangeEnd({ r, c: ci });
													return;
												}
												setSel({ r, c: ci });
												setRangeEnd(null);
												dragging.current = true;
											}}
											onMouseEnter={() => {
												if (!dragging.current || !sel) return;
												window.getSelection()?.removeAllRanges();
												setRangeEnd({ r, c: ci });
											}}
											onDoubleClick={() => startEdit(r, ci)}
											onContextMenu={(e) => {
												e.preventDefault();
												if (!inRange(r, ci)) {
													setSel({ r, c: ci });
													setRangeEnd(null);
												}
												onContextMenu?.(e, r, ci);
											}}
											title={val && val.length > 40 ? val.slice(0, 2000) : undefined}
										>
											{row || st === "added" ? (
												val === null ? (
													"NULL"
												) : val === "" ? (
													<span className="empty-str">''</span>
												) : thousands && (c.kind === "int" || c.kind === "numeric") && /^-?\d+(\.\d+)?$/.test(val ?? "") ? (
													groupDigits(val ?? "")
												) : (
													val
												)
											) : (
												""
											)}
										</div>
									);
								})}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
