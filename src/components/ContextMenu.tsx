import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem = { sep: true } | { label: string; run: () => void; danger?: boolean; disabled?: boolean };

/** 앱 자체 우클릭 메뉴 — 화면 밖으로 나가지 않게 자리를 맞추고, 바깥 누르기·Esc 로 닫힌다 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x, y });

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		setPos({ x: Math.min(x, innerWidth - r.width - 6), y: Math.min(y, innerHeight - r.height - 6) });
	}, [x, y]);

	useEffect(() => {
		const close = (e: Event) => {
			if (e instanceof KeyboardEvent && e.key !== "Escape") return;
			if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		window.addEventListener("mousedown", close, true);
		window.addEventListener("keydown", close, true);
		window.addEventListener("blur", onClose);
		return () => {
			window.removeEventListener("mousedown", close, true);
			window.removeEventListener("keydown", close, true);
			window.removeEventListener("blur", onClose);
		};
	}, [onClose]);

	return createPortal(
		<div className="cmenu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
			{items.map((it, i) =>
				"sep" in it ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 구분선은 순서가 곧 정체
					<div key={`s${i}`} className="cmenu-sep" />
				) : (
					<button
						key={it.label}
						type="button"
						role="menuitem"
						className={it.danger ? "danger" : undefined}
						disabled={it.disabled}
						onClick={() => {
							onClose();
							it.run();
						}}
					>
						{it.label}
					</button>
				),
			)}
		</div>,
		document.body,
	);
}
