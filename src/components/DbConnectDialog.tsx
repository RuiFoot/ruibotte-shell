import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Database, Download, FolderOpen } from "lucide-react";
import { engineOf } from "../lib/engines";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Profile } from "../lib/ipc";

export type DbConnectOk = { connId: number; version: string; database?: string | null; usedSavedSecret: boolean; features: string[] };
type Install = { what: string; done: number; total: number; state: "running" | "done" | "error"; message?: string | null };
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
	const [step, setStep] = useState<"form" | "connecting" | "java" | "driver">(profile.secretSaved ? "connecting" : "form");
	const [install, setInstall] = useState<Install | null>(null);
	const [busy, setBusy] = useState(false);
	const eng = engineOf(profile.engine);
	useEffect(() => {
		const un = listen<Install>("jdbc-install", (e) => setInstall(e.payload));
		return () => void un.then((f) => f());
	}, []);
	const [pw, setPw] = useState("");
	// 내 PC 전용 앱이라 기본은 저장(사용자가 끌 수 있음)
	const [save, setSave] = useState(true);
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
				if (x.code === "NEED_JAVA") {
					setStep("java");
					return;
				}
				if (x.code === "NEED_DRIVER") {
					setStep("driver");
					return;
				}
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
				{(step === "java" || step === "driver") && (
					<>
						<p style={{ color: "var(--text-2)", marginTop: 0 }}>
							{step === "java"
								? `${eng.label} 은(는) JDBC 브리지로 붙습니다. 처음 한 번 Java 실행기(Eclipse Temurin JRE 21, 약 45 MB)를 받아 이 PC 의 앱 폴더에 둡니다. 받은 파일은 sha256 으로 확인합니다.`
								: `${eng.label} 드라이버(jar)가 필요합니다.${eng.key === "oracle" ? " Maven Central 에서 최신판을 받아 sha1 로 확인합니다." : " 공개 저장소에 없어 가지고 계신 jar 파일을 골라 주세요(벤더 사이트·DB 설치 폴더에 있습니다)."}`}
						</p>
						{install && (
							<div className="xfer-row" style={{ border: 0 }}>
								<span>{install.what}</span>
								<small>{install.state === "error" ? install.message : install.total ? `${Math.round((100 * install.done) / install.total)}%` : ""}</small>
								<div className={`bar ${install.state}`}>
									<i style={{ width: install.total ? `${(100 * install.done) / install.total}%` : install.state === "done" ? "100%" : "8%" }} />
								</div>
							</div>
						)}
						{err && <p className="err">{err}</p>}
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={onCancel}>
								취소
							</button>
							{step === "java" || eng.key === "oracle" ? (
								<button
									type="button"
									className="btn primary"
									disabled={busy}
									onClick={async () => {
										setBusy(true);
										setErr("");
										try {
											if (step === "java") await invoke("jdbc_install_java");
											else await invoke("jdbc_install_driver", { engine: eng.key });
											setInstall(null);
											await run(pw || null, readOnly);
										} catch (x) {
											setErr(String(x));
										} finally {
											setBusy(false);
										}
									}}
								>
									<Download size={14} /> {busy ? "받는 중…" : step === "java" ? "Java 실행기 받기" : "드라이버 받기"}
								</button>
							) : (
								<button
									type="button"
									className="btn primary"
									onClick={async () => {
										const f = await openDialog({ multiple: false, directory: false, title: `${eng.label} JDBC 드라이버(jar)`, filters: [{ name: "JDBC 드라이버", extensions: ["jar"] }] });
										if (typeof f !== "string") return;
										try {
											await invoke("jdbc_add_driver_file", { engine: eng.key, path: f });
											await run(pw || null, readOnly);
										} catch (x) {
											setErr(String(x));
										}
									}}
								>
									<FolderOpen size={14} /> jar 파일 고르기
								</button>
							)}
						</div>
					</>
				)}
				{step === "connecting" ? (
					<p style={{ color: "var(--text-2)" }}>접속 중…{eng.jdbc ? " (JDBC 브리지를 띄우는 데 1~2초 걸립니다)" : ""}</p>
				) : step !== "form" ? null : (
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
