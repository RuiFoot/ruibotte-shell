import { Command as CommandIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, type Command, fmtKeys, GROUP_LABEL, GROUP_ORDER, loadRecentCommands, noteCommandRun, scoreCommand } from "../lib/commands";

type Row = { kind: "head"; label: string } | { kind: "cmd"; c: Command; i: number };

/** 비어 있을 때 묶음마다 보여 줄 수(넘치면 "더 치세요") */
const EMPTY_PER_GROUP = 6;
const MAX_RESULTS = 80;

/**
 * 명령 팔레트 — 한 입력창에서 연결·탭·작업대 동작·앱 설정을 찾아 실행.
 * 띄어 쓴 낱말은 모두 맞아야 하고, 초성(ㅅㅂ → 서버)도 된다. 최근 실행한 명령이 위로.
 */
export function CommandPalette({ initial = "", onClose }: { initial?: string; onClose: () => void }) {
	const [query, setQuery] = useState(initial);
	const [index, setIndex] = useState(0);
	const [recent, setRecent] = useState<string[]>([]);
	const list = useRef<HTMLDivElement>(null);
	// 열 때 한 번 모은다(열려 있는 동안 바뀐 상태는 다시 열면 반영)
	const commands = useMemo(() => allCommands(), []);
	useEffect(() => {
		void loadRecentCommands().then((r) => setRecent([...r]));
	}, []);

	const rows = useMemo<Row[]>(() => {
		const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const rank = (id: string) => {
			const i = recent.indexOf(id);
			return i < 0 ? 0 : 20 - i;
		};
		const out: Row[] = [];
		let n = 0;
		const push = (c: Command) => out.push({ kind: "cmd", c, i: n++ });
		if (!words.length) {
			// 빈 칸: 최근 실행 → 묶음별 앞쪽 몇 개
			const rec = recent.map((id) => commands.find((c) => c.id === id)).filter((c): c is Command => !!c && !c.disabled).slice(0, 6);
			if (rec.length) {
				out.push({ kind: "head", label: "최근 실행" });
				for (const c of rec) push(c);
			}
			for (const g of GROUP_ORDER) {
				const items = commands.filter((c) => c.group === g && !rec.includes(c));
				if (!items.length) continue;
				out.push({ kind: "head", label: `${GROUP_LABEL[g]}${items.length > EMPTY_PER_GROUP ? ` · ${items.length}개 중 일부` : ""}` });
				for (const c of items.slice(0, EMPTY_PER_GROUP)) push(c);
			}
			return out;
		}
		const scored = commands
			.map((c) => ({ c, s: scoreCommand(c, words) }))
			.filter((x) => x.s > 0)
			.map((x) => ({ ...x, s: x.s + rank(x.c.id) - (x.c.disabled ? 15 : 0) }))
			.sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title, "ko"))
			.slice(0, MAX_RESULTS);
		// 가장 잘 맞는 묶음부터, 묶음 안은 점수 순
		const best = new Map<string, number>();
		for (const x of scored) if (!best.has(x.c.group)) best.set(x.c.group, x.s);
		const groups = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
		for (const g of groups) {
			out.push({ kind: "head", label: GROUP_LABEL[g as Command["group"]] });
			for (const x of scored) if (x.c.group === g) push(x.c);
		}
		return out;
	}, [query, commands, recent]);

	const cmdRows = rows.filter((r): r is Extract<Row, { kind: "cmd" }> => r.kind === "cmd");
	const count = cmdRows.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 찾는 말이 바뀌면 맨 위로
	useEffect(() => setIndex(0), [query]);
	useEffect(() => {
		list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index]);

	const run = (c: Command | undefined) => {
		if (!c || c.disabled) return;
		noteCommandRun(c.id);
		onClose();
		// 팔레트가 닫힌 뒤(포커스가 돌아간 뒤) 실행
		requestAnimationFrame(() => void Promise.resolve(c.run()).catch((e) => alert(String((e as { message?: string })?.message ?? e))));
	};

	return (
		<div className="scrim" style={{ placeItems: "start center", paddingTop: "12vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="palette cp" role="dialog" aria-label="명령 팔레트">
				<div className="palette-head qo-head">
					<CommandIcon size={15} />
					<input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								onClose();
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setIndex((i) => (count ? (i + 1) % count : 0));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setIndex((i) => (count ? (i - 1 + count) % count : 0));
							} else if (e.key === "PageDown") {
								e.preventDefault();
								setIndex((i) => Math.min(count - 1, i + 8));
							} else if (e.key === "PageUp") {
								e.preventDefault();
								setIndex((i) => Math.max(0, i - 8));
							} else if (e.key === "Enter") {
								e.preventDefault();
								run(cmdRows[index]?.c);
							}
						}}
						placeholder="무엇을 할까요? 서버 이름·명령·설정(초성도 됩니다)"
						spellCheck={false}
						autoComplete="off"
						aria-controls="cp-list"
						aria-activedescendant={count ? `cp-${index}` : undefined}
					/>
				</div>
				<div className="palette-list cp-list" id="cp-list" ref={list} role="listbox" aria-label="명령">
					{count === 0 ? (
						<div className="qo-msg">{query.trim() ? "맞는 명령이 없습니다." : "등록된 명령이 없습니다."}</div>
					) : (
						rows.map((r) =>
							r.kind === "head" ? (
								<div key={`h:${r.label}`} className="cp-head" role="presentation">
									{r.label}
								</div>
							) : (
								<div
									key={r.c.id}
									id={`cp-${r.i}`}
									data-i={r.i}
									role="option"
									tabIndex={-1}
									aria-selected={r.i === index}
									aria-disabled={r.c.disabled || undefined}
									className={`cp-item${r.c.disabled ? " off" : ""}`}
									onMouseMove={() => r.i !== index && setIndex(r.i)}
									onMouseDown={(e) => {
										e.preventDefault();
										run(r.c);
									}}
								>
									<span className="cp-title">{r.c.title}</span>
									{r.c.hint && <span className="cp-hint">{r.c.hint}</span>}
									{r.c.keys && <kbd className="cp-keys">{fmtKeys(r.c.keys)}</kbd>}
								</div>
							),
						)
					)}
				</div>
				<div className="palette-foot">↑↓ 고르기 · Enter 실행 · Esc 닫기 · 띄어 쓴 낱말은 모두 맞아야 합니다 · 초성(ㅅㅂ)도 찾습니다</div>
			</div>
		</div>
	);
}
