import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, FileText, Search, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileText as FileTextT } from "../../lib/ipc";
import { Select } from "../Select";
import { errText, type GrepOpts, type Hit, localGrep, marked, type SudoCtx, sq, srvStream, sudoAllowed } from "./common";

/**
 * 파일 내용 찾기 — 폴더 안에서 낱말·정규식(대소문자·파일 이름 거르기·깊이·크기·바이너리 제외).
 * 서버: rg 가 있으면 rg, 없으면 find + grep 을 흘려 받는다. 내 PC: Rust 가 직접 찾는다(정규식은 파일 목록을 받아 화면이 맞춘다).
 * 결과 줄을 누르면 onOpenFile(path, line).
 */
export type ContentSearchProps = {
	side: "remote" | "local";
	/** 원격이면 SSH 연결 번호 */
	conn?: number;
	sudo?: SudoCtx;
	/** 처음 폴더 — 지금 트리 또는 터미널 폴더 */
	startDir: string;
	onOpenFile: (path: string, line?: number) => void;
};

const MAX_HITS = 5000;
const SIZES = [
	{ value: 1, label: "1MB 까지" },
	{ value: 10, label: "10MB 까지" },
	{ value: 100, label: "100MB 까지" },
	{ value: 0, label: "크기 제한 없음" },
];
const DEPTHS = [0, 1, 2, 3, 5, 10].map((d) => ({ value: d, label: d ? `깊이 ${d}` : "끝까지" }));

type Q = { dir: string; pat: string; regex: boolean; cs: boolean; globs: string[]; skip: string[]; depth: number; sizeMb: number; sudo: boolean };

const splitList = (s: string) =>
	s
		.split(/[,\s]+/)
		.map((x) => x.trim())
		.filter(Boolean);

/** 서버에서 돌릴 찾기 명령 — 출력은 "경로\0줄:글" (-Z 를 못 쓰는 grep 이면 "경로:줄:글") */
export function remoteGrepCmd(q: Q): string {
	const dir = q.dir || ".";
	// rg
	const rg = [
		"rg --no-config --line-number --with-filename --no-heading --null --color never -uu -M 400 --max-columns-preview",
		q.depth ? `--max-depth ${q.depth}` : "",
		q.sizeMb ? `--max-filesize ${q.sizeMb}M` : "",
		...q.globs.map((g) => `-g ${sq(g)}`),
		...q.skip.map((d) => `-g ${sq(`!${d}`)}`),
		q.cs ? "-s" : "-i",
		q.regex ? "" : "-F",
		`-e ${sq(q.pat)} -- ${sq(dir)}`,
	]
		.filter(Boolean)
		.join(" ");
	// find + grep
	const prune = q.skip.length ? `\\( -type d \\( ${q.skip.map((d) => `-name ${sq(d)}`).join(" -o ")} \\) -prune \\) -o ` : "";
	const names = q.globs.length ? `\\( ${q.globs.map((g) => `-name ${sq(g)}`).join(" -o ")} \\) ` : "";
	const size = q.sizeMb ? `-size -${q.sizeMb * 1024 + 1}k ` : "";
	const find = `find ${sq(dir)} ${q.depth ? `-maxdepth ${q.depth} ` : ""}${prune}\\( -type f ${names}${size}-print0 \\) 2>/dev/null`;
	const flags = `-I -H -n ${q.cs ? "" : "-i "}${q.regex ? "-E" : "-F"}`;
	const grep = `${find} | xargs -0 grep ${flags} $Z -e ${sq(q.pat)} -- 2>/dev/null | cut -b 1-800`;
	return `if command -v rg >/dev/null 2>&1; then ${rg} 2>/dev/null; else Z=; if grep -Z -q x /dev/null 2>/dev/null; [ $? -le 1 ]; then Z=-Z; fi; ${grep}; fi | head -n ${MAX_HITS}`;
}

/** 출력 한 줄 → 찾은 것 */
export function parseGrepLine(l: string): Hit | null {
	const z = l.indexOf("\0");
	if (z >= 0) {
		const m = l.slice(z + 1).match(/^(\d+)[:-](.*)$/s);
		return m ? { path: l.slice(0, z), line: Number(m[1]), text: m[2] } : null;
	}
	const m = l.match(/^(.+?):(\d+):(.*)$/s);
	return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null;
}

export function ContentSearch({ side, conn, sudo, startDir, onOpenFile }: ContentSearchProps) {
	const [dir, setDir] = useState(startDir);
	const [pat, setPat] = useState("");
	const [regex, setRegex] = useState(false);
	const [cs, setCs] = useState(false);
	const [globs, setGlobs] = useState("");
	const [skip, setSkip] = useState(".git node_modules");
	const [depth, setDepth] = useState(0);
	const [sizeMb, setSizeMb] = useState(10);
	const [useSudo, setUseSudo] = useState(false);
	const [hits, setHits] = useState<Hit[]>([]);
	const [run, setRun] = useState<{ busy: boolean; text: string; err?: boolean; q?: Q } | null>(null);
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const stopRef = useRef<(() => void) | null>(null);
	const canSudo = side === "remote" && sudoAllowed(sudo);

	useEffect(() => setDir(startDir), [startDir]);
	useEffect(() => () => stopRef.current?.(), []);

	const stop = () => {
		stopRef.current?.();
		stopRef.current = null;
	};

	const start = async () => {
		stop();
		if (!pat) return;
		const q: Q = { dir: dir.trim() || startDir, pat, regex, cs, globs: splitList(globs), skip: splitList(skip), depth, sizeMb, sudo: useSudo && canSudo };
		let re: RegExp | null = null;
		if (regex) {
			try {
				re = new RegExp(pat, cs ? "" : "i");
			} catch (e) {
				if (side === "local") return setRun({ busy: false, text: `정규식이 이상합니다: ${(e as Error).message}`, err: true });
			}
		}
		setHits([]);
		setFolded(new Set());
		setRun({ busy: true, text: "찾는 중…", q });
		const buf: Hit[] = [];
		let n = 0;
		let frame = 0;
		const add = (h: Hit[]) => {
			buf.push(...h);
			n += h.length;
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					setHits(buf.slice(0, MAX_HITS));
					setRun((r) => (r?.busy ? { ...r, text: `찾는 중… ${n}개` } : r));
				});
		};
		const done = (text: string, err = false) => {
			cancelAnimationFrame(frame);
			frame = 0;
			setHits(buf.slice(0, MAX_HITS));
			setRun({ busy: false, text: `${text}${n >= MAX_HITS ? ` — 처음 ${MAX_HITS}개까지만` : ""}`, err, q });
			stopRef.current = null;
		};
		try {
			if (side === "remote") {
				if (conn == null) throw new Error("연결이 없습니다");
				let part = "";
				stopRef.current = await srvStream(conn, remoteGrepCmd(q), {
					sudo: q.sudo,
					onText: (t) => {
						const lines = (part + t).split("\n");
						part = lines.pop() ?? "";
						const got = lines.map(parseGrepLine).filter((x): x is Hit => !!x);
						if (got.length) add(got);
					},
					onEnd: (e) => {
						const last = part && parseGrepLine(part);
						if (last) add([last]);
						done(e.cancelled ? `멈춤 — ${n}개` : `${n}개 찾음`);
					},
				});
				return;
			}
			const opts: GrepOpts = { pattern: regex ? null : pat, ignoreCase: !cs, globs: q.globs, skipDirs: q.skip, maxDepth: q.depth, maxSize: q.sizeMb * 1024 * 1024, maxHits: regex ? 100000 : MAX_HITS };
			if (!regex) {
				stopRef.current = await localGrep(q.dir, opts, add, (e) => done(e.cancelled ? `멈춤 — ${n}개` : `${n}개 찾음 · ${e.message ?? ""}`));
				return;
			}
			// 정규식: 파일 목록을 받아 하나씩 읽어 맞춘다
			const files: string[] = [];
			let cancelled = false;
			let listDone = false;
			let reading = false;
			const pump = async () => {
				if (reading) return;
				reading = true;
				while (files.length && !cancelled && n < MAX_HITS) {
					const p = files.shift() as string;
					try {
						const f = await invoke<FileTextT>("local_read_text", { path: p });
						if (!f.text) continue;
						const out: Hit[] = [];
						f.text.split(/\r?\n/).forEach((l, i) => {
							if (re?.test(l)) out.push({ path: p, line: i + 1, text: l.length > 400 ? `${l.slice(0, 400)}…` : l });
						});
						if (out.length) add(out);
					} catch {
						/* 못 읽는 파일은 건너뛴다 */
					}
				}
				reading = false;
				if (listDone && !files.length) done(cancelled ? `멈춤 — ${n}개` : `${n}개 찾음`);
			};
			const stopList = await localGrep(
				q.dir,
				opts,
				(h) => {
					files.push(...h.map((x) => x.path));
					void pump();
				},
				() => {
					listDone = true;
					void pump();
				},
			);
			stopRef.current = () => {
				cancelled = true;
				files.length = 0;
				stopList();
			};
		} catch (e) {
			done(errText(e), true);
		}
	};

	const grouped = useMemo(() => {
		const m = new Map<string, Hit[]>();
		for (const h of hits) m.set(h.path, [...(m.get(h.path) ?? []), h]);
		return [...m.entries()];
	}, [hits]);

	const highlight = useMemo(() => {
		const q = run?.q;
		if (!q) return null;
		if (!q.regex) return q.cs ? new RegExp(q.pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : q.pat;
		try {
			return new RegExp(q.pat, q.cs ? "g" : "gi");
		} catch {
			return null;
		}
	}, [run?.q]);

	const base = (run?.q?.dir ?? dir).replace(/\/+$/, "");
	const rel = (p: string) => (p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p);

	return (
		<div className="sp-panel sp-search">
			<form
				className="sp-form"
				onSubmit={(e) => {
					e.preventDefault();
					void start();
				}}
			>
				<div className="sp-bar">
					<label className="sp-find sp-wide">
						<Search size={13} />
						<input value={pat} onChange={(e) => setPat(e.target.value)} placeholder={regex ? "정규식" : "찾을 낱말"} spellCheck={false} autoFocus />
					</label>
					<button type="button" className={`btn ghost tiny${regex ? " on" : ""}`} aria-pressed={regex} onClick={() => setRegex((x) => !x)} title="정규식">
						.*
					</button>
					<button type="button" className={`btn ghost tiny${cs ? " on" : ""}`} aria-pressed={cs} onClick={() => setCs((x) => !x)} title="대소문자 구분">
						Aa
					</button>
					{run?.busy ? (
						<button type="button" className="btn tiny" onClick={stop}>
							<Square size={12} /> 멈추기
						</button>
					) : (
						<button type="submit" className="btn primary tiny" disabled={!pat}>
							찾기
						</button>
					)}
				</div>
				<div className="sp-bar">
					<label className="sp-find sp-wide" title="이 폴더 안에서">
						<span className="sp-k">폴더</span>
						<input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
					</label>
					<label className="sp-find" title="파일 이름 거르기 — 쉼표·빈칸으로 여럿">
						<span className="sp-k">이름</span>
						<input value={globs} onChange={(e) => setGlobs(e.target.value)} placeholder="*.log, *.conf" spellCheck={false} />
					</label>
				</div>
				<div className="sp-bar">
					<label className="sp-find" title="들어가지 않을 폴더 이름">
						<span className="sp-k">건너뛸 폴더</span>
						<input value={skip} onChange={(e) => setSkip(e.target.value)} spellCheck={false} />
					</label>
					<Select size="sm" value={depth} onChange={setDepth} title="최대 깊이" options={DEPTHS} />
					<Select size="sm" value={sizeMb} onChange={setSizeMb} title="이보다 큰 파일은 건너뜀" options={SIZES} />
					{canSudo && (
						<button type="button" className={`btn ghost tiny${useSudo ? " on" : ""}`} aria-pressed={useSudo} onClick={() => setUseSudo((x) => !x)} title="읽을 권한이 없는 파일까지(sudo)">
							sudo
						</button>
					)}
				</div>
			</form>
			{run && <p className={`sp-pad ${run.err ? "err" : "sp-dim"}`}>{run.text} · 바이너리 파일은 빠집니다</p>}
			<div className="sp-scroll selectable">
				{grouped.map(([path, l]) => {
					const shut = folded.has(path);
					return (
						<div key={path} className="sp-hitfile">
							<button
								type="button"
								className="sp-hithead"
								onClick={() =>
									setFolded((s) => {
										const n = new Set(s);
										if (n.has(path)) n.delete(path);
										else n.add(path);
										return n;
									})
								}
								onDoubleClick={() => onOpenFile(path)}
								title={path}
							>
								{shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
								<FileText size={13} />
								<span className="sp-mono">{rel(path)}</span>
								<small className="sp-dim">{l.length}</small>
							</button>
							{!shut &&
								l.map((h) => (
									<button key={`${h.line}:${h.text.slice(0, 20)}`} type="button" className="sp-hit" onClick={() => onOpenFile(h.path, h.line || undefined)} title={`${h.path}:${h.line}`}>
										<span className="sp-ln">{h.line}</span>
										<span className="sp-mono">{marked(h.text, highlight)}</span>
									</button>
								))}
						</div>
					);
				})}
				{run && !run.busy && !run.err && hits.length === 0 && <div className="sp-empty">찾은 것이 없습니다</div>}
			</div>
		</div>
	);
}
