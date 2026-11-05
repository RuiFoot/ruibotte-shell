import { useEffect, useRef, useState } from "react";
import { type Cell, type ColMeta, type FieldKind, fieldKind, validate } from "../lib/edits";

/**
 * 칸 안 형식별 입력기 — 날짜·날짜시각·시각, 참/거짓(3상태), enum, 숫자(검사), JSON·긴 글(여러 줄), UUID(새로 만들기).
 * Enter 확정(여러 줄은 Ctrl+Enter), Tab 확정 후 다음 칸, Esc 취소, NULL 단추(허용 열), 틀린 값은 빨간 테두리로 막는다.
 */
export function CellEditor({ meta, value, onDone }: { meta?: ColMeta; value: Cell; onDone: (v: Cell | undefined, move?: "next" | "down") => void }) {
	const kind: FieldKind = fieldKind(meta);
	const [v, setV] = useState<Cell>(value);
	const [err, setErr] = useState<string | null>(null);
	const ref = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
	useEffect(() => {
		ref.current?.focus();
		if (ref.current && "select" in ref.current && kind !== "enum" && kind !== "bool") ref.current.select?.();
	}, [kind]);

	const commit = (val: Cell, move?: "next" | "down") => {
		const e = validate(kind, val, meta);
		if (e) {
			setErr(e);
			return;
		}
		onDone(val, move);
	};

	const keys = (e: React.KeyboardEvent, multi = false) => {
		e.stopPropagation();
		if (e.key === "Escape") onDone(undefined);
		else if (e.key === "Enter" && (!multi || e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
			e.preventDefault();
			commit(v, "down");
		} else if (e.key === "Tab") {
			e.preventDefault();
			commit(v, "next");
		}
	};

	const nullBtn = meta?.nullable !== false && (
		<button
			type="button"
			className="cell-null"
			onMouseDown={(e) => {
				e.preventDefault();
				onDone(null);
			}}
			title="NULL 로"
		>
			NULL
		</button>
	);

	const common = {
		className: `cell-input${err ? " bad" : ""}`,
		title: err ?? undefined,
		onBlur: () => commit(v),
	};

	let input: React.ReactNode;
	if (kind === "bool") {
		input = (
			<select {...common} ref={ref} value={v ?? "\u0000"} onChange={(e) => commit(e.target.value === "\u0000" ? null : e.target.value)} onKeyDown={(e) => keys(e)}>
				<option value={/^(t|true|f|false)$/i.test(value ?? "") ? "true" : "1"}>참</option>
				<option value={/^(t|true|f|false)$/i.test(value ?? "") ? "false" : "0"}>거짓</option>
				{meta?.nullable !== false && <option value={"\u0000"}>NULL</option>}
			</select>
		);
	} else if (kind === "enum") {
		input = (
			<select {...common} ref={ref} value={v ?? ""} onChange={(e) => commit(e.target.value)} onKeyDown={(e) => keys(e)}>
				{(meta?.enumValues ?? []).map((x) => (
					<option key={x}>{x}</option>
				))}
			</select>
		);
	} else if (kind === "json" || kind === "longtext") {
		input = (
			<textarea
				{...common}
				ref={ref}
				className={`${common.className} cell-multi`}
				value={v ?? ""}
				onChange={(e) => {
					setV(e.target.value);
					setErr(null);
				}}
				onKeyDown={(e) => keys(e, true)}
				placeholder="Ctrl+Enter 확정"
			/>
		);
	} else {
		const type = kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : kind === "time" ? "time" : "text";
		const toInput = (x: Cell) => (x && kind === "datetime" ? x.replace(" ", "T").slice(0, 19) : (x ?? ""));
		const fromInput = (x: string) => (kind === "datetime" ? x.replace("T", " ") : x);
		input = (
			<input
				{...common}
				ref={ref}
				type={type}
				step={kind === "datetime" || kind === "time" ? 1 : undefined}
				inputMode={kind === "int" || kind === "numeric" ? "decimal" : undefined}
				value={toInput(v)}
				onChange={(e) => {
					setV(fromInput(e.target.value));
					setErr(null);
				}}
				onKeyDown={(e) => keys(e)}
			/>
		);
	}

	return (
		<div className="cell-editor" onMouseDown={(e) => e.stopPropagation()}>
			{input}
			{kind === "uuid" && (
				<button
					type="button"
					className="cell-null"
					onMouseDown={(e) => {
						e.preventDefault();
						commit(crypto.randomUUID());
					}}
				>
					새 UUID
				</button>
			)}
			{(kind === "datetime" || kind === "date") && (
				<button
					type="button"
					className="cell-null"
					onMouseDown={(e) => {
						e.preventDefault();
						const d = new Date();
						const p = (n: number) => String(n).padStart(2, "0");
						const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
						commit(kind === "date" ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
					}}
				>
					지금
				</button>
			)}
			{nullBtn}
			{err && <span className="cell-err">{err}</span>}
		</div>
	);
}
