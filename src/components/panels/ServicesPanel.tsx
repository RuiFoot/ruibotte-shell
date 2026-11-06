import { CirclePlay, CircleStop, FileText, Power, PowerOff, RefreshCw, RotateCw, Search, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Select } from "../Select";
import { bytes, confirmAction, errText, LogView, type SudoCtx, sq, srvRun, srvStream, sudoAllowed, useLines } from "./common";

/**
 * 서비스 칸 — systemd 서비스 목록(실패 먼저·상태별 묶기·거르기), 고르면 상태 요약·의존·메모리,
 * 시작·중지·재시작·다시 읽기·켜기·끄기(root 가 아니면 계정 sudo 설정을 따름), 그 서비스 journal 실시간 보기.
 */
export type ServicesPanelProps = {
	/** SSH 연결 번호 */
	conn: number;
	/** 연결한 계정의 sudo 설정 — 없거나 off 면 sudo 없이 시도(보통 polkit 이 거절) */
	sudo?: SudoCtx;
	/** 작업대 sudo 단추가 켜져 있으면 journal 을 처음부터 sudo 로 읽는다 */
	sudoOn?: boolean;
	/** 칸이 보일 때만 자동 새로 고침 */
	visible?: boolean;
	/** 터미널 새 탭에서 명령 돌리기(있으면 "터미널에서 journal" 메뉴) */
	onOpenTerminal?: (cmd: string, title: string) => void;
};

type Unit = { name: string; load: string; active: string; sub: string; desc: string; enabled: string };
type Detail = { props: Record<string, string>; status: string };

const STATE_ORDER = ["failed", "activating", "deactivating", "reloading", "active", "inactive"];
const STATE_LABEL: Record<string, string> = {
	failed: "실패",
	active: "실행 중",
	activating: "켜는 중",
	deactivating: "끄는 중",
	reloading: "다시 읽는 중",
	inactive: "멈춤",
};

/** systemctl 목록 두 개(list-units·list-unit-files)를 합친다 — 템플릿(foo@.service)·없는 유닛은 뺀다 */
export function parseUnits(units: string, files: string): Unit[] {
	const map = new Map<string, Unit>();
	for (const raw of units.split("\n")) {
		const l = raw.replace(/^[●*\s]+/, "").trim();
		if (!l) continue;
		const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
		if (!m || !m[1].endsWith(".service") || m[2] === "not-found") continue;
		map.set(m[1], { name: m[1], load: m[2], active: m[3], sub: m[4], desc: m[5], enabled: "" });
	}
	for (const raw of files.split("\n")) {
		const m = raw.trim().match(/^(\S+\.service)\s+(\S+)/);
		if (!m || m[1].includes("@.")) continue;
		const u = map.get(m[1]);
		if (u) u.enabled = m[2];
		else map.set(m[1], { name: m[1], load: "loaded", active: "inactive", sub: "dead", desc: "", enabled: m[2] });
	}
	return [...map.values()];
}

const rank = (a: string) => {
	const i = STATE_ORDER.indexOf(a);
	return i < 0 ? STATE_ORDER.length : i;
};

/** systemctl show 의 키=값 */
function parseShow(s: string): Record<string, string> {
	const o: Record<string, string> = {};
	for (const l of s.split("\n")) {
		const i = l.indexOf("=");
		if (i > 0) o[l.slice(0, i)] = l.slice(i + 1);
	}
	return o;
}

const SHOW_PROPS = [
	"Id",
	"Description",
	"LoadState",
	"ActiveState",
	"SubState",
	"UnitFileState",
	"MainPID",
	"MemoryCurrent",
	"CPUUsageNSec",
	"TasksCurrent",
	"ActiveEnterTimestamp",
	"FragmentPath",
	"Requires",
	"Wants",
	"After",
	"WantedBy",
	"RequiredBy",
	"PartOf",
	"Restart",
	"NRestarts",
	"Result",
	"CanReload",
	"User",
].join(",");

const isNum = (v?: string) => !!v && /^\d+$/.test(v) && v !== "18446744073709551615";

export function ServicesPanel({ conn, sudo, sudoOn, visible = true, onOpenTerminal }: ServicesPanelProps) {
	const [env, setEnv] = useState<{ state: "loading" | "none" | "ok"; root: boolean; error?: string }>({ state: "loading", root: false });
	const [units, setUnits] = useState<Unit[]>([]);
	const [busy, setBusy] = useState(false);
	const [filter, setFilter] = useState("");
	const [only, setOnly] = useState<"all" | "active" | "failed" | "inactive" | "enabled">("all");
	const [grouped, setGrouped] = useState(true);
	const [sel, setSel] = useState<string | null>(null);
	const [detail, setDetail] = useState<Detail | null>(null);
	const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; u: Unit } | null>(null);
	const canSudo = sudoAllowed(sudo);
	const useSudo = !env.root && canSudo;

	const load = useCallback(async () => {
		setBusy(true);
		try {
			const r = await srvRun(
				conn,
				"echo uid=$(id -u); if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo sd=yes; else echo sd=no; exit 0; fi; echo @@UNITS@@; LC_ALL=C systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null; echo @@FILES@@; LC_ALL=C systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null",
				{ timeoutMs: 30000 },
			);
			const root = /uid=0\b/.test(r.stdout);
			if (!/sd=yes/.test(r.stdout)) {
				setEnv({ state: "none", root });
				return;
			}
			const [, rest = ""] = r.stdout.split("@@UNITS@@\n");
			const [u = "", f = ""] = rest.split("@@FILES@@\n");
			setUnits(parseUnits(u, f));
			setEnv({ state: "ok", root });
		} catch (e) {
			setEnv((x) => ({ ...x, state: x.state === "loading" ? "ok" : x.state, error: errText(e) }));
		} finally {
			setBusy(false);
		}
	}, [conn]);

	useEffect(() => {
		void load();
	}, [load]);

	const loadDetail = useCallback(
		async (name: string) => {
			try {
				const r = await srvRun(conn, `LC_ALL=C systemctl show ${sq(name)} -p ${SHOW_PROPS} --no-pager; echo @@STATUS@@; SYSTEMD_COLORS=0 LC_ALL=C systemctl status ${sq(name)} --no-pager -n 0 -l 2>&1`, { timeoutMs: 15000 });
				const [show, status = ""] = r.stdout.split("@@STATUS@@\n");
				setDetail({ props: parseShow(show), status: status.trimEnd() });
			} catch (e) {
				setDetail({ props: {}, status: errText(e) });
			}
		},
		[conn],
	);

	useEffect(() => {
		setDetail(null);
		if (sel) void loadDetail(sel);
	}, [sel, loadDetail]);

	// 보이는 동안 10초마다 목록·상세
	const loadRef = useRef(load);
	loadRef.current = load;
	useEffect(() => {
		if (!visible || env.state !== "ok") return;
		const t = window.setInterval(() => {
			void loadRef.current();
			if (sel) void loadDetail(sel);
		}, 10000);
		return () => window.clearInterval(t);
	}, [visible, env.state, sel, loadDetail]);

	const act = async (u: Unit, verb: "start" | "stop" | "restart" | "reload" | "enable" | "disable") => {
		const label = { start: "시작", stop: "중지", restart: "재시작", reload: "다시 읽기", enable: "켜기(부팅 때 자동 시작)", disable: "끄기(부팅 때 자동 시작 안 함)" }[verb];
		const risky = verb === "stop" || verb === "restart" || verb === "disable";
		const ssh = /^(ssh|sshd|openssh-server)\.service$/.test(u.name);
		if (risky || ssh) {
			const ok = await confirmAction({
				title: `${u.name} ${label}`,
				message: `${ssh ? "SSH 서비스입니다 — 지금 이 접속이 끊기고 다시 들어오지 못할 수 있습니다.\n" : ""}${verb === "stop" ? "서비스가 멈춥니다. 이 서비스를 쓰는 곳이 영향을 받습니다." : verb === "restart" ? "서비스를 껐다 켭니다. 잠깐 끊깁니다." : verb === "disable" ? "다음 부팅 때 저절로 켜지지 않습니다(지금 도는 것은 그대로)." : ""}`,
				okLabel: label,
				danger: true,
			});
			if (!ok) return;
		}
		setNote({ text: `${u.name} ${label} 중…` });
		try {
			const r = await srvRun(conn, `systemctl ${verb} ${sq(u.name)} 2>&1`, { sudo: useSudo, timeoutMs: 120000 });
			if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().split("\n").slice(-2).join(" ") || `실패(종료 코드 ${r.code})`);
			setNote({ text: `${u.name} ${label} 했습니다` });
		} catch (e) {
			const m = errText(e);
			setNote({ text: !useSudo && /access denied|interactive authentication|not authorized/i.test(m) ? `${m} — 이 계정은 sudo 를 쓰지 않게 설정돼 있습니다. 계정 설정에서 sudo 를 켜세요.` : m, err: true });
		}
		void load();
		if (sel === u.name) void loadDetail(u.name);
	};

	const daemonReload = async () => {
		if (!(await confirmAction({ title: "systemd 설정 다시 읽기", message: "유닛 파일을 고친 뒤에 씁니다(systemctl daemon-reload). 도는 서비스는 그대로입니다.", okLabel: "다시 읽기" }))) return;
		try {
			const r = await srvRun(conn, "systemctl daemon-reload 2>&1", { sudo: useSudo, timeoutMs: 60000 });
			setNote(r.code === 0 ? { text: "systemd 설정을 다시 읽었습니다" } : { text: r.stdout.trim() || r.stderr.trim(), err: true });
		} catch (e) {
			setNote({ text: errText(e), err: true });
		}
		void load();
	};

	const shown = useMemo(() => {
		const f = filter.trim().toLowerCase();
		const l = units.filter((u) => {
			if (f && !u.name.toLowerCase().includes(f) && !u.desc.toLowerCase().includes(f)) return false;
			if (only === "active") return u.active === "active";
			if (only === "failed") return u.active === "failed";
			if (only === "inactive") return u.active === "inactive";
			if (only === "enabled") return u.enabled === "enabled";
			return true;
		});
		l.sort((a, b) => rank(a.active) - rank(b.active) || a.name.localeCompare(b.name));
		return l;
	}, [units, filter, only]);

	const groups = useMemo(() => {
		if (!grouped) return [{ key: "", items: shown }];
		const m = new Map<string, Unit[]>();
		for (const u of shown) {
			const k = STATE_LABEL[u.active] ? u.active : "inactive";
			m.set(k, [...(m.get(k) ?? []), u]);
		}
		return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([key, items]) => ({ key, items }));
	}, [shown, grouped]);

	const counts = useMemo(() => {
		const c = { active: 0, failed: 0, inactive: 0 };
		for (const u of units) if (u.active in c) c[u.active as keyof typeof c]++;
		return c;
	}, [units]);

	if (env.state === "loading") return <div className="sp-panel sp-center">서비스 목록을 읽는 중…</div>;
	if (env.state === "none")
		return (
			<div className="sp-panel sp-center">
				<p>이 서버는 systemd 로 돌지 않습니다.</p>
				<p className="sp-dim">컨테이너 안이거나 다른 init(OpenRC·SysV·supervisord)을 쓰는 서버입니다. 서비스는 터미널에서 service·rc-service 같은 명령으로 다루세요.</p>
			</div>
		);

	const cur = units.find((u) => u.name === sel);
	const menuItems = (u: Unit): MenuItem[] => [
		{ label: "시작", run: () => void act(u, "start"), disabled: u.active === "active" },
		{ label: "중지", run: () => void act(u, "stop"), danger: true, disabled: u.active === "inactive" },
		{ label: "재시작", run: () => void act(u, "restart"), danger: true },
		{ label: "다시 읽기(reload)", run: () => void act(u, "reload"), disabled: u.active !== "active" },
		{ sep: true },
		{ label: "켜기(부팅 때 시작)", run: () => void act(u, "enable"), disabled: u.enabled === "enabled" || u.enabled === "static" },
		{ label: "끄기(부팅 때 안 함)", run: () => void act(u, "disable"), danger: true, disabled: u.enabled !== "enabled" },
		...(onOpenTerminal ? [{ sep: true } as MenuItem, { label: "터미널에서 journal 따라 보기", run: () => onOpenTerminal(`journalctl -u ${sq(u.name)} -f -n 200`, `journal · ${u.name}`) }] : []),
	];

	return (
		<div className="sp-panel sp-split">
			<section className="sp-list">
				<div className="sp-bar">
					<label className="sp-find">
						<Search size={13} />
						<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="이름·설명 거르기" spellCheck={false} />
					</label>
					<Select
						size="sm"
						value={only}
						onChange={setOnly}
						title="상태로 거르기"
						options={[
							{ value: "all", label: `모두 ${units.length}` },
							{ value: "failed", label: `실패 ${counts.failed}` },
							{ value: "active", label: `실행 중 ${counts.active}` },
							{ value: "inactive", label: `멈춤 ${counts.inactive}` },
							{ value: "enabled", label: "부팅 때 켜짐" },
						]}
					/>
					<button type="button" className={`btn ghost tiny${grouped ? " on" : ""}`} aria-pressed={grouped} onClick={() => setGrouped((x) => !x)} title="상태별로 묶기">
						묶기
					</button>
					<span className="sp-grow" />
					<button type="button" className="btn ghost tiny" onClick={() => void daemonReload()} title="systemd 설정 다시 읽기(daemon-reload)">
						<FileText size={13} />
					</button>
					<button type="button" className="btn ghost tiny" onClick={() => void load()} disabled={busy} title="새로 고침">
						<RefreshCw size={13} className={busy ? "sp-spin" : undefined} />
					</button>
				</div>
				{env.error && <p className="err sp-pad">{env.error}</p>}
				{!env.root && !canSudo && <p className="sp-note sp-pad">이 계정은 sudo 를 쓰지 않게 설정돼 있어 시작·중지가 거절될 수 있습니다.</p>}
				<div className="sp-scroll">
					{groups.map((g) => (
						<div key={g.key || "all"}>
							{g.key && (
								<div className={`sp-group st-${g.key}`}>
									{STATE_LABEL[g.key]} <small>{g.items.length}</small>
								</div>
							)}
							{g.items.map((u) => (
								<button
									key={u.name}
									type="button"
									className={`sp-row${sel === u.name ? " sel" : ""}`}
									onClick={() => setSel(u.name)}
									onContextMenu={(e) => {
										e.preventDefault();
										setSel(u.name);
										setMenu({ x: e.clientX, y: e.clientY, u });
									}}
									title={u.desc}
								>
									<span className={`sp-dot st-${u.active}`} />
									<span className="sp-name">{u.name.replace(/\.service$/, "")}</span>
									<span className="sp-desc">{u.desc}</span>
									<span className={`sp-tag${u.enabled === "enabled" ? " on" : ""}`}>{u.enabled || "—"}</span>
								</button>
							))}
						</div>
					))}
					{shown.length === 0 && <div className="sp-empty">맞는 서비스가 없습니다</div>}
				</div>
			</section>
			<section className="sp-detail">
				{!cur ? (
					<div className="sp-empty">왼쪽에서 서비스를 고르세요. 우클릭하면 바로 다룰 수 있습니다.</div>
				) : (
					<>
						<div className="sp-head">
							<span className={`sp-dot st-${cur.active}`} />
							<b>{cur.name}</b>
							<small className="sp-dim">
								{STATE_LABEL[cur.active] ?? cur.active} ({cur.sub}) · {cur.enabled || "—"}
							</small>
							<span className="sp-grow" />
							<button type="button" className="btn ghost tiny" title="시작" disabled={cur.active === "active"} onClick={() => void act(cur, "start")}>
								<CirclePlay size={14} />
							</button>
							<button type="button" className="btn ghost tiny danger" title="중지" disabled={cur.active === "inactive"} onClick={() => void act(cur, "stop")}>
								<CircleStop size={14} />
							</button>
							<button type="button" className="btn ghost tiny" title="재시작" onClick={() => void act(cur, "restart")}>
								<RotateCw size={14} />
							</button>
							<button type="button" className="btn ghost tiny" title="다시 읽기(reload)" disabled={detail?.props.CanReload !== "yes" || cur.active !== "active"} onClick={() => void act(cur, "reload")}>
								<RefreshCw size={14} />
							</button>
							{cur.enabled === "enabled" ? (
								<button type="button" className="btn ghost tiny danger" title="끄기(부팅 때 자동 시작 안 함)" onClick={() => void act(cur, "disable")}>
									<PowerOff size={14} />
								</button>
							) : (
								<button type="button" className="btn ghost tiny" title="켜기(부팅 때 자동 시작)" disabled={cur.enabled === "static" || cur.enabled === "masked"} onClick={() => void act(cur, "enable")}>
									<Power size={14} />
								</button>
							)}
							{onOpenTerminal && (
								<button type="button" className="btn ghost tiny" title="터미널에서 journal 따라 보기" onClick={() => onOpenTerminal(`journalctl -u ${sq(cur.name)} -f -n 200`, `journal · ${cur.name}`)}>
									<SquareTerminal size={14} />
								</button>
							)}
						</div>
						{note && <p className={`sp-pad ${note.err ? "err" : "sp-note"}`}>{note.text}</p>}
						{detail && <UnitFacts d={detail} onPick={(n) => units.some((u) => u.name === n) && setSel(n)} />}
						<Journal key={cur.name} conn={conn} unit={cur.name} sudoOk={canSudo && !env.root} sudoStart={!!sudoOn && canSudo && !env.root} />
					</>
				)}
			</section>
			{menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.u)} onClose={() => setMenu(null)} />}
		</div>
	);
}

function UnitFacts({ d, onPick }: { d: Detail; onPick: (name: string) => void }) {
	const p = d.props;
	const [open, setOpen] = useState(false);
	const deps = (k: string, label: string) => {
		const l = (p[k] ?? "").split(/\s+/).filter(Boolean);
		if (!l.length) return null;
		return (
			<div className="sp-deps">
				<span className="sp-k">{label}</span>
				{l.slice(0, 30).map((n) => (
					<button key={n} type="button" className="chip" onClick={() => onPick(n)} title={n}>
						{n.replace(/\.service$/, "")}
					</button>
				))}
				{l.length > 30 && <small className="sp-dim">외 {l.length - 30}개</small>}
			</div>
		);
	};
	const cpu = isNum(p.CPUUsageNSec) ? `${(Number(p.CPUUsageNSec) / 1e9).toFixed(1)}초` : "—";
	return (
		<div className="sp-facts">
			<div className="sp-kv">
				<span className="sp-k">메모리</span>
				<span>{isNum(p.MemoryCurrent) ? bytes(Number(p.MemoryCurrent)) : "—"}</span>
				<span className="sp-k">CPU 쓴 시간</span>
				<span>{cpu}</span>
				<span className="sp-k">PID</span>
				<span>{p.MainPID && p.MainPID !== "0" ? p.MainPID : "—"}</span>
				<span className="sp-k">작업 수</span>
				<span>{isNum(p.TasksCurrent) ? p.TasksCurrent : "—"}</span>
				<span className="sp-k">켠 때</span>
				<span>{p.ActiveEnterTimestamp || "—"}</span>
				<span className="sp-k">재시작</span>
				<span>
					{p.Restart || "—"}
					{p.NRestarts && p.NRestarts !== "0" ? ` · ${p.NRestarts}번` : ""}
					{p.Result && p.Result !== "success" ? ` · 마지막 결과 ${p.Result}` : ""}
				</span>
				<span className="sp-k">파일</span>
				<span className="sp-mono">{p.FragmentPath || "—"}</span>
			</div>
			{deps("Requires", "필요")}
			{deps("Wants", "함께")}
			{deps("After", "뒤에 켬")}
			{deps("WantedBy", "쓰는 쪽")}
			{deps("RequiredBy", "필요로 함")}
			{d.status && (
				<details className="sp-status" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
					<summary>systemctl status</summary>
					<pre className="selectable">{d.status}</pre>
				</details>
			)}
		</div>
	);
}

const PRIOS = [
	{ value: "", label: "모든 수준" },
	{ value: "3", label: "오류 이상" },
	{ value: "4", label: "경고 이상" },
	{ value: "5", label: "알림 이상" },
	{ value: "6", label: "정보 이상" },
];

/** 그 서비스의 journal 실시간(journalctl -u -f) */
function Journal({ conn, unit, sudoOk, sudoStart }: { conn: number; unit: string; sudoOk: boolean; sudoStart: boolean }) {
	const stream = useLines(20000);
	const [lines, setLines] = useState(200);
	const [prio, setPrio] = useState("");
	const [sudo, setSudo] = useState(sudoStart);
	const [state, setState] = useState<{ text: string; err?: boolean }>({ text: "여는 중…" });
	const [limited, setLimited] = useState(false);
	const { push, end, clear } = stream;
	useEffect(() => {
		let close: (() => void) | null = null;
		let gone = false;
		clear();
		setLimited(false);
		setState({ text: "여는 중…" });
		const cmd = `journalctl -u ${sq(unit)} -f -n ${lines}${prio ? ` -p ${prio}` : ""} --no-pager -o short-iso 2>&1`;
		srvStream(conn, cmd, {
			sudo,
			onText: (t) => {
				if (/insufficient permissions|not seeing messages from other users/i.test(t)) setLimited(true);
				push(t);
			},
			onEnd: (e) => {
				end();
				if (!gone) setState(e.cancelled ? { text: "멈춤" } : { text: `끝남(종료 코드 ${e.code ?? "?"}) — journalctl 이 없거나 읽을 수 없습니다`, err: e.code !== 0 });
			},
		})
			.then((c) => {
				if (gone) c();
				else {
					close = c;
					setState({ text: `실시간${sudo ? " · sudo" : ""}` });
				}
			})
			.catch((e) => !gone && setState({ text: errText(e), err: true }));
		return () => {
			gone = true;
			close?.();
		};
	}, [conn, unit, lines, prio, sudo, push, end, clear]);
	return (
		<div className="sp-journal">
			{limited && !sudo && (
				<div className="sp-note sp-pad">
					권한이 없어 일부 기록만 보입니다.{" "}
					{sudoOk ? (
						<button type="button" className="btn tiny" onClick={() => setSudo(true)}>
							sudo 로 보기
						</button>
					) : (
						"계정을 systemd-journal 또는 adm 묶음에 넣거나 sudo 를 켜세요."
					)}
				</div>
			)}
			<LogView
				stream={stream}
				left={
					<>
						<Select size="sm" value={lines} onChange={setLines} title="처음 보일 줄 수" options={[100, 200, 500, 2000, 10000].map((n) => ({ value: n, label: `${n}줄` }))} />
						<Select size="sm" value={prio} onChange={setPrio} title="우선순위(이 수준보다 중요한 것만)" options={PRIOS} />
						{sudoOk && (
							<button type="button" className={`btn ghost tiny${sudo ? " on" : ""}`} aria-pressed={sudo} onClick={() => setSudo((x) => !x)} title="sudo 로 읽기(모든 기록)">
								sudo
							</button>
						)}
					</>
				}
				status={<span className={state.err ? "err" : "sp-dim"}>{state.text}</span>}
			/>
		</div>
	);
}
