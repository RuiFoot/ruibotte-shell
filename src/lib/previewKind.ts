import { archiveFormat } from "./archive";

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
