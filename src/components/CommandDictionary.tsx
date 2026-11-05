import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, BookOpen, Copy, CornerDownLeft, Search, SquareTerminal, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { activeTerminal, DANGER } from "../lib/activeTerm";

import { type Dict, type DictCmd, loadDict } from "../lib/dict";

const SYN: string[][] = [
	["교체", "바꾸기", "치환", "대체"],
	["압축 풀기", "풀기", "해제", "추출"],
	["압축", "묶기", "아카이브"],
	["확인", "조회", "보기"],
	["용량", "크기", "사용량"],
	["찾기", "검색"],
	["지우기", "삭제", "제거"],
	["포트", "소켓", "열린 포트"],
	["폴더", "디렉터리", "디렉토리"],
];

/** 한글 초성(ㄱ~ㅎ) — "ㅇㅊ" 로 "압축" 찾기 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
function initials(s: string) {
	let out = "";
	for (const ch of s) {
		const c = ch.charCodeAt(0) - 0xac00;
		out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
	}
	return out;
}
const isCho = (w: string) => /^[ㄱ-ㅎ]+$/.test(w);

function score(name: string, c: DictCmd, words: string[]): number {
	let s = 0;
	for (const w of words) {
		const alts = [w, ...(SYN.find((g) => g.includes(w))?.filter((x) => x !== w) ?? [])];
		let hit = 0;
		if (isCho(w)) {
			if (c.k.some((k) => initials(k).includes(w))) hit = 30;
			else if (initials(c.d).includes(w)) hit = 15;
		}
		for (const a of alts) {
			if (name === a) hit = Math.max(hit, 100);
			else if (name.startsWith(a)) hit = Math.max(hit, 60);
			else if (c.k.some((k) => k.includes(a))) hit = Math.max(hit, a === w ? 40 : 30);
			else if (c.d.includes(a)) hit = Math.max(hit, 20);
		}
		if (!hit) return 0;
		s += hit;
	}
	return s;
}

export function CommandDictionaryPane() {
	const [dict, setDict] = useState<Dict | null>(null);
	const [q, setQ] = useState("");
	const [sel, setSel] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const flash = (t: string) => {
		setNote(t);
		window.setTimeout(() => setNote(""), 2500);
	};
	const plain = fillPlaceholders;
	/** 터미널에 넣기(실행하지 않음) — 마지막으로 쓴 터미널 */
	const insert = (text: string) => {
		const t = activeTerminal();
		if (!t) return flash("먼저 터미널을 한 번 눌러 두세요");
		t.write(text);
		flash(`${t.label} 터미널에 넣었습니다 — 확인한 뒤 Enter`);
	};

	useEffect(() => {
		void loadDict().then(setDict);
	}, []);

	const list = useMemo(() => {
		if (!dict) return [];
		const names = Object.keys(dict.c);
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return names.sort();
		return names
			.map((n) => [n, score(n, dict.c[n], words)] as const)
			.filter(([, s]) => s > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([n]) => n);
	}, [dict, q]);

	const cur = sel && dict?.c[sel] ? sel : list[0];
	const cmd = cur && dict ? dict.c[cur] : null;

	return (
		<>
			<div className="toolbar">
				<span className="title">명령어 사전</span>
				<div className="search" style={{ height: 30, margin: 0, width: 320, borderRadius: 9 }}>
					<Search size={14} />
					<input
						value={q}
						onChange={(e) => {
							setQ(e.target.value);
							setSel(null);
						}}
						placeholder="명령 이름·하고 싶은 일(예: 교체, 압축 풀기)·초성(ㅇㅊ)"
						style={{ fontSize: 13 }}
					/>
				</div>
			</div>
			<div className="dict">
				<div className="dict-list">
					{!dict && <div className="sb-empty">사전 불러오는 중…</div>}
					{list.slice(0, 400).map((n) => (
						<button key={n} type="button" aria-current={n === cur} onClick={() => setSel(n)}>
							<b>{n}</b>
							<small>{dict?.c[n].d}</small>
						</button>
					))}
				</div>
				<div className="dict-body selectable">
					{cmd && cur ? (
						<>
							<h3>{cur}</h3>
							<p className="lead">{cmd.d}</p>
							<div className="chips">
								{cmd.k.map((k) => (
									<span key={k} className="chip">
										{k}
									</span>
								))}
							</div>
							{note && <div className="tree-note" style={{ margin: "0 0 10px" }}>{note}</div>}
							{cmd.x?.map(([d, c]) => (
								<div key={c} className={`ex${DANGER.test(c) ? " danger" : ""}`}>
									<p>
										{DANGER.test(c) && (
											<span className="danger-tag">
												<AlertTriangle size={12} /> 되돌리기 어려움
											</span>
										)}
										{d}
									</p>
									<div className="ex-row">
										<code>{withSlots(c)}</code>
										<span className="ex-acts">
											<button
												type="button"
												className="btn ghost icon"
												title="터미널에 넣기(실행하지 않음) — 마지막으로 쓴 터미널, 자리표시자는 이름만 남김"
												onClick={() => insert(plain(c))}
											>
												<SquareTerminal size={13} />
											</button>
											<button type="button" className="btn ghost icon" title="복사" onClick={() => void navigator.clipboard.writeText(plain(c)).then(() => flash("복사했습니다"))}>
												<Copy size={13} />
											</button>
											<button
												type="button"
												className="btn ghost icon"
												title="내 스니펫으로 저장(Alt+P 로 꺼내 쓰기)"
												onClick={() =>
													void invoke("snippet_save", { s: { kind: "shell", name: `${cur} — ${d}`.slice(0, 80), body: plain(c) } })
														.then(() => flash("스니펫으로 저장했습니다(터미널에서 Alt+P)"))
														.catch((e) => flash(String(e)))
												}
											>
												<Star size={13} />
											</button>
										</span>
									</div>
									<ExampleEdit key={c} command={c} cmdName={cur} onInsert={insert} />
								</div>
							))}
							{cmd.o?.slice(0, 60).map(([f, d]) => (
								<div key={f} className="opt">
									<code>{f.split("|").join(", ")}</code>
									<span>{d}</span>
								</div>
							))}
							<p className="dict-note">
								출처: Fig autocomplete {dict?.src.fig}(MIT) · tldr-pages(CC BY 4.0) — 설명은 한국어로 옮김. NOTICE.md 참고.
							</p>
						</>
					) : (
						dict && (
							<div className="empty">
								<BookOpen size={18} /> 맞는 명령이 없습니다
							</div>
						)
					)}
				</div>
			</div>
		</>
	);
}

const PLACEHOLDER = /\{\{(.*?)\}\}/g;

/** 자리표시자를 셸에 넣을 글자로 — {{[-r|--recursive]}} 는 첫 갈래, {{경로}} 는 안의 글자 */
function fillPlaceholders(command: string): string {
	return command.replace(/\{\{\[([^|\]]+)\|[^\]]*\]\}\}/g, "$1").replace(PLACEHOLDER, "$1");
}

/**
 * 예시 고치기 — {{자리}} 를 Tab·Shift+Tab 으로 옮겨 다니며(그 자리를 통째로 골라 바로 덮어쓰기) 채우고, Enter 로 터미널에 넣는다(실행하지 않음).
 * 남은 {{자리}} 는 안의 글자만 남긴다.
 */
function ExampleEdit({ command, cmdName, onInsert }: { command: string; cmdName: string; onInsert: (text: string) => void }) {
	const [value, setValue] = useState(command);
	const input = useRef<HTMLInputElement>(null);
	/** 다음(Shift 면 이전) 자리표시자를 고른다 — 없으면 false(Tab 은 원래대로) */
	const jump = (back: boolean) => {
		const el = input.current;
		if (!el) return false;
		const spots = [...value.matchAll(PLACEHOLDER)].map((m): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
		if (!spots.length) return false;
		const cur = el.selectionStart ?? 0;
		const next = back
			? ([...spots].reverse().find(([s]) => s < cur) ?? spots[spots.length - 1])
			: (spots.find(([s]) => s > cur || (s === cur && el.selectionEnd === cur)) ?? spots[0]);
		if (!next) return false;
		el.setSelectionRange(next[0], next[1]);
		return true;
	};
	return (
		<div className="ex-edit">
			<input
				ref={input}
				value={value}
				spellCheck={false}
				autoComplete="off"
				aria-label={`${cmdName} 예시 고치기 — Tab 으로 자리표시자 이동, Enter 로 터미널에 넣기`}
				title="Tab·Shift+Tab: 다음·이전 자리 · Enter: 터미널에 넣기(실행하지 않음)"
				onChange={(e) => setValue(e.target.value)}
				onFocus={() => window.setTimeout(() => jump(false), 0)}
				onKeyDown={(e) => {
					if (e.key === "Tab" && jump(e.shiftKey)) e.preventDefault();
					else if (e.key === "Enter") {
						e.preventDefault();
						onInsert(fillPlaceholders(value));
					} else if (e.key === "Escape") setValue(command);
				}}
			/>
			<button type="button" className="btn ghost" title="고친 명령을 터미널 입력 줄에 넣기(실행하지 않음)" onClick={() => onInsert(fillPlaceholders(value))}>
				<CornerDownLeft size={13} /> 터미널에 넣기
			</button>
		</div>
	);
}

/** tldr 예시의 {{자리}} 를 괄호 없이 강조된 낱말로 */
function withSlots(c: string) {
	return c.split(/({{[^}]*}})/).map((part, i) =>
		part.startsWith("{{") && part.endsWith("}}") ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: 고정 조각
			<span key={i} className="slot">
				{part.slice(2, -2)}
			</span>
		) : (
			part
		),
	);
}
