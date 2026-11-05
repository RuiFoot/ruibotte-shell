/**
 * 화면 점검용 가짜 백엔드 — `pnpm dev` 를 일반 브라우저로 열 때만 쓴다(Tauri 창·배포판에는 들어가지 않음).
 * 모든 화면을 Rust 없이 띄워 보고 고치기 위한 것이다. 값은 그럴듯한 예시일 뿐이다.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Args = Record<string, unknown>;
const now = Math.floor(Date.now() / 1000);

const profiles = [
	{ id: 1, kind: "ssh", name: "개발 서버", host: "dev.example.com", port: 22, username: "deploy", color: "#0a84ff", favorite: true, auth: "key", keyPath: "~/.ssh/id_ed25519", legacy: "off", defaultPath: null, database: null, secretSaved: true, lastUsedAt: now - 3600, groupName: "개발" },
	{ id: 2, kind: "ssh", name: "구형 로그 서버", host: "10.0.0.6", port: 22, username: "root", color: "#ff9f0a", favorite: true, auth: "password", legacy: "sha1", defaultPath: "/var/log", database: null, secretSaved: false, lastUsedAt: now - 86400 * 3, groupName: "개발" },
	{ id: 3, kind: "db", name: "운영 PostgreSQL", host: "db.example.com", port: 5432, username: "app", engine: "postgres", color: "#30d158", favorite: true, auth: "password", legacy: "off", database: "app", secretSaved: true, lastUsedAt: now - 7200, groupName: "운영" },
	{ id: 4, kind: "db", name: "레거시 MariaDB", host: "10.0.0.9", port: 3306, username: "ro", engine: "mariadb", color: "#bf5af2", favorite: false, auth: "password", legacy: "off", database: "RSA", secretSaved: false },
	{ id: 5, kind: "db", name: "Oracle 회계", host: "10.0.0.12", port: 1521, username: "acc", engine: "oracle", color: "#8e8e93", favorite: false, auth: "password", legacy: "off", database: "ORCL", secretSaved: false },
];

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
					return profiles;
				case "profile_save":
					return 99;
				case "setting_get":
					return null;
				case "local_home":
					return "C:/Users/me";
				case "local_list":
				case "sftp_list":
				case "sudo_list":
					return dir(String(args.path ?? "/"));
				case "sftp_realpath":
					return String(args.path ?? "/home/deploy");
				case "ssh_connect":
					return { connId: 1, home: "/home/deploy", fingerprint: "SHA256:abcd", algorithm: "ssh-ed25519", newlyPinned: false, usedSavedSecret: true };
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
				default:
					return null;
			}
		},
		{ shouldMockEvents: true },
	);
}
