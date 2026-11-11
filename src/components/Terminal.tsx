import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, bytesChannel, type ShellHandle, type TermBackend } from "../lib/ipc";
import { attachCompletion, type Completer, type CompletionSource } from "../lib/termComplete";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { SnippetPalette } from "./SnippetPalette";
import { DANGER, setActiveTerminal } from "../lib/activeTerm";
import { revealLogDir, SessionRecorder } from "../lib/sessionLog";
import { attachHighlighter } from "../lib/termHighlight";
import { loadTermPrefs, TERM_PREFS_EVENT } from "../lib/termPrefs";
import { getAppearance, onAppearance, termFontFamily, termTheme } from "../lib/theme";
import { createZmodem, type ZmodemBridge, type ZmProgress } from "../lib/zmodemTerm";
import { Select } from "./Select";
import { AssistFormSheet, ExplainCard } from "./CmdAssist";
import { candidatesFor, cmdDesc, ensureDict, type ExplainPart, explainLine, fillTemplate, hasTemplateFields, optLookup, requestMan, subDesc } from "../lib/cmdAssist";
import { attachAssist, type TermAssist } from "../lib/termAssist";

type Stat = { label: string; ok?: boolean };
type Pending = { marker: IMarker; start: number; text: string };

/**
 * 터미널 칸 — 원격(SSH 채널)·내 PC(PTY) 공용. 출력은 바이너리 채널 → xterm.write.
 * 셸 통합(OSC 133 A·D, 7, 6974): 명령마다 ✓/✗·걸린 시간, 트리 따라가기, root 표시, 오래 걸린 명령 끝 알림.
 * 검색(Ctrl+Shift+F)·링크·글꼴(Ctrl+=/−/0)·복사/붙여넣기(Ctrl+Shift+C/V, 우클릭)·여러 줄 붙여넣기 확인·
 * 스크롤백 저장·인코딩(UTF-8/EUC-KR)·스니펫(Alt+P).
 * 명령 입력 보조(D25, 리눅스 셸만): 입력 줄 위 서명 힌트·{{빈칸}} Tab 템플릿·명령 만들기 폼·Ctrl+Shift+E 조각 풀이.
 */

/** 바이트 → x-user-defined 글(0x80~0xFF 는 U+F780~) — 원격이 그 인코딩으로 바이트 그대로 되돌려 보낸다(ZMODEM 바이너리) */
function bytesAsUserDefined(b: Uint8Array) {
	let out = "";
	for (let i = 0; i < b.length; i += 8192) {
		const part = b.subarray(i, i + 8192);
		const u = new Uint16Array(part.length);
		for (let j = 0; j < part.length; j++) u[j] = part[j] < 0x80 ? part[j] : 0xf700 + part[j];
		out += String.fromCharCode(...u);
	}
	return out;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

/** rz/sz 를 쳤는데 서버에 없을 때 나오는 말 */
const NO_LRZSZ = /(?:^|[\s:])[rs]z: (?:command )?not found|command not found: [rs]z\b|Command '[rs]z' not found|[rs]z: 명령어를 찾을 수 없음/;

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
	shell,
	shellOptions,
	onShellChange,
	onSplit,
	onRootShell,
	statusExtra,
	onRecording,
	logName,
	profileId,
	assist = false,
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
	/** 자동완성(흐린 제안·Ctrl+Space 목록) 출처 */
	completion?: CompletionSource;
	/** 출력의 경로를 Ctrl+누르면 편집기로 */
	onOpenPath?: (path: string) => void;
	/** 처음 인코딩(서버 로캘이 EUC-KR 이면) */
	defaultEncoding?: string;
	/** 내 PC 셸 id(없으면 기본) */
	shell?: string;
	/** 고를 수 있는 셸(내 PC) — 있으면 상태 줄에 고르기 */
	shellOptions?: { value: string; label: string; hint?: string }[];
	onShellChange?: (id: string) => void;
	/** 우클릭 › 오른쪽·아래로 나누기(작업대가 옆에 새 터미널 칸) */
	onSplit?: (dir: "right" | "below") => void;
	/** 원격: 우클릭 › root 셸로(sudo -i)·나오기 */
	onRootShell?: (on: boolean) => void;
	/** 상태 줄 오른쪽에 덧붙일 것(원격: 작은 자원 표시) */
	statusExtra?: ReactNode;
	/** 세션 기록을 켜고 끌 때(탭에 ● 표시) */
	onRecording?: (on: boolean) => void;
	/** 기록 폴더 이름(서버 이름) — 없으면 label */
	logName?: string;
	/** 원격: 이 서버 번호 — 서버별 터미널 색 덮어쓰기(설정 › 화면, 서버 설정) */
	profileId?: number;
	/** 명령 입력 보조(D25) — 리눅스 셸(원격 SSH·bash·zsh·Git Bash·WSL)에서만 켠다. PowerShell·cmd 는 끔 */
	assist?: boolean;
}) {
	const profileIdRef = useRef(profileId);
	profileIdRef.current = profileId;
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
	/** 입력 지연(키 → 첫 출력) p50/p95 — 1초마다 한 번만 상태로 올린다 */
	const [lag, setLag] = useState<{ p50: number; p95: number; n: number } | null>(null);
	/** 글꼴 크기(설정한 크기가 아니면 상태 줄에) */
	const [fontPx, setFontPx] = useState(() => getAppearance().termSize);
	/** 명령 기록(셸 통합) — 명령과 출력 복사·명령 사이 이동 */
	const cmds = useRef<{ start: IMarker; end?: IMarker; text: string; code?: number }[]>([]);
	const [findCount, setFindCount] = useState<{ i: number; n: number } | null>(null);
	const [here, setHere] = useState<string | null>(null);
	const exited = useRef(false);
	const reopenAt = useRef<string | undefined>(undefined);
	const onOpenPathRef = useRef(onOpenPath);
	onOpenPathRef.current = onOpenPath;
	const menuLine = useRef<number | null>(null);
	// 세션 기록 — 셸을 다시 열어도 이어서 기록, 칸을 닫으면 멈춤
	const recRef = useRef<SessionRecorder | null>(null);
	const recStarting = useRef(false);
	const [recording, setRecording] = useState<string | null>(null);
	const logNameRef = useRef(logName ?? label);
	logNameRef.current = logName ?? label;
	const onRecordingRef = useRef(onRecording);
	onRecordingRef.current = onRecording;
	// rz/sz — 원격 셸에서만
	const isRemote = backend.exitEvent === "ssh-shell-exit";
	const zmRef = useRef<ZmodemBridge | null>(null);
	const [zm, setZm] = useState<ZmProgress | null>(null);
	// 명령 입력 보조(D25)
	const assistRef = useRef(assist);
	assistRef.current = assist;
	const axRef = useRef<TermAssist | null>(null);
	const [formOpen, setFormOpen] = useState<{ id: string | null } | null>(null);
	const [explain, setExplainView] = useState<{ text: string; parts: ExplainPart[] } | null>(null);
	const explainOpen = useRef(false);
	const setExplain = (v: { text: string; parts: ExplainPart[] } | null) => {
		explainOpen.current = !!v;
		setExplainView(v);
	};
	const completerRef = useRef<Completer | null>(null);
	/** 폼 후보 — 지금 터미널 폴더 목록·읽기 전용 서버 명령 */
	const candidates = (src: Parameters<typeof candidatesFor>[0]) => {
		const c = completionRef.current;
		return candidatesFor(src, { key: c?.key ?? label, exec: c?.exec, listDir: c?.listDir, cwd: completerRef.current?.cwdNow() ?? null });
	};
	const openExplain = async (given?: string) => {
		let text = (given ?? axRef.current?.explainText() ?? "").trim();
		if (!text) text = (cmds.current.at(-1)?.text ?? "").replace(/^.*?[$#>]\s/, "").trim();
		if (!text) {
			setStat({ label: "풀이할 명령을 고르거나(선택) 입력 줄에 쳐 주세요" });
			return;
		}
		await ensureDict();
		const line = text.split("\n")[0] ?? "";
		// 원격: 사전에 없는 옵션 설명은 서버 man 에서 — 풀이를 열 때만 한 번 받는다(최대 2.5초 기다림)
		const exec = completionRef.current?.exec;
		if (exec) {
			const w = line.trim().split(/\s+/);
			const cmd = (w[0] === "sudo" ? w[1] : w[0]) ?? "";
			await Promise.race([requestMan(exec, cmd), new Promise((r) => window.setTimeout(r, 2500))]);
		}
		setExplain({ text: line, parts: explainLine(line, optLookup, cmdDesc, subDesc) });
	};
	const openExplainRef = useRef(openExplain);
	openExplainRef.current = openExplain;
	/** 넣기 — {{빈칸}} 이 있으면 빈칸 템플릿, 없으면 그대로(실행하지 않음) */
	const insertTemplate = (text: string) => {
		const ax = axRef.current;
		const t = termRef.current;
		if (ax && hasTemplateFields(text)) ax.template(text);
		else if (t) t.input(ax ? fillTemplate(text) : text);
		t?.focus();
	};
	const insertRef = useRef(insertTemplate);
	insertRef.current = insertTemplate;
	const candRef = useRef(candidates);
	candRef.current = candidates;

	const startRec = async () => {
		if (recRef.current || recStarting.current) return;
		recStarting.current = true;
		try {
			const p = await loadTermPrefs();
			const r = await SessionRecorder.start(logNameRef.current, { dir: p.logDir, strip: p.logStrip, timestamps: p.logStamp });
			recRef.current = r;
			setRecording(r.path);
			setStat({ label: `기록 중 — ${r.path}`, ok: true });
		} catch (e) {
			setStat({ label: `기록을 시작하지 못했습니다: ${String(e)}` });
		} finally {
			recStarting.current = false;
		}
	};
	const stopRec = async () => {
		const r = recRef.current;
		if (!r) return;
		recRef.current = null;
		setRecording(null);
		await r.stop();
		setStat({ label: `기록을 멈췄습니다 — ${r.path}`, ok: true });
	};
	useEffect(() => {
		onRecordingRef.current?.(!!recording);
	}, [recording]);
	useEffect(
		() => () => {
			void recRef.current?.stop();
			recRef.current = null;
		},
		[],
	);

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
		const look = getAppearance();
		const th0 = termTheme(profileIdRef.current);
		el.style.background = th0.background ?? "";
		const term = new XTerm({
			fontFamily: termFontFamily(),
			fontSize: look.termSize,
			lineHeight: look.termLine,
			cursorBlink: true,
			scrollback: 10000,
			allowProposedApi: true,
			overviewRuler: { width: 8 },
			theme: th0,
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
				setFontPx(n);
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
		// ── 단어 색칠·기록·rz/sz 설정(설정 화면이 바꾸면 다시 읽는다) ──
		const hi = attachHighlighter(term);
		const utf8 = new TextEncoder();
		/** 화면에 그리고 기록에도 — EUC-KR 이면 기록은 UTF-8 로. done: xterm 이 다 그린 뒤(흐름 제어 ack) */
		const show = (b: Uint8Array, done?: () => void) => {
			const dec = decoderRef.current;
			const rec = recRef.current;
			if (dec) {
				const t = dec.decode(b, { stream: true });
				term.write(t, done);
				rec?.push(utf8.encode(t));
			} else {
				term.write(b, done);
				rec?.push(b);
			}
		};
		// 흐름 제어 — 그린 바이트를 모아 64 KB 마다(작으면 30 ms 뒤) 알린다. 백엔드는 화면에 떠 있는 양을 창 안으로 묶는다
		let ackPending = 0;
		let ackTimer: number | undefined;
		const flushAck = () => {
			ackTimer = undefined;
			const id = idRef.current;
			if (!ackPending || disposed) return;
			if (id == null) {
				ackTimer = window.setTimeout(flushAck, 50);
				return;
			}
			const n = ackPending;
			ackPending = 0;
			void backend.ack?.(id, n).catch(() => undefined);
		};
		const drawn = (n: number) => {
			ackPending += n;
			if (ackPending >= 65536) {
				window.clearTimeout(ackTimer);
				flushAck();
			} else if (ackTimer === undefined) ackTimer = window.setTimeout(flushAck, 30);
		};
		const zmb = isRemote
			? createZmodem({
					send: async (b) => {
						if (idRef.current != null) await backend.write(idRef.current, bytesAsUserDefined(b), "x-user-defined");
					},
					toTerminal: show,
					pickDir: async () => {
						const p = await loadTermPrefs();
						if (p.zmDir) return p.zmDir;
						const d = await openDialog({ directory: true, multiple: false, title: "sz — 받을 폴더 고르기" });
						return typeof d === "string" ? d : null;
					},
					pickFiles: async () => {
						const r = await openDialog({ multiple: true, title: "rz — 서버로 올릴 파일 고르기" });
						return r == null ? null : Array.isArray(r) ? r : [r];
					},
					progress: setZm,
					notice: (m, ok) => setStat({ label: m, ok }),
				})
			: null;
		zmRef.current = zmb;
		const applyPrefs = () =>
			void loadTermPrefs().then((p) => {
				if (disposed) return;
				completerRef.current?.setTabList(p.tabList);
				axRef.current?.setSig(p.sigHint);
				hi.setRules(p.hiOn ? p.hiWords : null);
				zmb?.setEnabled(p.zmOn);
				if (p.logAuto && !recRef.current) void startRec();
			});
		applyPrefs();
		window.addEventListener(TERM_PREFS_EVENT, applyPrefs);
		/** rz/sz 를 친 직후 몇 초 — 서버에 lrzsz 가 없다는 말을 찾는다 */
		let zmWatch = 0;
		let zmTail = "";
		// 입력 지연 — 키를 보낸 시각부터 다음 출력이 올 때까지(에코). 최근 100개
		let lagAt = 0;
		const lagSamples: number[] = [];
		let lagDirty = false;
		const lagTimer = window.setInterval(() => {
			if (!lagDirty || disposed) return;
			lagDirty = false;
			const sorted = [...lagSamples].sort((a, b) => a - b);
			const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
			setLag({ p50: at(0.5), p95: at(0.95), n: sorted.length });
		}, 1000);
		const ch = bytesChannel((b) => {
			if (lagAt) {
				const ms = performance.now() - lagAt;
				lagAt = 0;
				// 에코가 없는 입력(암호 줄 등) 뒤의 늦은 출력은 지연이 아니다
				if (ms < 3000) {
					lagSamples.push(ms);
					if (lagSamples.length > 100) lagSamples.shift();
					lagDirty = true;
				}
			}
			axRef.current?.output(b.length);
			const n = b.length;
			if (zmb) {
				zmb.consume(b);
				drawn(n);
			} else show(b, () => drawn(n));
			if (zmWatch) {
				if (Date.now() > zmWatch) zmWatch = 0;
				else {
					zmTail = (zmTail + plain.decode(b)).slice(-300);
					if (NO_LRZSZ.test(zmTail)) {
						zmWatch = 0;
						setStat({ label: "서버에 lrzsz 가 없습니다 — 설치: sudo apt install lrzsz (RHEL 계열: sudo dnf install lrzsz)" });
					}
				}
			}
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
		if (completionRef.current) completer = attachCompletion(term, el, completionRef.current, (s) => write(s), (open) => axRef.current?.popChanged(open));
		completerRef.current = completer;
		// ── 명령 입력 보조(D25) — 리눅스 셸만 ──
		const ax =
			completer && assistRef.current
				? attachAssist({
						term,
						host: el,
						completer,
						emit: (s) => {
							write(s);
							onInputRef.current?.(s);
						},
						exec: completionRef.current?.exec,
						onExplain: () => void openExplainRef.current(),
						explainOpen: () => explainOpen.current,
						closeExplain: () => setExplain(null),
					})
				: null;
		axRef.current = ax;

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
				ax?.reset();
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
					// 렌더마다 불린다 — 처음 한 번만 쓴다(에코마다 DOM 을 다시 쓰지 않게)
					if (d.textContent === text) return;
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
				// Windows: file://localhost/C:/Users → C:/Users (cmd 는 역슬래시로 준다)
				p = p.replace(/\\/g, "/");
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
			.open(term.cols, term.rows, ch, reopenAt.current ?? cwd, shell)
			.then((id) => {
				if (disposed) {
					void backend.close(id);
					return;
				}
				idRef.current = id;
				onShellRef.current?.({
					idle: () => !promptSeen || (atPrompt && !typedAtPrompt),
					assist: ax
						? (a) => {
								if (a.kind === "form") setFormOpen({ id: a.id ?? null });
								else if (a.kind === "explain") void openExplainRef.current();
								else insertRef.current(a.text);
							}
						: undefined,
					send: (s) => write(s),
					sudoPw: backend.sudoPw ? () => backend.sudoPw?.(id) ?? Promise.resolve(false) : undefined,
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
			// rz/sz 전송 중 — 셸에 글을 보내지 않는다(Ctrl+C 는 전송 멈추기)
			if (zmb?.active()) {
				if (d === "\x03") zmb.cancel();
				return;
			}
			if (zmb && d.includes("\r")) {
				const buf = term.buffer.active;
				const typed = (buf.getLine(buf.cursorY + buf.baseY)?.translateToString(true) ?? "").replace(/^.*?[$#>]\s/, "").trim();
				if (/^(?:sudo\s+)?(?:rz|sz)(?:\s|$)/.test(typed)) {
					zmWatch = Date.now() + 4000;
					zmTail = "";
				}
			}
			if (atPrompt && d !== "\r") typedAtPrompt = true;
			// 빈칸 템플릿 입력(D25 ①) — 셸로 보내기까지 끝
			if (ax?.data(d)) return;
			if (d === "\r") completer?.submitted();
			// 첫 입력(붙여넣기·템플릿처럼 여러 글자도) 직전 커서 = 입력 시작
			else if (d >= " " && d !== "\x7f") completer?.typed();
			if (atPrompt && d.includes("\r")) {
				const buf = term.buffer.active;
				const line = buf.getLine(buf.cursorY + buf.baseY)?.translateToString(true) ?? "";
				const marker = term.registerMarker(0);
				if (marker) pending = { marker, start: Date.now(), text: line.trim() };
				atPrompt = false;
			}
			if (!lagAt) lagAt = performance.now();
			write(d);
			onInputRef.current?.(d);
			if (d.includes("\r")) ax?.reset();
		});
		const onResize = term.onResize(({ cols, rows }) => {
			if (idRef.current != null) void backend.resize(idRef.current, cols, rows);
		});
		term.attachCustomKeyEventHandler((e) => {
			// 입력 보조(D25) — 빈칸 Tab 이 자동완성 Tab 보다 먼저, Ctrl+Shift+E 풀이
			if (ax && !ax.key(e)) {
				e.preventDefault();
				e.stopPropagation();
				return false;
			}
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
				const next = e.key === "0" ? getAppearance().termSize : Math.min(32, Math.max(8, cur + (e.key === "-" ? -1 : 1)));
				term.options.fontSize = next;
				setFontPx(next);
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
		// 사전에서 "터미널에 넣기" 할 대상 — 마지막으로 포커스를 받은 터미널
		const onFocusIn = () =>
			setActiveTerminal({
				write: (s) => write(s),
				label,
				...(ax ? { template: (s: string) => insertRef.current(s), candidates: (src: Parameters<typeof candidatesFor>[0]) => candRef.current(src) } : {}),
			});
		ta?.addEventListener("focus", onFocusIn);
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
		// 화면 설정(앱 테마·색 구성·글꼴)이 바뀌면 바로 — 글꼴 크기는 설정에서 바꿨을 때만(Ctrl+= 로 이 터미널만 키운 것은 둔다)
		let lookSize = look.termSize;
		const unLook = onAppearance(() => {
			const a = getAppearance();
			const th = termTheme(profileIdRef.current);
			term.options.theme = th;
			el.style.background = th.background ?? "";
			term.options.fontFamily = termFontFamily();
			term.options.lineHeight = a.termLine;
			if (a.termSize !== lookSize) {
				lookSize = a.termSize;
				term.options.fontSize = a.termSize;
				setFontPx(a.termSize);
			}
			if (el.offsetWidth > 0) fit.fit();
		});

		return () => {
			disposed = true;
			window.clearInterval(lagTimer);
			window.clearTimeout(ackTimer);
			setLag(null);
			window.removeEventListener(TERM_PREFS_EVENT, applyPrefs);
			zmb?.cancel();
			zmRef.current = null;
			setZm(null);
			hi.dispose();
			ax?.dispose();
			axRef.current = null;
			completer?.dispose();
			completerRef.current = null;
			ta?.removeEventListener("paste", onPaste, true);
			ta?.removeEventListener("focus", onFocusIn);
			osc133.dispose();
			osc7.dispose();
			osc6974.dispose();
			pathLinks.dispose();
			onSel.dispose();
			onResults.dispose();
			cmds.current = [];
			exited.current = false;
			onShellRef.current?.(null);
			unLook();
			void unlisten.then((f) => f());
			ro.disconnect();
			onData.dispose();
			onResize.dispose();
			if (idRef.current != null) void backend.close(idRef.current);
			idRef.current = null;
			term.dispose();
			termRef.current = null;
		};
	}, [gen, backend, shell]);

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
		...(axRef.current
			? ([
					{ label: "명령 풀이  Ctrl+Shift+E", run: () => void openExplain(termRef.current?.getSelection() || undefined) },
					{ label: "명령 만들기…", run: () => setFormOpen({ id: null }) },
				] as MenuItem[])
			: []),
		{ label: "화면 지우기", run: () => termRef.current?.clear() },
		{ label: "스크롤백 저장…", run: () => void exportScrollback() },
		recording ? { label: "이 터미널 기록 멈추기", run: () => void stopRec() } : { label: "이 터미널 기록 시작", run: () => void startRec() },
		{
			label: "기록 폴더 열기",
			run: () =>
				void loadTermPrefs()
					.then((p) => revealLogDir(p.logDir, logNameRef.current))
					.catch((e) => setStat({ label: `폴더를 열지 못했습니다: ${String(e)}` })),
		},
		{ sep: true },
		{ label: encoding === "UTF-8" ? "인코딩: EUC-KR 로" : "인코딩: UTF-8 로", run: () => changeEncoding(encoding === "UTF-8" ? "EUC-KR" : "UTF-8") },
		{ label: "셸 다시 열기", run: () => setGen((g) => g + 1) },
		...(onSplit || onRootShell ? ([{ sep: true }] as MenuItem[]) : []),
		...(onSplit
			? ([
					{ label: "오른쪽으로 나누기", run: () => onSplit("right") },
					{ label: "아래로 나누기", run: () => onSplit("below") },
				] as MenuItem[])
			: []),
		...(onRootShell ? [root ? { label: "root 셸에서 나오기", run: () => onRootShell(false) } : { label: "root 셸로(sudo -i)", danger: true, run: () => onRootShell(true) }] : []),
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
			{zm && (
				<div className="zm-bar" role="status">
					<span className="zm-dir">{zm.dir === "down" ? "받는 중" : "올리는 중"}</span>
					<span className="zm-name" title={zm.name}>
						{zm.count > 1 ? `(${zm.index}/${zm.count}) ` : ""}
						{zm.name}
					</span>
					<div className="bar">
						<i style={{ width: `${zm.total ? Math.min(100, (zm.done / zm.total) * 100) : 0}%` }} />
					</div>
					<small>
						{fmtBytes(zm.done)}
						{zm.total ? ` / ${fmtBytes(zm.total)} · ${Math.floor((zm.done / zm.total) * 100)}%` : ""}
					</small>
					<button type="button" className="btn ghost" onClick={() => zmRef.current?.cancel()} title="전송 멈추기(Ctrl+C)">
						취소
					</button>
				</div>
			)}
			<div className="statusbar">
				{recording && (
					<button type="button" className="rec-dot" title={`기록 중 — ${recording}\n눌러 멈추기`} onClick={() => void stopRec()}>
						● 기록
					</button>
				)}
				<span className={stat.ok ? "ok" : undefined}>{stat.label}</span>
				{last && (
					<span className={last.code === 0 ? "ok" : "err"}>
						{last.code === 0 ? "✓" : `✗ ${last.code}`} {last.ms < 1000 ? `${last.ms}ms` : `${(last.ms / 1000).toFixed(1)}초`}
					</span>
				)}
				{root && <span className="badge warn">root</span>}
				{lag && lag.n >= 5 && (
					<span className={lag.p95 > 150 ? "err" : undefined} title={`입력 지연 — 키를 보낸 뒤 첫 출력(에코)이 올 때까지, 최근 ${lag.n}번\n중앙값 ${lag.p50} ms · 느린 쪽 5% ${lag.p95} ms`}>
						입력 {lag.p50}/{lag.p95}ms
					</span>
				)}
				{fontPx !== getAppearance().termSize && <span title="터미널 글꼴 — Ctrl+0 설정한 크기로">글꼴 {fontPx}px</span>}
				{here && (
					<button type="button" className="env-chip" title="지금 폴더 — 눌러 경로 복사" onClick={() => void navigator.clipboard.writeText(here)}>
						{here}
					</button>
				)}
				<span style={{ marginLeft: "auto" }} />
				{statusExtra}
				{shellOptions && shellOptions.length > 1 && shell && (
					<Select size="sm" value={shell} onChange={(v) => onShellChange?.(v)} title="셸 바꾸기(새로 연다)" options={shellOptions} />
				)}
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
			{formOpen && (
				<AssistFormSheet
					initial={formOpen.id}
					candidates={candidates}
					target={label}
					onClose={() => {
						setFormOpen(null);
						termRef.current?.focus();
					}}
					onInsert={(text) => {
						setFormOpen(null);
						insertTemplate(text);
					}}
				/>
			)}
			{explain && (
				<ExplainCard
					text={explain.text}
					parts={explain.parts}
					anchor={host.current?.getBoundingClientRect() ?? null}
					onClose={() => {
						setExplain(null);
						termRef.current?.focus();
					}}
				/>
			)}
			{palette && (
				<SnippetPalette
					onClose={() => {
						setPalette(false);
						termRef.current?.focus();
					}}
					onPick={(body, run) => {
						setPalette(false);
						// {{빈칸}} — 넣기는 빈칸 템플릿으로, 바로 실행은 기본값으로 채워 보낸다(D25)
						if (axRef.current && hasTemplateFields(body)) {
							if (run) write(`${fillTemplate(body)}\r`);
							else return insertTemplate(body);
						} else write(run ? `${body}\r` : body);
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
