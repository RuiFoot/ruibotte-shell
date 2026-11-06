import { ArrowRightLeft, Database, Fingerprint, KeyRound, Layers, Pencil, Play, Plus, Server, Settings2, ShieldAlert, Star, Stethoscope, Trash2, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Account, accountName, api, type Profile, type Route, routes as routeApi } from "../lib/ipc";
import { AccountEditor, type AccountDraft, AUTH_LABEL, blankAccount, draftOf, SUDO_LABEL } from "./AccountEditor";
import { DiagSheet } from "./DiagSheet";
import { ForwardRules } from "./ForwardPanel";
import { condText, routeName, routeSummary } from "./RouteEditor";

/** 마지막 접속(밀리초) → "3시간 전" */
export function agoMs(t?: number | null): string {
	if (!t) return "";
	const ms = t > 1e12 ? t : t * 1000;
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 60) return "방금";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
	return new Date(ms).toLocaleDateString();
}

/** sudo 표시(안 씀이면 빈 글) */
export function sudoBadge(a: Pick<Account, "sudo" | "sudoUser">): string {
	if (a.sudo === "off") return "";
	return `sudo ${SUDO_LABEL[a.sudo]}${a.sudoUser && a.sudoUser !== "root" ? ` · -u ${a.sudoUser}` : ""}`;
}

/**
 * 서버 카드 — 서버를 누르면 바로 접속하지 않고 여기서 서버 정보를 보고 계정을 고른다.
 * 계정 줄: 접속·고치기·지우기, 두 번 누르면 그 계정으로 접속. Enter = 고른(처음엔 기본) 계정으로 접속.
 */
export function ServerCard({
	profile: p,
	onClose,
	onConnect,
	onEditServer,
	onChanged,
	via,
	openConn,
	servers = [],
}: {
	profile: Profile;
	/** 경로 줄임에 쓸 서버 목록(점프 단계 이름) */
	servers?: Profile[];
	/** DB: 거쳐 가는 SSH 서버 이름(SSH 터널) */
	via?: string;
	/** SSH: 지금 이 서버에 열린 연결(포워딩을 바로 켜고 끄기) */
	openConn?: number;
	onClose: () => void;
	onConnect: (a: Account) => void;
	onEditServer: () => void;
	/** 계정을 바꿨을 때(목록 다시 읽기) */
	onChanged: () => void;
}) {
	const accounts = p.accounts ?? [];
	const [sel, setSel] = useState(() => Math.max(0, accounts.findIndex((a) => a.isDefault)));
	const [editing, setEditing] = useState<AccountDraft | null>(null);
	const [hostKey, setHostKey] = useState<{ algorithm: string; fingerprint: string } | null>(null);
	const [err, setErr] = useState("");
	const [showFwd, setShowFwd] = useState(false);
	const [routeList, setRouteList] = useState<Route[]>([]);
	const [nowRoute, setNowRoute] = useState<number | null>(null);
	const [diag, setDiag] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (p.kind !== "ssh" || p.id == null) return;
		void routeApi
			.list(p.id)
			.then(setRouteList)
			.catch(() => setRouteList([]));
	}, [p.kind, p.id, p.host, p.port]);
	useEffect(() => {
		if (openConn == null) return setNowRoute(null);
		void routeApi
			.ofConn(openConn)
			.then((r) => setNowRoute(r?.id ?? null))
			.catch(() => setNowRoute(null));
	}, [openConn]);
	const lastRoute = routeList.reduce<Route | null>((b, r) => ((r.lastOkAt ?? 0) > (b?.lastOkAt ?? 0) ? r : b), null);
	useEffect(() => {
		if (p.kind !== "ssh") return;
		void api
			.hostKeyGet(p.host, p.port)
			.then(setHostKey)
			.catch(() => setHostKey(null));
	}, [p.kind, p.host, p.port]);
	useEffect(() => {
		listRef.current?.focus();
	}, []);
	useEffect(() => {
		if (sel >= accounts.length) setSel(Math.max(0, accounts.length - 1));
	}, [accounts.length, sel]);

	const remove = async (a: Account) => {
		if (a.id == null) return;
		if (accounts.length <= 1) {
			setErr("서버에 남은 마지막 계정이라 지울 수 없습니다. 서버째 지우려면 '서버 설정'에서 지우세요.");
			return;
		}
		if (!confirm(`'${accountName(a)}' 계정을 지울까요? 저장한 암호·sudo 암호도 함께 지웁니다.`)) return;
		try {
			await api.accountDelete(a.id);
			setErr("");
			onChanged();
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		}
	};
	const makeDefault = async (a: Account) => {
		if (a.id == null || a.isDefault) return;
		await api.accountSetDefault(a.id);
		onChanged();
	};

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div
				className="sheet wide server-card"
				onKeyDown={(e) => {
					if (editing) return;
					if (e.key === "Escape") onClose();
				}}
			>
				<div className="sc-head">
					<span className="sc-dot" style={{ background: p.color ?? "var(--accent)" }} />
					<div className="sc-title">
						<h3>
							{p.kind === "ssh" ? <Server size={15} /> : <Database size={15} />} {p.name}
						</h3>
						<div className="sc-addr">
							{p.kind === "db" ? `${p.engine ?? "postgres"} · ` : "SSH · "}
							{p.host}:{p.port}
							{p.kind === "db" && p.database ? `/${p.database}` : ""}
							{p.groupName ? <span className="badge">{p.groupName}</span> : null}
							{p.legacy !== "off" && <span className="badge warn">구형 호환</span>}
							{p.kind === "db" && via && (
								<span className="badge via-badge" title={`${via} 를 거쳐 접속합니다(SSH 터널) — 위 주소는 그 서버에서 본 DB 주소`}>
									<ArrowRightLeft size={10} /> SSH 경유 · {via}
								</span>
							)}
							{p.kind === "ssh" && p.tmux && (
								<span className="badge" title="새 터미널을 tmux 세션으로 엽니다 — 끊겨도 다시 연결하면 이어짐">
									<Layers size={10} /> tmux
								</span>
							)}
						</div>
					</div>
					{p.kind === "ssh" && p.id != null && (
						<button type="button" className="btn ghost" title="경로마다 이름 풀이·TCP·SSH 인사·호스트 키·인증까지 어디서 막히는지 봅니다(고른 계정으로)" onClick={() => setDiag(true)}>
							<Stethoscope size={14} /> 진단
						</button>
					)}
					<button type="button" className="btn ghost" title="서버 설정(주소·경로·묶음·메모·점프·계정)" onClick={onEditServer}>
						<Settings2 size={14} /> 서버 설정
					</button>
				</div>
				{p.memo && <p className="sc-memo">{p.memo}</p>}
				<div className="sc-facts">
					<span>마지막 접속 {p.lastUsedAt ? agoMs(p.lastUsedAt) : "없음"}</span>
					{p.kind === "ssh" && (
						<span title={hostKey ? `${hostKey.algorithm} ${hostKey.fingerprint}` : "아직 접속한 적이 없어 지문을 고정하지 않았습니다"}>
							<Fingerprint size={12} /> {hostKey ? <code>{hostKey.fingerprint}</code> : "호스트 키 미고정"}
						</span>
					)}
				</div>

				{p.kind === "ssh" && routeList.length > 1 && (
					<div className="sc-routes" aria-label="경로">
						{routeList.map((r, i) => (
							<div key={r.id} className={`sc-route${nowRoute === r.id ? " now" : ""}`} title={r.lastOkAt ? `이 경로로 마지막 접속 ${agoMs(r.lastOkAt)}` : "아직 이 경로로 붙은 적이 없습니다"}>
								<span className="rt-n">{i + 1}</span>
								<b>{routeName(r, i)}</b>
								<span className="rt-sum">{routeSummary(r, servers)}</span>
								{r.condKind && (
									<span className="badge" title={condText(r)}>
										<Wifi size={10} /> {condText(r)}
									</span>
								)}
								{nowRoute === r.id ? <span className="badge">지금 연결</span> : lastRoute?.id === r.id ? <span className="badge">지난번</span> : null}
							</div>
						))}
					</div>
				)}
				<div className="sc-acc-head">
					<b>계정</b> <small>{accounts.length}</small>
					<span style={{ flex: 1 }} />
					<small className="sc-tip">Enter 접속 · ↑↓ 고르기 · 두 번 눌러 접속</small>
				</div>
				<div
					className="sc-accounts"
					ref={listRef}
					tabIndex={0}
					role="listbox"
					aria-label="계정"
					onKeyDown={(e) => {
						if (editing) return;
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setSel((i) => Math.min(accounts.length - 1, i + 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setSel((i) => Math.max(0, i - 1));
						} else if (e.key === "Enter" && accounts[sel]) {
							e.preventDefault();
							onConnect(accounts[sel]);
						}
					}}
				>
					{accounts.map((a, i) => (
						<div
							key={a.id}
							className="sc-acc"
							role="option"
							aria-selected={i === sel}
							tabIndex={-1}
							onClick={() => setSel(i)}
							onDoubleClick={() => onConnect(a)}
						>
							<button
								type="button"
								className={`sc-star${a.isDefault ? " on" : ""}`}
								title={a.isDefault ? "기본 계정" : "기본 계정으로"}
								onClick={(e) => {
									e.stopPropagation();
									void makeDefault(a);
								}}
							>
								<Star size={13} />
							</button>
							<div className="sc-acc-meta">
								<b>
									{accountName(a)}
									{a.label?.trim() ? <small className="sc-user"> {a.username}</small> : null}
								</b>
								<small>
									{p.kind === "ssh" ? AUTH_LABEL[a.auth] : "암호"}
									{a.auth !== "agent" && (a.secretSaved ? " · 저장됨" : " · 접속 때 물음")}
									{a.lastUsedAt ? ` · ${agoMs(a.lastUsedAt)}` : ""}
								</small>
							</div>
							{a.secretSaved && <KeyRound size={12} className="sc-ic" aria-label="암호 저장됨" />}
							{p.kind === "ssh" && a.sudo !== "off" && (
								<span className="badge" title={sudoBadge(a)}>
									<ShieldAlert size={10} /> {sudoBadge(a)}
								</span>
							)}
							<span className="sc-acts">
								<button
									type="button"
									className="btn ghost icon"
									title="고치기"
									onClick={(e) => {
										e.stopPropagation();
										setEditing(draftOf(a));
									}}
								>
									<Pencil size={13} />
								</button>
								<button
									type="button"
									className="btn ghost icon danger"
									title={accounts.length <= 1 ? "마지막 계정은 지울 수 없습니다" : "지우기"}
									disabled={accounts.length <= 1}
									onClick={(e) => {
										e.stopPropagation();
										void remove(a);
									}}
								>
									<Trash2 size={13} />
								</button>
								<button
									type="button"
									className="btn primary sc-go"
									onClick={(e) => {
										e.stopPropagation();
										onConnect(a);
									}}
								>
									<Play size={12} /> 접속
								</button>
							</span>
						</div>
					))}
					{!accounts.length && <div className="panel-hint">계정이 없습니다. 아래에서 더하세요.</div>}
				</div>
				{err && <p className="err">{err}</p>}
				{p.kind === "ssh" && p.id != null && (
					<>
						<button type="button" className="btn ghost disclose sc-fwd-toggle" onClick={() => setShowFwd((x) => !x)} title="이 서버를 거치는 포트 포워딩(로컬·원격·SOCKS)">
							{showFwd ? "▾" : "▸"} <ArrowRightLeft size={13} /> 포트 포워딩{openConn == null ? " — 접속하면 켜고 끌 수 있습니다" : ""}
						</button>
						{showFwd && <ForwardRules profileId={p.id} conn={openConn} />}
					</>
				)}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => p.id != null && setEditing(blankAccount(p.id, p.kind))}>
						<Plus size={14} /> 계정 추가
					</button>
					<span style={{ flex: 1 }} />
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button type="button" className="btn primary" disabled={!accounts[sel]} onClick={() => accounts[sel] && onConnect(accounts[sel])}>
						<Play size={13} /> {accounts[sel] ? `${accounts[sel].username} 로 접속` : "접속"}
					</button>
				</div>
			</div>
			{diag && p.id != null && <DiagSheet profileId={p.id} accountId={accounts[sel]?.id} title={`${p.name}${accounts[sel] ? ` · ${accounts[sel].username}` : ""}`} onClose={() => setDiag(false)} />}
			{editing && (
				<AccountEditor
					asSheet
					server={p}
					initial={editing}
					onCancel={() => {
						setEditing(null);
						requestAnimationFrame(() => listRef.current?.focus());
					}}
					onSaved={() => {
						setEditing(null);
						onChanged();
						requestAnimationFrame(() => listRef.current?.focus());
					}}
				/>
			)}
		</div>
	);
}
