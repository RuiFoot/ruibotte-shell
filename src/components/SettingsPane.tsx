import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import iconUrl from "../../assets/icon.svg?url";
import { askText } from "../lib/ask";
import { SETTINGS_GOTO_EVENT, type SettingsSection, takeSettingsSection } from "../lib/commands";
import { type AppInfo, api, localShells, type ShellInfo } from "../lib/ipc";
import { defaultLogDir, revealLogDir } from "../lib/sessionLog";
import { HI_COLORS, type HiRule, notifyTermPrefs, PREF_KEYS, parseWords } from "../lib/termPrefs";
import { type AppTheme, getAppearance, isDark, MONO_FONTS, onAppearance, setAppearance, TERM_SCHEMES, type TermScheme, termFontFamily, termTheme } from "../lib/theme";
import { checkNow, installNow, RELEASES, setAuto, useUpdate } from "../lib/updater";
import { Select } from "./Select";

function ago(ms: number) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "방금";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86400)}일 전`;
}

function Row({ label, sub, children }: { label: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
	return (
		<div className="set-row">
			<div className="set-text">
				<div>{label}</div>
				{sub && <small>{sub}</small>}
			</div>
			{children}
		</div>
	);
}

/** 앱 설정 한 칸 — 앱 DB(setting) 에 문자열로 둔다 */
function useSetting(key: string, def: string): [string, (v: string) => void] {
	const [v, setV] = useState(def);
	useEffect(() => {
		void api.settingGet(key).then((x) => x && setV(x));
	}, [key]);
	return [
		v,
		(x: string) => {
			setV(x);
			void api.settingSet(key, x);
		},
	];
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className="toggle" onClick={() => onChange(!on)}>
			<i />
		</button>
	);
}

/** 터미널 설정 한 칸 — 바꾸면 열린 터미널에 바로 알린다 */
function useTermSetting(key: string, def: string): [string, (v: string) => void] {
	const [v, set] = useSetting(key, def);
	return [
		v,
		(x: string) => {
			set(x);
			window.setTimeout(notifyTermPrefs, 50);
		},
	];
}

/** 폴더 칸 — 비우면 기본(placeholder) */
function FolderPick({ value, placeholder, onChange, title }: { value: string; placeholder: string; onChange: (v: string) => void; title: string }) {
	return (
		<div className="folder-pick">
			<span className={value ? "fp-path" : "fp-path muted"} title={value || placeholder}>
				{value || placeholder}
			</span>
			<button
				type="button"
				className="btn"
				onClick={async () => {
					const d = await openDialog({ directory: true, multiple: false, title, defaultPath: value || undefined });
					if (typeof d === "string") onChange(d);
				}}
			>
				바꾸기
			</button>
			{value && (
				<button type="button" className="btn ghost" onClick={() => onChange("")} title="기본으로">
					기본
				</button>
			)}
		</div>
	);
}

/** 사용자 단어·색 목록 */
function WordList({ words, onChange }: { words: HiRule[]; onChange: (w: HiRule[]) => void }) {
	const [draft, setDraft] = useState("");
	const [color, setColor] = useState(HI_COLORS[3].value);
	const add = () => {
		const w = draft.trim();
		if (!w || words.some((x) => x.word.toLowerCase() === w.toLowerCase())) return;
		onChange([...words, { word: w, color }]);
		setDraft("");
	};
	return (
		<div className="hi-words">
			{words.map((w, i) => (
				<div className="hi-word" key={w.word}>
					<span className="hi-sample" style={{ color: w.color }}>
						{w.word}
					</span>
					<span className="hi-swatches">
						{HI_COLORS.map((c) => (
							<button
								key={c.value}
								type="button"
								className={`hi-swatch${c.value === w.color ? " on" : ""}`}
								style={{ background: c.value }}
								title={c.label}
								aria-label={c.label}
								onClick={() => onChange(words.map((x, j) => (j === i ? { ...x, color: c.value } : x)))}
							/>
						))}
					</span>
					<button type="button" className="btn ghost" onClick={() => onChange(words.filter((_, j) => j !== i))}>
						빼기
					</button>
				</div>
			))}
			<form
				className="hi-word"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<input className="hi-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="단어(대소문자 무시) — 예: timeout" spellCheck={false} />
				<span className="hi-swatches">
					{HI_COLORS.map((c) => (
						<button
							key={c.value}
							type="button"
							className={`hi-swatch${c.value === color ? " on" : ""}`}
							style={{ background: c.value }}
							title={c.label}
							aria-label={c.label}
							onClick={() => setColor(c.value)}
						/>
					))}
				</span>
				<button type="submit" className="btn" disabled={!draft.trim()}>
					더하기
				</button>
			</form>
		</div>
	);
}

/** 화면 설정을 읽고, 바뀌면 다시 그리기 */
function useAppearance() {
	const [, setTick] = useState(0);
	useEffect(() => onAppearance(() => setTick((t) => t + 1)), []);
	return getAppearance();
}

/** 고정폭 글꼴 고르기 — 목록 + 직접 넣기 */
function FontSelect({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
	const CUSTOM = "\u0000custom";
	const known = value === "" || MONO_FONTS.includes(value);
	return (
		<Select
			size="sm"
			value={value}
			title={title}
			onChange={(v) => {
				if (v !== CUSTOM) return onChange(v);
				void askText({ title, message: "내 PC 에 깔린 고정폭 글꼴 이름(없으면 앱 기본 글꼴로 보입니다)", value, placeholder: "예: D2Coding ligature", okLabel: "쓰기", allowEmpty: true }).then((x) => {
					if (x !== null) onChange(x.trim());
				});
			}}
			options={[
				{ value: "", label: "앱 기본(고정폭)" },
				...(known ? [] : [{ value, label: value, hint: "직접 넣음" }]),
				...MONO_FONTS.map((f) => ({ value: f, label: f })),
				{ value: CUSTOM, label: "직접 넣기…" },
			]}
		/>
	);
}

/** 터미널 색 구성 미리보기 카드 */
function SchemeCard({ s, on, onPick }: { s: TermScheme; on: boolean; onPick: () => void }) {
	// 기본은 지금 앱 테마의 터미널 색
	const t = s.theme ?? termTheme(null, { ...getAppearance(), termScheme: "default", byProfile: {} });
	const c = (k: keyof typeof t, def: string) => (t[k] as string | undefined) ?? def;
	return (
		<button type="button" className={`scheme-card${on ? " on" : ""}`} aria-pressed={on} onClick={onPick} title={s.label}>
			<span className="scheme-screen" style={{ background: t.background, color: t.foreground, fontFamily: termFontFamily() }}>
				<span>
					<b style={{ color: c("green", "#30d158") }}>rui@web</b>:<b style={{ color: c("blue", "#0a84ff") }}>~/app</b>$ ls
				</span>
				<span>
					<span style={{ color: c("blue", "#0a84ff") }}>logs</span> <span style={{ color: c("green", "#30d158") }}>run.sh</span> <span style={{ color: c("red", "#ff453a") }}>ERROR</span> <span style={{ color: c("yellow", "#ffd60a") }}>WARN</span>
				</span>
				<span className="scheme-swatches">
					{(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const).map((k) => (
						<i key={k} style={{ background: c(k, "transparent") }} />
					))}
				</span>
			</span>
			<span className="scheme-name">{s.label}</span>
		</button>
	);
}

const SIZES = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) => ({ value: String(n), label: `${n}px` }));

/** 설정 › 화면 — 앱 테마·터미널 색 구성·편집기 강조 색·글꼴 */
function AppearanceSettings() {
	const a = useAppearance();
	const overrides = Object.keys(a.byProfile).length;
	return (
		<>
			<div className="set-group">
				<Row label="앱 테마" sub={a.app === "system" ? `시스템을 따릅니다 — 지금 ${isDark(a) ? "어둡게" : "밝게"}` : "앱만 이 밝기로 고정합니다"}>
					<div className="seg tiny" role="group" aria-label="앱 테마">
						{(
							[
								["system", "시스템 따라"],
								["light", "밝게"],
								["dark", "어둡게"],
							] as [AppTheme, string][]
						).map(([k, l]) => (
							<button key={k} type="button" aria-pressed={a.app === k} onClick={() => setAppearance({ app: k })}>
								{l}
							</button>
						))}
					</div>
				</Row>
				<div className="set-row">
					<div className="set-text">
						<div>터미널 색 구성</div>
						<small>
							열린 터미널에 바로 적용됩니다. 서버마다 다르게 하려면 서버 설정 › 터미널 색{overrides ? ` — 지금 ${overrides}개 서버가 따로 씀` : ""}
						</small>
						<div className="scheme-grid">
							{TERM_SCHEMES.map((s) => (
								<SchemeCard key={s.id} s={s} on={a.termScheme === s.id} onPick={() => setAppearance({ termScheme: s.id })} />
							))}
						</div>
					</div>
				</div>
				{overrides > 0 && (
					<Row label="서버별 터미널 색" sub={`${overrides}개 서버가 자기 색 구성을 씁니다`}>
						<button type="button" className="btn" onClick={() => confirm("서버마다 고른 터미널 색을 모두 지우고 위 색 구성을 따르게 할까요?") && setAppearance({ byProfile: {} })}>
							모두 앱 설정 따르기
						</button>
					</Row>
				)}
				<div className="set-row">
					<div className="set-text">
						<div>편집기 강조 색</div>
						<small>앱 테마를 따라 밝은·어두운 짝으로 바뀝니다(편집기·SQL·비교 공통)</small>
						<pre className="syn-preview" style={{ fontFamily: "var(--editor-font)" }}>
							<span style={{ color: "var(--syn-comment)", fontStyle: "italic" }}>{"// 오래된 기록 지우기"}</span>
							{"\n"}
							<span style={{ color: "var(--syn-keyword)" }}>const</span> <span style={{ color: "var(--syn-var)" }}>days</span> <span style={{ color: "var(--syn-punct)" }}>=</span> <span style={{ color: "var(--syn-number)" }}>30</span>
							<span style={{ color: "var(--syn-punct)" }}>;</span>
							{"\n"}
							<span style={{ color: "var(--syn-func)" }}>cleanup</span>
							<span style={{ color: "var(--syn-punct)" }}>(</span>
							<span style={{ color: "var(--syn-string)" }}>"/var/log/app"</span>
							<span style={{ color: "var(--syn-punct)" }}>, {"{"} </span>
							<span style={{ color: "var(--syn-prop)" }}>days</span>
							<span style={{ color: "var(--syn-punct)" }}> {"}"});</span>
						</pre>
					</div>
				</div>
			</div>
			<div className="set-group">
				<Row label="터미널 글꼴" sub="없는 글꼴이면 앱 기본 고정폭으로 보입니다">
					<FontSelect value={a.termFont} title="터미널 글꼴" onChange={(v) => setAppearance({ termFont: v })} />
				</Row>
				<Row label="터미널 글자 크기" sub="Ctrl+= · − 로 터미널마다 잠깐 바꿀 수 있고, Ctrl+0 은 이 크기로 되돌립니다">
					<Select size="sm" value={String(a.termSize)} onChange={(v) => setAppearance({ termSize: Number(v) })} options={SIZES(9, 24)} />
				</Row>
				<Row label="터미널 줄 간격">
					<Select size="sm" value={String(a.termLine)} onChange={(v) => setAppearance({ termLine: Number(v) })} options={["1", "1.1", "1.15", "1.2", "1.3", "1.4", "1.5"].map((x) => ({ value: x, label: x === "1.15" ? "1.15 (기본)" : x }))} />
				</Row>
				<Row label="편집기 글꼴" sub="편집기·비교·SQL 편집기">
					<FontSelect value={a.editorFont} title="편집기 글꼴" onChange={(v) => setAppearance({ editorFont: v })} />
				</Row>
				<Row label="편집기 글자 크기">
					<Select size="sm" value={String(a.editorSize)} onChange={(v) => setAppearance({ editorSize: Number(v) })} options={SIZES(10, 22).map((o) => (o.value === "13" ? { ...o, label: "13px (기본)" } : o))} />
				</Row>
				<Row label="편집기 줄 간격">
					<Select size="sm" value={String(a.editorLine)} onChange={(v) => setAppearance({ editorLine: Number(v) })} options={["1.3", "1.4", "1.5", "1.55", "1.6", "1.7", "1.8"].map((x) => ({ value: x, label: x === "1.55" ? "1.55 (기본)" : x }))} />
				</Row>
			</div>
		</>
	);
}

/** 설정 › 정보 — 업데이트·자동 실행·문제 해결(ruibotte-deck 정보 화면과 같은 흐름) */
export function SettingsPane({ info }: { info: AppInfo | null }) {
	const u = useUpdate();
	const [scrollback, setScrollback] = useSetting("term.scrollback", "10000");
	const [copyOnSelect, setCopyOnSelect] = useSetting("term.copyOnSelect", "0");
	const [completeMode, setCompleteMode] = useSetting("term.completeMode", "ghost");
	const [localShell, setLocalShell] = useSetting("term.localShell", "");
	const [logAuto, setLogAuto] = useTermSetting(PREF_KEYS.logAuto, "0");
	const [logDir, setLogDir] = useTermSetting(PREF_KEYS.logDir, "");
	const [logStrip, setLogStrip] = useTermSetting(PREF_KEYS.logStrip, "1");
	const [logStamp, setLogStamp] = useTermSetting(PREF_KEYS.logStamp, "0");
	const [hiOn, setHiOn] = useTermSetting(PREF_KEYS.hiOn, "1");
	const [hiWords, setHiWords] = useTermSetting(PREF_KEYS.hiWords, "[]");
	const [zmOn, setZmOn] = useTermSetting(PREF_KEYS.zmOn, "1");
	const [zmDir, setZmDir] = useTermSetting(PREF_KEYS.zmDir, "");
	const [logBase, setLogBase] = useState("");
	useEffect(() => {
		void defaultLogDir()
			.then(setLogBase)
			.catch(() => {});
	}, []);
	const [shellList, setShellList] = useState<ShellInfo[]>([]);
	useEffect(() => {
		void localShells().then((l) => setShellList(l ?? []));
	}, []);
	const [autostart, setAutostart] = useState<boolean | null>(null);
	const [msg, setMsg] = useState("");
	const [autoSave, setAutoSave] = useState(false);
	// 명령 팔레트에서 "설정 › 화면" 등으로 바로 — 그 묶음 제목으로 스크롤하고 잠깐 강조
	const root = useRef<HTMLDivElement>(null);
	const [flash, setFlash] = useState<SettingsSection | null>(null);
	useEffect(() => {
		const go = (id: SettingsSection | null) => {
			if (!id) return;
			requestAnimationFrame(() => root.current?.querySelector(`#set-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
			setFlash(id);
			window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
		};
		go(takeSettingsSection());
		const on = () => go(takeSettingsSection());
		window.addEventListener(SETTINGS_GOTO_EVENT, on);
		return () => window.removeEventListener(SETTINGS_GOTO_EVENT, on);
	}, []);
	const h4 = (id: SettingsSection, text: string) => (
		<h4 id={`set-${id}`} className={flash === id ? "flash" : undefined}>
			{text}
		</h4>
	);
	useEffect(() => {
		void api.settingGet("editor.autosave").then((v) => setAutoSave(v === "1"));
	}, []);

	useEffect(() => {
		autostartIsOn()
			.then(setAutostart)
			.catch(() => setAutostart(null));
	}, []);

	const label =
		u.phase === "checking"
			? "확인 중…"
			: u.phase === "downloading"
				? `${u.latest} 받는 중… ${u.pct ?? 0}%`
				: u.phase === "installing"
					? `${u.latest} 설치 중 — 앱이 잠깐 꺼졌다가 다시 켜져요`
					: u.phase === "available"
						? `새 버전 ${u.latest} 이(가) 있어요`
						: u.phase === "error"
							? (u.error ?? "확인 실패")
							: u.phase === "uptodate"
								? `최신 버전이에요 (${u.current})`
								: `지금 버전 ${u.current}`;
	const notes = u.notes
		?.split("\n")
		.map((l) => l.replace(/^[#*\-\s]+/, "").trim())
		.filter(Boolean)
		.slice(0, 5)
		.join(" · ");

	const issue = () => {
		const body = [
			`- 버전: ${info?.version ?? "?"} (${info?.portable ? "포터블" : "설치판"})`,
			`- OS: ${info?.os ?? "?"} ${info?.arch ?? ""}`,
			"",
			"## 어떤 문제인가요?",
			"",
			"## 어떻게 하면 생기나요?",
			"",
			"<!-- 서버 주소·계정·회사 이름 같은 정보는 지우고 올려 주세요. -->",
		].join("\n");
		void openUrl(`https://github.com/RuiFoot/ruibotte-shell/issues/new?title=${encodeURIComponent("[문제] ")}&body=${encodeURIComponent(body)}`);
	};

	return (
		<div className="settings" ref={root}>
			<div className="about">
				<img src={iconUrl} alt="" />
				<div>
					<div className="nm">RuiBotte Shell</div>
					<div className="muted">
						버전 {info?.version ?? "–"} · {info?.portable ? "포터블" : "설치판"} · {info?.os} {info?.arch} · made by RuiBotte
					</div>
				</div>
			</div>

			{h4("update", "업데이트")}
			<div className="set-group">
				<Row label={label} sub={u.phase === "available" ? notes : undefined}>
					{u.phase === "available" ? (
						<button type="button" className="btn primary" onClick={() => void installNow()}>
							{u.portable ? "새 파일 받기 ›" : "지금 업데이트"}
						</button>
					) : (
						<button type="button" className="btn" disabled={u.phase === "checking" || u.phase === "downloading" || u.phase === "installing"} onClick={() => void checkNow(true)}>
							{u.phase === "checking" ? "확인 중…" : "확인"}
						</button>
					)}
				</Row>
				{u.phase === "downloading" && (
					<div className="set-row">
						<div className="xfer-row" style={{ border: 0, flex: 1, padding: 0 }}>
							<div className="bar">
								<i style={{ width: `${u.pct ?? 0}%` }} />
							</div>
						</div>
					</div>
				)}
				<Row label="자동으로 확인" sub="시작 1분 뒤·6시간마다 GitHub Releases 를 확인하고, 새 판이면 알림을 한 번 띄웁니다">
					<Toggle on={u.auto} onChange={(v) => void setAuto(v)} label="자동으로 확인" />
				</Row>
				{u.portable && <Row label="포터블판" sub="자동 설치 대신 릴리스 페이지에서 새 exe 를 받아 바꿔 쓰세요. 자료는 exe 옆 폴더에 남습니다." />}
			</div>
			<p className="set-foot">
				{u.checkedAt ? `마지막 확인 ${ago(u.checkedAt)}` : "아직 확인하지 않았어요"} · 받은 파일은 서명을 확인한 뒤에만 설치합니다
			</p>

			{h4("appearance", "화면")}
			<AppearanceSettings />

			{h4("editor", "편집기")}
			<div className="set-group">
				<Row label="자동 저장" sub="고친 뒤 1.5초 멈추면 저장(읽기 전용·충돌은 제외). 새로 여는 파일부터 적용됩니다">
					<Toggle
						on={autoSave}
						label="자동 저장"
						onChange={(v) => {
							setAutoSave(v);
							void api.settingSet("editor.autosave", v ? "1" : "0");
						}}
					/>
				</Row>
			</div>

			{h4("terminal", "터미널")}
			<div className="set-group">
				<Row label="내 PC 기본 셸" sub="내 PC 터미널을 열 때 — 터미널 상태 줄에서 그때그때 바꿀 수도 있습니다">
					<Select
						size="sm"
						value={localShell || shellList[0]?.id || ""}
						onChange={setLocalShell}
						options={shellList.filter((x) => !x.admin).map((x) => ({ value: x.id, label: x.label }))}
					/>
				</Row>
				<Row label="자동완성 방식" sub="새로 여는 터미널부터 적용됩니다">
					<Select
						size="sm"
						value={completeMode}
						onChange={setCompleteMode}
						options={[
							{ value: "ghost", label: "흐린 제안 + Tab 목록", hint: "기본" },
							{ value: "auto", label: "치다 멈추면 목록" },
							{ value: "tab", label: "Tab 목록만" },
							{ value: "off", label: "끔(셸 완성만)" },
						]}
					/>
				</Row>
				<Row label="스크롤백" sub="터미널마다 기억하는 줄 수 — 많을수록 메모리를 더 씁니다">
					<Select
						size="sm"
						value={scrollback}
						onChange={setScrollback}
						options={["5000", "10000", "50000", "100000"].map((n) => ({ value: n, label: `${Number(n).toLocaleString()}줄` }))}
					/>
				</Row>
				<Row label="고르면 바로 복사" sub="터미널에서 끌어 고른 글을 곧바로 클립보드로(리눅스 터미널처럼)">
					<Toggle on={copyOnSelect === "1"} label="고르면 바로 복사" onChange={(v) => setCopyOnSelect(v ? "1" : "0")} />
				</Row>
				<Row label="rz/sz 파일 주고받기" sub="원격 셸에서 sz 파일 → 내 PC 로 받기, rz → 내 PC 파일 올리기(서버에 lrzsz 가 있어야 함). 전송 중 Ctrl+C 로 멈춤">
					<Toggle on={zmOn !== "0"} label="rz/sz 파일 주고받기" onChange={(v) => setZmOn(v ? "1" : "0")} />
				</Row>
				{zmOn !== "0" && (
					<Row label="받기 폴더" sub="비우면 받을 때마다 고릅니다">
						<FolderPick value={zmDir} placeholder="그때그때 고르기" title="sz 로 받을 기본 폴더" onChange={setZmDir} />
					</Row>
				)}
			</div>

			{h4("termlog", "터미널 기록")}
			<div className="set-group">
				<Row label="새 터미널을 열면 바로 기록" sub="꺼져 있어도 터미널 우클릭 › 이 터미널 기록 시작 으로 그때그때 켤 수 있습니다. 기록 중인 탭에는 ● 가 붙습니다">
					<Toggle on={logAuto === "1"} label="새 터미널을 열면 바로 기록" onChange={(v) => setLogAuto(v ? "1" : "0")} />
				</Row>
				<Row label="저장 폴더" sub="그 아래 서버 이름 폴더에 날짜_시각.log 로 남습니다">
					<FolderPick value={logDir} placeholder={logBase || "앱 데이터의 logs"} title="터미널 기록 폴더" onChange={setLogDir} />
				</Row>
				<Row label="색 코드 지우기" sub="글자색·커서 이동 같은 제어 코드를 빼고 글만 남깁니다(끄면 cat 으로 다시 볼 때 색이 살아납니다)">
					<Toggle on={logStrip !== "0"} label="색 코드 지우기" onChange={(v) => setLogStrip(v ? "1" : "0")} />
				</Row>
				<Row label="줄 앞에 시각" sub="[시:분:초.천분의1] — 출력을 0.25초 단위로 묶어 적어 그만큼 차이가 날 수 있습니다">
					<Toggle on={logStamp === "1"} label="줄 앞에 시각" onChange={(v) => setLogStamp(v ? "1" : "0")} />
				</Row>
				<Row label="기록 폴더" sub="파일 탐색기로 엽니다">
					<button type="button" className="btn" onClick={() => void revealLogDir(logDir).catch((e) => setMsg(String(e)))}>
						열기
					</button>
				</Row>
			</div>
			<p className="set-foot">설정은 새로 여는 기록부터 적용됩니다. 암호 입력은 화면에 나오지 않으므로 기록에도 남지 않습니다.</p>

			{h4("highlight", "터미널 단어 색칠")}
			<div className="set-group">
				<Row
					label="로그 단어 색칠"
					sub={
						<>
							<span style={{ color: "#ff453a" }}>ERROR · FATAL · …Exception</span> · <span style={{ color: "#ff9f0a" }}>WARN</span> · <span style={{ color: "#0a84ff" }}>INFO</span> — 프로그램이 이미 색을 준 글자와 전체 화면 앱(vim·less)은 그대로 둡니다
						</>
					}
				>
					<Toggle on={hiOn !== "0"} label="로그 단어 색칠" onChange={(v) => setHiOn(v ? "1" : "0")} />
				</Row>
				{hiOn !== "0" && (
					<div className="set-row">
						<div className="set-text">
							<div>내 단어</div>
							<small>더한 단어는 기본 단어보다 먼저 칠합니다</small>
							<WordList words={parseWords(hiWords)} onChange={(w) => setHiWords(JSON.stringify(w))} />
						</div>
					</div>
				)}
			</div>

			{h4("start", "시작")}
			<div className="set-group">
				<Row label="로그인할 때 자동 실행" sub={autostart === null ? "이 환경에서는 바꿀 수 없어요" : undefined}>
					<Toggle
						on={!!autostart}
						label="로그인할 때 자동 실행"
						onChange={async (v) => {
							try {
								if (v) await autostartOn();
								else await autostartOff();
								setAutostart(await autostartIsOn());
							} catch (e) {
								setMsg(String(e));
							}
						}}
					/>
				</Row>
			</div>

			{h4("help", "문제 해결")}
			<div className="set-group">
				<Row label="데이터 폴더" sub={info?.dataPath ?? "설정·접속 프로필(app.db)"}>
					<button type="button" className="btn" onClick={() => info && void revealItemInDir(info.dataPath)}>
						열기
					</button>
				</Row>
				<Row label="문제 보고" sub="GitHub 에 새 이슈 쓰기(버전·OS 를 미리 채움)">
					<button type="button" className="btn" onClick={issue}>
						보고하기 ›
					</button>
				</Row>
				<Row label="릴리스 노트" sub="지난 판의 바뀐 점">
					<button type="button" className="btn" onClick={() => void openUrl(RELEASES)}>
						열기 ›
					</button>
				</Row>
			</div>
			{msg && <p className="err">{msg}</p>}
		</div>
	);
}
