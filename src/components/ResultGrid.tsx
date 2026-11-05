import { useVirtualizer } from "@tanstack/react-virtual";
import { Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type GridInfo } from "../lib/ipc";

const PAGE = 200;
const ROW_H = 26;
const WIDTHS: Record<string, number> = { int: 90, numeric: 120, timestamp: 170, text: 180 };

/** 결과 표 시제품(스파이크 5) — 행은 Rust 에 두고, 보이는 쪽(200행)만 받아 그린다 */
export function ResultGridPane() {
	const [info, setInfo] = useState<GridInfo | null>(null);
	const [status, setStatus] = useState("행 만드는 중…");
	const [, force] = useState(0);
	const pages = useRef(new Map<number, string[][]>());
	const loading = useRef(new Set<number>());
	const scroller = useRef<HTMLDivElement>(null);
	const firstPaint = useRef<number | null>(null);

	useEffect(() => {
		let gone = false;
		const t0 = performance.now();
		api.gridDemoOpen(100_000).then((g) => {
			if (gone) return;
			firstPaint.current = t0;
			setInfo(g);
			setStatus(`${g.count.toLocaleString()}행 · Rust 생성 ${Math.round(g.buildMs)} ms`);
		});
		return () => {
			gone = true;
			pages.current.clear();
			void api.gridClose();
		};
	}, []);

	const cols = useMemo(() => {
		if (!info) return "";
		return ["64px", ...info.columns.map((c) => `${WIDTHS[c.kind] ?? 160}px`)].join(" ");
	}, [info]);
	const totalW = useMemo(
		() => (info ? 64 + info.columns.reduce((s, c) => s + (WIDTHS[c.kind] ?? 160), 0) : 0),
		[info],
	);

	const v = useVirtualizer({
		count: info?.count ?? 0,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_H,
		overscan: 20,
	});

	const ensure = useCallback((page: number) => {
		if (pages.current.has(page) || loading.current.has(page)) return;
		loading.current.add(page);
		const t0 = performance.now();
		api.gridRows(page * PAGE, page * PAGE + PAGE).then((rows) => {
			pages.current.set(page, rows);
			loading.current.delete(page);
			if (page === 0 && firstPaint.current != null) {
				const ms = performance.now() - firstPaint.current;
				setStatus((s) => `${s} · 첫 화면 ${Math.round(ms)} ms (조각 ${Math.round(performance.now() - t0)} ms)`);
				firstPaint.current = null;
			}
			// 오래된 쪽은 버린다(메모리는 Rust 쪽 한 벌만)
			if (pages.current.size > 40) {
				const first = pages.current.keys().next().value;
				if (first !== undefined) pages.current.delete(first);
			}
			force((n) => n + 1);
		});
	}, []);

	const items = v.getVirtualItems();
	if (items.length) {
		ensure(Math.floor(items[0].index / PAGE));
		ensure(Math.floor(items[items.length - 1].index / PAGE));
	}

	return (
		<>
			<div className="toolbar">
				<span className="title">결과 표 시제품</span>
				<Table2 size={15} style={{ color: "var(--text-3)" }} />
			</div>
			<div className="grid-scroll selectable" ref={scroller}>
				{info && (
					<div style={{ width: totalW, minWidth: "100%" }}>
						<div className="grid-head" style={{ gridTemplateColumns: cols, width: totalW }}>
							<div style={{ textAlign: "right", color: "var(--text-3)" }}>#</div>
							{info.columns.map((c) => (
								<div key={c.name}>
									{c.name}
									<small>{c.kind}</small>
								</div>
							))}
						</div>
						<div style={{ height: v.getTotalSize(), position: "relative" }}>
							{items.map((it) => {
								const row = pages.current.get(Math.floor(it.index / PAGE))?.[it.index % PAGE];
								return (
									<div
										key={it.key}
										className="grid-row"
										style={{ transform: `translateY(${it.start}px)`, gridTemplateColumns: cols, width: totalW }}
									>
										<div className="rn">{it.index + 1}</div>
										{info.columns.map((c, ci) => {
											const val = row?.[ci];
											const isNull = val === "NULL";
											return (
												<div
													key={c.name}
													className={isNull ? "null" : c.kind === "int" || c.kind === "numeric" ? "num" : undefined}
												>
													{row ? val : ""}
												</div>
											);
										})}
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>
			<div className="statusbar">
				<span>{status}</span>
			</div>
		</>
	);
}
