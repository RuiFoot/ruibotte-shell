import { useEffect, useState } from "react";
import { localShells, type ShellInfo } from "../../lib/ipc";
import { defaultLogDir, revealLogDir } from "../../lib/sessionLog";
import { HI_COLORS, type HiRule, PREF_KEYS, parseWords } from "../../lib/termPrefs";
import { Select } from "../Select";
import { FolderPick, Group, LinkRow, type PageProps, Row, Toggle, useSetting, useTermSetting } from "./ui";

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
					<span className="hi-swatches" role="group" aria-label={`${w.word} 색`}>
						{HI_COLORS.map((c) => (
							<button
								key={c.value}
								type="button"
								className={`hi-swatch${c.value === w.color ? " on" : ""}`}
								style={{ background: c.value }}
								title={c.label}
								aria-label={c.label}
								aria-pressed={c.value === w.color}
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
				<input className="hi-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="단어(대소문자 무시) — 예: timeout" aria-label="더할 단어" spellCheck={false} />
				<span className="hi-swatches" role="group" aria-label="새 단어 색">
					{HI_COLORS.map((c) => (
						<button
							key={c.value}
							type="button"
							className={`hi-swatch${c.value === color ? " on" : ""}`}
							style={{ background: c.value }}
							title={c.label}
							aria-label={c.label}
							aria-pressed={c.value === color}
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

/** 설정 › 터미널 — 셸·입력·복사·출력, 하위 화면: 단어 색칠·터미널 기록 */
export function TerminalPage({ sub, go, say }: PageProps) {
	const [hiOn, setHiOn] = useTermSetting(PREF_KEYS.hiOn, "1");
	const [hiWords, setHiWords] = useTermSetting(PREF_KEYS.hiWords, "[]");
	const [logAuto, setLogAuto] = useTermSetting(PREF_KEYS.logAuto, "0");
	if (sub === "words")
		return (
			<>
				<Group>
					<Row
						id="term.highlight"
						sub={
							<>
								<span style={{ color: "#ff453a" }}>ERROR · FATAL · …Exception</span> · <span style={{ color: "#ff9f0a" }}>WARN</span> · <span style={{ color: "#0a84ff" }}>INFO</span> — 프로그램이 이미 색을 준 글자와 전체 화면 앱(vim·less)은 그대로 둡니다
							</>
						}
					>
						<Toggle on={hiOn !== "0"} label="로그 단어 색칠" onChange={(v) => setHiOn(v ? "1" : "0")} />
					</Row>
				</Group>
				{hiOn !== "0" && (
					<Group title="내 단어">
						<Row id="term.highlight.words" label="단어와 색" block>
							<WordList words={parseWords(hiWords)} onChange={(w) => setHiWords(JSON.stringify(w))} />
						</Row>
					</Group>
				)}
			</>
		);
	if (sub === "log") return <TermLogPage logAuto={logAuto} setLogAuto={setLogAuto} say={say} />;
	return <TermMain hiOn={hiOn !== "0"} words={parseWords(hiWords).length} logOn={logAuto === "1"} go={go} />;
}

function TermMain({ hiOn, words, logOn, go }: { hiOn: boolean; words: number; logOn: boolean; go: PageProps["go"] }) {
	const [scrollback, setScrollback] = useSetting("term.scrollback", "10000");
	const [copyOnSelect, setCopyOnSelect] = useSetting("term.copyOnSelect", "0");
	const [completeMode, setCompleteMode] = useSetting("term.completeMode", "ghost");
	const [localShell, setLocalShell] = useSetting("term.localShell", "");
	const [tabList, setTabList] = useTermSetting(PREF_KEYS.tabList, "1");
	const [sigHint, setSigHint] = useTermSetting(PREF_KEYS.sigHint, "0");
	const [ctrlVSend, setCtrlVSend] = useTermSetting(PREF_KEYS.ctrlVSend, "0");
	const [noWrap, setNoWrap] = useSetting("term.noWrap", "0");
	const [noWrapHint, setNoWrapHint] = useSetting("term.noWrapHint", "1");
	const [shellList, setShellList] = useState<ShellInfo[]>([]);
	useEffect(() => {
		void localShells().then((l) => setShellList(l ?? []));
	}, []);
	return (
		<>
			<Group title="셸">
				<Row id="term.localShell">
					<Select
						size="sm"
						aria-label="내 PC 기본 셸"
						value={localShell || shellList[0]?.id || ""}
						onChange={setLocalShell}
						options={shellList.filter((x) => !x.admin).map((x) => ({ value: x.id, label: x.label }))}
					/>
				</Row>
				<Row id="term.scrollback">
					<Select
						size="sm"
						aria-label="스크롤백"
						value={scrollback}
						onChange={setScrollback}
						options={["5000", "10000", "50000", "100000"].map((n) => ({ value: n, label: `${Number(n).toLocaleString()}줄` }))}
					/>
				</Row>
			</Group>
			<Group title="입력">
				<Row id="term.completeMode">
					<Select
						size="sm"
						aria-label="자동완성 방식"
						value={completeMode}
						onChange={setCompleteMode}
						options={[
							{ value: "ghost", label: "흐린 제안 + 목록", hint: "기본" },
							{ value: "auto", label: "치다 멈추면 목록" },
							{ value: "tab", label: "목록만(흐린 제안 없음)" },
							{ value: "off", label: "끔(셸 완성만)" },
						]}
					/>
				</Row>
				<Row id="term.tabList">
					<Select
						size="sm"
						aria-label="Tab 키"
						value={tabList === "0" ? "0" : "1"}
						onChange={setTabList}
						options={[
							{ value: "1", label: "앱 목록", hint: "기본" },
							{ value: "0", label: "셸 완성" },
						]}
					/>
				</Row>
				<Row id="term.sigHint">
					<Toggle on={sigHint === "1"} label="명령 서명 줄" onChange={(v) => setSigHint(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="복사·붙여넣기" foot="Ctrl+C 는 고른 글이 있으면 복사, 없으면 ^C(중단)입니다. macOS 는 ⌘C·⌘V 로 복사·붙여넣기하고 Ctrl+C·Ctrl+V 는 늘 서버로 갑니다.">
				<Row id="term.ctrlVSend">
					<Toggle on={ctrlVSend === "1"} label="Ctrl+V 를 서버로 보내기" onChange={(v) => setCtrlVSend(v ? "1" : "0")} />
				</Row>
				<Row id="term.copyOnSelect">
					<Toggle on={copyOnSelect === "1"} label="고르면 바로 복사" onChange={(v) => setCopyOnSelect(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="출력" foot="rz/sz 파일 주고받기는 설정 › 파일·전송 에 있습니다.">
				<Row id="term.noWrap">
					<Toggle on={noWrap === "1"} label="긴 줄 접지 않기(가로 스크롤)" onChange={(v) => setNoWrap(v ? "1" : "0")} />
				</Row>
				{noWrap !== "1" && (
					<Row id="term.noWrapHint">
						<Toggle on={noWrapHint !== "0"} label="접힌 줄 알림" onChange={(v) => setNoWrapHint(v ? "1" : "0")} />
					</Row>
				)}
				<LinkRow id="term.highlight" label="로그 단어 색칠" sub="ERROR·WARN·INFO 와 내 단어에 색" value={hiOn ? (words ? `켬 · 내 단어 ${words}개` : "켬") : "끔"} onClick={() => go("words")} />
				<LinkRow id="term.log.auto" label="터미널 기록" sub="터미널 출력을 파일로 남기기" value={logOn ? "새 터미널마다" : "직접 켤 때만"} onClick={() => go("log")} />
			</Group>
		</>
	);
}

function TermLogPage({ logAuto, setLogAuto, say }: { logAuto: string; setLogAuto: (v: string) => void; say: (m: string) => void }) {
	const [logDir, setLogDir] = useTermSetting(PREF_KEYS.logDir, "");
	const [logStrip, setLogStrip] = useTermSetting(PREF_KEYS.logStrip, "1");
	const [logStamp, setLogStamp] = useTermSetting(PREF_KEYS.logStamp, "0");
	const [logBase, setLogBase] = useState("");
	useEffect(() => {
		void defaultLogDir()
			.then(setLogBase)
			.catch(() => {});
	}, []);
	return (
		<>
			<Group>
				<Row id="term.log.auto">
					<Toggle on={logAuto === "1"} label="새 터미널을 열면 바로 기록" onChange={(v) => setLogAuto(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="기록 파일" foot="설정은 새로 여는 기록부터 적용됩니다. 암호 입력은 화면에 나오지 않으므로 기록에도 남지 않습니다.">
				<Row id="term.log.dir">
					<FolderPick value={logDir} placeholder={logBase || "앱 데이터의 logs"} title="터미널 기록 폴더" onChange={setLogDir} />
				</Row>
				<Row id="term.log.stripAnsi">
					<Toggle on={logStrip !== "0"} label="색 코드 지우기" onChange={(v) => setLogStrip(v ? "1" : "0")} />
				</Row>
				<Row id="term.log.timestamps">
					<Toggle on={logStamp === "1"} label="줄 앞에 시각" onChange={(v) => setLogStamp(v ? "1" : "0")} />
				</Row>
				<Row id="term.log.reveal">
					<button type="button" className="btn" onClick={() => void revealLogDir(logDir).catch((e) => say(String(e)))}>
						열기
					</button>
				</Row>
			</Group>
		</>
	);
}
