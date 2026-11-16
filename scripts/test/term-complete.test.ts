// 터미널 자동완성 단위 시험 — 흐린 제안(ghost)의 기록 맥락 규칙·폴더 이름 제안·Tab 목록의 지난 명령 순서·옛 기록 호환.
// 쓰기: pnpm test:term   (node --import ./scripts/test/ts-hook.mjs scripts/test/term-complete.test.ts)
// 폴더·컨테이너 이름은 일반 예시 — 실제 서버·서비스 이름을 쓰지 않는다.
import { complete, type GhostCtx, ghost, type HistEntry, mergeHistory, pathArgs, pushHistory, readHistory } from "../../src/lib/complete.ts";
import type { FsEntry } from "../../src/lib/ipc.ts";

let pass = 0;
let fail = 0;
function ok(cond: unknown, name: string, extra?: unknown) {
	if (cond) pass++;
	else {
		fail++;
		console.error(`✗ ${name}`, extra === undefined ? "" : JSON.stringify(extra));
	}
}
function eq<T>(got: T, want: T, name: string) {
	ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
}

const d = (name: string): FsEntry => ({ name, path: name, kind: "dir", size: 0 });
const f = (name: string): FsEntry => ({ name, path: name, kind: "file", size: 1 });

/** 서버 /srv/search 폴더(사용자 보고와 같은 모양) */
const SEARCH = "/srv/search";
const SEARCH_LIST = [d("RS5"), d("backups"), d("bin"), d("conf"), d("current"), d("data"), d("logs"), f("run.sh"), f(".env")];

function mk(history: HistEntry[], dirs: Record<string, FsEntry[]>, over: Partial<GhostCtx> = {}) {
	const wanted: string[] = [];
	const c: GhostCtx = {
		history,
		listDir: (dir) => dirs[dir] ?? null,
		cwd: SEARCH,
		home: "/root",
		shellCtx: "host",
		shellKind: "linux",
		want: (dir) => wanted.push(dir),
		...over,
	};
	return { c, wanted };
}

// ── 사용자 보고: 컨테이너 안에서 친 cd 가 서버 폴더에서 흐리게 나오던 것 ──
{
	const hist: HistEntry[] = [{ cmd: "cd CHOSUN_AC_KR/", cwd: "/data/collections", ctx: "docker:engine" }];
	const { c } = mk(hist, { [SEARCH]: SEARCH_LIST });
	eq(ghost("cd C", c), "", "컨테이너 안 cd 기록은 서버 폴더에서 제안하지 않는다(cd C)");
	eq(ghost("cd c", c), "", "cd c — conf·current 둘이라 공통 앞부분이 늘지 않으면 띄우지 않는다");
	eq(ghost("cd co", c), "nf/", "cd co → nf/ (지금 폴더 목록)");
	eq(ghost("cd cu", c), "rrent/", "cd cu → rrent/");
	eq(ghost("cd R", c), "S5/", "대소문자 구분 — R 은 RS5 하나");
	eq(ghost("cd r", c), "", "cd 는 폴더만 — run.sh 는 제안하지 않는다");
	eq(ghost("cat r", c), "un.sh", "cat 은 파일도");
	eq(ghost("cat .e", c), "nv", "점 파일은 . 으로 시작할 때만");
	eq(ghost("cat e", c), "", "점 파일은 . 없이 제안하지 않는다");
}
// 옛 문자열 기록(어디서 쳤는지 모름) — 지금 폴더에 없는 경로면 제안하지 않고, 있으면 제안
{
	const hist = readHistory(["cd CHOSUN_AC_KR/", "cd conf/nginx", "docker ps -a"]);
	const { c } = mk(hist, { [SEARCH]: SEARCH_LIST });
	eq(ghost("cd C", c), "", "옛 기록 cd CHOSUN_AC_KR/ — 지금 폴더에 없으면 제안하지 않는다");
	eq(ghost("cd co", c), "nf/nginx", "옛 기록 cd conf/nginx — conf 가 지금 폴더에 있으면 기록 그대로");
	eq(ghost("dock", c), "er ps -a", "경로 없는 명령은 어디서 쳤든");
}
// 다른 맥락 — 경로 없는 명령은 제안, 경로 명령은 쓰지 않는다(이름이 지금 폴더에 있어도)
{
	const hist: HistEntry[] = [
		{ cmd: "systemctl status nginx", cwd: "/", ctx: "docker:web" },
		{ cmd: "cd conf/ssl", cwd: "/etc/nginx", ctx: "docker:web" },
		{ cmd: "cat /etc/os-release", cwd: "/", ctx: "docker:web" },
	];
	const { c } = mk(hist, { [SEARCH]: SEARCH_LIST, "/": [d("etc")] });
	eq(ghost("systemctl s", c), "tatus nginx", "다른 맥락이라도 경로 없는 명령은 제안");
	eq(ghost("cd conf/", c), "", "다른 맥락 경로 명령은 쓰지 않는다 — cd conf/ 뒤는 conf 안 목록을 받아야");
	eq(ghost("cat /etc/o", c), "", "다른 맥락의 절대 경로도 쓰지 않는다");
}
// 같은 폴더 기록 우선 — 같은 폴더 → 같은 맥락 → 최근
{
	const hist: HistEntry[] = [
		{ cmd: "cd data/new", cwd: "/srv/other", ctx: "host" },
		{ cmd: "cd data/old", cwd: SEARCH, ctx: "host" },
		{ cmd: "cd data/x", cwd: SEARCH, ctx: "docker:web" },
	];
	const { c } = mk(hist, { [SEARCH]: SEARCH_LIST });
	eq(ghost("cd da", c), "ta/old", "같은 폴더·맥락에서 친 것이 더 최근의 다른 폴더 것보다 먼저");
	const { c: c2 } = mk(hist.slice(0, 1), { [SEARCH]: SEARCH_LIST });
	eq(ghost("cd da", c2), "ta/new", "다른 폴더 기록도 첫 마디(data)가 지금 폴더에 있으면 제안");
	const { c: c3 } = mk(hist.slice(0, 1), { [SEARCH]: [d("bin")] });
	eq(ghost("cd da", c3), "", "다른 폴더 기록의 첫 마디가 지금 폴더에 없으면 제안하지 않는다");
	const pathless: HistEntry[] = [
		{ cmd: "tail -f app.log", cwd: "/var/log", ctx: "docker:web" },
		{ cmd: "tail -f app.log", cwd: "/var/log", ctx: "host" },
		{ cmd: "make build", cwd: "/a", ctx: "docker:web" },
		{ cmd: "make test", cwd: "/a", ctx: "host" },
	];
	const { c: c4 } = mk(pathless, { [SEARCH]: SEARCH_LIST });
	eq(ghost("make ", c4), "test", "경로 없는 명령도 같은 맥락 것이 먼저");
}
// 캐시가 아직 없으면 제안하지 않고 뒤에서 받기를 부탁한다(입력을 기다리게 하지 않는다)
{
	const hist: HistEntry[] = [{ cmd: "cd conf/", cwd: "/elsewhere", ctx: "host" }];
	const { c, wanted } = mk(hist, {});
	eq(ghost("cd co", c), "", "목록 캐시가 없으면 제안 없음");
	ok(wanted.includes(SEARCH), "없는 목록(지금 폴더)은 want 로 부탁", wanted);
	const { c: c2, wanted: w2 } = mk([], {});
	eq(ghost("cd co", c2), "", "기록 없음 + 캐시 없음 → 없음");
	ok(w2.includes(SEARCH), "폴더 이름 제안도 want 로 부탁", w2);
}
// 같은 폴더·같은 맥락에서 친 것은 목록 확인 없이 그대로
{
	const hist: HistEntry[] = [{ cmd: "cd gone/", cwd: SEARCH, ctx: "host" }];
	const { c, wanted } = mk(hist, {});
	eq(ghost("cd g", c), "one/", "같은 자리 기록은 캐시 없이도 그대로");
	eq(wanted, [], "같은 자리 기록은 목록을 부탁하지 않는다");
}
// 경로 판정
{
	eq(pathArgs("docker ps -a"), null, "docker ps — 경로 없음");
	eq(pathArgs("systemctl status nginx"), null, "systemctl status — 경로 없음");
	eq(pathArgs("cd conf/"), ["conf/"], "cd — 인자가 경로");
	eq(pathArgs("cd"), null, "인자 없는 cd 는 경로 없음");
	eq(pathArgs("grep -rn foo src"), ["src"], "grep — 첫 인자(무늬)는 경로 아님");
	eq(pathArgs("chmod -R 755 bin"), ["bin"], "chmod — 권한은 경로 아님");
	eq(pathArgs("tar xzf a.tgz"), ["a.tgz"], "tar 동작 글자는 경로 아님");
	eq(pathArgs("tail -n 100 app.log"), ["app.log"], "숫자는 경로 아님");
	eq(pathArgs("./run.sh start"), ["./run.sh"], "./x 실행은 머리가 경로");
	eq(pathArgs("sudo vim conf/a.yml"), ["conf/a.yml"], "sudo 뒤 명령");
	eq(pathArgs("git checkout feature/x"), null, "git 브랜치는 경로 아님");
	eq(pathArgs("curl https://example.com/a"), null, "주소는 경로 아님");
	eq(pathArgs("kubectl apply -f deploy/app.yaml"), ["deploy/app.yaml"], "그 밖의 명령은 마지막 낱말이 경로처럼 보이면");
	eq(pathArgs("cd conf && ls"), ["conf"], "첫 단순 명령까지만");
}
// 경로 기록의 .. 와 ~
{
	const hist: HistEntry[] = [
		{ cmd: "cd ../shared/lib", cwd: "/x/y", ctx: "host" },
		{ cmd: "cd ~/work", cwd: "/x", ctx: "host" },
	];
	const { c } = mk(hist, { "/srv": [d("search"), d("shared")], [SEARCH]: SEARCH_LIST });
	eq(ghost("cd ../s", c), "hared/lib", "../ 는 지금 폴더의 위에서 첫 마디를 찾는다");
	eq(ghost("cd ~/w", c), "ork", "같은 맥락의 ~ 경로는 폴더와 상관없다");
}
// 기록 저장 — 옛 모양 호환·같은 칸 합치기·상한
{
	eq(readHistory(["ls", { cmd: "cd a", cwd: "/x", ctx: "host" }, 3, null, { cmd: "" }]), [{ cmd: "ls" }, { cmd: "cd a", cwd: "/x", ctx: "host" }], "옛 문자열·새 객체가 섞여도 읽고 모르는 모양은 버린다");
	eq(readHistory("x"), [], "배열이 아니면 빈 기록");
	let l: HistEntry[] = readHistory(["cd conf/", "docker ps"]);
	l = pushHistory(l, { cmd: "docker ps", cwd: "/a", ctx: "host" });
	eq(l.map((x) => x.cmd), ["docker ps", "cd conf/"], "경로 없는 명령은 한 칸(옛 것을 새 자리로)");
	l = pushHistory(l, { cmd: "cd conf/", cwd: "/a", ctx: "host" });
	eq(l.length, 2, "옛 기록은 같은 줄의 새 기록에 자리를 내준다");
	l = pushHistory(l, { cmd: "cd conf/", cwd: "/b", ctx: "host" });
	eq(l.filter((x) => x.cmd === "cd conf/").length, 2, "경로 명령은 폴더가 다르면 따로 둔다");
	l = pushHistory(l, { cmd: "cd conf/", cwd: "/b", ctx: "host" });
	eq(l.filter((x) => x.cmd === "cd conf/").length, 2, "같은 폴더·맥락이면 한 칸");
	const big = Array.from({ length: 600 }, (_, i) => `echo ${i}`);
	eq(readHistory(big).length, 500, "읽을 때도 500개 상한");
	eq(pushHistory(readHistory(big), { cmd: "ls" }).length, 500, "넣어도 500개 상한");
	const merged = mergeHistory([{ cmd: "cd a", cwd: "/x", ctx: "host" }], readHistory(["cd a", "ls"]));
	eq(merged, [{ cmd: "cd a", cwd: "/x", ctx: "host" }, { cmd: "ls" }], "불러온 저장본은 이번 세션 기록 뒤에, 같은 칸은 버린다");
	// 저장 → 읽기 왕복
	eq(readHistory(JSON.parse(JSON.stringify(merged))), merged, "저장 모양 왕복");
}
// Tab 목록 — 다른 폴더·맥락의 경로 기록은 뒤로, 지금 폴더에 없는 cd 기록은 빼기
{
	const hist: HistEntry[] = [
		{ cmd: "cd CHOSUN_AC_KR/", cwd: "/data", ctx: "docker:engine" },
		{ cmd: "cd conf/", cwd: "/data", ctx: "docker:engine" },
		{ cmd: "cd bin", cwd: SEARCH, ctx: "host" },
		{ cmd: "cdrecord", cwd: "/", ctx: "host" },
	];
	const { c } = mk(hist, { [SEARCH]: SEARCH_LIST });
	const r = complete("cd", { ...c, commands: ["cd", "cdrecord"], listDir: c.listDir });
	const labels = r.items.map((x) => x.label);
	ok(!labels.includes("cd CHOSUN_AC_KR/"), "지금 폴더에 없는 cd 기록은 Tab 목록에서 뺀다", labels);
	ok(labels[0] === "cd bin", "같은 폴더 기록이 맨 앞", labels);
	ok(labels.indexOf("cd conf/") > labels.indexOf("cdrecord") && labels.indexOf("cd conf/") === labels.length - 1, "다른 맥락 경로 기록은 명령 후보 뒤", labels);
	ok(r.items.find((x) => x.label === "cd conf/")?.desc === "지난 명령 · 다른 셸", "뒤로 간 기록은 이유를 적는다");
}
// PowerShell — 거르지 않고 같은 폴더 것을 먼저
{
	const hist: HistEntry[] = [
		{ cmd: "cd Projects", cwd: "C:/Users/a/Desktop" },
		{ cmd: "cd Program", cwd: "C:/Users/a" },
	];
	const { c } = mk(hist, {}, { shellKind: "pwsh", cwd: "C:/Users/a", shellCtx: undefined });
	eq(ghost("cd Pro", c), "gram", "PowerShell 은 같은 폴더 것 먼저");
	eq(ghost("cd Proj", c), "ects", "PowerShell 은 다른 폴더 기록도 거르지 않는다");
}

console.log(`term-complete: ${pass} 통과, ${fail} 실패`);
if (fail) process.exit(1);
