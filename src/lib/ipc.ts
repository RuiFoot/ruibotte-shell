import { Channel, invoke } from "@tauri-apps/api/core";

export type AppInfo = {
	name: string;
	version: string;
	os: "windows" | "macos" | "linux" | string;
	arch: string;
	dataPath: string;
	portable: boolean;
	osBackdrop: boolean;
};

export type Profile = {
	id?: number;
	kind: "ssh" | "db";
	name: string;
	host: string;
	port: number;
	username: string;
	engine?: string | null;
	color?: string | null;
	favorite: boolean;
	lastUsedAt?: number | null;
};

export type GridColumn = { name: string; kind: string };
export type GridInfo = { columns: GridColumn[]; count: number; buildMs: number };
export type BenchResult = { bytes: number; chunks: number; send_ms: number };

/** Raw 바이너리 채널 — 받는 값은 ArrayBuffer(판에 따라 number[]) */
export function bytesChannel(onBytes: (b: Uint8Array) => void): Channel<ArrayBuffer | number[]> {
	const ch = new Channel<ArrayBuffer | number[]>();
	ch.onmessage = (m) => onBytes(m instanceof ArrayBuffer ? new Uint8Array(m) : Uint8Array.from(m));
	return ch;
}

export const api = {
	appInfo: () => invoke<AppInfo>("app_info"),
	ptyOpen: (cols: number, rows: number, onData: Channel<ArrayBuffer | number[]>) =>
		invoke<number>("pty_open", { cols, rows, onData }),
	ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
	ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
	ptyClose: (id: number) => invoke<void>("pty_close", { id }),
	benchStream: (bytes: number, onData: Channel<ArrayBuffer | number[]>) =>
		invoke<BenchResult>("bench_stream", { bytes, onData }),
	gridDemoOpen: (rows: number) => invoke<GridInfo>("grid_demo_open", { rows }),
	gridRows: (from: number, to: number) => invoke<string[][]>("grid_rows", { from, to }),
	gridClose: () => invoke<void>("grid_close"),
	profilesList: () => invoke<Profile[]>("profiles_list"),
	profileSave: (p: Profile) => invoke<number>("profile_save", { p }),
	profileDelete: (id: number) => invoke<void>("profile_delete", { id }),
};
