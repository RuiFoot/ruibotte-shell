import { invoke } from "@tauri-apps/api/core";
import { FileText, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FsBackend } from "../lib/ipc";

/** `.`·`..`·겹친 `/` 정리 — 원격은 `/…`, 내 PC 는 `C:/…` 도 */
function normalize(path: string): string {
	const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
	const out: string[] = [];
	for (const part of path.slice(drive.length).split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `${drive}/${out.join("/")}`;
}

/** 넣은 경로를 절대 경로로 — `~` 는 홈, 상대 경로는 base 기준 */
export function resolvePath(raw: string, base: string, home: string): string {
	const p = raw.replace(/\\/g, "/");
	if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return normalize(p);
	if (p === "~" || p.startsWith("~/")) return normalize(home + p.slice(1));
	return normalize(`${base}/${p}`);
}

const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** 이름으로 찾기 — 원격은 서버 find, 내 PC 는 앱이 직접(깊이 8·200개, .git·node_modules 제외) */
async function findFiles(fs: FsBackend, base: string, query: string): Promise<string[]> {
	if (fs.side === "local") return invoke<string[]>("local_find", { base, query });
	if (fs.conn == null) return [];
	const pat = query.includes("*") ? query : `*${query}*`;
	const cmd = `find ${sq(base)} -maxdepth 8 \\( -name .git -o -name node_modules \\) -prune -o -type f -iname ${sq(pat)} -print 2>/dev/null | head -200`;
	const out = await invoke<string>("ssh_exec", { conn: fs.conn, cmd });
	return out.split("\n").filter(Boolean);
}

/**
 * 파일 빠른 열기(Alt+O) — 지금 터미널 폴더(없으면 홈) 아래에서 이름으로 찾는다.
 * `/` 나 `~` 로 시작하면 그 경로를 바로 연다. ↑↓ 고르기, Enter 열기, Esc 닫기.
 */
export function QuickOpen({ fs, base, onClose, onOpen }: { fs: FsBackend; base: string; onClose: () => void; onOpen: (path: string) => void }) {
	const [query, setQuery] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [index, setIndex] = useState(0);
	const seq = useRef(0);
	const list = useRef<HTMLDivElement>(null);
	const q = query.trim();
	const direct = q.startsWith("/") || q.startsWith("~") || (fs.side === "local" && /^[A-Za-z]:[\\/]/.test(q));

	useEffect(() => {
		if (!q || direct) {
			seq.current++;
			setFiles([]);
			setError(null);
			setPending(false);
			return;
		}
		const my = ++seq.current;
		const timer = window.setTimeout(() => {
			setPending(true);
			findFiles(fs, base, q)
				.then((r) => {
					if (seq.current !== my) return;
					setFiles(r);
					setIndex(0);
					setError(null);
				})
				.catch((e) => seq.current === my && setError(String((e as { message?: string })?.message ?? e)))
				.finally(() => seq.current === my && setPending(false));
		}, 180);
		return () => window.clearTimeout(timer);
	}, [q, base, direct, fs]);

	useEffect(() => {
		list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index]);

	const open = (i: number) => {
		if (direct) {
			onOpen(resolvePath(q, base, fs.home));
			return;
		}
		const f = files[i];
		if (f) onOpen(f);
	};

	return (
		<div className="scrim" style={{ placeItems: "start center", paddingTop: "12vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="palette" role="dialog" aria-label="파일 빠른 열기">
				<div className="palette-head qo-head">
					<Search size={15} />
					<input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								onClose();
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setIndex((i) => Math.min(files.length - 1, i + 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setIndex((i) => Math.max(0, i - 1));
							} else if (e.key === "Enter") {
								e.preventDefault();
								open(index);
							}
						}}
						placeholder={`이름으로 찾기 (${base} 아래) · /경로 로 바로 열기`}
						spellCheck={false}
						autoComplete="off"
					/>
					{pending && <span className="qo-spin">찾는 중…</span>}
				</div>
				<div className="palette-list" ref={list} role="listbox" aria-label="찾은 파일">
					{direct ? (
						<div className="qo-msg">Enter — {resolvePath(q, base, fs.home)} 열기</div>
					) : error ? (
						<div className="qo-msg err">{error}</div>
					) : q && !pending && files.length === 0 ? (
						<div className="qo-msg">찾은 파일이 없습니다.</div>
					) : !q ? (
						<div className="qo-msg">파일 이름 일부를 치세요. * 는 아무 글자입니다.</div>
					) : (
						files.map((f, i) => {
							const rel = f.startsWith(`${base}/`) ? f.slice(base.length + 1) : f;
							const slash = rel.lastIndexOf("/");
							return (
								<div
									key={f}
									data-i={i}
									role="option"
									tabIndex={-1}
									aria-selected={i === index}
									className="qo-item"
									title={f}
									onMouseEnter={() => setIndex(i)}
									onMouseDown={(e) => {
										e.preventDefault();
										open(i);
									}}
								>
									<FileText size={14} />
									<span className="qo-name">{slash >= 0 ? rel.slice(slash + 1) : rel}</span>
									{slash >= 0 && <span className="qo-dir">{rel.slice(0, slash)}</span>}
								</div>
							);
						})
					)}
				</div>
				<div className="palette-foot">↑↓ 고르기 · Enter 열기 · Esc 닫기 · 깊이 8단계·200개까지(.git·node_modules 제외)</div>
			</div>
		</div>
	);
}
