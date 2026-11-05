import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowDownToLine, ChevronDown, ChevronUp, Palette, Pause, Play, Trash2, WrapText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bytesChannel, type FsBackend } from "../lib/ipc";
import { Select } from "./Select";

/**
 * 실시간 보기 — 원격은 `tail -n N -F`, 내 PC 는 늘어난 만큼 읽기. 화면은 읽기 전용 xterm 이라 로그 색(ANSI)이 그대로 보인다.
 * 멈춤(멈춘 동안 온 줄은 모아 두었다가 다시 켜면 한꺼번에)·찾기(일치 수)·인코딩·지우기·처음 줄 수·
 * 수준 색(ERROR 빨강·WARN 노랑·INFO 하늘·DEBUG 흐림 — 이미 색이 있는 줄은 그대로)·맨 아래로.
 * 줄바꿈 켜고 끄기(끄면 긴 줄은 가로로 밀어 본다)·보관 줄 수 상한(넘으면 오래된 줄부터 버린다).
 */
/** 줄바꿈을 끈 때 한 줄 너비(글자) */
const NOWRAP_COLS = 1000;
const ESC = "\x1b";
/** 색이 없는 로그 줄에 수준·시각 색을 입힌다 */
function colorize(text: string): string {
	return text
		.split("\n")
		.map((l) => {
			if (!l || l.includes(ESC)) return l;
			let s = l.replace(/^(\[?\d{4}[-/.]\d{2}[-/.]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?)/, `${ESC}[2m$1${ESC}[22m`);
			if (/\b(ERROR|FATAL|SEVERE|CRIT(ICAL)?|PANIC)\b|Exception\b/.test(s)) s = `${ESC}[31m${s}${ESC}[39m`;
			else if (/\bWARN(ING)?\b/.test(s)) s = `${ESC}[33m${s}${ESC}[39m`;
			else if (/\b(DEBUG|TRACE)\b/.test(s)) s = `${ESC}[2m${s}${ESC}[22m`;
			else if (/^\s+at\s/.test(s)) s = `${ESC}[2m${s}${ESC}[22m`;
			return s;
		})
		.join("\n");
}
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
	const [initLines, setInitLines] = useState(500);
	const [color, setColor] = useState(true);
	const colorRef = useRef(true);
	colorRef.current = color;
	const [found, setFound] = useState<{ i: number; n: number } | null>(null);
	const utf8 = useRef(new TextDecoder());
	const [wrap, setWrap] = useState(true);
	const wrapRef = useRef(true);
	wrapRef.current = wrap;
	const [keep, setKeep] = useState(50_000);
	const fitRef = useRef<FitAddon | null>(null);
	/** 칸 크기에 맞추기 — 줄바꿈을 끄면 너비는 넓게 두고 높이만 맞춘다 */
	const layout = () => {
		const t = termRef.current;
		const f = fitRef.current;
		if (!t || !f) return;
		if (wrapRef.current) return f.fit();
		const d = f.proposeDimensions();
		if (d && Number.isFinite(d.rows)) t.resize(NOWRAP_COLS, Math.max(2, d.rows - 1));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: 줄바꿈·보관 줄 수는 아래에서 따로 적용(다시 열지 않는다)
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const s = getComputedStyle(document.documentElement);
		const term = new XTerm({
			disableStdin: true,
			convertEol: true,
			scrollback: keep,
			fontFamily: s.getPropertyValue("--font-mono"),
			fontSize: 12.5,
			theme: { background: s.getPropertyValue("--term-bg").trim(), foreground: s.getPropertyValue("--term-fg").trim() },
		});
		const fit = new FitAddon();
		const search = new SearchAddon();
		term.loadAddon(fit);
		term.loadAddon(search);
		const res = search.onDidChangeResults((r) => setFound({ i: r.resultIndex + 1, n: r.resultCount }));
		term.open(el);
		termRef.current = term;
		fitRef.current = fit;
		searchRef.current = search;
		layout();
		const ro = new ResizeObserver(() => el.offsetWidth > 0 && layout());
		ro.observe(el);
		let count = 0;
		const write = (b: Uint8Array) => {
			const d = decRef.current ?? utf8.current;
			const text = d.decode(b, { stream: true });
			term.write(colorRef.current ? colorize(text) : text);
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
				? invoke<number>("ssh_tail_open", { conn: fs.conn, path, lines: initLines, onData: ch })
				: invoke<number>("local_tail_open", { path, lines: initLines, onData: ch });
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
			res.dispose();
			term.dispose();
			termRef.current = null;
			fitRef.current = null;
		};
	}, [fs, path, initLines]);

	// 줄바꿈 전환 — 이미 받은 줄도 다시 흘린다(xterm reflow)
	// biome-ignore lint/correctness/useExhaustiveDependencies: wrap 이 바뀔 때만
	useEffect(() => {
		layout();
	}, [wrap]);
	useEffect(() => {
		if (termRef.current) termRef.current.options.scrollback = keep;
	}, [keep]);

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
				{q && found && <span className="find-count">{found.n ? `${found.i}/${found.n}` : "없음"}</span>}
				<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findPrevious(q)}>
					<ChevronUp size={13} />
				</button>
				<button type="button" className="btn ghost icon" onClick={() => searchRef.current?.findNext(q)}>
					<ChevronDown size={13} />
				</button>
				<span style={{ flex: 1 }} />
				<button type="button" className="btn ghost" title="맨 아래로(새 줄 따라가기)" onClick={() => termRef.current?.scrollToBottom()}>
					<ArrowDownToLine size={13} />
				</button>
				<button type="button" className={`btn ghost${color ? " on" : ""}`} title="수준 색 입히기(ERROR·WARN·INFO·DEBUG) — 이미 색이 있는 줄은 그대로" onClick={() => setColor((c) => !c)}>
					<Palette size={13} />
				</button>
				<button type="button" className={`btn ghost${wrap ? " on" : ""}`} title={wrap ? "줄바꿈 켜짐 — 눌러 끄면 긴 줄을 가로로 밀어 봅니다" : "줄바꿈 꺼짐 — 눌러 켜기"} onClick={() => setWrap((w) => !w)}>
					<WrapText size={13} />
				</button>
				<Select
					size="sm"
					value={keep}
					onChange={setKeep}
					title="보관 줄 수 — 넘으면 오래된 줄부터 버린다"
					options={[5000, 20000, 50000, 100000, 200000].map((n) => ({ value: n, label: `보관 ${n.toLocaleString()}줄` }))}
				/>
				<Select
					size="sm"
					value={initLines}
					onChange={setInitLines}
					title="처음 보일 줄 수(바꾸면 다시 연다)"
					options={[100, 500, 2000, 10000].map((n) => ({ value: n, label: `끝 ${n.toLocaleString()}줄` }))}
				/>
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
			<div className={`term-host${wrap ? "" : " nowrap"}`} ref={host} />
			<div className="statusbar">
				<span className={state === "따라가는 중" ? "ok" : undefined}>
					{isPaused ? "멈춤 — 새 줄을 모으는 중" : state}
				</span>
				<span title="받은 줄 수(화면에는 보관 줄 수까지만 남는다)">{lines.toLocaleString()}줄</span>
				<span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{path}</span>
			</div>
		</div>
	);
}
