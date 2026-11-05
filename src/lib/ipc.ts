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
	/** 거쳐 갈 SSH 프로필(점프 호스트) */
	jumpId?: number | null;
	/** 연결 묶음(폴더) */
	groupName?: string | null;
	/** DB SSL: off · prefer · require · verify */
	ssl?: string | null;
	/** 메모 */
	memo?: string | null;
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
	jumpId?: number | null;
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
	/** remote = SFTP, local = 내 PC */
	side: "remote" | "local";
	/** 원격이면 연결 번호(전송용) */
	conn?: number;
	label: string;
	home: string;
	sep: "/";
	list(path: string): Promise<FsEntry[]>;
	read(path: string, encoding?: string): Promise<FileText>;
	write(path: string, text: string, meta: TextMeta, expectMtime?: number | null): Promise<Saved>;
	mkdir(path: string): Promise<void>;
	touch(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** 원격은 바로 지우고(폴더는 안까지), 내 PC 는 휴지통으로 */
	remove(path: string): Promise<unknown>;
	/** 같은 쪽 안에서 복사(폴더는 안까지, 같은 이름이면 거절) */
	copy?(from: string, to: string): Promise<unknown>;
};

export type TransferProgress = {
	id: number;
	direction: "up" | "down" | "relay";
	name: string;
	dest: string;
	bytesDone: number;
	bytesTotal: number;
	filesDone: number;
	filesTotal: number;
	skipped: number;
	verified: number;
	resumed: number;
	state: "running" | "done" | "error" | "cancelled";
	error?: string | null;
	ms: number;
};

/** 시작한 전송의 조건 — 실패·취소 뒤 "다시(이어서)" 에 쓴다 */
export const transferArgs = new Map<number, { conn: number; direction: "up" | "down"; src: string; destDir: string }>();
/** 지금 도는 전송(앱을 끌 때 묻기) */
export const runningTransfers = new Set<number>();

export const transfers = {
	start: async (conn: number, direction: "up" | "down", src: string, destDir: string, overwrite: boolean) => {
		const id = await invoke<number>("transfer_start", { conn, direction, src, destDir, overwrite });
		transferArgs.set(id, { conn, direction, src, destDir });
		return id;
	},
	cancel: (id: number) => invoke<void>("transfer_cancel", { id }),
};

/** 폴더 내용이 바뀌었음을 트리들에 알림(전송·파일 조작 뒤) */
export function notifyFsChanged(side: "remote" | "local", dir: string, conn?: number) {
	window.dispatchEvent(new CustomEvent("rb-fs-changed", { detail: { side, dir, conn } }));
}

export function parentDir(p: string): string {
	const t = p.replace(/\/+$/, "");
	const i = t.lastIndexOf("/");
	if (i <= 0) return /^[A-Za-z]:/.test(t) ? `${t.slice(0, 2)}/` : "/";
	const d = t.slice(0, i);
	return /^[A-Za-z]:$/.test(d) ? `${d}/` : d;
}

export function joinPath(dir: string, name: string): string {
	return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/** 터미널이 보는 셸 — 원격(SSH 채널)과 내 PC(PTY) 가 같은 모양 */
export type TermBackend = {
	open(cols: number, rows: number, onData: Channel<ArrayBuffer | number[]>, cwd?: string, shell?: string): Promise<number>;
	/** encoding: 터미널 인코딩(UTF-8 이 아니면 원격이 그 인코딩으로 바꿔 보낸다) */
	write(id: number, data: string, encoding?: string): Promise<void>;
	resize(id: number, cols: number, rows: number): Promise<void>;
	close(id: number): Promise<void>;
	/** 셸이 끝났을 때 이벤트 이름과 그 이벤트가 이 셸 것인지 */
	exitEvent: string;
	isMine(payload: unknown, id: number): boolean;
};

export function localFs(home: string): FsBackend {
	return {
		side: "local",
		label: "내 PC",
		home,
		sep: "/",
		list: (path) => invoke("local_list", { path }),
		read: (path, encoding) => invoke("local_read_text", { path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("local_write_text", { path, text, meta, expectMtime }),
		mkdir: (path) => invoke("local_mkdir", { path }),
		touch: (path) => invoke("local_touch", { path }),
		rename: (from, to) => invoke("local_rename", { from, to }),
		remove: (path) => invoke("local_trash", { path }),
		copy: (from, to) => invoke("local_copy", { from, to }),
	};
}

/** 내 PC 셸 — pwsh·cmd·bash·zsh·wsl 에 따라 셸 통합·자동완성이 다르다 */
export type ShellInfo = { id: string; label: string; program: string; args: string[]; kind: "pwsh" | "cmd" | "bash" | "zsh" | "wsl" | "other"; admin: boolean };
let shellsCache: Promise<ShellInfo[]> | null = null;
export const localShells = () => {
	shellsCache ??= invoke<ShellInfo[]>("pty_shells").catch(() => []);
	return shellsCache;
};

export const localTerm: TermBackend = {
	open: (cols, rows, onData, cwd, shell) => invoke<number>("pty_open", { cols, rows, onData, cwd, shell }),
	write: (id, data) => invoke("pty_write", { id, data }),
	resize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
	close: (id) => invoke("pty_close", { id }),
	exitEvent: "pty-exit",
	isMine: (p, id) => (p as { id: number }).id === id,
};

export function sshFs(conn: number, label: string, home: string): FsBackend {
	return {
		side: "remote",
		conn,
		label,
		home,
		sep: "/",
		list: (path) => invoke("sftp_list", { conn, path }),
		read: (path, encoding) => invoke("sftp_read_text", { conn, path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("sftp_write_text", { conn, path, text, meta, expectMtime }),
		mkdir: (path) => invoke("sftp_mkdir", { conn, path }),
		touch: (path) => invoke("sftp_touch", { conn, path }),
		rename: (from, to) => invoke("sftp_rename", { conn, from, to }),
		remove: (path) => invoke("sftp_remove", { conn, path }),
		copy: (from, to) => invoke("ssh_copy", { conn, from, to }),
	};
}

/** sudo 로 다루는 원격 파일 시스템(같은 연결의 exec 채널) */
export function sshSudoFs(conn: number, label: string, home: string, profileId?: number): FsBackend {
	const op = (op: string, path: string, to?: string) => invoke<void>("sudo_op", { conn, profileId, op, path, to });
	return {
		side: "remote",
		conn,
		label: `${label} (sudo)`,
		home,
		sep: "/",
		list: (path) => invoke("sudo_list", { conn, profileId, path }),
		read: (path, encoding) => invoke("sudo_read_text", { conn, profileId, path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("sudo_write_text", { conn, profileId, path, text, meta, expectMtime }),
		mkdir: (path) => op("mkdir", path),
		touch: (path) => op("touch", path),
		rename: (from, to) => op("rename", from, to),
		remove: (path) => op("remove", path),
	};
}

export const sudoApi = {
	check: (conn: number, profileId: number | undefined, password: string | null, save: boolean) =>
		invoke<boolean>("sudo_check", { conn, profileId, password, save }),
};

/** 바깥에서 셸을 다루는 손잡이 — 글 넣기, 출력에서 글귀 기다리기 */
export type ShellHandle = {
	send: (s: string) => void;
	expect: (re: RegExp, ms: number) => Promise<boolean>;
	/** 프롬프트에서 아무것도 치지 않고 기다리는 중인지(셸 통합이 없으면 늘 true) */
	idle?: () => boolean;
};

export function sshTerm(conn: number): TermBackend {
	return {
		open: (cols, rows, onData, cwd) => invoke<number>("ssh_shell_open", { conn, cols, rows, cwd, onData }),
		write: (shell, data, encoding) => invoke("ssh_shell_write", { conn, shell, data, encoding }),
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
	settingGet: (key: string) => invoke<string | null>("setting_get", { key }),
	settingSet: (key: string, value: string) => invoke<void>("setting_set", { key, value }),
	profilesList: () => invoke<Profile[]>("profiles_list"),
	profileSave: (p: Profile) => invoke<number>("profile_save", { p }),
	profileDelete: (id: number) => invoke<void>("profile_delete", { id }),
};
