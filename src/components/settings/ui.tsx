import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { askText } from "../../lib/ask";
import { api, type AppInfo } from "../../lib/ipc";
import { onSettingLive, setSettingLive } from "../../lib/settingsBus";
import { notifyTermPrefs } from "../../lib/termPrefs";
import { getAppearance, MONO_FONTS, onAppearance } from "../../lib/theme";
import { Select } from "../Select";
import { rowMeta } from "./meta";

/** 범주 화면이 받는 것 — 하위 화면(sub)과 이동 */
export type PageProps = {
	info: AppInfo | null;
	sub: string | null;
	/** 같은 범주의 하위 화면으로(null 이면 범주 첫 화면) */
	go: (sub: string | null) => void;
	/** 다른 범주·하위 화면·줄로 — "general#update.status" */
	goto: (path: string) => void;
	onOpen: (w: "keys" | "connections" | "import") => void;
	/** 화면 아래 알림(실패 글) */
	say: (msg: string) => void;
};

/**
 * 설정 한 줄 — 왼쪽 이름(+작은 설명), 오른쪽 조절기. 이름·설명은 meta 의 ROWS[id] 에서(덮어쓸 수 있음).
 * block: 조절기를 이름 아래로(색 구성 격자·단어 목록처럼 넓은 것)
 */
export function Row({ id, label, sub, children, block }: { id: string; label?: ReactNode; sub?: ReactNode; children?: ReactNode; block?: boolean }) {
	const m = rowMeta(id);
	const name = label ?? m?.label ?? id;
	const desc = sub === undefined ? m?.desc : sub;
	return (
		<div className={`stg-row${block ? " block" : ""}`} data-set-id={id}>
			<div className="stg-text">
				<div className="stg-name">{name}</div>
				{desc && <small>{desc}</small>}
				{block && children}
			</div>
			{!block && children != null && <div className="stg-ctl">{children}</div>}
		</div>
	);
}

/** › 줄 — 하위 화면·다른 화면으로 */
export function LinkRow({ id, label, sub, value, onClick }: { id: string; label?: ReactNode; sub?: ReactNode; value?: ReactNode; onClick: () => void }) {
	const m = rowMeta(id);
	const desc = sub === undefined ? m?.desc : sub;
	return (
		<button type="button" className="stg-row stg-link" data-set-id={id} onClick={onClick}>
			<span className="stg-text">
				<span className="stg-name">{label ?? m?.label ?? id}</span>
				{desc && <small>{desc}</small>}
			</span>
			{value != null && <span className="stg-value">{value}</span>}
			<ChevronRight size={14} className="stg-chev" aria-hidden />
		</button>
	);
}

/** 둥근 묶음 칸 — 위 작은 머리글, 아래 작은 설명 */
export function Group({ title, foot, children }: { title?: ReactNode; foot?: ReactNode; children: ReactNode }) {
	return (
		<section className="stg-group">
			{title && <h3 className="stg-ghead">{title}</h3>}
			<div className="stg-card">{children}</div>
			{foot && <p className="stg-gfoot">{foot}</p>}
		</section>
	);
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!on)}>
			<i />
		</button>
	);
}

/** 앱 설정 한 칸 — 앱 DB(setting) 에 문자열로 둔다. 다른 화면(빠른 스위치)에서 바뀌어도 따라간다 */
export function useSetting(key: string, def: string): [string, (v: string) => void] {
	const [v, setV] = useState(def);
	useEffect(() => {
		let alive = true;
		// 읽기가 오기 전에 다른 화면에서 바뀌면 그 값이 더 새것 — 늦게 온 읽기로 덮지 않는다
		let touched = false;
		void api.settingGet(key).then((x) => alive && !touched && x && setV(x));
		const off = onSettingLive([key], (_, x) => {
			touched = true;
			setV(x || def);
		});
		return () => {
			alive = false;
			off();
		};
	}, [key, def]);
	return [
		v,
		(x: string) => {
			setV(x);
			setSettingLive(key, x);
		},
	];
}

/** 터미널 설정 한 칸 — 바꾸면 열린 터미널에 바로 알린다 */
export function useTermSetting(key: string, def: string): [string, (v: string) => void] {
	const [v, set] = useSetting(key, def);
	return [
		v,
		(x: string) => {
			set(x);
			window.setTimeout(notifyTermPrefs, 50);
		},
	];
}

/** 화면 설정을 읽고, 바뀌면 다시 그리기 */
export function useAppearance() {
	const [, setTick] = useState(0);
	useEffect(() => onAppearance(() => setTick((t) => t + 1)), []);
	return getAppearance();
}

/** 폴더 칸 — 비우면 기본(placeholder) */
export function FolderPick({ value, placeholder, onChange, title }: { value: string; placeholder: string; onChange: (v: string) => void; title: string }) {
	return (
		<div className="folder-pick">
			<span className={value ? "fp-path" : "fp-path muted"} title={value || placeholder}>
				{value || placeholder}
			</span>
			<button
				type="button"
				className="btn"
				onClick={async () => {
					const d = await openDialog({ directory: true, multiple: false, title, defaultPath: value || undefined });
					if (typeof d === "string") onChange(d);
				}}
			>
				바꾸기
			</button>
			{value && (
				<button type="button" className="btn ghost" onClick={() => onChange("")} title="기본으로">
					기본
				</button>
			)}
		</div>
	);
}

/** 고정폭 글꼴 고르기 — 목록 + 직접 넣기 */
export function FontSelect({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
	const CUSTOM = "\u0000custom";
	const known = value === "" || MONO_FONTS.includes(value);
	return (
		<Select
			size="sm"
			value={value}
			title={title}
			aria-label={title}
			onChange={(v) => {
				if (v !== CUSTOM) return onChange(v);
				void askText({ title, message: "내 PC 에 깔린 고정폭 글꼴 이름(없으면 앱 기본 글꼴로 보입니다)", value, placeholder: "예: D2Coding ligature", okLabel: "쓰기", allowEmpty: true }).then((x) => {
					if (x !== null) onChange(x.trim());
				});
			}}
			options={[
				{ value: "", label: "앱 기본(고정폭)" },
				...(known ? [] : [{ value, label: value, hint: "직접 넣음" }]),
				...MONO_FONTS.map((f) => ({ value: f, label: f })),
				{ value: CUSTOM, label: "직접 넣기…" },
			]}
		/>
	);
}

export const SIZES = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) => ({ value: String(n), label: `${n}px` }));

export function ago(ms: number) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "방금";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86400)}일 전`;
}
