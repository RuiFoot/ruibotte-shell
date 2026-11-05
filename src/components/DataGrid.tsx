import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

const PAGE = 200;
const ROW_H = 26;

export type GridCol = { name: string; kind: string };
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
	onContextMenu,
	apiRef,
	sort,
	onSort,
}: {
	columns: GridCol[];
	rowCount: number;
	fetchRows: (from: number, to: number) => Promise<Cell[][]>;
	resetKey: string | number;
	overlay?: GridOverlay;
	/** 이 칸을 고칠 수 있는지 */
	editable?: (r: number, c: number) => boolean;
	renderEditor?: (r: number, c: number, value: Cell, done: (v: Cell | undefined, move?: "next" | "down") => void) => ReactNode;
	onCellNull?: (r: number, c: number) => void;
	onContextMenu?: (e: React.MouseEvent, r: number, c: number) => void;
	apiRef?: React.Ref<GridApi>;
	/** 지금 정렬(머리에 ▲▼) */
	sort?: { col: number; desc: boolean } | null;
	/** 머리 누르기 — 정렬 바꾸기 */
	onSort?: (col: number) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pages = useRef(new Map<number, Cell[][]>());
	const loading = useRef(new Set<number>());
	const [, force] = useState(0);
	const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
	const [rows, setRows] = useState<Set<number>>(new Set());
	const anchor = useRef<number | null>(null);
	const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
	const added = overlay?.added ?? [];
	const count = rowCount + added.length;

	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 가 바뀌면 받은 쪽을 버린다
	useEffect(() => {
		pages.current.clear();
		loading.current.clear();
		setSel(null);
		setRows(new Set());
		setEditing(null);
		force((n) => n + 1);
	}, [resetKey]);

	// 열 너비: 처음엔 형식으로 짐작, 첫 묶음이 오면 내용에 맞추고, 머리 경계를 끌면 그 값으로
	const [widths, setWidths] = useState<number[]>(() => columns.map(widthOf));
	const fitted = useRef(false);
	const userSized = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 열이 바뀔 때만 다시 짐작
	useEffect(() => {
		setWidths(columns.map(widthOf));
		fitted.current = false;
		userSized.current = false;
	}, [columns]);
	const tpl = useMemo(() => ["64px", ...widths.map((w) => `${w}px`)].join(" "), [widths]);
	const total = 64 + widths.reduce((a, b) => a + b, 0);

	const v = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 24 });

	const ensure = useCallback(
		(page: number) => {
			if (page * PAGE >= rowCount || pages.current.has(page) || loading.current.has(page)) return;
			loading.current.add(page);
			void fetchRows(page * PAGE, page * PAGE + PAGE).then((r) => {
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

	const startEdit = (r: number, c: number) => {
		if (editable?.(r, c) && renderEditor) setEditing({ r, c });
	};

	return (
		<div
			className="grid-scroll selectable"
			ref={scroller}
			tabIndex={0}
			onKeyDown={(e) => {
				if (editing || !sel) return;
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !rows.size) {
					e.preventDefault();
					void navigator.clipboard.writeText(cellAt(sel.r, sel.c) ?? "");
					return;
				}
				if (e.key === "F2" || e.key === "Enter") {
					e.preventDefault();
					startEdit(sel.r, sel.c);
					return;
				}
				if (e.key === "Delete" && onCellNull && editable?.(sel.r, sel.c)) {
					e.preventDefault();
					onCellNull(sel.r, sel.c);
					return;
				}
				const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, 1] };
				const d = mv[e.key];
				if (d) {
					e.preventDefault();
					const r = Math.min(count - 1, Math.max(0, sel.r + d[0]));
					const c = Math.min(columns.length - 1, Math.max(0, sel.c + (e.shiftKey && e.key === "Tab" ? -1 : d[1])));
					setSel({ r, c });
					setRows(new Set());
					v.scrollToIndex(r);
				}
			}}
		>
			<div style={{ width: total, minWidth: "100%" }}>
				<div className="grid-head" style={{ gridTemplateColumns: tpl, width: total }}>
					<div style={{ textAlign: "right", color: "var(--text-3)" }}>#</div>
					{columns.map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 같은 이름 열이 있을 수 있다
						<div
							key={`${c.name}-${i}`}
							title={`${c.kind}${onSort ? " — 눌러 정렬(오름 → 내림 → 원래대로)" : ""}`}
							className={`gh${onSort ? " sortable" : ""}`}
							onClick={(ev) => {
								if ((ev.target as HTMLElement).classList.contains("col-resize")) return;
								onSort?.(i);
							}}
						>
							{c.name}
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
					))}
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
								{columns.map((c, ci) => {
									const val = cellAt(r, ci);
									const isSel = sel?.r === r && sel?.c === ci;
									const edited = overlay?.cellEdited(r, ci);
									if (editing && editing.r === r && editing.c === ci && renderEditor) {
										return (
											// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서가 곧 정체
											<div key={ci} className="cell-editing">
												{renderEditor(r, ci, val ?? null, (nv, move) => {
													setEditing(null);
													scroller.current?.focus();
													if (move === "next") setSel({ r, c: Math.min(columns.length - 1, ci + 1) });
													if (move === "down") setSel({ r: Math.min(count - 1, r + 1), c: ci });
													void nv;
												})}
											</div>
										);
									}
									return (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서가 곧 정체
											key={ci}
											className={`${val === null ? "null" : c.kind === "int" || c.kind === "numeric" ? "num" : ""}${isSel ? " sel" : ""}${edited ? " edited" : ""}`}
											onMouseDown={() => {
												setSel({ r, c: ci });
												setRows(new Set());
											}}
											onDoubleClick={() => startEdit(r, ci)}
											onContextMenu={(e) => {
												e.preventDefault();
												setSel({ r, c: ci });
												onContextMenu?.(e, r, ci);
											}}
											title={val && val.length > 40 ? val.slice(0, 2000) : undefined}
										>
											{row || st === "added" ? (val === null ? "NULL" : (val ?? "")) : ""}
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
