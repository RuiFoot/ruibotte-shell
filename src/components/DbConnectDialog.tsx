import { invoke } from "@tauri-apps/api/core";
import { Database } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Profile } from "../lib/ipc";

export type DbConnectOk = { connId: number; version: string; database?: string | null; usedSavedSecret: boolean };
type DbError = { code: string; message: string };

/** DB 접속 — 암호(저장 선택)·읽기 전용 고르기 */
export function DbConnectDialog({
	profile,
	onConnected,
	onCancel,
}: {
	profile: Profile;
	onConnected: (ok: DbConnectOk, readOnly: boolean) => void;
	onCancel: () => void;
}) {
	const [step, setStep] = useState<"form" | "connecting">(profile.secretSaved ? "connecting" : "form");
	const [pw, setPw] = useState("");
	const [save, setSave] = useState(false);
	const [readOnly, setReadOnly] = useState(false);
	const [err, setErr] = useState("");
	const started = useRef(false);
	const roKey = `db.readonly.${profile.id}`;

	const run = useCallback(
		async (password: string | null, ro: boolean) => {
			setStep("connecting");
			setErr("");
			try {
				const ok = await invoke<DbConnectOk>("db_connect", {
					req: {
						profileId: profile.id,
						engine: profile.engine ?? "postgres",
						host: profile.host,
						port: profile.port,
						username: profile.username,
						password,
						database: profile.database,
						readOnly: ro,
						saveSecret: save,
						legacy: profile.legacy !== "off",
					},
				});
				void api.settingSet(roKey, ro ? "1" : "0");
				onConnected(ok, ro);
			} catch (e) {
				const x = e as DbError;
				setStep("form");
				if (x.code !== "NEED_SECRET") setErr(x.message ?? String(e));
			}
		},
		[profile, save, onConnected, roKey],
	);

	useEffect(() => {
		void api.settingGet(roKey).then((v) => {
			const ro = v === "1";
			setReadOnly(ro);
			if (profile.secretSaved && !started.current) {
				started.current = true;
				void run(null, ro);
			}
		});
	}, [profile.secretSaved, roKey, run]);

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && step === "form" && onCancel()}>
			<form
				className="sheet"
				onSubmit={(e) => {
					e.preventDefault();
					void run(pw, readOnly);
				}}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
			>
				<h3 style={{ marginBottom: 4 }}>
					<Database size={16} style={{ verticalAlign: -2 }} /> {profile.name}
				</h3>
				<p style={{ margin: "0 0 16px", color: "var(--text-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
					{profile.engine} · {profile.username}@{profile.host}:{profile.port}
					{profile.database ? `/${profile.database}` : ""}
				</p>
				{step === "connecting" ? (
					<p style={{ color: "var(--text-2)" }}>접속 중…</p>
				) : (
					<>
						<div className="field">
							<label htmlFor="db-pw">암호</label>
							<input id="db-pw" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
						</div>
						<label className="check">
							<input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
							읽기 전용(세션 READ ONLY + 조회 문장만)
						</label>
						{profile.id != null && (
							<label className="check">
								<input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
								접속에 성공하면 암호를 OS 자격 증명 저장소에 저장
							</label>
						)}
						{err && <p className="err">{err}</p>}
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								취소
							</button>
							<button type="submit" className="btn primary">
								접속
							</button>
						</div>
					</>
				)}
			</form>
		</div>
	);
}
