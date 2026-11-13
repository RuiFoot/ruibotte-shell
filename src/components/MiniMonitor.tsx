import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { api } from "../lib/ipc";
import { ContextMenu, type MenuItem } from "./ContextMenu";

type Ticks = { busy: number; iowait: number; total: number };
type Lite = {
	ncpu: number;
	load: [number, number, number];
	cpu: Ticks[];
	mem: { total: number; available: number };
	disks: { sizeK: number; usedK: number; mount: string }[];
};

/** "off" 끔 · "auto" 망 상태 따라(빠르면 5초, 느리거나 실패하면 최대 60초까지 늘림) · 숫자 고정 간격(ms) */
type Every = "off" | "auto" | "5000" | "15000" | "60000";
const KEY = "monitor.mini.every";
const N = 30;
const AUTO_MIN = 5000;
const AUTO_MAX = 60000;
/** 이보다 오래 걸리면 망이 느린 것으로 보고 간격을 늘린다 */
const SLOW_MS = 800;

const LABEL: Record<Every, string> = { off: "끔", auto: "자동(망 상태 따라)", "5000": "5초마다", "15000": "15초마다", "60000": "1분마다" };

type Snap = { cpu: number[]; mem: number[]; disk: { pct: number; mount: string } | null; info: string; err: boolean; gap: number };
const EMPTY: Snap = { cpu: [], mem: [], disk: null, info: "", err: false, gap: AUTO_MIN };

// ── 간격(모든 서버 공용 설정) ──
let everyNow: Every = "auto";
let everyLoaded = false;
const everySubs = new Set<() => void>();
function loadEvery() {
	if (everyLoaded) return;
	everyLoaded = true;
	void api
		.settingGet(KEY)
		.then((v) => {
			if (v && v in LABEL) setEveryGlobal(v as Every, false);
		})
		.catch(() => undefined);
}
function setEveryGlobal(v: Every, save = true) {
	if (v === everyNow) return;
	everyNow = v;
	if (save) void api.settingSet(KEY, v).catch(() => undefined);
	for (const f of everySubs) f();
	for (const p of pollers.values()) p.restart();
}
function subEvery(f: () => void) {
	everySubs.add(f);
	return () => everySubs.delete(f);
}

/**
 * 연결 하나에 읽기 하나 — 터미널을 여러 개(나누기·탭) 열어도 서버에는 한 번만 묻고 모든 표시가 같은 값을 본다.
 * 보는 표시가 없어지면 멈춘다.
 */
class Poller {
	snap: Snap = EMPTY;
	subs = new Set<() => void>();
	private prev: Ticks | null = null;
	/** 구독이 모두 빠진 뒤 지우기 예약 */
	dropTimer = 0;
	private timer = 0;
	private gen = 0;
	constructor(private conn: number) {}
	private set(p: Partial<Snap>) {
		this.snap = { ...this.snap, ...p };
		for (const f of this.subs) f();
	}
	/** 한참 쉬었다 다시 읽을 때 — 오래된 CPU 표본과의 차이로 평균이 흐려지지 않게 */
	forgetPrev() {
		this.prev = null;
	}
	restart() {
		window.clearTimeout(this.timer);
		const my = ++this.gen;
		if (everyNow === "off" || !this.subs.size) return;
		let next = everyNow === "auto" ? AUTO_MIN : Number(everyNow);
		const tick = async () => {
			if (my !== this.gen) return;
			if (document.visibilityState === "visible") {
				const t0 = performance.now();
				let ok = false;
				try {
					const s = await invoke<Lite>("ssh_stats", { conn: this.conn, lite: true });
					if (my !== this.gen) return;
					ok = true;
					const t = s.cpu[0];
					const p = this.prev;
					this.prev = t;
					const cpu = p && t && t.total > p.total ? [...this.snap.cpu, Math.max(0, Math.min(100, Math.round(((t.busy - p.busy) / (t.total - p.total)) * 100)))].slice(-N) : this.snap.cpu;
					const mem = s.mem.total ? [...this.snap.mem, Math.round((1 - s.mem.available / s.mem.total) * 100)].slice(-N) : this.snap.mem;
					const full = s.disks.filter((d) => d.sizeK > 0).sort((a, b) => b.usedK / b.sizeK - a.usedK / a.sizeK)[0];
					this.set({
						err: false,
						cpu,
						mem,
						disk: full ? { pct: Math.round((full.usedK / full.sizeK) * 100), mount: full.mount } : null,
						info: `부하 ${s.load.map((x) => x.toFixed(2)).join(" ")} · 코어 ${s.ncpu} · 응답 ${Math.round(performance.now() - t0)}ms`,
					});
				} catch {
					if (my === this.gen) this.set({ err: true });
				}
				if (everyNow === "auto") {
					const slow = !ok || performance.now() - t0 > SLOW_MS;
					next = slow ? Math.min(AUTO_MAX, next * 2) : Math.max(AUTO_MIN, next / 2);
					if (next !== this.snap.gap) this.set({ gap: next });
				}
			}
			if (my === this.gen) this.timer = window.setTimeout(tick, next);
		};
		void tick();
	}
	stop() {
		this.gen++;
		window.clearTimeout(this.timer);
	}
}
const pollers = new Map<number, Poller>();
function subPoller(conn: number, f: () => void) {
	let p = pollers.get(conn);
	if (!p) {
		p = new Poller(conn);
		pollers.set(conn, p);
	}
	const first = p.subs.size === 0;
	window.clearTimeout(p.dropTimer);
	p.subs.add(f);
	if (first) {
		p.forgetPrev();
		p.restart();
	}
	return () => {
		const q = pollers.get(conn);
		if (!q) return;
		q.subs.delete(f);
		if (!q.subs.size) {
			// 멈추기만 하고 1분은 남겨 둔다 — 탭을 바꿨다 돌아와도 꺾은선 기록·CPU 이전 표본이 남아 바로 보인다
			q.stop();
			window.clearTimeout(q.dropTimer);
			q.dropTimer = window.setTimeout(() => {
				if (!q.subs.size) pollers.delete(conn);
			}, 60_000);
		}
	};
}

/**
 * 상태 줄에 붙는 작은 서버 자원 표시 — CPU·메모리·가장 찬 디스크를 숫자와 짧은 꺾은선으로.
 * 켜고 끄기·간격은 우클릭(또는 ⋯)으로 고르고 모든 서버에 같이 기억한다. 기본은 "자동":
 * 응답이 빠르면 5초, 느리거나(0.8초 넘음) 실패하면 간격을 두 배씩(최대 1분) 늘리고 다시 빨라지면 줄인다.
 * 창이 안 보이거나 이 작업대(앱 탭)가 뒤에 가려져 있을 때(enabled=false)는 읽지 않는다. 80% 넘으면 주황, 90% 넘으면 빨강. 누르면 자세한 자원 칸을 연다.
 */
export function MiniMonitor({ conn, onOpen, enabled = true }: { conn: number; onOpen: () => void; /** 이 작업대(앱 탭)가 앞에 보일 때만 읽는다 */ enabled?: boolean }) {
	loadEvery();
	const every = useSyncExternalStore(subEvery, () => everyNow);
	const setEvery = (v: Every) => setEveryGlobal(v);
	const sub = useCallback((f: () => void) => (enabled ? subPoller(conn, f) : () => undefined), [conn, enabled]);
	const snap = useSyncExternalStore(sub, () => pollers.get(conn)?.snap ?? EMPTY);
	const { cpu, mem, disk, info, err, gap } = snap;
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	const openMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setMenu({ x: e.clientX, y: e.clientY });
	};
	const items: MenuItem[] = [
		...(Object.keys(LABEL) as Every[]).map((k) => ({ label: `${every === k ? "✓ " : "　"}${LABEL[k]}`, run: () => setEvery(k) })),
		{ sep: true },
		{ label: "자세히 보기(자원 칸)", run: onOpen },
	];

	if (every === "off")
		return (
			<>
				<button type="button" className="mini-mon off" onClick={() => setEvery("auto")} onContextMenu={openMenu} title="서버 자원 표시 켜기(우클릭: 간격 고르기)">
					<Activity size={12} /> 자원
				</button>
				{menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
			</>
		);

	const c = cpu.at(-1);
	const m = mem.at(-1);
	const slowNote = every === "auto" && gap > AUTO_MIN ? `\n망이 느려 ${Math.round(gap / 1000)}초마다 읽는 중` : "";
	return (
		<>
			<button
				type="button"
				className={`mini-mon${err ? " err" : ""}`}
				onClick={onOpen}
				onContextMenu={openMenu}
				title={`${err ? "자원을 읽지 못했습니다\n" : ""}${info}${disk ? `\n가장 찬 디스크: ${disk.mount} ${disk.pct}%` : ""}\n간격: ${LABEL[every]}${slowNote}\n누르면 자세히 · 우클릭으로 끄기·간격`}
			>
				<Meter label="CPU" v={c} hist={cpu} />
				<Meter label="메모리" v={m} hist={mem} />
				{disk && <Meter label="디스크" v={disk.pct} />}
				{slowNote && <span className="mm-slow">{Math.round(gap / 1000)}s</span>}
			</button>
			{menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
		</>
	);
}

function level(v?: number) {
	return v == null ? "" : v >= 90 ? " bad" : v >= 80 ? " warn" : "";
}

function Meter({ label, v, hist }: { label: string; v?: number; hist?: number[] }) {
	return (
		<span className={`mm-item${level(v)}`}>
			<span className="mm-lbl">{label}</span>
			{hist && hist.length > 1 && <Spark data={hist} />}
			<span className="mm-val">{v == null ? "–" : `${v}%`}</span>
		</span>
	);
}

function Spark({ data }: { data: number[] }) {
	const w = 36;
	const h = 12;
	const step = w / (N - 1);
	const off = N - data.length;
	const d = data.map((v, i) => `${i ? "L" : "M"}${((off + i) * step).toFixed(1)},${(h - (v / 100) * h).toFixed(1)}`).join("");
	return (
		<svg className="mm-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
			<path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" />
		</svg>
	);
}
