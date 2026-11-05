import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { Gauge, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, bytesChannel } from "../lib/ipc";

function themeFromCss(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
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

/** 로컬 터미널(PTY). 출력은 바이너리 채널 → xterm.write(Uint8Array). React 상태를 거치지 않는다. */
export function TerminalPane({ active }: { active: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const idRef = useRef<number | null>(null);
	const [stat, setStat] = useState<Stat>({ label: "시작 중…" });
	const [gen, setGen] = useState(0);
	const [benching, setBenching] = useState(false);

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
			// WebGL 이 안 되는 GPU 는 xterm 기본 렌더러로 물러난다
		}
		fit.fit();
		termRef.current = term;
		fitRef.current = fit;

		let disposed = false;
		const started = performance.now();
		const ch = bytesChannel((b) => term.write(b));
		api
			.ptyOpen(term.cols, term.rows, ch)
			.then((id) => {
				if (disposed) {
					void api.ptyClose(id);
					return;
				}
				idRef.current = id;
				setStat({ label: `로컬 셸 · ${Math.round(performance.now() - started)} ms에 열림`, ok: true });
			})
			.catch((e) => setStat({ label: `셸을 열지 못했습니다: ${String(e)}` }));

		const onData = term.onData((d) => {
			if (idRef.current != null) void api.ptyWrite(idRef.current, d);
		});
		const onResize = term.onResize(({ cols, rows }) => {
			if (idRef.current != null) void api.ptyResize(idRef.current, cols, rows);
		});
		const ro = new ResizeObserver(() => {
			if (el.offsetWidth > 0) fit.fit();
		});
		ro.observe(el);
		const unlisten = listen<{ id: number }>("pty-exit", (e) => {
			if (e.payload.id === idRef.current) {
				idRef.current = null;
				setStat({ label: "셸이 끝났습니다 — 다시 열기" });
			}
		});
		const mq = matchMedia("(prefers-color-scheme: dark)");
		const onScheme = () => {
			term.options.theme = themeFromCss();
		};
		mq.addEventListener("change", onScheme);

		return () => {
			disposed = true;
			mq.removeEventListener("change", onScheme);
			void unlisten.then((f) => f());
			ro.disconnect();
			onData.dispose();
			onResize.dispose();
			if (idRef.current != null) void api.ptyClose(idRef.current);
			idRef.current = null;
			term.dispose();
			termRef.current = null;
		};
	}, [gen]);

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
			<div className="toolbar">
				<span className="title">로컬 터미널</span>
				<button type="button" className="btn ghost" onClick={bench} disabled={benching} title="24 MiB 출력 벤치(스파이크 1)">
					<Gauge size={15} /> 출력 벤치
				</button>
				<button type="button" className="btn ghost icon" onClick={() => setGen((g) => g + 1)} title="다시 열기">
					<RotateCcw size={15} />
				</button>
			</div>
			<div className="term-host" ref={host} />
			<div className="statusbar">
				<span className={stat.ok ? "ok" : undefined}>{stat.label}</span>
			</div>
		</>
	);
}
