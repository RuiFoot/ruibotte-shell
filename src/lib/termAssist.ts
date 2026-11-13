/**
 * 터미널 명령 입력 보조(D25) — ① 빈칸 Tab 템플릿 ② 입력 줄 위 서명 힌트. 리눅스 셸(원격 SSH·bash·zsh·Git Bash·WSL)에서만 붙인다.
 * 키 입력 경로는 막지 않는다: 서명은 입력이 110ms 멈춘 뒤 줄 하나를 한 번 나눠(lex) 계산하고, 자동완성 목록이 떠 있으면 숨긴다.
 * 흐린 제안은 입력 줄 안, 서명은 입력 줄 바로 위 한 줄(맨 윗줄이면 아래)이라 겹치지 않는다. React 상태 없이 DOM 을 직접 그린다.
 * 빈칸 이동은 셸에 ←/→ 를 보내고, 빈칸에 처음 친 글자는 기본값 길이만큼 백스페이스를 보낸 뒤 들어간다(셸 설정은 바꾸지 않는다 — 웹과 같음).
 */
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import {
	ensureDict,
	type Exec,
	knownCmd,
	optLookup,
	parseTemplate,
	type SigView,
	signatureAt,
	subsOf,
	type TplField,
} from "./cmdAssist";
import type { Completer } from "./termComplete";

export type TermAssist = {
	/** {{빈칸}} 템플릿을 입력 줄에 넣고 첫 빈칸으로 */
	template: (raw: string) => void;
	/** 빈칸 모드 입력 — 처리했으면 true(셸로 보내기까지 끝) */
	data: (d: string) => boolean;
	/** 키 — false 면 여기서 처리함(xterm·자동완성으로 보내지 않는다) */
	key: (e: KeyboardEvent) => boolean;
	/** 빈칸 템플릿 중인지 */
	templating: () => boolean;
	/** 풀이할 글자 — 고른 글자, 없으면 지금 입력 줄 */
	explainText: () => string;
	/** 출력 바이트(큰 출력 중엔 계산하지 않는다) */
	output: (n: number) => void;
	/** 프롬프트 시작·명령 실행 */
	reset: () => void;
	/** 자동완성 목록이 열리고 닫힐 때 */
	popChanged: (open: boolean) => void;
	/** 서명 줄 켜기·끄기(설정 — 기본 끔) */
	setSig: (on: boolean) => void;
	dispose: () => void;
};

const SIG_DELAY = 110;
const cells = (s: string) => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0);

export function attachAssist(o: {
	term: Terminal;
	host: HTMLElement;
	completer: Completer;
	/** 셸로 보내기(동시 입력 포함) */
	emit: (s: string) => void;
	exec?: Exec;
	/** Ctrl+Shift+E — 조각 풀이 열기 */
	onExplain: () => void;
	/** 풀이가 떠 있으면 Esc 로 닫기 */
	explainOpen: () => boolean;
	closeExplain: () => void;
}): TermAssist {
	const { term, host, completer, emit } = o;
	const bar = document.createElement("div");
	bar.className = "ax-bar";
	bar.hidden = true;
	host.append(bar);
	void ensureDict();

	const metrics = () => {
		const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
		if (!screen) return null;
		const r = screen.getBoundingClientRect();
		const h = host.getBoundingClientRect();
		return { cw: r.width / term.cols, ch: r.height / term.rows, ox: r.left - h.left, oy: r.top - h.top, hw: h.width };
	};
	const hide = () => {
		if (!bar.hidden) bar.hidden = true;
	};
	/** 보조 줄 자리 — 입력 줄 바로 위 한 줄(맨 윗줄이면 아래), 입력 시작 칸에 맞춘다 */
	const place = (x: number) => {
		const m = metrics();
		if (!m) return false;
		const cy = term.buffer.active.cursorY;
		const left = Math.max(0, m.ox + x * m.cw);
		bar.style.left = `${left}px`;
		bar.style.top = `${m.oy + (cy > 0 ? cy - 1 : cy + 1) * m.ch}px`;
		bar.style.height = `${m.ch}px`;
		bar.style.lineHeight = `${m.ch}px`;
		bar.style.maxWidth = `${Math.max(120, m.hw - left - 8)}px`;
		return true;
	};
	const span = (cls: string, text: string) => {
		const s = document.createElement("span");
		s.className = cls;
		s.textContent = text;
		return s;
	};

	// ── ② 서명(기본 끔 — 입력 줄 바로 위 = 직전 출력 마지막 줄을 가린다) ──
	let sigOn = false;
	let sigTimer = 0;
	let burst = 0;
	let burstAt = 0;
	let lastKey = "";
	const drawSig = (view: SigView, x: number) => {
		const key = `${view.parts.map((p) => (p.active ? `*${p.text}` : p.text)).join(" ")}|${view.label}|${view.desc}|${x}`;
		if (key === lastKey && !bar.hidden) return;
		lastKey = key;
		bar.replaceChildren();
		bar.className = "ax-bar";
		view.parts.forEach((p, i) => {
			if (i) bar.append(" ");
			bar.append(span(p.active ? "ax-on" : i === 0 ? "ax-cmd" : "ax-arg", p.text));
		});
		if (view.label || view.desc) {
			bar.append(span("ax-sep", " — "));
			const act = view.parts.find((p) => p.active)?.text.replace(/^\[|\]$|…/g, "");
			if (view.label && view.label !== act) bar.append(span("ax-label", view.desc ? `${view.label} ` : view.label));
			if (view.desc) bar.append(span("ax-desc", view.desc));
		}
		if (place(x)) bar.hidden = false;
	};
	const updateSig = () => {
		sigTimer = 0;
		if (tpl) return;
		if (!sigOn) return hide();
		const buf = term.buffer.active;
		// 큰 출력이 흐르는 중이면 나중에
		if (performance.now() - burstAt < 150 && burst > 8192) {
			schedule();
			return;
		}
		const start = completer.inputStart();
		const input =
			completer.mode() !== "off" && start && buf.type === "normal" && buf.viewportY === buf.baseY && !completer.popOpen()
				? completer.input()
				: null;
		if (!input?.trim() || !start) return hide();
		const view = signatureAt(input, optLookup, subsOf, knownCmd);
		if (!view) return hide();
		// 서버 man 은 여기서 받지 않는다(입력 중 같은 연결로 큰 출력이 흐르면 에코가 밀린다) — 조각 풀이를 열 때만
		drawSig(view, start.x);
	};
	const schedule = () => {
		window.clearTimeout(sigTimer);
		sigTimer = window.setTimeout(updateSig, SIG_DELAY);
	};
	const onCursor = term.onCursorMove(() => {
		if (tpl || !sigOn) return;
		// 프롬프트가 아니면(명령이 도는 중) 계산 안 함 — 줄을 읽지 않고 바로 끝
		if (!completer.inputStart()) {
			if (!bar.hidden) hide();
			return;
		}
		schedule();
	});
	const onScroll = term.onScroll(() => {
		if (!tpl) hide();
	});
	const onResize = term.onResize(() => {
		hide();
		if (tpl) endTemplate();
		else if (sigOn) schedule();
	});

	// ── ① 빈칸 템플릿 ──
	type Tpl = { chars: string[]; fields: TplField[]; cur: number; caret: number; fresh: boolean; x0: number; y: number; deco: IDecoration | null; marker: IMarker | null };
	let tpl: Tpl | null = null;
	const absY = () => term.buffer.active.cursorY + term.buffer.active.baseY;
	const undraw = (s: Tpl) => {
		s.deco?.dispose();
		s.marker?.dispose();
		s.deco = null;
		s.marker = null;
	};
	const endTemplate = () => {
		const s = tpl;
		if (!s) return;
		undraw(s);
		tpl = null;
		completer.hold(false);
		hide();
		lastKey = "";
		schedule();
	};
	const drawTemplate = () => {
		const s = tpl;
		if (!s) return;
		undraw(s);
		const f = s.fields[s.cur];
		if (!f) return;
		const x = s.x0 + cells(s.chars.slice(0, f.start).join(""));
		const w = Math.max(1, cells(s.chars.slice(f.start, f.start + f.len).join("")));
		if (s.y === absY() && x + w <= term.cols) {
			const marker = term.registerMarker(0);
			const deco = marker ? term.registerDecoration({ marker, x, width: w }) : undefined;
			if (deco) {
				const fresh = s.fresh;
				deco.onRender((d) => {
					d.classList.add("ax-slot");
					d.classList.toggle("fresh", fresh);
				});
				s.deco = deco;
			}
			s.marker = marker ?? null;
		}
		lastKey = "";
		bar.replaceChildren(
			span("ax-step", `빈칸 ${s.cur + 1}/${s.fields.length}`),
			" ",
			span("ax-on", f.name),
			...(f.d ? [span("ax-sep", " — "), span("ax-desc", f.d)] : []),
			span("ax-keys", `  ${s.fresh ? "치면 바뀜 · " : ""}${s.cur + 1 < s.fields.length ? "Tab 다음" : "Tab 끝"}${s.cur > 0 ? " · Shift+Tab 이전" : ""} · Esc 끝`),
		);
		bar.className = "ax-bar tpl";
		if (place(s.x0)) bar.hidden = false;
	};
	const moveCaret = (to: number) => {
		const s = tpl;
		if (!s) return;
		const delta = to - s.caret;
		if (delta) emit((delta > 0 ? "\x1b[C" : "\x1b[D").repeat(Math.abs(delta)));
		s.caret = to;
	};
	const gotoField = (i: number) => {
		const s = tpl;
		const f = s?.fields[i];
		if (!s || !f) return;
		moveCaret(f.start + f.len);
		s.cur = i;
		s.fresh = f.len > 0;
		drawTemplate();
	};
	const shiftAfter = (s: Tpl, from: number, by: number) => {
		for (let k = from + 1; k < s.fields.length; k++) (s.fields[k] as TplField).start += by;
	};
	const data = (d: string): boolean => {
		const s = tpl;
		const f = s?.fields[s.cur];
		if (!s || !f) return false;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자 판별
		const printable = !/[\x00-\x1f\x7f]/.test(d);
		if (printable || d === "\x7f") {
			if (s.fresh) {
				emit("\x7f".repeat(f.len));
				s.chars.splice(f.start, f.len);
				shiftAfter(s, s.cur, -f.len);
				s.caret = f.start;
				f.len = 0;
				s.fresh = false;
				if (d === "\x7f") {
					drawTemplate();
					return true;
				}
			} else if (d === "\x7f") {
				if (s.caret <= f.start) {
					endTemplate();
					return false;
				}
				emit("\x7f");
				s.chars.splice(s.caret - 1, 1);
				s.caret--;
				f.len--;
				shiftAfter(s, s.cur, -1);
				drawTemplate();
				return true;
			}
			const add = [...d];
			emit(d);
			s.chars.splice(s.caret, 0, ...add);
			s.caret += add.length;
			f.len += add.length;
			shiftAfter(s, s.cur, add.length);
			drawTemplate();
			return true;
		}
		// Enter·Esc·화살표·Ctrl 키 같은 다른 편집 키 — 일반 입력으로
		endTemplate();
		return false;
	};
	const template = (raw: string) => {
		endTemplate();
		const { text, fields } = parseTemplate(raw);
		// 프롬프트를 알 때만 빈칸 모드(셸 통합) — 아니면 기본값으로 채워 넣기만
		const buf = term.buffer.active;
		const x0 = buf.cursorX;
		const y = absY();
		term.input(text);
		if (!fields.length || !completer.inputStart()) return;
		completer.hold(true);
		tpl = { chars: [...text], fields, cur: -1, caret: [...text].length, fresh: false, x0, y, deco: null, marker: null };
		gotoField(0);
	};

	const key = (e: KeyboardEvent): boolean => {
		if (e.type !== "keydown") return true;
		// ④ 조각 풀이 — Ctrl+Shift+E(터미널로 보내지 않는다), 떠 있으면 Esc 로 닫기
		if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyE") {
			o.onExplain();
			return false;
		}
		if (e.key === "Escape" && o.explainOpen()) {
			o.closeExplain();
			return false;
		}
		// ① 빈칸 — Tab 다음, Shift+Tab 이전, 마지막에서 Tab·Esc 는 일반 입력으로, Enter 는 끝내고 그대로 실행
		if (tpl && !e.ctrlKey && !e.altKey && !e.metaKey) {
			if (e.key === "Tab") {
				const next = tpl.cur + (e.shiftKey ? -1 : 1);
				if (next >= tpl.fields.length) {
					moveCaret(tpl.chars.length);
					endTemplate();
				} else gotoField(Math.max(0, next));
				return false;
			}
			if (e.key === "Escape") {
				endTemplate();
				return false;
			}
			if (e.key === "Enter") endTemplate();
		}
		return true;
	};

	const explainText = () => {
		const sel = term.getSelection().trim();
		if (sel) return sel;
		const start = completer.inputStart();
		if (!start) return "";
		const buf = term.buffer.active;
		let text = buf.getLine(start.y)?.translateToString(true, start.x) ?? "";
		for (let row = start.y + 1; buf.getLine(row)?.isWrapped; row++) text += buf.getLine(row)?.translateToString(true) ?? "";
		return text.trim();
	};

	return {
		template,
		data,
		key,
		templating: () => tpl != null,
		explainText,
		output: (n) => {
			const now = performance.now();
			if (now - burstAt > 150) burst = 0;
			burst += n;
			burstAt = now;
		},
		reset: () => {
			if (tpl) endTemplate();
			window.clearTimeout(sigTimer);
			lastKey = "";
			hide();
		},
		popChanged: (open) => {
			if (open) hide();
			else if (!tpl && sigOn) schedule();
		},
		setSig: (on) => {
			sigOn = on;
			lastKey = "";
			if (!on && !tpl) {
				window.clearTimeout(sigTimer);
				hide();
			}
		},
		dispose: () => {
			window.clearTimeout(sigTimer);
			if (tpl) undraw(tpl);
			tpl = null;
			onCursor.dispose();
			onScroll.dispose();
			onResize.dispose();
			bar.remove();
		},
	};
}
