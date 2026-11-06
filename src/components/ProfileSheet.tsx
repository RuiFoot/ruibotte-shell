import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Copy, KeyRound, Loader2, Pencil, PlugZap, Plus, ShieldAlert, ShieldQuestion, Star, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ENGINES, engineOf } from "../lib/engines";
import { type Account, accountName, api, asSshError, defaultAccount, type LegacyLevel, type Profile, tunnelReq } from "../lib/ipc";
import { AccountEditor, type AccountDraft, AccountFields, AUTH_LABEL, blankAccount, draftOf, saveAccountDraft } from "./AccountEditor";
import { getAppearance, onAppearance, setProfileScheme, TERM_SCHEMES } from "../lib/theme";
import { RoutesBox } from "./RouteEditor";
import { Select } from "./Select";
import { agoMs, sudoBadge } from "./ServerCard";

const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#8e8e93"];
const DB_PORT: Record<string, number> = Object.fromEntries(ENGINES.map((e) => [e.key, e.port]));
const LEVEL_NAME: Record<LegacyLevel, string> = { off: "끔", rsa: "RSA", sha1: "SHA1", weakest: "최후" };

export function blankProfile(kind: "ssh" | "db"): Profile {
	return {
		kind,
		name: "",
		host: "",
		port: kind === "ssh" ? 22 : 5432,
		username: "",
		engine: kind === "db" ? "postgres" : null,
		color: COLORS[0],
		favorite: true,
		auth: "password",
		keyPath: null,
		legacy: "off",
		defaultPath: null,
		database: null,
		groupName: null,
	};
}

type Test =
	| { s: "idle" }
	| { s: "running" }
	| { s: "ok"; text: string }
	| { s: "fail"; text: string }
	| { s: "hostkey"; fingerprint: string; algorithm: string; mismatch?: string; via?: boolean }
	| { s: "legacy"; text: string; suggest: LegacyLevel };

/**
 * 연결 설정 — 주소·묶음·색·고급(점프·구형 호환)과 이 서버의 계정들(사용자명·인증·암호·sudo).
 * 새 서버는 계정 하나를 함께 입력하고, 저장한 서버는 계정을 더하고·고치고·지운다(계정마다 바로 저장).
 * 저장 전에 "연결 테스트"로 실제로 붙어 본다. 고칠 때는 지우기·복제도 여기서.
 */
export function ProfileSheet({
	initial,
	onClose,
	onSaved,
	onDeleted,
	onDuplicate,
	others = [],
	extraGroups = [],
	inline = false,
	onConnect,
	onDirty,
	onAccountsChanged,
}: {
	/** 점프 호스트·묶음 후보를 고를 다른 프로필 */
	others?: Profile[];
	/** 연결이 아직 없는 묶음 */
	extraGroups?: string[];
	initial: Profile;
	onClose: () => void;
	onSaved: (id: number) => void;
	onDeleted?: (id: number) => void;
	onDuplicate?: (p: Profile) => void;
	/** 연결 관리 화면 안에 그대로(시트가 아니라) */
	inline?: boolean;
	/** 저장한 뒤 바로 접속 */
	onConnect?: (p: Profile) => void;
	/** 고친 게 있는지(다른 연결로 옮길 때 묻기) */
	onDirty?: (dirty: boolean) => void;
	/** 계정을 더하거나 고쳤을 때(목록 다시 읽기) */
	onAccountsChanged?: () => void;
}) {
	const [p, setP] = useState<Profile>(initial);
	const [err, setErr] = useState("");
	const [advanced, setAdvanced] = useState(initial.legacy !== "off" || !!initial.jumpId);
	// 새 서버: 함께 만들 첫 계정(복제면 원래 서버의 기본 계정 설정을 따른다)
	const [draft, setDraft] = useState<AccountDraft>(() => {
		const base = defaultAccount(initial);
		const d = base ? draftOf({ ...base, id: undefined, secretSaved: false, sudoSaved: false, lastUsedAt: null }) : blankAccount(0, initial.kind);
		return { ...d, username: d.username || initial.username, isDefault: true };
	});
	const [test, setTest] = useState<Test>({ s: "idle" });
	const [saving, setSaving] = useState(false);
	const set = (patch: Partial<Profile>) => {
		setP((x) => ({ ...x, ...patch }));
		if (test.s !== "running") setTest({ s: "idle" });
	};
	const editing = initial.id != null;
	// DB 읽기 전용 접속(연결마다 기억 — 접속 창의 체크와 같은 값)
	const [ro, setRo] = useState(false);
	const [roInit, setRoInit] = useState(false);
	useEffect(() => {
		if (initial.id == null) return;
		void api.settingGet(`db.readonly.${initial.id}`).then((v) => {
			setRo(v === "1");
			setRoInit(v === "1");
		});
	}, [initial.id]);
	// 계정은 따로 저장되니 서버 고침 여부에서 뺀다
	const strip = (x: Profile) => JSON.stringify({ ...x, accounts: undefined, username: undefined, auth: undefined, keyPath: undefined, secretSaved: undefined, lastUsedAt: undefined, accountId: undefined });
	const draftDirty = !editing && (!!draft.username.trim() || !!draft.secret);
	const dirty = strip(p) !== strip(initial) || draftDirty || ro !== roInit;
	useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
	// 테스트에 쓸 계정 — 새 서버는 입력 중인 계정, 저장한 서버는 기본 계정
	const defAcc = defaultAccount(initial);
	const acc: AccountDraft = editing ? (defAcc ? draftOf(defAcc) : blankAccount(initial.id ?? 0, p.kind)) : draft;
	const groups = [...new Set([...others.map((o) => o.groupName), ...extraGroups].filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ko"));

	async function runTest(trust?: string, legacy?: LegacyLevel) {
		setTest({ s: "running" });
		const lv = legacy ?? p.legacy;
		if (legacy) setP((x) => ({ ...x, legacy }));
		try {
			if (p.kind === "ssh") {
				const r = await invoke<{ ms: number; home: string; algorithm: string; newlyPinned: boolean }>("ssh_test", {
					req: {
						accountId: acc.id,
						host: p.host.trim(),
						port: p.port,
						username: acc.username.trim(),
						auth: acc.auth,
						keyPath: acc.keyPath,
						secret: acc.secret || null,
						legacy: lv,
						trustFingerprint: trust ?? null,
						jumpId: p.jumpId ?? null,
					},
				});
				setTest({ s: "ok", text: `접속됨 · ${r.ms} ms · ${r.algorithm}${r.newlyPinned ? " · 지문 고정" : ""} · 홈 ${r.home}` });
			} else {
				const r = await invoke<{ ms: number; version: string }>("db_test", {
					req: {
						accountId: acc.id,
						engine: p.engine ?? "postgres",
						host: p.host.trim(),
						port: p.port,
						username: acc.username.trim(),
						password: acc.secret || null,
						database: p.database,
						readOnly: false,
						legacy: p.legacy !== "off",
						ssl: p.ssl ?? null,
						...tunnelReq(p, { sshTrustFingerprint: trust ?? null }),
					},
				});
				setTest({ s: "ok", text: `접속됨 · ${r.ms} ms · ${r.version}${p.sshTunnelProfileId ? " · SSH 경유" : ""}` });
			}
		} catch (x) {
			const e = asSshError(x);
			const code = String(e.code);
			if (code === "SSH_HOSTKEY_UNKNOWN" && e.fingerprint) setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "", via: true });
			else if (code === "SSH_HOSTKEY_MISMATCH" && e.fingerprint) setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "", mismatch: e.pinnedFingerprint ?? "", via: true });
			else if (code === "SSH_NEED_SECRET") setTest({ s: "fail", text: "거칠 SSH 서버의 암호가 저장돼 있지 않습니다 — 그 서버의 계정에 암호를 저장하거나, 접속할 때 창에서 입력하세요" });
			else if (e.code === "HOSTKEY_UNKNOWN" && e.fingerprint) setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "" });
			else if (e.code === "HOSTKEY_MISMATCH" && e.fingerprint)
				setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "", mismatch: e.pinnedFingerprint ?? "" });
			else if (e.code === "NEGOTIATION" && e.suggest) setTest({ s: "legacy", text: e.message, suggest: e.suggest });
			else if (e.code === "NEED_SECRET") setTest({ s: "fail", text: acc.auth === "key" && p.kind === "ssh" ? "개인키 암호를 입력하세요" : "암호를 입력하세요" });
			else setTest({ s: "fail", text: e.message });
		}
	}

	async function save() {
		setSaving(true);
		try {
			if (!editing && !draft.username.trim()) throw new Error("계정의 사용자명을 입력하세요");
			const id = await api.profileSave(editing ? p : { ...p, username: draft.username.trim(), auth: p.kind === "ssh" ? draft.auth : "password", keyPath: draft.keyPath ?? null });
			if (!editing) {
				// 함께 만든 기본 계정에 라벨·sudo·비밀을 채운다
				const first = (await api.accountsList(id))[0];
				if (first?.id != null) await saveAccountDraft({ ...draft, id: first.id, profileId: id, isDefault: true, sudo: p.kind === "ssh" ? draft.sudo : "off" });
			}
			if (p.kind === "db") await api.settingSet(`db.readonly.${id}`, ro ? "1" : "0");
			onSaved(id);
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		} finally {
			setSaving(false);
		}
	}


	return (
		<Wrap inline={inline} onClose={onClose}>
			<form
				className={inline ? "pf-inline" : "sheet wide"}
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				onKeyDown={(e) => !inline && e.key === "Escape" && onClose()}
			>
				<div className="sheet-title">
					<h3>{editing ? "연결 설정" : "새 연결"}</h3>
					{!editing && (
						<div className="seg" role="group" style={{ margin: 0 }}>
							{(["ssh", "db"] as const).map((k) => (
								<button
									key={k}
									type="button"
									aria-pressed={p.kind === k}
									onClick={() =>
										set({
											kind: k,
											port: k === "ssh" ? 22 : (DB_PORT[p.engine ?? "postgres"] ?? 5432),
											engine: k === "db" ? (p.engine ?? "postgres") : null,
										})
									}
								>
									{k === "ssh" ? "SSH 서버" : "데이터베이스"}
								</button>
							))}
						</div>
					)}
				</div>

				<fieldset className="sheet-sec">
					<legend>일반</legend>
					<div className="row2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
						<div className="field">
							<label htmlFor="pf-name">이름</label>
							<input id="pf-name" autoFocus value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 개발 서버" />
						</div>
						<div className="field">
							<label htmlFor="pf-group">묶음</label>
							<input id="pf-group" value={p.groupName ?? ""} onChange={(e) => set({ groupName: e.target.value || null })} placeholder="예: 운영 · 고객사 A" spellCheck={false} />
						</div>
					</div>
					{groups.length > 0 && (
						<div className="chips">
							{groups.map((g) => (
								<button key={g} type="button" className={`chip${p.groupName === g ? " on" : ""}`} onClick={() => set({ groupName: p.groupName === g ? null : g })}>
									{g}
								</button>
							))}
						</div>
					)}
					{p.kind === "db" && (
						<div className="field">
							<label htmlFor="pf-engine">엔진</label>
							<Select
								id="pf-engine"
								value={p.engine ?? "postgres"}
								onChange={(v) => set({ engine: v, port: DB_PORT[v] })}
								options={ENGINES.map((e) => ({ value: e.key, label: e.label, hint: e.jdbc ? "JDBC · 처음 쓸 때 받기" : undefined }))}
							/>
						</div>
					)}
					<div className="row2">
						<div className="field">
							<label htmlFor="pf-host">주소</label>
							<input id="pf-host" value={p.host} onChange={(e) => set({ host: e.target.value })} placeholder="host.example.com" spellCheck={false} />
						</div>
						<div className="field">
							<label htmlFor="pf-port">포트</label>
							<input id="pf-port" inputMode="numeric" value={p.port} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
						</div>
					</div>
					{p.kind === "db" && <TunnelFields p={p} others={others} set={set} />}
					{p.kind === "db" && ["postgres", "mysql", "mariadb"].includes(p.engine ?? "postgres") && (
						<div className="field">
							<label htmlFor="pf-ssl">SSL</label>
							<Select
								id="pf-ssl"
								value={p.ssl ?? (p.engine === "postgres" || !p.engine ? "prefer" : "off")}
								onChange={(v) => set({ ssl: v })}
								options={[
									{ value: "off", label: "끔" },
									{ value: "prefer", label: "되면 사용", hint: "서버가 받으면 암호화" },
									{ value: "require", label: "반드시 사용", hint: "인증서는 확인 안 함(자체 서명)" },
									{ value: "verify", label: "사용·인증서 확인", hint: "공인 인증서만" },
								]}
							/>
						</div>
					)}
					{p.kind === "db" && (
						<div className="field">
							<label htmlFor="pf-db">{engineOf(p.engine).dbLabel}</label>
							<input id="pf-db" value={p.database ?? ""} onChange={(e) => set({ database: e.target.value || null })} spellCheck={false} />
						</div>
					)}
					{p.kind === "db" && (
						<label className="check" title="켜면 이 연결은 늘 읽기 전용으로 접속합니다 — 쓰기 문장은 앱이 실행 전에 거절(접속 창에서 한 번씩 바꿀 수 있음)">
							<input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} /> 읽기 전용으로 접속(운영 DB 보호)
						</label>
					)}
				</fieldset>

				{p.kind === "ssh" && <RoutesBox profileId={initial.id} others={others} onFirst={(r) => set({ host: r.host, port: r.port, jumpId: r.jumps[0]?.profileId ?? null })} />}

				<fieldset className="sheet-sec">
					<legend>계정</legend>
					{editing && initial.id != null ? (
						<AccountsBox server={p} profileId={initial.id} initialList={initial.accounts ?? []} onChanged={onAccountsChanged} />
					) : (
						<>
							<AccountFields
								kind={p.kind}
								value={draft}
								showDefault={false}
								idPrefix="pf-acc"
								onChange={(x) => {
									setDraft((d) => ({ ...d, ...x }));
									if (test.s !== "running") setTest({ s: "idle" });
								}}
							/>
							<small className="hint">계정은 서버를 저장한 뒤 더 늘릴 수 있습니다(한 서버에 계정 여럿).</small>
						</>
					)}
				</fieldset>

				<fieldset className="sheet-sec">
					<legend>표시·고급</legend>
					<div className="field">
						<label htmlFor="pf-memo">메모</label>
						<textarea id="pf-memo" className="memo-input" rows={2} value={p.memo ?? ""} onChange={(e) => set({ memo: e.target.value || null })} placeholder="용도·주의할 점(목록과 마우스 올리면 보임)" />
					</div>
					<label className="check" style={{ marginTop: 0, marginBottom: 10 }}>
						<input type="checkbox" checked={p.favorite} onChange={(e) => set({ favorite: e.target.checked })} /> 즐겨찾기(목록 맨 위)
					</label>
					{p.kind === "ssh" && (
						<div className="field">
							<label htmlFor="pf-path">시작 폴더(비우면 홈)</label>
							<input id="pf-path" value={p.defaultPath ?? ""} onChange={(e) => set({ defaultPath: e.target.value || null })} placeholder="/var/log" spellCheck={false} />
						</div>
					)}
					{p.kind === "ssh" && (
						<div className="field">
							<label className="check" style={{ marginTop: 0 }}>
								<input type="checkbox" checked={!!p.tmux} onChange={(e) => set({ tmux: e.target.checked })} /> 터미널을 tmux 세션으로 열기(끊겨도 이어짐)
							</label>
							{p.tmux && (
								<small className="hint tmux-hint">
									새 터미널은 서버의 tmux 세션 rbs-1, rbs-2… 에 붙습니다. 다시 연결하면 같은 순서로 같은 세션에 다시 붙어, 돌던 명령이 그대로 이어집니다. 서버에 tmux 가 없으면 일반 셸로 열고 알려 드립니다.
									<br />
									tmux 안에서는 지난 출력이 이 앱의 스크롤에 쌓이지 않습니다 — 휠로 보려면 서버의 ~/.tmux.conf 에 <code>set -g mouse on</code> 을 넣으세요(그때 글자를 고르려면 Shift 를 누른 채 끌기). 세션은 두고 나오기만 하려면 Ctrl+B 다음 D. 셸 통합(폴더 따라가기·명령 끝 표시)은 tmux 안에서는 꺼집니다.
								</small>
							)}
						</div>
					)}
					{p.kind === "ssh" && <TermSchemeField profileId={p.id} />}
					<div className="field">
						<label>색</label>
						<div style={{ display: "flex", gap: 8 }}>
							{COLORS.map((c) => (
								<button
									key={c}
									type="button"
									aria-label={c}
									aria-pressed={p.color === c}
									onClick={() => set({ color: c })}
									className="swatch"
									style={{ background: c, boxShadow: p.color === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : "none" }}
								/>
							))}
						</div>
					</div>
					{p.kind === "ssh" && (
						<>
							<button type="button" className="btn ghost disclose" onClick={() => setAdvanced((a) => !a)}>
								{advanced ? "▾" : "▸"} 점프 호스트·구형 SSH 호환
							</button>
							{advanced && (
								<>
									<div className="field" style={{ marginTop: 8 }}>
										<label htmlFor="pf-jump">점프 호스트(이 서버를 거쳐 접속)</label>
										<Select
											id="pf-jump"
											value={p.jumpId ?? 0}
											onChange={(v) => set({ jumpId: v || null })}
											options={[
												{ value: 0, label: "거치지 않음" },
												...others.filter((o) => o.kind === "ssh" && o.id !== p.id).map((o) => ({ value: o.id as number, label: o.name, hint: `${o.username}@${o.host}` })),
											]}
										/>
										<small className="hint">점프 호스트는 한 번 직접 접속해 지문을 고정하고 암호를 저장해 두어야 합니다</small>
									</div>
									<div className="field">
										<label htmlFor="pf-legacy">구형 SSH 호환(이 서버에만)</label>
										<Select<LegacyLevel>
											id="pf-legacy"
											value={p.legacy}
											onChange={(v) => set({ legacy: v })}
											options={[
												{ value: "off", label: "끔", hint: "권장" },
												{ value: "rsa", label: "RSA", hint: "ssh-rsa(SHA-1) 호스트 키" },
												{ value: "sha1", label: "SHA1", hint: "SHA-1 키 교환·CBC 암호" },
												{ value: "weakest", label: "최후", hint: "ssh-dss·group1·3des 까지" },
											]}
										/>
									</div>
								</>
							)}
						</>
					)}
				</fieldset>

				{test.s !== "idle" && (
					<div className={`test-box ${test.s}`}>
						{test.s === "running" && (
							<>
								<Loader2 size={15} className="spin" /> 붙어 보는 중…
							</>
						)}
						{test.s === "ok" && (
							<>
								<CheckCircle2 size={15} /> {test.text}
							</>
						)}
						{test.s === "fail" && (
							<>
								<XCircle size={15} /> {test.text}
							</>
						)}
						{test.s === "hostkey" && (
							<div className="test-col">
								<span>
									<ShieldQuestion size={15} /> {test.via ? "거칠 SSH 서버 — " : ""}
									{test.mismatch ? "호스트 키가 고정한 것과 다릅니다 — 서버가 바뀌었거나 가로채기일 수 있습니다" : "처음 보는 서버입니다. 지문이 맞는지 확인하세요"}
								</span>
								<code>
									{test.algorithm} {test.fingerprint}
								</code>
								{!test.mismatch && (
									<button type="button" className="btn" onClick={() => void runTest(test.fingerprint)}>
										이 지문을 믿고 다시 테스트
									</button>
								)}
							</div>
						)}
						{test.s === "legacy" && (
							<div className="test-col">
								<span>
									<XCircle size={15} /> {test.text}
								</span>
								<button type="button" className="btn" onClick={() => void runTest(undefined, test.suggest)}>
									구형 호환 "{LEVEL_NAME[test.suggest]}" 켜고 다시 테스트
								</button>
							</div>
						)}
					</div>
				)}
				{err && <p className="err">{err}</p>}

				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						disabled={!p.host.trim() || !acc.username.trim() || test.s === "running"}
						onClick={() => void runTest()}
						title={`실제로 붙어 인증까지 해 보고 바로 끊습니다 — ${editing ? "기본 계정" : "입력한 계정"}(${acc.username || "사용자명 없음"})으로`}
					>
						<PlugZap size={14} /> 연결 테스트
					</button>
					{editing && onDuplicate && (
						<button type="button" className="btn ghost icon" title="복제" onClick={() => onDuplicate({ ...p, id: undefined, name: `${p.name} 복사본`, secretSaved: false, accounts: initial.accounts })}>
							<Copy size={14} />
						</button>
					)}
					{editing && onDeleted && (
						<button
							type="button"
							className="btn ghost icon danger"
							title="지우기"
							onClick={() => {
								if (p.id != null && confirm(`${p.name} 서버를 지울까요? 계정 ${initial.accounts?.length ?? 1}개와 저장한 암호도 함께 지웁니다.`)) void api.profileDelete(p.id).then(() => onDeleted(p.id as number));
							}}
						>
							<Trash2 size={14} />
						</button>
					)}
					<span style={{ flex: 1 }} />
					<button type="button" className="btn" onClick={onClose} disabled={inline && !dirty}>
						{inline ? "되돌리기" : "취소"}
					</button>
					{inline && onConnect && editing && (
						<button type="button" className="btn" disabled={dirty} title={dirty ? "먼저 저장하세요" : "계정을 골라 접속"} onClick={() => onConnect(p)}>
							접속
						</button>
					)}
					<button type="submit" className="btn primary" disabled={saving || !p.name.trim() || !p.host.trim() || (inline && !dirty && editing)}>
						저장
					</button>
				</div>
			</form>
		</Wrap>
	);
}

/** DB: 거칠 SSH 서버·계정(SSH 터널) — DataGrip 의 SSH 터널과 같음 */
function TunnelFields({ p, others, set }: { p: Profile; others: Profile[]; set: (patch: Partial<Profile>) => void }) {
	const sshs = others.filter((o) => o.kind === "ssh" && o.id != null);
	const via = sshs.find((o) => o.id === p.sshTunnelProfileId);
	const def = via ? defaultAccount(via) : undefined;
	return (
		<div className="row2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
			<div className="field">
				<label htmlFor="pf-tunnel">거칠 SSH 서버(SSH 터널)</label>
				<Select<number>
					id="pf-tunnel"
					value={p.sshTunnelProfileId ?? 0}
					onChange={(v) => set({ sshTunnelProfileId: v || null, sshTunnelAccountId: null })}
					options={[{ value: 0, label: "거치지 않음", hint: "바로 접속" }, ...sshs.map((o) => ({ value: o.id as number, label: o.name, hint: `${o.host}:${o.port}` }))]}
				/>
				{p.sshTunnelProfileId ? (
					<small className="hint">위 주소·포트는 그 SSH 서버에서 본 DB 주소입니다(예: 127.0.0.1 이나 내부 이름)</small>
				) : sshs.length === 0 ? (
					<small className="hint">SSH 서버를 먼저 저장하면 여기서 고를 수 있습니다</small>
				) : null}
			</div>
			{via && (
				<div className="field">
					<label htmlFor="pf-tunnel-acc">SSH 계정</label>
					<Select<number>
						id="pf-tunnel-acc"
						value={p.sshTunnelAccountId ?? 0}
						onChange={(v) => set({ sshTunnelAccountId: v || null })}
						options={[
							{ value: 0, label: "기본 계정", hint: def ? accountName(def) : undefined },
							...(via.accounts ?? []).filter((a) => a.id != null).map((a) => ({ value: a.id as number, label: accountName(a), hint: a.label?.trim() ? a.username : undefined })),
						]}
					/>
				</div>
			)}
		</div>
	);
}

/** 시트(가운데 떠 있는 창) 또는 화면 안에 그대로 */
function Wrap({ inline, onClose, children }: { inline: boolean; onClose: () => void; children: React.ReactNode }) {
	if (inline) return <>{children}</>;
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			{children}
		</div>
	);
}

/** 저장한 서버의 계정 목록 — 고르면 아래에서 바로 고치고, 더하고, 지우고, 기본으로 */
function AccountsBox({ server, profileId, initialList, onChanged }: { server: Profile; profileId: number; initialList: Account[]; onChanged?: () => void }) {
	const [list, setList] = useState<Account[]>(initialList);
	const [edit, setEdit] = useState<AccountDraft | null>(null);
	const [err, setErr] = useState("");
	const load = useCallback(() => {
		void api.accountsList(profileId).then(setList);
	}, [profileId]);
	useEffect(load, [load]);
	const changed = () => {
		load();
		onChanged?.();
	};
	const remove = async (a: Account) => {
		if (a.id == null) return;
		if (!confirm(`'${accountName(a)}' 계정을 지울까요? 저장한 암호·sudo 암호도 함께 지웁니다.`)) return;
		try {
			await api.accountDelete(a.id);
			setErr("");
			if (edit?.id === a.id) setEdit(null);
			changed();
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		}
	};
	return (
		<div className="acc-box">
			{list.map((a) => (
				<div key={a.id} className="acc-row" aria-current={edit?.id === a.id} onDoubleClick={() => setEdit(draftOf(a))}>
					<button
						type="button"
						className={`sc-star${a.isDefault ? " on" : ""}`}
						title={a.isDefault ? "기본 계정" : "기본 계정으로"}
						onClick={() => a.id != null && !a.isDefault && void api.accountSetDefault(a.id).then(changed)}
					>
						<Star size={13} />
					</button>
					<span className="acc-name">
						<b>{accountName(a)}</b>
						{a.label?.trim() ? <small> {a.username}</small> : null}
					</span>
					<small className="acc-meta">
						{server.kind === "ssh" ? AUTH_LABEL[a.auth] : "암호"}
						{a.lastUsedAt ? ` · ${agoMs(a.lastUsedAt)}` : ""}
					</small>
					{a.secretSaved && <KeyRound size={11} className="sc-ic" aria-label="암호 저장됨" />}
					{server.kind === "ssh" && a.sudo !== "off" && (
						<span className="badge">
							<ShieldAlert size={10} /> {sudoBadge(a)}
						</span>
					)}
					<button type="button" className="btn ghost icon" title="고치기" onClick={() => setEdit(draftOf(a))}>
						<Pencil size={13} />
					</button>
					<button type="button" className="btn ghost icon danger" title={list.length <= 1 ? "마지막 계정은 지울 수 없습니다(서버째 지우기는 아래 휴지통)" : "지우기"} disabled={list.length <= 1} onClick={() => void remove(a)}>
						<Trash2 size={13} />
					</button>
				</div>
			))}
			{err && <p className="err">{err}</p>}
			{edit ? (
				<AccountEditor
					key={edit.id ?? "new"}
					server={server}
					initial={edit}
					onCancel={() => setEdit(null)}
					onSaved={() => {
						setEdit(null);
						changed();
					}}
				/>
			) : (
				<button type="button" className="btn ghost" style={{ alignSelf: "flex-start" }} onClick={() => setEdit(blankAccount(profileId, server.kind))}>
					<Plus size={13} /> 계정 추가
				</button>
			)}
		</div>
	);
}

/** 서버별 터미널 색 구성 — 앱 설정(설정 › 화면)을 덮어쓴다. 고르면 열린 터미널에 바로 */
function TermSchemeField({ profileId }: { profileId?: number }) {
	const [, setTick] = useState(0);
	useEffect(() => onAppearance(() => setTick((t) => t + 1)), []);
	const cur = profileId != null ? (getAppearance().byProfile[String(profileId)] ?? "inherit") : "inherit";
	return (
		<div className="field">
			<label htmlFor="pf-scheme">터미널 색 구성</label>
			<Select
				id="pf-scheme"
				size="sm"
				value={cur}
				disabled={profileId == null}
				title={profileId == null ? "저장한 뒤 고를 수 있습니다" : "이 서버의 터미널만 — 고르면 바로 적용"}
				onChange={(v) => profileId != null && setProfileScheme(profileId, v)}
				options={[
					{ value: "inherit", label: "앱 설정 따르기", hint: TERM_SCHEMES.find((x) => x.id === getAppearance().termScheme)?.label },
					...TERM_SCHEMES.map((x) => ({ value: x.id, label: x.label })),
				]}
			/>
			<small className="hint">운영 서버만 다른 색으로 두면 헷갈리지 않습니다. {profileId == null ? "서버를 저장한 뒤 고를 수 있습니다." : "고르면 바로 적용됩니다(저장 단추와 상관없음)."}</small>
		</div>
	);
}
