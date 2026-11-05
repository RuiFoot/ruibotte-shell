/**
 * 터미널에 자동완성을 얹는다 — 흐린 제안(→ 로 받기)과 Tab 목록(Tab·↓ 다음, Shift+Tab·↑ 이전, Enter·→ 받기, Esc 닫기).
 * 키 입력 경로를 막지 않도록 React 상태 없이 DOM 을 직접 그린다. 프롬프트(OSC 133 A) 뒤 입력에서만 켜진다.
 * 목록이 비면 Tab 은 원래대로 셸(bash 완성)에 넘긴다. 지난 명령은 서버별로 앱 DB 에 500개까지.
 */
import type { Terminal } from "@xterm/xterm";
import { type Candidate, complete, ghost } from "./complete";
import { loadDict } from "./dict";
import { api, type FsEntry } from "./ipc";

export type CompletionSource = {
	/** 서버별 기록 열쇠(예: ssh:호스트:계정) */
	key: string;
	listDir: (dir: string) => Promise<FsEntry[]>;
	commands: () => Promise<string[]>;
	home?: string;
};

export type Completer = {
	/** 프롬프트 시작(OSC 133 A) */
	prompt: () => void;
	/** 명령 실행(Enter) — 기록 */
	submitted: () => void;
	/** 사람이 입력함(프롬프트 상태에서) */
	typed: () => void;
	cwd: (p: string) => void;
	/** 키 처리 — false 면 xterm 이 처리하지 않는다 */
	key: (e: KeyboardEvent) => boolean;
	dispose: () => void;
};

export function attachCompletion(term: Terminal, host: HTMLElement, src: CompletionSource, send: (s: string) => void): Completer {
	void loadDict();
	let history: string[] = [];
	void api.settingGet(`hist.${src.key}`).then((v) => {
		try {
			history = v ? (JSON.parse(v) as string[]) : [];
		} catch {
			history = [];
		}
	});
	let commands: string[] = [];
	let commandsAsked = false;
	const dirCache = new Map<string, { at: number; list: FsEntry[] }>();
	let cwd: string | null = null;
	let inputStart: { x: number; y: number } | null = null;
	let promptOn = false;
	let items: Candidate[] = [];
	let sel = 0;
	let replace = 0;
	let timer: number | undefined;

	const ghostEl = document.createElement("div");
	ghostEl.className = "term-ghost";
	/** 목록에 그리는 최대 후보 수(그 안에서 스크롤·Tab 순환) */
	const MAX_POP = 200;
	const pop = document.createElement("div");
	pop.className = "term-pop";
	pop.hidden = true;
	host.append(ghostEl, pop);

	const metrics = () => {
		const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
		if (!screen) return null;
		const r = screen.getBoundingClientRect();
		const h = host.getBoundingClientRect();
		return { cw: r.width / term.cols, ch: r.height / term.rows, ox: r.left - h.left, oy: r.top - h.top };
	};

	const currentInput = (): string | null => {
		if (!promptOn || !inputStart) return null;
		const b = term.buffer.active;
		const y = b.cursorY + b.baseY;
		if (y !== inputStart.y) return null; // 여러 줄 입력은 다루지 않는다
		const line = b.getLine(y)?.translateToString(false) ?? "";
		return line.slice(inputStart.x, b.cursorX);
	};

	const atLineEnd = () => {
		const b = term.buffer.active;
		const line = b.getLine(b.cursorY + b.baseY)?.translateToString(true) ?? "";
		return b.cursorX >= line.length;
	};

	const listDirCached = (dir: string): FsEntry[] | null => {
		const c = dirCache.get(dir);
		if (c && Date.now() - c.at < 10_000) return c.list;
		return null;
	};

	const ctx = () => ({ commands, history, listDir: listDirCached, cwd, home: src.home ?? null });

	const hideGhost = () => {
		ghostEl.textContent = "";
	};
	const closePop = () => {
		pop.hidden = true;
		items = [];
	};

	const placeAtCursor = (el: HTMLElement, below: boolean) => {
		const m = metrics();
		if (!m) return;
		const b = term.buffer.active;
		el.style.left = `${m.ox + b.cursorX * m.cw}px`;
		el.style.top = `${m.oy + (b.cursorY + (below ? 1 : 0)) * m.ch}px`;
		el.style.lineHeight = `${m.ch}px`;
		el.style.fontSize = `${term.options.fontSize ?? 13}px`;
	};

	const renderGhost = () => {
		const line = currentInput();
		if (line === null || !pop.hidden || !atLineEnd()) return hideGhost();
		const g = ghost(line, history);
		ghostEl.textContent = g;
		if (g) placeAtCursor(ghostEl, false);
	};

	const renderPop = () => {
		if (!items.length) return closePop();
		pop.innerHTML = "";
		items.slice(0, MAX_POP).forEach((c, i) => {
			const row = document.createElement("div");
			row.className = `term-pop-item${i === sel ? " sel" : ""}`;
			const l = document.createElement("b");
			l.textContent = c.label;
			const d = document.createElement("span");
			d.textContent = c.desc ?? (c.kind === "path" ? "" : c.kind === "hist" ? "지난 명령" : "");
			row.append(l, d);
			row.onmousedown = (ev) => {
				ev.preventDefault();
				sel = i;
				accept();
			};
			pop.append(row);
		});
		const foot = document.createElement("div");
		foot.className = "term-pop-more";
		foot.textContent = `${Math.min(sel + 1, items.length)}/${items.length > MAX_POP ? `${MAX_POP}+` : items.length} · Tab 다음 · Enter 넣기 · Esc 닫기`;
		pop.append(foot);
		pop.hidden = false;
		// 커서 위·아래 중 넓은 쪽으로 열고, 그 높이 안에서 스크롤(칸 경계에 잘리지 않게)
		const m = metrics();
		const hr = host.getBoundingClientRect();
		if (m) {
			const b = term.buffer.active;
			const curTop = m.oy + b.cursorY * m.ch;
			const curBottom = curTop + m.ch;
			const below = hr.height - curBottom - 6;
			const above = curTop - 6;
			const down = below >= Math.min(pop.scrollHeight, 220) || below >= above;
			pop.style.maxHeight = `${Math.max(80, down ? below : above)}px`;
			pop.style.left = `${Math.max(0, Math.min(m.ox + b.cursorX * m.cw, hr.width - pop.offsetWidth - 4))}px`;
			pop.style.top = down ? `${curBottom + 2}px` : `${Math.max(2, curTop - 2 - pop.offsetHeight)}px`;
		}
		pop.querySelector<HTMLElement>(".term-pop-item.sel")?.scrollIntoView({ block: "nearest" });
		hideGhost();
	};

	const accept = () => {
		const c = items[sel];
		if (!c) return closePop();
		send("\x7f".repeat(replace) + c.insert);
		closePop();
	};

	const compute = async (open: boolean): Promise<boolean> => {
		const line = currentInput();
		if (line === null) return false;
		if (!commandsAsked) {
			commandsAsked = true;
			void src
				.commands()
				.then((c) => {
					commands = c;
				})
				.catch(() => {});
		}
		let r = complete(line, ctx());
		if (r.pending) {
			try {
				const list = await src.listDir(r.pending);
				dirCache.set(r.pending, { at: Date.now(), list });
			} catch {
				dirCache.set(r.pending, { at: Date.now(), list: [] });
			}
			r = complete(line, ctx());
		}
		if (!open && pop.hidden) return false;
		items = r.items;
		replace = r.replace;
		sel = 0;
		renderPop();
		return items.length > 0;
	};

	const schedule = () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (!pop.hidden) void compute(false);
			renderGhost();
		}, 60);
	};

	const remember = (cmd: string) => {
		const c = cmd.trim();
		if (!c || c.startsWith(" ")) return;
		history = [c, ...history.filter((h) => h !== c)].slice(0, 500);
		void api.settingSet(`hist.${src.key}`, JSON.stringify(history));
	};

	let lastLine = "";
	const onRender = term.onRender(() => {
		if (promptOn) {
			const l = currentInput();
			if (l !== null && l !== lastLine) {
				lastLine = l;
				schedule();
			}
		}
	});

	return {
		prompt: () => {
			promptOn = true;
			inputStart = null;
			lastLine = "";
			closePop();
			hideGhost();
		},
		submitted: () => {
			const l = currentInput();
			if (l) remember(l);
			promptOn = false;
			inputStart = null;
			closePop();
			hideGhost();
		},
		typed: () => {
			if (promptOn && !inputStart) {
				// 첫 입력 직전 커서 = 입력 시작(프롬프트 끝)
				const b = term.buffer.active;
				inputStart = { x: b.cursorX, y: b.cursorY + b.baseY };
			}
		},
		cwd: (p) => {
			cwd = p;
		},
		key: (e) => {
			if (e.type !== "keydown" || !promptOn) return true;
			if (!pop.hidden) {
				// 목록이 열려 있으면 Tab 은 셸처럼 다음 후보로(포커스가 다른 칸으로 넘어가지 않게 화면 쪽에서 기본 동작을 막는다)
				const n = Math.min(items.length, MAX_POP);
				if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
					const back = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
					sel = (sel + (back ? -1 : 1) + n) % n;
					renderPop();
					return false;
				}
				if (e.key === "Enter" || e.key === "ArrowRight") {
					accept();
					return false;
				}
				if (e.key === "Escape") {
					closePop();
					renderGhost();
					return false;
				}
				return true;
			}
			if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
				if (!inputStart) {
					const b = term.buffer.active;
					inputStart = { x: b.cursorX, y: b.cursorY + b.baseY };
				}
				void compute(true).then((has) => {
					if (!has) send("\t"); // 후보가 없으면 셸 완성으로
				});
				return false;
			}
			if (e.key === "ArrowRight" && !e.ctrlKey && ghostEl.textContent && atLineEnd()) {
				send(ghostEl.textContent);
				hideGhost();
				return false;
			}
			return true;
		},
		dispose: () => {
			window.clearTimeout(timer);
			onRender.dispose();
			ghostEl.remove();
			pop.remove();
		},
	};
}
