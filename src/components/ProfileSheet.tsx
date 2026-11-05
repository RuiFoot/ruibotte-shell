import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Copy, Eye, EyeOff, FolderOpen, KeyRound, Loader2, PlugZap, ShieldQuestion, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { ENGINES, engineOf } from "../lib/engines";
import { api, asSshError, type LegacyLevel, type Profile } from "../lib/ipc";
import { Select } from "./Select";

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
	| { s: "hostkey"; fingerprint: string; algorithm: string; mismatch?: string }
	| { s: "legacy"; text: string; suggest: LegacyLevel };

/**
 * 연결 설정 — 주소·계정·암호(OS 자격 증명 저장소)·묶음·색·고급(점프·구형 호환).
 * 저장 전에 "연결 테스트"로 실제로 붙어 본다. 고칠 때는 지우기·복제도 여기서.
 */
export function ProfileSheet({
	initial,
	onClose,
	onSaved,
	onDeleted,
	onDuplicate,
	others = [],
}: {
	/** 점프 호스트·묶음 후보를 고를 다른 프로필 */
	others?: Profile[];
	initial: Profile;
	onClose: () => void;
	onSaved: (id: number) => void;
	onDeleted?: (id: number) => void;
	onDuplicate?: (p: Profile) => void;
}) {
	const [p, setP] = useState<Profile>(initial);
	const [err, setErr] = useState("");
	const [advanced, setAdvanced] = useState(initial.legacy !== "off" || !!initial.jumpId);
	const [secret, setSecret] = useState("");
	const [showSecret, setShowSecret] = useState(false);
	const [forget, setForget] = useState(false);
	const [test, setTest] = useState<Test>({ s: "idle" });
	const [saving, setSaving] = useState(false);
	const set = (patch: Partial<Profile>) => {
		setP((x) => ({ ...x, ...patch }));
		if (test.s !== "running") setTest({ s: "idle" });
	};
	const editing = initial.id != null;
	const savedSecret = !!initial.secretSaved && !forget;
	const groups = [...new Set(others.map((o) => o.groupName).filter((g): g is string => !!g))].sort();

	async function runTest(trust?: string, legacy?: LegacyLevel) {
		setTest({ s: "running" });
		const lv = legacy ?? p.legacy;
		if (legacy) setP((x) => ({ ...x, legacy }));
		try {
			if (p.kind === "ssh") {
				const r = await invoke<{ ms: number; home: string; algorithm: string; newlyPinned: boolean }>("ssh_test", {
					req: {
						profileId: forget ? undefined : (p.id ?? undefined),
						host: p.host.trim(),
						port: p.port,
						username: p.username,
						auth: p.auth,
						keyPath: p.keyPath,
						secret: secret || null,
						legacy: lv,
						trustFingerprint: trust ?? null,
						jumpId: p.jumpId ?? null,
					},
				});
				setTest({ s: "ok", text: `접속됨 · ${r.ms} ms · ${r.algorithm}${r.newlyPinned ? " · 지문 고정" : ""} · 홈 ${r.home}` });
			} else {
				const r = await invoke<{ ms: number; version: string }>("db_test", {
					req: {
						profileId: forget ? undefined : (p.id ?? undefined),
						engine: p.engine ?? "postgres",
						host: p.host.trim(),
						port: p.port,
						username: p.username,
						password: secret || null,
						database: p.database,
						readOnly: false,
						legacy: p.legacy !== "off",
					},
				});
				setTest({ s: "ok", text: `접속됨 · ${r.ms} ms · ${r.version}` });
			}
		} catch (x) {
			const e = asSshError(x);
			if (e.code === "HOSTKEY_UNKNOWN" && e.fingerprint) setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "" });
			else if (e.code === "HOSTKEY_MISMATCH" && e.fingerprint)
				setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "", mismatch: e.pinnedFingerprint ?? "" });
			else if (e.code === "NEGOTIATION" && e.suggest) setTest({ s: "legacy", text: e.message, suggest: e.suggest });
			else if (e.code === "NEED_SECRET") setTest({ s: "fail", text: p.auth === "key" && p.kind === "ssh" ? "개인키 암호를 입력하세요" : "암호를 입력하세요" });
			else setTest({ s: "fail", text: e.message });
		}
	}

	async function save() {
		setSaving(true);
		try {
			const id = await api.profileSave(p);
			if (secret) await invoke("secret_set", { profileId: id, secret });
			else if (forget) await invoke("secret_set", { profileId: id, secret: "" });
			onSaved(id);
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		} finally {
			setSaving(false);
		}
	}

	async function pickKey() {
		const f = await openDialog({ multiple: false, directory: false, title: "개인키 파일 고르기" });
		if (typeof f === "string") set({ keyPath: f });
	}

	const keyAuth = p.kind === "ssh" && p.auth === "key";

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<form
				className="sheet wide"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				onKeyDown={(e) => e.key === "Escape" && onClose()}
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
					{p.kind === "db" && (
						<div className="field">
							<label htmlFor="pf-db">{engineOf(p.engine).dbLabel}</label>
							<input id="pf-db" value={p.database ?? ""} onChange={(e) => set({ database: e.target.value || null })} spellCheck={false} />
						</div>
					)}
				</fieldset>

				<fieldset className="sheet-sec">
					<legend>인증</legend>
					<div className="field">
						<label htmlFor="pf-user">계정</label>
						<input id="pf-user" value={p.username} onChange={(e) => set({ username: e.target.value })} spellCheck={false} autoComplete="off" />
					</div>
					{p.kind === "ssh" && (
						<div className="field">
							<label>방식</label>
							<div className="seg" role="group" style={{ margin: 0 }}>
								<button type="button" aria-pressed={p.auth === "password"} onClick={() => set({ auth: "password" })}>
									암호
								</button>
								<button type="button" aria-pressed={p.auth === "key"} onClick={() => set({ auth: "key" })}>
									개인키
								</button>
							</div>
						</div>
					)}
					{keyAuth && (
						<div className="field">
							<label htmlFor="pf-key">개인키 파일</label>
							<div style={{ display: "flex", gap: 6 }}>
								<input id="pf-key" style={{ flex: 1 }} value={p.keyPath ?? ""} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
								<button type="button" className="btn" onClick={() => void pickKey()}>
									<FolderOpen size={14} /> 찾기
								</button>
							</div>
						</div>
					)}
					<div className="field">
						<label htmlFor="pf-secret">{keyAuth ? "개인키 암호(있을 때만)" : "암호"}</label>
						<div className="secret-row">
							<input
								id="pf-secret"
								type={showSecret ? "text" : "password"}
								value={secret}
								onChange={(e) => {
									setSecret(e.target.value);
									setTest({ s: "idle" });
								}}
								placeholder={savedSecret ? "저장됨 — 바꾸려면 새로 입력" : "저장하면 OS 자격 증명 저장소에 넣습니다"}
								autoComplete="new-password"
							/>
							<button type="button" className="btn ghost icon" title={showSecret ? "가리기" : "보이기"} onClick={() => setShowSecret((x) => !x)}>
								{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
							</button>
						</div>
						<small className="hint">
							{savedSecret ? (
								<>
									<KeyRound size={11} /> 저장된 {keyAuth ? "키 암호" : "암호"}로 접속합니다 ·{" "}
									<button type="button" className="link" onClick={() => setForget(true)}>
										저장된 것 지우기
									</button>
								</>
							) : forget ? (
								<>
									저장할 때 지웁니다 ·{" "}
									<button type="button" className="link" onClick={() => setForget(false)}>
										되돌리기
									</button>
								</>
							) : (
								"비워 두면 접속할 때 묻습니다"
							)}
						</small>
					</div>
				</fieldset>

				<fieldset className="sheet-sec">
					<legend>표시·고급</legend>
					{p.kind === "ssh" && (
						<div className="field">
							<label htmlFor="pf-path">시작 폴더(비우면 홈)</label>
							<input id="pf-path" value={p.defaultPath ?? ""} onChange={(e) => set({ defaultPath: e.target.value || null })} placeholder="/var/log" spellCheck={false} />
						</div>
					)}
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
									<ShieldQuestion size={15} />{" "}
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
					<button type="button" className="btn" disabled={!p.host.trim() || test.s === "running"} onClick={() => void runTest()} title="실제로 붙어 인증까지 해 보고 바로 끊습니다">
						<PlugZap size={14} /> 연결 테스트
					</button>
					{editing && onDuplicate && (
						<button type="button" className="btn ghost icon" title="복제" onClick={() => onDuplicate({ ...p, id: undefined, name: `${p.name} 복사본`, secretSaved: false })}>
							<Copy size={14} />
						</button>
					)}
					{editing && onDeleted && (
						<button
							type="button"
							className="btn ghost icon danger"
							title="지우기"
							onClick={() => {
								if (p.id != null && confirm(`${p.name} 연결을 지울까요? 저장한 암호도 함께 지웁니다.`)) void api.profileDelete(p.id).then(() => onDeleted(p.id as number));
							}}
						>
							<Trash2 size={14} />
						</button>
					)}
					<span style={{ flex: 1 }} />
					<button type="button" className="btn" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn primary" disabled={saving || !p.name.trim() || !p.host.trim()}>
						저장
					</button>
				</div>
			</form>
		</div>
	);
}
