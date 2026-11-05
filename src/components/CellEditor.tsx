import { useEffect, useRef, useState } from "react";
import { type Cell, type ColMeta, type FieldKind, fieldKind, validate } from "../lib/edits";
import { Select } from "./Select";

/** 참/거짓 고르기에서 NULL 을 나타내는 값 */
const NULL_KEY = "\u0000";

/**
 * 칸 안 형식별 입력기 — 날짜·날짜시각·시각, 참/거짓(3상태), enum, 숫자(검사), JSON·긴 글(여러 줄), UUID(새로 만들기).
 * Enter 확정(여러 줄은 Ctrl+Enter), Tab 확정 후 다음 칸, Esc 취소, NULL 단추(허용 열), 틀린 값은 빨간 테두리로 막는다.
 */
export function CellEditor({ meta, value, onDone, seeded }: { meta?: ColMeta; value: Cell; onDone: (v: Cell | undefined, move?: "next" | "down") => void; seeded?: boolean }) {
	const kind: FieldKind = fieldKind(meta);
	const [v, setV] = useState<Cell>(value);
	const [err, setErr] = useState<string | null>(null);
	const ref = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
	useEffect(() => {
		ref.current?.focus();
		if (ref.current && "select" in ref.current && kind !== "enum" && kind !== "bool") {
			if (seeded) {
				const n = ref.current.value?.length ?? 0;
				ref.current.setSelectionRange?.(n, n);
			} else ref.current.select?.();
		}
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
		const word = /^(t|true|f|false)$/i.test(value ?? "");
		input = (
			<Select
				size="sm"
				className="cell-select"
				autoOpen
				value={v ?? NULL_KEY}
				onChange={(x) => commit(x === NULL_KEY ? null : x)}
				onClose={() => onDone(undefined)}
				options={[
					{ value: word ? "true" : "1", label: "참" },
					{ value: word ? "false" : "0", label: "거짓" },
					...(meta?.nullable !== false ? [{ value: NULL_KEY, label: "NULL" }] : []),
				]}
			/>
		);
	} else if (kind === "enum") {
		input = (
			<Select
				size="sm"
				className="cell-select"
				autoOpen
				value={v ?? ""}
				onChange={(x) => commit(x)}
				onClose={() => onDone(undefined)}
				options={(meta?.enumValues ?? []).map((x) => ({ value: x, label: x }))}
			/>
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
