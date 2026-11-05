import { invoke } from "@tauri-apps/api/core";

/** 지역 시각 "YYYY-MM-DD_HHMMSS" */
function stamp(d = new Date()) {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const tz = () => -new Date().getTimezoneOffset();

export type LogOptions = { dir: string; strip: boolean; timestamps: boolean };

/**
 * 터미널 세션 기록 — 출력 바이트를 모아(시각을 붙이면 0.25초, 아니면 1초·256 KiB 마다) Rust 로 보낸다.
 * 쓰기는 하나씩 차례로(순서가 섞이지 않게).
 */
export class SessionRecorder {
	readonly path: string;
	private id: number;
	private buf: Uint8Array[] = [];
	private size = 0;
	private timer: number | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private closed = false;
	private readonly every: number;

	private constructor(id: number, path: string, every: number) {
		this.id = id;
		this.path = path;
		this.every = every;
	}

	static async start(server: string, o: LogOptions): Promise<SessionRecorder> {
		const r = await invoke<{ id: number; path: string }>("session_log_open", {
			server,
			dir: o.dir || null,
			fileStamp: stamp(),
			tzOffsetMin: tz(),
			stripAnsi: o.strip,
			timestamps: o.timestamps,
		});
		return new SessionRecorder(r.id, r.path, o.timestamps ? 250 : 1000);
	}

	push(b: Uint8Array) {
		if (this.closed || !b.length) return;
		this.buf.push(b);
		this.size += b.length;
		if (this.size >= 256 * 1024) this.flush();
		else if (this.timer === undefined) this.timer = window.setTimeout(() => this.flush(), this.every);
	}

	private flush() {
		window.clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.buf.length) return this.chain;
		const all = new Uint8Array(this.size);
		let o = 0;
		for (const c of this.buf) {
			all.set(c, o);
			o += c.length;
		}
		this.buf = [];
		this.size = 0;
		const id = this.id;
		this.chain = this.chain.then(() => invoke("session_log_write", all, { headers: { "x-id": String(id) } })).catch(() => {});
		return this.chain;
	}

	async stop() {
		if (this.closed) return;
		this.flush();
		this.closed = true;
		await this.chain;
		await invoke("session_log_close", { id: this.id, tzOffsetMin: tz() }).catch(() => {});
	}
}

export const revealLogDir = (dir: string, server?: string) => invoke<void>("session_log_reveal", { dir: dir || null, server: server ?? null });
export const defaultLogDir = () => invoke<string>("session_log_default_dir");
