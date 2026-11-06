/**
 * 서버 도구 칸(서비스·Docker·내용 찾기·웹 포트·DB 활동)이 함께 쓰는 것 — 명령 실행(sudo 암호 묻기 포함)·흘려 받기·확인 창·로그 보기.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Pause, Play, Search, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { asSshError, type SudoMode, sudoApi } from "../../lib/ipc";
import "../../styles/panels.css";

/** 연결한 계정의 sudo 설정(작업대가 ConnectOk 의 sudo·sudoUser 로 넘긴다) */
export type SudoCtx = { mode: SudoMode; user: string };
export const sudoAllowed = (s?: SudoCtx) => !!s && s.mode !== "off";

export type RunOut = { code: number | null; stdout: string; stderr: string; truncated: boolean };

export const errText = (e: unknown) => asSshError(e).message;

/** 셸 작은따옴표 */
export const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** 색 코드(ANSI) 지우기 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 색 코드는 ESC 로 시작한다
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

// ── 확인·암호 창 ─────────────────────

function mount<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
	return new Promise((resolve) => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const done = (v: T) => {
			root.unmount();
			host.remove();
			resolve(v);
		};
		root.render(render(done));
	});
}

/** 위험한 일 확인 — 확인이면 true */
export function confirmAction(o: { title: string; message?: string; okLabel?: string; danger?: boolean }): Promise<boolean> {
	return mount<boolean>((done) => <ConfirmSheet o={o} done={done} />);
}

function ConfirmSheet({ o, done }: { o: { title: string; message?: string; okLabel?: string; danger?: boolean }; done: (v: boolean) => void }) {
	const ok = useRef<HTMLButtonElement>(null);
	useEffect(() => ok.current?.focus(), []);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
			<div
				className="sheet ask-sheet"
				role="alertdialog"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						done(false);
					}
				}}
			>
				<h3>{o.title}</h3>
				{o.message && <p className="ask-msg">{o.message}</p>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => done(false)}>
						취소
					</button>
					<button ref={ok} type="button" className={`btn ${o.danger ? "danger-solid" : "primary"}`} onClick={() => done(true)}>
						{o.okLabel ?? "확인"}
					</button>
				</div>
			</div>
		</div>
	);
}

/** sudo 암호 묻기 — 글자는 가려서. 취소면 null */
export function askSudoPassword(error?: string): Promise<{ password: string; save: boolean } | null> {
	return mount<{ password: string; save: boolean } | null>((done) => <PasswordSheet error={error} done={done} />);
}

function PasswordSheet({ error, done }: { error?: string; done: (v: { password: string; save: boolean } | null) => void }) {
	const [v, setV] = useState("");
	const [save, setSave] = useState(false);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
			<form
				className="sheet ask-sheet"
				onSubmit={(e) => {
					e.preventDefault();
					if (v) done({ password: v, save });
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						done(null);
					}
				}}
			>
				<h3>sudo 암호</h3>
				<p className="ask-msg">이 일은 관리자 권한이 필요합니다. 넣은 암호는 이 연결 동안만 기억합니다.</p>
				{error && <p className="err">{error}</p>}
				<input ref={ref} type="password" value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" spellCheck={false} />
				<label className="sp-check">
					<input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> 이 계정에 저장(OS 저장소)
				</label>
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => done(null)}>
						취소
					</button>
					<button type="submit" className="btn primary" disabled={!v}>
						확인
					</button>
				</div>
			</form>
		</div>
	);
}

/** sudo 암호가 필요하다는 오류면 묻고 넣은 뒤 다시 — 취소하면 원래 오류 */
export async function withSudoRetry<T>(conn: number, f: () => Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e) {
		if (asSshError(e).code !== "NEED_SECRET") throw e;
		let error: string | undefined;
		for (;;) {
			const got = await askSudoPassword(error);
			if (!got) throw e;
			try {
				await sudoApi.check(conn, got.password, got.save);
				break;
			} catch (x) {
				const ex = asSshError(x);
				if (ex.code !== "AUTH_FAILED" && ex.code !== "NEED_SECRET") throw x;
				error = ex.message;
			}
		}
		return f();
	}
}

/** 서버에서 명령 하나 — 종료 코드가 0 이 아니어도 결과로 돌려준다 */
export function srvRun(conn: number, cmd: string, o: { sudo?: boolean; timeoutMs?: number } = {}): Promise<RunOut> {
	const go = () => invoke<RunOut>("srv_run", { conn, cmd, sudo: !!o.sudo, timeoutMs: o.timeoutMs ?? null });
	return o.sudo ? withSudoRetry(conn, go) : go();
}

/** 실패면 오류 출력 마지막 줄로 던진다 */
export async function srvOk(conn: number, cmd: string, o: { sudo?: boolean; timeoutMs?: number } = {}): Promise<string> {
	const r = await srvRun(conn, cmd, o);
	if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `실패(종료 코드 ${r.code ?? "?"})`);
	return r.stdout;
}

type StreamEnd = { id: number; code: number | null; cancelled: boolean; message?: string | null };

/** 끝나지 않는 명령의 출력을 글자로 흘려 받기 — 돌려받은 함수를 부르면 멈춘다 */
export async function srvStream(
	conn: number,
	cmd: string,
	o: { sudo?: boolean; onText: (s: string) => void; onEnd: (e: { code: number | null; cancelled: boolean }) => void },
): Promise<() => void> {
	const dec = new TextDecoder();
	const ch = new Channel<ArrayBuffer | number[]>();
	ch.onmessage = (m) => o.onText(dec.decode(m instanceof ArrayBuffer ? new Uint8Array(m) : Uint8Array.from(m), { stream: true }));
	return openStream(() => invoke<number>("srv_stream_open", { conn, cmd, sudo: !!o.sudo, onData: ch }), o.onEnd, o.sudo ? conn : null);
}

/** 내 PC 폴더 찾기(local_grep) — 묶음마다 onHits */
export type Hit = { path: string; line: number; text: string };
export type GrepOpts = { pattern: string | null; ignoreCase: boolean; globs: string[]; skipDirs: string[]; maxDepth: number; maxSize: number; maxHits: number };
export function localGrep(root: string, opts: GrepOpts, onHits: (h: Hit[]) => void, onEnd: (e: { cancelled: boolean; message?: string | null }) => void): Promise<() => void> {
	const ch = new Channel<Hit[]>();
	ch.onmessage = onHits;
	return openStream(() => invoke<number>("local_grep", { root, opts, onData: ch }), onEnd, null);
}

async function openStream(open: () => Promise<number>, onEnd: (e: StreamEnd) => void, sudoConn: number | null): Promise<() => void> {
	let id: number | null = null;
	const early: StreamEnd[] = [];
	const un = await listen<StreamEnd>("srv-stream-end", (e) => {
		if (id == null) early.push(e.payload);
		else if (e.payload.id === id) {
			un();
			onEnd(e.payload);
		}
	});
	try {
		id = await (sudoConn != null ? withSudoRetry(sudoConn, open) : open());
	} catch (e) {
		un();
		throw e;
	}
	const got = early.find((x) => x.id === id);
	if (got) {
		un();
		onEnd(got);
	}
	const mine = id;
	return () => void invoke("srv_stream_close", { id: mine });
}

// ── 흘러 들어오는 줄 ──────────────────

/** 줄 모으기 — 보관 상한·멈춤(멈춘 동안 온 줄은 세어 두고 다시 켜면 보여 줌)·화면 갱신은 한 프레임에 한 번 */
export function useLines(keep = 20000) {
	const all = useRef<string[]>([]);
	const part = useRef("");
	const [shown, setShown] = useState<string[]>([]);
	const [paused, setPausedState] = useState(false);
	const pausedRef = useRef(false);
	const [pending, setPending] = useState(0);
	const frame = useRef(0);
	const shownLen = useRef(0);
	const flush = useCallback(() => {
		frame.current = 0;
		if (pausedRef.current) {
			setPending(all.current.length - shownLen.current);
			return;
		}
		shownLen.current = all.current.length;
		setShown(all.current.slice());
		setPending(0);
	}, []);
	const schedule = useCallback(() => {
		if (!frame.current) frame.current = requestAnimationFrame(flush);
	}, [flush]);
	const push = useCallback(
		(text: string) => {
			const s = part.current + text.replace(/\r\n?/g, "\n");
			const lines = s.split("\n");
			part.current = lines.pop() ?? "";
			if (!lines.length) return;
			all.current.push(...lines.map(stripAnsi));
			if (all.current.length > keep) {
				const cut = all.current.length - keep;
				all.current.splice(0, cut);
				shownLen.current = Math.max(0, shownLen.current - cut);
			}
			schedule();
		},
		[keep, schedule],
	);
	/** 끝날 때 남은 반 줄도 */
	const end = useCallback(() => {
		if (part.current) {
			all.current.push(stripAnsi(part.current));
			part.current = "";
			schedule();
		}
	}, [schedule]);
	const clear = useCallback(() => {
		all.current = [];
		part.current = "";
		shownLen.current = 0;
		setShown([]);
		setPending(0);
	}, []);
	const setPaused = useCallback(
		(p: boolean) => {
			pausedRef.current = p;
			setPausedState(p);
			if (!p) flush();
		},
		[flush],
	);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);
	return { lines: shown, push, end, clear, paused, setPaused, pending };
}

/** 글 안의 찾은 낱말 강조 */
export function marked(text: string, find: string | RegExp | null): ReactNode {
	if (!find) return text;
	const out: ReactNode[] = [];
	let at = 0;
	if (typeof find === "string") {
		const lo = text.toLowerCase();
		const f = find.toLowerCase();
		for (let i = lo.indexOf(f); i >= 0 && f; i = lo.indexOf(f, i + f.length)) {
			if (i > at) out.push(text.slice(at, i));
			out.push(<mark key={i}>{text.slice(i, i + f.length)}</mark>);
			at = i + f.length;
		}
	} else {
		const re = new RegExp(find.source, find.flags.includes("g") ? find.flags : `${find.flags}g`);
		for (let m = re.exec(text); m; m = re.exec(text)) {
			if (!m[0]) {
				re.lastIndex++;
				continue;
			}
			if (m.index > at) out.push(text.slice(at, m.index));
			out.push(<mark key={m.index}>{m[0]}</mark>);
			at = m.index + m[0].length;
			if (out.length > 200) break;
		}
	}
	if (!out.length) return text;
	if (at < text.length) out.push(text.slice(at));
	return out;
}

const lvl = (l: string) =>
	/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|PANIC|EMERG|ALERT|SEVERE)\b|Exception\b|\b[Ff]ailed\b/.test(l) ? "e" : /\bWARN(ING)?\b|\b[Ww]arning\b/.test(l) ? "w" : /\b(DEBUG|TRACE)\b/.test(l) ? "d" : "";

const ROW = 18;

/** 로그 보기 — 찾기(강조·맞는 줄만)·멈춤·맨 아래 따라가기·지우기. 도구 막대 왼쪽 자리(left)는 칸마다 다른 고르기 */
export function LogView({ stream, left, status }: { stream: ReturnType<typeof useLines>; left?: ReactNode; status?: ReactNode }) {
	const [find, setFind] = useState("");
	const [only, setOnly] = useState(false);
	const [follow, setFollow] = useState(true);
	const box = useRef<HTMLDivElement>(null);
	const rows = useMemo(() => {
		const f = find.trim().toLowerCase();
		if (!f || !only) return stream.lines;
		return stream.lines.filter((l) => l.toLowerCase().includes(f));
	}, [stream.lines, find, only]);
	const hits = useMemo(() => {
		const f = find.trim().toLowerCase();
		return f ? stream.lines.reduce((n, l) => n + (l.toLowerCase().includes(f) ? 1 : 0), 0) : 0;
	}, [stream.lines, find]);
	const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => ROW, overscan: 30 });
	useEffect(() => {
		if (follow && rows.length) v.scrollToIndex(rows.length - 1, { align: "end" });
	}, [rows.length, follow, v]);
	const f = find.trim();
	return (
		<div className="sp-log">
			<div className="sp-bar">
				{left}
				<label className="sp-find">
					<Search size={13} />
					<input value={find} onChange={(e) => setFind(e.target.value)} placeholder="찾기" spellCheck={false} />
					{f && <small>{hits}줄</small>}
				</label>
				<button type="button" className={`btn ghost tiny${only ? " on" : ""}`} aria-pressed={only} onClick={() => setOnly((x) => !x)} title="찾은 줄만 보기">
					맞는 줄만
				</button>
				<span className="sp-grow" />
				{stream.paused && stream.pending > 0 && <small className="sp-dim">멈춘 동안 {stream.pending}줄</small>}
				<button type="button" className="btn ghost tiny" onClick={() => stream.setPaused(!stream.paused)} title={stream.paused ? "다시 보기" : "멈추기(화면만 — 받기는 계속)"}>
					{stream.paused ? <Play size={13} /> : <Pause size={13} />}
				</button>
				<button type="button" className={`btn ghost tiny${follow ? " on" : ""}`} aria-pressed={follow} onClick={() => setFollow((x) => !x)} title="맨 아래 따라가기">
					<ArrowDownToLine size={13} />
				</button>
				<button type="button" className="btn ghost tiny" onClick={stream.clear} title="화면 지우기">
					<Trash2 size={13} />
				</button>
			</div>
			<div
				className="sp-log-body selectable"
				ref={box}
				onWheel={(e) => {
					if (e.deltaY < 0 && follow) setFollow(false);
				}}
			>
				{rows.length === 0 ? (
					<div className="sp-empty">{status ?? "아직 줄이 없습니다"}</div>
				) : (
					<div style={{ height: v.getTotalSize(), position: "relative" }}>
						{v.getVirtualItems().map((it) => {
							const l = rows[it.index];
							return (
								<div key={it.key} className={`sp-line ${lvl(l)}`} style={{ transform: `translateY(${it.start}px)` }}>
									{marked(l, f || null)}
								</div>
							);
						})}
					</div>
				)}
			</div>
			{status && rows.length > 0 && <div className="sp-foot">{status}</div>}
		</div>
	);
}

/** 보일 때만 몇 초마다 — 앞 일이 끝난 뒤 다음(겹치지 않게). every 0 이면 끔 */
export function usePoll(fn: () => Promise<unknown>, every: number, on: boolean) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(() => {
		if (!on || every <= 0) return;
		let stop = false;
		let t = 0;
		const loop = async () => {
			t = window.setTimeout(async () => {
				await ref.current().catch(() => undefined);
				if (!stop) void loop();
			}, every * 1000);
		};
		void loop();
		return () => {
			stop = true;
			window.clearTimeout(t);
		};
	}, [every, on]);
}

/** 바이트 → 사람 크기 */
export function bytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "—";
	if (n < 1024) return `${n} B`;
	const u = ["KB", "MB", "GB", "TB"];
	let x = n / 1024;
	let i = 0;
	while (x >= 1024 && i < u.length - 1) {
		x /= 1024;
		i++;
	}
	return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

/** 초 → "3분 20초" */
export function secs(s: number): string {
	if (!Number.isFinite(s) || s < 0) return "—";
	if (s < 60) return `${Math.floor(s)}초`;
	if (s < 3600) return `${Math.floor(s / 60)}분 ${Math.floor(s % 60)}초`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
	return `${Math.floor(s / 86400)}일 ${Math.floor((s % 86400) / 3600)}시간`;
}
