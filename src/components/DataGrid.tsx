import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PAGE = 200;
const ROW_H = 26;

export type GridCol = { name: string; kind: string };

function widthOf(c: GridCol) {
	if (c.kind === "int") return 100;
	if (c.kind === "numeric") return 130;
	if (c.kind === "date") return 190;
	if (c.kind === "bool") return 70;
	return Math.min(320, Math.max(140, c.name.length * 9 + 40));
}

/**
 * 큰 결과 표 — 행은 Rust 에 두고, 보이는 쪽(200행 묶음)만 받아 그린다.
 * NULL 은 흐린 글씨, 숫자 열은 오른쪽 정렬. 칸을 누르면 고르고 Ctrl+C 로 값 복사.
 */
export function DataGrid({
	columns,
	rowCount,
	fetchRows,
	resetKey,
}: {
	columns: GridCol[];
	rowCount: number;
	fetchRows: (from: number, to: number) => Promise<(string | null)[][]>;
	resetKey: string | number;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pages = useRef(new Map<number, (string | null)[][]>());
	const loading = useRef(new Set<number>());
	const [, force] = useState(0);
	const [sel, setSel] = useState<{ r: number; c: number } | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 가 바뀌면 받은 쪽을 버린다
	useEffect(() => {
		pages.current.clear();
		loading.current.clear();
		setSel(null);
		force((n) => n + 1);
	}, [resetKey]);

	const widths = useMemo(() => columns.map(widthOf), [columns]);
	const tpl = useMemo(() => ["64px", ...widths.map((w) => `${w}px`)].join(" "), [widths]);
	const total = 64 + widths.reduce((a, b) => a + b, 0);

	const v = useVirtualizer({ count: rowCount, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 24 });

	const ensure = useCallback(
		(page: number) => {
			if (pages.current.has(page) || loading.current.has(page)) return;
			loading.current.add(page);
			void fetchRows(page * PAGE, page * PAGE + PAGE).then((rows) => {
				pages.current.set(page, rows);
				loading.current.delete(page);
				if (pages.current.size > 60) {
					const first = pages.current.keys().next().value;
					if (first !== undefined) pages.current.delete(first);
				}
				force((n) => n + 1);
			});
		},
		[fetchRows],
	);

	const items = v.getVirtualItems();
	if (items.length) {
		ensure(Math.floor(items[0].index / PAGE));
		ensure(Math.floor(items[items.length - 1].index / PAGE));
	}

	const cellAt = (r: number, c: number) => pages.current.get(Math.floor(r / PAGE))?.[r % PAGE]?.[c];

	return (
		<div
			className="grid-scroll selectable"
			ref={scroller}
			tabIndex={0}
			onKeyDown={(e) => {
				if (!sel) return;
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
					e.preventDefault();
					const val = cellAt(sel.r, sel.c);
					void navigator.clipboard.writeText(val ?? "");
					return;
				}
				const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
				const d = mv[e.key];
				if (d) {
					e.preventDefault();
					const r = Math.min(rowCount - 1, Math.max(0, sel.r + d[0]));
					const c = Math.min(columns.length - 1, Math.max(0, sel.c + d[1]));
					setSel({ r, c });
					v.scrollToIndex(r);
				}
			}}
		>
			<div style={{ width: total, minWidth: "100%" }}>
				<div className="grid-head" style={{ gridTemplateColumns: tpl, width: total }}>
					<div style={{ textAlign: "right", color: "var(--text-3)" }}>#</div>
					{columns.map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 같은 이름 열이 있을 수 있다
						<div key={`${c.name}-${i}`} title={c.kind}>
							{c.name}
						</div>
					))}
				</div>
				<div style={{ height: v.getTotalSize(), position: "relative" }}>
					{items.map((it) => {
						const row = pages.current.get(Math.floor(it.index / PAGE))?.[it.index % PAGE];
						return (
							<div key={it.key} className="grid-row" style={{ transform: `translateY(${it.start}px)`, gridTemplateColumns: tpl, width: total }}>
								<div className="rn">{it.index + 1}</div>
								{columns.map((c, ci) => {
									const val = row?.[ci];
									const isSel = sel?.r === it.index && sel?.c === ci;
									return (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서가 곧 정체
											key={ci}
											className={`${val === null ? "null" : c.kind === "int" || c.kind === "numeric" ? "num" : ""}${isSel ? " sel" : ""}`}
											onMouseDown={() => setSel({ r: it.index, c: ci })}
											title={val && val.length > 40 ? val.slice(0, 2000) : undefined}
										>
											{row ? (val === null ? "NULL" : val) : ""}
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
