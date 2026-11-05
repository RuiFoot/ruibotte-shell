import { type LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

type Lang = LanguageSupport | StreamLanguage<unknown>;
type Def = { id: string; label: string; load: () => Promise<Lang> };

const legacy = async (m: Promise<Record<string, unknown>>, key: string) => StreamLanguage.define((await m)[key] as StreamParser<unknown>);

/**
 * 로그 보기 — 수준(ERROR·WARN·INFO·DEBUG)과 시각, 예외·스택을 색으로.
 * 토큰 이름은 코드 색 변수로 이어진다(invalid=빨강, atom=노랑, typeName=하늘, comment=흐림, meta=주황).
 */
const logMode: StreamParser<unknown> = {
	name: "log",
	token(stream) {
		if (stream.sol() && stream.match(/^\s+at\s+\S+/)) {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match(/^\[?\d{4}[-/.]\d{2}[-/.]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?/)) return "meta";
		if (stream.match(/^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/)) return "meta";
		if (stream.match(/^(?:ERROR|ERR|FATAL|SEVERE|CRIT(?:ICAL)?|EMERG|ALERT|PANIC)\b/i)) return "invalid";
		if (stream.match(/^[\w$.]*(?:Exception|Error)\b/)) return "invalid";
		if (stream.match(/^WARN(?:ING)?\b/i)) return "atom";
		if (stream.match(/^(?:INFO|NOTICE)\b/i)) return "typeName";
		if (stream.match(/^(?:DEBUG|TRACE|FINE[RS]?T?)\b/i)) return "comment";
		if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
		if (stream.match(/^\b\d+(?:\.\d+)?\b/)) return "number";
		stream.next();
		return null;
	},
};

/** 고를 수 있는 언어(상태 줄) — 순서대로 보인다 */
export const LANGS: Def[] = [
	{ id: "js", label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
	{ id: "ts", label: "TypeScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) },
	{ id: "json", label: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
	{ id: "html", label: "HTML·JSP", load: async () => (await import("@codemirror/lang-html")).html() },
	{ id: "css", label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
	{ id: "xml", label: "XML", load: async () => (await import("@codemirror/lang-xml")).xml() },
	{ id: "yaml", label: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
	{ id: "md", label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
	{ id: "sql", label: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
	{ id: "py", label: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
	{ id: "java", label: "Java", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "java") },
	{ id: "kotlin", label: "Kotlin", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "kotlin") },
	{ id: "groovy", label: "Groovy·Gradle", load: () => legacy(import("@codemirror/legacy-modes/mode/groovy"), "groovy") },
	{ id: "c", label: "C", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "c") },
	{ id: "cpp", label: "C++", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "cpp") },
	{ id: "cs", label: "C#", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "csharp") },
	{ id: "go", label: "Go", load: () => legacy(import("@codemirror/legacy-modes/mode/go"), "go") },
	{ id: "rust", label: "Rust", load: () => legacy(import("@codemirror/legacy-modes/mode/rust"), "rust") },
	{ id: "php", label: "PHP(C 계열 강조)", load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "c") },
	{ id: "ruby", label: "Ruby", load: () => legacy(import("@codemirror/legacy-modes/mode/ruby"), "ruby") },
	{ id: "perl", label: "Perl", load: () => legacy(import("@codemirror/legacy-modes/mode/perl"), "perl") },
	{ id: "lua", label: "Lua", load: () => legacy(import("@codemirror/legacy-modes/mode/lua"), "lua") },
	{ id: "shell", label: "셸(bash·sh)", load: () => legacy(import("@codemirror/legacy-modes/mode/shell"), "shell") },
	{ id: "ps", label: "PowerShell", load: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), "powerShell") },
	{ id: "props", label: "ini·properties·conf·systemd", load: () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties") },
	{ id: "toml", label: "TOML", load: () => legacy(import("@codemirror/legacy-modes/mode/toml"), "toml") },
	{ id: "nginx", label: "nginx", load: () => legacy(import("@codemirror/legacy-modes/mode/nginx"), "nginx") },
	{ id: "docker", label: "Dockerfile", load: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile") },
	{ id: "cmake", label: "CMake", load: () => legacy(import("@codemirror/legacy-modes/mode/cmake"), "cmake") },
	{ id: "diff", label: "diff·patch", load: () => legacy(import("@codemirror/legacy-modes/mode/diff"), "diff") },
	{ id: "log", label: "로그", load: async () => StreamLanguage.define(logMode) },
];

const BY_EXT: Record<string, string> = {
	js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", json: "json", jsonc: "json",
	html: "html", htm: "html", jsp: "html", vue: "html", css: "css", scss: "css", less: "css",
	xml: "xml", xsd: "xml", pom: "xml", svg: "xml", xhtml: "xml", wsdl: "xml", yml: "yaml", yaml: "yaml",
	md: "md", markdown: "md", sql: "sql", py: "py", java: "java", kt: "kotlin", kts: "kotlin", groovy: "groovy", gradle: "groovy",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "cs", go: "go", rs: "rust", php: "php", rb: "ruby", pl: "perl", pm: "perl", lua: "lua",
	sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", ps1: "ps", psm1: "ps",
	properties: "props", conf: "props", cfg: "props", ini: "props", env: "props", service: "props", timer: "props", socket: "props", mount: "props", target: "props",
	toml: "toml", diff: "diff", patch: "diff", log: "log", out: "log", err: "log",
};

/** 이름·경로·첫 줄(shebang)로 언어 짐작 — 모르면 null */
export function detectLang(path: string, firstLine = ""): string | null {
	const name = path.split("/").pop()?.toLowerCase() ?? "";
	const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	if (name === "dockerfile" || name.startsWith("dockerfile.")) return "docker";
	if (name === "makefile" || name === "cmakelists.txt") return name === "makefile" ? "shell" : "cmake";
	if (name === "nginx.conf" || path.includes("/nginx/")) return "nginx";
	if (name.startsWith(".bash") || name === ".profile" || name === ".zshrc" || name === "crontab" || path.includes("/cron.")) return "shell";
	if (/^#!.*\b(ba|z|k)?sh\b/.test(firstLine)) return "shell";
	if (/^#!.*\bpython/.test(firstLine)) return "py";
	if (/^#!.*\b(node|deno|bun)\b/.test(firstLine)) return "js";
	if (/^#!.*\bperl/.test(firstLine)) return "perl";
	if (ext && BY_EXT[ext]) return BY_EXT[ext];
	// 날짜가 붙은 로그(app.log.2026-11-05, messages-20261105)·/var/log 아래
	if (/\.log\.|\.log-|^(messages|syslog|secure|catalina|access|error)(\.|-|$)/.test(name) || path.startsWith("/var/log/")) return "log";
	return null;
}

export async function loadLang(id: string | null): Promise<Lang | null> {
	const d = LANGS.find((l) => l.id === id);
	return d ? d.load() : null;
}
