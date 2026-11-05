import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowLeftRight, Copy, FolderOpen, KeyRound, Plus, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { askText } from "../lib/ask";
import { ContextMenu, type MenuItem } from "./ContextMenu";

/** keys.rs KeyInfo */
export type KeyInfo = {
	path: string;
	name: string;
	place: "ssh" | "app" | "other";
	format: "openssh" | "pem" | "pkcs8" | "ppk" | "pub";
	algorithm?: string | null;
	bits?: number | null;
	fingerprint?: string | null;
	comment?: string | null;
	publicKey?: string | null;
	encrypted?: boolean | null;
	pubPath?: string | null;
};

const FORMAT: Record<KeyInfo["format"], string> = { openssh: "OpenSSH", pem: "PEM", pkcs8: "PKCS#8", ppk: "PuTTY", pub: "공개키만" };
const ALGO: Record<string, string> = { "ssh-ed25519": "Ed25519", "ssh-rsa": "RSA", "ecdsa-sha2-nistp256": "ECDSA", "ecdsa-sha2-nistp384": "ECDSA", "ecdsa-sha2-nistp521": "ECDSA", "ssh-dss": "DSA" };
const NEED_PW = "NEED_PASSPHRASE";

const errText = (e: unknown) => String(typeof e === "object" && e && "message" in e ? (e as { message: string }).message : e).replace(/^NEED_PASSPHRASE:\s*/, "");

/**
 * SSH 키 관리 — ~/.ssh 와 앱이 만든 키(앱 데이터의 keys) 목록, 새 키 만들기, PPK ↔ OpenSSH 바꾸기,
 * 공개키를 열린 SSH 연결의 서버에 등록(ssh-copy-id 와 같음: ~/.ssh 700, authorized_keys 600, 이미 있으면 그대로).
 * conns: 지금 열린 SSH 연결(번호·보이는 이름) — 앱이 넘긴다
 */
export function KeysPane({ conns = [] }: { conns?: { conn: number; label: string }[] }) {
	const [list, setList] = useState<KeyInfo[] | null>(null);
	const [dirs, setDirs] = useState<{ ssh: string; app: string } | null>(null);
	const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
	const [gen, setGen] = useState(false);
	const [conv, setConv] = useState<KeyInfo | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(() => {
		invoke<KeyInfo[]>("keys_list")
			.then(setList)
			.catch((e) => setMsg({ text: errText(e) }));
	}, []);
	useEffect(() => {
		load();
		void invoke<{ ssh: string; app: string }>("keys_dirs").then(setDirs);
	}, [load]);

	const copyPub = (k: KeyInfo) => {
		if (!k.publicKey) return;
		void navigator.clipboard.writeText(k.publicKey);
		setMsg({ text: `${k.name} 공개키를 복사했습니다`, ok: true });
	};

	const install = async (k: KeyInfo) => {
		if (!k.publicKey) return;
		let conn = conns[0]?.conn;
		if (conns.length > 1) {
			const v = await askText({ title: "어느 서버에 등록할까요?", message: `${k.name} 공개키를 그 서버 계정의 ~/.ssh/authorized_keys 에 넣습니다`, choiceOnly: true, choices: conns.map((c) => ({ value: String(c.conn), label: c.label })) });
			if (v == null) return;
			conn = Number(v);
		}
		if (conn == null) return void setMsg({ text: "열린 SSH 연결이 없습니다 — 서버에 먼저 접속하세요" });
		const label = conns.find((c) => c.conn === conn)?.label ?? `연결 ${conn}`;
		setBusy(`${label} 에 등록하는 중…`);
		try {
			const r = await invoke<string>("keys_install", { conn, publicKey: k.publicKey });
			setMsg({ text: r === "exists" ? `${label} 에 이미 등록돼 있습니다` : `${label} 에 등록했습니다 — 이제 이 키로 접속할 수 있습니다`, ok: true });
		} catch (e) {
			setMsg({ text: errText(e) });
		} finally {
			setBusy(null);
		}
	};

	const pickToConvert = async () => {
		const f = await openDialog({ multiple: false, title: "바꿀 키 파일 고르기", defaultPath: dirs?.ssh });
		if (typeof f !== "string") return;
		try {
			setConv(await invoke<KeyInfo>("keys_inspect", { path: f }));
		} catch (e) {
			setMsg({ text: errText(e) });
		}
	};

	const rowMenu = (e: React.MouseEvent, k: KeyInfo) => {
		e.preventDefault();
		const items: MenuItem[] = [
			{ label: "공개키 복사", run: () => copyPub(k), disabled: !k.publicKey },
			{ label: "지문 복사", run: () => void navigator.clipboard.writeText(k.fingerprint ?? ""), disabled: !k.fingerprint },
			{ label: conns.length ? "서버에 공개키 등록…" : "서버에 공개키 등록(열린 연결 없음)", run: () => void install(k), disabled: !k.publicKey || !conns.length },
			{ sep: true },
			{ label: k.format === "ppk" ? "OpenSSH 로 바꾸기…" : "PuTTY(.ppk) 로 바꾸기…", run: () => setConv(k), disabled: k.format === "pub" },
			{ label: "경로 복사", run: () => void navigator.clipboard.writeText(k.path) },
			{ label: "폴더에서 보기", run: () => void revealItemInDir(k.path) },
		];
		setMenu({ x: e.clientX, y: e.clientY, items });
	};

	return (
		<div className="keys-pane">
			<div className="toolbar">
				<span className="title">
					<KeyRound size={14} /> SSH 키
				</span>
				<span style={{ flex: 1 }} />
				<button type="button" className="btn" onClick={() => setGen(true)}>
					<Plus size={14} /> 새 키
				</button>
				<button type="button" className="btn ghost" onClick={() => void pickToConvert()} title="PuTTY .ppk ↔ OpenSSH">
					<ArrowLeftRight size={14} /> 바꾸기
				</button>
				<button type="button" className="btn ghost icon" onClick={load} title="새로 고침">
					<RefreshCw size={14} />
				</button>
				{dirs && (
					<button type="button" className="btn ghost icon" onClick={() => void revealItemInDir(dirs.ssh).catch((e) => setMsg({ text: errText(e) }))} title={`${dirs.ssh} 열기`}>
						<FolderOpen size={14} />
					</button>
				)}
			</div>
			<div className="keys-list">
				{list === null ? (
					<p className="muted keys-empty">읽는 중…</p>
				) : list.length === 0 ? (
					<div className="keys-empty">
						<p>키가 없습니다.</p>
						<p className="muted">{dirs ? `${dirs.ssh} 와 앱 키 폴더를 살펴봤습니다.` : ""} 새 키를 만들어 보세요.</p>
					</div>
				) : (
					list.map((k) => (
						<div key={k.path} className="key-row" onContextMenu={(e) => rowMenu(e, k)}>
							<div className="key-main">
								<div className="key-name">
									<b title={k.path}>{k.name}</b>
									<span className="badge">{FORMAT[k.format]}</span>
									{k.algorithm && (
										<span className="badge">
											{ALGO[k.algorithm] ?? k.algorithm}
											{k.bits && k.algorithm !== "ssh-ed25519" ? ` ${k.bits}` : ""}
										</span>
									)}
									{k.encrypted && <span className="badge">암호</span>}
									{k.place === "app" && <span className="badge">앱</span>}
								</div>
								<div className="key-fp" title="SHA256 지문">
									{k.fingerprint ?? "지문을 알 수 없습니다(암호 걸린 PEM — .pub 파일이 없음)"}
								</div>
								{k.comment && <div className="key-comment">{k.comment}</div>}
							</div>
							<div className="key-actions">
								<button type="button" className="btn ghost icon" disabled={!k.publicKey} onClick={() => copyPub(k)} title="공개키 복사">
									<Copy size={14} />
								</button>
								<button type="button" className="btn ghost icon" disabled={!k.publicKey || !conns.length || !!busy} onClick={() => void install(k)} title={conns.length ? "서버에 공개키 등록(authorized_keys)" : "열린 SSH 연결이 없습니다"}>
									<Upload size={14} />
								</button>
							</div>
						</div>
					))
				)}
			</div>
			<div className="statusbar">
				{busy ? <span>{busy}</span> : msg ? <span className={msg.ok ? "ok" : "err"}>{msg.text}</span> : <span>{list ? `키 ${list.length}개 · 우클릭으로 더 보기` : ""}</span>}
			</div>
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
			{gen && (
				<GenerateSheet
					existing={new Set((list ?? []).map((k) => `${k.place}:${k.name}`))}
					onClose={() => setGen(false)}
					onDone={(k) => {
						setGen(false);
						setMsg({ text: `${k.name} 을(를) 만들었습니다 — ${k.path}`, ok: true });
						load();
					}}
				/>
			)}
			{conv && (
				<ConvertSheet
					k={conv}
					onClose={() => setConv(null)}
					onDone={(path) => {
						setConv(null);
						setMsg({ text: `바꿨습니다 — ${path}`, ok: true });
						load();
					}}
				/>
			)}
		</div>
	);
}

function GenerateSheet({ existing, onClose, onDone }: { existing: Set<string>; onClose: () => void; onDone: (k: KeyInfo) => void }) {
	const [algo, setAlgo] = useState<"ed25519" | "rsa">("ed25519");
	const [place, setPlace] = useState<"ssh" | "app">("ssh");
	const base = algo === "rsa" ? "id_rsa" : "id_ed25519";
	const suggest = () => {
		let n = base;
		for (let i = 2; existing.has(`${place}:${n}`); i++) n = `${base}_${i}`;
		return n;
	};
	const [name, setName] = useState(suggest);
	const [touched, setTouched] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 종류·자리를 바꾸면 이름 제안도(손댄 이름은 그대로)
	useEffect(() => {
		if (!touched) setName(suggest());
	}, [algo, place]);
	const [comment, setComment] = useState("");
	const [pw, setPw] = useState("");
	const [pw2, setPw2] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const nameOk = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name);
	const ok = nameOk && pw === pw2 && !busy;

	const run = async () => {
		setBusy(true);
		setErr("");
		try {
			const k = await invoke<KeyInfo>("keys_generate", { name, algo, passphrase: pw || null, comment: comment.trim() || null, place });
			onDone(k);
		} catch (e) {
			setErr(errText(e));
			setBusy(false);
		}
	};

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
			<form
				className="sheet"
				onSubmit={(e) => {
					e.preventDefault();
					if (ok) void run();
				}}
				onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
			>
				<h3>새 SSH 키</h3>
				<div className="seg" role="group">
					<button type="button" aria-pressed={algo === "ed25519"} onClick={() => setAlgo("ed25519")}>
						Ed25519(권장)
					</button>
					<button type="button" aria-pressed={algo === "rsa"} onClick={() => setAlgo("rsa")}>
						RSA 4096
					</button>
				</div>
				<div className="field">
					<label htmlFor="kg-name">파일 이름</label>
					<input
						id="kg-name"
						value={name}
						onChange={(e) => {
							setTouched(true);
							setName(e.target.value);
						}}
						spellCheck={false}
						autoComplete="off"
					/>
					{!nameOk && <small className="err">영문·숫자·- _ . 만(점으로 시작하지 않게)</small>}
				</div>
				<div className="field">
					<label htmlFor="kg-comment">설명(공개키 끝에 붙음, 선택)</label>
					<input id="kg-comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="예: 내이름@노트북" spellCheck={false} autoComplete="off" />
				</div>
				<div className="row2" style={{ gridTemplateColumns: "1fr 1fr" }}>
					<div className="field">
						<label htmlFor="kg-pw">암호(선택)</label>
						<input id="kg-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
					</div>
					<div className="field">
						<label htmlFor="kg-pw2">암호 한 번 더</label>
						<input id="kg-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
					</div>
				</div>
				{pw !== pw2 && <small className="err">두 암호가 다릅니다</small>}
				<div className="field">
					<span className="field-label">저장할 곳</span>
					<div className="seg" role="group" style={{ margin: 0 }}>
						<button type="button" aria-pressed={place === "ssh"} onClick={() => setPlace("ssh")}>
							~/.ssh
						</button>
						<button type="button" aria-pressed={place === "app"} onClick={() => setPlace("app")}>
							앱 키 폴더
						</button>
					</div>
				</div>
				<p className="muted keys-note">개인키는 내 PC 에만 남습니다. 서버에는 공개키(.pub)만 등록하세요.{algo === "rsa" ? " RSA 4096 은 만드는 데 몇 초 걸릴 수 있습니다." : ""}</p>
				{err && <p className="err">{err}</p>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose} disabled={busy}>
						닫기
					</button>
					<button type="submit" className="btn primary" disabled={!ok}>
						{busy ? "만드는 중…" : "만들기"}
					</button>
				</div>
			</form>
		</div>
	);
}

function ConvertSheet({ k, onClose, onDone }: { k: KeyInfo; onClose: () => void; onDone: (path: string) => void }) {
	const [to, setTo] = useState<"openssh" | "ppk">(k.format === "ppk" ? "openssh" : "ppk");
	const [pw, setPw] = useState("");
	const [newPw, setNewPw] = useState("");
	const [needPw, setNeedPw] = useState(!!k.encrypted);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");

	const run = async () => {
		const stem = k.name.replace(/\.ppk$/i, "");
		const dst = await saveDialog({
			title: to === "ppk" ? "PuTTY 키로 저장" : "OpenSSH 키로 저장",
			defaultPath: to === "ppk" ? `${k.path.replace(/[^\\/]+$/, "")}${stem}.ppk` : `${k.path.replace(/[^\\/]+$/, "")}${stem}${k.format === "ppk" ? "" : "_openssh"}`,
			filters: to === "ppk" ? [{ name: "PuTTY 키", extensions: ["ppk"] }] : undefined,
		});
		if (!dst) return;
		setBusy(true);
		setErr("");
		try {
			const path = await invoke<string>("keys_convert", { src: k.path, dst, to, passphrase: pw || null, newPassphrase: to === "openssh" ? newPw || null : null });
			onDone(path);
		} catch (e) {
			const m = String(e);
			if (m.startsWith(NEED_PW)) setNeedPw(true);
			setErr(errText(e));
			setBusy(false);
		}
	};

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
			<form
				className="sheet"
				onSubmit={(e) => {
					e.preventDefault();
					if (!busy) void run();
				}}
				onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
			>
				<h3>키 바꾸기 — {k.name}</h3>
				<p className="muted keys-note" style={{ marginTop: -8 }}>
					지금 형식: {FORMAT[k.format]}
					{k.encrypted ? " · 암호 걸림" : ""}
				</p>
				<div className="seg" role="group">
					<button type="button" aria-pressed={to === "openssh"} onClick={() => setTo("openssh")}>
						OpenSSH 로
					</button>
					<button type="button" aria-pressed={to === "ppk"} onClick={() => setTo("ppk")}>
						PuTTY(.ppk 3) 로
					</button>
				</div>
				{needPw && (
					<div className="field">
						<label htmlFor="kc-pw">지금 키의 암호</label>
						<input id="kc-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" autoFocus />
					</div>
				)}
				{to === "openssh" ? (
					<div className="field">
						<label htmlFor="kc-new">새 파일에 걸 암호(비우면 암호 없음)</label>
						<input id="kc-new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
					</div>
				) : (
					<p className="muted keys-note">PPK 는 암호 없이 만듭니다(ed25519·RSA). 암호가 필요하면 PuTTYgen 에서 거세요. 짝 공개키 .pub 는 OpenSSH 로 바꿀 때 함께 만듭니다.</p>
				)}
				{err && <p className="err">{err}</p>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose} disabled={busy}>
						닫기
					</button>
					<button type="submit" className="btn primary" disabled={busy || (needPw && !pw)}>
						{busy ? "바꾸는 중…" : "저장할 곳 고르기…"}
					</button>
				</div>
			</form>
		</div>
	);
}
