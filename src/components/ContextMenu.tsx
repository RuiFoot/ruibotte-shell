import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem = { sep: true } | { label: string; run: () => void; danger?: boolean; disabled?: boolean };

/** "복사  Ctrl+C" — 이름 뒤 두 칸 이상 띄운 부분은 단축키로 오른쪽에 흐리게 */
function splitLabel(label: string): [string, string | null] {
	const m = /^(.*?\S)\s{2,}(\S.*)$/.exec(label);
	return m ? [m[1], m[2]] : [label, null];
}

/**
 * 앱 자체 우클릭 메뉴 — 화면 밖으로 나가지 않게 자리를 맞추고(넘치면 안에서 스크롤), 바깥 누르기·Esc 로 닫힌다.
 * 키보드: 열리면 첫 항목에 초점, ↑↓·Home·End 로 옮기고 Enter·Space 로 실행(macOS 메뉴와 같게)
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x, y });

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		setPos({ x: Math.max(6, Math.min(x, innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, innerHeight - r.height - 6)) });
		// 메뉴 자체에 초점(마우스로 연 때 첫 줄이 고른 것처럼 보이지 않게) — ↓ 를 누르면 첫 항목부터
		el.focus({ preventScroll: true });
	}, [x, y]);

	// 닫히면 열기 전 초점으로 돌려준다(터미널·편집기에서 메뉴를 쓴 뒤 바로 이어 칠 수 있게)
	// 첫 렌더 때 잡는다 — 아래 레이아웃 효과가 곧 첫 항목으로 초점을 옮긴다
	const beforeRef = useRef(document.activeElement as HTMLElement | null);
	useEffect(() => {
		const before = beforeRef.current;
		return () => {
			const now = document.activeElement;
			if (before?.isConnected && (!now || now === document.body || ref.current?.contains(now))) before.focus({ preventScroll: true });
		};
	}, []);

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

	const move = (e: React.KeyboardEvent) => {
		const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
		if (!list.length) return;
		const i = list.indexOf(document.activeElement as HTMLButtonElement); // 메뉴 자체면 -1 → ↓ 는 첫 항목, ↑ 는 끝
		let next = -1;
		if (e.key === "ArrowDown") next = (i + 1) % list.length;
		else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = list.length - 1;
		if (next < 0) return;
		e.preventDefault();
		list[next]?.focus();
	};

	return createPortal(
		<div className="cmenu" ref={ref} tabIndex={-1} style={{ left: pos.x, top: pos.y }} role="menu" onKeyDown={move}>
			{items.map((it, i) => {
				if ("sep" in it)
					// biome-ignore lint/suspicious/noArrayIndexKey: 구분선은 순서가 곧 정체
					return <div key={`s${i}`} className="cmenu-sep" role="separator" />;
				const [name, keys] = splitLabel(it.label);
				return (
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
						<span className="cmenu-name">{name}</span>
						{keys && <kbd className="cmenu-keys">{keys}</kbd>}
					</button>
				);
			})}
		</div>,
		document.body,
	);
}
