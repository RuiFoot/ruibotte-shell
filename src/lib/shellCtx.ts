/**
 * 터미널이 지금 어느 셸에 있는지(서버 · 컨테이너)와 그 셸의 작업 목록(jobs).
 * 셸 훅이 프롬프트마다 OSC 6976(host · docker:이름)·OSC 6977(jobs 줄, ␤ 로 이음)을 보낸다 —
 * "마지막으로 프롬프트를 그린 셸" 이 트리·편집기가 볼 곳이다(docker exec 로 들어가면 컨테이너, exit 하면 서버, fg·Ctrl+Z 는 그대로).
 */

export type Job = { n: number; state: "stopped" | "running"; cmd: string };

/** OSC 6977 내용 → 작업 목록(끝난 작업은 뺀다). bash `jobs` 와 zsh 훅(번호 상태 명령) 모양 둘 다 */
export function parseJobs(data: string): Job[] {
	const out: Job[] = [];
	for (const raw of data.split("␤")) {
		const m = /^\[(\d+)\]\s*[+-]?\s+(\S+)(?:\s+\([^)]*\))?\s+(.*)$/.exec(raw.trim());
		if (!m) continue;
		const st = m[2].toLowerCase();
		const state = st.startsWith("stopped") || st.startsWith("suspended") ? "stopped" : st.startsWith("running") ? "running" : null;
		if (!state) continue;
		out.push({ n: Number(m[1]), state, cmd: m[3].replace(/\s*&$/, "").trim() });
	}
	return out;
}

/** 값이 따로 오는 docker exec 옵션 */
const VALUE_OPTS = new Set(["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys"]);
const SHELLS = /^(bash|sh|ash|zsh|dash|ksh|mksh)$/;

/**
 * 친 줄(프롬프트 포함)이 컨테이너 안 대화형 셸로 들어가는 docker/podman exec 이면 컨테이너 이름.
 * `docker exec -it web bash` · `sudo docker exec -it -u root web /bin/sh -l` · `podman exec -ti db zsh` — 셸이 아닌 명령(psql 등)·-d·-c 는 아님
 */
export function parseDockerExec(line: string): string | null {
	const m = /(?:^|[\s;&|$#>])(?:sudo\s+(?:-\S+\s+)*)?(?:docker|podman)\s+(?:container\s+)?exec\s+(.+)$/.exec(line);
	if (!m) return null;
	const toks = m[1].trim().split(/\s+/);
	let tty = false;
	let inter = false;
	let i = 0;
	for (; i < toks.length; i++) {
		const t = toks[i];
		if (!t.startsWith("-")) break;
		if (t === "-d" || t === "--detach") return null;
		if (t === "--tty") tty = true;
		else if (t === "--interactive") inter = true;
		else if (VALUE_OPTS.has(t)) i++;
		else if (/^-[a-zA-Z]+$/.test(t)) {
			if (t.includes("d")) return null;
			if (t.includes("t")) tty = true;
			if (t.includes("i")) inter = true;
			// -itu root — 묶음 끝 글자가 값을 받는 옵션이면 다음 낱말이 값
			if ("euw".includes(t[t.length - 1])) i++;
		}
	}
	const ctr = toks[i];
	const cmd = toks[i + 1];
	if (!tty || !inter || !ctr || !cmd || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ctr)) return null;
	if (!SHELLS.test(cmd.replace(/^.*\//, ""))) return null;
	if (toks.slice(i + 2).includes("-c")) return null;
	return ctr;
}

/** 멈춘 작업이 파일 편집·보기 프로그램이면 그 파일(마지막 인자 하나) */
export function jobFile(cmd: string): string | null {
	const m = /^(?:sudo\s+(?:-\S+\s+)*)?(?:vim?|nvim|nano|micro|view|less|more|emacs\s+-nw)\s+((?:[-+]\S*\s+)*)(\S+)$/.exec(cmd.trim());
	if (!m || m[2].startsWith("-")) return null;
	return m[2];
}

/** 컨테이너 이름(서버 셸이면 null) */
export function ctxContainer(ctx: string | undefined): string | null {
	return ctx?.startsWith("docker:") ? ctx.slice(7) : null;
}
