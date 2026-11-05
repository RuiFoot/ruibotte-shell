import { KeyRound, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, asSshError, type ConnectOk, type LegacyLevel, type Profile, type SshError } from "../lib/ipc";

const LEVEL_NAME: Record<LegacyLevel, string> = {
	off: "끔",
	rsa: "RSA — ssh-rsa(SHA-1) 호스트 키",
	sha1: "SHA1 — SHA-1 키 교환·CBC 암호 추가",
	weakest: "최후 — ssh-dss·group1-sha1·3des 까지",
};

type Step =
	| { s: "connecting" }
	| { s: "secret"; error?: string }
	| { s: "hostkey"; e: SshError }
	| { s: "negotiation"; e: SshError }
	| { s: "error"; e: SshError };

/**
 * 접속 진행 — 암호 묻기, 처음 보는 호스트 키 확인, 바뀐 키 경고, 구형 호환 제안을 한 흐름으로.
 */
export function ConnectDialog({
	profile,
	onConnected,
	onCancel,
	onProfileChanged,
}: {
	profile: Profile;
	onConnected: (ok: ConnectOk, p: Profile) => void;
	onCancel: () => void;
	onProfileChanged: () => void;
}) {
	const [p, setP] = useState(profile);
	const needsSecretFirst = p.auth === "password" && !p.secretSaved;
	const [step, setStep] = useState<Step>(needsSecretFirst ? { s: "secret" } : { s: "connecting" });
	const [secret, setSecret] = useState("");
	const [save, setSave] = useState(false);
	const trust = useRef<string | null>(null);
	const started = useRef(false);

	const run = useCallback(
		async (prof: Profile, sec: string | null) => {
			setStep({ s: "connecting" });
			try {
				const ok = await api.sshConnect({
					profileId: prof.id,
					host: prof.host,
					port: prof.port,
					username: prof.username,
					auth: prof.auth,
					keyPath: prof.keyPath,
					secret: sec || null,
					legacy: prof.legacy,
					trustFingerprint: trust.current,
					saveSecret: save,
				});
				onConnected(ok, prof);
			} catch (raw) {
				const e = asSshError(raw);
				if (e.code === "HOSTKEY_UNKNOWN" || e.code === "HOSTKEY_MISMATCH") setStep({ s: "hostkey", e });
				else if (e.code === "NEGOTIATION") setStep({ s: "negotiation", e });
				else if (e.code === "NEED_SECRET" || e.code === "AUTH_FAILED") setStep({ s: "secret", error: e.code === "AUTH_FAILED" ? e.message : undefined });
				else setStep({ s: "error", e });
			}
		},
		[onConnected, save],
	);

	useEffect(() => {
		if (started.current || needsSecretFirst) return;
		started.current = true;
		void run(p, null);
	}, [needsSecretFirst, p, run]);

	async function enableLevel(level: LegacyLevel) {
		const next = { ...p, legacy: level };
		await api.profileSave(next);
		setP(next);
		onProfileChanged();
		void run(next, secret);
	}

	const title = `${p.username ? `${p.username}@` : ""}${p.host}${p.port !== 22 ? `:${p.port}` : ""}`;

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && step.s !== "connecting" && onCancel()}>
			<div className="sheet" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
				<h3 style={{ marginBottom: 4 }}>{p.name}</h3>
				<p style={{ margin: "0 0 16px", color: "var(--text-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{title}</p>

				{step.s === "connecting" && <p style={{ color: "var(--text-2)" }}>접속 중…</p>}

				{step.s === "secret" && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void run(p, secret);
						}}
					>
						<div className="field">
							<label htmlFor="cd-secret">{p.auth === "key" ? "개인키 암호" : "암호"}</label>
							<input id="cd-secret" type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
						</div>
						{step.error && <p className="err">{step.error}</p>}
						{p.id != null && (
							<label className="check">
								<input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
								접속에 성공하면 OS 자격 증명 저장소에 저장
							</label>
						)}
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								취소
							</button>
							<button type="submit" className="btn primary">
								<KeyRound size={14} /> 접속
							</button>
						</div>
					</form>
				)}

				{step.s === "hostkey" && (
					<>
						{step.e.code === "HOSTKEY_MISMATCH" ? (
							<p style={{ display: "flex", gap: 8, color: "var(--danger)" }}>
								<ShieldAlert size={18} style={{ flex: "none" }} /> {step.e.message}
							</p>
						) : (
							<p style={{ display: "flex", gap: 8, color: "var(--text-2)" }}>
								<ShieldCheck size={18} style={{ flex: "none", color: "var(--accent)" }} /> 처음 접속하는 서버입니다. 서버 관리자가 알려 준 지문과 같은지 확인하세요.
							</p>
						)}
						{step.e.pinnedFingerprint && (
							<div className="field">
								<label>고정한 지문</label>
								<div className="fp">{step.e.pinnedFingerprint}</div>
							</div>
						)}
						<div className="field">
							<label>서버가 보낸 지문 ({step.e.algorithm})</label>
							<div className="fp">{step.e.fingerprint}</div>
						</div>
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								취소
							</button>
							<button
								type="button"
								className={step.e.code === "HOSTKEY_MISMATCH" ? "btn" : "btn primary"}
								style={step.e.code === "HOSTKEY_MISMATCH" ? { color: "var(--danger)" } : undefined}
								onClick={() => {
									trust.current = step.e.fingerprint ?? null;
									void run(p, secret);
								}}
							>
								{step.e.code === "HOSTKEY_MISMATCH" ? "새 키를 신뢰하고 접속" : "지문이 맞습니다 — 접속"}
							</button>
						</div>
					</>
				)}

				{step.s === "negotiation" && (
					<>
						<p style={{ display: "flex", gap: 8, color: "var(--text-2)" }}>
							<TriangleAlert size={18} style={{ flex: "none", color: "#ff9f0a" }} /> 오래된 SSH 서버라 알고리즘이 맞지 않습니다({step.e.kind}).
						</p>
						<div className="field">
							<label>서버가 내민 목록</label>
							<div className="fp">{step.e.theirs?.filter((t) => !t.startsWith("ext-info") && !t.startsWith("kex-strict")).join(", ")}</div>
						</div>
						{step.e.suggest ? (
							<p style={{ fontSize: 12.5, color: "var(--text-2)" }}>
								이 서버에만 구형 호환 <b>{LEVEL_NAME[step.e.suggest]}</b> 을(를) 켜면 접속할 수 있습니다. 지금 단계: {LEVEL_NAME[p.legacy]}.
								{step.e.suggest === "weakest" && <span className="err"> 최후 단계는 매우 약한 암호입니다. 서버 업그레이드를 권합니다.</span>}
							</p>
						) : (
							<p className="err">켤 수 있는 단계로도 맞지 않습니다.</p>
						)}
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								취소
							</button>
							{step.e.suggest && p.id != null && (
								<button type="button" className="btn primary" onClick={() => void enableLevel(step.e.suggest as LegacyLevel)}>
									켜고 다시 접속
								</button>
							)}
						</div>
					</>
				)}

				{step.s === "error" && (
					<>
						<p className="err">{step.e.message}</p>
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								닫기
							</button>
							<button type="button" className="btn primary" onClick={() => void run(p, secret)}>
								다시 시도
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
