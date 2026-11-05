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

export type LegacyLevel = "off" | "rsa" | "sha1" | "weakest";

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
	auth: "password" | "key";
	keyPath?: string | null;
	legacy: LegacyLevel;
	defaultPath?: string | null;
	database?: string | null;
	/** 읽기 전용 — OS 저장소에 비밀이 있는지 */
	secretSaved?: boolean;
};

export type SshError = {
	code:
		| "HOSTKEY_UNKNOWN"
		| "HOSTKEY_MISMATCH"
		| "NEGOTIATION"
		| "AUTH_FAILED"
		| "NEED_SECRET"
		| "NETWORK"
		| "CLOSED"
		| "SFTP"
		| "CONFLICT"
		| "ENCODING"
		| "OTHER";
	message: string;
	fingerprint?: string;
	algorithm?: string;
	pinnedFingerprint?: string;
	kind?: string;
	theirs?: string[];
	suggest?: LegacyLevel;
};

export type ConnectReq = {
	profileId?: number;
	host: string;
	port: number;
	username: string;
	auth: "password" | "key";
	keyPath?: string | null;
	secret?: string | null;
	legacy: LegacyLevel;
	trustFingerprint?: string | null;
	saveSecret?: boolean;
};

export type ConnectOk = {
	connId: number;
	home: string;
	fingerprint: string;
	algorithm: string;
	newlyPinned: boolean;
	usedSavedSecret: boolean;
};

export type FsEntry = { name: string; path: string; kind: "dir" | "file" | "link" | "other"; size: number; mtime?: number | null };
export type TextMeta = { encoding: string; bom: boolean; eol: "LF" | "CRLF" | "CR"; guessed: boolean };
export type FileText = {
	path: string;
	size: number;
	mtime?: number | null;
	text?: string | null;
	meta: TextMeta;
	binary: boolean;
	tooLarge: boolean;
};
export type Saved = { size: number; mtime?: number | null };

/** 오류를 SshError 꼴로(문자열 오류도) */
export function asSshError(e: unknown): SshError {
	if (e && typeof e === "object" && "code" in e) return e as SshError;
	return { code: "OTHER", message: String(e) };
}

/** 트리·편집기가 보는 파일 시스템 — 원격(SFTP)과 내 PC 가 같은 모양 */
export type FsBackend = {
	label: string;
	home: string;
	sep: "/";
	list(path: string): Promise<FsEntry[]>;
	read(path: string, encoding?: string): Promise<FileText>;
	write(path: string, text: string, meta: TextMeta, expectMtime?: number | null): Promise<Saved>;
};

/** 터미널이 보는 셸 — 원격(SSH 채널)과 내 PC(PTY) 가 같은 모양 */
export type TermBackend = {
	open(cols: number, rows: number, onData: Channel<ArrayBuffer | number[]>, cwd?: string): Promise<number>;
	write(id: number, data: string): Promise<void>;
	resize(id: number, cols: number, rows: number): Promise<void>;
	close(id: number): Promise<void>;
	/** 셸이 끝났을 때 이벤트 이름과 그 이벤트가 이 셸 것인지 */
	exitEvent: string;
	isMine(payload: unknown, id: number): boolean;
};

export function localFs(home: string): FsBackend {
	return {
		label: "내 PC",
		home,
		sep: "/",
		list: (path) => invoke("local_list", { path }),
		read: (path, encoding) => invoke("local_read_text", { path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("local_write_text", { path, text, meta, expectMtime }),
	};
}

export const localTerm: TermBackend = {
	open: (cols, rows, onData) => invoke<number>("pty_open", { cols, rows, onData }),
	write: (id, data) => invoke("pty_write", { id, data }),
	resize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
	close: (id) => invoke("pty_close", { id }),
	exitEvent: "pty-exit",
	isMine: (p, id) => (p as { id: number }).id === id,
};

export function sshFs(conn: number, label: string, home: string): FsBackend {
	return {
		label,
		home,
		sep: "/",
		list: (path) => invoke("sftp_list", { conn, path }),
		read: (path, encoding) => invoke("sftp_read_text", { conn, path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("sftp_write_text", { conn, path, text, meta, expectMtime }),
	};
}

export function sshTerm(conn: number): TermBackend {
	return {
		open: (cols, rows, onData, cwd) => invoke<number>("ssh_shell_open", { conn, cols, rows, cwd, onData }),
		write: (shell, data) => invoke("ssh_shell_write", { conn, shell, data }),
		resize: (shell, cols, rows) => invoke("ssh_shell_resize", { conn, shell, cols, rows }),
		close: (shell) => invoke("ssh_shell_close", { conn, shell }),
		exitEvent: "ssh-shell-exit",
		isMine: (p, id) => {
			const x = p as { conn: number; shell: number };
			return x.conn === conn && x.shell === id;
		},
	};
}

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
	localHome: () => invoke<string>("local_home"),
	sshConnect: (req: ConnectReq) => invoke<ConnectOk>("ssh_connect", { req }),
	sshDisconnect: (conn: number) => invoke<void>("ssh_disconnect", { conn }),
	secretForget: (profileId: number) => invoke<void>("secret_forget", { profileId }),
	profilesList: () => invoke<Profile[]>("profiles_list"),
	profileSave: (p: Profile) => invoke<number>("profile_save", { p }),
	profileDelete: (id: number) => invoke<void>("profile_delete", { id }),
};
