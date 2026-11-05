import { BookOpen, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** data/cmd-dict/dict.json 형식(Orbit D24 에서 만든 데이터를 그대로 씀) */
type DictOpt = [flags: string, desc: string, arg?: string];
type DictCmd = { d: string; k: string[]; o?: DictOpt[]; s?: Record<string, { d: string }>; x?: [string, string][] };
type Dict = { v: number; src: { fig: string; tldr: string }; c: Record<string, DictCmd> };

let cache: Promise<Dict> | null = null;
/** 사전은 처음 열 때 받는다(기동 비용 0) */
function loadDict(): Promise<Dict> {
	cache ??= import("../../data/cmd-dict/dict.json").then((m) => (m as unknown as { default: Dict }).default);
	return cache;
}

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

function score(name: string, c: DictCmd, words: string[]): number {
	let s = 0;
	for (const w of words) {
		const alts = [w, ...(SYN.find((g) => g.includes(w))?.filter((x) => x !== w) ?? [])];
		let hit = 0;
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
						placeholder="명령 이름 또는 하고 싶은 일(예: 교체, 압축 풀기)"
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
							{cmd.x?.map(([d, c]) => (
								<div key={c} className="ex">
									<p>{d}</p>
									<code>{c}</code>
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
