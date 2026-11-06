import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errText, type SudoCtx, srvRun, sudoAllowed, usePoll } from "./common";

/**
 * 서버 웹 화면 열기 — 서버에서 듣고 있는 TCP 포트(ss → netstat → /proc/net/tcp 순), 프로세스 이름,
 * HTTP(S) 로 응답하는지 확인(curl·wget), [브라우저로 열기] = 내 PC 127.0.0.1 빈 포트로 잠깐 포워딩 + 기본 브라우저.
 * 열린 터널은 아래에 보이고 닫을 수 있다(저장하지 않음 — 연결이 끊기면 함께 닫힘).
 */
export type WebPortsPanelProps = {
	conn: number;
	sudo?: SudoCtx;
	visible?: boolean;
	/** 브라우저로 열기(없으면 OS 기본 브라우저) */
	onOpenUrl?: (url: string) => void;
};

export type Listen = { port: number; addrs: string[]; procs: string[] };
type Probe = { scheme: "http" | "https" | ""; status: string; server: string };
type Fwd = { id: number; conn: number; host: string; port: number; localPort: number; startedAt: number };

/** "0.0.0.0:80" "[::]:443" "*:22" "127.0.0.53%lo:53" → [주소, 포트] */
function splitAddr(a: string): [string, number] | null {
	const i = a.lastIndexOf(":");
	if (i < 0) return null;
	const port = Number(a.slice(i + 1));
	if (!Number.isInteger(port)) return null;
	return [a.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, ""), port];
}

/** 16진 /proc/net/tcp 주소 → 사람 주소 */
function procAddr(hex: string): string {
	if (hex.length === 8) return [3, 2, 1, 0].map((i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
	if (/^0+$/.test(hex)) return "::";
	if (hex === "00000000000000000000000001000000") return "::1";
	if (hex.startsWith("0000000000000000FFFF0000")) return procAddr(hex.slice(24));
	return "::?";
}

/** ss·netstat·/proc 출력 → 포트별로 묶음 */
export function parseListen(out: string): Listen[] {
	const m = new Map<number, Listen>();
	const add = (addr: string, port: number, proc: string) => {
		const x = m.get(port) ?? { port, addrs: [], procs: [] };
		if (!x.addrs.includes(addr)) x.addrs.push(addr);
		if (proc && !x.procs.includes(proc)) x.procs.push(proc);
		m.set(port, x);
	};
	const mode = out.match(/@@(SS|NETSTAT|PROC)/)?.[1];
	for (const raw of out.split("\n")) {
		const f = raw.trim().split(/\s+/);
		if (mode === "SS" && f[0] === "LISTEN" && f[3]) {
			const a = splitAddr(f[3]);
			const procs = [...raw.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((x) => `${x[1]}(${x[2]})`);
			if (a) add(a[0] === "*" ? "0.0.0.0" : a[0], a[1], procs.join(" "));
		} else if (mode === "NETSTAT" && /^tcp/.test(f[0]) && f[5] === "LISTEN") {
			const a = splitAddr(f[3]);
			const p = f[6] && f[6] !== "-" ? f[6].replace(/^(\d+)\/(.+)$/, "$2($1)") : "";
			if (a) add(a[0] === "*" ? "0.0.0.0" : a[0], a[1], p);
		} else if (mode === "PROC" && /^\d+:$/.test(f[0]) && f[3] === "0A") {
			const [h, p] = f[1].split(":");
			add(procAddr(h), Number.parseInt(p, 16), "");
		}
	}
	return [...m.values()].sort((a, b) => a.port - b.port);
}

/** 서버 안에서 그 포트에 닿을 주소 — 모든 주소·루프백이면 127.0.0.1, ::1 만이면 ::1, 아니면 그 주소 */
export function targetHost(l: Listen): string {
	if (l.addrs.some((a) => a === "0.0.0.0" || a === "::" || a.startsWith("127."))) return "127.0.0.1";
	if (l.addrs.includes("::1")) return "::1";
	return l.addrs[0] ?? "127.0.0.1";
}

const hostUrl = (h: string) => (h.includes(":") ? `[${h}]` : h);

const LIST_CMD =
	"if command -v ss >/dev/null 2>&1; then echo @@SS; ss -lntpH 2>/dev/null || ss -lntp 2>/dev/null; elif command -v netstat >/dev/null 2>&1; then echo @@NETSTAT; netstat -lntp 2>/dev/null; else echo @@PROC; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; fi";

/** 포트마다 HTTP·HTTPS 로 물어보기(나란히, 2초씩) — "포트\t방식\t첫 줄\tServer" */
export function probeCmd(list: { host: string; port: number }[]): string {
	const one = (h: string, p: number) => {
		const u = hostUrl(h);
		return `( for s in http https; do if command -v curl >/dev/null 2>&1; then o=$(curl -skI --max-time 2 "$s://${u}:${p}/" 2>/dev/null | tr -d '\\r'); else o=$(wget -q -S --spider -T 2 -t 1 --no-check-certificate "$s://${u}:${p}/" 2>&1 | sed 's/^ *//'); fi; f=$(printf '%s\\n' "$o" | grep -m1 '^HTTP/'); if [ -n "$f" ]; then printf '%s\\t%s\\t%s\\t%s\\n' ${p} $s "$f" "$(printf '%s\\n' "$o" | grep -i -m1 '^server:' | cut -d' ' -f2-)"; exit; fi; done; printf '%s\\t\\t\\t\\n' ${p} ) &`;
	};
	return `if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then echo @@NOPROBE; exit 0; fi; ${list.map((x) => one(x.host, x.port)).join(" ")} wait`;
}

/** 메뉴에서 바로 쓰는 함수 — 서버 포트를 잇고 브라우저로 연다. 돌려주는 값은 연 주소 */
export async function openServerPort(conn: number, port: number, o: { host?: string; scheme?: "http" | "https"; path?: string; onOpenUrl?: (url: string) => void } = {}): Promise<string> {
	const f = await invoke<Fwd>("web_forward_open", { conn, host: o.host ?? "127.0.0.1", port });
	const url = `${o.scheme ?? "http"}://127.0.0.1:${f.localPort}${o.path ?? "/"}`;
	if (o.onOpenUrl) o.onOpenUrl(url);
	else await openUrl(url);
	return url;
}

export function WebPortsPanel({ conn, sudo, visible = true, onOpenUrl }: WebPortsPanelProps) {
	const [list, setList] = useState<Listen[] | null>(null);
	const [probe, setProbe] = useState<Map<number, Probe>>(new Map());
	const [probing, setProbing] = useState(false);
	const [fwds, setFwds] = useState<Fwd[]>([]);
	const [busy, setBusy] = useState(false);
	const [asRoot, setAsRoot] = useState(false);
	const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
	const [onlyWeb, setOnlyWeb] = useState(false);
	const [noProbe, setNoProbe] = useState(false);
	const canSudo = sudoAllowed(sudo);

	const loadFwds = useCallback(async () => setFwds(await invoke<Fwd[]>("web_forward_list", { conn })), [conn]);

	const load = useCallback(async () => {
		setBusy(true);
		try {
			const r = await srvRun(conn, LIST_CMD, { sudo: asRoot, timeoutMs: 20000 });
			const l = parseListen(r.stdout);
			setList(l);
			setProbing(true);
			const p = await srvRun(conn, probeCmd(l.slice(0, 60).map((x) => ({ host: targetHost(x), port: x.port }))), { timeoutMs: 30000 });
			setNoProbe(p.stdout.includes("@@NOPROBE"));
			const m = new Map<number, Probe>();
			for (const line of p.stdout.split("\n")) {
				const [port, scheme, status, server] = line.split("\t");
				if (/^\d+$/.test(port)) m.set(Number(port), { scheme: (scheme as Probe["scheme"]) || "", status: status ?? "", server: server ?? "" });
			}
			setProbe(m);
		} catch (e) {
			setNote({ text: errText(e), err: true });
		} finally {
			setBusy(false);
			setProbing(false);
		}
	}, [conn, asRoot]);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		void loadFwds();
	}, [loadFwds]);
	usePoll(loadFwds, 3, visible);

	const open = async (l: Listen) => {
		const pr = probe.get(l.port);
		try {
			const url = await openServerPort(conn, l.port, { host: targetHost(l), scheme: pr?.scheme === "https" ? "https" : "http", onOpenUrl });
			setNote({ text: `${url} 로 열었습니다(서버 ${l.port})` });
			void loadFwds();
		} catch (e) {
			setNote({ text: errText(e), err: true });
		}
	};

	const close = async (id: number) => {
		await invoke("web_forward_close", { id });
		void loadFwds();
	};

	const shown = useMemo(() => (list ?? []).filter((l) => !onlyWeb || probe.get(l.port)?.scheme), [list, probe, onlyWeb]);
	const noProcs = (list ?? []).length > 0 && (list ?? []).every((l) => !l.procs.length);

	return (
		<div className="sp-panel sp-web">
			<div className="sp-bar">
				<Globe size={14} />
				<b>듣고 있는 포트</b>
				<button type="button" className={`btn ghost tiny${onlyWeb ? " on" : ""}`} aria-pressed={onlyWeb} onClick={() => setOnlyWeb((x) => !x)} title="웹으로 응답한 포트만">
					웹만
				</button>
				{canSudo && (
					<button type="button" className={`btn ghost tiny${asRoot ? " on" : ""}`} aria-pressed={asRoot} onClick={() => setAsRoot((x) => !x)} title="다른 사용자 프로세스 이름까지 보기(sudo)">
						sudo
					</button>
				)}
				<span className="sp-grow" />
				{probing && <small className="sp-dim">웹인지 확인하는 중…</small>}
				<button type="button" className="btn ghost tiny" onClick={() => void load()} disabled={busy} title="새로 고침">
					<RefreshCw size={13} className={busy ? "sp-spin" : undefined} />
				</button>
			</div>
			{note && <p className={`sp-pad ${note.err ? "err" : "sp-note"}`}>{note.text}</p>}
			{noProbe && <p className="sp-pad sp-dim">서버에 curl·wget 이 없어 웹인지 확인하지 못했습니다 — 그래도 [브라우저로 열기]는 됩니다.</p>}
			{noProcs && !asRoot && <p className="sp-pad sp-dim">프로세스 이름은 내 것만 보입니다{canSudo ? " — sudo 를 켜면 모두 보입니다" : ""}.</p>}
			<div className="sp-scroll">
				{list == null ? (
					<div className="sp-empty">포트를 읽는 중…</div>
				) : (
					<table className="sp-table">
						<thead>
							<tr>
								<th className="num">포트</th>
								<th>주소</th>
								<th>프로세스</th>
								<th>웹</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{shown.map((l) => {
								const pr = probe.get(l.port);
								const fw = fwds.find((f) => f.port === l.port);
								return (
									<tr key={l.port}>
										<td className="num sp-mono">{l.port}</td>
										<td className="sp-dim sp-mono sp-clip" title={l.addrs.join(", ")}>
											{l.addrs.join(", ")}
										</td>
										<td className="sp-mono sp-clip" title={l.procs.join(", ")}>
											{l.procs.join(", ") || "—"}
										</td>
										<td title={pr?.status}>
											{pr?.scheme ? (
												<span className="sp-tag on">
													{pr.scheme.toUpperCase()} {pr.status.split(" ")[1] ?? ""}
													{pr.server ? ` · ${pr.server}` : ""}
												</span>
											) : pr ? (
												<span className="sp-dim">아님</span>
											) : (
												<span className="sp-dim">{probing ? "…" : "—"}</span>
											)}
										</td>
										<td className="acts">
											<button type="button" className={`btn tiny${pr?.scheme ? " primary" : ""}`} onClick={() => void open(l)} title="내 PC 로 이어 브라우저로 열기">
												<ExternalLink size={12} /> {fw ? `열기(:${fw.localPort})` : "브라우저로 열기"}
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
				{list && shown.length === 0 && <div className="sp-empty">{onlyWeb ? "웹으로 응답한 포트가 없습니다" : "듣고 있는 포트가 없습니다"}</div>}
			</div>
			{fwds.length > 0 && (
				<div className="sp-fwds">
					<div className="sp-k">열린 터널</div>
					{fwds.map((f) => (
						<div key={f.id} className="sp-fwd">
							<span className="sp-mono">
								127.0.0.1:{f.localPort} → 서버 {hostUrl(f.host)}:{f.port}
							</span>
							<button type="button" className="btn ghost tiny" onClick={() => {
									const url = `${probe.get(f.port)?.scheme === "https" ? "https" : "http"}://127.0.0.1:${f.localPort}/`;
									void (onOpenUrl ? onOpenUrl(url) : openUrl(url));
								}} title="다시 열기">
								<ExternalLink size={12} />
							</button>
							<button type="button" className="btn ghost tiny" onClick={() => void close(f.id)} title="터널 닫기">
								<X size={12} />
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
