import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Eye, EyeOff, FolderOpen, KeyRound, Loader2, PlugZap, ShieldQuestion, XCircle } from "lucide-react";
import { useState } from "react";
import { type Account, type AuthKind, api, asSshError, type Profile, type SudoMode, tunnelReq } from "../lib/ipc";

/** 고치는 중인 계정 — 저장 전 비밀(암호·sudo 암호)과 "지우기" 표시를 함께 든다(값은 다시 화면에 오지 않는다) */
export type AccountDraft = Account & { secret: string; forget: boolean; sudoSecret: string; sudoForget: boolean };

export const SUDO_LABEL: Record<SudoMode, string> = { off: "안 씀", ask: "물어보기", saved: "암호 저장", nopasswd: "암호 없이" };
export const AUTH_LABEL: Record<AuthKind, string> = { password: "암호", key: "개인키", agent: "에이전트" };

export function blankAccount(profileId: number, _kind?: "ssh" | "db"): AccountDraft {
	return {
		profileId,
		label: null,
		username: "",
		auth: "password",
		keyPath: null,
		sudo: "off",
		sudoUser: "root",
		isDefault: false,
		secret: "",
		forget: false,
		sudoSecret: "",
		sudoForget: false,
	};
}

export function draftOf(a: Account): AccountDraft {
	return { ...a, secret: "", forget: false, sudoSecret: "", sudoForget: false };
}

/** 저장 → 계정 id. 비밀은 따로(OS 저장소) */
export async function saveAccountDraft(d: AccountDraft): Promise<number> {
	const { secret, forget, sudoSecret, sudoForget, ...a } = d;
	const id = await api.accountSave(a);
	if (a.auth !== "agent" && secret) await api.accountSecretSet(id, secret);
	else if (forget || (a.auth === "agent" && a.secretSaved)) await api.accountSecretSet(id, "");
	if (a.sudo === "saved" && sudoSecret) await api.accountSudoSecretSet(id, sudoSecret);
	else if (sudoForget && a.sudo === "saved") await api.accountSudoSecretSet(id, "");
	return id;
}

/** 계정 입력칸 — 라벨·사용자명·인증 방식·키 파일·암호·sudo·기본 계정 */
export function AccountFields({
	kind,
	value: d,
	onChange,
	showDefault = true,
	idPrefix = "ac",
}: {
	kind: "ssh" | "db";
	value: AccountDraft;
	onChange: (patch: Partial<AccountDraft>) => void;
	showDefault?: boolean;
	idPrefix?: string;
}) {
	const [show, setShow] = useState(false);
	const ssh = kind === "ssh";
	const keyAuth = ssh && d.auth === "key";
	const savedSecret = !!d.secretSaved && !d.forget;
	const savedSudo = !!d.sudoSaved && !d.sudoForget;
	async function pickKey() {
		const f = await openDialog({ multiple: false, directory: false, title: "개인키 파일 고르기" });
		if (typeof f === "string") onChange({ keyPath: f });
	}
	return (
		<>
			<div className="row2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
				<div className="field">
					<label htmlFor={`${idPrefix}-user`}>사용자명</label>
					<input id={`${idPrefix}-user`} value={d.username} onChange={(e) => onChange({ username: e.target.value })} spellCheck={false} autoComplete="off" placeholder={ssh ? "예: ubuntu" : "예: app"} />
				</div>
				<div className="field">
					<label htmlFor={`${idPrefix}-label`}>라벨(선택)</label>
					<input id={`${idPrefix}-label`} value={d.label ?? ""} onChange={(e) => onChange({ label: e.target.value || null })} spellCheck={false} placeholder="예: 배포용 · 읽기 전용" />
				</div>
			</div>
			{ssh && (
				<div className="field">
					<label>인증 방식</label>
					<div className="seg" role="group" style={{ margin: 0 }}>
						{(["password", "key", "agent"] as const).map((k) => (
							<button key={k} type="button" aria-pressed={d.auth === k} onClick={() => onChange({ auth: k })}>
								{AUTH_LABEL[k]}
							</button>
						))}
					</div>
					{d.auth === "agent" && <small className="hint">이 PC 의 SSH 에이전트(OpenSSH 인증 에이전트·Pageant·ssh-agent)에 넣어 둔 키로 접속합니다</small>}
				</div>
			)}
			{keyAuth && (
				<div className="field">
					<label htmlFor={`${idPrefix}-key`}>개인키 파일</label>
					<div style={{ display: "flex", gap: 6 }}>
						<input id={`${idPrefix}-key`} style={{ flex: 1 }} value={d.keyPath ?? ""} onChange={(e) => onChange({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
						<button type="button" className="btn" onClick={() => void pickKey()}>
							<FolderOpen size={14} /> 찾기
						</button>
					</div>
				</div>
			)}
			{d.auth !== "agent" && (
				<div className="field">
					<label htmlFor={`${idPrefix}-secret`}>{keyAuth ? "개인키 암호(있을 때만)" : "암호"}</label>
					<div className="secret-row">
						<input
							id={`${idPrefix}-secret`}
							type={show ? "text" : "password"}
							value={d.secret}
							onChange={(e) => onChange({ secret: e.target.value })}
							placeholder={savedSecret ? "저장됨 — 바꾸려면 새로 입력" : "저장하면 OS 자격 증명 저장소에 넣습니다"}
							autoComplete="new-password"
						/>
						<button type="button" className="btn ghost icon" title={show ? "가리기" : "보이기"} onClick={() => setShow((x) => !x)}>
							{show ? <EyeOff size={14} /> : <Eye size={14} />}
						</button>
					</div>
					<small className="hint">
						{savedSecret ? (
							<>
								<KeyRound size={11} /> 저장된 {keyAuth ? "키 암호" : "암호"}로 접속합니다 ·{" "}
								<button type="button" className="link" onClick={() => onChange({ forget: true })}>
									저장된 것 지우기
								</button>
							</>
						) : d.forget ? (
							<>
								저장할 때 지웁니다 ·{" "}
								<button type="button" className="link" onClick={() => onChange({ forget: false })}>
									되돌리기
								</button>
							</>
						) : (
							"비워 두면 접속할 때 묻습니다"
						)}
					</small>
				</div>
			)}
			{ssh && (
				<div className="field">
					<label>sudo</label>
					<div className="seg" role="group" style={{ margin: 0 }}>
						{(["off", "ask", "saved", "nopasswd"] as const).map((k) => (
							<button key={k} type="button" aria-pressed={d.sudo === k} onClick={() => onChange({ sudo: k })}>
								{SUDO_LABEL[k]}
							</button>
						))}
					</div>
					<small className="hint">
						{d.sudo === "off" && "이 계정으로 접속하면 작업대의 sudo 단추와 'root 셸로'를 숨깁니다"}
						{d.sudo === "ask" && "sudo 를 켤 때 암호를 묻고, 그 연결 동안만 기억합니다"}
						{d.sudo === "saved" && "OS 자격 증명 저장소에 둔 sudo 암호를 씁니다"}
						{d.sudo === "nopasswd" && "서버 sudoers 에 NOPASSWD 로 열려 있을 때 — 암호 없이 sudo -n 으로 실행합니다"}
					</small>
				</div>
			)}
			{ssh && d.sudo === "saved" && (
				<div className="field">
					<label htmlFor={`${idPrefix}-sudopw`}>sudo 암호</label>
					<input
						id={`${idPrefix}-sudopw`}
						type="password"
						value={d.sudoSecret}
						onChange={(e) => onChange({ sudoSecret: e.target.value })}
						placeholder={savedSudo ? "저장됨 — 바꾸려면 새로 입력" : "비워 두면 sudo 를 켤 때 묻습니다"}
						autoComplete="new-password"
					/>
					{savedSudo ? (
						<small className="hint">
							<KeyRound size={11} /> 저장됨 ·{" "}
							<button type="button" className="link" onClick={() => onChange({ sudoForget: true })}>
								지우기
							</button>
						</small>
					) : d.sudoForget ? (
						<small className="hint">
							저장할 때 지우고 '물어보기'로 바꿉니다 ·{" "}
							<button type="button" className="link" onClick={() => onChange({ sudoForget: false })}>
								되돌리기
							</button>
						</small>
					) : null}
				</div>
			)}
			{ssh && d.sudo !== "off" && (
				<div className="field">
					<label htmlFor={`${idPrefix}-sudouser`}>sudo 대상 사용자</label>
					<input id={`${idPrefix}-sudouser`} value={d.sudoUser} onChange={(e) => onChange({ sudoUser: e.target.value })} placeholder="root" spellCheck={false} autoComplete="off" />
					<small className="hint">root 가 아니면 sudo -u 이 사용자로 실행합니다(예: postgres)</small>
				</div>
			)}
			{showDefault && (
				<label className="check" style={{ marginTop: 0 }}>
					<input type="checkbox" checked={d.isDefault} onChange={(e) => onChange({ isDefault: e.target.checked })} /> 기본 계정(빠른 접속·Enter 에 쓰는 계정)
				</label>
			)}
		</>
	);
}

type Test = { s: "idle" } | { s: "running" } | { s: "ok"; text: string } | { s: "fail"; text: string } | { s: "hostkey"; fingerprint: string; algorithm: string; mismatch?: string };

/** 이 계정으로 붙어 보기(저장 전 값으로) — 저장한 비밀은 계정에서 */
export async function testAccount(server: Profile, d: AccountDraft, trust?: string): Promise<string> {
	const useSaved = d.id != null && !d.forget && !d.secret;
	if (server.kind === "ssh") {
		const r = await invoke<{ ms: number; home: string; algorithm: string; newlyPinned: boolean }>("ssh_test", {
			req: {
				accountId: useSaved ? d.id : undefined,
				host: server.host.trim(),
				port: server.port,
				username: d.username.trim(),
				auth: d.auth,
				keyPath: d.keyPath,
				secret: d.secret || null,
				legacy: server.legacy,
				trustFingerprint: trust ?? null,
				jumpId: server.jumpId ?? null,
			},
		});
		return `접속됨 · ${r.ms} ms · ${r.algorithm}${r.newlyPinned ? " · 지문 고정" : ""} · 홈 ${r.home}`;
	}
	const r = await invoke<{ ms: number; version: string }>("db_test", {
		req: {
			accountId: useSaved ? d.id : undefined,
			engine: server.engine ?? "postgres",
			host: server.host.trim(),
			port: server.port,
			username: d.username.trim(),
			password: d.secret || null,
			database: server.database,
			readOnly: false,
			legacy: server.legacy !== "off",
			ssl: server.ssl ?? null,
			...tunnelReq(server, { sshTrustFingerprint: trust ?? null }),
		},
	});
	return `접속됨 · ${r.ms} ms · ${r.version}`;
}

/** 연결 테스트 결과 줄 */
export function useAccountTest(server: Profile, d: AccountDraft) {
	const [test, setTest] = useState<Test>({ s: "idle" });
	const run = async (trust?: string) => {
		setTest({ s: "running" });
		try {
			setTest({ s: "ok", text: await testAccount(server, d, trust) });
		} catch (x) {
			const e = asSshError(x);
			const code = String(e.code).replace(/^SSH_/, "");
			if (code === "NEED_SECRET" && e.code !== "NEED_SECRET") setTest({ s: "fail", text: "거칠 SSH 서버의 암호가 저장돼 있지 않습니다 — 그 서버의 계정에 암호를 저장하세요" });
			else if ((code === "HOSTKEY_UNKNOWN" || code === "HOSTKEY_MISMATCH") && e.fingerprint)
				setTest({ s: "hostkey", fingerprint: e.fingerprint, algorithm: e.algorithm ?? "", mismatch: code === "HOSTKEY_MISMATCH" ? (e.pinnedFingerprint ?? "") : undefined });
			else if (e.code === "NEED_SECRET") setTest({ s: "fail", text: d.auth === "key" ? "개인키 암호를 입력하세요" : "암호를 입력하세요" });
			else setTest({ s: "fail", text: e.message });
		}
	};
	const box =
		test.s === "idle" ? null : (
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
							<ShieldQuestion size={15} /> {test.mismatch ? "호스트 키가 고정한 것과 다릅니다 — 서버가 바뀌었거나 가로채기일 수 있습니다" : "처음 보는 서버입니다. 지문이 맞는지 확인하세요"}
						</span>
						<code>
							{test.algorithm} {test.fingerprint}
						</code>
						{!test.mismatch && (
							<button type="button" className="btn" onClick={() => void run(test.fingerprint)}>
								이 지문을 믿고 다시 테스트
							</button>
						)}
					</div>
				)}
			</div>
		);
	return { test, run, reset: () => setTest({ s: "idle" }), box };
}

/** 계정 하나 고치기·더하기 — 서버 설정 안(inline)이나 서버 카드 위 시트로 */
export function AccountEditor({
	server,
	initial,
	onSaved,
	onCancel,
	asSheet = false,
}: {
	/** 테스트에 쓸 서버(주소·포트·구형 호환·점프) */
	server: Profile;
	initial: AccountDraft;
	onSaved: (id: number) => void;
	onCancel: () => void;
	asSheet?: boolean;
}) {
	const [d, setD] = useState<AccountDraft>(initial);
	const [err, setErr] = useState("");
	const [saving, setSaving] = useState(false);
	const t = useAccountTest(server, d);
	const patch = (x: Partial<AccountDraft>) => {
		setD((o) => ({ ...o, ...x }));
		setErr("");
		if (t.test.s !== "running") t.reset();
	};
	const isNew = initial.id == null;
	async function save() {
		if (!d.username.trim()) return setErr("사용자명을 입력하세요");
		setSaving(true);
		try {
			onSaved(await saveAccountDraft(d));
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		} finally {
			setSaving(false);
		}
	}
	const body = (
		<div
			className={asSheet ? "sheet wide acc-sheet" : "acc-edit"}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onCancel();
				} else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
					e.preventDefault();
					e.stopPropagation();
					void save();
				}
			}}
		>
			<div className="sheet-title">
				<h3 style={asSheet ? undefined : { fontSize: 13 }}>{isNew ? `${server.name} — 계정 추가` : `계정 고치기 — ${initial.label?.trim() || initial.username}`}</h3>
			</div>
			<AccountFields kind={server.kind} value={d} onChange={patch} idPrefix={`ac${initial.id ?? "n"}`} />
			{t.box}
			{err && <p className="err">{err}</p>}
			<div className="sheet-actions">
				<button type="button" className="btn" disabled={!d.username.trim() || t.test.s === "running"} onClick={() => void t.run()} title="이 계정으로 실제로 붙어 인증까지 해 보고 바로 끊습니다">
					<PlugZap size={14} /> 연결 테스트
				</button>
				<span style={{ flex: 1 }} />
				<button type="button" className="btn" onClick={onCancel}>
					취소
				</button>
				<button type="button" className="btn primary" disabled={saving || !d.username.trim()} onClick={() => void save()}>
					{isNew ? "계정 추가" : "저장"}
				</button>
			</div>
		</div>
	);
	if (!asSheet) return body;
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
			{body}
		</div>
	);
}
