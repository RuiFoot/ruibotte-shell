/**
 * 터미널에 자동완성을 얹는다 — 흐린 제안(→ 받기, Ctrl+→ 한 낱말)과 Tab 목록.
 * Tab(이전 판과 같은 규칙): 후보 하나면 바로 넣기, 여럿이면 공통 앞부분까지 채우고 목록, 목록에서 Tab·Enter 는 넣기, 폴더를 넣으면 그 안을 다시 보인다(연타로 파고들기).
 * ↑↓ 고르기, Esc 닫기, Ctrl+Space 열기. 방식(설정): 흐린 제안+Tab / 치다 멈추면 목록 / Tab 만 / 끔.
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
	/** 셸 종류 — linux(사전·스펙) · pwsh(cmdlet) · cmd(내장 명령) */
	shellKind?: "linux" | "pwsh" | "cmd";
	listDir: (dir: string) => Promise<FsEntry[]>;
	commands: () => Promise<string[]>;
	home?: string;
	/** systemd 유닛 이름(원격만) */
	units?: () => Promise<string[]>;
	/** 컨테이너 이름(원격만) */
	containers?: () => Promise<string[]>;
	/** 원격만: 읽기 전용 명령 하나 실행(명령 입력 보조의 후보·man) */
	exec?: (cmd: string) => Promise<string>;
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
	/** 지금 입력(프롬프트 끝부터 커서까지, 한 줄일 때만) — 프롬프트가 아니면 null */
	input: () => string | null;
	/** 입력 시작 칸(프롬프트 끝) — 모르면 null */
	inputStart: () => { x: number; y: number } | null;
	/** 지금 폴더(OSC 7) */
	cwdNow: () => string | null;
	/** 목록이 떠 있는지 */
	popOpen: () => boolean;
	/** 방식 — off 면 입력 보조도 쉰다 */
	mode: () => string;
	/** 잠깐 멈추기(빈칸 템플릿 동안 — 목록·흐린 제안·Tab 을 쓰지 않는다) */
	hold: (on: boolean) => void;
	dispose: () => void;
};

export function attachCompletion(term: Terminal, host: HTMLElement, src: CompletionSource, send: (s: string) => void, onPop?: (open: boolean) => void): Completer {
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
	let units: string[] = [];
	let containers: string[] = [];
	let unitsAsked = false;
	let containersAsked = false;
	/** 방식: ghost(흐린 제안+Tab) · auto(멈추면 목록) · tab(Tab 만) · off */
	let mode = "ghost";
	void api.settingGet("term.completeMode").then((v) => {
		if (v) mode = v;
	});
	let autoTimer: number | undefined;
	let drilling = false;
	const dirCache = new Map<string, { at: number; list: FsEntry[] }>();
	let cwd: string | null = null;
	let inputStart: { x: number; y: number } | null = null;
	let promptOn = false;
	let items: Candidate[] = [];
	let sel = 0;
	let replace = 0;
	let timer: number | undefined;
	let held = false;

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

	const ctx = () => ({ commands, history, listDir: listDirCached, cwd, home: src.home ?? null, units, containers, shellKind: src.shellKind ?? "linux" });

	const hideGhost = () => {
		ghostEl.textContent = "";
	};
	const closePop = () => {
		const was = !pop.hidden;
		pop.hidden = true;
		items = [];
		if (was) onPop?.(false);
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
		if (held || line === null || !pop.hidden || !atLineEnd() || mode === "tab" || mode === "off") return hideGhost();
		const g = ghost(line, history);
		ghostEl.textContent = g;
		if (g) placeAtCursor(ghostEl, false);
	};

	const renderPop = () => {
		if (!items.length || held) return closePop();
		const wasHidden = pop.hidden;
		pop.innerHTML = "";
		items.slice(0, MAX_POP).forEach((c, i) => {
			const row = document.createElement("div");
			row.className = `term-pop-item${i === sel ? " sel" : ""}`;
			const l = document.createElement("b");
			// 친 글자와 맞은 곳을 굵게(앞부분이면 그 길이만큼, 아니면 차례로)
			const q = query.toLowerCase();
			const low = c.label.toLowerCase();
			const hits = new Set<number>();
			if (q && low.startsWith(q)) for (let k = 0; k < q.length; k++) hits.add(k);
			else if (q) {
				let k = 0;
				for (let j = 0; j < low.length && k < q.length; j++) if (low[j] === q[k]) {
					hits.add(j);
					k++;
				}
			}
			for (let j = 0; j < c.label.length; j++) {
				const ch = document.createElement(hits.has(j) ? "mark" : "span");
				ch.textContent = c.label[j];
				l.append(ch);
			}
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
		foot.textContent = `${Math.min(sel + 1, items.length)}/${items.length > MAX_POP ? `${MAX_POP}+` : items.length} · ↑↓ 고르기 · Tab·Enter 넣기 · Esc 닫기`;
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
		if (wasHidden) onPop?.(true);
	};

	const accept = () => {
		const c = items[sel];
		if (!c) return closePop();
		send("\x7f".repeat(replace) + c.insert);
		closePop();
		if (c.dir) drill();
	};
	/** 폴더를 넣었으면 셸이 받아 그린 뒤 그 안을 다시 보인다 */
	const drill = () => {
		drilling = true;
		window.setTimeout(() => {
			drilling = false;
			void compute(true);
		}, 140);
	};
	/** Tab(목록 닫힘): 하나면 바로, 여럿이면 공통 앞부분 채우고 목록 */
	const tabOpen = async () => {
		const has = await compute(false, true);
		if (!has) {
			send("\t"); // 후보가 없으면 셸 완성으로
			return;
		}
		const real = items.filter((x) => x.kind !== "hist");
		if (real.length === 1 && items.length === 1) {
			sel = 0;
			accept();
			return;
		}
		const ins = real.map((x) => x.insert.replace(/[ /]$/, ""));
		let p = ins[0] ?? "";
		for (const s of ins) while (p && !s.startsWith(p)) p = p.slice(0, -1);
		if (p.length > query.length && p.toLowerCase().startsWith(query.toLowerCase())) {
			send("\x7f".repeat(replace) + p);
			replace = p.length;
			query = p;
		}
		renderPop();
	};

	let query = "";
	const compute = async (open: boolean, quiet = false): Promise<boolean> => {
		const line = currentInput();
		if (line === null) return false;
		const first = line.trimStart().split(/\s+/)[0] ?? "";
		if (!unitsAsked && src.units && /^(systemctl|journalctl|service)$/.test(first)) {
			unitsAsked = true;
			void src.units().then((u) => {
				units = u;
			}).catch(() => {});
		}
		if (!containersAsked && src.containers && /^(docker|podman)$/.test(first)) {
			containersAsked = true;
			void src.containers().then((c) => {
				containers = c;
			}).catch(() => {});
		}
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
		if (!open && !quiet && pop.hidden) return false;
		items = r.items;
		replace = r.replace;
		query = line.slice(line.length - r.replace);
		sel = 0;
		if (!quiet) renderPop();
		return items.length > 0;
	};

	const schedule = () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (!pop.hidden) void compute(false);
			renderGhost();
		}, 60);
		if (mode === "auto") {
			window.clearTimeout(autoTimer);
			autoTimer = window.setTimeout(() => {
				const l = currentInput();
				if (l && l.trim() && pop.hidden && atLineEnd()) void compute(true);
			}, 350);
		}
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
			if (e.type !== "keydown" || !promptOn || mode === "off" || held) return true;
			if (drilling && e.key === "Tab") return false; // 파고드는 중에 온 Tab 은 삼킨다
			if (!pop.hidden) {
				const n = Math.min(items.length, MAX_POP);
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					sel = (sel + (e.key === "ArrowUp" ? -1 : 1) + n) % n;
					renderPop();
					return false;
				}
				if (e.key === "Tab" && e.shiftKey) {
					sel = (sel - 1 + n) % n;
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
			const openKey = (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) || (e.ctrlKey && e.code === "Space");
			if (openKey) {
				if (!inputStart) {
					const b = term.buffer.active;
					inputStart = { x: b.cursorX, y: b.cursorY + b.baseY };
				}
				if (e.key === "Tab") void tabOpen();
				else void compute(true);
				return false;
			}
			if (e.key === "ArrowRight" && !e.ctrlKey && ghostEl.textContent && atLineEnd()) {
				send(ghostEl.textContent);
				hideGhost();
				return false;
			}
			if (e.key === "ArrowRight" && e.ctrlKey && ghostEl.textContent && atLineEnd()) {
				// 흐린 제안에서 한 낱말만
				const m = /^\s*\S+/.exec(ghostEl.textContent);
				if (m) send(m[0]);
				return false;
			}
			return true;
		},
		input: currentInput,
		inputStart: () => (promptOn ? inputStart : null),
		cwdNow: () => cwd,
		popOpen: () => !pop.hidden,
		mode: () => mode,
		hold: (on) => {
			held = on;
			if (on) {
				window.clearTimeout(autoTimer);
				closePop();
				hideGhost();
			}
		},
		dispose: () => {
			window.clearTimeout(timer);
			window.clearTimeout(autoTimer);
			onRender.dispose();
			ghostEl.remove();
			pop.remove();
		},
	};
}
