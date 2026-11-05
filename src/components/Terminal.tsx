import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { Gauge, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, bytesChannel, type ShellHandle, type TermBackend } from "../lib/ipc";

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

/**
 * 터미널 칸 — 원격(SSH 채널)·내 PC(PTY) 공용. 출력은 바이너리 채널 → xterm.write(Uint8Array).
 * React 상태를 거치지 않는다(대량 출력에서 멈추지 않게).
 */
export function TerminalView({
	backend,
	active,
	cwd,
	label,
	showBench = false,
	toolbar = true,
	onShell,
	onCwd,
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
}) {
	const onCwdRef = useRef(onCwd);
	onCwdRef.current = onCwd;
	const waiters = useRef<{ re: RegExp; done: (ok: boolean) => void }[]>([]);
	const onShellRef = useRef(onShell);
	onShellRef.current = onShell;
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const idRef = useRef<number | null>(null);
	const [stat, setStat] = useState<Stat>({ label: "여는 중…" });
	const [gen, setGen] = useState(0);
	const [benching, setBenching] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: gen 이 바뀌면 다시 연다
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const term = new XTerm({
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
			fontSize: 13,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: true,
			theme: themeFromCss(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// WebGL 이 안 되는 GPU 는 xterm 기본 렌더러로
		}
		fit.fit();
		termRef.current = term;
		fitRef.current = fit;

		let disposed = false;
		const started = performance.now();
		const decoder = new TextDecoder();
		let tail = "";
		const ch = bytesChannel((b) => {
			term.write(b);
			if (waiters.current.length) {
				tail = (tail + decoder.decode(b, { stream: true })).slice(-400);
				for (const w of waiters.current.slice()) {
					if (w.re.test(tail)) {
						waiters.current = waiters.current.filter((x) => x !== w);
						tail = "";
						w.done(true);
					}
				}
			}
		});
		// OSC 7: file://호스트/경로 → 지금 폴더
		const osc7 = term.parser.registerOscHandler(7, (data) => {
			const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
			if (m) {
				try {
					onCwdRef.current?.(decodeURIComponent(m[1]));
				} catch {
					onCwdRef.current?.(m[1]);
				}
			}
			return true;
		});
		backend
			.open(term.cols, term.rows, ch, cwd)
			.then((id) => {
				if (disposed) {
					void backend.close(id);
					return;
				}
				idRef.current = id;
				onShellRef.current?.({
					send: (s) => {
						if (idRef.current != null) void backend.write(idRef.current, s);
					},
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
			if (idRef.current != null) void backend.write(idRef.current, d);
		});
		const onResize = term.onResize(({ cols, rows }) => {
			if (idRef.current != null) void backend.resize(idRef.current, cols, rows);
		});
		const ro = new ResizeObserver(() => {
			if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
		});
		ro.observe(el);
		const unlisten = listen(backend.exitEvent, (e) => {
			if (idRef.current != null && backend.isMine(e.payload, idRef.current)) {
				idRef.current = null;
				setStat({ label: "셸이 끝났습니다 — ↻ 로 다시 열기" });
			}
		});
		const mq = matchMedia("(prefers-color-scheme: dark)");
		const onScheme = () => {
			term.options.theme = themeFromCss();
		};
		mq.addEventListener("change", onScheme);

		return () => {
			disposed = true;
			osc7.dispose();
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

	/** 스파이크 1: 24 MiB 를 화면에 쏘고 마지막 묶음이 그려질 때까지 잰다 */
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
			const mbps = bytes / 1024 / 1024 / (total / 1000);
			setStat({
				label: `벤치 24 MiB · ${(total / 1000).toFixed(2)}초 (${mbps.toFixed(0)} MiB/s) · 묶음 ${r.chunks} · 보내기 ${Math.round(r.send_ms)} ms`,
				ok: total <= 3000,
			});
		} catch (e) {
			setStat({ label: `벤치 실패: ${String(e)}` });
		} finally {
			setBenching(false);
			term.write("\r\n");
		}
	}

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
			<div className="term-host" ref={host} onClick={() => termRef.current?.focus()} />
			<div className="statusbar">
				<span className={stat.ok ? "ok" : undefined}>{stat.label}</span>
				{!toolbar && (
					<button type="button" className="btn ghost icon" style={{ marginLeft: "auto", height: 20, width: 20 }} onClick={() => setGen((g) => g + 1)} title="셸 다시 열기">
						<RotateCcw size={12} />
					</button>
				)}
			</div>
		</>
	);
}
