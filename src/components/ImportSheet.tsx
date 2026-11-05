import { invoke } from "@tauri-apps/api/core";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type LegacyLevel } from "../lib/ipc";

type Candidate = {
	source: "ssh-config" | "putty";
	name: string;
	host: string;
	port: number;
	username: string;
	keyPath?: string | null;
	legacy: LegacyLevel;
	duplicate: boolean;
};

/** 가져오기 — ~/.ssh/config·PuTTY 세션에서 골라 내 연결로 */
export function ImportSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
	const [list, setList] = useState<Candidate[] | null>(null);
	const [pick, setPick] = useState<Set<number>>(new Set());
	const [err, setErr] = useState("");

	useEffect(() => {
		invoke<Candidate[]>("import_candidates", { sshConfigPath: null })
			.then((c) => {
				setList(c);
				setPick(new Set(c.map((x, i) => (x.duplicate ? -1 : i)).filter((i) => i >= 0)));
			})
			.catch((e) => setErr(String(e)));
	}, []);

	async function run() {
		if (!list) return;
		for (const i of pick) {
			const c = list[i];
			await api.profileSave({
				kind: "ssh",
				name: c.name,
				host: c.host,
				port: c.port,
				username: c.username,
				favorite: false,
				color: "#0a84ff",
				auth: c.keyPath ? "key" : "password",
				keyPath: c.keyPath ?? null,
				legacy: c.legacy,
				defaultPath: null,
				database: null,
			});
		}
		onDone();
	}

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="sheet" style={{ width: "min(560px, calc(100vw - 32px))" }}>
				<h3>접속 정보 가져오기</h3>
				<p style={{ color: "var(--text-2)", marginTop: -8 }}>~/.ssh/config 와 PuTTY 저장 세션에서 찾았습니다. 암호는 가져오지 않습니다.</p>
				{err && <p className="err">{err}</p>}
				{!list && !err && <p>찾는 중…</p>}
				{list && list.length === 0 && <div className="empty">가져올 항목이 없습니다.</div>}
				{list && list.length > 0 && (
					<div style={{ maxHeight: 340, overflow: "auto", margin: "0 -6px" }}>
						{list.map((c, i) => (
							<label key={`${c.source}-${c.name}-${i}`} className="check" style={{ padding: "6px", margin: 0, opacity: c.duplicate ? 0.55 : 1 }}>
								<input
									type="checkbox"
									checked={pick.has(i)}
									onChange={(e) => {
										const n = new Set(pick);
										if (e.target.checked) n.add(i);
										else n.delete(i);
										setPick(n);
									}}
								/>
								<span style={{ flex: 1, minWidth: 0 }}>
									<b style={{ color: "var(--text)" }}>{c.name}</b>{" "}
									<small style={{ fontFamily: "var(--font-mono)" }}>
										{c.username ? `${c.username}@` : ""}
										{c.host}:{c.port}
									</small>
								</span>
								{c.legacy !== "off" && <span className="badge warn">구형 {c.legacy}</span>}
								<span className="badge">{c.source === "putty" ? "PuTTY" : "ssh config"}</span>
								{c.duplicate && <span className="badge">이미 있음</span>}
							</label>
						))}
					</div>
				)}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button type="button" className="btn primary" disabled={!pick.size} onClick={() => void run()}>
						{pick.size}개 가져오기
					</button>
				</div>
			</div>
		</div>
	);
}

/** 내보내기 — 내 SSH 연결을 ssh config 로(암호 없음) */
export function ExportSheet({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState("");
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		void invoke<string>("export_ssh_config").then(setText);
	}, []);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="sheet" style={{ width: "min(620px, calc(100vw - 32px))" }}>
				<h3>ssh config 로 내보내기</h3>
				<p style={{ color: "var(--text-2)", marginTop: -8 }}>~/.ssh/config 에 붙여 넣으면 터미널의 ssh 명령에서도 같은 이름으로 접속됩니다.</p>
				<textarea className="fp" readOnly value={text} style={{ width: "100%", height: 300, resize: "vertical", border: 0, color: "var(--text)" }} />
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={() => {
							void navigator.clipboard.writeText(text);
							setCopied(true);
						}}
					>
						<Copy size={14} /> {copied ? "복사함" : "복사"}
					</button>
				</div>
			</div>
		</div>
	);
}
