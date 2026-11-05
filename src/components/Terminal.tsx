import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IMarker, Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, Gauge, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, bytesChannel, type ShellHandle, type TermBackend } from "../lib/ipc";
import { attachCompletion, type Completer, type CompletionSource } from "../lib/termComplete";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { SnippetPalette } from "./SnippetPalette";
import { Select } from "./Select";

function themeFromCss() {
	const s = getComputedStyle(document.documentElement);
	const v = (n: string) => s.getPropertyValue(n).trim();
	return {
		background: v("--term-bg"),
		foreground: v("--term-fg"),
		cursor: v("--accent"),
		selectionBackground: "rgba(10,132,255,0.28)",
	};
}

type Stat = { label: string; ok?: boolean };
type Pending = { marker: IMarker; start: number; text: string };

/**
 * 터미널 칸 — 원격(SSH 채널)·내 PC(PTY) 공용. 출력은 바이너리 채널 → xterm.write.
 * 셸 통합(OSC 133 A·D, 7, 6974): 명령마다 ✓/✗·걸린 시간, 트리 따라가기, root 표시, 오래 걸린 명령 끝 알림.
 * 검색(Ctrl+Shift+F)·링크·글꼴(Ctrl+=/−/0)·복사/붙여넣기(Ctrl+Shift+C/V, 우클릭)·여러 줄 붙여넣기 확인·
 * 스크롤백 저장·인코딩(UTF-8/EUC-KR)·스니펫(Alt+P).
 */
/** 붙여넣기 전에 한 번 더 보게 할 명령 */
const DANGER = /(\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/?(\s|$|\*)|\brm\s+-[a-z]*r[a-z]*f|\bmkfs\b|\bdd\s+[^|]*of=\/dev\/|>\s*\/dev\/sd|\b(shutdown|reboot|poweroff|halt|init\s+0)\b|\bchmod\s+-R\s+777\s+\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bDROP\s+(DATABASE|TABLE)\b|\btruncate\s+table\b)/i;

/** 출력의 경로 — 절대 경로(/…, C:/…)와 뒤에 붙은 :줄 */
const PATH_RE = /(?:^|[\s'"(=:])((?:\/|[A-Za-z]:[\\/])[\w.@+~\-\\/]*[\w])(?::(\d+))?/g;

export function TerminalView({
	backend,
	active,
	cwd,
	label,
	showBench = false,
	toolbar = true,
	onShell,
	onCwd,
	onInput,
	completion,
	onOpenPath,
	defaultEncoding,
}: {
	backend: TermBackend;
	active: boolean;
	cwd?: string;
	label: string;
	showBench?: boolean;
	toolbar?: boolean;
	/** 바깥(트리 "터미널에서 이 폴더로" 등)에서 셸에 글을 넣을 수 있게 */
	onShell?: (h: ShellHandle | null) => void;
	/** 셸이 알려 준 지금 폴더(OSC 7) */
	onCwd?: (path: string) => void;
	/** 사람이 친 입력(동시 입력용) */
	onInput?: (data: string) => void;
	/** 자동완성(흐린 제안·Tab 목록) 출처 */
	completion?: CompletionSource;
	/** 출력의 경로를 Ctrl+누르면 편집기로 */
	onOpenPath?: (path: string) => void;
	/** 처음 인코딩(서버 로캘이 EUC-KR 이면) */
	defaultEncoding?: string;
}) {
	const completionRef = useRef(completion);
	completionRef.current = completion;
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const searchRef = useRef<SearchAddon | null>(null);
	const idRef = useRef<number | null>(null);
	const encRef = useRef("UTF-8");
	const decoderRef = useRef<TextDecoder | null>(null);
	const onShellRef = useRef(onShell);
	onShellRef.current = onShell;
	const onCwdRef = useRef(onCwd);
	onCwdRef.current = onCwd;
	const onInputRef = useRef(onInput);
	onInputRef.current = onInput;
	const waiters = useRef<{ re: RegExp; done: (ok: boolean) => void }[]>([]);
	const [stat, setStat] = useState<Stat>({ label: "여는 중…" });
	const [gen, setGen] = useState(0);
	const [benching, setBenching] = useState(false);
	const [encoding, setEncoding] = useState("UTF-8");
	const [root, setRoot] = useState(false);
	const [find, setFind] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [palette, setPalette] = useState(false);
	const [last, setLast] = useState<{ code: number; ms: number } | null>(null);
	/** 명령 기록(셸 통합) — 명령과 출력 복사·명령 사이 이동 */
	const cmds = useRef<{ start: IMarker; end?: IMarker; text: string; code?: number }[]>([]);
	const [findCount, setFindCount] = useState<{ i: number; n: number } | null>(null);
	const [here, setHere] = useState<string | null>(null);
	const exited = useRef(false);
	const reopenAt = useRef<string | undefined>(undefined);
	const onOpenPathRef = useRef(onOpenPath);
	onOpenPathRef.current = onOpenPath;
	const menuLine = useRef<number | null>(null);

	const write = (s: string) => {
		if (idRef.current != null) void backend.write(idRef.current, s, encRef.current);
	};

	const paste = (text: string) => {
		const t = termRef.current;
		if (!t || !text) return;
		const lines = text.replace(/\r\n/g, "\n").split("\n");
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		const bad = lines.filter((l) => DANGER.test(l));
		if (bad.length && !confirm(`⚠ 위험할 수 있는 명령이 있습니다:\n\n${bad.slice(0, 4).join("\n")}\n\n정말 붙여 넣을까요?`)) return;
		if (lines.length > 1 && !bad.length && !confirm(`${lines.length}줄을 붙여 넣습니다. 줄마다 실행될 수 있습니다. 계속할까요?\n\n${lines.slice(0, 6).join("\n")}${lines.length > 6 ? "\n…" : ""}`)) return;
		t.paste(text);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: gen 이 바뀌면 다시 연다
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const term = new XTerm({
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
			fontSize: 13,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 10000,
			allowProposedApi: true,
			overviewRuler: { width: 8 },
			theme: themeFromCss(),
		});
		const fit = new FitAddon();
		const search = new SearchAddon();
		term.loadAddon(fit);
		term.loadAddon(search);
		const onResults = search.onDidChangeResults((r) => setFindCount(r.resultCount ? { i: r.resultIndex + 1, n: r.resultCount } : { i: 0, n: 0 }));
		term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(el);
		const pathLinks = term.registerLinkProvider({
			provideLinks(y, cb) {
				if (!onOpenPathRef.current) return cb(undefined);
				const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
				const out: Parameters<typeof cb>[0] = [];
				for (const m of line.matchAll(PATH_RE)) {
					const p = m[1];
					if (p.length < 3 || /^\/\/|^\/(dev|proc)\b/.test(p)) continue;
					const x = (m.index ?? 0) + m[0].indexOf(p) + 1;
					out.push({
						range: { start: { x, y }, end: { x: x + p.length - 1, y } },
						text: p,
						decorations: { pointerCursor: true, underline: true },
						activate: (ev) => {
							if (ev.ctrlKey || ev.metaKey) onOpenPathRef.current?.(p.replace(/\\/g, "/"));
						},
					});
				}
				cb(out.length ? out : undefined);
			},
		});
		// 고르면 바로 복사(설정)
		let copyOnSelect = false;
		void api.settingGet("term.copyOnSelect").then((v) => {
			copyOnSelect = v === "1";
		});
		const onSel = term.onSelectionChange(() => {
			if (copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
		});
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// WebGL 이 안 되는 GPU 는 xterm 기본 렌더러로
		}
		void api.settingGet("term.scrollback").then((v) => {
			const n = Number(v);
			if (n >= 1000 && n <= 200000) term.options.scrollback = n;
		});
		void api.settingGet("term.fontSize").then((v) => {
			const n = Number(v);
			if (n >= 8 && n <= 32) {
				term.options.fontSize = n;
				fit.fit();
			}
		});
		fit.fit();
		termRef.current = term;
		fitRef.current = fit;
		searchRef.current = search;

		let disposed = false;
		const started = performance.now();
		const plain = new TextDecoder();
		let tail = "";
		const ch = bytesChannel((b) => {
			const dec = decoderRef.current;
			if (dec) term.write(dec.decode(b, { stream: true }));
			else term.write(b);
			if (waiters.current.length) {
				tail = (tail + plain.decode(b)).slice(-400);
				for (const w of waiters.current.slice()) {
					if (w.re.test(tail)) {
						waiters.current = waiters.current.filter((x) => x !== w);
						tail = "";
						w.done(true);
					}
				}
			}
		});

		// ── 자동완성 ──
		let completer: Completer | null = null;
		if (completionRef.current) completer = attachCompletion(term, el, completionRef.current, (s) => write(s));

		// ── 셸 통합 ──
		let atPrompt = false;
		let promptSeen = false;
		let typedAtPrompt = false;
		let pending: Pending | null = null;
		const osc133 = term.parser.registerOscHandler(133, (data) => {
			const [kind, arg] = data.split(";");
			if (kind === "A") {
				atPrompt = true;
				promptSeen = true;
				typedAtPrompt = false;
				completer?.prompt();
			}
			if (kind === "D" && pending) {
				const code = Number(arg ?? 0);
				const ms = Date.now() - pending.start;
				const p = pending;
				pending = null;
				setLast({ code, ms });
				const end = term.registerMarker(0);
				cmds.current.push({ start: p.marker, end: end ?? undefined, text: p.text, code });
				if (cmds.current.length > 2000) cmds.current.shift();
				term.registerDecoration({ marker: p.marker, overviewRulerOptions: { color: code === 0 ? "#30d158" : "#ff453a", position: "right" } });
				const text = `${code === 0 ? "✓" : `✗ ${code}`} ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}`;
				const deco = term.registerDecoration({ marker: p.marker, anchor: "right", x: 0, width: text.length + 1, layer: "top" });
				deco?.onRender((d) => {
					d.textContent = text;
					d.className = `cmd-mark ${code === 0 ? "ok" : "bad"}`;
					d.title = `${p.text}\n종료 코드 ${code} · ${ms} ms`;
				});
				if (ms > 10_000 && !document.hasFocus()) {
					sendNotification({ title: code === 0 ? "명령이 끝났습니다" : `명령이 실패했습니다(${code})`, body: `${p.text.slice(0, 80)} · ${(ms / 1000).toFixed(0)}초` });
				}
			}
			return true;
		});
		const osc7 = term.parser.registerOscHandler(7, (data) => {
			const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
			if (m) {
				let p = m[1];
				try {
					p = decodeURIComponent(m[1]);
				} catch {
					// 그대로
				}
				// Windows: file://localhost/C:/Users → C:/Users
				if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
				completer?.cwd(p);
				onCwdRef.current?.(p);
				setHere(p);
				reopenAt.current = p;
			}
			return true;
		});
		const osc6974 = term.parser.registerOscHandler(6974, (data) => {
			setRoot(data.trim() === "0");
			return true;
		});

		backend
			.open(term.cols, term.rows, ch, reopenAt.current ?? cwd)
			.then((id) => {
				if (disposed) {
					void backend.close(id);
					return;
				}
				idRef.current = id;
				onShellRef.current?.({
					idle: () => !promptSeen || (atPrompt && !typedAtPrompt),
					send: (s) => write(s),
					expect: (re, ms) =>
						new Promise<boolean>((res) => {
							const w = { re, done: res };
							waiters.current.push(w);
							window.setTimeout(() => {
								if (waiters.current.includes(w)) {
									waiters.current = waiters.current.filter((x) => x !== w);
									res(false);
								}
							}, ms);
						}),
				});
				setStat({ label: `${label} · ${Math.round(performance.now() - started)} ms에 열림`, ok: true });
			})
			.catch((e) => setStat({ label: `셸을 열지 못했습니다: ${typeof e === "object" ? (e as { message?: string }).message : String(e)}` }));

		const onData = term.onData((d) => {
			if (atPrompt && d !== "\r") typedAtPrompt = true;
			if (d === "\r") completer?.submitted();
			else if (d.length === 1 && d >= " ") completer?.typed();
			if (atPrompt && d.includes("\r")) {
				const buf = term.buffer.active;
				const line = buf.getLine(buf.cursorY + buf.baseY)?.translateToString(true) ?? "";
				const marker = term.registerMarker(0);
				if (marker) pending = { marker, start: Date.now(), text: line.trim() };
				atPrompt = false;
			}
			write(d);
			onInputRef.current?.(d);
		});
		const onResize = term.onResize(({ cols, rows }) => {
			if (idRef.current != null) void backend.resize(idRef.current, cols, rows);
		});
		term.attachCustomKeyEventHandler((e) => {
			if (completer && !completer.key(e)) {
				// xterm 이 처리하지 않은 키는 브라우저 기본 동작(Tab = 다음 칸으로 포커스)이 남는다 — 막는다
				e.preventDefault();
				e.stopPropagation();
				return false;
			}
			// 터미널 안에서 Tab·Shift+Tab 은 늘 셸 몫(포커스 이동 금지)
			if (e.key === "Tab") e.preventDefault();
			if (e.type !== "keydown") return true;
			if (exited.current && e.key === "Enter") {
				setGen((g) => g + 1);
				return false;
			}
			const mod = e.ctrlKey || e.metaKey;
			if (mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
				// 명령 사이 이동 — 보이는 맨 위 줄 기준 이전/다음 명령으로
				const top = term.buffer.active.viewportY;
				const lines = cmds.current.map((c) => c.start.line).filter((l) => l >= 0);
				const target = e.key === "ArrowUp" ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
				if (target != null) term.scrollToLine(target);
				else if (e.key === "ArrowDown") term.scrollToBottom();
				return false;
			}
			if (mod && e.shiftKey && e.code === "KeyC") {
				const s = term.getSelection();
				if (s) void navigator.clipboard.writeText(s);
				return false;
			}
			if (mod && e.shiftKey && e.code === "KeyV") {
				void navigator.clipboard.readText().then(paste);
				return false;
			}
			if (mod && e.shiftKey && e.code === "KeyF") {
				setFind((f) => (f === null ? term.getSelection() || "" : null));
				return false;
			}
			if (mod && !e.shiftKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
				const cur = term.options.fontSize ?? 13;
				const next = e.key === "0" ? 13 : Math.min(32, Math.max(8, cur + (e.key === "-" ? -1 : 1)));
				term.options.fontSize = next;
				fit.fit();
				void api.settingSet("term.fontSize", String(next));
				return false;
			}
			if (e.altKey && e.code === "KeyP") {
				setPalette(true);
				return false;
			}
			return true;
		});
		// 여러 줄 붙여넣기 확인 — xterm 이 받기 전에 가로챈다
		const ta = term.textarea;
		const onPaste = (ev: ClipboardEvent) => {
			const text = ev.clipboardData?.getData("text/plain") ?? "";
			if (text.replace(/\r?\n$/, "").includes("\n")) {
				ev.preventDefault();
				ev.stopImmediatePropagation();
				paste(text);
			}
		};
		ta?.addEventListener("paste", onPaste, true);

		const ro = new ResizeObserver(() => {
			if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
		});
		ro.observe(el);
		const unlisten = listen(backend.exitEvent, (e) => {
			if (idRef.current != null && backend.isMine(e.payload, idRef.current)) {
				idRef.current = null;
				exited.current = true;
				setStat({ label: "셸이 끝났습니다 — Enter 로 같은 폴더에서 다시 열기" });
			}
		});
		const mq = matchMedia("(prefers-color-scheme: dark)");
		const onScheme = () => {
			term.options.theme = themeFromCss();
		};
		mq.addEventListener("change", onScheme);

		return () => {
			disposed = true;
			completer?.dispose();
			ta?.removeEventListener("paste", onPaste, true);
			osc133.dispose();
			osc7.dispose();
			osc6974.dispose();
			pathLinks.dispose();
			onSel.dispose();
			onResults.dispose();
			cmds.current = [];
			exited.current = false;
			onShellRef.current?.(null);
			mq.removeEventListener("change", onScheme);
			void unlisten.then((f) => f());
			ro.disconnect();
			onData.dispose();
			onResize.dispose();
			if (idRef.current != null) void backend.close(idRef.current);
			idRef.current = null;
			term.dispose();
			termRef.current = null;
		};
	}, [gen, backend]);

	useEffect(() => {
		if (active) {
			requestAnimationFrame(() => {
				fitRef.current?.fit();
				termRef.current?.focus();
			});
		}
	}, [active]);

	const changeEncoding = (enc: string) => {
		encRef.current = enc;
		decoderRef.current = enc === "UTF-8" ? null : new TextDecoder("euc-kr");
		setEncoding(enc);
	};
	// 서버 로캘이 EUC-KR 이면 처음부터 그 인코딩으로(사용자가 바꾸면 그대로)
	const autoEnc = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 처음 한 번
	useEffect(() => {
		if (defaultEncoding && defaultEncoding !== "UTF-8" && !autoEnc.current && encRef.current === "UTF-8") {
			autoEnc.current = true;
			changeEncoding(defaultEncoding);
		}
	}, [defaultEncoding]);

	async function exportScrollback() {
		const t = termRef.current;
		if (!t) return;
		const buf = t.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
		while (lines.length && !lines.at(-1)) lines.pop();
		const path = await saveDialog({ defaultPath: `terminal-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}.txt`, filters: [{ name: "텍스트", extensions: ["txt", "log"] }] });
		if (!path) return;
		await invoke("local_write_text", { path, text: `${lines.join("\n")}\n`, meta: { encoding: "UTF-8", bom: false, eol: "LF", guessed: false }, expectMtime: null });
		setStat({ label: `스크롤백 ${lines.length}줄을 저장했습니다`, ok: true });
	}

	/** 24 MiB 를 화면에 쏘고 마지막 묶음이 그려질 때까지 잰다 */
	async function bench() {
		const term = termRef.current;
		if (!term || benching) return;
		setBenching(true);
		const bytes = 24 * 1024 * 1024;
		const t0 = performance.now();
		let lastWrite: Promise<void> = Promise.resolve();
		const ch = bytesChannel((b) => {
			lastWrite = new Promise((res) => term.write(b, res));
		});
		try {
			const r = await api.benchStream(bytes, ch);
			await lastWrite;
			const total = performance.now() - t0;
			setStat({ label: `벤치 24 MiB · ${(total / 1000).toFixed(2)}초 · 묶음 ${r.chunks}`, ok: total <= 3000 });
		} catch (e) {
			setStat({ label: `벤치 실패: ${String(e)}` });
		} finally {
			setBenching(false);
			term.write("\r\n");
		}
	}

	/** 우클릭한 줄이 든 명령 */
	const cmdAt = (line: number | null) => {
		if (line == null) return null;
		const list = cmds.current;
		for (let i = list.length - 1; i >= 0; i--) {
			const c = list[i];
			const end = c.end?.line ?? Number.MAX_SAFE_INTEGER;
			if (c.start.line >= 0 && line >= c.start.line && line <= end) return c;
		}
		return null;
	};
	const linesOf = (from: number, to: number) => {
		const b = termRef.current?.buffer.active;
		if (!b) return "";
		const out: string[] = [];
		for (let i = from; i <= to; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
		while (out.length && !out.at(-1)?.trim()) out.pop();
		return out.join("\n");
	};
	const hitCmd = cmdAt(menuLine.current);
	const menuItems: MenuItem[] = [
		...(hitCmd
			? ([
					{ label: `명령과 출력 복사 — ${hitCmd.text.slice(0, 30)}`, run: () => void navigator.clipboard.writeText(linesOf(hitCmd.start.line, (hitCmd.end?.line ?? hitCmd.start.line) - 1)) },
					{ label: "출력만 복사", run: () => void navigator.clipboard.writeText(linesOf(hitCmd.start.line + 1, (hitCmd.end?.line ?? hitCmd.start.line + 1) - 1)) },
					{ label: "명령만 복사", run: () => void navigator.clipboard.writeText(hitCmd.text.replace(/^.*?[$#>]\s/, "")) },
					{ sep: true },
				] as MenuItem[])
			: []),
		{ label: "복사  Ctrl+Shift+C", run: () => void navigator.clipboard.writeText(termRef.current?.getSelection() ?? ""), disabled: !termRef.current?.hasSelection() },
		{ label: "붙여넣기  Ctrl+Shift+V", run: () => void navigator.clipboard.readText().then(paste) },
		{ label: "모두 선택", run: () => termRef.current?.selectAll() },
		{ sep: true },
		{ label: "찾기  Ctrl+Shift+F", run: () => setFind("") },
		{ label: "스니펫  Alt+P", run: () => setPalette(true) },
		{ label: "화면 지우기", run: () => termRef.current?.clear() },
		{ label: "스크롤백 저장…", run: () => void exportScrollback() },
		{ sep: true },
		{ label: encoding === "UTF-8" ? "인코딩: EUC-KR 로" : "인코딩: UTF-8 로", run: () => changeEncoding(encoding === "UTF-8" ? "EUC-KR" : "UTF-8") },
		{ label: "셸 다시 열기", run: () => setGen((g) => g + 1) },
	];

	return (
		<>
			{toolbar && (
				<div className="toolbar">
					<span className="title">{label}</span>
					{showBench && (
						<button type="button" className="btn ghost" onClick={bench} disabled={benching} title="24 MiB 출력 벤치">
							<Gauge size={15} /> 출력 벤치
						</button>
					)}
					<button type="button" className="btn ghost icon" onClick={() => setGen((g) => g + 1)} title="셸 다시 열기">
						<RotateCcw size={15} />
					</button>
				</div>
			)}
			{find !== null && (
				<div className="term-find">
					<input
						autoFocus
						value={find}
						placeholder="찾기 — Enter 다음, Shift+Enter 이전"
						onChange={(e) => {
							setFind(e.target.value);
							searchRef.current?.findNext(e.target.value, {
								incremental: true,
								decorations: { matchOverviewRuler: "#ff9f0a", activeMatchColorOverviewRuler: "#0a84ff", matchBackground: "#ff9f0a55", activeMatchBackground: "#0a84ff88" },
							});
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								if (e.shiftKey) searchRef.current?.findPrevious(find);
								else searchRef.current?.findNext(find);
							}
							if (e.key === "Escape") {
								searchRef.current?.clearDecorations();
								setFind(null);
								termRef.current?.focus();
							}
						}}
					/>
					{findCount && find ? <span className="find-count">{findCount.n ? `${findCount.i}/${findCount.n}` : "없음"}</span> : null}
					<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findPrevious(find)} title="이전(Shift+Enter)">
						<ChevronUp size={14} />
					</button>
					<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findNext(find)} title="다음(Enter)">
						<ChevronDown size={14} />
					</button>
					<button
						type="button"
						className="btn ghost icon"
						onClick={() => {
							searchRef.current?.clearDecorations();
							setFind(null);
						}}
					>
						<X size={14} />
					</button>
				</div>
			)}
			<div
				className="term-host"
				ref={host}
				onClick={() => termRef.current?.focus()}
				onContextMenu={(e) => {
					e.preventDefault();
					const t = termRef.current;
					const screen = host.current?.querySelector(".xterm-screen")?.getBoundingClientRect();
					if (t && screen) menuLine.current = t.buffer.active.viewportY + Math.floor(((e.clientY - screen.top) / screen.height) * t.rows);
					setMenu({ x: e.clientX, y: e.clientY });
				}}
			/>
			<div className="statusbar">
				<span className={stat.ok ? "ok" : undefined}>{stat.label}</span>
				{last && (
					<span className={last.code === 0 ? "ok" : "err"}>
						{last.code === 0 ? "✓" : `✗ ${last.code}`} {last.ms < 1000 ? `${last.ms}ms` : `${(last.ms / 1000).toFixed(1)}초`}
					</span>
				)}
				{root && <span className="badge warn">root</span>}
				{here && (
					<button type="button" className="env-chip" title="지금 폴더 — 눌러 경로 복사" onClick={() => void navigator.clipboard.writeText(here)}>
						{here}
					</button>
				)}
				<span style={{ marginLeft: "auto" }} />
				<Select
					size="sm"
					value={encoding}
					onChange={changeEncoding}
					title="터미널 인코딩(EUC-KR 서버의 한글)"
					options={[
						{ value: "UTF-8", label: "UTF-8" },
						{ value: "EUC-KR", label: "EUC-KR" },
					]}
				/>
				{!toolbar && (
					<button type="button" className="btn ghost icon" style={{ height: 20, width: 20 }} onClick={() => setGen((g) => g + 1)} title="셸 다시 열기">
						<RotateCcw size={12} />
					</button>
				)}
			</div>
			{menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
			{palette && (
				<SnippetPalette
					onClose={() => {
						setPalette(false);
						termRef.current?.focus();
					}}
					onPick={(body, run) => {
						setPalette(false);
						write(run ? `${body}\r` : body);
						termRef.current?.focus();
					}}
					currentLine={() => {
						const t = termRef.current;
						if (!t) return "";
						const b = t.buffer.active;
						return (
							b
								.getLine(b.cursorY + b.baseY)
								?.translateToString(true)
								.replace(/^.*?[$#>]\s/, "") ?? ""
						);
					}}
				/>
			)}
		</>
	);
}
