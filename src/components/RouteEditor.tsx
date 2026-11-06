import { ArrowDown, ArrowUp, ArrowRight, Pencil, Plus, Route as RouteIcon, Trash2, Wifi, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { accountName, api, type CondKind, type Hop, type NetInfo, type Profile, type ProxyKind, type Route, routes as routeApi } from "../lib/ipc";
import { agoMs } from "./ServerCard";
import { Select } from "./Select";

export const COND_LABEL: Record<CondKind, string> = { gateway: "기본 게이트웨이", dns: "DNS 접미사", wifi: "Wi-Fi 이름", reach: "닿는 호스트" };
const PROXY_LABEL: Record<ProxyKind, string> = { http: "HTTP 프록시", socks5: "SOCKS5 프록시", command: "프록시 명령" };

/** 경로 이름 — 라벨, 없으면 "경로 n" */
export function routeName(r: Route, i: number): string {
	return r.label?.trim() || `경로 ${i + 1}`;
}

/** 경로 줄임 — "SOCKS5 프록시 · 점프 A → B · host:22" */
export function routeSummary(r: Route, servers: Profile[]): string {
	const parts: string[] = [];
	if (r.proxyKind === "command") parts.push("프록시 명령");
	else if (r.proxyKind) parts.push(`${PROXY_LABEL[r.proxyKind]} ${r.proxyHost ?? ""}:${r.proxyPort ?? ""}`);
	if (r.jumps.length) parts.push(`점프 ${r.jumps.map((h) => servers.find((s) => s.id === h.profileId)?.name ?? "(지워진 서버)").join(" → ")}`);
	parts.push(`${r.host}:${r.port}`);
	return parts.join(" · ");
}

/** 망 조건 한 줄 */
export function condText(r: Route): string {
	if (!r.condKind) return "";
	return `${COND_LABEL[r.condKind]} ${r.condValue ?? ""}${r.condNot ? " 이(가) 아닐 때" : " 일 때"}`;
}

const TIMEOUTS = [3, 4, 5, 8, 10];

/**
 * 서버 설정의 "경로" 칸 — 한 서버에 주소 여럿(사내 직접·외부 주소·점프 경유·프록시 경유)을 순서대로.
 * 접속할 때 망 조건이 맞는 경로부터 차례로 시도하고, 붙지 못하면(정한 시간 안에) 다음 경로로 넘어간다.
 * 첫 경로는 위의 주소·포트·점프 호스트 칸과 같다(바꾸면 onFirst 로 알린다).
 */
export function RoutesBox({ profileId, others, onFirst }: { profileId?: number; others: Profile[]; onFirst?: (r: Route) => void }) {
	const [list, setList] = useState<Route[]>([]);
	const [edit, setEdit] = useState<Route | null>(null);
	const [err, setErr] = useState("");
	const [wait, setWait] = useState(4);
	const servers = others.filter((o) => o.kind === "ssh");

	const load = useCallback(async () => {
		if (profileId == null) return [];
		const l = await routeApi.list(profileId);
		setList(l);
		return l;
	}, [profileId]);
	useEffect(() => {
		void load().catch((e) => setErr(String(e)));
		void api.settingGet("ssh.routeTimeoutSec").then((v) => {
			const n = Number(v);
			if (n) setWait(n);
		});
	}, [load]);

	const after = async (before: Route | undefined) => {
		const l = await load();
		const f = l[0];
		if (f && onFirst && (!before || before.id !== f.id || before.host !== f.host || before.port !== f.port || before.jumps[0]?.profileId !== f.jumps[0]?.profileId)) onFirst(f);
	};
	const move = async (i: number, d: -1 | 1) => {
		if (profileId == null) return;
		const ids = list.map((r) => r.id as number);
		const j = i + d;
		if (j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		try {
			await routeApi.reorder(profileId, ids);
			setErr("");
			await after(list[0]);
		} catch (e) {
			setErr(String(e));
		}
	};
	const remove = async (r: Route, i: number) => {
		if (r.id == null) return;
		try {
			await routeApi.remove(r.id);
			setErr("");
			await after(i === 0 ? undefined : list[0]);
		} catch (e) {
			setErr(String(e));
		}
	};

	if (profileId == null) {
		return (
			<fieldset className="sheet-sec">
				<legend>경로</legend>
				<p className="panel-hint">저장한 뒤 이 서버에 닿는 길을 더 넣을 수 있습니다 — 사내 직접·외부 주소, 점프 여러 단계, 프록시. 망에 따라 맞는 길을 골라 붙습니다.</p>
			</fieldset>
		);
	}

	return (
		<fieldset className="sheet-sec">
			<legend>경로 — 위에서부터 차례로 시도</legend>
			<div className="rt-list">
				{list.map((r, i) => (
					<div key={r.id} className="rt-row">
						<span className="rt-n">{i + 1}</span>
						<span className="rt-main">
							<b>{routeName(r, i)}</b>
							<small className="rt-sum">{routeSummary(r, servers)}</small>
							{(r.condKind || r.lastOkAt) && (
								<small className="rt-meta">
									{r.condKind && (
										<span className="badge">
											<Wifi size={10} /> {condText(r)}
										</span>
									)}
									{r.lastOkAt ? <span>마지막 접속 {agoMs(r.lastOkAt)}</span> : null}
								</small>
							)}
						</span>
						<span className="rt-acts">
							<button type="button" className="btn ghost icon" title="위로" disabled={i === 0} onClick={() => void move(i, -1)}>
								<ArrowUp size={13} />
							</button>
							<button type="button" className="btn ghost icon" title="아래로" disabled={i === list.length - 1} onClick={() => void move(i, 1)}>
								<ArrowDown size={13} />
							</button>
							<button type="button" className="btn ghost icon" title="고치기" onClick={() => setEdit(r)}>
								<Pencil size={13} />
							</button>
							<button type="button" className="btn ghost icon danger" title={list.length <= 1 ? "마지막 경로는 지울 수 없습니다" : "지우기"} disabled={list.length <= 1} onClick={() => void remove(r, i)}>
								<Trash2 size={13} />
							</button>
						</span>
					</div>
				))}
			</div>
			{err && <p className="err">{err}</p>}
			<div className="rt-foot">
				<button type="button" className="btn ghost" onClick={() => setEdit({ profileId, host: "", port: 22, jumps: [] })}>
					<Plus size={14} /> 경로 추가
				</button>
				<span style={{ flex: 1 }} />
				<label className="rt-wait" htmlFor="rt-wait">
					경로마다 기다리기
				</label>
				<Select
					id="rt-wait"
					size="sm"
					value={wait}
					onChange={(v) => {
						setWait(v);
						void api.settingSet("ssh.routeTimeoutSec", String(v));
					}}
					options={TIMEOUTS.map((n) => ({ value: n, label: `${n}초`, hint: n === 4 ? "기본" : undefined }))}
					title="경로가 여럿일 때, 한 경로에서 이 시간 안에 SSH 인사가 오지 않으면 다음 경로로 넘어갑니다(모든 서버 공통)"
				/>
			</div>
			{list.length > 0 && list[0].jumps.length > 1 && <small className="hint">첫 경로의 점프가 두 단계 이상이라 위의 "점프 호스트" 칸 대신 여기서 고칩니다.</small>}
			{edit && (
				<RouteSheet
					initial={edit}
					index={edit.id == null ? list.length : list.findIndex((x) => x.id === edit.id)}
					servers={servers.filter((s) => s.id !== profileId)}
					onCancel={() => setEdit(null)}
					onSaved={() => {
						const before = list[0];
						setEdit(null);
						void after(before);
					}}
				/>
			)}
		</fieldset>
	);
}

/** 경로 하나 고치기 */
function RouteSheet({ initial, index, servers, onCancel, onSaved }: { initial: Route; index: number; servers: Profile[]; onCancel: () => void; onSaved: () => void }) {
	const [r, setR] = useState<Route>(initial);
	const [secret, setSecret] = useState("");
	const [forgetSecret, setForgetSecret] = useState(false);
	const [err, setErr] = useState("");
	const [net, setNet] = useState<NetInfo | null>(null);
	const set = (patch: Partial<Route>) => setR((x) => ({ ...x, ...patch }));
	useEffect(() => {
		void routeApi
			.net()
			.then(setNet)
			.catch(() => setNet(null));
	}, []);

	const setHop = (i: number, h: Hop | null) => {
		const jumps = [...r.jumps];
		if (h) jumps[i] = h;
		else jumps.splice(i, 1);
		set({ jumps });
	};
	const used = new Set(r.jumps.map((h) => h.profileId));
	const condOptions: { value: CondKind | ""; label: string; hint?: string }[] = [
		{ value: "", label: "늘 시도", hint: "망과 상관없이" },
		...(net?.supportsGateway !== false ? [{ value: "gateway" as const, label: COND_LABEL.gateway, hint: "공유기·사내 게이트웨이 IP" }] : []),
		...(net?.supportsDns !== false ? [{ value: "dns" as const, label: COND_LABEL.dns, hint: "사내망이 주는 도메인" }] : []),
		...(net?.supportsWifi ? [{ value: "wifi" as const, label: COND_LABEL.wifi, hint: "연결된 Wi-Fi(SSID)" }] : []),
		{ value: "reach", label: COND_LABEL.reach, hint: "호스트:포트가 0.3초 안에 닿으면" },
	];
	const nowValues: string[] = r.condKind === "gateway" ? (net?.gateways ?? []) : r.condKind === "dns" ? (net?.dnsSuffixes ?? []) : r.condKind === "wifi" ? (net?.wifi ?? []) : [];

	async function save() {
		try {
			const pass = r.proxyKind === "http" || r.proxyKind === "socks5" ? (forgetSecret ? "" : secret || undefined) : r.proxySecretSaved ? "" : undefined;
			await routeApi.save(r, pass);
			onSaved();
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		}
	}

	// 서버 설정 시트(form) 안에 form 을 겹치지 않게 body 로 띄운다
	return createPortal(
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
			<form
				className="sheet wide rt-sheet"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onCancel();
					}
				}}
			>
				<h3>
					<RouteIcon size={15} /> {initial.id == null ? "경로 추가" : `${routeName(initial, index)} 고치기`}
				</h3>
				<div className="field">
					<label htmlFor="rt-label">이름</label>
					<input id="rt-label" value={r.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder={`예: 사내 직접 · 외부 주소 · 점프 경유 (비우면 경로 ${index + 1})`} />
				</div>
				<div className="row2">
					<div className="field">
						<label htmlFor="rt-host">{r.jumps.length ? "대상 주소(마지막 점프 서버에서 본 주소)" : "주소"}</label>
						<input id="rt-host" value={r.host} onChange={(e) => set({ host: e.target.value })} placeholder="host.example.com" spellCheck={false} autoFocus />
					</div>
					<div className="field">
						<label htmlFor="rt-port">포트</label>
						<input id="rt-port" inputMode="numeric" value={r.port || ""} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
					</div>
				</div>

				<fieldset className="sheet-sec">
					<legend>점프 단계 — 순서대로 거쳐 감</legend>
					{r.jumps.length > 0 && (
						<div className="rt-chain" aria-label="거쳐 가는 길">
							<span>내 PC</span>
							{r.proxyKind && (
								<>
									<ArrowRight size={11} />
									<span className="rt-chip">{PROXY_LABEL[r.proxyKind]}</span>
								</>
							)}
							{r.jumps.map((h, i) => (
								<span key={`${h.profileId}-${i}`} className="rt-chain-seg">
									<ArrowRight size={11} />
									<span className="rt-chip">{servers.find((s) => s.id === h.profileId)?.name ?? "?"}</span>
								</span>
							))}
							<ArrowRight size={11} />
							<span className="rt-chip on">대상</span>
						</div>
					)}
					{r.jumps.map((h, i) => {
						const srv = servers.find((s) => s.id === h.profileId);
						return (
							<div key={`${h.profileId}-${i}`} className="rt-hop">
								<span className="rt-n">{i + 1}</span>
								<Select
									aria-label={`점프 ${i + 1} 서버`}
									value={h.profileId}
									onChange={(v) => setHop(i, { profileId: v, accountId: null })}
									options={servers.map((s) => ({ value: s.id as number, label: s.name, hint: `${s.host}:${s.port}`, disabled: s.id !== h.profileId && used.has(s.id as number) }))}
								/>
								<Select
									aria-label={`점프 ${i + 1} 계정`}
									value={h.accountId ?? 0}
									onChange={(v) => setHop(i, { ...h, accountId: v || null })}
									options={[{ value: 0, label: "기본 계정" }, ...(srv?.accounts ?? []).map((a) => ({ value: a.id as number, label: accountName(a), hint: a.secretSaved || a.auth !== "password" ? undefined : "암호 저장 필요" }))]}
								/>
								<button type="button" className="btn ghost icon" title="이 단계 빼기" onClick={() => setHop(i, null)}>
									<X size={13} />
								</button>
							</div>
						);
					})}
					{r.jumps.length < 5 && (
						<button
							type="button"
							className="btn ghost"
							disabled={!servers.some((s) => !used.has(s.id as number))}
							onClick={() => {
								const next = servers.find((s) => !used.has(s.id as number));
								if (next?.id != null) set({ jumps: [...r.jumps, { profileId: next.id, accountId: null }] });
							}}
						>
							<Plus size={14} /> 점프 단계 추가
						</button>
					)}
					<small className="hint">각 점프 서버는 한 번 접속해 지문을 고정하고 계정 암호를 저장해 두어야 합니다(접속 중에는 묻지 않습니다). 같은 서버는 두 번 거칠 수 없습니다.</small>
				</fieldset>

				<fieldset className="sheet-sec">
					<legend>프록시 — 첫 구간{r.jumps.length ? "(첫 점프 서버까지)" : ""}</legend>
					<div className="field">
						<Select<ProxyKind | "">
							aria-label="프록시 방식"
							value={r.proxyKind ?? ""}
							onChange={(v) => set({ proxyKind: v || null })}
							options={[
								{ value: "", label: "거치지 않음", hint: "바로 연결" },
								{ value: "http", label: "HTTP 프록시", hint: "CONNECT" },
								{ value: "socks5", label: "SOCKS5 프록시", hint: "이름은 프록시가 풀이" },
								{ value: "command", label: "프록시 명령", hint: "ProxyCommand — 표준 입출력으로" },
							]}
						/>
					</div>
					{(r.proxyKind === "http" || r.proxyKind === "socks5") && (
						<>
							<div className="row2">
								<div className="field">
									<label htmlFor="rt-ph">프록시 주소</label>
									<input id="rt-ph" value={r.proxyHost ?? ""} onChange={(e) => set({ proxyHost: e.target.value })} spellCheck={false} placeholder="proxy.example.com" />
								</div>
								<div className="field">
									<label htmlFor="rt-pp">포트</label>
									<input id="rt-pp" inputMode="numeric" value={r.proxyPort ?? ""} onChange={(e) => set({ proxyPort: Number(e.target.value.replace(/\D/g, "")) || null })} placeholder={r.proxyKind === "http" ? "3128" : "1080"} />
								</div>
							</div>
							<div className="rt-two">
								<div className="field">
									<label htmlFor="rt-pu">계정(선택)</label>
									<input id="rt-pu" value={r.proxyUser ?? ""} onChange={(e) => set({ proxyUser: e.target.value })} spellCheck={false} autoComplete="off" />
								</div>
								<div className="field">
									<label htmlFor="rt-pw">암호{r.proxySecretSaved ? " — 저장됨" : ""}</label>
									<input
										id="rt-pw"
										type="password"
										value={secret}
										disabled={forgetSecret}
										onChange={(e) => setSecret(e.target.value)}
										placeholder={r.proxySecretSaved ? "바꿀 때만 입력" : "OS 자격 증명 저장소에 저장"}
										autoComplete="new-password"
									/>
								</div>
							</div>
							{r.proxySecretSaved && (
								<label className="check">
									<input type="checkbox" checked={forgetSecret} onChange={(e) => setForgetSecret(e.target.checked)} /> 저장한 프록시 암호 지우기
								</label>
							)}
						</>
					)}
					{r.proxyKind === "command" && (
						<div className="field">
							<label htmlFor="rt-cmd">명령</label>
							<input id="rt-cmd" className="mono" value={r.proxyCommand ?? ""} onChange={(e) => set({ proxyCommand: e.target.value })} spellCheck={false} placeholder="ssh -W %h:%p gateway" />
							<small className="hint">%h·%p = {r.jumps.length ? "첫 점프 서버" : "대상"} 주소·포트, %r = 사용자, %% = %. 명령의 표준 입출력이 SSH 연결이 됩니다(창은 뜨지 않음).</small>
						</div>
					)}
				</fieldset>

				<fieldset className="sheet-sec">
					<legend>이 망일 때만</legend>
					<div className="rt-two">
						<div className="field">
							<Select<CondKind | "">
								aria-label="망 조건"
								value={r.condKind ?? ""}
								onChange={(v) => set({ condKind: v || null, condValue: v === r.condKind ? r.condValue : "" })}
								options={condOptions}
							/>
						</div>
						{r.condKind && (
							<div className="field">
								<input
									aria-label="조건 값"
									value={r.condValue ?? ""}
									onChange={(e) => set({ condValue: e.target.value })}
									spellCheck={false}
									placeholder={r.condKind === "reach" ? "intranet.example:443" : r.condKind === "gateway" ? "192.0.2.1" : r.condKind === "dns" ? "corp.example" : "Office-WiFi"}
								/>
							</div>
						)}
					</div>
					{r.condKind && nowValues.length > 0 && (
						<div className="rt-now">
							<small>지금 PC:</small>
							{nowValues.map((v) => (
								<button key={v} type="button" className={`chip${r.condValue === v ? " on" : ""}`} onClick={() => set({ condValue: v })} title="눌러 넣기">
									{v}
								</button>
							))}
						</div>
					)}
					{r.condKind === "wifi" && net?.wifiNote && <small className="hint">{net.wifiNote}</small>}
					{r.condKind && (
						<label className="check">
							<input type="checkbox" checked={!!r.condNot} onChange={(e) => set({ condNot: e.target.checked })} /> 거꾸로 — 그 망이 <b>아닐 때만</b> 시도
						</label>
					)}
					<small className="hint">
						{r.condKind
							? "여러 값은 쉼표로. 맞으면 이 경로를 먼저, 안 맞으면 건너뜁니다(모든 경로가 안 맞으면 차례로 다 시도)."
							: "조건이 없으면 조건이 맞는 경로 다음에 차례대로 시도합니다."}
					</small>
				</fieldset>

				{err && <p className="err">{err}</p>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onCancel}>
						취소
					</button>
					<button type="submit" className="btn primary" disabled={!r.host.trim() || !r.port}>
						저장
					</button>
				</div>
			</form>
		</div>,
		document.body,
	);
}
