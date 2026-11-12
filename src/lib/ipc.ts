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

/** 인증 방식 — 에이전트는 SSH 만 */
export type AuthKind = "password" | "key" | "agent";
/** 계정의 sudo — 안 씀 · 켤 때 물음 · 저장한 암호 · 암호 없이(NOPASSWD) */
export type SudoMode = "off" | "ask" | "saved" | "nopasswd";

/** 서버(접속 정보)에 딸린 계정 하나 */
export type Account = {
	id?: number;
	profileId: number;
	/** 보이는 이름(비우면 사용자명) */
	label?: string | null;
	username: string;
	auth: AuthKind;
	keyPath?: string | null;
	sudo: SudoMode;
	/** sudo -u 대상(기본 root) */
	sudoUser: string;
	isDefault: boolean;
	lastUsedAt?: number | null;
	/** 읽기 전용 — 계정 암호(키 암호)가 OS 저장소에 있는지 */
	secretSaved?: boolean;
	/** 읽기 전용 — sudo 암호가 OS 저장소에 있는지 */
	sudoSaved?: boolean;
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
	/** 기본 계정 값(읽기용) — 새 서버를 만들 때는 이 값으로 기본 계정이 생긴다 */
	auth: AuthKind;
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
	/** 읽기 전용 — 이 서버의 계정(기본 계정이 맨 앞) */
	accounts?: Account[];
	/** 화면 전용 — 이 프로필 값이 어느 계정으로 채워졌는지(접속·다시 연결에 쓴다) */
	accountId?: number;
	/** DB: 이 SSH 서버(프로필)를 거쳐 접속(SSH 터널) */
	sshTunnelProfileId?: number | null;
	/** DB: 터널에 쓸 그 SSH 서버의 계정(비우면 기본 계정) */
	sshTunnelAccountId?: number | null;
	/** SSH: 새 터미널을 tmux 세션으로(끊겨도 다시 연결하면 이어짐) */
	tmux?: boolean;
};

/** DB 접속 요청에 붙이는 SSH 터널 값 — 서버 설정의 "거칠 SSH 서버" */
export function tunnelReq(p: Pick<Profile, "kind" | "sshTunnelProfileId" | "sshTunnelAccountId">, extra?: { sshSecret?: string | null; sshTrustFingerprint?: string | null; sshSaveSecret?: boolean }) {
	if (p.kind !== "db" || !p.sshTunnelProfileId) return {};
	return { sshProfileId: p.sshTunnelProfileId, sshAccountId: p.sshTunnelAccountId ?? null, ...extra };
}

/** 포트 포워딩 규칙 — local: 내 PC 포트 → 서버 쪽 대상, remote: 서버 포트 → 내 PC 쪽 대상, dynamic: 내 PC SOCKS5 */
export type ForwardKind = "local" | "remote" | "dynamic";
export type Forward = {
	id?: number;
	profileId: number;
	kind: ForwardKind;
	bindHost: string;
	bindPort: number;
	targetHost?: string | null;
	targetPort?: number | null;
	autoStart: boolean;
	label?: string | null;
};
/** 켜 둔 규칙의 지금 상태 */
export type ForwardActive = {
	id: number;
	conn: number;
	profileId: number;
	kind: ForwardKind;
	label?: string | null;
	/** 짧은 표시 — "3306→db:3306" */
	short: string;
	bindHost: string;
	port: number;
	targetHost?: string | null;
	targetPort?: number | null;
	open: number;
	total: number;
	up: number;
	down: number;
	error?: string | null;
	startedAt: number;
};
export type ForwardStatus = { active: ForwardActive[]; failed: { id: number; conn: number; label: string; error: string }[] };
export type TmuxSession = { name: string; windows: number; attached: number; created?: number | null; ours: boolean };

/** 규칙을 짧게(켜기 전 목록용) */
export function forwardShort(f: Pick<Forward, "kind" | "bindPort" | "targetHost" | "targetPort">): string {
	const t = `${f.targetHost ?? ""}:${f.targetPort ?? ""}`;
	if (f.kind === "dynamic") return `SOCKS ${f.bindPort}`;
	if (f.kind === "remote") return `서버 ${f.bindPort || "자동"}→${t}`;
	return `${f.bindPort}→${t}`;
}

export const forwards = {
	list: (profileId: number) => invoke<Forward[] | null>("forward_list", { profileId }).then((x) => x ?? []),
	save: (f: Forward) => invoke<number>("forward_save", { f }),
	remove: (id: number) => invoke<void>("forward_delete", { id }),
	start: (conn: number, id: number) => invoke<void>("forward_start", { conn, id }),
	stop: (id: number) => invoke<void>("forward_stop", { id }),
	status: (q: { conn?: number; profileId?: number }) =>
		invoke<ForwardStatus | null>("forward_status", { conn: q.conn ?? null, profileId: q.profileId ?? null }).then((x) => x ?? { active: [], failed: [] }),
};

export const tmux = {
	/** null = 서버에 tmux 가 없음 */
	list: (conn: number) => invoke<TmuxSession[] | null>("ssh_tmux_list", { conn }),
	kill: (conn: number, name: string) => invoke<void>("ssh_tmux_kill", { conn, name }),
};

/** 서버의 기본 계정(없으면 undefined) */
export function defaultAccount(p: Profile): Account | undefined {
	return p.accounts?.find((a) => a.isDefault) ?? p.accounts?.[0];
}

/** 계정 보이는 이름 */
export function accountName(a: Pick<Account, "label" | "username">): string {
	return a.label?.trim() || a.username || "(이름 없음)";
}

/** 계정으로 채운 접속용 프로필 — 사용자명·인증·키·저장 표시를 그 계정 값으로 */
export function withAccount(p: Profile, a?: Account): Profile {
	if (!a) return p;
	return { ...p, username: a.username, auth: a.auth, keyPath: a.keyPath, secretSaved: !!a.secretSaved, accountId: a.id };
}

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
	/** 쉬운 원인 설명(방화벽·사내망 등) */
	hint?: string;
	/** 어느 경로에서 난 오류인지 — 지문 확인 뒤 같은 경로로 다시 */
	routeId?: number;
	routeLabel?: string;
	/** 앞서 실패·건너뛴 경로들 */
	attempts?: string[];
};

export type ConnectReq = {
	profileId?: number;
	/** 이 계정으로(사용자명·인증·키·저장한 비밀을 계정 값으로) */
	accountId?: number;
	host: string;
	port: number;
	username: string;
	auth: AuthKind;
	keyPath?: string | null;
	secret?: string | null;
	legacy: LegacyLevel;
	trustFingerprint?: string | null;
	saveSecret?: boolean;
	jumpId?: number | null;
	/** 이 경로로만(지문 확인 뒤 같은 경로로 다시) */
	routeId?: number | null;
};

export type ConnectOk = {
	connId: number;
	home: string;
	fingerprint: string;
	algorithm: string;
	newlyPinned: boolean;
	usedSavedSecret: boolean;
	accountId?: number | null;
	username: string;
	/** 계정의 sudo 설정 — 작업대가 따른다 */
	sudo: SudoMode;
	sudoUser: string;
	/** 붙은 경로 */
	route?: RouteUsed;
};

/** 어느 경로로 붙었는지 */
export type RouteUsed = {
	id?: number | null;
	label: string;
	/** "점프 A → B · host:22" */
	summary: string;
	/** 서버에 저장한 경로 수(1 이하면 굳이 보이지 않는다) */
	total: number;
	/** 앞 경로가 실패했거나 건너뛰어 이 경로로 왔을 때 */
	note?: string;
};

/** 점프 단계 하나 — 거칠 SSH 서버와 그 계정(비우면 기본 계정) */
export type Hop = { profileId: number; accountId?: number | null };
export type ProxyKind = "http" | "socks5" | "command";
export type CondKind = "gateway" | "dns" | "wifi" | "reach";
/** 서버에 닿는 길 하나 */
export type Route = {
	id?: number;
	profileId: number;
	ord?: number;
	label?: string | null;
	host: string;
	port: number;
	jumps: Hop[];
	proxyKind?: ProxyKind | null;
	proxyHost?: string | null;
	proxyPort?: number | null;
	proxyUser?: string | null;
	/** %h %p %r %% 를 바꿔 실행 */
	proxyCommand?: string | null;
	/** 읽기 전용 */
	proxySecretSaved?: boolean;
	condKind?: CondKind | null;
	condValue?: string | null;
	condNot?: boolean;
	/** 읽기 전용 — 이 경로로 마지막에 붙은 때 */
	lastOkAt?: number | null;
};
/** 지금 PC 의 망 값 */
export type NetInfo = {
	gateways: string[];
	dnsSuffixes: string[];
	wifi: string[];
	supportsGateway: boolean;
	supportsDns: boolean;
	supportsWifi: boolean;
	wifiNote?: string;
};
export type DiagStep = { name: string; status: "ok" | "fail" | "warn" | "skip" | "info"; ms?: number; detail: string; hint?: string };
export type RouteDiag = { routeId?: number | null; label: string; summary: string; cond?: string; condState: "none" | "match" | "noMatch" | "unknown"; steps: DiagStep[]; ok: boolean };
export type DiagReport = { profile: string; account: string; net: NetInfo; routes: RouteDiag[]; at: number };

export const routes = {
	list: (profileId: number) => invoke<Route[] | null>("route_list", { profileId }).then((x) => x ?? []),
	/** proxySecret: 빈 값 = 지우기, 값 = 저장, undefined = 그대로 */
	save: (r: Route, proxySecret?: string) => invoke<number>("route_save", { r, proxySecret: proxySecret ?? null }),
	remove: (id: number) => invoke<void>("route_delete", { id }),
	reorder: (profileId: number, ids: number[]) => invoke<void>("route_reorder", { profileId, ids }),
	net: () => invoke<NetInfo>("net_info_get"),
	diagnose: (profileId: number, accountId?: number | null) => invoke<DiagReport>("ssh_diagnose", { profileId, accountId: accountId ?? null }),
	/** 열린 연결이 붙은 경로 */
	ofConn: (conn: number) => invoke<RouteUsed | null>("ssh_conn_route", { conn }),
	/** 가져온 서버의 첫 경로에 ProxyJump·ProxyCommand → 알릴 말 */
	importRoutes: (items: { profileId: number; proxyJump?: string | null; proxyCommand?: string | null }[]) => invoke<string[]>("import_routes", { items }),
};

export type FsEntry = {
	name: string;
	path: string;
	kind: "dir" | "file" | "link" | "other";
	size: number;
	mtime?: number | null;
	/** 심볼릭 링크면 가리키는 곳 */
	target?: string | null;
};
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
	/** 컨테이너 안 파일(docker exec) — 이름. SFTP 전송·끌어 놓기·실시간 보기 대상이 아니다 */
	container?: string;
};

export type TransferProgress = {
	id: number;
	/** relay = 내 PC 거쳐 서버 → 서버, direct = 서버끼리 바로 */
	direction: "up" | "down" | "relay" | "direct";
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
	/** 받는 서버 연결(서버 → 서버) — 끝나면 그 서버 트리를 새로 읽는다 */
	destConn?: number;
};

/** 시작한 전송의 조건 — 실패·취소 뒤 "다시(이어서)" 에 쓴다 */
export const transferArgs = new Map<number, { conn: number; direction: "up" | "down"; src: string; destDir: string; destName?: string }>();
/** 서버끼리 바로 보낸 전송의 조건 — 실패하면 "내 PC 거쳐서" 로 다시 보낼 때 쓴다 */
export const directArgs = new Map<number, { fromConn: number; src: string; toConn: number; destDir: string; overwrite: boolean; destName?: string }>();
/** 지금 도는 전송(앱을 끌 때 묻기) */
export const runningTransfers = new Set<number>();

export const transfers = {
	/** destName: 받는 쪽 이름(같은 이름이 있어 이름을 바꿔 보낼 때) */
	start: async (conn: number, direction: "up" | "down", src: string, destDir: string, overwrite: boolean, destName?: string) => {
		const id = await invoke<number>("transfer_start", { conn, direction, src, destDir, overwrite, destName });
		transferArgs.set(id, { conn, direction, src, destDir, destName });
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
	/** 원격: sudo 암호를 그 셸에 넣기 */
	sudoPw?(id: number): Promise<boolean>;
	/** 흐름 제어 — 화면이 그린 바이트 수(그만큼 더 보낸다) */
	ack?(id: number, n: number): Promise<void>;
	/** 원격: docker exec 로 들어간 컨테이너 셸에 프롬프트 훅을 건다(트리·편집기가 컨테이너를 따라가게) */
	injectCtx?(id: number, ctr: string): Promise<void>;
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
	ack: (id, n) => invoke("pty_ack", { id, n }),
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

/** sudo 로 다루는 원격 파일 시스템(같은 연결의 exec 채널) — sudo 설정·암호는 연결한 계정을 따른다 */
export function sshSudoFs(conn: number, label: string, home: string, sudoUser = "root"): FsBackend {
	const op = (op: string, path: string, to?: string) => invoke<void>("sudo_op", { conn, op, path, to });
	return {
		side: "remote",
		conn,
		label: `${label} (sudo${sudoUser && sudoUser !== "root" ? ` -u ${sudoUser}` : ""})`,
		home,
		sep: "/",
		list: (path) => invoke("sudo_list", { conn, path }),
		read: (path, encoding) => invoke("sudo_read_text", { conn, path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("sudo_write_text", { conn, path, text, meta, expectMtime }),
		mkdir: (path) => op("mkdir", path),
		touch: (path) => op("touch", path),
		rename: (from, to) => op("rename", from, to),
		remove: (path) => op("remove", path),
	};
}

/** 컨테이너 안 파일 — 서버에서 docker(podman) exec 로. 트리·편집기가 컨테이너를 따라갈 때 */
export function containerFs(conn: number, ctr: string, home = "/"): FsBackend {
	const op = (op: string, path: string, to?: string) => invoke<void>("ctr_op", { conn, ctr, op, path, to });
	return {
		side: "remote",
		conn,
		container: ctr,
		label: `컨테이너 ${ctr}`,
		home,
		sep: "/",
		list: (path) => invoke("ctr_list", { conn, ctr, path }),
		read: (path, encoding) => invoke("ctr_read_text", { conn, ctr, path, encoding }),
		write: (path, text, meta, expectMtime) => invoke("ctr_write_text", { conn, ctr, path, text, meta, expectMtime }),
		mkdir: (path) => op("mkdir", path),
		touch: (path) => op("touch", path),
		rename: (from, to) => op("rename", from, to),
		remove: (path) => op("remove", path),
	};
}

export const sudoApi = {
	/** 되는지 보기 — 넣은 암호는 이 연결 동안 기억, save 면 계정의 sudo 암호로 저장 */
	check: (conn: number, password: string | null, save: boolean) => invoke<boolean>("sudo_check", { conn, password, save }),
};

/** 바깥에서 셸을 다루는 손잡이 — 글 넣기, 출력에서 글귀 기다리기 */
export type ShellHandle = {
	send: (s: string) => void;
	expect: (re: RegExp, ms: number) => Promise<boolean>;
	/** 프롬프트에서 아무것도 치지 않고 기다리는 중인지(셸 통합이 없으면 늘 true) */
	idle?: () => boolean;
	/** 원격: sudo 암호를 이 셸에 넣기(값은 화면을 거치지 않는다) — 넣을 암호가 없으면 false */
	sudoPw?: () => Promise<boolean>;
	/** 명령 입력 보조(D25) — 리눅스 셸 터미널만. 폼 열기·풀이·빈칸 템플릿 넣기 */
	assist?: (a: { kind: "form"; id?: string } | { kind: "explain" } | { kind: "template"; text: string }) => void;
};

export function sshTerm(conn: number): TermBackend {
	return {
		open: (cols, rows, onData, cwd) => invoke<number>("ssh_shell_open", { conn, cols, rows, cwd, onData }),
		write: (shell, data, encoding) => invoke("ssh_shell_write", { conn, shell, data, encoding }),
		resize: (shell, cols, rows) => invoke("ssh_shell_resize", { conn, shell, cols, rows }),
		close: (shell) => invoke("ssh_shell_close", { conn, shell }),
		sudoPw: (shell) => invoke<boolean>("ssh_shell_sudo_pw", { conn, shell }),
		ack: (shell, n) => invoke("ssh_shell_ack", { conn, shell, n }),
		injectCtx: (shell, ctr) => invoke("ssh_shell_inject_ctx", { conn, shell, ctr }),
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
	accountsList: (profileId: number) => invoke<Account[]>("accounts_list", { profileId }),
	accountSave: (a: Account) => invoke<number>("account_save", { a }),
	accountDelete: (id: number) => invoke<void>("account_delete", { id }),
	accountSetDefault: (id: number) => invoke<void>("account_set_default", { id }),
	/** 빈 값이면 지운다 */
	accountSecretSet: (id: number, secret: string) => invoke<void>("account_secret_set", { id, secret }),
	/** 빈 값이면 지운다(sudo 는 "물어보기"로) */
	accountSudoSecretSet: (id: number, secret: string) => invoke<void>("account_sudo_secret_set", { id, secret }),
	hostKeyGet: (host: string, port: number) => invoke<{ algorithm: string; fingerprint: string; pinnedAt: number } | null>("host_key_get", { host, port }),
};
