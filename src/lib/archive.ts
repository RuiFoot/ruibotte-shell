/**
 * 압축 파일 목록 읽기(풀지 않는다) — zip·jar·war 는 끝의 중앙 디렉터리만, tar 는 머리 블록만 읽고 내용은 건너뛴다.
 * tar.gz·tgz 는 DecompressionStream 으로 풀면서 머리만 본다.
 */

export type ArchiveEntry = { name: string; size: number; mtime: Date | null; dir: boolean; link?: string };
export type ArchiveListing = { format: string; entries: ArchiveEntry[]; truncated: boolean };

/** 파일의 일부 읽기 — offset 이 음수면 끝에서 그만큼 앞부터 */
export type ReadRange = (offset: number, max: number) => Promise<Uint8Array>;

const MAX_ENTRIES = 50_000;
const CHUNK = 4 * 1024 * 1024;
/** tar.gz 는 처음부터 풀어야 해서 이만큼(압축된 크기)까지만 읽는다 */
const MAX_GZ_READ = 512 * 1024 * 1024;

export function archiveFormat(path: string): "zip" | "tar" | "tgz" | null {
	const p = path.toLowerCase();
	if (/\.(zip|jar|war|ear|apk|aar|whl|nupkg|vsix|xpi)$/.test(p)) return "zip";
	if (/\.(tar\.gz|tgz|tar\.z)$/.test(p) || p.endsWith(".gz")) return "tgz";
	if (p.endsWith(".tar")) return "tar";
	return null;
}

export class NotArchive extends Error {}

export async function listArchive(path: string, read: ReadRange, signal?: { aborted: boolean }): Promise<ArchiveListing> {
	const f = archiveFormat(path);
	if (f === "zip") return listZip(read);
	if (f === "tar") return listTar(read, signal);
	if (f === "tgz") return listTgz(read, signal);
	throw new NotArchive("압축 파일이 아닙니다");
}

// ── zip ─────────────────────────────

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 0x100000000;

function dosDate(time: number, date: number): Date | null {
	if (!date) return null;
	return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8Loose = new TextDecoder("utf-8");
let cp949: TextDecoder | null = null;
/** zip 이름 — UTF-8 표시가 없으면 UTF-8 로 해 보고, 안 되면 EUC-KR(윈도 탐색기로 만든 zip) */
function zipName(b: Uint8Array, flagUtf8: boolean): string {
	if (flagUtf8) return utf8Loose.decode(b);
	try {
		return utf8.decode(b);
	} catch {
		try {
			cp949 ??= new TextDecoder("euc-kr");
			return cp949.decode(b);
		} catch {
			return utf8Loose.decode(b);
		}
	}
}

async function listZip(read: ReadRange): Promise<ArchiveListing> {
	const tail = await read(-(65_557 + 20), 65_557 + 20);
	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new NotArchive("zip 끝 표시를 찾지 못했습니다(zip 이 아니거나 깨진 파일)");
	let count = u16(tail, eocd + 10);
	let cdSize = u32(tail, eocd + 12);
	let cdOff = u32(tail, eocd + 16);
	// zip64 — 값이 넘쳐 있으면 바로 앞의 zip64 위치 표시에서
	if (cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
		const loc = eocd - 20;
		if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
			const z = await read(u64(tail, loc + 8), 56);
			if (u32(z, 0) === 0x06064b50) {
				count = u64(z, 32);
				cdSize = u64(z, 40);
				cdOff = u64(z, 48);
			}
		}
	}
	const truncated = cdSize > 32 * 1024 * 1024;
	const cd = await read(cdOff, Math.min(cdSize, 32 * 1024 * 1024));
	const entries: ArchiveEntry[] = [];
	let p = 0;
	while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50 && entries.length < Math.min(count, MAX_ENTRIES)) {
		const flags = u16(cd, p + 8);
		let csize = u32(cd, p + 20);
		let size = u32(cd, p + 24);
		const nlen = u16(cd, p + 28);
		const xlen = u16(cd, p + 30);
		const clen = u16(cd, p + 32);
		const name = zipName(cd.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
		// zip64 덧붙임에서 실제 크기
		if (size === 0xffffffff || csize === 0xffffffff) {
			let x = p + 46 + nlen;
			const end = x + xlen;
			while (x + 4 <= end) {
				const id = u16(cd, x);
				const len = u16(cd, x + 2);
				if (id === 1) {
					let q = x + 4;
					if (size === 0xffffffff) {
						size = u64(cd, q);
						q += 8;
					}
					if (csize === 0xffffffff) csize = u64(cd, q);
					break;
				}
				x += 4 + len;
			}
		}
		entries.push({ name, size, mtime: dosDate(u16(cd, p + 12), u16(cd, p + 14)), dir: name.endsWith("/") });
		p += 46 + nlen + xlen + clen;
	}
	return { format: "zip", entries, truncated: truncated || entries.length < count };
}

// ── tar ─────────────────────────────

const ascii = new TextDecoder("utf-8");
function cstr(b: Uint8Array, from: number, len: number): string {
	const s = b.subarray(from, from + len);
	const z = s.indexOf(0);
	return ascii.decode(z < 0 ? s : s.subarray(0, z));
}
/** 8진수 숫자 칸(큰 값은 base-256) */
function octal(b: Uint8Array, from: number, len: number): number {
	if (b[from] & 0x80) {
		let n = 0;
		for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
		return n;
	}
	const s = cstr(b, from, len).trim();
	return s ? Number.parseInt(s, 8) || 0 : 0;
}

/** 순서대로 받은 바이트에서 tar 머리만 골라낸다 — 내용은 건너뛴다(skip 이 크면 부른 쪽이 읽지 않고 건너뛸 수 있다) */
class TarParser {
	entries: ArchiveEntry[] = [];
	done = false;
	/** 건너뛸 내용 바이트 */
	skip = 0;
	private pend = new Uint8Array(512);
	private have = 0;
	/** 긴 이름·pax 머리 내용 모으기 */
	private collect: { kind: string; size: number; buf: Uint8Array; have: number } | null = null;
	private next: { name?: string; size?: number; mtime?: number; link?: string } = {};
	private first = true;

	feed(chunk: Uint8Array) {
		let i = 0;
		while (i < chunk.length && !this.done) {
			if (this.skip > 0) {
				const n = Math.min(this.skip, chunk.length - i);
				this.skip -= n;
				i += n;
				continue;
			}
			if (this.collect) {
				const c = this.collect;
				const n = Math.min(c.buf.length - c.have, chunk.length - i);
				c.buf.set(chunk.subarray(i, i + n), c.have);
				c.have += n;
				i += n;
				if (c.have === c.buf.length) {
					this.collect = null;
					this.special(c.kind, c.buf.subarray(0, c.size));
				}
				continue;
			}
			const n = Math.min(512 - this.have, chunk.length - i);
			this.pend.set(chunk.subarray(i, i + n), this.have);
			this.have += n;
			i += n;
			if (this.have === 512) {
				this.have = 0;
				this.header(this.pend);
			}
		}
	}

	private header(h: Uint8Array) {
		if (h.every((x) => x === 0)) {
			this.done = true;
			return;
		}
		if (this.first) {
			this.first = false;
			// 머리 검사합 — 첫 블록이 tar 가 아니면 그만
			let sum = 0;
			for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
			if (sum !== octal(h, 148, 8)) throw new NotArchive("tar 형식이 아닙니다");
		}
		const type = String.fromCharCode(h[156] || 48);
		const size = octal(h, 124, 12);
		const padded = Math.ceil(size / 512) * 512;
		if (type === "L" || type === "K" || type === "x" || type === "g") {
			if (size > 4 * 1024 * 1024) {
				this.skip = padded;
				return;
			}
			this.collect = { kind: type, size, buf: new Uint8Array(padded), have: 0 };
			if (padded === 0) {
				this.collect = null;
			}
			return;
		}
		const prefix = cstr(h, 257, 6).startsWith("ustar") ? cstr(h, 345, 155) : "";
		let name = cstr(h, 0, 100);
		if (prefix) name = `${prefix}/${name}`;
		const n = this.next;
		this.next = {};
		const realSize = n.size ?? size;
		const mt = n.mtime ?? octal(h, 136, 12);
		this.entries.push({
			name: n.name ?? name,
			size: type === "5" ? 0 : realSize,
			mtime: mt ? new Date(mt * 1000) : null,
			dir: type === "5" || (n.name ?? name).endsWith("/"),
			link: type === "1" || type === "2" ? (n.link ?? cstr(h, 157, 100)) : undefined,
		});
		if (this.entries.length >= MAX_ENTRIES) this.done = true;
		// 하드링크·폴더 등은 내용이 없다
		this.skip = type === "1" || type === "2" || type === "5" ? 0 : Math.ceil(realSize / 512) * 512;
	}

	private special(kind: string, data: Uint8Array) {
		if (kind === "L") this.next.name = cstr(data, 0, data.length);
		else if (kind === "K") this.next.link = cstr(data, 0, data.length);
		else if (kind === "x") {
			// pax: "길이 키=값\n" 줄들
			const text = ascii.decode(data);
			let p = 0;
			while (p < text.length) {
				const sp = text.indexOf(" ", p);
				if (sp < 0) break;
				const len = Number(text.slice(p, sp));
				if (!len) break;
				const rec = text.slice(sp + 1, p + len - 1);
				const eq = rec.indexOf("=");
				const k = rec.slice(0, eq);
				const v = rec.slice(eq + 1);
				if (k === "path") this.next.name = v;
				else if (k === "linkpath") this.next.link = v;
				else if (k === "size") this.next.size = Number(v);
				else if (k === "mtime") this.next.mtime = Math.floor(Number(v));
				p += len;
			}
		}
	}
}

async function listTar(read: ReadRange, signal?: { aborted: boolean }): Promise<ArchiveListing> {
	const t = new TarParser();
	let pos = 0;
	for (;;) {
		if (signal?.aborted) break;
		// 큰 내용은 읽지 않고 건너뛴다
		if (t.skip > CHUNK) {
			pos += t.skip;
			t.skip = 0;
		}
		const b = await read(pos, CHUNK);
		if (!b.length) break;
		t.feed(b);
		pos += b.length;
		if (t.done || b.length < CHUNK) break;
	}
	return { format: "tar", entries: t.entries, truncated: t.entries.length >= MAX_ENTRIES };
}

async function listTgz(read: ReadRange, signal?: { aborted: boolean }): Promise<ArchiveListing> {
	const t = new TarParser();
	const ds = new DecompressionStream("gzip");
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();
	let truncated = false;
	// 읽어 넣기 — 다 됐거나(머리 끝) 상한이면 멈춘다
	const pump = (async () => {
		let pos = 0;
		try {
			for (;;) {
				if (signal?.aborted || t.done) break;
				if (pos >= MAX_GZ_READ) {
					truncated = true;
					break;
				}
				const b = await read(pos, CHUNK);
				if (!b.length) break;
				await writer.write(b as Uint8Array<ArrayBuffer>);
				pos += b.length;
				if (b.length < CHUNK) break;
			}
			await writer.close();
		} catch {
			// 읽는 쪽이 먼저 끝남(머리 끝) — 무시
		}
	})();
	let gotAny = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			gotAny = true;
			t.feed(value);
			if (t.done || signal?.aborted) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} catch (e) {
		await reader.cancel().catch(() => undefined);
		await pump;
		if (e instanceof NotArchive) throw e;
		if (!gotAny) throw new NotArchive(`gzip 을 풀지 못했습니다: ${String((e as Error)?.message ?? e)}`);
		truncated = true;
	}
	await pump;
	return { format: "tar.gz", entries: t.entries, truncated: truncated || t.entries.length >= MAX_ENTRIES };
}
