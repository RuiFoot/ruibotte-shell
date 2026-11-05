/**
 * 터미널에 자동완성을 얹는다 — 흐린 제안(→ 로 받기)과 Tab 목록(↑↓·Tab/Enter·Esc).
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
		items.slice(0, 12).forEach((c, i) => {
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
		if (items.length > 12) {
			const more = document.createElement("div");
			more.className = "term-pop-more";
			more.textContent = `… ${items.length - 12}개 더 — 더 쳐서 좁히기`;
			pop.append(more);
		}
		pop.hidden = false;
		placeAtCursor(pop, true);
		// 화면 아래로 넘치면 위로
		const hr = host.getBoundingClientRect();
		const pr = pop.getBoundingClientRect();
		if (pr.bottom > hr.bottom) {
			const m = metrics();
			if (m) pop.style.top = `${m.oy + term.buffer.active.cursorY * m.ch - pr.height}px`;
		}
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
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + Math.min(items.length, 12)) % Math.min(items.length, 12);
					renderPop();
					return false;
				}
				if (e.key === "Tab" || e.key === "Enter") {
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
