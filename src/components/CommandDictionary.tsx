import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, BookOpen, Copy, Search, SquareTerminal, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	/** {{자리}} 를 이름만 남기고 */
	const plain = (c: string) => c.replace(/\{\{([^}]*)\}\}/g, "$1");

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
												onClick={() => {
													const t = activeTerminal();
													if (!t) return flash("먼저 터미널을 한 번 눌러 두세요");
													t.write(plain(c));
													flash(`${t.label} 터미널에 넣었습니다 — 자리표시자를 고친 뒤 Enter`);
												}}
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
