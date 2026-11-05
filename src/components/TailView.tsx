import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bytesChannel, type FsBackend } from "../lib/ipc";
import { Select } from "./Select";

/**
 * 실시간 보기 — 원격은 `tail -n N -F`, 내 PC 는 늘어난 만큼 읽기. 화면은 읽기 전용 xterm 이라 로그 색(ANSI)이 그대로 보인다.
 * 멈춤(멈춘 동안 온 줄은 모아 두었다가 다시 켜면 한꺼번에)·찾기·인코딩·지우기.
 */
export function TailView({ fs, path }: { fs: FsBackend; path: string }) {
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const searchRef = useRef<SearchAddon | null>(null);
	const paused = useRef<Uint8Array[] | null>(null);
	const [isPaused, setPaused] = useState(false);
	const [lines, setLines] = useState(0);
	const [state, setState] = useState("여는 중…");
	const [q, setQ] = useState("");
	const [enc, setEnc] = useState("UTF-8");
	const decRef = useRef<TextDecoder | null>(null);

	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const s = getComputedStyle(document.documentElement);
		const term = new XTerm({
			disableStdin: true,
			convertEol: true,
			scrollback: 50_000,
			fontFamily: s.getPropertyValue("--font-mono"),
			fontSize: 12.5,
			theme: { background: s.getPropertyValue("--term-bg").trim(), foreground: s.getPropertyValue("--term-fg").trim() },
		});
		const fit = new FitAddon();
		const search = new SearchAddon();
		term.loadAddon(fit);
		term.loadAddon(search);
		term.open(el);
		fit.fit();
		termRef.current = term;
		searchRef.current = search;
		const ro = new ResizeObserver(() => el.offsetWidth > 0 && fit.fit());
		ro.observe(el);
		let count = 0;
		const write = (b: Uint8Array) => {
			const d = decRef.current;
			if (d) term.write(d.decode(b, { stream: true }));
			else term.write(b);
			for (const x of b) if (x === 10) count++;
			setLines(count);
		};
		const ch = bytesChannel((b) => {
			if (paused.current) paused.current.push(b);
			else write(b);
		});
		let id: number | null = null;
		let gone = false;
		const open =
			fs.side === "remote"
				? invoke<number>("ssh_tail_open", { conn: fs.conn, path, lines: 500, onData: ch })
				: invoke<number>("local_tail_open", { path, lines: 500, onData: ch });
		open
			.then((x) => {
				if (gone) return void invoke("tail_close", { id: x });
				id = x;
				setState("따라가는 중");
			})
			.catch((e) => setState(String(e?.message ?? e)));
		const un = listen<{ id: number }>("tail-end", (e) => {
			if (e.payload.id === id) setState("끝남");
		});
		(term as unknown as { __rbWrite: typeof write }).__rbWrite = write;
		return () => {
			gone = true;
			if (id != null) void invoke("tail_close", { id });
			void un.then((f) => f());
			ro.disconnect();
			term.dispose();
		};
	}, [fs, path]);

	const toggle = () => {
		if (paused.current) {
			const queued = paused.current;
			paused.current = null;
			const w = (termRef.current as unknown as { __rbWrite?: (b: Uint8Array) => void } | null)?.__rbWrite;
			for (const b of queued) w?.(b);
			setPaused(false);
		} else {
			paused.current = [];
			setPaused(true);
		}
	};

	return (
		<div className="panel-fill">
			<div className="wb-bar">
				<button type="button" className={`btn ghost${isPaused ? " on" : ""}`} onClick={toggle} title="멈춘 동안 온 줄은 다시 켜면 이어 붙입니다">
					{isPaused ? <Play size={13} /> : <Pause size={13} />} {isPaused ? "이어 보기" : "멈춤"}
				</button>
				<button type="button" className="btn ghost" onClick={() => termRef.current?.clear()} title="화면 지우기">
					<Trash2 size={13} /> 지우기
				</button>
				<input
					className="path-input"
					style={{ width: 200 }}
					placeholder="찾기 (Enter 다음)"
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						searchRef.current?.findNext(e.target.value, { incremental: true, decorations: { matchOverviewRuler: "#ff9f0a", activeMatchColorOverviewRuler: "#0a84ff", matchBackground: "#ff9f0a55", activeMatchBackground: "#0a84ff88" } });
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							if (e.shiftKey) searchRef.current?.findPrevious(q);
							else searchRef.current?.findNext(q);
						}
					}}
				/>
				<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findPrevious(q)}>
					<ChevronUp size={13} />
				</button>
				<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findNext(q)}>
					<ChevronDown size={13} />
				</button>
				<span style={{ flex: 1 }} />
				<Select
					size="sm"
					value={enc}
					onChange={(v) => {
						setEnc(v);
						decRef.current = v === "UTF-8" ? null : new TextDecoder("euc-kr");
					}}
					options={[
						{ value: "UTF-8", label: "UTF-8" },
						{ value: "EUC-KR", label: "EUC-KR" },
					]}
				/>
			</div>
			<div className="term-host" ref={host} />
			<div className="statusbar">
				<span className={state === "따라가는 중" ? "ok" : undefined}>
					{isPaused ? "멈춤 — 새 줄을 모으는 중" : state}
				</span>
				<span>{lines.toLocaleString()}줄</span>
				<span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{path}</span>
			</div>
		</div>
	);
}
