import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type LegacyLevel, type Profile } from "../lib/ipc";

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
	// 같은 주소·포트의 다른 사용자는 서버 하나의 계정 여럿으로
	const [merge, setMerge] = useState(true);

	useEffect(() => {
		invoke<Candidate[]>("import_candidates", { sshConfigPath: null })
			.then((c) => {
				setList(c);
				setPick(new Set(c.map((x, i) => (x.duplicate ? -1 : i)).filter((i) => i >= 0)));
			})
			.catch((e) => setErr(String(e)));
	}, []);

	const [dbs, setDbs] = useState<{ source: string; name: string; engine: string; host: string; port: number; database: string; username: string }[]>([]);
	async function pickDbFile() {
		const f = await openDialog({ multiple: false, filters: [{ name: "DataGrip·DBeaver", extensions: ["xml", "json"] }] });
		if (typeof f !== "string") return;
		try {
			setDbs(await invoke("import_db_file", { path: f }));
		} catch (e) {
			setErr(String(e));
		}
	}
	async function run() {
		try {
			const have: Profile[] = await api.profilesList();
			const same = (p: Profile, kind: "ssh" | "db", host: string, port: number, extra?: (p: Profile) => boolean) =>
				p.kind === kind && p.host.toLowerCase() === host.toLowerCase() && p.port === port && (!extra || extra(p));
			/** 같은 서버가 있으면 계정만 더하고, 없으면 서버(기본 계정 포함)를 만든다 */
			const put = async (target: Profile | undefined, make: Profile, auth: "password" | "key", keyPath: string | null) => {
				if (merge && target?.id != null) {
					if ((target.accounts ?? []).some((x) => x.username === make.username)) return;
					await api.accountSave({ profileId: target.id, username: make.username, auth, keyPath, sudo: "off", sudoUser: "root", isDefault: false, label: null });
					target.accounts = [...(target.accounts ?? []), { profileId: target.id, username: make.username, auth, keyPath, sudo: "off", sudoUser: "root", isDefault: false }];
					return;
				}
				const id = await api.profileSave(make);
				have.push({ ...make, id, accounts: [{ profileId: id, username: make.username, auth, keyPath, sudo: "off", sudoUser: "root", isDefault: true }] });
			};
			for (const d of dbs) {
				const make: Profile = { kind: "db", name: d.name, host: d.host, port: d.port, username: d.username, engine: d.engine, database: d.database || null, favorite: false, color: "#30d158", auth: "password", keyPath: null, legacy: "off", defaultPath: null };
				await put(
					have.find((p) => same(p, "db", d.host, d.port, (x) => x.engine === d.engine && (x.database ?? "") === (d.database ?? ""))),
					make,
					"password",
					null,
				);
			}
			for (const i of list ? [...pick].sort((x, y) => x - y) : []) {
				const c = (list as Candidate[])[i];
				const auth = c.keyPath ? "key" : "password";
				const make: Profile = {
					kind: "ssh",
					name: c.name,
					host: c.host,
					port: c.port,
					username: c.username,
					favorite: false,
					color: "#0a84ff",
					auth,
					keyPath: c.keyPath ?? null,
					legacy: c.legacy,
					defaultPath: null,
					database: null,
				};
				await put(
					have.find((p) => same(p, "ssh", c.host, c.port)),
					make,
					auth,
					c.keyPath ?? null,
				);
			}
			onDone();
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		}
	}

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="sheet" style={{ width: "min(560px, calc(100vw - 32px))" }}>
				<h3>접속 정보 가져오기</h3>
				<p style={{ color: "var(--text-2)", marginTop: -8 }}>~/.ssh/config 와 PuTTY 저장 세션에서 찾았습니다. DB 는 "DB 파일…"로 DataGrip·DBeaver 파일을 고르세요. 암호는 가져오지 않습니다. "이미 있음"은 같은 서버에 같은 사용자 계정이 있다는 뜻입니다.</p>
				{dbs.length > 0 && (
					<p style={{ fontSize: 12.5 }}>
						DB {dbs.length}개: {dbs.map((d) => `${d.name}(${d.engine})`).join(", ")}
					</p>
				)}
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
				<label className="check" title="예: 같은 서버에 root·deploy 두 줄이 있으면 서버 하나에 계정 두 개로 넣습니다">
					<input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> 같은 주소·포트의 다른 사용자는 한 서버의 계정으로 합치기(이미 있는 서버에도)
				</label>
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button type="button" className="btn" onClick={() => void pickDbFile()} title="DataGrip dataSources.xml · DBeaver data-sources.json">
						DB 파일…{dbs.length ? ` (${dbs.length})` : ""}
					</button>
					<button type="button" className="btn primary" disabled={!pick.size && !dbs.length} onClick={() => void run()}>
						{pick.size + dbs.length}개 가져오기
					</button>
				</div>
			</div>
		</div>
	);
}

const FORMATS = [
	{ key: "ssh-config", label: "ssh config", ext: "config", hint: "~/.ssh/config 에 붙여 넣으면 ssh 명령에서도 같은 이름으로 접속됩니다" },
	{ key: "hosts", label: "hosts", ext: "txt", hint: "IP 주소인 서버를 이름으로 부르는 hosts 줄" },
	{ key: "putty-reg", label: "PuTTY", ext: "reg", hint: "두 번 눌러 레지스트리에 넣으면 PuTTY 저장 세션이 생깁니다" },
	{ key: "mobaxterm", label: "MobaXterm", ext: "mxtsessions", hint: "MobaXterm › Sessions › Import sessions from file" },
	{ key: "datagrip", label: "DataGrip", ext: "xml", hint: "DB 프로필 — DataGrip 데이터 원본(dataSources.xml)" },
	{ key: "dbeaver", label: "DBeaver", ext: "json", hint: "DB 프로필 — DBeaver data-sources.json" },
	{ key: "jdbc-csv", label: "JDBC CSV", ext: "csv", hint: "DB 프로필 — 이름·엔진·JDBC URL·계정" },
];

/** 내보내기 — SSH·DB 프로필을 여러 형식으로(암호 없음) */
export function ExportSheet({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState("");
	const [copied, setCopied] = useState(false);
	const [fmt, setFmt] = useState("ssh-config");
	const cur = FORMATS.find((f) => f.key === fmt) ?? FORMATS[0];
	useEffect(() => {
		setCopied(false);
		void invoke<string>("export_profiles", { format: fmt }).then(setText).catch((e) => setText(String(e)));
	}, [fmt]);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="sheet" style={{ width: "min(620px, calc(100vw - 32px))" }}>
				<h3>내보내기</h3>
				<div className="seg" role="group" style={{ flexWrap: "wrap" }}>
					{FORMATS.map((f) => (
						<button key={f.key} type="button" aria-pressed={fmt === f.key} onClick={() => setFmt(f.key)}>
							{f.label}
						</button>
					))}
				</div>
				<p style={{ color: "var(--text-2)", marginTop: 0, fontSize: 12.5 }}>{cur.hint} · 암호는 들어 있지 않습니다.</p>
				<textarea className="fp" readOnly value={text} style={{ width: "100%", height: 300, resize: "vertical", border: 0, color: "var(--text)" }} />
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose}>
						닫기
					</button>
					<button
						type="button"
						className="btn"
						onClick={async () => {
							const path = await saveDialog({ defaultPath: `ruibotte-shell-${cur.key}.${cur.ext}` });
							if (path) await invoke("local_write_text", { path, text, meta: { encoding: fmt === "putty-reg" ? "UTF-16LE" : "UTF-8", bom: fmt === "putty-reg", eol: fmt === "putty-reg" ? "CRLF" : "LF", guessed: false }, expectMtime: null });
						}}
					>
						파일로 저장
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
