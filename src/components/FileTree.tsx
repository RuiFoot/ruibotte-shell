import { ArrowLeft, ArrowRight, ChevronRight, Plus, File, FileCode, FileText, Folder, FolderOpen, House, Link2, RefreshCw, Unlink } from "lucide-react";
import { memo, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { asSshError, type FsBackend, type FsEntry, joinPath, notifyFsChanged, parentDir } from "../lib/ipc";
import { freeName, useConflictAsk } from "./ConflictSheet";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { askText } from "../lib/ask";

const CODE = /\.(js|ts|tsx|jsx|json|py|java|go|rs|sh|sql|xml|yml|yaml|html|css|jsp|php|rb|c|h|cpp|kt)$/i;
export const DRAG_MIME = "application/x-rbshell-entry";

export type DragEntry = { side: "remote" | "local"; conn?: number; path: string; name: string; kind: FsEntry["kind"] };

function icon(e: FsEntry, open: boolean) {
	if (e.kind === "dir") return open ? <FolderOpen size={15} className="ti dir" /> : <Folder size={15} className="ti dir" />;
	if (e.kind === "link") return <Link2 size={15} className="ti" />;
	if (CODE.test(e.name)) return <FileCode size={15} className="ti" />;
	if (/\.(log|txt|md|conf|properties|ini|cfg|env)$/i.test(e.name)) return <FileText size={15} className="ti" />;
	return <File size={15} className="ti" />;
}

function fmtSize(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
	return `${(n / 1073741824).toFixed(2)} GB`;
}

type Node = { entries?: FsEntry[]; error?: string };

/** 지우면 안 되는 최상위 폴더(실수 방지) */
const PROTECTED = /^(\/|\/(bin|boot|dev|etc|home|lib|lib32|lib64|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var)\/?|[A-Za-z]:\/?|[A-Za-z]:\/(Windows|Program Files|Program Files \(x86\)|ProgramData|Users)\/?)$/i;
/** 큰 폴더는 이만큼씩 그린다 */
const PAGE = 500;

/** 행을 감싼 스크롤 칸(overflow auto/scroll 이고 실제로 넘치는 조상) */
function scrollerOf(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
	}
	return null;
}

/**
 * 터미널 따라가기로 고른 폴더를 보이게 — 행이 칸 위쪽 1/4 안에 이미 있으면 그대로 두고,
 * 아니면(아래쪽에 붙었거나 가려졌으면) 행 하나 여유를 두고 위쪽으로 올려 펼친 안이 아래에 보이게 한다.
 * 펼친 목록이 그려지기 전일 수 있어 행이 나타날 때까지 몇 프레임 기다린다.
 */
function revealScroll(body: HTMLElement | null, path: string, cancelled: () => boolean) {
	let tries = 0;
	const tick = () => {
		if (cancelled() || !body) return;
		const el = body.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
		const box = el ? scrollerOf(el) : null;
		if (!el || !box) {
			if (++tries < 12) requestAnimationFrame(tick);
			else el?.scrollIntoView({ block: "nearest" });
			return;
		}
		const b = box.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const comfy = r.top >= b.top && r.bottom <= b.top + b.height / 4;
		if (!comfy) box.scrollTo({ top: Math.max(0, box.scrollTop + (r.top - b.top) - r.height) });
	};
	requestAnimationFrame(tick);
}
/** 탐색기에서 끌어 놓은 파일을 보내는 조각 크기 */
const CHUNK = 4 * 1024 * 1024;

/**
 * 파일 트리 — 펼칠 때만 그 폴더를 읽는다(원격·내 PC 공용).
 * 우클릭 메뉴(새 폴더·새 파일·이름 바꾸기·지우기·경로 복사·주고받기), 끌어 놓기(옮기기·주고받기).
 */
export const FileTree = memo(function FileTree({
	fs,
	root,
	onRoot,
	onOpen,
	onDrop,
	onSend,
	sendLabel,
	onCd,
	onTail,
	onCompare,
	compareLabel,
	onArchive,
	onRelay,
	selected,
	onUploadPick,
	onDownloadTo,
	onNewTerminal,
	reveal,
	onSelectDir,
	sync,
	onSyncChange,
	note,
}: {
	fs: FsBackend;
	root: string;
	onRoot: (p: string) => void;
	onOpen: (e: FsEntry) => void;
	/** 끌어 놓기 — 다른 트리에서 오면 주고받기, 같은 트리면 옮기기 */
	onDrop?: (src: DragEntry, destDir: string) => void;
	/** 반대편으로 보내기(올리기·받기) */
	onSend?: (e: FsEntry) => void;
	sendLabel?: string;
	/** 터미널에서 이 폴더로 이동 */
	onCd?: (dir: string) => void;
	/** 실시간 보기 */
	onTail?: (e: FsEntry) => void;
	/** 비교 — 첫 번째는 고르기, 두 번째는 비교 */
	onCompare?: (e: FsEntry) => void;
	compareLabel?: (e: FsEntry) => string;
	/** 폴더째 받기(.tar.gz) */
	onArchive?: (e: FsEntry) => void;
	/** 다른 서버로 보내기(중계) */
	onRelay?: (e: FsEntry) => void;
	selected?: string;
	/** 올리기 — 내 PC 에서 파일(또는 폴더) 고르기 */
	onUploadPick?: (dir: string, folder: boolean) => void;
	/** 받을 곳 골라 받기 */
	onDownloadTo?: (e: FsEntry) => void;
	/** 이 폴더에서 새 터미널 */
	onNewTerminal?: (dir: string) => void;
	/** 이 폴더까지 펼쳐 고르기(터미널 cd) — 뿌리는 그대로 */
	reveal?: { path: string; nonce: number } | null;
	/** 사용자가 폴더를 골랐다(같이면 터미널이 따라간다) */
	onSelectDir?: (dir: string) => void;
	/** 터미널과 동기화 — 같이 / 따로 */
	sync?: "together" | "apart";
	onSyncChange?: (m: "together" | "apart") => void;
	/** 머리 아래 잠깐 보이는 알림 */
	note?: string | null;
}) {
	const [nodes, setNodes] = useState<Record<string, Node>>({});
	const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
	const [rootInput, setRootInput] = useState(root);
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const [dropOn, setDropOn] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	const openRef = useRef(open);
	openRef.current = open;
	/** 키보드 커서(경로) */
	const [cur, setCur] = useState<string | null>(null);
	/** 큰 폴더에서 그린 개수 */
	const [shown, setShown] = useState<Record<string, number>>({});
	/** 탐색기에서 끌어 놓아 올리는 중 */
	const [upload, setUpload] = useState<{ done: number; total: number; name: string } | null>(null);
	const conflict = useConflictAsk();
	const bodyRef = useRef<HTMLDivElement>(null);

	// 폴더 이동 기록 — 뒤로·앞으로(단추·마우스 옆 단추·Alt+←/→). 터미널 따라가기로 바뀐 것도 기록한다
	const hist = useRef({ back: [] as string[], fwd: [] as string[], prev: root, nav: false });
	const [, bump] = useState(0);
	useEffect(() => {
		const h = hist.current;
		if (root === h.prev) return;
		if (!h.nav) {
			h.back.push(h.prev);
			if (h.back.length > 100) h.back.shift();
			h.fwd = [];
		}
		h.nav = false;
		h.prev = root;
		bump((n) => n + 1);
	}, [root]);
	const goBack = () => {
		const h = hist.current;
		const p = h.back.pop();
		if (p == null) return;
		h.fwd.push(h.prev);
		h.nav = true;
		onRoot(p);
	};
	const goForward = () => {
		const h = hist.current;
		const p = h.fwd.pop();
		if (p == null) return;
		h.back.push(h.prev);
		h.nav = true;
		onRoot(p);
	};

	const load = useCallback(
		(path: string) =>
			fs
				.list(path)
				.then((entries) => setNodes((n) => ({ ...n, [path]: { entries } })))
				.catch((e) => setNodes((n) => ({ ...n, [path]: { error: asSshError(e).message } }))),
		[fs],
	);

	useEffect(() => {
		setRootInput(root);
		setOpen(new Set([root]));
		setNodes({});
		load(root);
	}, [root, load]);

	// 터미널 cd·처음 시작 폴더 — 뿌리에서 그 폴더까지 차례로 펼치고 고른다(뿌리 밖이면 뿌리를 / 로)
	// biome-ignore lint/correctness/useExhaustiveDependencies: reveal 이 바뀔 때만
	useEffect(() => {
		if (!reveal) return;
		const target = reveal.path.replace(/\/+$/, "") || "/";
		const base = root.replace(/\/+$/, "");
		const inside = target === root || target.startsWith(`${base}/`) || root === "/";
		if (!inside) {
			onRoot(/^[A-Za-z]:/.test(target) ? `${target.slice(0, 2)}/` : "/");
			return; // 뿌리가 바뀐 뒤 같은 reveal 로 다시 온다
		}
		let gone = false;
		const chain: string[] = [];
		let p = target;
		while (p && p !== root && p.length > base.length) {
			chain.unshift(p);
			const up = parentDir(p);
			if (up === p) break;
			p = up;
		}
		void (async () => {
			// 그 폴더 자신도 펼쳐 안이 보이게(이전 판과 같이). 읽은 목록에서 다음 칸이 몇 번째인지 알아 그만큼만 그린다
			const listed = new Map<string, FsEntry[]>();
			for (const dir of [root, ...chain]) {
				if (gone) return;
				const have = nodes[dir]?.entries;
				if (have) listed.set(dir, have);
				else {
					try {
						const entries = await fs.list(dir);
						listed.set(dir, entries);
						setNodes((n) => ({ ...n, [dir]: { entries } }));
					} catch (e) {
						setNodes((n) => ({ ...n, [dir]: { error: asSshError(e).message } }));
					}
				}
			}
			if (gone) return;
			setOpen((s) => new Set([...s, root, ...chain]));
			// 조상 폴더는 고른 폴더가 보일 만큼만 더 그린다(모두 펼치지 않는다 — 큰 폴더가 한꺼번에 그려지지 않게)
			setShown((s) => {
				const n = { ...s };
				[root, ...chain.slice(0, -1)].forEach((d, i) => {
					const at = listed.get(d)?.findIndex((x) => x.path === chain[i]) ?? -1;
					if (at >= 0) n[d] = Math.max(n[d] ?? PAGE, at + 20);
				});
				return n;
			});
			setCur(target);
			// 따라간 폴더를 위쪽으로 올려 그 안(펼친 내용)이 아래에 보이게 — "nearest" 는 아래 끝에 붙여 안이 가려졌다
			revealScroll(bodyRef.current, target, () => gone);
		})();
		return () => {
			gone = true;
		};
	}, [reveal, root]);

	// 전송·조작 뒤 그 폴더를 다시 읽는다(열려 있을 때만)
	useEffect(() => {
		const on = (ev: Event) => {
			const d = (ev as CustomEvent<{ side: string; dir: string; conn?: number }>).detail;
			if (d.side !== fs.side || (fs.side === "remote" && d.conn !== fs.conn)) return;
			if (openRef.current.has(d.dir)) load(d.dir);
		};
		window.addEventListener("rb-fs-changed", on);
		return () => window.removeEventListener("rb-fs-changed", on);
	}, [fs, load]);

	const toggle = (p: string) => {
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(p)) n.delete(p);
			else {
				n.add(p);
				load(p);
			}
			return n;
		});
	};

	const refresh = () => {
		for (const p of open) load(p);
	};

	const flash = (t: string) => {
		setMsg(t);
		window.setTimeout(() => setMsg(null), 4000);
	};

	const act = async (f: () => Promise<unknown>, dir: string) => {
		try {
			await f();
			notifyFsChanged(fs.side, dir, fs.conn);
			if (!open.has(dir)) toggle(dir);
		} catch (e) {
			flash(asSshError(e).message);
		}
	};

	const renameEntry = async (e: FsEntry) => {
		const name = await askText({ title: "이름 바꾸기", value: e.name, okLabel: "바꾸기" });
		if (name && name !== e.name) void act(() => fs.rename(e.path, joinPath(parentDir(e.path), name)), parentDir(e.path));
	};
	const removeEntry = async (e: FsEntry) => {
		if (PROTECTED.test(e.path)) {
			flash(`${e.path} 는 지울 수 없게 막아 두었습니다`);
			return;
		}
		const what = e.kind === "dir" ? `폴더 ${e.name} 와 안의 모든 것` : e.name;
		const ok =
			fs.side === "local"
				? confirm(`${what}을(를) 휴지통으로 보낼까요?`)
				: (await askText({ title: "서버에서 지우기", message: `${what}을(를) 지웁니다. 되살릴 수 없습니다.\n지우려면 이름을 그대로 치세요: ${e.name}`, mustEqual: e.name, danger: true, okLabel: "지우기" })) === e.name;
		if (ok) void act(() => fs.remove(e.path), parentDir(e.path));
	};
	const copyEntry = async (e: FsEntry) => {
		if (!fs.copy) return;
		const dot = e.kind === "file" ? e.name.lastIndexOf(".") : -1;
		const def = dot > 0 ? `${e.name.slice(0, dot)} 복사본${e.name.slice(dot)}` : `${e.name} 복사본`;
		const to = await askText({ title: "복사", message: "복사해 둘 경로(같은 폴더면 이름만)", value: def, okLabel: "복사" });
		if (!to) return;
		const dest = to.includes("/") ? to : joinPath(parentDir(e.path), to);
		void act(() => fs.copy?.(e.path, dest) ?? Promise.resolve(), parentDir(dest));
	};
	const moveEntry = async (e: FsEntry) => {
		const to = await askText({ title: "옮기기", message: `${e.name} 을(를) 옮길 폴더`, value: parentDir(e.path), okLabel: "옮기기" });
		if (!to || to === parentDir(e.path)) return;
		void act(async () => {
			await fs.rename(e.path, joinPath(to, e.name));
			notifyFsChanged(fs.side, parentDir(e.path), fs.conn);
		}, to);
	};

	/** 탐색기에서 끌어 놓은 파일·폴더 올리기(원격 트리) — 폴더는 안까지 만들고, 파일은 조각으로 보낸다 */
	const uploadDropped = async (items: DataTransferItemList, dir: string) => {
		if (fs.side !== "remote" || fs.conn == null) return;
		type Job = { file: File; dest: string };
		const jobs: Job[] = [];
		const dirs: string[] = [];
		const readAll = (r: FileSystemDirectoryReader) =>
			new Promise<FileSystemEntry[]>((res) => {
				const out: FileSystemEntry[] = [];
				const next = () =>
					r.readEntries((batch) => {
						if (!batch.length) return res(out);
						out.push(...batch);
						next();
					}, () => res(out));
				next();
			});
		const walkEntry = async (en: FileSystemEntry, into: string) => {
			if (en.isFile) {
				const file = await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej));
				jobs.push({ file, dest: joinPath(into, en.name) });
			} else if (en.isDirectory) {
				const d = joinPath(into, en.name);
				dirs.push(d);
				for (const c of await readAll((en as FileSystemDirectoryEntry).createReader())) await walkEntry(c, d);
			}
		};
		const entries = [...items].map((it) => it.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
		for (const en of entries) await walkEntry(en, dir);
		if (!jobs.length && !dirs.length) return;
		// 펼친 적 없는 폴더는 기억한 목록이 없다 — 늘 새로 읽어 같은 이름을 확인한다(묻지 않고 덮어쓰지 않게)
		let fresh: FsEntry[] | null = null;
		try {
			fresh = await fs.list(dir);
		} catch {
			fresh = nodes[dir]?.entries ?? null;
		}
		const existing = new Set((fresh ?? []).map((x) => x.name));
		const clash = entries.filter((en) => existing.has(en.name)).map((en) => en.name);
		if (clash.length) {
			// 덮어쓰기·건너뛰기·이름 바꿔 올리기(name (1).ext) — 끌어 놓은 맨 위 항목 기준
			const choice = await conflict.ask(clash, dir);
			if (!choice) return;
			if (choice !== "overwrite") {
				const taken = new Set(existing);
				for (const name of clash) {
					const from = joinPath(dir, name);
					const outside = (p: string) => p !== from && !p.startsWith(`${from}/`);
					if (choice === "skip") {
						for (let i = jobs.length - 1; i >= 0; i--) if (!outside(jobs[i].dest)) jobs.splice(i, 1);
						for (let i = dirs.length - 1; i >= 0; i--) if (!outside(dirs[i])) dirs.splice(i, 1);
						continue;
					}
					const fresh = freeName(name, taken);
					taken.add(fresh);
					const to = joinPath(dir, fresh);
					const move = (p: string) => (outside(p) ? p : to + p.slice(from.length));
					for (const j of jobs) j.dest = move(j.dest);
					for (let i = 0; i < dirs.length; i++) dirs[i] = move(dirs[i]);
				}
				if (!jobs.length && !dirs.length) return;
			}
		}
		const total = jobs.reduce((a, j) => a + j.file.size, 0);
		let done = 0;
		try {
			for (const d of dirs) await fs.mkdir(d).catch(() => undefined);
			for (const j of jobs) {
				setUpload({ done, total, name: j.file.name });
				let off = 0;
				do {
					const part = new Uint8Array(await j.file.slice(off, off + CHUNK).arrayBuffer());
					await invoke("sftp_put_chunk", part, { headers: { "x-conn": String(fs.conn), "x-path": encodeURIComponent(j.dest), "x-offset": String(off) } });
					off += part.length;
					done += part.length;
					setUpload({ done, total, name: j.file.name });
				} while (off < j.file.size);
			}
			flash(`올렸습니다 — 파일 ${jobs.length}개${dirs.length ? ` · 폴더 ${dirs.length}개` : ""}`);
		} catch (e) {
			flash(asSshError(e).message);
		} finally {
			setUpload(null);
			notifyFsChanged(fs.side, dir, fs.conn);
			if (!open.has(dir)) toggle(dir);
		}
	};

	const menuFor = (e: FsEntry | null, dir: string): MenuItem[] => {
		const items: MenuItem[] = [
			{
				label: "새 파일…",
				run: async () => {
					const name = await askText({ title: "새 파일", placeholder: "이름", okLabel: "만들기" });
					if (name) void act(() => fs.touch(joinPath(dir, name)), dir);
				},
			},
			{
				label: "새 폴더…",
				run: async () => {
					const name = await askText({ title: "새 폴더", placeholder: "이름", okLabel: "만들기" });
					if (name) void act(() => fs.mkdir(joinPath(dir, name)), dir);
				},
			},
		];
		if (e) {
			items.push({ sep: true });
			if (e.kind !== "dir") items.push({ label: "열기", run: () => onOpen(e) });
			if (e.kind !== "dir" && onTail) items.push({ label: "실시간 보기(tail -F)  L", run: () => onTail(e) });
			if (e.kind !== "dir" && onCompare) items.push({ label: compareLabel?.(e) ?? "비교 대상으로 고르기", run: () => onCompare(e) });
			if (e.kind === "dir" && onArchive) items.push({ label: "폴더째 받기(.tar.gz)…", run: () => onArchive(e) });
			if (onRelay) items.push({ label: "다른 서버로 보내기…", run: () => onRelay(e) });
			if (onSend) items.push({ label: sendLabel ?? "보내기", run: () => onSend(e) });
			if (onDownloadTo) items.push({ label: "다른 곳에 받기…", run: () => onDownloadTo(e) });
			if (e.kind === "dir" && onCd) items.push({ label: "터미널에서 이 폴더로", run: () => onCd(e.path) });
			if (onNewTerminal) items.push({ label: "여기서 새 터미널  T", run: () => onNewTerminal(e.kind === "dir" ? e.path : parentDir(e.path)) });
			if (e.kind === "dir") items.push({ label: "여기를 맨 위로", run: () => onRoot(e.path) });
			items.push(
				{ sep: true },
				{ label: "이름 바꾸기…  F2", run: () => renameEntry(e) },
				...(fs.copy ? [{ label: "복사…", run: () => copyEntry(e) }] : []),
				{ label: "옮기기…", run: () => moveEntry(e) },
				{ label: "경로 복사", run: () => void navigator.clipboard.writeText(e.path) },
				{ label: "이름 복사", run: () => void navigator.clipboard.writeText(e.name) },
				{ sep: true },
				{ label: fs.side === "local" ? "휴지통으로  Del" : "지우기…  Del", danger: true, disabled: PROTECTED.test(e.path), run: () => removeEntry(e) },
			);
		} else {
			if (onUploadPick) items.push({ sep: true }, { label: "파일 올리기…", run: () => onUploadPick(dir, false) }, { label: "폴더 올리기…", run: () => onUploadPick(dir, true) });
			if (onNewTerminal) items.push({ label: "여기서 새 터미널", run: () => onNewTerminal(dir) });
			items.push({ sep: true }, { label: "새로 읽기", run: refresh }, { label: "경로 복사", run: () => void navigator.clipboard.writeText(dir) });
		}
		return items;
	};

	const dropProps = (dir: string) => ({
		onDragOver: (ev: React.DragEvent) => {
			const osFiles = ev.dataTransfer.types.includes("Files") && fs.side === "remote" && fs.conn != null && !fs.container;
			if (osFiles) {
				ev.preventDefault();
				ev.stopPropagation();
				ev.dataTransfer.dropEffect = "copy";
				setDropOn(dir);
				return;
			}
			if (!onDrop || !ev.dataTransfer.types.includes(DRAG_MIME)) return;
			ev.preventDefault();
			ev.stopPropagation();
			ev.dataTransfer.dropEffect = "copy";
			setDropOn(dir);
		},
		onDragLeave: () => setDropOn((d) => (d === dir ? null : d)),
		onDrop: (ev: React.DragEvent) => {
			const raw = ev.dataTransfer.getData(DRAG_MIME);
			setDropOn(null);
			if (!raw && ev.dataTransfer.files.length && fs.side === "remote" && !fs.container) {
				ev.preventDefault();
				ev.stopPropagation();
				void uploadDropped(ev.dataTransfer.items, dir);
				return;
			}
			if (!raw || !onDrop) return;
			ev.preventDefault();
			ev.stopPropagation();
			onDrop(JSON.parse(raw) as DragEntry, dir);
		},
	});

	const rows: ReactElement[] = [];
	const walk = (path: string, depth: number) => {
		const node = nodes[path];
		const pad = 12 + depth * 14;
		if (node?.error) {
			rows.push(
				<div key={`${path}#err`} className="tree-msg err" style={{ paddingLeft: pad }}>
					{node.error}
				</div>,
			);
			return;
		}
		if (!node?.entries) {
			rows.push(
				<div key={`${path}#loading`} className="tree-msg" style={{ paddingLeft: pad }}>
					읽는 중…
				</div>,
			);
			return;
		}
		if (!node.entries.length) {
			rows.push(
				<div key={`${path}#empty`} className="tree-msg" style={{ paddingLeft: pad }}>
					비어 있음
				</div>,
			);
		}
		const limit = shown[path] ?? PAGE;
		for (const e of node.entries.slice(0, limit)) {
			flat.push(e);
			const isOpen = open.has(e.path);
			const dir = e.kind === "dir" ? e.path : path;
			rows.push(
				<button
					key={e.path}
					type="button"
					className="tree-row"
					data-drop={dropOn === e.path && e.kind === "dir" ? "on" : undefined}
					aria-current={selected === e.path}
					data-cur={cur === e.path ? "on" : undefined}
					data-path={e.path}
					style={{ paddingLeft: 6 + depth * 14 }}
					title={`${e.path}${e.target ? ` → ${e.target}` : ""}${e.kind === "file" ? ` · ${fmtSize(e.size)}` : ""}`}
					draggable={!fs.container}
					onDragStart={(ev) => {
						const d: DragEntry = { side: fs.side, conn: fs.conn, path: e.path, name: e.name, kind: e.kind };
						ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(d));
						ev.dataTransfer.effectAllowed = "copyMove";
					}}
					onClick={() => {
						setCur(e.path);
						if (e.kind === "dir") {
							toggle(e.path);
							onSelectDir?.(e.path);
						} else onOpen(e);
					}}
					onDoubleClick={() => e.kind === "dir" && (onCd ? onCd(e.path) : onRoot(e.path))}
					onContextMenu={(ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						setMenu({ x: ev.clientX, y: ev.clientY, items: menuFor(e, dir) });
					}}
					{...(e.kind === "dir" ? dropProps(e.path) : {})}
				>
					<ChevronRight size={12} className="chev" style={{ visibility: e.kind === "dir" ? "visible" : "hidden", transform: isOpen ? "rotate(90deg)" : undefined }} />
					{icon(e, isOpen)}
					<span className={e.name.startsWith(".") ? "dim" : undefined}>{e.name}</span>
					{e.target && <span className="link-to">→ {e.target}</span>}
				</button>,
			);
			if (e.kind === "dir" && isOpen) walk(e.path, depth + 1);
		}
		if (node.entries.length > limit) {
			rows.push(
				<button key={`${path}#more`} type="button" className="tree-msg tree-more" style={{ paddingLeft: pad }} onClick={() => setShown((s) => ({ ...s, [path]: limit + PAGE }))}>
					{(node.entries.length - limit).toLocaleString()}개 더 보기
				</button>,
			);
		}
	};
	const flat: FsEntry[] = [];
	walk(root, 0);

	const atTop = root === "/" || /^[A-Za-z]:\/?$/.test(root);
	return (
		<div
			className="tree"
			// 마우스 옆 단추: 3 = 뒤로, 4 = 앞으로
			onMouseUp={(ev) => {
				if (ev.button === 3 || ev.button === 4) {
					ev.preventDefault();
					if (ev.button === 3) goBack();
					else goForward();
				}
			}}
			onKeyDown={(ev) => {
				const typing = (ev.target as HTMLElement).closest("input, textarea");
				if (ev.altKey && ev.key === "ArrowLeft") {
					ev.preventDefault();
					goBack();
				} else if (ev.altKey && ev.key === "ArrowRight") {
					ev.preventDefault();
					goForward();
				} else if ((ev.key === "Backspace" || (ev.altKey && ev.key === "ArrowUp")) && !typing && !atTop) {
					ev.preventDefault();
					onRoot(parentDir(root));
				}
			}}
		>
			{/* 머리 1줄: 이동 단추 · 터미널 연동 · 새로 만들기 / 2줄: 경로(칸이 좁아도 경로가 다 보이게 한 줄을 통째로) */}
			<div className="tree-bar">
				<button type="button" className="btn ghost icon" title="뒤로 (Alt+← · 마우스 뒤로 단추)" onClick={goBack} disabled={!hist.current.back.length}>
					<ArrowLeft size={14} />
				</button>
				<button type="button" className="btn ghost icon" title="앞으로 (Alt+→ · 마우스 앞으로 단추)" onClick={goForward} disabled={!hist.current.fwd.length}>
					<ArrowRight size={14} />
				</button>
				<button type="button" className="btn ghost icon" title="위 폴더 (Backspace · Alt+↑)" onClick={() => onRoot(parentDir(root))} disabled={atTop}>
					<ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
				</button>
				<button type="button" className="btn ghost icon" title="홈 폴더" onClick={() => onRoot(fs.home)}>
					<House size={14} />
				</button>
				<button type="button" className="btn ghost icon" title="새로 읽기" onClick={refresh}>
					<RefreshCw size={13} />
				</button>
				<span style={{ flex: 1 }} />
				{onSyncChange && sync && (
					<button
						type="button"
						className={`btn ghost tree-sync${sync === "together" ? " on" : ""}`}
						aria-pressed={sync === "together"}
						title={
							sync === "together"
								? "터미널 연동 켜짐 — 터미널에서 cd 하면 트리가 따라가고, 트리에서 고른 폴더로 터미널이 cd 합니다. 눌러서 끄기"
								: "터미널 연동 꺼짐 — 트리와 터미널이 각자 움직입니다. 눌러서 켜기"
						}
						onClick={() => onSyncChange(sync === "together" ? "apart" : "together")}
					>
						{sync === "together" ? <Link2 size={13} /> : <Unlink size={13} />}
						<span className="tree-sync-label">연동</span>
					</button>
				)}
				<button
					type="button"
					className="btn ghost icon"
					title="새 파일·폴더, 올리기"
					onClick={(ev) => {
						const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
						setMenu({ x: r.left, y: r.bottom + 4, items: menuFor(null, cur && nodes[cur] ? cur : root) });
					}}
				>
					<Plus size={14} />
				</button>
			</div>
			{note && <div className="tree-note">{note}</div>}
			<div className="tree-head">
				<form
					onSubmit={(ev) => {
						ev.preventDefault();
						onRoot(rootInput.trim() || "/");
					}}
					style={{ flex: 1, minWidth: 0 }}
				>
					<input className="path-input" value={rootInput} onChange={(e) => setRootInput(e.target.value)} spellCheck={false} title="경로를 치고 Enter" aria-label="경로" />
				</form>
			</div>
			{upload && (
				<div className="tree-upload">
					올리는 중 {Math.round((upload.done / Math.max(1, upload.total)) * 100)}% · {upload.name}
					<div className="mon-bar">
						<div style={{ width: `${(upload.done / Math.max(1, upload.total)) * 100}%` }} />
					</div>
				</div>
			)}
			<div
				ref={bodyRef}
				tabIndex={0}
				onKeyDown={(ev) => {
					if ((ev.target as HTMLElement).closest("input, textarea") || ev.altKey) return;
					const i = flat.findIndex((x) => x.path === cur);
					const at = i >= 0 ? flat[i] : null;
					const go = (j: number) => {
						const t = flat[Math.max(0, Math.min(flat.length - 1, j))];
						if (!t) return;
						setCur(t.path);
						bodyRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(t.path)}"]`)?.scrollIntoView({ block: "nearest" });
					};
					const k = ev.key;
					if (k === "ArrowDown") go(i + 1);
					else if (k === "ArrowUp") go(i < 0 ? 0 : i - 1);
					else if (k === "Home") go(0);
					else if (k === "End") go(flat.length - 1);
					else if (k === "ArrowRight" && at?.kind === "dir") {
						if (!open.has(at.path)) toggle(at.path);
						else go(i + 1);
					} else if (k === "ArrowLeft" && at) {
						if (at.kind === "dir" && open.has(at.path)) toggle(at.path);
						else go(flat.findIndex((x) => x.path === parentDir(at.path)));
					} else if (k === "Enter" && at) {
						if (at.kind === "dir") toggle(at.path);
						else onOpen(at);
					} else if (k === "F2" && at) renameEntry(at);
					else if (k === "Delete" && at) removeEntry(at);
					// T = 여기서 새 터미널(파일이면 그 폴더), L = 실시간 보기(tail -F) — Orbit 트리와 같은 키
					else if ((k === "t" || k === "T") && !ev.ctrlKey && !ev.altKey && !ev.metaKey && onNewTerminal)
						onNewTerminal(at ? (at.kind === "dir" ? at.path : parentDir(at.path)) : root);
					else if ((k === "l" || k === "L") && !ev.ctrlKey && !ev.altKey && !ev.metaKey && at && at.kind !== "dir" && onTail) onTail(at);
					else return;
					ev.preventDefault();
					ev.stopPropagation();
				}}
				className="tree-body"
				data-drop={dropOn === root ? "on" : undefined}
				onContextMenu={(ev) => {
					ev.preventDefault();
					setMenu({ x: ev.clientX, y: ev.clientY, items: menuFor(null, root) });
				}}
				{...dropProps(root)}
			>
				{rows}
			</div>
			{msg && <div className="tree-toast">{msg}</div>}
			{menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
			{conflict.element}
		</div>
	);
});
