import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { ENGINES, engineOf } from "../lib/engines";
import { api, type LegacyLevel, type Profile } from "../lib/ipc";

const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#8e8e93"];
const DB_PORT: Record<string, number> = Object.fromEntries(ENGINES.map((e) => [e.key, e.port]));

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
	};
}

/** 접속 프로필 만들기·고치기 */
export function ProfileSheet({
	initial,
	onClose,
	onSaved,
	others = [],
}: {
	/** 점프 호스트로 고를 수 있는 다른 SSH 프로필 */
	others?: Profile[];
	initial: Profile;
	onClose: () => void;
	onSaved: (id: number) => void;
}) {
	const [p, setP] = useState<Profile>(initial);
	const [err, setErr] = useState("");
	const [advanced, setAdvanced] = useState(initial.legacy !== "off" || !!initial.jumpId);
	const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
	const editing = initial.id != null;

	async function save() {
		try {
			const id = await api.profileSave(p);
			onSaved(id);
		} catch (e) {
			setErr(String(e));
		}
	}

	async function pickKey() {
		const f = await openDialog({ multiple: false, directory: false, title: "개인키 파일 고르기" });
		if (typeof f === "string") set({ keyPath: f });
	}

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<form
				className="sheet"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				onKeyDown={(e) => e.key === "Escape" && onClose()}
			>
				<h3>{editing ? "연결 고치기" : "새 연결"}</h3>
				{!editing && (
					<div className="seg" role="group">
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
				<div className="field">
					<label htmlFor="pf-name">이름</label>
					<input id="pf-name" autoFocus value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 개발 서버" />
				</div>
				{p.kind === "db" && (
					<div className="field">
						<label htmlFor="pf-engine">엔진</label>
						<select id="pf-engine" value={p.engine ?? "postgres"} onChange={(e) => set({ engine: e.target.value, port: DB_PORT[e.target.value] })}>
							{ENGINES.map((e) => (
								<option key={e.key} value={e.key}>
									{e.label}
									{e.jdbc ? " (JDBC — 처음 쓸 때 받기)" : ""}
								</option>
							))}
						</select>
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
				<div className="field">
					<label htmlFor="pf-user">계정</label>
					<input id="pf-user" value={p.username} onChange={(e) => set({ username: e.target.value })} spellCheck={false} />
				</div>
				{p.kind === "ssh" && (
					<>
						<div className="field">
							<label>인증</label>
							<div className="seg" role="group" style={{ margin: 0 }}>
								<button type="button" aria-pressed={p.auth === "password"} onClick={() => set({ auth: "password" })}>
									암호
								</button>
								<button type="button" aria-pressed={p.auth === "key"} onClick={() => set({ auth: "key" })}>
									개인키
								</button>
							</div>
						</div>
						{p.auth === "key" && (
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
							<label htmlFor="pf-path">시작 폴더(비우면 홈)</label>
							<input id="pf-path" value={p.defaultPath ?? ""} onChange={(e) => set({ defaultPath: e.target.value || null })} placeholder="/var/log" spellCheck={false} />
						</div>
					</>
				)}
				{p.kind === "db" && (
					<div className="field">
						<label htmlFor="pf-db">{engineOf(p.engine).dbLabel}</label>
						<input id="pf-db" value={p.database ?? ""} onChange={(e) => set({ database: e.target.value || null })} spellCheck={false} />
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
								style={{
									width: 22,
									height: 22,
									borderRadius: "50%",
									border: 0,
									background: c,
									boxShadow: p.color === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : "none",
								}}
							/>
						))}
					</div>
				</div>
				{p.kind === "ssh" && (
					<>
						<button type="button" className="btn ghost" style={{ padding: 0, color: "var(--text-2)" }} onClick={() => setAdvanced((a) => !a)}>
							{advanced ? "▾" : "▸"} 고급
						</button>
						{advanced && (
							<>
							<div className="field" style={{ marginTop: 8 }}>
								<label htmlFor="pf-jump">점프 호스트(이 서버를 거쳐 접속)</label>
								<select id="pf-jump" value={p.jumpId ?? ""} onChange={(e) => set({ jumpId: e.target.value ? Number(e.target.value) : null })}>
									<option value="">거치지 않음</option>
									{others
										.filter((o) => o.kind === "ssh" && o.id !== p.id)
										.map((o) => (
											<option key={o.id} value={o.id}>
												{o.name} ({o.username}@{o.host})
											</option>
										))}
								</select>
								<small style={{ color: "var(--text-3)" }}>점프 호스트는 한 번 직접 접속해 지문을 고정하고 암호를 저장해 두어야 합니다</small>
							</div>
							<div className="field" style={{ marginTop: 8 }}>
								<label htmlFor="pf-legacy">구형 SSH 호환(이 서버에만)</label>
								<select id="pf-legacy" value={p.legacy} onChange={(e) => set({ legacy: e.target.value as LegacyLevel })}>
									<option value="off">끔(권장)</option>
									<option value="rsa">RSA — ssh-rsa(SHA-1) 호스트 키</option>
									<option value="sha1">SHA1 — SHA-1 키 교환·CBC 암호</option>
									<option value="weakest">최후 — ssh-dss·group1·3des 까지</option>
								</select>
							</div>
							</>
						)}
					</>
				)}
				<p style={{ color: "var(--text-3)", fontSize: 12, margin: "10px 0 0" }}>암호는 여기서 받지 않습니다. 접속할 때 묻고, 원하면 OS 자격 증명 저장소에 저장합니다.</p>
				{err && <p className="err">{err}</p>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn primary">
						저장
					</button>
				</div>
			</form>
		</div>
	);
}
