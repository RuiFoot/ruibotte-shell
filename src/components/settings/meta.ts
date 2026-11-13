import { ArrowDownUp, Database, FileCode2, Info, Keyboard, type LucideIcon, Palette, Settings, ShieldCheck, SquareTerminal } from "lucide-react";
import { initials, isCho } from "../../lib/hangul";
import { shortcutRows } from "../../lib/shortcuts";

/**
 * 설정 화면의 범주·하위 화면·줄 색인 — 사이드바·검색·바로 가기(openSettings)가 함께 쓴다.
 * 줄 이름·설명은 여기 한 곳에 두고 화면의 <Row id> 가 가져다 그린다(검색 결과와 화면 글이 어긋나지 않게).
 */
export type CatId = "general" | "appearance" | "shortcuts" | "terminal" | "editor" | "files" | "db" | "ssh" | "about";

export type Cat = { id: CatId; label: string; icon: LucideIcon; color: string; keywords: string };

/** 사이드바 — 무리마다 사이를 띄운다 */
export const CAT_GROUPS: Cat[][] = [
	[
		{ id: "general", label: "일반", icon: Settings, color: "#8e8e93", keywords: "시작 자동 실행 업데이트 general" },
		{ id: "appearance", label: "모양", icon: Palette, color: "#5e5ce6", keywords: "화면 테마 색 글꼴 폰트 appearance theme font" },
		{ id: "shortcuts", label: "단축키", icon: Keyboard, color: "#636366", keywords: "키 shortcut keyboard" },
	],
	[
		{ id: "terminal", label: "터미널", icon: SquareTerminal, color: "#3a3a3c", keywords: "셸 terminal shell" },
		{ id: "editor", label: "편집기", icon: FileCode2, color: "#ff9f0a", keywords: "editor 자동 저장" },
		{ id: "files", label: "파일·전송", icon: ArrowDownUp, color: "#30b0c7", keywords: "rz sz zmodem 전송 파일" },
		{ id: "db", label: "데이터베이스", icon: Database, color: "#bf5af2", keywords: "db sql database" },
	],
	[
		{ id: "ssh", label: "SSH·보안", icon: ShieldCheck, color: "#30d158", keywords: "ssh 키 호스트 known_hosts 보안" },
		{ id: "about", label: "정보", icon: Info, color: "#0a84ff", keywords: "버전 about 정보 라이선스" },
	],
];
export const CATS: Cat[] = CAT_GROUPS.flat();
export const catOf = (id: string): Cat | undefined => CATS.find((c) => c.id === id);
export const isCat = (id: string): id is CatId => CATS.some((c) => c.id === id);

/** 하위 화면 — "범주/이름" */
export const SUBS: Record<string, { label: string; keywords?: string }> = {
	"appearance/scheme": { label: "터미널 색 구성", keywords: "color scheme 색" },
	"terminal/words": { label: "단어 색칠", keywords: "강조 highlight error warn" },
	"terminal/log": { label: "터미널 기록", keywords: "로그 log 세션 기록" },
};

export type RowMeta = {
	cat: CatId;
	/** 하위 화면 이름(범주/ 뒤) */
	sub?: string;
	/** 묶음 머리글 — 검색 결과의 길잡이 */
	group?: string;
	label: string;
	desc?: string;
	/** 동의어·영어 */
	kw?: string;
};

/** 설정 줄 하나하나 — 키는 대개 저장 키(setting)와 같다 */
export const ROWS: Record<string, RowMeta> = {
	// 일반
	"session.autoRestore": {
		cat: "general",
		group: "시작",
		label: "켤 때 지난 연결 다시 열기",
		desc: "앱을 끌 때 열려 있던 SSH·DB 탭을 그때 쓴 계정으로 차례로 다시 엽니다 — 암호·지문을 물어야 하면 접속 창이 하나씩 뜹니다",
		kw: "세션 복원 restore 이어서",
	},
	autostart: { cat: "general", group: "시작", label: "로그인할 때 자동 실행", kw: "autostart 부팅 시작 프로그램" },
	"update.status": { cat: "general", group: "소프트웨어 업데이트", label: "업데이트 확인", desc: "지금 버전과 새 버전", kw: "update 버전 새 판 설치" },
	"update.auto": { cat: "general", group: "소프트웨어 업데이트", label: "자동으로 확인", desc: "시작 1분 뒤·6시간마다 GitHub Releases 를 확인하고, 새 판이면 알림을 한 번 띄웁니다", kw: "update auto" },

	// 모양
	"ui.theme": { cat: "appearance", group: "테마", label: "앱 테마", kw: "다크 라이트 밝게 어둡게 dark light theme 시스템" },
	"term.scheme": { cat: "appearance", group: "색", label: "터미널 색 구성", desc: "열린 터미널에 바로 적용됩니다", kw: "color scheme 테마 배경" },
	"editor.syntax": { cat: "appearance", group: "색", label: "편집기 강조 색", desc: "앱 테마를 따라 밝은·어두운 짝으로 바뀝니다(편집기·SQL·비교 공통)", kw: "syntax 문법 강조" },
	"term.scheme.byProfile": { cat: "appearance", sub: "scheme", label: "서버별 터미널 색", kw: "서버마다 프로필" },
	"term.fontFamily": { cat: "appearance", group: "터미널 글꼴", label: "터미널 글꼴", desc: "없는 글꼴이면 앱 기본 고정폭으로 보입니다", kw: "font 폰트 고정폭 D2Coding" },
	"term.fontSize": { cat: "appearance", group: "터미널 글꼴", label: "터미널 글자 크기", desc: "Ctrl+= · − 로 터미널마다 잠깐 바꿀 수 있고, Ctrl+0 은 이 크기로 되돌립니다", kw: "font size 크기" },
	"term.lineHeight": { cat: "appearance", group: "터미널 글꼴", label: "터미널 줄 간격", kw: "line height 행간" },
	"editor.fontFamily": { cat: "appearance", group: "편집기 글꼴", label: "편집기 글꼴", desc: "편집기·비교·SQL 편집기", kw: "font 폰트 고정폭" },
	"editor.fontSize": { cat: "appearance", group: "편집기 글꼴", label: "편집기 글자 크기", kw: "font size 크기" },
	"editor.lineHeight": { cat: "appearance", group: "편집기 글꼴", label: "편집기 줄 간격", kw: "line height 행간" },

	// 터미널
	"term.localShell": { cat: "terminal", group: "셸", label: "내 PC 기본 셸", desc: "내 PC 터미널을 열 때 — 터미널 상태 줄에서 그때그때 바꿀 수도 있습니다", kw: "shell powershell cmd bash wsl zsh" },
	"term.scrollback": { cat: "terminal", group: "셸", label: "스크롤백", desc: "터미널마다 기억하는 줄 수 — 많을수록 메모리를 더 씁니다", kw: "scrollback 줄 수 버퍼" },
	"term.completeMode": { cat: "terminal", group: "입력", label: "자동완성 방식", desc: "새로 여는 터미널부터 적용됩니다", kw: "complete 제안 목록 ghost" },
	"term.tabList": {
		cat: "terminal",
		group: "입력",
		label: "Tab 키",
		desc: "앱 목록: Tab 으로 명령·옵션 설명·경로 목록을 엽니다(후보가 하나면 바로 채우고, 없으면 셸 완성으로). 셸 완성: Tab 은 서버 셸(bash)에 맡기고 앱 목록은 Ctrl+Space 로 엽니다",
		kw: "tab 완성 자동완성",
	},
	"term.sigHint": {
		cat: "terminal",
		group: "입력",
		label: "명령 서명 줄",
		desc: "입력 줄 바로 위에 지금 명령의 옵션·인자 자리를 보입니다(직전 출력 마지막 줄을 가립니다). 조각 풀이(Ctrl+Shift+E)는 꺼도 됩니다",
		kw: "signature 옵션 도움",
	},
	"term.ctrlVSend": {
		cat: "terminal",
		group: "복사·붙여넣기",
		label: "Ctrl+V 를 서버로 보내기(^V)",
		desc: "끄면(기본) Ctrl+V 는 붙여넣기입니다. 켜면 Ctrl+V 가 서버로 ^V(다음 글자 그대로 넣기)로 가고, 붙여넣기는 Ctrl+Shift+V 로 합니다",
		kw: "paste 붙여넣기 ctrl+c 복사",
	},
	"term.copyOnSelect": { cat: "terminal", group: "복사·붙여넣기", label: "고르면 바로 복사", desc: "터미널에서 끌어 고른 글을 곧바로 클립보드로(리눅스 터미널처럼)", kw: "copy 선택 클립보드" },
	"term.noWrap": {
		cat: "terminal",
		group: "출력",
		label: "긴 줄 접지 않기(가로 스크롤)",
		desc: "docker ps 같은 긴 줄을 접지 않고 옆으로 밀어 봅니다(Shift+휠). 열린 터미널에 바로 적용되고, 터미널에서 Alt+Z 로 그 터미널만 바꿀 수 있습니다. vim·less 같은 전체 화면 프로그램 중에는 칸 폭에 맞춥니다",
		kw: "nowrap wrap 줄 바꿈 가로 스크롤 alt+z",
	},
	"term.noWrapHint": { cat: "terminal", group: "출력", label: "접힌 줄 알림", desc: "긴 줄이 처음 접히면 터미널마다 한 번 Alt+Z 를 알립니다", kw: "nowrap 알림 힌트" },
	"term.highlight": {
		cat: "terminal",
		sub: "words",
		label: "로그 단어 색칠",
		desc: "ERROR · FATAL · …Exception · WARN · INFO — 프로그램이 이미 색을 준 글자와 전체 화면 앱(vim·less)은 그대로 둡니다",
		kw: "highlight 강조 error warn",
	},
	"term.highlight.words": { cat: "terminal", sub: "words", label: "내 단어", desc: "더한 단어는 기본 단어보다 먼저 칠합니다", kw: "단어 색 추가" },
	"term.log.auto": {
		cat: "terminal",
		sub: "log",
		label: "새 터미널을 열면 바로 기록",
		desc: "꺼져 있어도 터미널 우클릭 › 이 터미널 기록 시작 으로 그때그때 켤 수 있습니다. 기록 중인 탭에는 ● 가 붙습니다",
		kw: "log 로그 저장",
	},
	"term.log.dir": { cat: "terminal", sub: "log", label: "저장 폴더", desc: "그 아래 서버 이름 폴더에 날짜_시각.log 로 남습니다", kw: "log 폴더 경로" },
	"term.log.stripAnsi": { cat: "terminal", sub: "log", label: "색 코드 지우기", desc: "글자색·커서 이동 같은 제어 코드를 빼고 글만 남깁니다(끄면 cat 으로 다시 볼 때 색이 살아납니다)", kw: "ansi escape" },
	"term.log.timestamps": { cat: "terminal", sub: "log", label: "줄 앞에 시각", desc: "[시:분:초.천분의1] — 출력을 0.25초 단위로 묶어 적어 그만큼 차이가 날 수 있습니다", kw: "timestamp 시간" },
	"term.log.reveal": { cat: "terminal", sub: "log", label: "기록 폴더", desc: "파일 탐색기로 엽니다", kw: "열기 탐색기" },

	// 편집기
	"editor.autosave": {
		cat: "editor",
		group: "자동 저장",
		label: "자동 저장",
		desc: "확인 창 없이 저장합니다. 열고 나서 서버 파일이 바뀌었으면 저장하지 않고 멈춥니다(비교·덮어쓰기는 직접). 편집기 상태 줄에서도 켜고 끌 수 있습니다",
		kw: "autosave save",
	},
	"editor.autosave.when": { cat: "editor", group: "자동 저장", label: "자동 저장 시점", desc: "멈추면: 고치다 손을 멈추고 잠시 뒤 · 포커스가 떠날 때: 다른 칸·다른 앱으로 옮길 때", kw: "autosave blur" },
	"editor.autosave.delay": { cat: "editor", group: "자동 저장", label: "멈춘 뒤 기다릴 시간", desc: "자동 저장 시점이 멈추면·둘 다일 때", kw: "autosave delay 지연" },
	"editor.minimap": { cat: "editor", group: "보기", label: "미니맵", desc: "오른쪽 개요 막대 — 아주 긴 파일(5만 줄 넘음)은 빼고 그립니다. 편집기 상태 줄에서도 켜고 끌 수 있습니다", kw: "minimap 개요" },

	// 파일·전송
	"term.zmodem": {
		cat: "files",
		group: "rz/sz (ZMODEM)",
		label: "rz/sz 파일 주고받기",
		desc: "원격 셸에서 sz 파일 → 내 PC 로 받기, rz → 내 PC 파일 올리기(서버에 lrzsz 가 있어야 함). 전송 중 Ctrl+C 로 멈춤",
		kw: "zmodem lrzsz 전송 다운로드 업로드",
	},
	"term.zmodem.dir": { cat: "files", group: "rz/sz (ZMODEM)", label: "받기 폴더", desc: "비우면 받을 때마다 고릅니다", kw: "다운로드 폴더 sz" },

	// 데이터베이스
	"db.timeout": { cat: "db", group: "실행", label: "문장 시간 상한", desc: "넘으면 멈춥니다(PostgreSQL·MySQL 은 서버가, 그 밖은 앱이 재다가 취소)", kw: "timeout 시간 초과 취소" },
	"db.autoLimit": { cat: "db", group: "실행", label: "자동 LIMIT", desc: "LIMIT 없는 SELECT 에 행 상한을 서버 쪽에도 붙입니다(PostgreSQL·MySQL·MariaDB·Oracle)", kw: "limit 행 상한" },
	"db.confirmWrites": { cat: "db", group: "실행", label: "쓰기 확인", desc: "INSERT·UPDATE·DELETE·DDL·GRANT 를 실행 전에 모두 묻습니다", kw: "confirm 확인 안전 update delete" },
	"db.pageSize": { cat: "db", group: "결과", label: "표 한 쪽 행 수", desc: "표 보기에서 서버에서 쪽 단위로 읽는 행 수", kw: "page size 페이지" },
	"db.thousands": { cat: "db", group: "결과", label: "숫자 천 단위 구분", desc: "결과 표의 숫자를 1,000 처럼 보입니다", kw: "thousands 쉼표 콤마" },
	"db.completeAlias": { cat: "db", group: "자동완성", label: "표를 고르면 별칭 붙이기", desc: "FROM·JOIN 뒤에서 표를 고르면 짧은 별칭(o, c …)을 함께 넣습니다", kw: "complete alias 자동완성 별칭" },
	"db.completeQualify": {
		cat: "db",
		group: "자동완성",
		label: "열 앞에 별칭 붙이기",
		desc: "별칭이 있거나 표가 여럿이면 열을 a.열 로 넣습니다 — 여러 표에 겹치는 이름은 꺼도 붙입니다",
		kw: "complete qualify 자동완성 한정",
	},
	"db.completeWords": { cat: "db", group: "자동완성", label: "문서 낱말 제안", desc: "편집기에 이미 쓴 낱말을 목록 맨 뒤에 함께 냅니다", kw: "complete words 자동완성 낱말" },
	"db.fmtCase": { cat: "db", group: "SQL 정렬", label: "정렬 키워드", desc: "SQL 정렬(Shift+Alt+F)이 SELECT·FROM 같은 키워드를 쓰는 꼴", kw: "format 대문자 소문자 포맷" },

	// SSH·보안
	"ssh.routeTimeoutSec": {
		cat: "ssh",
		group: "연결",
		label: "경로마다 기다리기",
		desc: "경로가 여럿일 때, 한 경로에서 이 시간 안에 SSH 인사가 오지 않으면 다음 경로로 넘어갑니다(모든 서버 공통)",
		kw: "route timeout 경로 점프",
	},
	"monitor.mini.every": { cat: "ssh", group: "연결", label: "서버 자원 읽기 간격", desc: "터미널 상태 줄의 CPU·메모리 작은 표시 — 자동은 망이 느리면 최대 60초까지 늘립니다", kw: "monitor cpu 메모리 모니터" },
	keys: { cat: "ssh", group: "키·호스트", label: "SSH 키 관리", desc: "개인키 만들기·가져오기·공개키 올리기", kw: "key ppk ed25519 공개키" },
	import: { cat: "ssh", group: "키·호스트", label: "연결 가져오기", desc: "~/.ssh/config·known_hosts 와 PuTTY 저장 세션", kw: "import known_hosts putty 호스트 키" },
	connections: { cat: "ssh", group: "키·호스트", label: "연결 관리", desc: "서버·DB 연결 목록과 묶음", kw: "프로필 서버 목록" },

	// 정보
	"about.update": { cat: "about", group: "소프트웨어 업데이트", label: "소프트웨어 업데이트", kw: "update 버전" },
	"about.data": { cat: "about", group: "문제 해결", label: "데이터 폴더", desc: "설정·접속 프로필(app.db)", kw: "data 폴더 app.db" },
	"about.issue": { cat: "about", group: "문제 해결", label: "문제 보고", desc: "GitHub 에 새 이슈 쓰기(버전·OS 를 미리 채움)", kw: "issue bug 버그" },
	"about.releases": { cat: "about", group: "문제 해결", label: "릴리스 노트", desc: "지난 판의 바뀐 점", kw: "release notes 변경" },
	"about.license": { cat: "about", group: "법적 고지", label: "라이선스", desc: "MIT", kw: "license mit" },
	"about.notice": { cat: "about", group: "법적 고지", label: "제3자 고지", desc: "함께 쓰는 오픈 소스와 그 라이선스", kw: "notice open source 오픈소스" },
};

export const rowMeta = (id: string): RowMeta | undefined => ROWS[id];

/** 줄로 가는 경로 */
export const rowPath = (id: string, m: RowMeta) => `${m.cat}${m.sub ? `/${m.sub}` : ""}#${id}`;

export type Hit = { id: string; path: string; label: string; where: string; cat: Cat };

type Entry = Hit & { hay: string; ini: string; lab: string };
let index: Entry[] | null = null;
function buildIndex(): Entry[] {
	const out: Entry[] = [];
	const add = (id: string, path: string, cat: Cat, label: string, where: string, rest: string) => {
		const hay = `${label} ${where} ${rest}`.toLowerCase();
		out.push({ id, path, cat, label, where, hay, ini: initials(hay), lab: label.toLowerCase() });
	};
	for (const c of CATS) add(`cat:${c.id}`, c.id, c, c.label, "범주", c.keywords);
	for (const [k, s] of Object.entries(SUBS)) {
		const c = catOf(k.split("/")[0]) as Cat;
		add(`sub:${k}`, k, c, s.label, c.label, s.keywords ?? "");
	}
	for (const [id, m] of Object.entries(ROWS)) {
		const c = catOf(m.cat) as Cat;
		const where = m.sub ? `${c.label} › ${SUBS[`${m.cat}/${m.sub}`]?.label ?? ""}` : c.label;
		add(id, rowPath(id, m), c, m.label, where, `${m.group ?? ""} ${m.desc ?? ""} ${m.kw ?? ""}`);
	}
	// 단축키 — 설명으로 찾고(예: "붙여넣기"), 키를 함께 보인다
	const sc = catOf("shortcuts") as Cat;
	const mac = document.documentElement.dataset.os === "macos";
	let sec = "";
	shortcutRows(mac).forEach(([k, v], i) => {
		if (!v) {
			sec = k;
			return;
		}
		const id = `shortcut.${i}`;
		add(id, `shortcuts#${id}`, sc, v, `단축키 › ${sec} · ${k}`, k);
	});
	return out;
}

/** 이름·설명·동의어(한글 초성 포함)로 찾기 — 낱말이 모두 들어간 것만, 이름에 걸린 것을 앞으로 */
export function searchSettings(q: string, limit = 40): Hit[] {
	const words = q.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	index ??= buildIndex();
	const scored: [number, Entry][] = [];
	for (const e of index) {
		let score = 0;
		let ok = true;
		for (const w of words) {
			if (e.lab.includes(w)) score += e.lab.startsWith(w) ? 4 : 3;
			else if (e.hay.includes(w)) score += 1;
			else if (isCho(w) && initials(e.lab).includes(w)) score += 2;
			else if (isCho(w) && e.ini.includes(w)) score += 1;
			else {
				ok = false;
				break;
			}
		}
		if (ok) scored.push([score + (e.id.startsWith("cat:") ? 1 : 0), e]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	return scored.slice(0, limit).map(([, e]) => ({ id: e.id, path: e.path, label: e.label, where: e.where, cat: e.cat }));
}
