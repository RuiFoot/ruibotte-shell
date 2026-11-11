import { invoke } from "@tauri-apps/api/core";
import Zmodem, { type Detection, type Offer, type Session } from "zmodem.js";

export type ZmProgress = {
	dir: "down" | "up";
	name: string;
	done: number;
	total: number;
	/** 몇 번째 파일(1부터)/모두 몇 개(모르면 0) */
	index: number;
	count: number;
};

export type ZmHooks = {
	/** 원격으로 바이트 보내기 — 차례대로 */
	send: (bytes: Uint8Array) => Promise<void>;
	/** ZMODEM 이 아닌 출력 — 터미널로 */
	/** done: 화면에 다 그린 뒤(흐름 제어 ack) — 그대로 넘긴 출력에만 */
	toTerminal: (bytes: Uint8Array, done?: () => void) => void;
	/** 받을 폴더(설정의 기본 폴더 또는 고르기) — null 이면 취소 */
	pickDir: () => Promise<string | null>;
	/** 올릴 파일 고르기 — null·빈 배열이면 취소 */
	pickFiles: () => Promise<string[] | null>;
	progress: (p: ZmProgress | null) => void;
	notice: (msg: string, ok?: boolean) => void;
};

const CHUNK = 256 * 1024;
const ZDLE = 0x18;
const STAR = 0x2a;
/** 취소 신호 — CAN 8개 + 지우기 10개(셸에 떨어져도 흔적이 남지 않게) */
const ABORT = Uint8Array.from([...Array(8).fill(0x18), ...Array(10).fill(0x08)]);

/**
 * 원격 셸의 rz/sz(ZMODEM) — 출력에서 시작 신호(**␘B0…)를 찾으면 zmodem.js 세션으로 넘긴다.
 * - sz 파일: 받을 폴더를 정한 뒤 받아 파일로(묶어 쓰기), 끝나면 알림
 * - rz: 내 PC 파일 고르기 → 하나씩 올리기(256 KiB 씩 읽어 보낸다, 보낸 것이 빠지길 기다려 메모리를 늘리지 않음)
 * 평소 출력은 ZDLE(0x18) 바이트가 없으면 그대로 지나간다(대량 출력 성능).
 */
export function createZmodem(h: ZmHooks) {
	let enabled = true;
	let busy: "picking" | "session" | null = null;
	/** 고르는 동안 다시 온 시작 신호 — 고른 뒤 가장 새것으로 시작한다 */
	let latest: Detection | null = null;
	let session: Session | null = null;
	let cancelled = false;
	/** 칸이 사라짐 — 이후 보내기·그리기를 하지 않는다 */
	let disposed = false;
	let lastStars = 0;
	const openFiles = new Set<number>();
	let pending: Promise<void> = Promise.resolve();
	/**
	 * 취소 뒤 비우기 — sz 는 보내는 동안 우리 쪽 신호를 읽지 않아 남은 파일을 계속 쏟는다.
	 * 그 바이트는 화면에 내지 않고 버리면서 취소 신호를 거듭 보낸다(sz 가 다음 응답을 기다릴 때 읽고 끝낸다).
	 * 1초 조용하면(또는 30초) 끝 — 마지막 ZMODEM 바이트 뒤의 글(셸 프롬프트 등)만 화면에 돌려준다.
	 */
	let drain: { until: number; last: number; tick: number; tail: Uint8Array } | null = null;
	const sendRaw = (b: Uint8Array) => {
		if (disposed) return;
		pending = pending.then(() => h.send(b)).catch(() => {});
	};
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	const endDrain = () => {
		const d = drain;
		if (!d) return;
		window.clearInterval(d.tick);
		drain = null;
		const t = d.tail;
		const rest = t.subarray(t.lastIndexOf(ZDLE) + 1);
		h.toTerminal(Uint8Array.from([0x0d, 0x0a]));
		// 마지막 ZMODEM 바이트 뒤가 온전한 글(UTF-8)이고 끝 줄이 프롬프트처럼 보일 때만 그 줄을 돌려준다
		// (아니면 Enter 한 번으로 새 프롬프트)
		let text = "";
		try {
			text = utf8.decode(rest);
		} catch {
			return;
		}
		const lastLine = text.slice(text.lastIndexOf("\n") + 1).replace(/^\r+/, "");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 글자가 섞였는지 보는 것이 목적
		if (/[$#>%] ?$/.test(lastLine) && !/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/.test(lastLine)) h.toTerminal(new TextEncoder().encode(lastLine));
	};
	const startDrain = () => {
		const now = Date.now();
		drain = { until: now + 30_000, last: now, tick: 0, tail: new Uint8Array(0) };
		// 0.5초마다 취소 신호 — 2초 조용하면(또는 30초) 끝
		drain.tick = window.setInterval(() => {
			const d = drain;
			if (!d) return;
			const t = Date.now();
			if (t - d.last > 2000 || t > d.until) endDrain();
			else sendRaw(ABORT);
		}, 500);
	};
	const feedDrain = (b: Uint8Array) => {
		const d = drain;
		if (!d) return;
		const keep = 4096;
		const tail = b.length >= keep ? b.subarray(b.length - keep) : b;
		const joined = new Uint8Array(d.tail.length + tail.length);
		joined.set(d.tail);
		joined.set(tail, d.tail.length);
		d.tail = joined.length > keep ? joined.slice(joined.length - keep) : joined;
		d.last = Date.now();
	};

	/** 끝맺음을 억지로 할 때 — zmodem.js 가 보내는 취소 신호를 셸에 흘리지 않는다 */
	let mute = false;
	/** 세션이 마지막으로 바이트를 받은 때 */
	let lastIn = 0;
	const sender = (octets: number[]) => {
		if (mute) return;
		const b = Uint8Array.from(octets);
		pending = pending.then(() => h.send(b)).catch(() => {});
	};
	const sentry = new Zmodem.Sentry({
		to_terminal: (octets) => {
			if (octets.length) h.toTerminal(octets instanceof Uint8Array ? octets : Uint8Array.from(octets));
		},
		sender,
		on_retract: () => {},
		on_detect: (d) => {
			latest = d;
			if (!enabled) {
				d.deny();
				return;
			}
			if (busy) return;
			void begin(d);
		},
	});

	/** 이번 전송 번호 — 끝맺음(알림·정리)은 한 번만 */
	let run = 0;
	let ended = -1;
	const finish = (msg?: string, ok?: boolean) => {
		if (ended === run) return;
		ended = run;
		session = null;
		busy = null;
		latest = null;
		h.progress(null);
		for (const id of openFiles) void invoke("zm_save_close", { id, keep: false });
		openFiles.clear();
		if (msg) h.notice(msg, ok);
	};

	async function begin(d: Detection) {
		run++;
		busy = "picking";
		cancelled = false;
		const role = d.get_session_role();
		try {
			if (role === "receive") {
				const dir = await h.pickDir();
				const cur = latest && latest.is_valid() ? latest : d;
				if (!dir || !cur.is_valid()) {
					if (cur.is_valid()) cur.deny();
					return finish(dir ? "받기 시작 신호가 끊겼습니다 — 다시 sz 를 실행하세요" : "받기를 취소했습니다");
				}
				receive(cur.confirm(), dir);
			} else {
				const paths = await h.pickFiles();
				const cur = latest && latest.is_valid() ? latest : d;
				if (!paths?.length || !cur.is_valid()) {
					if (cur.is_valid()) cur.deny();
					return finish(paths?.length ? "올리기 시작 신호가 끊겼습니다 — 다시 rz 를 실행하세요" : "올리기를 취소했습니다");
				}
				const files = await invoke<{ path: string; name: string; size: number; mtime?: number | null }[]>("zm_file_info", { paths });
				await send(cur.confirm(), files);
			}
		} catch (e) {
			try {
				session?.abort();
			} catch {
				// 이미 끝남
			}
			finish(`rz/sz 전송 실패: ${String(e)}`);
		}
	}

	/** 상대가 끝 인사(ZFIN·OO)를 다 주지 않고 셸로 돌아갔을 때 — 조용히 세션을 닫는다 */
	const forceEnd = (zs: Session) => {
		if (session !== zs) return;
		mute = true;
		try {
			zs.abort();
		} catch {
			// 이미 끝남
		}
		mute = false;
	};

	function receive(zs: Session, dir: string) {
		busy = "session";
		session = zs;
		lastIn = Date.now();
		let index = 0;
		let got = 0;
		let inFile = false;
		let lastEnd = 0;
		let lastWasFinal = false;
		const watch = window.setInterval(() => {
			if (session !== zs) return window.clearInterval(watch);
			const now = Date.now();
			// 마지막 파일을 다 받은 뒤 끝 인사가 오지 않으면(1.5초, 남은 수를 모르면 5초)
			if (!inFile && lastEnd && now - lastEnd > (lastWasFinal ? 1500 : 5000) && now - lastIn > 1000) forceEnd(zs);
			// 한참 아무것도 오지 않으면
			else if (now - lastIn > 60_000) {
				forceEnd(zs);
				h.notice("응답이 없어 받기를 멈췄습니다");
			}
		}, 500);
		zs.on("offer", (o: Offer) => {
			inFile = true;
			void (async () => {
				const det = o.get_details();
				index++;
				const name = det.name || "received.bin";
				let file: { id: number; path: string };
				try {
					file = await invoke<{ id: number; path: string }>("zm_save_open", { dir, name });
				} catch (e) {
					h.notice(`${name}: ${String(e)}`);
					o.skip();
					return;
				}
				openFiles.add(file.id);
				const total = det.size ?? 0;
				const count = index + Math.max(0, (det.files_remaining ?? 1) - 1);
				let done = 0;
				let parts: number[][] = [];
				let partLen = 0;
				let writes: Promise<unknown> = Promise.resolve();
				const flush = () => {
					if (!partLen) return;
					const all = new Uint8Array(partLen);
					let off = 0;
					for (const p of parts) {
						all.set(p, off);
						off += p.length;
					}
					parts = [];
					partLen = 0;
					writes = writes.then(() => invoke("zm_save_write", all, { headers: { "x-id": String(file.id) } }));
				};
				let shown = 0;
				h.progress({ dir: "down", name, done: 0, total, index, count });
				await o.accept({
					on_input: (payload) => {
						parts.push(payload);
						partLen += payload.length;
						done += payload.length;
						if (partLen >= CHUNK) flush();
						const now = performance.now();
						if (now - shown > 100) {
							shown = now;
							h.progress({ dir: "down", name, done, total, index, count });
						}
					},
				});
				flush();
				await writes;
				openFiles.delete(file.id);
				await invoke("zm_save_close", { id: file.id, keep: true });
				got++;
				inFile = false;
				lastEnd = Date.now();
				lastWasFinal = det.files_remaining != null && det.files_remaining <= 1;
				h.notice(`받음: ${file.path}`, true);
			})().catch((e) => {
				try {
					zs.abort();
				} catch {
					// 이미 끝남
				}
				finish(`받기 실패: ${String(e)}`);
			});
		});
		zs.on("session_end", () => {
			const msg = cancelled ? "받기를 멈췄습니다" : got ? `${got}개 파일을 받았습니다` : undefined;
			finish(msg, !cancelled && got > 0);
		});
		zs.start();
	}

	async function send(zs: Session, files: { path: string; name: string; size: number; mtime?: number | null }[]) {
		busy = "session";
		session = zs;
		let over = false;
		const my = run;
		zs.on("session_end", () => {
			over = true;
			// 상대가 먼저 끝내 기다리던 응답이 오지 않을 때도 정리되게
			window.setTimeout(() => run === my && finish(cancelled ? "올리기를 멈췄습니다" : "올리기 세션이 끝났습니다"), 1500);
		});
		const totalBytes = files.reduce((a, f) => a + f.size, 0);
		let sentBefore = 0;
		let sent = 0;
		for (let i = 0; i < files.length; i++) {
			if (cancelled || over) break;
			const f = files[i];
			const x = await zs.send_offer({ name: f.name, size: f.size, mtime: f.mtime ?? undefined, files_remaining: files.length - i, bytes_remaining: totalBytes - sentBefore });
			sentBefore += f.size;
			if (!x) {
				h.notice(`${f.name}: 서버가 건너뛰었습니다(같은 파일이 있을 수 있음)`);
				continue;
			}
			let off = x.get_offset() || 0;
			h.progress({ dir: "up", name: f.name, done: off, total: f.size, index: i + 1, count: files.length });
			if (f.size === 0) {
				await x.end([]);
			}
			while (off < f.size) {
				if (cancelled || over) break;
				const buf = new Uint8Array(await invoke<ArrayBuffer>("local_read_bytes", { path: f.path, max: CHUNK, offset: off }));
				if (!buf.length) throw new Error(`${f.name} 를 더 읽지 못했습니다`);
				off += buf.length;
				if (off >= f.size) await x.end(buf);
				else {
					await x.send(buf);
					// 보낸 것이 빠질 때까지 — 메모리에 쌓지 않는다
					await pending;
				}
				h.progress({ dir: "up", name: f.name, done: off, total: f.size, index: i + 1, count: files.length });
			}
			if (!cancelled && !over) sent++;
		}
		if (!cancelled && !over) {
			await zs.close();
			await pending;
		}
		finish(cancelled ? "올리기를 멈췄습니다" : `${sent}개 파일을 올렸습니다`, !cancelled && sent > 0);
	}

	return {
		/** 원격 출력 한 묶음 — done 은 이 묶음을 화면에 다 그렸거나(그대로 넘김) 여기서 삼켰을 때 한 번 */
		consume(b: Uint8Array, done?: () => void) {
			if (drain) {
				feedDrain(b);
				done?.();
				return;
			}
			if (!session && !busy && b.indexOf(ZDLE) < 0) {
				// 시작 신호가 묶음 경계에 걸칠 때를 위해 끝의 '*' 수만 기억
				let n = 0;
				while (n < 2 && b[b.length - 1 - n] === STAR) n++;
				lastStars = n;
				h.toTerminal(b, done);
				return;
			}
			done?.();
			if (session) lastIn = Date.now();
			let input = b;
			if (!session && lastStars && b.indexOf(ZDLE) <= 2) {
				input = new Uint8Array(lastStars + b.length);
				input.fill(STAR, 0, lastStars);
				input.set(b, lastStars);
			}
			lastStars = 0;
			try {
				sentry.consume(input);
			} catch (e) {
				h.toTerminal(b);
				finish(`rz/sz 처리 오류: ${String(e)}`);
			}
		},
		/** 세션 중(또는 취소 뒤 비우는 중)이면 사람의 입력은 셸로 보내지 않는다 */
		active: () => !!session || busy !== null || !!drain,
		cancel() {
			if (busy !== "session") return;
			cancelled = true;
			const up = session?.type === "send";
			try {
				session?.abort();
			} catch {
				// 이미 끝남
			}
			startDrain();
			finish(up ? "올리기를 멈췄습니다" : "받기를 멈췄습니다 — 서버가 멈출 때까지 남은 출력은 버립니다");
		},
		setEnabled(on: boolean) {
			enabled = on;
		},
		/** 터미널 칸이 사라질 때 — 진행 중이면 멈추고, 비우기·감시 타이머를 남기지 않는다(새 셸에 취소 신호가 가지 않게) */
		dispose() {
			try {
				session?.abort();
			} catch {
				// 이미 끝남
			}
			session = null; // 감시 타이머(watch)는 session 이 바뀌면 스스로 멈춘다
			if (drain) window.clearInterval(drain.tick);
			drain = null;
			disposed = true;
		},
	};
}

export type ZmodemBridge = ReturnType<typeof createZmodem>;
