import { AlertTriangle, ArrowRightLeft, Layers, Pencil, Plus, Power, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Forward, type ForwardActive, type ForwardKind, type ForwardStatus, forwards, forwardShort, type TmuxSession, tmux } from "../lib/ipc";

const KIND_LABEL: Record<ForwardKind, string> = { local: "로컬", remote: "원격", dynamic: "SOCKS" };
const KIND_HINT: Record<ForwardKind, string> = {
	local: "내 PC 의 포트로 들어온 연결을 서버를 거쳐 대상(서버에서 본 주소)으로 — 예: 내 PC 3306 → 서버 안 DB",
	remote: "서버의 포트로 들어온 연결을 이 PC 쪽 대상으로 — 예: 서버 8080 → 내 PC 의 개발 서버 localhost:3000",
	dynamic: "내 PC 127.0.0.1 에 SOCKS5 프록시를 엽니다 — 브라우저·도구의 프록시로 쓰면 서버를 거쳐 나갑니다(인증 없음, 이 PC 안에서만)",
};

/** 바이트 → "1.2 MB" */
export function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const u = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function errText(e: unknown): string {
	return String((e as { message?: string })?.message ?? e);
}

function blank(profileId: number): Forward {
	return { profileId, kind: "local", bindHost: "127.0.0.1", bindPort: 0, targetHost: "127.0.0.1", targetPort: null, autoStart: false, label: null };
}

/** 켜 둔 규칙 상태 — 2초마다 다시 읽는다(보일 때만) */
function useForwardStatus(q: { conn?: number; profileId?: number }, on = true) {
	const [st, setSt] = useState<ForwardStatus>({ active: [], failed: [] });
	const { conn, profileId } = q;
	const load = useCallback(() => {
		void forwards
			.status({ conn, profileId })
			.then(setSt)
			.catch(() => undefined);
	}, [conn, profileId]);
	useEffect(() => {
		if (!on) return;
		load();
		const t = window.setInterval(load, 2000);
		return () => window.clearInterval(t);
	}, [load, on]);
	return { st, load };
}

/**
 * 서버의 포트 포워딩 규칙 — 더하기·고치기·지우기, "접속하면 켜기", 지금 켜고 끄기(그 서버에 열린 연결이 있을 때).
 * 켜진 규칙은 열린 연결 수·주고받은 바이트·마지막 오류를 보여 준다.
 */
export function ForwardRules({ profileId, conn }: { profileId: number; conn?: number }) {
	const [rules, setRules] = useState<Forward[]>([]);
	const [edit, setEdit] = useState<Forward | null>(null);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState<number | null>(null);
	const { st, load: loadStatus } = useForwardStatus({ profileId });
	const load = useCallback(() => {
		void forwards
			.list(profileId)
			.then(setRules)
			.catch((e) => setErr(errText(e)));
	}, [profileId]);
	useEffect(load, [load]);
	const activeOf = (id?: number) => st.active.find((a) => a.id === id);
	const failedOf = (id?: number) => st.failed.find((f) => f.id === id && (conn == null || f.conn === conn));

	const toggle = async (f: Forward) => {
		if (f.id == null) return;
		const a = activeOf(f.id);
		setBusy(f.id);
		setErr("");
		try {
			if (a) await forwards.stop(f.id);
			else if (conn != null) await forwards.start(conn, f.id);
		} catch (e) {
			setErr(errText(e));
		} finally {
			setBusy(null);
			loadStatus();
		}
	};
	const setAuto = async (f: Forward, autoStart: boolean) => {
		try {
			await forwards.save({ ...f, autoStart });
			load();
		} catch (e) {
			setErr(errText(e));
		}
	};
	const remove = async (f: Forward) => {
		if (f.id == null) return;
		if (!confirm(`포워딩 규칙 '${f.label?.trim() || forwardShort(f)}' 을(를) 지울까요?${activeOf(f.id) ? " 켜져 있으면 끕니다." : ""}`)) return;
		try {
			await forwards.remove(f.id);
			if (edit?.id === f.id) setEdit(null);
			load();
			loadStatus();
		} catch (e) {
			setErr(errText(e));
		}
	};

	return (
		<div className="fwd-box">
			{rules.map((f) => {
				const a = activeOf(f.id);
				const fail = failedOf(f.id);
				const canToggle = !!a || conn != null;
				return (
					<div key={f.id} className={`fwd-row${a ? " on" : ""}`}>
						<button
							type="button"
							className={`fwd-power${a ? " on" : ""}`}
							disabled={!canToggle || busy === f.id}
							aria-pressed={!!a}
							title={a ? "끄기" : conn != null ? "지금 켜기" : "이 서버에 접속한 뒤에 켤 수 있습니다"}
							onClick={() => void toggle(f)}
						>
							<Power size={13} />
						</button>
						<span className={`fwd-kind k-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
						<span className="fwd-main">
							<b>{a ? a.short : forwardShort(f)}</b>
							{f.label?.trim() ? <small> {f.label}</small> : null}
							{a && (
								<small className="fwd-stat" title={`지금 열린 연결 ${a.open} · 지금까지 ${a.total}개 · 보냄 ${bytes(a.up)} · 받음 ${bytes(a.down)}`}>
									연결 {a.open}/{a.total} · ↑{bytes(a.up)} ↓{bytes(a.down)}
								</small>
							)}
							{a?.error && (
								<small className="fwd-err">
									<AlertTriangle size={11} /> {a.error}
								</small>
							)}
							{!a && fail && (
								<small className="fwd-err">
									<AlertTriangle size={11} /> 접속할 때 켜지 못했습니다: {fail.error}
								</small>
							)}
						</span>
						<label className="check fwd-auto" title="이 서버에 접속하면 저절로 켭니다">
							<input type="checkbox" checked={f.autoStart} onChange={(e) => void setAuto(f, e.target.checked)} /> 접속하면 켜기
						</label>
						<button type="button" className="btn ghost icon" title="고치기(켜져 있으면 끄고 다시 켜야 반영)" onClick={() => setEdit(f)}>
							<Pencil size={13} />
						</button>
						<button type="button" className="btn ghost icon danger" title="지우기" onClick={() => void remove(f)}>
							<Trash2 size={13} />
						</button>
					</div>
				);
			})}
			{!rules.length && !edit && <div className="panel-hint">포워딩 규칙이 없습니다. 아래에서 더하세요.</div>}
			{err && <p className="err">{err}</p>}
			{edit ? (
				<ForwardEditor
					key={edit.id ?? "new"}
					initial={edit}
					onCancel={() => setEdit(null)}
					onSaved={async (id, wasOn) => {
						setEdit(null);
						load();
						// 켜져 있던 규칙을 고쳤으면 다시 켠다(새 값으로)
						if (wasOn && conn != null) {
							try {
								await forwards.stop(id);
								await forwards.start(conn, id);
							} catch (e) {
								setErr(errText(e));
							}
						}
						loadStatus();
					}}
					wasOn={!!activeOf(edit.id)}
				/>
			) : (
				<button type="button" className="btn ghost" style={{ alignSelf: "flex-start" }} onClick={() => setEdit(blank(profileId))}>
					<Plus size={13} /> 포워딩 추가
				</button>
			)}
		</div>
	);
}

function ForwardEditor({ initial, onCancel, onSaved, wasOn }: { initial: Forward; onCancel: () => void; onSaved: (id: number, wasOn: boolean) => void; wasOn: boolean }) {
	const [f, setF] = useState<Forward>(initial);
	const [err, setErr] = useState("");
	const set = (x: Partial<Forward>) => {
		setF((o) => ({ ...o, ...x }));
		setErr("");
	};
	const num = (v: string) => Number(v.replace(/\D/g, "").slice(0, 5)) || 0;
	const save = async () => {
		try {
			onSaved(await forwards.save(f), wasOn);
		} catch (e) {
			setErr(errText(e));
		}
	};
	const isNew = initial.id == null;
	return (
		<div
			className="acc-edit fwd-edit"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onCancel();
				} else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") {
					e.preventDefault();
					e.stopPropagation();
					void save();
				}
			}}
		>
			<div className="seg" role="group" style={{ margin: 0 }}>
				{(["local", "remote", "dynamic"] as const).map((k) => (
					<button key={k} type="button" aria-pressed={f.kind === k} onClick={() => set({ kind: k, bindHost: k === "dynamic" ? "127.0.0.1" : f.bindHost })}>
						{KIND_LABEL[k]}
					</button>
				))}
			</div>
			<small className="hint">{KIND_HINT[f.kind]}</small>
			<div className="fwd-grid">
				<div className="field">
					<label htmlFor="fw-bh">{f.kind === "remote" ? "서버에서 받을 주소" : "내 PC 에서 받을 주소"}</label>
					<input id="fw-bh" value={f.bindHost} disabled={f.kind === "dynamic"} onChange={(e) => set({ bindHost: e.target.value })} placeholder="127.0.0.1" spellCheck={false} />
				</div>
				<div className="field">
					<label htmlFor="fw-bp">{f.kind === "remote" ? "서버 포트(0 = 서버가 고름)" : "내 PC 포트"}</label>
					<input id="fw-bp" inputMode="numeric" autoFocus value={f.bindPort || ""} onChange={(e) => set({ bindPort: num(e.target.value) })} placeholder={f.kind === "dynamic" ? "1080" : "3306"} />
				</div>
				{f.kind !== "dynamic" && (
					<>
						<div className="field">
							<label htmlFor="fw-th">{f.kind === "remote" ? "보낼 곳(내 PC 쪽 주소)" : "보낼 곳(서버에서 본 주소)"}</label>
							<input id="fw-th" value={f.targetHost ?? ""} onChange={(e) => set({ targetHost: e.target.value })} placeholder={f.kind === "remote" ? "localhost" : "127.0.0.1 · db"} spellCheck={false} />
						</div>
						<div className="field">
							<label htmlFor="fw-tp">보낼 포트</label>
							<input id="fw-tp" inputMode="numeric" value={f.targetPort || ""} onChange={(e) => set({ targetPort: num(e.target.value) || null })} placeholder="3306" />
						</div>
					</>
				)}
			</div>
			{f.kind === "remote" && f.bindHost.trim() !== "" && !["127.0.0.1", "localhost"].includes(f.bindHost.trim()) && (
				<small className="hint">서버 밖에서도 받으려면 sshd 의 GatewayPorts 가 켜져 있어야 합니다</small>
			)}
			<div className="fwd-grid">
				<div className="field" style={{ gridColumn: "span 2" }}>
					<label htmlFor="fw-label">이름(선택)</label>
					<input id="fw-label" value={f.label ?? ""} onChange={(e) => set({ label: e.target.value || null })} placeholder="예: 운영 DB · 관리 화면" />
				</div>
			</div>
			<label className="check" style={{ marginTop: 0 }}>
				<input type="checkbox" checked={f.autoStart} onChange={(e) => set({ autoStart: e.target.checked })} /> 이 서버에 접속하면 저절로 켜기
			</label>
			{err && <p className="err">{err}</p>}
			<div className="sheet-actions">
				<span style={{ flex: 1 }} />
				<button type="button" className="btn" onClick={onCancel}>
					취소
				</button>
				<button type="button" className="btn primary" onClick={() => void save()}>
					{isNew ? "추가" : wasOn ? "저장하고 다시 켜기" : "저장"}
				</button>
			</div>
		</div>
	);
}

/** 작업대에서 여는 포워딩 관리 창 */
export function ForwardSheet({ profileId, conn, title, onClose }: { profileId: number; conn?: number; title: string; onClose: () => void }) {
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div
				className="sheet wide fwd-sheet"
				onKeyDown={(e) => {
					if (e.key === "Escape") onClose();
				}}
			>
				<div className="sheet-title">
					<h3>
						<ArrowRightLeft size={15} /> 포트 포워딩 — {title}
					</h3>
					<button type="button" className="btn ghost icon" title="닫기" onClick={onClose}>
						<X size={14} />
					</button>
				</div>
				<ForwardRules profileId={profileId} conn={conn} />
			</div>
		</div>
	);
}

/** 상태 줄의 작은 표시 — 켜진 규칙마다 "⇄ 3306→db:3306", 누르면 관리 창 */
export function ForwardChips({ conn, onOpen }: { conn: number; onOpen: () => void }) {
	const { st } = useForwardStatus({ conn });
	const failed = st.failed.filter((f) => f.conn === conn);
	if (!st.active.length && !failed.length) return null;
	const tip = (a: ForwardActive) =>
		`${a.label ? `${a.label} — ` : ""}${a.kind === "dynamic" ? `SOCKS5 127.0.0.1:${a.port}` : a.kind === "remote" ? `서버 ${a.bindHost}:${a.port} → 내 PC ${a.targetHost}:${a.targetPort}` : `내 PC ${a.bindHost}:${a.port} → ${a.targetHost}:${a.targetPort}`}\n연결 ${a.open} (지금까지 ${a.total}) · 보냄 ${bytes(a.up)} · 받음 ${bytes(a.down)}${a.error ? `\n마지막 오류: ${a.error}` : ""}\n눌러 포워딩 관리`;
	return (
		<span className="fwd-chips">
			{st.active.map((a) => (
				<button key={a.id} type="button" className={`fwd-chip${a.error ? " warn" : ""}${a.open ? " busy" : ""}`} title={tip(a)} onClick={onOpen}>
					⇄ {a.short}
					{a.open ? <small>{a.open}</small> : null}
				</button>
			))}
			{failed.length > 0 && (
				<button type="button" className="fwd-chip warn" title={failed.map((f) => `${f.label}: ${f.error}`).join("\n")} onClick={onOpen}>
					<AlertTriangle size={10} /> 포워딩 {failed.length} 실패
				</button>
			)}
		</span>
	);
}

/** 서버의 tmux 세션 — 앱이 만든 것(rbs-번호)과 그 밖, 끝내기 */
export function TmuxSheet({ conn, title, enabled, onClose }: { conn: number; title: string; enabled: boolean; onClose: () => void }) {
	const [list, setList] = useState<TmuxSession[] | null | undefined>(undefined);
	const [err, setErr] = useState("");
	const load = useCallback(() => {
		setErr("");
		void tmux
			.list(conn)
			.then(setList)
			.catch((e) => setErr(errText(e)));
	}, [conn]);
	useEffect(load, [load]);
	const kill = async (s: TmuxSession) => {
		if (!confirm(`tmux 세션 '${s.name}' 을(를) 끝낼까요? 그 안에서 돌던 프로그램도 함께 끝납니다.${s.attached ? ` 지금 붙어 있는 터미널 ${s.attached}개도 닫힙니다.` : ""}`)) return;
		try {
			await tmux.kill(conn, s.name);
			load();
		} catch (e) {
			setErr(errText(e));
		}
	};
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="sheet wide fwd-sheet" onKeyDown={(e) => e.key === "Escape" && onClose()}>
				<div className="sheet-title">
					<h3>
						<Layers size={15} /> tmux 세션 — {title}
					</h3>
					<button type="button" className="btn ghost icon" title="다시 읽기" onClick={load}>
						<RefreshCw size={13} />
					</button>
					<button type="button" className="btn ghost icon" title="닫기" onClick={onClose}>
						<X size={14} />
					</button>
				</div>
				<small className="hint">
					{enabled
						? "이 서버는 새 터미널을 tmux 세션(rbs-번호)으로 엽니다. 연결이 끊겨도 세션은 서버에 남고, 다시 연결하면 같은 세션에 붙습니다."
						: "이 서버는 터미널을 일반 셸로 엽니다 — 서버 설정의 '터미널을 tmux 세션으로 열기'를 켜면 끊겨도 이어집니다."}
				</small>
				{list === undefined && !err && <div className="panel-hint">읽는 중…</div>}
				{list === null && <div className="panel-hint">서버에 tmux 가 없습니다(설치 예: sudo apt install tmux).</div>}
				{list && !list.length && <div className="panel-hint">tmux 세션이 없습니다.</div>}
				{list && list.length > 0 && (
					<div className="fwd-box">
						{list.map((s) => (
							<div key={s.name} className={`fwd-row${s.attached ? " on" : ""}`}>
								<span className={`fwd-kind${s.ours ? " k-local" : ""}`}>{s.ours ? "앱" : "직접"}</span>
								<span className="fwd-main">
									<b>{s.name}</b>
									<small className="fwd-stat">
										창 {s.windows}개 · {s.attached ? `붙은 터미널 ${s.attached}` : "아무도 안 붙음"}
										{s.created ? ` · ${new Date(s.created * 1000).toLocaleString()} 만듦` : ""}
									</small>
								</span>
								<button type="button" className="btn ghost icon danger" title="세션 끝내기" onClick={() => void kill(s)}>
									<Trash2 size={13} />
								</button>
							</div>
						))}
					</div>
				)}
				{err && <p className="err">{err}</p>}
			</div>
		</div>
	);
}
