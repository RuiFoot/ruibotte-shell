import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Eye, FolderOpen, Play, RadioTower } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/ipc";

type Action = { path: string; action: "copy" | "delete"; reason: "new" | "changed" | "extra"; size: number; dir: boolean };
type Plan = { actions: Action[]; same: number; bytes: number; ms: number };
type WatchEv = { id: number; path: string; state: "sent" | "conflict" | "error"; message?: string | null };

const fmt = (n: number) => (n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * 동기화(rsync 모드) — 내 PC 폴더 ↔ 서버 폴더. 미리보기(dry-run)로 무엇이 바뀌는지 보고 실행.
 * 지우기·체크섬·제외 패턴, 같은 설정의 rsync 명령, 경로 매핑 자동 반영(내 PC 저장 → 서버, 충돌은 덮어쓰지 않음).
 */
export function SyncPanel({ conn, remoteHome, user, host, port, onRun }: { conn: number; remoteHome: string; user: string; host: string; port: number; onRun: () => void }) {
	const key = `sync.${host}:${port}`;
	const [local, setLocal] = useState("");
	const [remote, setRemote] = useState(remoteHome);
	const [direction, setDirection] = useState<"up" | "down">("up");
	const [del, setDel] = useState(false);
	const [checksum, setChecksum] = useState(false);
	const [excludes, setExcludes] = useState(".git\nnode_modules\n*.log\n*.tmp");
	const [plan, setPlan] = useState<Plan | null>(null);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [watchId, setWatchId] = useState<number | null>(null);
	const [events, setEvents] = useState<WatchEv[]>([]);

	// 설정은 서버별로 기억
	useEffect(() => {
		void api.settingGet(key).then((v) => {
			if (!v) return;
			try {
				const o = JSON.parse(v);
				setLocal(o.local ?? "");
				setRemote(o.remote ?? remoteHome);
				setDirection(o.direction ?? "up");
				setDel(!!o.delete);
				setChecksum(!!o.checksum);
				setExcludes((o.excludes ?? []).join("\n"));
			} catch {
				// 무시
			}
		});
	}, [key, remoteHome]);
	const opts = useMemo(() => ({ local, remote, direction, delete: del, checksum, excludes: excludes.split("\n").map((x) => x.trim()).filter(Boolean) }), [local, remote, direction, del, checksum, excludes]);
	useEffect(() => {
		if (local) void api.settingSet(key, JSON.stringify(opts));
	}, [key, opts, local]);

	useEffect(() => {
		const un = listen<WatchEv>("watch", (e) => {
			if (e.payload.id === watchId) setEvents((l) => [e.payload, ...l].slice(0, 100));
		});
		return () => void un.then((f) => f());
	}, [watchId]);
	useEffect(() => () => void (watchId != null && invoke("watch_stop", { id: watchId })), [watchId]);

	const preview = async () => {
		setBusy(true);
		setMsg("");
		try {
			setPlan(await invoke<Plan>("sync_plan", { conn, opts }));
		} catch (e) {
			setMsg((e as { message?: string }).message ?? String(e));
		} finally {
			setBusy(false);
		}
	};
	const run = async () => {
		if (plan?.actions.some((a) => a.action === "delete") && !confirm(`${plan.actions.filter((a) => a.action === "delete").length}개를 지웁니다(${direction === "up" ? "서버에서 — 되살릴 수 없음" : "내 PC 휴지통으로"}). 계속할까요?`)) return;
		try {
			await invoke("sync_run", { conn, opts });
			setPlan(null);
			onRun();
			setMsg("실행했습니다 — 전송 칸에서 진행을 봅니다");
		} catch (e) {
			setMsg((e as { message?: string }).message ?? String(e));
		}
	};

	return (
		<div className="panel-fill sync">
			<div className="sync-form">
				<div className="row2" style={{ gridTemplateColumns: "1fr auto" }}>
					<div className="field">
						<label>내 PC 폴더</label>
						<input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="C:/work/site" spellCheck={false} />
					</div>
					<button
						type="button"
						className="btn"
						style={{ alignSelf: "end", marginBottom: 10 }}
						onClick={async () => {
							const d = await openDialog({ directory: true, multiple: false });
							if (typeof d === "string") setLocal(d);
						}}
					>
						<FolderOpen size={14} />
					</button>
				</div>
				<div className="field">
					<label>서버 폴더</label>
					<input value={remote} onChange={(e) => setRemote(e.target.value)} spellCheck={false} />
				</div>
				<div className="seg" role="group">
					<button type="button" aria-pressed={direction === "up"} onClick={() => setDirection("up")}>
						내 PC → 서버
					</button>
					<button type="button" aria-pressed={direction === "down"} onClick={() => setDirection("down")}>
						서버 → 내 PC
					</button>
				</div>
				<label className="check">
					<input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} /> 받는 쪽에만 있는 것은 지우기(--delete)
				</label>
				<label className="check">
					<input type="checkbox" checked={checksum} onChange={(e) => setChecksum(e.target.checked)} /> 체크섬으로 비교(느리지만 정확, --checksum)
				</label>
				<div className="field" style={{ marginTop: 10 }}>
					<label>제외(줄마다 하나, * ? ** )</label>
					<textarea value={excludes} onChange={(e) => setExcludes(e.target.value)} rows={3} className="fp" style={{ border: 0, resize: "vertical", color: "var(--text)" }} />
				</div>
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					<button type="button" className="btn" disabled={!local || busy} onClick={() => void preview()}>
						<Eye size={14} /> {busy ? "살피는 중…" : "미리보기"}
					</button>
					<button type="button" className="btn primary" disabled={!plan || !plan.actions.length} onClick={() => void run()}>
						<Play size={14} /> 실행
					</button>
					<button
						type="button"
						className="btn ghost"
						disabled={!local}
						onClick={async () => {
							const cmd = await invoke<string>("sync_rsync_command", { opts, user, host, port });
							await navigator.clipboard.writeText(cmd);
							setMsg("rsync 명령을 복사했습니다");
						}}
					>
						<Copy size={14} /> rsync 명령
					</button>
					<button
						type="button"
						className={`btn ghost${watchId != null ? " on" : ""}`}
						disabled={!local || direction !== "up"}
						title="내 PC 폴더에서 저장한 파일을 서버의 같은 자리로 바로 보냅니다. 서버 쪽이 바뀌었으면 덮어쓰지 않고 충돌로 알립니다"
						onClick={async () => {
							if (watchId != null) {
								await invoke("watch_stop", { id: watchId });
								setWatchId(null);
								return;
							}
							try {
								setWatchId(await invoke<number>("watch_start", { conn, local, remote, excludes: opts.excludes }));
								setEvents([]);
							} catch (e) {
								setMsg((e as { message?: string }).message ?? String(e));
							}
						}}
					>
						<RadioTower size={14} /> 자동 반영 {watchId != null ? "켜짐" : ""}
					</button>
				</div>
				{msg && <p className="err" style={{ color: msg.includes("복사") || msg.includes("실행") ? "var(--text-2)" : undefined }}>{msg}</p>}
			</div>
			<div className="sync-list selectable">
				{!plan && watchId == null && <div className="panel-hint">미리보기를 누르면 옮길 파일·지울 파일이 여기 나옵니다. 실행 전에는 아무것도 바꾸지 않습니다.</div>}
				{plan && (
					<div className="sync-sum">
						옮길 것 {plan.actions.filter((a) => a.action === "copy").length}개({fmt(plan.bytes)}) · 지울 것 {plan.actions.filter((a) => a.action === "delete").length}개 · 같음 {plan.same}개 · {plan.ms} ms
					</div>
				)}
				{plan?.actions.map((a) => (
					<div key={`${a.action}:${a.path}`} className={`sync-row ${a.action}`}>
						<span>{a.action === "delete" ? "−" : a.reason === "new" ? "+" : "~"}</span>
						<code>
							{a.path}
							{a.dir ? "/" : ""}
						</code>
						<small>{a.dir ? "" : fmt(a.size)}</small>
					</div>
				))}
				{watchId != null && (
					<>
						<div className="sync-sum">자동 반영 — {local} → {remote}</div>
						{events.map((e, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 시간 순 기록
							<div key={i} className={`sync-row ${e.state === "sent" ? "copy" : "delete"}`}>
								<span>{e.state === "sent" ? "↑" : e.state === "conflict" ? "⚠" : "✗"}</span>
								<code>{e.path}</code>
								<small>{e.message ?? "보냄"}</small>
							</div>
						))}
					</>
				)}
			</div>
		</div>
	);
}
