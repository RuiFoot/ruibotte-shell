/**
 * 터미널에 자동완성을 얹는다 — 흐린 제안(→ 받기, Ctrl+→ 한 낱말)과 목록(Ctrl+Space).
 * Tab(기본, 설정 "Tab 키 = 셸 완성"이면 Ctrl+Space 만): 후보 하나면 바로 넣기, 여럿이면 공통 앞부분까지 채우고 목록,
 * 폴더를 넣으면 그 안을 다시 보인다(연타로 파고들기 — 계산 중 온 Tab 은 쌓았다가 차례로). 치는 동안에는 목록을 띄우지 않고 흐린 제안(지난 명령)만.
 * "치다 멈추면 목록" 방식에서 저절로 뜬 목록은 ↑↓ 로 고른 뒤에만 Enter 가 넣기다(아니면 Enter 는 명령 실행).
 * 목록이 떠 있으면 Tab·Enter 는 넣기, ↑↓ 고르기, Esc 닫기. 방식(설정): 흐린 제안+목록 / 치다 멈추면 목록 / 목록만 / 끔.
 * 키 입력 경로를 막지 않도록 React 상태 없이 DOM 을 직접 그린다. 프롬프트(OSC 133 A) 뒤 입력에서만 켜진다.
 * 목록이 비면 Tab 은 원래대로 셸(bash 완성)에 넘긴다. 지난 명령은 서버별로 앱 DB 에 500개까지 — 친 폴더·셸 맥락과 함께.
 */
import type { Terminal } from "@xterm/xterm";
import { type Candidate, complete, ghost, HIST_MAX, type HistEntry, mergeHistory, pushHistory, readHistory } from "./complete";
import { loadDict } from "./dict";
import { api, type FsEntry } from "./ipc";

/** 목록을 저절로 띄우지 않는 짧은 인자 — . .. ../.. ~ ~/ - -- */
const SHORT_ARG = /^(\.{1,2}(\/\.{1,2})*\/?|~\/?|-{1,2})$/;

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
	/** 명령 실행(Enter) — 기록. typed: 친 키로 모은 줄(에코가 아직 화면에 오지 않았을 때 — 한글은 Enter 가 마지막 음절을 확정하며 함께 간다) */
	submitted: (typed?: string) => void;
	/** 사람이 입력함(프롬프트 상태에서) */
	typed: () => void;
	cwd: (p: string) => void;
	/** 셸 맥락(OSC 6976 host · docker:이름) — 기록·경로 목록을 맥락별로 */
	context: (c: string | undefined) => void;
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
	/**
	 * IME 조합 중(한글 등) — 목록·흐린 제안을 닫고 쉰다. 조합 글자는 아직 화면 버퍼에 없어 그 사이 계산한 제안은 한 글자 늦고,
	 * 받으면(→) 확정 글자보다 앞서 셸로 간다. 끝(off)은 확정 글자가 셸로 간 뒤 — 다시 그리기는 그 에코가 화면에 온 뒤(onRender)
	 */
	composing: (on: boolean) => void;
	/** Tab 으로 앱 목록 열기(설정 — 기본 끔: Tab 은 셸 완성) */
	setTabList: (on: boolean) => void;
	dispose: () => void;
};

/**
 * 서버(키)별 지난 명령 — 같은 서버 터미널 여러 개가 한 목록을 함께 쓴다(각자 들고 있다가 통째로 덮어쓰면 서로 지운다).
 * 저장 모양: [{ cmd, cwd?, ctx? }] — 옛 문자열 목록도 그대로 읽는다(어디서 쳤는지 모르는 기록)
 */
const histories = new Map<string, { list: HistEntry[]; add: (e: HistEntry) => void }>();
function sharedHistory(key: string) {
	let h = histories.get(key);
	if (h) return h;
	let loaded = false;
	let pending = false;
	const store = () => void api.settingSet(`hist.${key}`, JSON.stringify(h?.list ?? []));
	h = {
		list: [],
		add(e) {
			const self = h as { list: HistEntry[] };
			self.list = pushHistory(self.list, e);
			// 불러오기 전에 친 명령은 불러온 뒤 합친다(빈 목록으로 저장해 옛 기록을 지우지 않게)
			if (loaded) store();
			else pending = true;
		},
	};
	histories.set(key, h);
	void api.settingGet(`hist.${key}`).then((v) => {
		let old: HistEntry[] = [];
		try {
			old = v ? readHistory(JSON.parse(v)) : [];
		} catch {
			old = [];
		}
		const self = h as { list: HistEntry[] };
		self.list = mergeHistory(self.list, old, HIST_MAX);
		loaded = true;
		if (pending) store();
	});
	return h;
}

export function attachCompletion(term: Terminal, host: HTMLElement, src: CompletionSource, send: (s: string) => void, onPop?: (open: boolean) => void): Completer {
	void loadDict();
	const hist = sharedHistory(src.key);
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
	/** 셸 맥락(host · docker:이름) — 셸 훅이 알리기 전에는 undefined */
	let shellCtx: string | undefined;
	let inputStart: { x: number; y: number } | null = null;
	let promptOn = false;
	let items: Candidate[] = [];
	let sel = 0;
	let replace = 0;
	let timer: number | undefined;
	let held = false;
	/** IME 조합 중 */
	let ime = false;
	let tabList = true;
	/** Tab 계산 중(겹쳐 돌지 않게) — 그동안 온 Tab 은 버리지 않고 세어 두었다가 차례로 처리한다(연타로 파고들기) */
	let tabBusy = false;
	let tabQueued = 0;
	/** 입력이 멈춰 저절로 뜬 목록 — ↑↓ 로 고른 뒤에만 Enter 가 넣기(아니면 Enter 는 셸로, 명령 실행) */
	let autoOpen = false;
	let moved = false;

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
		// 칸 번호로 자른다 — 한글 같은 두 칸 글자가 앞에 있으면 문자열 위치와 칸 위치가 어긋난다
		if (b.cursorX < inputStart.x) return "";
		return b.getLine(y)?.translateToString(false, inputStart.x, b.cursorX) ?? "";
	};

	const atLineEnd = () => {
		const b = term.buffer.active;
		// 커서 뒤(칸 기준)에 글자가 없으면 줄 끝
		return (b.getLine(b.cursorY + b.baseY)?.translateToString(true, b.cursorX) ?? "").length === 0;
	};

	/** 폴더 목록 캐시 열쇠 — 맥락별(컨테이너 안 /root 와 서버 /root 는 다른 폴더). 맥락 이름에는 | 가 없다 */
	const dirKey = (dir: string) => `${shellCtx ?? ""}|${dir}`;
	const DIR_TTL = 10_000;
	const putDir = (dir: string, list: FsEntry[], key = dirKey(dir)) => {
		dirCache.delete(key);
		dirCache.set(key, { at: Date.now(), list });
		// 오래된 것부터 버린다(맵은 넣은 순서)
		if (dirCache.size > 300) dirCache.delete(dirCache.keys().next().value as string);
	};
	const listDirCached = (dir: string): FsEntry[] | null => {
		const c = dirCache.get(dirKey(dir));
		if (c && Date.now() - c.at < DIR_TTL) return c.list;
		return null;
	};
	/** 뒤에서 받는 중인 폴더(같은 폴더를 겹쳐 묻지 않게) */
	const fetching = new Set<string>();
	/** 캐시에 없는(또는 낡은) 폴더를 뒤에서 받는다 — 다 받으면 흐린 제안을 다시 그린다(줄이 그대로일 때만). 입력은 기다리지 않는다 */
	const want = (dir: string) => {
		const key = dirKey(dir);
		if (fetching.has(key) || fetching.size >= 4) return;
		fetching.add(key);
		const line = currentInput();
		void src
			.listDir(dir)
			.then(
				(list) => putDir(dir, list, key),
				() => putDir(dir, [], key),
			)
			.finally(() => {
				fetching.delete(key);
				if (line !== null && currentInput() === line && key === dirKey(dir)) renderGhost();
			});
	};
	/** 흐린 제안용 — 낡은 목록도 그대로 쓰고(깜박이지 않게) 뒤에서 새로 받는다 */
	const listDirStale = (dir: string): FsEntry[] | null => {
		const c = dirCache.get(dirKey(dir));
		if (!c) return null;
		if (Date.now() - c.at >= DIR_TTL) want(dir);
		return c.list;
	};

	const ctx = () => ({ commands, history: hist.list, listDir: listDirCached, want, cwd, home: src.home ?? null, units, containers, shellKind: src.shellKind ?? "linux", shellCtx });
	const ghostCtx = () => ({ history: hist.list, listDir: listDirStale, want, cwd, home: src.home ?? null, shellKind: src.shellKind ?? "linux", shellCtx });

	const hideGhost = () => {
		ghostEl.textContent = "";
	};
	const closePop = () => {
		const was = !pop.hidden;
		pop.hidden = true;
		items = [];
		autoOpen = false;
		moved = false;
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
		if (held || ime || line === null || !pop.hidden || !atLineEnd() || mode === "tab" || mode === "off") return hideGhost();
		// 치는 동안에는 목록을 띄우지 않는다 — 흐린 제안은 지난 명령·받아 둔 폴더 목록에서만(기다리지 않음), 목록은 Tab
		const g = ghost(line, ghostCtx());
		ghostEl.textContent = g;
		if (g) placeAtCursor(ghostEl, false);
	};

	const renderPop = () => {
		if (!items.length || held || ime) return closePop();
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

	/** 선택만 옮기기 — 목록 전체를 다시 그리지 않고 표시와 아래 줄 숫자만 바꾼다 */
	const moveSel = (next: number) => {
		const rows = pop.querySelectorAll<HTMLElement>(".term-pop-item");
		rows[sel]?.classList.remove("sel");
		sel = next;
		moved = true;
		const row = rows[sel];
		row?.classList.add("sel");
		row?.scrollIntoView({ block: "nearest" });
		const foot = pop.querySelector(".term-pop-more");
		if (foot) foot.textContent = `${Math.min(sel + 1, items.length)}/${items.length > MAX_POP ? `${MAX_POP}+` : items.length} · ↑↓ 고르기 · Tab·Enter 넣기 · Esc 닫기`;
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
			void compute(true).finally(() => {
				drilling = false;
				runQueuedTab();
			});
		}, 140);
	};
	/** 계산 중에 쌓인 Tab 하나를 처리 — 목록이 떠 있으면 넣기, 아니면 다시 Tab */
	const runQueuedTab = () => {
		if (!tabQueued || drilling || tabBusy) return;
		tabQueued--;
		if (!promptOn || held || ime) {
			tabQueued = 0;
			return;
		}
		if (!pop.hidden) {
			accept();
			if (!drilling) runQueuedTab();
		} else if (tabList) void tabOpen();
		else {
			send("\t");
			runQueuedTab();
		}
	};
	/** Tab(목록 닫힘): 하나면 바로, 여럿이면 공통 앞부분 채우고 목록 */
	const tabOpen = async () => {
		if (tabBusy) return; // 앞 Tab 이 아직 계산 중 — 겹쳐 돌리지 않는다
		tabBusy = true;
		let has = false;
		const before = currentInput();
		try {
			has = await compute(false, true);
		} finally {
			tabBusy = false;
		}
		try {
			// 계산하는 사이 줄이 바뀌었거나 조합이 시작됐으면 아무것도 하지 않는다(셸에 Tab 을 넘기지도 않는다)
			if (currentInput() !== before || ime) return;
			tabShow(has);
		} finally {
			runQueuedTab();
		}
	};
	const tabShow = (has: boolean) => {
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
		ensureLists(line);
		let r = complete(line, ctx());
		if (r.pending) {
			const key = dirKey(r.pending);
			try {
				putDir(r.pending, await src.listDir(r.pending), key);
			} catch {
				putDir(r.pending, [], key);
			}
			// 목록을 받아 오는 사이 사람이 더 쳤으면 이 결과는 버린다(지울 글자 수가 어긋나 엉뚱하게 고쳐 쓴다)
			if (currentInput() !== line) return false;
			r = complete(line, ctx());
		}
		if (!open && !quiet && pop.hidden) return false;
		items = r.items;
		replace = r.replace;
		query = line.slice(line.length - r.replace);
		sel = 0;
		moved = false;
		if (!quiet) renderPop();
		return items.length > 0;
	};
	/** 명령·유닛·컨테이너 이름은 처음 쓸 때 한 번 받아 둔다 */
	const ensureLists = (line: string) => {
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
				// 공백 뒤·3글자 미만 낱말에는 띄우지 않는다(치는 중에 목록이 깜박이지 않게)
				const token = l?.split(/\s+/).pop() ?? "";
				if (!l || !l.trim() || /\s$/.test(l) || token.length < 3 || SHORT_ARG.test(token) || !pop.hidden || !atLineEnd() || held || ime) return;
				void compute(true).then((has) => {
					if (has) autoOpen = true;
				});
			}, 350);
		}
	};

	const remember = (cmd: string) => {
		const c = cmd.trim();
		if (!c || c.startsWith(" ")) return;
		// 친 자리(폴더·셸) 와 함께 — cd 같은 경로 명령은 그 자리에서만 그대로 제안한다
		const e: HistEntry = { cmd: c };
		if (cwd) e.cwd = cwd;
		if (shellCtx) e.ctx = shellCtx;
		hist.add(e);
	};

	/**
	 * 프롬프트가 뜬 뒤 첫 키 전까지는 출력이 끝날 때마다 커서 = 입력 시작(프롬프트 끝).
	 * 첫 키부터는 고정 — ↑·Ctrl+R 로 불러온 줄도 프롬프트 끝부터 입력으로 본다(첫 글자 직전 커서로 잡으면 불러온 줄 끝이 시작이 된다)
	 */
	let keyed = false;
	const onParsed = term.onWriteParsed(() => {
		if (!promptOn || keyed) return;
		const b = term.buffer.active;
		inputStart = { x: b.cursorX, y: b.cursorY + b.baseY };
	});
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
			keyed = false;
			inputStart = null;
			tabQueued = 0;
			lastLine = "";
			closePop();
			hideGhost();
		},
		submitted: (typed) => {
			const l = currentInput();
			// 화면 줄이 친 줄의 앞부분일 때만 친 줄로(↑·Ctrl+R 로 불러온 줄은 화면 줄이 맞다)
			const c = typed && l != null && typed.length > l.length && typed.startsWith(l) ? typed : l;
			if (c) remember(c);
			promptOn = false;
			tabQueued = 0;
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
		context: (c) => {
			shellCtx = c;
		},
		key: (e) => {
			if (e.type === "keydown" && promptOn && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) keyed = true;
			if (e.type !== "keydown" || !promptOn || mode === "off" || held || ime) return true;
			const plainTab = e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
			// 파고드는 중·계산 중에 온 Tab 은 세어 두었다가 끝나면 차례로(버리지 않는다)
			if ((drilling || tabBusy) && plainTab) {
				tabQueued++;
				return false;
			}
			if (!pop.hidden) {
				const n = Math.min(items.length, MAX_POP);
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					moveSel((sel + (e.key === "ArrowUp" ? -1 : 1) + n) % n);
					return false;
				}
				if (e.key === "Tab" && e.shiftKey) {
					moveSel((sel - 1 + n) % n);
					return false;
				}
				if (e.key === "Enter" && autoOpen && !moved) {
					// 저절로 뜬 목록에서 고르지 않고 Enter — 목록만 닫고 명령은 그대로 실행
					closePop();
					return true;
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
			const openKey = (tabList && e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) || (e.ctrlKey && e.code === "Space");
			if (openKey) {
				if (!inputStart) {
					const b = term.buffer.active;
					inputStart = { x: b.cursorX, y: b.cursorY + b.baseY };
				}
				if (e.key === "Tab") void tabOpen();
				else void compute(true);
				return false;
			}
			if (e.key === "ArrowRight" && ghostEl.textContent && atLineEnd()) {
				// 그려 둔 제안은 60ms 늦을 수 있다 — 지금 줄로 다시 계산해 같을 때만 받는다(어긋나면 → 는 셸로)
				const now = ghost(currentInput() ?? "", ghostCtx());
				if (now !== ghostEl.textContent) {
					hideGhost();
					return true;
				}
				if (!e.ctrlKey) {
					send(now);
					hideGhost();
				} else {
					// 흐린 제안에서 한 낱말만
					const m = /^\s*\S+/.exec(now);
					if (m) send(m[0]);
				}
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
		composing: (on) => {
			if (ime === on) return;
			ime = on;
			if (on) {
				window.clearTimeout(timer);
				window.clearTimeout(autoTimer);
				tabQueued = 0;
				closePop();
				hideGhost();
			}
		},
		setTabList: (on) => {
			tabList = on;
		},
		dispose: () => {
			window.clearTimeout(timer);
			window.clearTimeout(autoTimer);
			onRender.dispose();
			onParsed.dispose();
			ghostEl.remove();
			pop.remove();
		},
	};
}
