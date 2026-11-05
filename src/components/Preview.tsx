import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import type { FsBackend } from "../lib/ipc";
import { DataGrid } from "./DataGrid";

/** 확장자로 보기 방식 고르기 */
export function previewKind(path: string): "image" | "pdf" | "hex" | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"].includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
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

async function readBytes(fs: FsBackend, path: string, max?: number): Promise<Uint8Array<ArrayBuffer>> {
	const buf =
		fs.side === "remote"
			? await invoke<ArrayBuffer>("sftp_read_bytes", { conn: fs.conn, path, max })
			: await invoke<ArrayBuffer>("local_read_bytes", { path, max });
	return new Uint8Array(buf);
}

/** 이미지·PDF·헥스 미리보기 */
export function BinaryPreview({ fs, path, kind }: { fs: FsBackend; path: string; kind: "image" | "pdf" | "hex" }) {
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
				{kind === "image" && url && <img src={url} alt={path} className="preview-img" />}
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

export function TableView({ text, sep }: { text: string; sep: string }) {
	const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
	const head = rows[0] ?? [];
	const body = rows.slice(1);
	const cols = head.map((h, i) => ({ name: h || `열 ${i + 1}`, kind: body.slice(0, 50).every((r) => r[i] === undefined || r[i] === "" || /^-?\d+(\.\d+)?$/.test(r[i])) ? "numeric" : "text" }));
	const fetchRows = useMemo(() => (from: number, to: number) => Promise.resolve(body.slice(from, to).map((r) => cols.map((_, i) => r[i] ?? null))), [body, cols]);
	return <DataGrid columns={cols} rowCount={body.length} fetchRows={fetchRows} resetKey={text.length} />;
}
