/**
 * 화면 점검용 가짜 백엔드 — `pnpm dev` 를 일반 브라우저로 열 때만 쓴다(Tauri 창·배포판에는 들어가지 않음).
 * 모든 화면을 Rust 없이 띄워 보고 고치기 위한 것이다. 값은 그럴듯한 예시일 뿐이다.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Args = Record<string, unknown>;
const now = Math.floor(Date.now() / 1000);

const settings = new Map<string, string>();
const profiles: Record<string, any>[] = [
	{ id: 1, kind: "ssh", name: "개발 서버", host: "dev.example.com", port: 22, username: "deploy", color: "#0a84ff", favorite: true, auth: "key", keyPath: "~/.ssh/id_ed25519", legacy: "off", defaultPath: null, database: null, secretSaved: true, lastUsedAt: now - 3600, groupName: "개발" },
	{ id: 2, kind: "ssh", name: "구형 로그 서버", host: "10.0.0.6", port: 22, username: "root", color: "#ff9f0a", favorite: true, auth: "password", legacy: "sha1", defaultPath: "/var/log", database: null, secretSaved: false, lastUsedAt: now - 86400 * 3, groupName: "개발" },
	{ id: 3, kind: "db", name: "운영 PostgreSQL", host: "db.example.com", port: 5432, username: "app", engine: "postgres", color: "#30d158", favorite: true, auth: "password", legacy: "off", database: "app", secretSaved: true, lastUsedAt: now - 7200, groupName: "운영" },
	{ id: 4, kind: "db", name: "레거시 MariaDB", host: "10.0.0.9", port: 3306, username: "ro", engine: "mariadb", color: "#bf5af2", favorite: false, auth: "password", legacy: "off", database: "RSA", secretSaved: false },
	{ id: 5, kind: "db", name: "Oracle 회계", host: "10.0.0.12", port: 1521, username: "acc", engine: "oracle", color: "#8e8e93", favorite: false, auth: "password", legacy: "off", database: "ORCL", secretSaved: false },
];

// 계정 — 서버 하나에 여럿(기본 계정이 앞)
let accSeq = 100;
const accounts: Record<string, any>[] = profiles.map((p) => ({
	id: ++accSeq,
	profileId: p.id,
	label: null,
	username: p.username,
	auth: p.auth,
	keyPath: p.keyPath ?? null,
	sudo: p.kind === "ssh" ? "ask" : "off",
	sudoUser: "root",
	isDefault: true,
	lastUsedAt: p.lastUsedAt ?? null,
	secretSaved: p.secretSaved,
	sudoSaved: false,
}));
accounts.push({ id: ++accSeq, profileId: 1, label: "운영 배포", username: "release", auth: "agent", keyPath: null, sudo: "nopasswd", sudoUser: "root", isDefault: false, lastUsedAt: (now - 600) * 1000, secretSaved: false, sudoSaved: false });
accounts.push({ id: ++accSeq, profileId: 1, label: null, username: "postgres", auth: "password", keyPath: null, sudo: "saved", sudoUser: "postgres", isDefault: false, lastUsedAt: null, secretSaved: true, sudoSaved: true });
const accsOf = (pid: number) =>
	accounts.filter((a) => a.profileId === pid).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
const withAccs = (p: Record<string, any>) => {
	const list = accsOf(p.id).map((a) => ({ ...a }));
	const d = list[0];
	return d ? { ...p, username: d.username, auth: d.auth, keyPath: d.keyPath, secretSaved: d.secretSaved, accounts: list } : { ...p, accounts: list };
};

function dir(path: string) {
	const p = path.replace(/\/$/, "") || "";
	if (p === "") return ["etc", "home", "opt", "usr", "var"].map((n) => ({ name: n, path: `/${n}`, kind: "dir", size: 4096, mtime: now }));
	if (p === "/home") return ["app", "deploy"].map((n) => ({ name: n, path: `/home/${n}`, kind: "dir", size: 4096, mtime: now }));
	const names = ["app", "logs", "conf", ".ssh", "backup-2026-11-01", "README.md", "app.log", "deploy.sh", "config.yaml", "data.csv", "image.png", "very-long-file-name-for-overflow-check-2026-11-05.tar.gz"];
	return names.map((n, i) => ({ name: n, path: `${p}/${n}`, kind: i < 5 ? "dir" : "file", size: i < 5 ? 4096 : 1200 * (i + 1) * (i + 3), mtime: now - i * 4000 }));
}

function sendChannel(ch: unknown, text: string) {
	const id = typeof ch === "object" && ch ? (ch as { id: number }).id : Number(String(ch).replace("__CHANNEL__:", ""));
	const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } }).__TAURI_INTERNALS__;
	const bytes = Array.from(new TextEncoder().encode(text));
	setTimeout(() => internals.runCallback(id, { index: 0, message: bytes }), 120);
}

const prompt = "\x1b]133;A\x07\x1b[1;32mdeploy@dev\x1b[0m:\x1b[1;34m~\x1b[0m$ ";
const banner = `Last login: Thu Nov  5 09:12:44 2026 from 10.0.0.2\r\n\x1b]7;file://dev/home/deploy\x07${prompt}`;

let tick = 0;
function stats() {
	tick += 1;
	const t = tick * 300;
	return {
		atMs: Date.now(),
		host: "dev-app-01",
		kernel: "Linux 5.14.0-427.el9.x86_64",
		ncpu: 8,
		uptimeS: 86400 * 41 + 3600 * 5,
		load: [1.42, 1.1, 0.96],
		running: 3,
		cpu: Array.from({ length: 9 }, (_, i) => ({ busy: t * (i === 0 ? 8 : 1) * (0.2 + (i % 4) * 0.15) + tick * 5, iowait: tick * 3, total: t * (i === 0 ? 8 : 1) + 1000 })),
		mem: { total: 16384000, available: 5100000, free: 900000, buffers: 200000, cached: 4100000, swapTotal: 4194300, swapFree: 3900000 },
		net: [{ name: "eth0", rx: tick * 1_400_000, tx: tick * 380_000 }],
		disks: [
			{ fs: "/dev/mapper/rl-root", kind: "xfs", sizeK: 73400320, usedK: 41200000, availK: 32200320, mount: "/" },
			{ fs: "/dev/sda1", kind: "xfs", sizeK: 1038336, usedK: 380000, availK: 658336, mount: "/boot" },
			{ fs: "/dev/sdb1", kind: "ext4", sizeK: 524288000, usedK: 470000000, availK: 54288000, mount: "/data" },
			{ fs: "/dev/sdc1", kind: "ext4", sizeK: 209715200, usedK: 203000000, availK: 6715200, mount: "/var/log" },
		],
		io: [{ name: "sda", read: tick * 2000, write: tick * 9000 }],
		procs: [
			["java", "app", 21, 2_100_000],
			["postgres", "postgres", 9, 820_000],
			["nginx", "nginx", 2, 30_000],
			["sshd", "root", 0, 8_000],
			["node", "deploy", 5, 410_000],
			["systemd", "root", 0, 12_000],
			["kworker/u16:2-events_unbound", "root", 1, 0],
			["rsyslogd", "root", 0, 6_000],
		].map(([name, user, w, rss], i) => ({ pid: 1000 + i * 37, user, ticks: (w as number) * tick * 10, rssK: rss, state: i === 6 ? "D" : "S", name })),
	};
}

export function installMock() {
	mockWindows("main");
	mockIPC(
		(cmd: string, a?: unknown) => {
			const args = (a ?? {}) as Args;
			switch (cmd) {
				case "app_info":
					return { name: "RuiBotte Shell", version: "0.6.0", os: "windows", arch: "x86_64", dataPath: "C:/Users/me/AppData/Roaming/RuiBotte Shell", portable: false, osBackdrop: false };
				case "profiles_list":
					return profiles.map(withAccs);
				case "profile_save": {
					const { accounts: _a, ...p } = (args as { p: Record<string, any> }).p;
					const i = profiles.findIndex((x) => x.id === p.id);
					if (i >= 0) profiles[i] = { ...profiles[i], ...p };
					else {
						const id = Math.max(0, ...profiles.map((x) => x.id)) + 1;
						profiles.push({ ...p, id });
						accounts.push({ id: ++accSeq, profileId: id, label: null, username: p.username, auth: p.auth, keyPath: p.keyPath ?? null, sudo: "off", sudoUser: "root", isDefault: true, lastUsedAt: null, secretSaved: false, sudoSaved: false });
					}
					return p.id ?? profiles[profiles.length - 1].id;
				}
				case "accounts_list":
					return accsOf(Number(args.profileId)).map((a) => ({ ...a }));
				case "account_save": {
					const a = (args as { a: Record<string, any> }).a;
					const list = accsOf(a.profileId);
					if (!String(a.username ?? "").trim()) throw "사용자명을 입력하세요";
					let id = a.id;
					if (id != null) {
						const i = accounts.findIndex((x) => x.id === id);
						accounts[i] = { ...accounts[i], ...a, sudoUser: a.sudoUser || "root" };
					} else {
						id = ++accSeq;
						accounts.push({ ...a, id, sudoUser: a.sudoUser || "root", isDefault: list.length === 0, secretSaved: false, sudoSaved: false, lastUsedAt: null });
					}
					if (a.isDefault) for (const x of accounts) if (x.profileId === a.profileId) x.isDefault = x.id === id;
					return id;
				}
				case "account_delete": {
					const i = accounts.findIndex((x) => x.id === args.id);
					const a = accounts[i];
					if (accsOf(a.profileId).length <= 1) throw { code: "OTHER", message: "서버에 남은 마지막 계정이라 지울 수 없습니다. 서버째 지우려면 서버 설정에서 '지우기'를 쓰세요." };
					accounts.splice(i, 1);
					if (a.isDefault) accsOf(a.profileId)[0].isDefault = true;
					return null;
				}
				case "account_set_default": {
					const a = accounts.find((x) => x.id === args.id);
					if (a) for (const x of accounts) if (x.profileId === a.profileId) x.isDefault = x.id === a.id;
					return null;
				}
				case "account_secret_set": {
					const a = accounts.find((x) => x.id === args.id);
					if (a) a.secretSaved = !!args.secret;
					return null;
				}
				case "account_sudo_secret_set": {
					const a = accounts.find((x) => x.id === args.id);
					if (a) {
						a.sudoSaved = !!args.secret;
						a.sudo = args.secret ? "saved" : a.sudo === "saved" ? "ask" : a.sudo;
					}
					return null;
				}
				case "host_key_get":
					return args.host === "dev.example.com" ? { algorithm: "ssh-ed25519", fingerprint: "SHA256:Qm9vZGxlc2Ftc3BsZWZpbmdlcnByaW50MTIzNA", pinnedAt: Date.now() } : null;
				case "profile_delete": {
					const i = profiles.findIndex((x) => x.id === (args as { id: number }).id);
					if (i >= 0) profiles.splice(i, 1);
					return null;
				}
				case "setting_get":
					return settings.get((args as { key: string }).key) ?? null;
				case "setting_set":
					settings.set((args as { key: string; value: string }).key, (args as { key: string; value: string }).value);
					return null;
				case "local_home":
					return "C:/Users/me";
				case "local_list":
				case "sftp_list":
				case "sudo_list":
					return dir(String(args.path ?? "/"));
				case "sftp_realpath":
					return String(args.path ?? "/home/deploy");
				case "ssh_connect": {
					const req = (args as { req: Record<string, any> }).req;
					const a = accounts.find((x) => x.id === req.accountId);
					if (a) a.lastUsedAt = Date.now();
					return { connId: 1, home: "/home/deploy", fingerprint: "SHA256:abcd", algorithm: "ssh-ed25519", newlyPinned: false, usedSavedSecret: true, accountId: a?.id ?? null, username: a?.username ?? req.username, sudo: a?.sudo ?? "ask", sudoUser: a?.sudoUser ?? "root", route: { id: 12, label: "외부 · 점프", summary: "점프 구형 로그 서버 · 10.0.0.5:22", total: 3, note: "사내 직접 건너뜀 — 망 조건이 맞지 않음" } };
				}
				case "ssh_shell_open":
				case "pty_open":
					sendChannel(args.onData, banner);
					return 1;
				case "ssh_test":
					return new Promise((r) => setTimeout(() => r({ ms: 142, home: "/home/deploy", fingerprint: "SHA256:abcd", algorithm: "ssh-ed25519", newlyPinned: false }), 400));
				case "db_test":
					return { ms: 38, version: "PostgreSQL 18.6" };
				case "ssh_stats":
					return stats();
				case "ssh_du":
					return [
						{ name: ".", sizeK: 41200000 },
						{ name: "var", sizeK: 22000000 },
						{ name: "opt", sizeK: 12000000 },
						{ name: "usr", sizeK: 5200000 },
						{ name: "home", sizeK: 1800000 },
						{ name: "etc", sizeK: 32000 },
					];
				case "sftp_read_text":
				case "local_read_text":
					if (String(args.path).endsWith(".csv"))
						return { path: args.path, size: 200, mtime: now, text: "이름;부서;연봉\n김철수;개발;5,200\n이영희;영업;4,800\n박민수;개발;6,100\n", meta: { encoding: "UTF-8", bom: false, eol: "LF", guessed: false }, binary: false, tooLarge: false };
					return { path: args.path, size: 320, mtime: now, text: "server:\n  port: 8080\n  name: \"앱\"\n# 설정\n", meta: { encoding: "UTF-8", bom: false, eol: "LF", guessed: false }, binary: false, tooLarge: false };
				case "snippets_list":
				case "history_list":
				case "import_candidates":
					return [];
				case "db_connect":
					return { connId: 7, version: "PostgreSQL 18.6", database: "app", usedSavedSecret: true, features: ["explain", "sessions", "locks", "sizes", "ddl"] };
				case "db_tree": {
					const p = (args.path as string[]) ?? [];
					if (p.length === 0) return ["public", "audit"].map((n) => ({ name: n, kind: "schema" }));
					if (p.length === 1) return ["customer", "orders", "order_item", "product", "v_sales"].map((n, i) => ({ name: n, kind: i === 4 ? "view" : "table", detail: i === 4 ? null : `${(i + 1) * 1200}행` }));
					return ["id", "name", "created_at", "status"].map((n, i) => ({ name: n, kind: "column", detail: ["bigint PK", "varchar(200)", "timestamptz", "text"][i] }));
				}
				case "db_query":
					return { resultId: 1, columns: [{ name: "id", kind: "int" }, { name: "name", kind: "text" }, { name: "created_at", kind: "datetime" }, { name: "status", kind: "text" }], rowCount: 240, truncated: false, ms: 12, firstRowMs: 4 };
				case "db_rows": {
					const from = Number(args.from);
					const to = Number(args.to);
					return Array.from({ length: Math.max(0, Math.min(240, to) - from) }, (_, i) => [String(from + i + 1), `고객 ${from + i + 1}`, "2026-11-05 09:00:00", i % 7 === 0 ? null : "active"]);
				}
				case "db_view":
					return args.filter ? 37 : 240;
				case "db_table_meta":
					return [
						{ name: "id", dataType: "bigint", nullable: false, pk: true },
						{ name: "name", dataType: "varchar(200)", nullable: false, pk: false },
						{ name: "created_at", dataType: "timestamptz", nullable: true, pk: false },
						{ name: "status", dataType: "text", nullable: true, pk: false },
					];
				case "jdbc_status":
					return { java: false, drivers: [] };
				// 경로·진단(화면 점검용)
				case "route_list":
					return Number(args.profileId) === 1
						? [
								{ id: 11, profileId: 1, ord: 0, label: "사내 직접", host: "dev.example.com", port: 22, jumps: [], condKind: "dns", condValue: "corp.example", condNot: false, lastOkAt: now - 3600 },
								{ id: 12, profileId: 1, ord: 1, label: "외부 · 점프", host: "10.0.0.5", port: 22, jumps: [{ profileId: 2 }], lastOkAt: null },
								{ id: 13, profileId: 1, ord: 2, label: "프록시", host: "dev.example.com", port: 22, jumps: [], proxyKind: "socks5", proxyHost: "127.0.0.1", proxyPort: 1080, proxyUser: "u", proxySecretSaved: true },
							]
						: [{ id: 20 + Number(args.profileId), profileId: Number(args.profileId), ord: 0, host: "x", port: 22, jumps: [] }];
				case "route_save":
					return 99;
				case "net_info_get":
					return { gateways: ["192.0.2.1"], dnsSuffixes: ["corp.example"], wifi: [], supportsGateway: true, supportsDns: true, supportsWifi: true, wifiNote: "Wi-Fi 이름을 읽을 권한이 없습니다 — 위치 권한을 켜세요" };
				case "ssh_conn_route":
					return { id: 12, label: "외부 · 점프", summary: "점프 구형 로그 서버 · 10.0.0.5:22", total: 3, note: "사내 직접: dev.example.com:22 이(가) 4초 안에 답하지 않았습니다" };
				case "ssh_diagnose":
					return new Promise((r) =>
						setTimeout(
							() =>
								r({
									profile: "개발 서버",
									account: "deploy",
									at: Date.now(),
									net: { gateways: ["192.0.2.1"], dnsSuffixes: [], wifi: [], supportsGateway: true, supportsDns: true, supportsWifi: false },
									routes: [
										{
											routeId: 11,
											label: "사내 직접",
											summary: "dev.example.com:22",
											cond: "DNS 접미사 corp.example 일 때",
											condState: "noMatch",
											ok: false,
											steps: [
												{ name: "망 조건", status: "warn", detail: "안 맞음 — 지금: 없음. 접속할 때는 이 경로를 건너뜁니다" },
												{ name: "이름 풀이 · 대상", status: "fail", detail: "dev.example.com 이름을 찾지 못했습니다", hint: "주소에 오타가 있거나, 사내 DNS 에서만 풀리는 이름일 수 있습니다(사내망·VPN 연결을 확인하세요)" },
											],
										},
										{
											routeId: 12,
											label: "외부 · 점프",
											summary: "점프 구형 로그 서버 · 10.0.0.5:22",
											condState: "none",
											ok: true,
											steps: [
												{ name: "이름 풀이 · 점프 서버 구형 로그 서버", status: "info", detail: "IP 주소라 풀이할 이름이 없습니다" },
												{ name: "TCP 연결 · 점프 서버 구형 로그 서버", status: "ok", ms: 3.4, detail: "10.0.0.6:22 평균 3.4ms (3.9 · 3.1 · 3.2)" },
												{ name: "점프 1 · 구형 로그 서버", status: "ok", ms: 88, detail: "10.0.0.6:22 · 계정 root 인증까지" },
												{ name: "점프 서버 → 대상", status: "ok", ms: 4.2, detail: "10.0.0.5:22 길 열기 평균 4.2ms" },
												{ name: "SSH 인사", status: "ok", ms: 12, detail: "SSH-2.0-OpenSSH_9.6" },
												{ name: "키 교환·호스트 키", status: "ok", ms: 30, detail: "고정한 키와 같습니다 · ssh-ed25519 SHA256:abcd" },
												{ name: "인증", status: "ok", ms: 40, detail: "계정 deploy · 개인키" },
											],
										},
									],
								}),
							700,
						),
					);
				default:
					return null;
			}
		},
		{ shouldMockEvents: true },
	);
}
