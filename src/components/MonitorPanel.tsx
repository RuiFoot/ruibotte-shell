import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, FolderSearch, Pause, Play, Search, Square, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "./Select";

type Ticks = { busy: number; iowait: number; total: number };
type Proc = { pid: number; user: string; ticks: number; rssK: number; state: string; name: string };
type Stats = {
	atMs: number;
	host: string;
	kernel: string;
	ncpu: number;
	uptimeS: number;
	load: [number, number, number];
	running: number;
	cpu: Ticks[];
	mem: { total: number; available: number; free: number; buffers: number; cached: number; swapTotal: number; swapFree: number };
	net: { name: string; rx: number; tx: number }[];
	disks: { fs: string; kind: string; sizeK: number; usedK: number; availK: number; mount: string }[];
	io: { name: string; read: number; write: number }[];
	procs: Proc[];
};
type DuEntry = { name: string; sizeK: number };

const HIST = 60;
const kib = (k: number) => {
	if (k < 1024) return `${k} KB`;
	if (k < 1048576) return `${(k / 1024).toFixed(k < 10240 ? 1 : 0)} MB`;
	if (k < 1073741824) return `${(k / 1048576).toFixed(1)} GB`;
	return `${(k / 1073741824).toFixed(2)} TB`;
};
const rate = (bps: number) => (bps < 1024 ? `${bps.toFixed(0)} B/s` : bps < 1048576 ? `${(bps / 1024).toFixed(1)} KB/s` : `${(bps / 1048576).toFixed(1)} MB/s`);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const uptime = (s: number) => {
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};
const level = (r: number) => (r >= 0.95 ? "crit" : r >= 0.85 ? "warn" : "");
const errMsg = (e: unknown) => (e as { message?: string }).message ?? String(e);

/** 작은 선 그래프(0~1 또는 max 기준) */
function Spark({ data, max = 1, color }: { data: number[]; max?: number; color: string }) {
	const w = 120;
	const h = 32;
	const m = Math.max(max, ...data, 1e-9);
	const span = Math.max(1, data.length - 1);
	const pts = data.map((v, i) => `${(i / span) * w},${h - (v / m) * (h - 2) - 1}`).join(" ");
	return (
		<svg className="mon-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
			{data.length > 1 && (
				<>
					<polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity={0.14} stroke="none" />
					<polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
				</>
			)}
		</svg>
	);
}

function Bar({ value, cls = "" }: { value: number; cls?: string }) {
	return (
		<div className={`mon-bar ${cls}`}>
			<div style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
		</div>
	);
}

/**
 * 서버 자원 — CPU·메모리·디스크·네트워크·프로세스. 서버에 아무것도 깔지 않고 /proc·df 를 몇 초마다 읽는다.
 * 칸이 보일 때만 잰다(숨기면 멈춤). 디스크는 폴더별 용량(du)으로 파고들 수 있다.
 */
export function MonitorPanel({ conn, sudoOn, visible }: { conn: number; sudoOn: boolean; visible: boolean }) {
	const [cur, setCur] = useState<Stats | null>(null);
	const prev = useRef<Stats | null>(null);
	const [delta, setDelta] = useState<{ cpu: number[]; iowait: number; netRx: number; netTx: number; ioR: number; ioW: number; procCpu: Map<number, number> } | null>(null);
	const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>({ cpu: [], mem: [], rx: [], tx: [] });
	const [every, setEvery] = useState(3);
	const [paused, setPaused] = useState(false);
	const [error, setError] = useState("");
	const [sort, setSort] = useState<"cpu" | "mem">("cpu");
	const [filter, setFilter] = useState("");
	const [du, setDu] = useState<{ root: string; path: string; list: DuEntry[] | null; busy: boolean; error?: string } | null>(null);
	const [note, setNote] = useState("");

	const sample = useCallback(async () => {
		try {
			const s = await invoke<Stats>("ssh_stats", { conn });
			const p = prev.current;
			prev.current = s;
			setCur(s);
			setError("");
			if (!p) return;
			const dt = Math.max(0.001, (s.atMs - p.atMs) / 1000);
			const cpu = s.cpu.map((c, i) => {
				const o = p.cpu[i];
				const dTot = o ? c.total - o.total : 0;
				return dTot > 0 ? (c.busy - o.busy) / dTot : 0;
			});
			const dTotAll = p.cpu[0] ? s.cpu[0].total - p.cpu[0].total : 0;
			const iowait = dTotAll > 0 ? (s.cpu[0].iowait - p.cpu[0].iowait) / dTotAll : 0;
			const sum = (l: { rx: number; tx: number }[], k: "rx" | "tx") => l.reduce((a, x) => a + x[k], 0);
			const netRx = Math.max(0, (sum(s.net, "rx") - sum(p.net, "rx")) / dt);
			const netTx = Math.max(0, (sum(s.net, "tx") - sum(p.net, "tx")) / dt);
			const ioSum = (l: Stats["io"], k: "read" | "write") => l.reduce((a, x) => a + x[k], 0) * 512;
			const ioR = Math.max(0, (ioSum(s.io, "read") - ioSum(p.io, "read")) / dt);
			const ioW = Math.max(0, (ioSum(s.io, "write") - ioSum(p.io, "write")) / dt);
			// 프로세스 CPU% — top 처럼 코어 하나 = 100%
			const before = new Map(p.procs.map((x) => [x.pid, x.ticks]));
			const perCore = dTotAll / Math.max(1, s.ncpu);
			const procCpu = new Map<number, number>();
			for (const x of s.procs) {
				const b = before.get(x.pid);
				if (b != null && perCore > 0) procCpu.set(x.pid, Math.max(0, (x.ticks - b) / perCore));
			}
			setDelta({ cpu, iowait, netRx, netTx, ioR, ioW, procCpu });
			const memUsed = s.mem.total ? (s.mem.total - s.mem.available) / s.mem.total : 0;
			setHist((h) => ({
				cpu: [...h.cpu, cpu[0] ?? 0].slice(-HIST),
				mem: [...h.mem, memUsed].slice(-HIST),
				rx: [...h.rx, netRx].slice(-HIST),
				tx: [...h.tx, netTx].slice(-HIST),
			}));
		} catch (e) {
			setError(errMsg(e));
		}
	}, [conn]);

	// 보일 때만, 앞 요청이 끝난 뒤 다음을 잰다(느린 서버에서 겹치지 않게)
	useEffect(() => {
		if (!visible || paused) return;
		let stop = false;
		let t = 0;
		const loop = async () => {
			await sample();
			if (!stop) t = window.setTimeout(loop, every * 1000);
		};
		void loop();
		return () => {
			stop = true;
			window.clearTimeout(t);
		};
	}, [visible, paused, every, sample]);

	const procs = useMemo(() => {
		if (!cur) return [];
		const f = filter.trim().toLowerCase();
		const l = cur.procs
			.filter((p) => !f || p.name.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f)
			.map((p) => ({ ...p, cpu: delta?.procCpu.get(p.pid) ?? 0 }));
		l.sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu || b.rssK - a.rssK : b.rssK - a.rssK));
		return l.slice(0, 40);
	}, [cur, delta, sort, filter]);

	const openDu = async (path: string, root = du?.root ?? path) => {
		setDu({ root, path, list: null, busy: true });
		try {
			const list = await invoke<DuEntry[]>("ssh_du", { conn, path, asRoot: sudoOn });
			setDu({ root, path, list, busy: false });
		} catch (e) {
			setDu({ root, path, list: [], busy: false, error: errMsg(e) });
		}
	};
	const kill = async (p: Proc, force: boolean) => {
		if (!confirm(`${p.name}(PID ${p.pid}, ${p.user})을(를) ${force ? "강제로 끝냅니다(KILL — 저장하지 않은 작업이 사라질 수 있음)" : "멈추라고 요청합니다(TERM)"}. 계속할까요?`)) return;
		try {
			await invoke("ssh_kill", { conn, pid: p.pid, force, asRoot: sudoOn });
			setNote(`PID ${p.pid} 에 ${force ? "KILL" : "TERM"} 을 보냈습니다`);
			void sample();
		} catch (e) {
			setNote(errMsg(e));
		}
	};

	if (!cur) {
		return <div className="panel-fill mon-empty">{error ? <p className="err">{error}</p> : <p>서버 자원을 읽는 중…</p>}</div>;
	}
	const m = cur.mem;
	const memUsed = m.total - m.available;
	const swapUsed = m.swapTotal - m.swapFree;
	const loadRatio = cur.load[0] / Math.max(1, cur.ncpu);

	return (
		<div className="panel-fill mon selectable">
			<header className="mon-head">
				<div className="mon-title">
					<b>{cur.host}</b>
					<small>
						{cur.kernel} · 코어 {cur.ncpu}개 · 켜진 지 {uptime(cur.uptimeS)}
					</small>
				</div>
				<div className="mon-ctl">
					{error && <span className="err" title={error}>⚠ 마지막 측정 실패</span>}
					<Select size="sm" value={every} onChange={setEvery} title="측정 간격" options={[1, 2, 3, 5, 10, 30].map((s) => ({ value: s, label: `${s}초마다` }))} />
					<button type="button" className="btn ghost" onClick={() => setPaused((x) => !x)} title={paused ? "다시 재기" : "멈추기"}>
						{paused ? <Play size={14} /> : <Pause size={14} />}
					</button>
				</div>
			</header>

			<section className="mon-cards">
				<div className="mon-card">
					<div className="mon-k">CPU</div>
					<div className={`mon-v ${level(delta?.cpu[0] ?? 0)}`}>{delta ? pct(delta.cpu[0] ?? 0) : "—"}</div>
					<Spark data={hist.cpu} color="var(--accent)" />
					<small>
						I/O 대기 {delta ? pct(delta.iowait) : "—"} · 실행 중 {cur.running}
					</small>
				</div>
				<div className="mon-card">
					<div className="mon-k">메모리</div>
					<div className={`mon-v ${level(memUsed / Math.max(1, m.total))}`}>{pct(memUsed / Math.max(1, m.total))}</div>
					<Spark data={hist.mem} color="#bf5af2" />
					<small>
						{kib(memUsed)} / {kib(m.total)} · 캐시 {kib(m.cached + m.buffers)}
					</small>
				</div>
				<div className="mon-card">
					<div className="mon-k">부하(1·5·15분)</div>
					<div className={`mon-v ${loadRatio >= 2 ? "crit" : loadRatio >= 1 ? "warn" : ""}`}>{cur.load[0].toFixed(2)}</div>
					<small style={{ marginTop: "auto" }}>
						{cur.load.map((x) => x.toFixed(2)).join(" · ")} — 코어 {cur.ncpu}개 기준 {loadRatio >= 1 ? "밀림" : "여유"}
					</small>
					<small>
						스왑 {m.swapTotal ? `${kib(swapUsed)} / ${kib(m.swapTotal)}` : "없음"}
					</small>
				</div>
				<div className="mon-card">
					<div className="mon-k">네트워크</div>
					<div className="mon-v small">
						↓ {delta ? rate(delta.netRx) : "—"}
						<br />↑ {delta ? rate(delta.netTx) : "—"}
					</div>
					<Spark data={hist.rx.map((x, i) => Math.max(x, hist.tx[i] ?? 0))} max={1024} color="var(--ok)" />
					<small>
						디스크 읽기 {delta ? rate(delta.ioR) : "—"} · 쓰기 {delta ? rate(delta.ioW) : "—"}
					</small>
				</div>
			</section>

			{cur.ncpu > 1 && delta && (
				<section className="mon-cores" title="코어별 사용률">
					{delta.cpu.slice(1).map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 코어 번호
						<div key={i} className="mon-core" title={`코어 ${i}: ${pct(c)}`}>
							<div style={{ height: `${Math.min(100, c * 100)}%` }} className={level(c)} />
						</div>
					))}
				</section>
			)}

			<section className="mon-sec">
				<h4>디스크</h4>
				{du ? (
					<div className="mon-du">
						<div className="mon-du-head">
							<button type="button" className="btn ghost" onClick={() => (du.path === du.root ? setDu(null) : void openDu(du.path.replace(/\/[^/]+\/?$/, "") || "/"))}>
								<ChevronLeft size={14} /> {du.path === du.root ? "디스크 목록" : "위로"}
							</button>
							<code>{du.path}</code>
							<button type="button" className="btn ghost" onClick={() => setDu(null)}>
								닫기
							</button>
						</div>
						{du.busy && <p className="mon-muted">크기를 세는 중… 큰 폴더는 1~2분 걸릴 수 있습니다(같은 디스크만, 낮은 우선순위)</p>}
						{du.error && <p className="err">{du.error}</p>}
						{du.list && du.list.length > 0 && (
							<table className="mon-table">
								<tbody>
									{du.list.map((e) => {
										const total = du.list?.find((x) => x.name === ".")?.sizeK || 1;
										const isTotal = e.name === ".";
										return (
											<tr key={e.name} className={isTotal ? "total" : "click"} onClick={() => !isTotal && void openDu(`${du.path.replace(/\/$/, "")}/${e.name}`)}>
												<td className="name">{isTotal ? "(이 폴더 전체)" : `${e.name}/`}</td>
												<td className="num">{kib(e.sizeK)}</td>
												<td className="barcell">{!isTotal && <Bar value={e.sizeK / total} />}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
						{!sudoOn && <p className="mon-muted">읽을 권한이 없는 폴더는 빠집니다. 위의 sudo 를 켜면 모두 셉니다.</p>}
					</div>
				) : (
					<table className="mon-table">
						<thead>
							<tr>
								<th>마운트</th>
								<th className="opt">장치</th>
								<th className="num">사용</th>
								<th className="num">남음</th>
								<th className="num opt">전체</th>
								<th className="barcell" />
								<th />
							</tr>
						</thead>
						<tbody>
							{cur.disks.map((d) => {
								const r = d.usedK / Math.max(1, d.usedK + d.availK);
								return (
									<tr key={`${d.fs}:${d.mount}`}>
										<td className="name">{d.mount}</td>
										<td className="dim opt">
											{d.fs}
											{d.kind ? ` · ${d.kind}` : ""}
										</td>
										<td className="num">{kib(d.usedK)}</td>
										<td className={`num ${level(r)}`}>{kib(d.availK)}</td>
										<td className="num dim opt">{kib(d.sizeK)}</td>
										<td className="barcell">
											<Bar value={r} cls={level(r)} />
											<span className={`mon-pct ${level(r)}`}>{pct(r)}</span>
										</td>
										<td>
											<button type="button" className="btn ghost tiny" title="폴더별 용량 보기(du)" onClick={() => void openDu(d.mount, d.mount)}>
												<FolderSearch size={13} />
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</section>

			<section className="mon-sec">
				<div className="mon-sec-head">
					<h4>프로세스 {cur.procs.length}개</h4>
					<div className="seg" role="group" style={{ margin: 0 }}>
						<button type="button" aria-pressed={sort === "cpu"} onClick={() => setSort("cpu")}>
							CPU 순
						</button>
						<button type="button" aria-pressed={sort === "mem"} onClick={() => setSort("mem")}>
							메모리 순
						</button>
					</div>
					<label className="mon-filter">
						<Search size={13} />
						<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="이름·사용자·PID" spellCheck={false} />
					</label>
				</div>
				{note && <p className="mon-muted">{note}</p>}
				<table className="mon-table procs">
					<thead>
						<tr>
							<th className="num">PID</th>
							<th className="opt2">사용자</th>
							<th>이름</th>
							<th className="num">CPU</th>
							<th className="num">메모리</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{procs.map((p) => (
							<tr key={p.pid}>
								<td className="num dim">{p.pid}</td>
								<td className={`opt2${p.user === "root" ? " root" : ""}`}>{p.user}</td>
								<td className="name" title={`상태 ${p.state}`}>
									{p.name}
									{p.state === "Z" && <span className="mon-tag">좀비</span>}
									{p.state === "D" && <span className="mon-tag">I/O 대기</span>}
								</td>
								<td className={`num ${p.cpu >= 0.9 ? "warn" : ""}`}>{delta ? `${(p.cpu * 100).toFixed(1)}%` : "—"}</td>
								<td className="num">{kib(p.rssK)}</td>
								<td className="acts">
									<button type="button" className="btn ghost tiny" title="멈추라고 요청(TERM)" onClick={() => void kill(p, false)}>
										<Square size={12} />
									</button>
									<button type="button" className="btn ghost tiny danger" title="강제 종료(KILL)" onClick={() => void kill(p, true)}>
										<Zap size={12} />
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
