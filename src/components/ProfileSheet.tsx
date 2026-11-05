import { useState } from "react";
import { api, type Profile } from "../lib/ipc";

const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#8e8e93"];
const DB_PORT: Record<string, number> = { postgres: 5432, mariadb: 3306, mysql: 3306 };

/** 접속 프로필 시트 — 이 판은 저장만(실제 SSH·DB 연결은 다음 판) */
export function ProfileSheet({
	initialKind,
	onClose,
	onSaved,
}: {
	initialKind: "ssh" | "db";
	onClose: () => void;
	onSaved: () => void;
}) {
	const [p, setP] = useState<Profile>({
		kind: initialKind,
		name: "",
		host: "",
		port: initialKind === "ssh" ? 22 : 5432,
		username: "",
		engine: initialKind === "db" ? "postgres" : null,
		color: COLORS[0],
		favorite: true,
	});
	const [err, setErr] = useState("");
	const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));

	async function save() {
		try {
			await api.profileSave(p);
			onSaved();
		} catch (e) {
			setErr(String(e));
		}
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
				<h3>새 연결</h3>
				<div className="seg" role="group">
					{(["ssh", "db"] as const).map((k) => (
						<button
							key={k}
							type="button"
							aria-pressed={p.kind === k}
							onClick={() => set({ kind: k, port: k === "ssh" ? 22 : DB_PORT[p.engine ?? "postgres"] ?? 5432, engine: k === "db" ? (p.engine ?? "postgres") : null })}
						>
							{k === "ssh" ? "SSH 서버" : "데이터베이스"}
						</button>
					))}
				</div>
				<div className="field">
					<label htmlFor="pf-name">이름</label>
					<input id="pf-name" autoFocus value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 개발 서버" />
				</div>
				{p.kind === "db" && (
					<div className="field">
						<label htmlFor="pf-engine">엔진</label>
						<select id="pf-engine" value={p.engine ?? "postgres"} onChange={(e) => set({ engine: e.target.value, port: DB_PORT[e.target.value] })}>
							<option value="postgres">PostgreSQL</option>
							<option value="mariadb">MariaDB</option>
							<option value="mysql">MySQL</option>
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
				<p style={{ color: "var(--text-3)", fontSize: 12, margin: "10px 0 0" }}>
					암호는 저장하지 않습니다. 실제 연결과 OS 자격 증명 저장은 다음 판에서 붙습니다.
				</p>
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
