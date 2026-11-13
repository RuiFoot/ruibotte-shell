/**
 * 화면 점검용 가짜 백엔드 — `pnpm dev` 를 일반 브라우저로 열 때만 쓴다(Tauri 창·배포판에는 들어가지 않음).
 * 모든 화면을 Rust 없이 띄워 보고 고치기 위한 것이다. 값은 그럴듯한 예시일 뿐이다.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Args = Record<string, unknown>;
const now = Math.floor(Date.now() / 1000);

/** sql_map 예시(쿼리 지도 화면 점검) — 이 문장을 SQL 편집기에 붙여 넣으면 지도가 뜬다 */
const MOCK_SQL_SAMPLE = `WITH recent AS (SELECT customer_id, count(*) n FROM orders WHERE created_at > now() - interval '30 days' GROUP BY customer_id) SELECT c.name, o.id, i.qty, r.n FROM orders o JOIN customer c ON c.id = o.customer_id LEFT JOIN order_item i ON i.order_id = o.id JOIN recent r ON r.customer_id = c.id WHERE o.status = 'paid' AND YEAR(o.created_at) = 2024 AND o.id NOT IN (SELECT order_id FROM order_item WHERE qty = 0) ORDER BY o.created_at DESC LIMIT 50`;
const MOCK_SQL_MAP = {"ok": true, "error": null, "kind": "select", "dialect": "postgres", "scopes": [{"id": 0, "kind": "main", "name": null, "parent": null, "pos": [0, 448]}, {"id": 1, "kind": "cte", "name": "recent", "parent": 0, "pos": [5, 126]}, {"id": 2, "kind": "subquery", "name": "NOT IN", "parent": 0, "pos": [366, 411]}], "tables": [{"id": 0, "scope": 1, "schema": null, "name": "orders", "alias": null, "cte": null, "derived": null, "virt": false, "target": false, "qualText": "orders", "pos": [52, 58]}, {"id": 1, "scope": 0, "schema": null, "name": "orders", "alias": "o", "cte": null, "derived": null, "virt": false, "target": false, "qualText": "o", "pos": [164, 170]}, {"id": 2, "scope": 0, "schema": null, "name": "customer", "alias": "c", "cte": null, "derived": null, "virt": false, "target": false, "qualText": "c", "pos": [178, 186]}, {"id": 3, "scope": 0, "schema": null, "name": "order_item", "alias": "i", "cte": null, "derived": null, "virt": false, "target": false, "qualText": "i", "pos": [223, 233]}, {"id": 4, "scope": 0, "schema": null, "name": "recent", "alias": "r", "cte": 1, "derived": null, "virt": false, "target": false, "qualText": "r", "pos": [262, 268]}, {"id": 5, "scope": 2, "schema": null, "name": "order_item", "alias": null, "cte": null, "derived": null, "virt": false, "target": false, "qualText": "order_item", "pos": [387, 397]}], "joins": [{"scope": 0, "left": 1, "right": 2, "kind": "inner", "on": [{"a": 3, "b": 4, "op": "="}], "hasOn": true, "using": [], "natural": false, "pos": [192, 212]}, {"scope": 0, "left": 1, "right": 3, "kind": "left", "on": [{"a": 5, "b": 6, "op": "="}], "hasOn": true, "using": [], "natural": false, "pos": [239, 256]}, {"scope": 0, "left": 2, "right": 4, "kind": "inner", "on": [{"a": 7, "b": 8, "op": "="}], "hasOn": true, "using": [], "natural": false, "pos": [274, 294]}], "cols": [{"id": 0, "scope": 1, "table": 0, "qual": null, "name": "customer_id", "role": "select", "pred": null, "wrapped": null, "pos": [23, 34]}, {"id": 1, "scope": 1, "table": 0, "qual": null, "name": "created_at", "role": "where", "pred": "range", "wrapped": null, "pos": [65, 75]}, {"id": 2, "scope": 1, "table": 0, "qual": null, "name": "customer_id", "role": "group", "pred": null, "wrapped": null, "pos": [114, 125]}, {"id": 3, "scope": 0, "table": 2, "qual": "c", "name": "id", "role": "on", "pred": "eq", "wrapped": null, "pos": [192, 196]}, {"id": 4, "scope": 0, "table": 1, "qual": "o", "name": "customer_id", "role": "on", "pred": "eq", "wrapped": null, "pos": [199, 212]}, {"id": 5, "scope": 0, "table": 3, "qual": "i", "name": "order_id", "role": "on", "pred": "eq", "wrapped": null, "pos": [239, 249]}, {"id": 6, "scope": 0, "table": 1, "qual": "o", "name": "id", "role": "on", "pred": "eq", "wrapped": null, "pos": [252, 256]}, {"id": 7, "scope": 0, "table": 4, "qual": "r", "name": "customer_id", "role": "on", "pred": "eq", "wrapped": null, "pos": [274, 287]}, {"id": 8, "scope": 0, "table": 2, "qual": "c", "name": "id", "role": "on", "pred": "eq", "wrapped": null, "pos": [290, 294]}, {"id": 9, "scope": 0, "table": 2, "qual": "c", "name": "name", "role": "select", "pred": null, "wrapped": null, "pos": [134, 140]}, {"id": 10, "scope": 0, "table": 1, "qual": "o", "name": "id", "role": "select", "pred": null, "wrapped": null, "pos": [142, 146]}, {"id": 11, "scope": 0, "table": 3, "qual": "i", "name": "qty", "role": "select", "pred": null, "wrapped": null, "pos": [148, 153]}, {"id": 12, "scope": 0, "table": 4, "qual": "r", "name": "n", "role": "select", "pred": null, "wrapped": null, "pos": [155, 158]}, {"id": 13, "scope": 0, "table": 1, "qual": "o", "name": "status", "role": "where", "pred": "eq", "wrapped": null, "pos": [301, 309]}, {"id": 14, "scope": 0, "table": 1, "qual": "o", "name": "created_at", "role": "where", "pred": "eq", "wrapped": "YEAR", "pos": [328, 340]}, {"id": 15, "scope": 0, "table": 1, "qual": "o", "name": "id", "role": "where", "pred": "other", "wrapped": null, "pos": [353, 357]}, {"id": 16, "scope": 2, "table": null, "qual": null, "name": "order_id", "role": "select", "pred": null, "wrapped": null, "pos": [373, 381]}, {"id": 17, "scope": 2, "table": null, "qual": null, "name": "qty", "role": "where", "pred": "eq", "wrapped": null, "pos": [404, 407]}, {"id": 18, "scope": 0, "table": 1, "qual": "o", "name": "created_at", "role": "order", "pred": null, "wrapped": null, "pos": [422, 434]}], "facts": [{"kind": "cmp", "scope": 0, "pos": [192, 212], "col": 3, "col2": 4, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": null, "value": null}, {"kind": "cmp", "scope": 0, "pos": [239, 256], "col": 5, "col2": 6, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": null, "value": null}, {"kind": "cmp", "scope": 0, "pos": [274, 294], "col": 7, "col2": 8, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": null, "value": null}, {"kind": "cmp", "scope": 0, "pos": [301, 318], "col": 13, "col2": null, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": "str", "value": "paid"}, {"kind": "cmp", "scope": 0, "pos": [323, 348], "col": 14, "col2": null, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": "num", "value": "2024"}, {"kind": "fnOnCol", "scope": 0, "pos": [323, 341], "col": 14, "col2": null, "sub": null, "table": null, "text": "YEAR", "num": null, "op": null, "lit": null, "value": null}, {"kind": "cmp", "scope": 2, "pos": [404, 411], "col": 17, "col2": null, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": "num", "value": "0"}, {"kind": "notInSubquery", "scope": 0, "pos": [353, 412], "col": 15, "col2": null, "sub": 2, "table": null, "text": null, "num": null, "op": null, "lit": null, "value": null}]};

/** 두 번째 예시 — 두 문장 사이를 오가며 쿼리 분석 칸이 커서 문장을 따라가는지 본다 */
const MOCK_SQL_SAMPLE2 = `SELECT p.name, p.price, c.title FROM product p JOIN category c ON c.id = p.category_id WHERE p.price > 100 ORDER BY p.name`;
const MOCK_SQL_MAP2 = {"ok": true, "error": null, "kind": "select", "dialect": "postgres", "scopes": [{"id": 0, "kind": "main", "name": null, "parent": null, "pos": [0, 122]}], "tables": [{"id": 0, "scope": 0, "schema": null, "name": "product", "alias": "p", "cte": null, "derived": null, "virt": false, "target": false, "qualText": "p", "pos": [37, 44]}, {"id": 1, "scope": 0, "schema": null, "name": "category", "alias": "c", "cte": null, "derived": null, "virt": false, "target": false, "qualText": "c", "pos": [52, 60]}], "joins": [{"scope": 0, "left": 0, "right": 1, "kind": "inner", "on": [{"a": 3, "b": 4, "op": "="}], "hasOn": true, "using": [], "natural": false, "pos": [66, 86]}], "cols": [{"id": 0, "scope": 0, "table": 0, "qual": "p", "name": "name", "role": "select", "pred": null, "wrapped": null, "pos": [7, 13]}, {"id": 1, "scope": 0, "table": 0, "qual": "p", "name": "price", "role": "select", "pred": null, "wrapped": null, "pos": [15, 22]}, {"id": 2, "scope": 0, "table": 1, "qual": "c", "name": "title", "role": "select", "pred": null, "wrapped": null, "pos": [24, 31]}, {"id": 3, "scope": 0, "table": 1, "qual": "c", "name": "id", "role": "on", "pred": "eq", "wrapped": null, "pos": [66, 70]}, {"id": 4, "scope": 0, "table": 0, "qual": "p", "name": "category_id", "role": "on", "pred": "eq", "wrapped": null, "pos": [73, 86]}, {"id": 5, "scope": 0, "table": 0, "qual": "p", "name": "price", "role": "where", "pred": "range", "wrapped": null, "pos": [93, 100]}, {"id": 6, "scope": 0, "table": 0, "qual": "p", "name": "name", "role": "order", "pred": null, "wrapped": null, "pos": [116, 122]}], "facts": [{"kind": "cmp", "scope": 0, "pos": [66, 86], "col": 3, "col2": 4, "sub": null, "table": null, "text": null, "num": null, "op": "=", "lit": null, "value": null}, {"kind": "cmp", "scope": 0, "pos": [93, 106], "col": 5, "col2": null, "sub": null, "table": null, "text": null, "num": null, "op": ">", "lit": "num", "value": "100"}]};

const settings = new Map<string, string>();
// 쿼리 분석 칸 점검용 초안(운영 PostgreSQL 프로필의 첫 SQL 탭)
settings.set("sql.draft.3.1", `${MOCK_SQL_SAMPLE};

${MOCK_SQL_SAMPLE2};
`);
const profiles: Record<string, any>[] = [
	{ id: 1, kind: "ssh", name: "개발 서버", host: "dev.example.com", port: 22, username: "deploy", color: "#0a84ff", favorite: true, auth: "key", keyPath: "~/.ssh/id_ed25519", legacy: "off", defaultPath: null, database: null, secretSaved: true, lastUsedAt: now - 3600, groupName: "개발" },
	{ id: 2, kind: "ssh", name: "구형 로그 서버", host: "10.0.0.6", port: 22, username: "root", color: "#ff9f0a", favorite: true, auth: "password", legacy: "sha1", defaultPath: "/var/log", database: null, secretSaved: false, lastUsedAt: now - 86400 * 3, groupName: "개발" },
	{ id: 3, kind: "db", name: "운영 PostgreSQL", host: "db.example.com", port: 5432, username: "app", engine: "postgres", color: "#30d158", favorite: true, auth: "password", legacy: "off", database: "app", secretSaved: true, lastUsedAt: now - 7200, groupName: "운영" },
	{ id: 4, kind: "db", name: "레거시 MariaDB", host: "10.0.0.9", port: 3306, username: "ro", engine: "mariadb", color: "#bf5af2", favorite: false, auth: "password", legacy: "off", database: "RSA", secretSaved: false },
	{ id: 5, kind: "db", name: "Oracle 회계", host: "10.0.0.12", port: 1521, username: "acc", engine: "oracle", color: "#8e8e93", favorite: false, auth: "password", legacy: "off", database: "ORCL", secretSaved: false },
];

// 계정 — 서버 하나에 여럿(기본 계정이 앞)
let accSeq = 100;
/** 연결마다 번호를 달리(서버 ↔ 서버 화면 점검) */
let connSeq = 0;
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

/** 셸 흉내(화면 점검용) — 줄 편집 하나: 글자 넣기·백스페이스·←/→·Enter. 명령 입력 보조(빈칸 Tab 이동)를 눈으로 보려고 */
const shellLine = { buf: [] as string[], at: 0, ch: null as unknown, seq: 1 };
/** 흉내 셸 상태 — 들어간 컨테이너(훅을 넣었는지), 멈춘 작업, 앞에서 도는 가짜 편집기 */
const msh = { ctr: null as string | null, hooked: false, jobs: [] as string[], fg: null as string | null };
function mshMarks() {
	const j = msh.jobs.map((c, i) => `[${i + 1}]${i === msh.jobs.length - 1 ? "+" : "-"}  Stopped                 ${c}`).join("␤");
	if (msh.ctr) return msh.hooked ? `\x1b]133;D;0\x07\x1b]6976;docker:${msh.ctr}\x07\x1b]6977;${j}\x07\x1b]7;file://ctr/app\x07` : "";
	return `\x1b]133;D;0\x07\x1b]6976;host\x07\x1b]6977;${j}\x07\x1b]7;file://dev/home/deploy\x07`;
}
function mshPrompt() {
	return msh.ctr ? `${msh.hooked ? "\x1b]133;A\x07" : ""}\x1b[1;36mroot@${msh.ctr}\x1b[0m:/app# ` : prompt;
}
function quickSend(ch: unknown, text: string) {
	const id = typeof ch === "object" && ch ? (ch as { id: number }).id : Number(String(ch).replace("__CHANNEL__:", ""));
	const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } }).__TAURI_INTERNALS__;
	const bytes = Array.from(new TextEncoder().encode(text));
	setTimeout(() => internals.runCallback(id, { index: shellLine.seq++, message: bytes }), 5);
}
const cellW = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0);
function shellWrite(data: string) {
	const L = shellLine;
	if (!L.ch) return;
	let out = "";
	for (let i = 0; i < data.length; ) {
		if (data.startsWith("\x1b[D", i)) {
			if (L.at > 0) out += "\b".repeat(cellW(L.buf[--L.at] ?? ""));
			i += 3;
		} else if (data.startsWith("\x1b[C", i)) {
			if (L.at < L.buf.length) out += L.buf[L.at++];
			i += 3;
		} else if (data[i] === "\x7f") {
			if (L.at > 0) {
				const gone = L.buf.splice(--L.at, 1)[0] ?? "";
				const rest = L.buf.slice(L.at).join("");
				out += `${"\b".repeat(cellW(gone))}${rest}${" ".repeat(cellW(gone))}${"\b".repeat(cellW(rest) + cellW(gone))}`;
			}
			i++;
		} else if (data[i] === "\x1a" && msh.fg) {
			msh.jobs.push(msh.fg);
			out += `\r\n[${msh.jobs.length}]+  Stopped                 ${msh.fg}\r\n${mshMarks()}${mshPrompt()}`;
			msh.fg = null;
			i++;
		} else if (data[i] === "\r") {
			const line = L.buf.join("").trim();
			L.buf = [];
			L.at = 0;
			i++;
			const dx = /docker\s+exec\s+-it\s+(\S+)\s+(bash|sh)/.exec(line);
			const fg = /^fg(?:\s+%(\d+))?$/.exec(line);
			if (dx) {
				msh.ctr = dx[1];
				msh.hooked = false;
				out += `\r\n${mshPrompt()}`;
			} else if (line === "exit" && msh.ctr) {
				msh.ctr = null;
				msh.hooked = false;
				out += `\r\nexit\r\n${mshMarks()}${mshPrompt()}`;
			} else if (/^(vim?|nano)\s+\S+$/.test(line)) {
				msh.fg = line;
				out += `\r\n(가짜 편집기 ${line} — Ctrl+Z 로 멈추기)`;
			} else if (fg && msh.jobs.length) {
				const k = fg[1] ? Number(fg[1]) - 1 : msh.jobs.length - 1;
				msh.fg = msh.jobs.splice(k, 1)[0] ?? null;
				out += `\r\n${msh.fg}\r\n(가짜 편집기 — Ctrl+Z 로 멈추기)`;
			} else {
				out += `\r\n${line ? `(가짜 셸) ${line}\r\n` : ""}${mshMarks()}${mshPrompt()}`;
			}
		} else if (data.charCodeAt(i) < 0x20) i++;
		else {
			const cp = String.fromCodePoint(data.codePointAt(i) ?? 32);
			L.buf.splice(L.at++, 0, cp);
			const rest = L.buf.slice(L.at).join("");
			out += cp + rest + "\b".repeat(cellW(rest));
			i += cp.length;
		}
	}
	if (out) quickSend(L.ch, out);
}

const prompt = "\x1b]133;A\x07\x1b[1;32mdeploy@dev\x1b[0m:\x1b[1;34m~\x1b[0m$ ";
const banner = `Last login: Thu Nov  5 09:12:44 2026 from 10.0.0.2\r\n\x1b]6976;host\x07\x1b]7;file://dev/home/deploy\x07${prompt}`;

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
				case "relay_start":
				case "direct_start":
					return 900 + connSeq;
				case "ssh_connect": {
					// 화면 점검: window.__rbConnFail = "NETWORK" 처럼 두면 그 오류로 실패(조용한 다시 연결·접속 창 대기열 확인용)
					const fail = (window as unknown as { __rbConnFail?: string }).__rbConnFail;
					if (fail) throw { code: fail, message: `가짜 오류 ${fail}` };
					const req = (args as { req: Record<string, any> }).req;
					const a = accounts.find((x) => x.id === req.accountId);
					if (a) a.lastUsedAt = Date.now();
					return { connId: ++connSeq, home: "/home/deploy", fingerprint: "SHA256:abcd", algorithm: "ssh-ed25519", newlyPinned: false, usedSavedSecret: true, accountId: a?.id ?? null, username: a?.username ?? req.username, sudo: a?.sudo ?? "ask", sudoUser: a?.sudoUser ?? "root", route: { id: 12, label: "외부 · 점프", summary: "점프 구형 로그 서버 · 10.0.0.5:22", total: 3, note: "사내 직접 건너뜀 — 망 조건이 맞지 않음" } };
				}
				case "ssh_shell_open":
				case "pty_open":
					shellLine.ch = args.onData;
					shellLine.buf = [];
					shellLine.at = 0;
					shellLine.seq = 1;
					sendChannel(args.onData, banner);
					return 1;
				case "ssh_shell_inject_ctx":
					// 넣은 줄의 에코는 앱(Rust)이 거른다 — 훅이 걸린 뒤 프롬프트만
					msh.hooked = true;
					if (shellLine.ch) quickSend(shellLine.ch, `\r\x1b[2K${mshMarks()}${mshPrompt()}`);
					return null;
				case "ctr_where":
					return ["/app", "/root"];
				case "ctr_list": {
					const cp = String(args.path ?? "/").replace(/\/$/, "") || "";
					const mk = (n: string, d: boolean, i = 0) => ({ name: n, path: `${cp}/${n}`, kind: d ? "dir" : "file", size: d ? 4096 : 900 + i * 700, mtime: now - i * 600 });
					if (cp === "") return ["app", "bin", "etc", "root", "usr", "var"].map((n) => mk(n, true));
					if (cp === "/app") return [mk("static", true), mk("templates", true), ...["main.py", "config.yaml", "requirements.txt", "Dockerfile"].map((n, i) => mk(n, false, i + 1))];
					return ["a.conf", "b.conf"].map((n, i) => mk(n, false, i));
				}
				case "ctr_read_text":
					return { path: args.path, size: 120, mtime: now, text: `# 컨테이너 ${args.ctr} 안 파일\napp:\n  debug: false\n`, meta: { encoding: "UTF-8", bom: false, eol: "LF", guessed: false }, binary: false, tooLarge: false };
				case "ctr_write_text":
					return { size: String(args.text ?? "").length, mtime: Math.floor(Date.now() / 1000) };
				case "ctr_op":
					return null;
				case "ssh_shell_write":
				case "pty_write":
					shellWrite(String(args.data ?? ""));
					return null;
				case "pty_shells":
					return [
						{ id: "bash", label: "Git Bash", program: "bash.exe", args: [], kind: "bash", admin: false },
						{ id: "pwsh", label: "PowerShell", program: "pwsh.exe", args: [], kind: "pwsh", admin: false },
					];
				case "ssh_exec": {
					// 명령 입력 보조(D25) 후보·man 견본
					const cmd = String(args.cmd ?? "");
					if (cmd.includes("--type=service")) return "nginx.service enabled enabled\npostgresql.service enabled enabled\napp-api.service enabled enabled\n";
					if (cmd.includes("--type=timer")) return "logrotate.timer enabled enabled\nbackup.timer enabled enabled\n";
					if (cmd.startsWith("docker ps")) return "api\ndb\nredis\n";
					if (cmd.startsWith("docker images")) return "repia/api:1.4.2\npostgres:18\n<none>:<none>\n";
					if (cmd.startsWith("getent passwd")) return "root:x:0:0:root:/root:/bin/bash\ndeploy:x:1000:1000::/home/deploy:/bin/bash\n";
					if (cmd.startsWith("getent group")) return "root:x:0:\ndeploy:x:1000:\nwww-data:x:33:\n";
					if (cmd.includes("/sys/class/net")) return "eth0\nlo\n";
					if (cmd.includes("man -P cat")) return "NAME\n       sed - stream editor\n\nOPTIONS\n       -n, --quiet, --silent\n              suppress automatic printing of pattern space\n";
					if (cmd.includes("compgen")) return "sed\nfind\ntar\ngrep\nls\n";
					return "";
				}
				case "ssh_test":
					return new Promise((r) => setTimeout(() => r({ ms: 142, home: "/home/deploy", fingerprint: "SHA256:abcd", algorithm: "ssh-ed25519", newlyPinned: false }), 400));
				case "db_test":
					return { ms: 38, version: "PostgreSQL 18.6" };
				case "srv_run": {
					// 서버 칸(서비스·Docker·웹 화면) 화면 점검용 견본 출력
					const cmd = String((args as { cmd: string }).cmd);
					const out = (lines: string[], code = 0) => ({ code, stdout: `${lines.join("\n")}\n`, stderr: "", truncated: false });
					if (cmd.includes("list-units"))
						return out([
							"uid=1000",
							"sd=yes",
							"@@UNITS@@",
							"nginx.service loaded active running A high performance web server",
							"postgresql.service loaded active running PostgreSQL RDBMS",
							"app-api.service loaded failed failed Repia API",
							"cron.service loaded active running Regular background program processing daemon",
							"sshd.service loaded active running OpenSSH server daemon",
							"backup.service loaded inactive dead Nightly backup",
							"@@FILES@@",
							"nginx.service enabled enabled",
							"postgresql.service enabled enabled",
							"app-api.service enabled enabled",
							"cron.service enabled enabled",
							"sshd.service enabled enabled",
							"backup.service disabled enabled",
						]);
					if (cmd.includes("systemctl show"))
						return out([
							"Id=nginx.service",
							"ActiveState=active",
							"SubState=running",
							"MainPID=812",
							"MemoryCurrent=48234496",
							"ActiveEnterTimestamp=Thu 2026-11-05 09:12:44 KST",
							"FragmentPath=/lib/systemd/system/nginx.service",
							"@@STATUS@@",
							"● nginx.service - A high performance web server",
							"     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)",
							"     Active: active (running) since Thu 2026-11-05 09:12:44 KST; 1 day ago",
						]);
					if (cmd.includes("for b in docker podman")) return out(["bin=docker", "uid=1000"]);
					if (cmd.includes("ps -q")) return out([]);
					if (cmd.includes(" stats ")) return out(["a1b2c3\t0.42%\t312MiB / 7.6GiB\t4.01%", "d4e5f6\t3.10%\t1.2GiB / 7.6GiB\t15.8%"]);
					if (cmd.includes(" ps -a"))
						return out([
							"a1b2c3\tapi\trepia/api:1.4.2\trunning\tUp 3 days\t0.0.0.0:8080->8080/tcp\t3 days ago\tcom.docker.compose.project=app",
							"d4e5f6\tdb\tpostgres:18\trunning\tUp 3 days (healthy)\t5432/tcp\t3 days ago\tcom.docker.compose.project=app",
							"0f9e8d\tmigrate\trepia/api:1.4.2\texited\tExited (0) 3 days ago\t\t3 days ago\tcom.docker.compose.project=app",
							"77aa11\tredis\tredis:7\trunning\tUp 9 hours\t6379/tcp\t9 hours ago\t",
						]);
					if (cmd.includes(" images ")) return out(["repia/api\t1.4.2\tsha256:aa11\t412MB\t5 days ago", "postgres\t18\tsha256:bb22\t438MB\t2 weeks ago", "redis\t7\tsha256:cc33\t117MB\t3 weeks ago"]);
					if (cmd.includes("ss -") || cmd.includes("/proc/net"))
						return out([
							'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))',
							'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("java",pid=1201,fd=40))',
							'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=640,fd=5))',
						]);
					return out([]);
				}
				case "srv_stream_open":
					return 1;
				case "srv_stream_close":
					return null;
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
				case "sftp_write_text":
				case "local_write_text":
				case "sudo_write_text":
					return { size: String(args.text ?? "").length, mtime: Date.now() };
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
					// 카탈로그(인덱스·FK) 읽기는 빈 결과 — 가짜 행이 인덱스로 읽히지 않게
					if (/pg_index|pg_constraint/.test(String(args.sql))) return { resultId: null, columns: [], rowCount: 0, truncated: false, ms: 1 };
					if (/current_database\(\)/.test(String(args.sql))) return { resultId: 2, columns: [{ name: "current_database", kind: "text" }], rowCount: 1, truncated: false, ms: 1 };
					return { resultId: 1, columns: [{ name: "id", kind: "int" }, { name: "name", kind: "text" }, { name: "created_at", kind: "datetime" }, { name: "status", kind: "text" }], rowCount: 240, truncated: false, ms: 12, firstRowMs: 4 };
				case "db_rows": {
					if (Number(args.result) === 2) return [["app"]];
					const from = Number(args.from);
					const to = Number(args.to);
					return Array.from({ length: Math.max(0, Math.min(240, to) - from) }, (_, i) => [String(from + i + 1), `고객 ${from + i + 1}`, "2026-11-05 09:00:00", i % 7 === 0 ? null : "active"]);
				}
				case "db_view":
					return args.filter ? 37 : 240;
				case "sql_map": {
					// 목업에는 SQL 파서가 없다 — 이 예시 문장만 Rust 가 낸 결과 그대로(쿼리 지도·튜닝 화면 점검용)
					const norm = (x: string) => x.replace(/\s+/g, " ").trim();
					if (norm(String(args.sql)) === norm(MOCK_SQL_SAMPLE)) return MOCK_SQL_MAP;
					if (norm(String(args.sql)) === norm(MOCK_SQL_SAMPLE2)) return MOCK_SQL_MAP2;
					return { ok: false, error: `목업에는 SQL 파서가 없습니다 — 예시 문장을 붙여 넣으세요: ${MOCK_SQL_SAMPLE.slice(0, 60)}…`, kind: "other", dialect: "postgres", scopes: [], tables: [], joins: [], cols: [], facts: [] };
				}
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
