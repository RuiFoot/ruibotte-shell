/**
 * 터미널이 지금 어느 셸에 있는지(서버 · 컨테이너)와 그 셸의 작업 목록(jobs).
 * 셸 훅이 프롬프트마다 OSC 6976(host · docker:이름)·OSC 6977(작업 목록)을 보낸다 —
 * "마지막으로 프롬프트를 그린 셸" 이 그 터미널의 맥락이다(docker exec 로 들어가면 컨테이너, exit 하면 서버, fg·Ctrl+Z 는 그대로).
 * 셸 훅이 닿지 않는 맥락(ssh·su·tmux 등)은 친 명령으로 알아보고 띠로 알린다(Orbit §27 과 같은 규칙).
 */

export type Job = { n: number; state: "stopped" | "running"; cmd: string };

/** 작업 목록 줄 사이 구분 — ASCII(EUC-KR 로 풀어도 깨지지 않게, OSC 안에서 지워지는 제어 글자도 아님) */
export const JOB_SEP = "@@J@@";
/** 정지 작업과 뒤에서 도는 작업 사이 */
export const JOB_RUN = "@@R@@";

/**
 * OSC 6977 내용 → 작업 목록. 훅이 `jobs -s`(정지) · `jobs -r`(실행 중) 을 따로 보내므로 상태 글자(로캘마다 다름)는 읽지 않는다.
 * 줄 모양: bash `[1]+  Stopped                 vim a.conf`(상태 칸 뒤 두 칸 이상 띄움) · zsh 훅 `[1]  z  vim a.conf`
 */
export function parseJobs(data: string): Job[] {
	const [stopped = "", running = ""] = data.split(JOB_RUN);
	const out: Job[] = [];
	const take = (part: string, state: Job["state"]) => {
		for (const raw of part.split(JOB_SEP)) {
			const m = /^\[(\d+)\]\s*[+-]?\s+(.*)$/.exec(raw.trim());
			if (!m) continue;
			const parts = m[2].split(/\s{2,}/);
			const cmd = (parts.length >= 2 ? parts.slice(1).join("  ") : parts[0]).replace(/\s*&$/, "").trim();
			if (cmd) out.push({ n: Number(m[1]), state, cmd });
		}
	};
	take(stopped, "stopped");
	take(running, "running");
	return out.sort((a, b) => a.n - b.n);
}

/** 정지 신호로 멈춘 명령의 종료 코드(128 + SIGSTOP·TSTP·TTIN·TTOU) — 실패가 아니라 작업(jobs)으로 남았다 */
export const STOPPED_EXIT = new Set([147, 148, 149, 150]);

const SHELL_RE = /^(bash|sh|ash|zsh|dash|ksh|mksh)$/;
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ash", "ksh", "mksh", "tcsh", "csh"]);
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** docker 전역 옵션 중 값을 받는 것 */
const DOCKER_GLOBAL_VALUE = new Set(["-H", "--host", "-c", "--context", "--config", "-l", "--log-level"]);
/** docker exec 옵션 중 값을 받는 것 */
const DOCKER_EXEC_VALUE = new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"]);
const REMOTE_COMMANDS = new Set(["ssh", "mosh", "telnet", "rlogin", "rsh", "lxc-attach", "nsenter", "chroot", "systemd-nspawn", "toolbox", "distrobox"]);
const USER_COMMANDS = new Set(["su", "runuser", "login", "doas"]);
const MUX_COMMANDS = new Set(["tmux", "screen", "zellij", "byobu", "dtach", "abduco", "tmate"]);

export type ForeignCtx = {
	kind: "container" | "remote" | "user" | "multiplexer";
	label: string;
	/** 컨테이너 이름(docker/podman exec·attach) */
	name?: string;
};

const base = (x: string) => x.slice(x.lastIndexOf("/") + 1);

/** 명령 머리 — VAR=값·time·exec·command·nohup·env 를 건너뛴 첫 낱말 위치 */
function headIndex(tok: string[]): number {
	let i = 0;
	while (i < tok.length && (/^\w+=/.test(tok[i] ?? "") || ["time", "exec", "command", "nohup", "env"].includes(tok[i] ?? ""))) i++;
	return i;
}

/**
 * 친 명령(프롬프트 뒤 글만)이 셸 훅이 닿지 않는 다른 맥락으로 들어가는가 — 터미널 위 띠(트리·편집기는 이 서버 기준)와 경로 링크 확인에 쓴다.
 * docker exec 로 컨테이너 셸에 들어가는 것은 앱이 훅을 넣어 따라가지만, 넣기 전·넣지 못한 때를 위해 여기서도 알아본다
 */
export function contextCommand(cmd: string): ForeignCtx | null {
	const t = cmd.trim();
	const label = t.length > 120 ? `${t.slice(0, 120)}…` : t;
	const tok = t.split(/\s+/);
	let i = headIndex(tok);
	let a0 = base(tok[i] ?? "");
	if (a0 === "sudo") {
		let j = i + 1;
		for (; j < tok.length; j++) {
			const x = tok[j] ?? "";
			if (/^--(login|shell)$/.test(x) || /^-[A-Za-z]*[is][A-Za-z]*$/.test(x)) return { kind: "user", label };
			if (!x.startsWith("-")) break;
			if (/^-[ugpCD]$/.test(x)) j++;
		}
		if (j >= tok.length) return null;
		i = j;
		a0 = base(tok[i] ?? "");
		if (SHELLS.has(a0) || a0 === "su") return { kind: "user", label };
	}
	const rest = tok.slice(i + 1);
	if (a0 === "docker" || a0 === "podman" || a0 === "nerdctl") {
		let k = 0;
		while (k < rest.length && rest[k]?.startsWith("-")) k += rest[k]?.includes("=") || !DOCKER_GLOBAL_VALUE.has(rest[k] ?? "") ? 1 : 2;
		let sub = rest[k] ?? "";
		if (sub === "container") {
			k++;
			sub = rest[k] ?? "";
		}
		if (sub === "compose" || sub === "stack") return rest.slice(k + 1).some((x) => x === "exec" || x === "run" || x === "attach") ? { kind: "container", label } : null;
		if (sub === "exec" || sub === "attach") {
			let name: string | undefined;
			for (let j = k + 1; j < rest.length; j++) {
				const x = rest[j] ?? "";
				if (x === "--") {
					name = rest[j + 1];
					break;
				}
				if (x.startsWith("-")) {
					if (!x.includes("=") && DOCKER_EXEC_VALUE.has(x)) j++;
					continue;
				}
				name = x;
				break;
			}
			return { kind: "container", label, name: name && CONTAINER_NAME.test(name) ? name : undefined };
		}
		if (sub === "run") return rest.slice(k + 1).some((x) => x === "-d" || x === "--detach") ? null : { kind: "container", label };
		return null;
	}
	if ((a0 === "kubectl" || a0 === "oc") && rest.some((x) => x === "exec" || x === "attach" || x === "debug")) return { kind: "remote", label };
	if ((a0 === "lxc" || a0 === "incus") && /^(exec|shell|console)$/.test(rest[0] ?? "")) return { kind: "remote", label };
	if (REMOTE_COMMANDS.has(a0)) return { kind: "remote", label };
	if (USER_COMMANDS.has(a0)) return { kind: "user", label };
	if (MUX_COMMANDS.has(a0)) return { kind: "multiplexer", label };
	return null;
}

/** 다른 맥락 띠 문구 */
export function contextNotice(c: ForeignCtx): string {
	switch (c.kind) {
		case "container":
			return c.name ? `컨테이너 ${c.name} 안 — 트리·편집기가 아직 따라가지 않았습니다` : `컨테이너 안(${c.label}) — 트리·편집기·경로 링크는 이 서버 기준입니다`;
		case "remote":
			return `다른 서버·환경(${c.label}) — 트리·편집기·경로 링크는 이 서버 기준입니다`;
		case "user":
			return `다른 계정 셸(${c.label}) — 폴더를 따라가지 않습니다`;
		default:
			return `${c.label} 안 — 폴더를 따라가지 않습니다`;
	}
}

/**
 * 친 명령(프롬프트 뒤 글만)이 이 서버의 컨테이너 안 대화형 셸로 들어가는 docker/podman exec 이면 컨테이너 이름 — 앱이 그 셸에 훅을 넣는다.
 * 명령 머리(VAR=·env·sudo 옵션 뒤 첫 낱말)가 docker/podman 일 때만(`ssh other docker exec …` 는 다른 서버라 아님).
 * `docker exec -it web bash` · `sudo docker exec -it -u root web /bin/sh -l` · `podman exec -ti db zsh` — 셸이 아닌 명령·-d·-c·-it 없음은 아님
 */
export function parseDockerExec(cmd: string): string | null {
	const tok = cmd.trim().split(/\s+/);
	let i = headIndex(tok);
	if (base(tok[i] ?? "") === "sudo") {
		i++;
		while (i < tok.length && tok[i]?.startsWith("-")) {
			// sudo -i·-s 는 계정 셸 — 그 뒤는 보지 않는다
			if (/^-[A-Za-z]*[is][A-Za-z]*$/.test(tok[i] ?? "") || /^--(login|shell)$/.test(tok[i] ?? "")) return null;
			if (/^-[ugpCD]$/.test(tok[i] ?? "")) i++;
			i++;
		}
	}
	const a0 = base(tok[i] ?? "");
	if (a0 !== "docker" && a0 !== "podman") return null;
	let k = i + 1;
	while (k < tok.length && tok[k]?.startsWith("-")) k += tok[k]?.includes("=") || !DOCKER_GLOBAL_VALUE.has(tok[k] ?? "") ? 1 : 2;
	// 다른 호스트·문맥(-H·--context)을 쓰는 docker 는 이 서버 컨테이너가 아닐 수 있다
	if (tok.slice(i + 1, k).some((x) => /^(-H|--host|-c|--context)(=|$)/.test(x))) return null;
	if (tok[k] === "container") k++;
	if (tok[k] !== "exec") return null;
	let tty = false;
	let inter = false;
	let j = k + 1;
	for (; j < tok.length; j++) {
		const t = tok[j] ?? "";
		if (t === "--") {
			j++;
			break;
		}
		if (!t.startsWith("-")) break;
		if (t === "-d" || t === "--detach") return null;
		if (t === "--tty") tty = true;
		else if (t === "--interactive") inter = true;
		else if (t.includes("=")) continue;
		else if (DOCKER_EXEC_VALUE.has(t)) j++;
		else if (/^-[a-zA-Z]+$/.test(t)) {
			if (t.includes("d")) return null;
			if (t.includes("t")) tty = true;
			if (t.includes("i")) inter = true;
			// -itu root — 묶음 끝 글자가 값을 받는 옵션이면 다음 낱말이 값
			if ("euw".includes(t[t.length - 1])) j++;
		}
	}
	const ctr = tok[j];
	const sh = tok[j + 1];
	if (!tty || !inter || !ctr || !sh || !CONTAINER_NAME.test(ctr)) return null;
	if (!SHELL_RE.test(base(sh))) return null;
	if (tok.slice(j + 2).includes("-c")) return null;
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

/** 훅을 넣어도 되는 자리인가 — 프롬프트 모양이고(끝이 $ # % > ❯), 암호를 묻는 줄이 아니다 */
export function looksLikePrompt(lineBeforeCursor: string): boolean {
	const s = lineBeforeCursor.replace(/\s+$/, "");
	if (!s || /pass(word|phrase)|암호|비밀번호|\(yes\/no|\[y\/n\]/i.test(s)) return false;
	return /[$#%>❯]$/.test(s);
}
