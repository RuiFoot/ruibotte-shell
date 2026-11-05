import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Maximize, Minus, Plus, Scan, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ArchiveListing, archiveFormat, listArchive, NotArchive } from "../lib/archive";
import type { FsBackend } from "../lib/ipc";
import { DataGrid } from "./DataGrid";
import { Select } from "./Select";

/** 확장자로 보기 방식 고르기 */
export type PreviewKind = "image" | "pdf" | "hex" | "sheet" | "docx" | "archive";
export function previewKind(path: string): PreviewKind | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"].includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (["xlsx", "xlsm", "xls", "ods", "xlsb"].includes(ext)) return "sheet";
	if (ext === "docx") return "docx";
	if (archiveFormat(path)) return "archive";
	if (["zip", "gz", "tgz", "jar", "war", "class", "so", "dll", "exe", "bin", "o", "a", "iso", "img", "db", "sqlite", "xz", "bz2", "7z"].includes(ext)) return "hex";
	return null;
}

/** 편집기 옆에 켤 수 있는 보기 — 마크다운·CSV/TSV 표 */
export function altView(path: string): "markdown" | "csv" | "tsv" | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "csv") return "csv";
	if (ext === "tsv") return "tsv";
	return null;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	avif: "image/avif",
	pdf: "application/pdf",
};

/** offset: 이 자리부터(음수면 끝에서 그만큼 앞) */
async function readBytes(fs: FsBackend, path: string, max?: number, offset?: number): Promise<Uint8Array<ArrayBuffer>> {
	const buf =
		fs.side === "remote"
			? await invoke<ArrayBuffer>("sftp_read_bytes", { conn: fs.conn, path, max, offset })
			: await invoke<ArrayBuffer>("local_read_bytes", { path, max, offset });
	return new Uint8Array(buf);
}

/** 이미지·PDF·헥스 미리보기 */
export function BinaryPreview({ fs, path, kind }: { fs: FsBackend; path: string; kind: PreviewKind }) {
	if (kind === "sheet") return <SheetPreview fs={fs} path={path} />;
	if (kind === "docx") return <DocxPreview fs={fs} path={path} />;
	if (kind === "image") return <ImagePreview fs={fs} path={path} />;
	if (kind === "archive") return <ArchivePreview fs={fs} path={path} />;
	return <BlobPreview fs={fs} path={path} kind={kind} />;
}

const two = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date | null) => (d && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` : "");

/** 압축 파일 목록(zip·jar·tar·tar.gz) — 풀지 않고 이름·크기·날짜만. 표에서 거르고 정렬한다 */
function ArchivePreview({ fs, path }: { fs: FsBackend; path: string }) {
	const [list, setList] = useState<ArchiveListing | null>(null);
	const [info, setInfo] = useState("목록 읽는 중…");
	const [notArchive, setNotArchive] = useState(false);
	useEffect(() => {
		const signal = { aborted: false };
		const t0 = performance.now();
		setList(null);
		setNotArchive(false);
		listArchive(path, (offset, max) => readBytes(fs, path, max, offset), signal)
			.then((l) => {
				if (signal.aborted) return;
				setList(l);
				setInfo(`${l.format} · ${l.entries.length.toLocaleString()}개${l.truncated ? " (앞부분만)" : ""} · 풀지 않고 목록만 · ${Math.round(performance.now() - t0)} ms`);
			})
			.catch((e) => {
				if (signal.aborted) return;
				if (e instanceof NotArchive) setNotArchive(true);
				setInfo(`목록을 읽지 못했습니다: ${String(e?.message ?? e)}`);
			});
		return () => {
			signal.aborted = true;
		};
	}, [fs, path]);
	const rows = useMemo(
		() => (list ? [["이름", "크기", "바뀐 날짜", "종류"], ...list.entries.map((e) => [e.link ? `${e.name} → ${e.link}` : e.name, e.dir ? "" : e.size.toLocaleString(), fmtDate(e.mtime), e.dir ? "폴더" : e.link ? "링크" : "파일"])] : []),
		[list],
	);
	// gzip 이지만 tar 가 아닌 것 등 — 헥스로
	if (notArchive) return <BlobPreview fs={fs} path={path} kind="hex" />;
	if (!list) return <div className="panel-fill dock-watermark"><p>{info}</p></div>;
	return <GridTable rows={rows} extra={<span className="arc-info" title={info}>{info}</span>} />;
}

function BlobPreview({ fs, path, kind }: { fs: FsBackend; path: string; kind: "pdf" | "hex" }) {
	const [url, setUrl] = useState<string | null>(null);
	const [hex, setHex] = useState<string>("");
	const [info, setInfo] = useState("읽는 중…");
	useEffect(() => {
		let gone = false;
		let made: string | null = null;
		const t0 = performance.now();
		readBytes(fs, path, kind === "hex" ? 64 * 1024 : undefined)
			.then((b) => {
				if (gone) return;
				if (kind === "hex") {
					const lines: string[] = [];
					for (let off = 0; off < b.length; off += 16) {
						const row = b.subarray(off, off + 16);
						const h = Array.from(row, (x) => x.toString(16).padStart(2, "0")).join(" ");
						const a = Array.from(row, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
						lines.push(`${off.toString(16).padStart(8, "0")}  ${h.padEnd(47)}  ${a}`);
					}
					setHex(lines.join("\n"));
					setInfo(`앞 ${b.length.toLocaleString()}바이트 · ${Math.round(performance.now() - t0)} ms`);
				} else {
					const ext = path.split(".").pop()?.toLowerCase() ?? "";
					made = URL.createObjectURL(new Blob([b], { type: MIME[ext] ?? "application/octet-stream" }));
					setUrl(made);
					setInfo(`${(b.length / 1024).toFixed(0)} KB · ${Math.round(performance.now() - t0)} ms`);
				}
			})
			.catch((e) => !gone && setInfo(String(e?.message ?? e)));
		return () => {
			gone = true;
			if (made) URL.revokeObjectURL(made);
		};
	}, [fs, path, kind]);
	return (
		<div className="panel-fill">
			<div className="preview-body">
				{kind === "pdf" && url && <iframe src={url} title={path} className="preview-pdf" />}
				{kind === "hex" && <pre className="preview-hex selectable">{hex}</pre>}
			</div>
			<div className="statusbar">
				<span>{info}</span>
			</div>
		</div>
	);
}

/** 마크다운 미리보기(위험한 HTML 은 지움) */
export function MarkdownView({ text }: { text: string }) {
	const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string), [text]);
	// biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 로 정화한 HTML
	return <div className="md-view selectable" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** CSV·TSV 를 표로 — 따옴표 안 구분자·줄바꿈 존중 */
export function parseDelimited(text: string, sep: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') q = false;
			else cell += c;
		} else if (c === '"' && cell === "") q = true;
		else if (c === sep) {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

/** 구분자 짐작 — 앞 20줄에서 가장 고르게 나오는 것(, ; 탭 |) */
export function guessSep(text: string, fallback: string): string {
	const lines = text.split(/\r?\n/, 20).filter(Boolean);
	let best = fallback;
	let bestScore = 0;
	for (const s of [",", "\t", ";", "|"]) {
		const counts = lines.map((l) => l.split(s).length - 1);
		const min = Math.min(...counts);
		const same = counts.filter((c) => c === counts[0]).length;
		const score = min > 0 ? same * 10 + min : 0;
		if (score > bestScore) {
			best = s;
			bestScore = score;
		}
	}
	return best;
}

export function TableView({ text, sep }: { text: string; sep: string }) {
	const [delim, setDelim] = useState(() => guessSep(text, sep));
	const rows = useMemo(() => parseDelimited(text, delim), [text, delim]);
	return <GridTable rows={rows} extra={
		<Select size="sm" value={delim} onChange={setDelim} title="구분자" options={[{ value: ",", label: "쉼표" }, { value: "\t", label: "탭" }, { value: ";", label: "세미콜론" }, { value: "|", label: "세로줄" }]} />
	} />;
}

/** 표(CSV·엑셀 공용) — 첫 줄 머리 켜고 끄기, 머리 눌러 정렬, 거르기 */
export function GridTable({ rows, extra }: { rows: string[][]; extra?: React.ReactNode }) {
	const [header, setHeader] = useState(true);
	const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
	const [filter, setFilter] = useState("");
	const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const head = header ? (rows[0] ?? []) : [];
	const body0 = header ? rows.slice(1) : rows;
	const numeric = useMemo(
		() => Array.from({ length: width }, (_, i) => body0.slice(0, 80).every((r) => r[i] === undefined || r[i] === "" || /^-?[\d,]+(\.\d+)?$/.test(r[i]))),
		[body0, width],
	);
	const body = useMemo(() => {
		const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
		let out = words.length ? body0.filter((r) => words.every((w) => r.join("\u0001").toLowerCase().includes(w))) : body0;
		if (sort) {
			const c = sort.col;
			const num = numeric[c];
			out = [...out].sort((a, b) => {
				const x = a[c] ?? "";
				const y = b[c] ?? "";
				const o = num ? Number(x.replace(/,/g, "")) - Number(y.replace(/,/g, "")) : x.localeCompare(y, "ko");
				return sort.desc ? -o : o;
			});
		}
		return out;
	}, [body0, filter, sort, numeric]);
	const cols = Array.from({ length: width }, (_, i) => ({ name: head[i] || colName(i), kind: numeric[i] ? "numeric" : "text" }));
	const fetchRows = useMemo(() => (from: number, to: number) => Promise.resolve(body.slice(from, to).map((r) => cols.map((_, i) => r[i] ?? null))), [body, cols]);
	return (
		<div className="panel-fill">
			<DataGrid
				columns={cols}
				rowCount={body.length}
				fetchRows={fetchRows}
				resetKey={`${rows.length}:${header}:${filter}:${sort?.col}:${sort?.desc}`}
				sort={sort}
				onSort={(c) => setSort((s) => (s?.col !== c ? { col: c, desc: false } : !s.desc ? { col: c, desc: true } : null))}
			/>
			<div className="statusbar">
				<span>
					{body.length.toLocaleString()}행{filter ? ` / ${body0.length.toLocaleString()}` : ""} · {width}열
				</span>
				<span style={{ marginLeft: "auto" }} />
				{extra}
				<label className="check" style={{ margin: 0 }}>
					<input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> 첫 줄은 머리
				</label>
				<label className="res-filter">
					<Search size={11} />
					<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="거르기" spellCheck={false} />
				</label>
			</div>
		</div>
	);
}

/** 엑셀식 열 이름 A, B … Z, AA … */
function colName(i: number) {
	let s = "";
	let n = i + 1;
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/** 엑셀(xlsx·xls·ods) — 시트 탭, 값은 보이는 글(서식 적용) */
function SheetPreview({ fs, path }: { fs: FsBackend; path: string }) {
	const [book, setBook] = useState<{ names: string[]; sheets: Record<string, string[][]> } | null>(null);
	const [cur, setCur] = useState(0);
	const [info, setInfo] = useState("읽는 중…");
	useEffect(() => {
		let gone = false;
		const t0 = performance.now();
		void (async () => {
			try {
				const b = await readBytes(fs, path, 60 * 1024 * 1024);
				const XLSX = await import("xlsx");
				const wb = XLSX.read(b, { type: "array", cellDates: true, dense: true });
				const sheets: Record<string, string[][]> = {};
				for (const n of wb.SheetNames) sheets[n] = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: "", blankrows: false });
				if (gone) return;
				setBook({ names: wb.SheetNames, sheets });
				setInfo(`시트 ${wb.SheetNames.length}개 · ${(b.length / 1024).toFixed(0)} KB · ${Math.round(performance.now() - t0)} ms`);
			} catch (e) {
				if (!gone) setInfo(`읽지 못했습니다: ${String((e as Error)?.message ?? e)}`);
			}
		})();
		return () => {
			gone = true;
		};
	}, [fs, path]);
	if (!book) return <div className="panel-fill dock-watermark"><p>{info}</p></div>;
	const name = book.names[cur] ?? book.names[0];
	return (
		<div className="panel-fill">
			<div className="sheet-tabs">
				{book.names.map((n, i) => (
					<button key={n} type="button" aria-pressed={i === cur} onClick={() => setCur(i)}>
						{n}
					</button>
				))}
				<span className="sheet-info">{info}</span>
			</div>
			<GridTable key={name} rows={book.sheets[name] ?? []} />
		</div>
	);
}

/** 워드(docx) — 글·표·그림을 HTML 로(서식은 대략) */
function DocxPreview({ fs, path }: { fs: FsBackend; path: string }) {
	const [html, setHtml] = useState<string | null>(null);
	const [info, setInfo] = useState("읽는 중…");
	useEffect(() => {
		let gone = false;
		void (async () => {
			try {
				const b = await readBytes(fs, path, 60 * 1024 * 1024);
				const mammoth = await import("mammoth");
				const r = await mammoth.convertToHtml({ arrayBuffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });
				if (gone) return;
				setHtml(DOMPurify.sanitize(r.value));
				setInfo(`${(b.length / 1024).toFixed(0)} KB · 서식은 대략 보입니다`);
			} catch (e) {
				if (!gone) setInfo(`읽지 못했습니다: ${String((e as Error)?.message ?? e)}`);
			}
		})();
		return () => {
			gone = true;
		};
	}, [fs, path]);
	return (
		<div className="panel-fill">
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 로 정화한 HTML */}
			{html !== null ? <div className="md-view docx-view selectable" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="dock-watermark"><p>{info}</p></div>}
			<div className="statusbar">
				<span>{info}</span>
			</div>
		</div>
	);
}

/** 이미지 — 맞춤·원본·확대·축소(Ctrl+휠), 크기 표시 */
function ImagePreview({ fs, path }: { fs: FsBackend; path: string }) {
	const [url, setUrl] = useState<string | null>(null);
	const [info, setInfo] = useState("읽는 중…");
	const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
	const [zoom, setZoom] = useState<number | "fit">("fit");
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let gone = false;
		let made: string | null = null;
		readBytes(fs, path)
			.then((b) => {
				if (gone) return;
				const ext = path.split(".").pop()?.toLowerCase() ?? "";
				made = URL.createObjectURL(new Blob([b], { type: MIME[ext] ?? "application/octet-stream" }));
				setUrl(made);
				setInfo(`${(b.length / 1024).toFixed(0)} KB`);
			})
			.catch((e) => !gone && setInfo(String(e?.message ?? e)));
		return () => {
			gone = true;
			if (made) URL.revokeObjectURL(made);
		};
	}, [fs, path]);
	const step = (d: number) => setZoom((z) => {
		const cur = z === "fit" ? 1 : z;
		return Math.min(16, Math.max(0.05, Math.round(cur * (d > 0 ? 1.25 : 0.8) * 100) / 100));
	});
	return (
		<div className="panel-fill">
			<div
				className={`preview-body img-box${zoom === "fit" ? " fit" : ""}`}
				ref={box}
				onWheel={(e) => {
					if (!e.ctrlKey) return;
					e.preventDefault();
					step(-e.deltaY);
				}}
			>
				{url && (
					<img
						src={url}
						alt={path}
						className="preview-img"
						style={zoom === "fit" ? undefined : { width: dim ? dim.w * zoom : undefined, maxWidth: "none", maxHeight: "none" }}
						onLoad={(e) => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
					/>
				)}
			</div>
			<div className="statusbar">
				<span>
					{dim ? `${dim.w} × ${dim.h}px · ` : ""}
					{info}
				</span>
				<span style={{ marginLeft: "auto" }} />
				<span>{zoom === "fit" ? "맞춤" : `${Math.round(zoom * 100)}%`}</span>
				<button type="button" className="btn ghost icon" style={{ height: 20 }} title="축소(Ctrl+휠)" onClick={() => step(-1)}>
					<Minus size={12} />
				</button>
				<button type="button" className="btn ghost icon" style={{ height: 20 }} title="확대(Ctrl+휠)" onClick={() => step(1)}>
					<Plus size={12} />
				</button>
				<button type="button" className="btn ghost icon" style={{ height: 20 }} title="원본 크기" onClick={() => setZoom(1)}>
					<Scan size={12} />
				</button>
				<button type="button" className="btn ghost icon" style={{ height: 20 }} title="창에 맞춤" onClick={() => setZoom("fit")}>
					<Maximize size={12} />
				</button>
			</div>
		</div>
	);
}
