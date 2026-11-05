import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/**
 * 상태 줄에 붙는 작은 서버 자원 표시 — CPU·메모리·가장 찬 디스크를 숫자와 짧은 꺾은선으로.
 * 켜고 끄기·간격은 우클릭(또는 ⋯)으로 고르고 모든 서버에 같이 기억한다. 기본은 "자동":
 * 응답이 빠르면 5초, 느리거나(0.8초 넘음) 실패하면 간격을 두 배씩(최대 1분) 늘리고 다시 빨라지면 줄인다.
 * 창이 안 보일 때는 읽지 않는다. 80% 넘으면 주황, 90% 넘으면 빨강. 누르면 자세한 자원 칸을 연다.
 */
export function MiniMonitor({ conn, onOpen }: { conn: number; onOpen: () => void }) {
	const prev = useRef<Ticks | null>(null);
	const [every, setEveryState] = useState<Every>("auto");
	const [cpu, setCpu] = useState<number[]>([]);
	const [mem, setMem] = useState<number[]>([]);
	const [disk, setDisk] = useState<{ pct: number; mount: string } | null>(null);
	const [info, setInfo] = useState("");
	const [err, setErr] = useState(false);
	const [gap, setGap] = useState(AUTO_MIN);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	useEffect(() => {
		void api
			.settingGet(KEY)
			.then((v) => v && v in LABEL && setEveryState(v as Every))
			.catch(() => undefined);
	}, []);
	const setEvery = (v: Every) => {
		setEveryState(v);
		void api.settingSet(KEY, v).catch(() => undefined);
	};

	useEffect(() => {
		if (every === "off") return;
		let alive = true;
		let timer = 0;
		let next = every === "auto" ? AUTO_MIN : Number(every);
		const tick = async () => {
			if (document.visibilityState === "visible") {
				const t0 = performance.now();
				let ok = false;
				try {
					const s = await invoke<Lite>("ssh_stats", { conn });
					if (!alive) return;
					ok = true;
					setErr(false);
					const t = s.cpu[0];
					const p = prev.current;
					prev.current = t;
					if (p && t && t.total > p.total) {
						const v = Math.round(((t.busy - p.busy) / (t.total - p.total)) * 100);
						setCpu((h) => [...h, Math.max(0, Math.min(100, v))].slice(-N));
					}
					if (s.mem.total) setMem((h) => [...h, Math.round((1 - s.mem.available / s.mem.total) * 100)].slice(-N));
					const full = s.disks.filter((d) => d.sizeK > 0).sort((a, b) => b.usedK / b.sizeK - a.usedK / a.sizeK)[0];
					setDisk(full ? { pct: Math.round((full.usedK / full.sizeK) * 100), mount: full.mount } : null);
					setInfo(`부하 ${s.load.map((x) => x.toFixed(2)).join(" ")} · 코어 ${s.ncpu} · 응답 ${Math.round(performance.now() - t0)}ms`);
				} catch {
					if (alive) setErr(true);
				}
				if (every === "auto") {
					const slow = !ok || performance.now() - t0 > SLOW_MS;
					next = slow ? Math.min(AUTO_MAX, next * 2) : Math.max(AUTO_MIN, next / 2);
					setGap(next);
				}
			}
			if (alive) timer = window.setTimeout(tick, next);
		};
		void tick();
		return () => {
			alive = false;
			window.clearTimeout(timer);
		};
	}, [conn, every]);

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
