/**
 * 터미널 IME(한글 등) 조합 보조.
 *
 * ① 조합 상태 — compositionstart~end 와, compositionend 뒤 xterm 이 확정 글자를 셸로 보내기 전(setTimeout 0)의 짧은 꼬리.
 *    Windows(Chromium)는 Enter·Tab·방향키가 조합을 끝내면 keydown(229) → compositionend → 그 키의 keydown 이 한 번 더 온다.
 *    꼬리 동안 앱이 키를 가로채면(흐린 제안 받기·Tab 목록·빈칸 이동) 확정 글자보다 앞서 셸로 가 순서가 뒤집힌다.
 *
 * ② WKWebView(macOS) 한글 — composition 이벤트 없이 첫 자모는 insertText, 조합 갱신(ㅎ→하→한)은 insertReplacementText 로만 온다.
 *    xterm 6.0 은 insertReplacementText 를 버려 셸에는 자모만 간다(xterm.js PR #5704 와 같은 진단). 그 두 입력을 조합처럼 모아
 *    다음 글자·조합 밖 키에서 한 번에 보낸다. 미리보기는 xterm 의 조합 표시(.composition-view)를 그대로 쓴다.
 */
import type { Terminal } from "@xterm/xterm";

/** 첫 글자가 한글(자모·호환 자모·확장 자모·음절)인지 */
const HANGUL = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/;
/** 조합을 끝내지 않는 키(Shift 로 된소리, Caps Lock·Ctrl·Alt·Meta 만 누름) */
const MOD_ONLY = new Set([16, 17, 18, 20, 91, 92, 93, 224]);

/** WKWebView — Tauri macOS 의 웹뷰(Chromium 계열이 아닌 WebKit). 리눅스 WebKitGTK 도 UA 가 AppleWebKit 이지만 IME 경로가 달라 맥만 */
export const IS_WEBKIT =
	/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent) && /Mac/.test(navigator.platform || navigator.userAgent);

export type TermIme = {
	/** 조합 중(compositionstart~end, WebKit 흉내 조합 포함) */
	composing: () => boolean;
	/** compositionend 뒤 확정 글자가 아직 셸로 가지 않음 */
	tail: () => boolean;
	/**
	 * 키 — 앱 키 처리기 맨 앞에서 부른다. true/false 면 그대로 돌려준다(xterm 이 처리/안 함), undefined 면 앱 처리를 이어 간다.
	 * WebKit 흉내 조합 중의 229 키는 xterm 에 넘기지 않는다(넘기면 textarea 차이를 자모로 한 번 더 보낸다).
	 */
	key: (e: KeyboardEvent) => boolean | undefined;
	dispose: () => void;
};

export function attachIme(o: {
	term: Terminal;
	host: HTMLElement;
	/** WKWebView 한글 흉내를 켤지 */
	webkit: boolean;
	/** 조합 시작·끝(자동완성·흐린 제안 쉬기) — 끝은 확정 글자가 셸로 간 뒤 */
	onComposing: (on: boolean) => void;
}): TermIme {
	const { term, host } = o;
	const ta = term.textarea;
	let composing = false;
	let tail = false;
	let tailTimer: number | undefined;
	// ── ① 조합 상태 — xterm 의 처리기가 먼저 달려 있다(term.open). 그 뒤에 달아 xterm 이 확정 글자를 보내는 setTimeout 보다 늦게 끝을 알린다 ──
	const onStart = () => {
		composing = true;
		tail = false;
		window.clearTimeout(tailTimer);
		o.onComposing(true);
	};
	const onEnd = () => {
		composing = false;
		tail = true;
		window.clearTimeout(tailTimer);
		tailTimer = window.setTimeout(() => {
			tail = false;
			// 한 음절이 끝나자마자 다음 음절 조합이 시작됐으면(한 → ㄱ) 계속 쉰다
			if (!composing) o.onComposing(false);
		}, 0);
	};
	ta?.addEventListener("compositionstart", onStart);
	ta?.addEventListener("compositionend", onEnd);

	// ── ② WKWebView 한글 흉내 ──
	let pending: string | null = null;
	const view = () => term.element?.querySelector(".composition-view") as HTMLElement | null;
	/** xterm 의 조합 표시와 같은 자리 — 커서 칸 위에 조합 글자, textarea 도 거기로(후보 창이 커서 옆에 뜨게) */
	const showPending = () => {
		const v = view();
		const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
		if (!v || !screen || pending == null) return;
		const b = term.buffer.active;
		const r = screen.getBoundingClientRect();
		const cw = r.width / term.cols;
		const ch = r.height / term.rows;
		const left = Math.min(b.cursorX, term.cols - 1) * cw;
		const top = b.cursorY * ch;
		v.textContent = pending;
		v.style.left = `${left}px`;
		v.style.top = `${top}px`;
		v.style.height = `${ch}px`;
		v.style.lineHeight = `${ch}px`;
		v.style.fontFamily = term.options.fontFamily ?? "";
		v.style.fontSize = `${term.options.fontSize ?? 13}px`;
		v.classList.toggle("active", pending !== "");
		if (ta) {
			ta.style.left = `${left}px`;
			ta.style.top = `${top}px`;
		}
	};
	const hidePending = () => {
		const v = view();
		if (!v) return;
		v.classList.remove("active");
		v.textContent = "";
	};
	const flush = () => {
		if (pending == null) return;
		const t = pending;
		pending = null;
		hidePending();
		// 확정 글자를 사람이 친 입력으로(onData → 셸 쓰기·동시 입력) — 쉬던 자동완성은 그 뒤에 깨운다
		if (t) term.input(t, true);
		o.onComposing(false);
	};
	/** 조상에서 capture — textarea 에 직접 단 xterm 의 input 처리기보다 먼저 받는다 */
	const onInput = (ev: Event) => {
		const e = ev as InputEvent;
		if (e.target !== ta || e.isComposing || composing) return; // 정상 조합(composition 이벤트가 오는 IME)은 xterm 몫
		if (e.inputType === "insertReplacementText" && e.data && (pending != null || HANGUL.test(e.data))) {
			if (pending == null) o.onComposing(true);
			pending = e.data;
			showPending();
			e.stopImmediatePropagation();
			return;
		}
		if (e.inputType === "insertText" && e.data && HANGUL.test(e.data)) {
			// 새 음절 — 앞 음절은 확정
			flush();
			pending = e.data;
			o.onComposing(true);
			showPending();
			e.stopImmediatePropagation();
			return;
		}
		if (e.inputType === "deleteContentBackward" && pending != null) {
			// 조합 중 글자를 지웠다(자모 하나 남은 걸 지움) — 보낼 것 없음
			pending = "";
			hidePending();
			e.stopImmediatePropagation();
			return;
		}
		// 한글이 아닌 글자(숫자·공백·문장 부호·영문) — 앞 음절을 먼저 보내고 그 글자를 잇는다
		if (e.inputType === "insertText" && pending != null) {
			flush();
			// 흉내 조합 중의 키는 229 로 와서 xterm 에 넘기지 않았다(key) — 그 keydown 이 '본' 상태라 xterm 은 composed 입력을 버린다
			// (CoreBrowserTerminal._inputEvent: !composed || !keyDownSeen 일 때만 보냄). 그 조건이면 여기서 보낸다(공백·문장 부호 유실 방지)
			if (e.data && e.composed) {
				term.input(e.data, true);
				e.stopImmediatePropagation();
			}
		}
	};
	/** 다른 칸으로 포커스가 가면 조합 중 음절을 확정해 보낸다(맥 IME 는 흉내 조합을 모른다 — 그대로 두면 음절이 사라진다) */
	const onBlur = () => flush();
	if (o.webkit) {
		host.addEventListener("input", onInput, true);
		ta?.addEventListener("blur", onBlur);
	}

	return {
		composing: () => composing || pending != null,
		tail: () => tail,
		key: (e) => {
			if (!o.webkit || pending == null || e.type !== "keydown") return undefined;
			if (e.keyCode === 229) return false;
			if (!MOD_ONLY.has(e.keyCode)) flush();
			return undefined;
		},
		dispose: () => {
			window.clearTimeout(tailTimer);
			ta?.removeEventListener("compositionstart", onStart);
			ta?.removeEventListener("compositionend", onEnd);
			host.removeEventListener("input", onInput, true);
			ta?.removeEventListener("blur", onBlur);
			pending = null;
		},
	};
}
