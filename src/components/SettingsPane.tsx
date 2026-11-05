import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import iconUrl from "../../assets/icon.svg?url";
import { type AppInfo, api, localShells, type ShellInfo } from "../lib/ipc";
import { defaultLogDir, revealLogDir } from "../lib/sessionLog";
import { HI_COLORS, type HiRule, notifyTermPrefs, PREF_KEYS, parseWords } from "../lib/termPrefs";
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
		void localShells().then(setShellList);
	}, []);
	const [autostart, setAutostart] = useState<boolean | null>(null);
	const [msg, setMsg] = useState("");
	const [autoSave, setAutoSave] = useState(false);
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
		<div className="settings">
			<div className="about">
				<img src={iconUrl} alt="" />
				<div>
					<div className="nm">RuiBotte Shell</div>
					<div className="muted">
						버전 {info?.version ?? "–"} · {info?.portable ? "포터블" : "설치판"} · {info?.os} {info?.arch} · made by RuiBotte
					</div>
				</div>
			</div>

			<h4>업데이트</h4>
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

			<h4>편집기</h4>
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

			<h4>터미널</h4>
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

			<h4>터미널 기록</h4>
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

			<h4>터미널 단어 색칠</h4>
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

			<h4>시작</h4>
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

			<h4>문제 해결</h4>
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
