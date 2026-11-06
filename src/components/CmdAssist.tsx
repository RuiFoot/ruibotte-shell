/**
 * 명령 입력 보조(D25) 화면 — ③ 빈칸 채우기 폼 시트, ④ 조각 풀이 카드.
 * 폼은 칸을 채우면 완성 명령이 바로 보이고, 버튼은 [입력 줄에 넣기]만 있다(바로 실행 없음). 비운 필수 칸은 ① 빈칸으로 남긴다.
 */
import { AlertTriangle, CornerDownLeft, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AssistField,
	buildForm,
	dangersOf,
	type ExplainPart,
	FORMS,
	type FieldSource,
	type FormValues,
	formById,
	initialValues,
} from "../lib/cmdAssist";
import { Select } from "./Select";

export type CandidateFn = (src: FieldSource) => Promise<string[]>;

/** {{빈칸}} 을 강조해 그린다 */
export function SlotText({ text }: { text: string }) {
	return (
		<>
			{text.split(/(\{\{[^}]*\}\})/).map((part, i) =>
				part.startsWith("{{") && part.endsWith("}}") ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 고정 조각
					<span key={i} className="slot">
						{part.slice(2, -2)}
					</span>
				) : (
					part
				),
			)}
		</>
	);
}

/** 추천 값이 아래에 뜨는 입력칸(네이티브 datalist 대신) */
function SuggestInput({
	id,
	value,
	onChange,
	placeholder,
	suggest,
	onFocusLoad,
	autoFocus,
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	suggest: [string, string][];
	onFocusLoad?: () => void;
	autoFocus?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(0);
	const q = value.toLowerCase();
	const shown = useMemo(() => {
		const list = suggest.filter(([v, l]) => v !== value && (!q || v.toLowerCase().includes(q) || l.toLowerCase().includes(q)));
		return list.slice(0, 40);
	}, [suggest, value, q]);
	const pick = (v: string) => {
		onChange(v);
		setOpen(false);
	};
	return (
		<div className="af-suggest">
			<input
				id={id}
				value={value}
				// biome-ignore lint/a11y/noAutofocus: 시트를 열면 첫 칸에서 바로 치게(앱의 다른 시트와 같음)
				autoFocus={autoFocus}
				spellCheck={false}
				autoComplete="off"
				placeholder={placeholder}
				onChange={(e) => {
					onChange(e.target.value);
					setOpen(true);
					setHi(0);
				}}
				onFocus={() => {
					onFocusLoad?.();
					setOpen(true);
				}}
				onBlur={() => window.setTimeout(() => setOpen(false), 120)}
				onKeyDown={(e) => {
					if (!open || !shown.length) return;
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						setHi((h) => (h + (e.key === "ArrowUp" ? -1 : 1) + shown.length) % shown.length);
					} else if (e.key === "Enter" && shown[hi]) {
						e.preventDefault();
						e.stopPropagation();
						pick(shown[hi][0]);
					} else if (e.key === "Escape") {
						e.stopPropagation();
						setOpen(false);
					}
				}}
			/>
			{open && shown.length > 0 && (
				<div className="af-list" role="listbox">
					{shown.map(([v, l], i) => (
						<button
							key={v}
							type="button"
							role="option"
							aria-selected={i === hi}
							className={i === hi ? "sel" : undefined}
							onMouseDown={(e) => {
								e.preventDefault();
								pick(v);
							}}
							onMouseEnter={() => setHi(i)}
						>
							<b>{v}</b>
							{l && l !== v ? <span>{l}</span> : null}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * 빈칸 채우기 폼 — 폼 id 가 없으면 첫 폼부터 고르게. candidates 가 있으면 칸에 초점이 올 때 후보를 한 번 받는다(서버 조회는 읽기 전용·30초 캐시).
 */
export function AssistFormSheet({
	initial,
	only,
	candidates,
	target,
	onInsert,
	onClose,
}: {
	initial?: string | null;
	/** 이 명령의 폼만 고르게(사전 상세) */
	only?: string;
	candidates?: CandidateFn;
	/** 넣을 터미널 이름(안내) */
	target?: string;
	onInsert: (text: string) => void;
	onClose: () => void;
}) {
	const list = only ? FORMS.filter((x) => x.cmd === only) : FORMS;
	const [id, setId] = useState(() => (initial && formById(initial) ? initial : (list[0]?.form.id ?? "")));
	const form = formById(id);
	const [values, setValues] = useState<FormValues>(() => (form ? initialValues(form) : {}));
	const [cands, setCands] = useState<Record<string, string[]>>({});
	const asked = useRef(new Set<string>());
	useEffect(() => {
		const f = formById(id);
		setValues(f ? initialValues(f) : {});
	}, [id]);
	const loadSrc = (src?: FieldSource) => {
		if (!src || !candidates || asked.current.has(src)) return;
		asked.current.add(src);
		void candidates(src)
			.then((l) => setCands((c) => ({ ...c, [src]: l })))
			.catch(() => undefined);
	};
	if (!form) return null;
	const built = buildForm(form, values);
	const dangers = dangersOf(built.text, built.dangers);
	const set = (name: string, v: string) => setValues((x) => ({ ...x, [name]: v }));
	const insert = () => onInsert(built.text);
	const field = (f: AssistField, i: number) => {
		const fid = `af-${form.id}-${f.name}`;
		if (f.kind === "flag")
			return (
				<label key={f.name} className="check af-flag" title={f.d}>
					<input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked ? (f.on ?? "") : "")} />
					{f.label}
					{f.d ? <small>{f.d}</small> : null}
				</label>
			);
		if (f.kind === "select")
			return (
				<div key={f.name} className="field">
					<label htmlFor={fid}>{f.label}</label>
					<Select
						id={fid}
						value={values[f.name] ?? ""}
						onChange={(v) => set(f.name, v)}
						options={(f.options ?? []).map(([v, l]) => ({ value: v, label: l, hint: v || undefined }))}
					/>
				</div>
			);
		const suggest: [string, string][] = [...(f.options ?? []), ...(f.src ? (cands[f.src] ?? []).map((v): [string, string] => [v, ""]) : [])];
		return (
			<div key={f.name} className="field">
				<label htmlFor={fid}>
					{f.label}
					{f.req ? <em className="af-req"> 필수</em> : null}
				</label>
				<SuggestInput
					id={fid}
					value={values[f.name] ?? ""}
					onChange={(v) => set(f.name, v)}
					placeholder={f.d ?? (f.src ? "칸을 누르면 후보가 보입니다" : undefined)}
					suggest={suggest}
					onFocusLoad={() => loadSrc(f.src)}
					autoFocus={i === 0}
				/>
			</div>
		);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 시트 바깥(가림막) 누르기·Esc·Ctrl+Enter — 앱의 다른 시트와 같은 방식
		<div
			className="scrim"
			role="presentation"
			onMouseDown={(e) => e.target === e.currentTarget && onClose()}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onClose();
				} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					insert();
				}
			}}
		>
			<div className="sheet af-sheet" role="dialog" aria-label="명령 만들기">
				<h3>명령 만들기</h3>
				{list.length > 1 && (
					<div className="field">
						<label htmlFor="af-pick">무엇을 할까요</label>
						<Select id="af-pick" value={id} onChange={setId} options={list.map((x) => ({ value: x.form.id, label: x.form.label, hint: x.cmd }))} />
					</div>
				)}
				{form.d && <p className="af-lead">{form.d}</p>}
				<div className="af-fields" key={form.id}>
					{form.fields.map(field)}
				</div>
				<div className="af-preview-box">
					<div className="af-preview-head">완성 명령</div>
					<pre className="af-preview selectable">
						<SlotText text={built.text} />
					</pre>
					{built.missing.length > 0 && <p className="af-missing">비운 필수 칸 — {built.missing.join(", ")} — 은 빈칸으로 넣습니다. 터미널에서 Tab 으로 옮겨 채우세요.</p>}
					{dangers.map((d) => (
						<p key={d} className="af-danger">
							<AlertTriangle size={13} /> {d}
						</p>
					))}
				</div>
				<div className="sheet-actions">
					<span className="af-note">{target ? `${target} 터미널 입력 줄에 넣습니다 — 실행은 직접 Enter` : "실행은 직접 Enter"}</span>
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button type="button" className="btn primary" onClick={insert} title="입력 줄에 넣기(실행하지 않음) — Ctrl+Enter">
						<CornerDownLeft size={14} /> 입력 줄에 넣기
					</button>
				</div>
			</div>
		</div>
	);
}

const KIND_LABEL: Record<ExplainPart["kind"], string> = { cmd: "명령", sub: "하위 명령", opt: "옵션", val: "값", arg: "인자", op: "연결", wrap: "앞붙이" };

/** ④ 조각 풀이 — 터미널 위에 뜨는 작은 카드(Esc·× 로 닫기) */
export function ExplainCard({ text, parts, anchor, onClose }: { text: string; parts: ExplainPart[]; anchor: DOMRect | null; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const down = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		window.addEventListener("mousedown", down, true);
		return () => window.removeEventListener("mousedown", down, true);
	}, [onClose]);
	const style = anchor ? { right: Math.max(8, window.innerWidth - anchor.right + 12), top: Math.max(8, anchor.top + 10), maxHeight: Math.max(160, anchor.height - 20) } : undefined;
	return (
		<div
			className="ax-explain"
			ref={ref}
			style={style}
			role="dialog"
			aria-label="명령 풀이"
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="ax-explain-head">
				<b>명령 풀이</b>
				<button type="button" className="btn ghost icon" title="닫기(Esc)" onClick={onClose}>
					<X size={13} />
				</button>
			</div>
			<code className="ax-explain-line selectable">{text}</code>
			<div className="ax-explain-list">
				{parts.map((p, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 조각 순서가 곧 정체
					<div key={i} className={`ax-part k-${p.kind}`}>
						<code>{p.tok}</code>
						<span className="ax-kind">{KIND_LABEL[p.kind]}</span>
						<span className={p.d ? "ax-d" : "ax-d none"}>{p.d ?? "설명 없음"}</span>
					</div>
				))}
			</div>
			<div className="ax-explain-foot">Ctrl+Shift+E 다시 풀이 · Esc 닫기 · 설명 출처: 손으로 적은 한국어 → 사전(Fig·tldr) → 서버 man</div>
		</div>
	);
}
