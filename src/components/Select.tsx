import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption<T extends string | number> = { value: T; label: string; hint?: string; disabled?: boolean };

/**
 * 앱 고유 드롭다운 — OS 기본 목록(Windows 흰 목록) 대신 앱 디자인의 떠 있는 목록을 띄운다.
 * 키보드: ↑↓·Home·End 로 옮기고 Enter·Space 로 고르고 Esc 로 닫는다. 글자를 치면 그 글자로 시작하는 항목으로 간다.
 * 목록은 body 에 띄워 칸 경계에 잘리지 않고, 아래 자리가 모자라면 위로 연다.
 */
export function Select<T extends string | number>({
	value,
	options,
	onChange,
	size = "md",
	className = "",
	title,
	disabled,
	autoOpen,
	onClose,
	style,
	id,
	"aria-label": ariaLabel,
}: {
	value: T;
	options: SelectOption<T>[];
	onChange: (v: T) => void;
	/** md = 입력칸 높이(32), sm = 상태 줄·도구 막대용 */
	size?: "sm" | "md";
	className?: string;
	title?: string;
	disabled?: boolean;
	/** 처음부터 열기(표 칸 편집기) */
	autoOpen?: boolean;
	/** 고르지 않고 닫혔을 때 */
	onClose?: () => void;
	style?: CSSProperties;
	id?: string;
	"aria-label"?: string;
}) {
	const [open, setOpen] = useState(!!autoOpen);
	const [hi, setHi] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
	const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
	const btn = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const typed = useRef({ s: "", t: 0 });
	const listId = useId();
	const current = options.find((o) => o.value === value);

	const place = () => {
		const r = btn.current?.getBoundingClientRect();
		if (!r) return;
		const want = Math.min(320, options.length * 30 + 10);
		const below = window.innerHeight - r.bottom - 8;
		const above = r.top - 8;
		const up = below < Math.min(want, 160) && above > below;
		setPos({
			left: Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8),
			top: up ? r.top - 4 : r.bottom + 4,
			width: r.width,
			up,
			maxH: Math.max(120, Math.min(320, up ? above : below)),
		});
	};

	useLayoutEffect(() => {
		if (!open) return;
		place();
		setHi(Math.max(0, options.findIndex((o) => o.value === value)));
		// biome-ignore lint/correctness/useExhaustiveDependencies: 열 때만
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const down = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btn.current?.contains(t) || list.current?.contains(t)) return;
			close();
		};
		const away = () => close();
		// 뒤 칸이 스크롤되면 목록이 떠 버리므로 닫는다(목록 자체 스크롤은 제외)
		const scrolled = (e: Event) => {
			if (list.current?.contains(e.target as Node)) return;
			close();
		};
		window.addEventListener("mousedown", down, true);
		window.addEventListener("resize", away);
		window.addEventListener("blur", away);
		window.addEventListener("scroll", scrolled, true);
		return () => {
			window.removeEventListener("scroll", scrolled, true);
			window.removeEventListener("mousedown", down, true);
			window.removeEventListener("resize", away);
			window.removeEventListener("blur", away);
		};
	});

	useEffect(() => {
		if (open) list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
	}, [open, hi]);

	function close(chosen = false) {
		setOpen(false);
		if (!chosen) onClose?.();
		btn.current?.focus();
	}
	function choose(i: number) {
		const o = options[i];
		if (!o || o.disabled) return;
		setOpen(false);
		btn.current?.focus();
		if (o.value !== value) onChange(o.value);
		else onClose?.();
	}
	function step(from: number, d: number) {
		let i = from;
		for (let n = 0; n < options.length; n++) {
			i = (i + d + options.length) % options.length;
			if (!options[i].disabled) return i;
		}
		return from;
	}

	const onKey = (e: KeyboardEvent) => {
		if (disabled) return;
		const k = e.key;
		if (!open) {
			if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
				e.preventDefault();
				setOpen(true);
			}
			return;
		}
		if (k === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (k === "ArrowDown") {
			e.preventDefault();
			setHi((h) => step(h, 1));
		} else if (k === "ArrowUp") {
			e.preventDefault();
			setHi((h) => step(h, -1));
		} else if (k === "Home") {
			e.preventDefault();
			setHi(step(-1, 1));
		} else if (k === "End") {
			e.preventDefault();
			setHi(step(options.length, -1));
		} else if (k === "Enter" || k === " ") {
			e.preventDefault();
			choose(hi);
		} else if (k === "Tab") {
			close();
		} else if (k.length === 1) {
			const now = Date.now();
			typed.current = { s: now - typed.current.t < 700 ? typed.current.s + k.toLowerCase() : k.toLowerCase(), t: now };
			const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.s));
			if (i >= 0) setHi(i);
		}
	};

	return (
		<>
			<button
				ref={btn}
				id={id}
				type="button"
				className={`rb-select ${size} ${className}`}
				title={title}
				disabled={disabled}
				style={style}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-label={ariaLabel}
				onClick={() => (open ? close() : setOpen(true))}
				onKeyDown={onKey}
			>
				<span className="rb-select-label">{current?.label ?? String(value)}</span>
				<ChevronDown size={size === "sm" ? 12 : 14} className="rb-select-chev" />
			</button>
			{open &&
				pos &&
				createPortal(
					<div
						ref={list}
						id={listId}
						role="listbox"
						className="rb-select-list"
						style={{
							left: pos.left,
							minWidth: Math.max(pos.width, 140),
							maxHeight: pos.maxH,
							...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
						}}
						onMouseDown={(e) => e.preventDefault()}
					>
						{options.map((o, i) => (
							<div
								key={String(o.value)}
								data-i={i}
								role="option"
								aria-selected={o.value === value}
								aria-disabled={o.disabled}
								className={`rb-select-opt${i === hi ? " hi" : ""}${o.disabled ? " off" : ""}`}
								onMouseEnter={() => !o.disabled && setHi(i)}
								onClick={() => choose(i)}
							>
								<Check size={13} className="rb-select-check" style={{ visibility: o.value === value ? "visible" : "hidden" }} />
								<span>{o.label}</span>
								{o.hint && <small>{o.hint}</small>}
							</div>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
