import { useEffect, useState } from "react";
import { AUTO_SAVE_DEFAULT, type AutoSave, loadAutoSave, onAutoSave, setAutoSave as storeAutoSave } from "../../lib/autoSave";
import { shortcutRows } from "../../lib/shortcuts";
import { PREF_KEYS } from "../../lib/termPrefs";
import { Select } from "../Select";
import { FolderPick, Group, LinkRow, type PageProps, Row, Toggle, useSetting, useTermSetting } from "./ui";

/** 설정 › 편집기 — 자동 저장·미니맵 */
export function EditorPage(_: PageProps) {
	const [autoSave, setAutoSave] = useState<AutoSave>(AUTO_SAVE_DEFAULT);
	useEffect(() => {
		void loadAutoSave().then(setAutoSave);
		return onAutoSave(setAutoSave);
	}, []);
	const change = (next: AutoSave) => {
		setAutoSave(next);
		storeAutoSave(next);
	};
	// 기본 켬 — 편집기와 같은 읽기("0" 만 끔)
	const [minimap, setMinimap] = useSetting("editor.minimap", "1");
	return (
		<>
			<Group title="자동 저장">
				<Row id="editor.autosave">
					<Toggle on={autoSave.on} label="자동 저장" onChange={(v) => change({ ...autoSave, on: v })} />
				</Row>
				<Row id="editor.autosave.when">
					<Select
						size="sm"
						aria-label="자동 저장 시점"
						value={autoSave.when}
						onChange={(v) => change({ ...autoSave, when: v as AutoSave["when"] })}
						options={[
							{ value: "delay", label: "멈추면", hint: "기본" },
							{ value: "blur", label: "포커스가 떠날 때" },
							{ value: "both", label: "둘 다" },
						]}
					/>
				</Row>
				<Row id="editor.autosave.delay">
					<Select
						size="sm"
						aria-label="멈춘 뒤 기다릴 시간"
						value={String(autoSave.delayMs)}
						onChange={(v) => change({ ...autoSave, delayMs: Number(v) })}
						options={[
							{ value: "800", label: "0.8초" },
							{ value: "1500", label: "1.5초", hint: "기본" },
							{ value: "3000", label: "3초" },
							{ value: "5000", label: "5초" },
							{ value: "10000", label: "10초" },
						]}
					/>
				</Row>
			</Group>
			<Group title="보기" foot="글꼴·글자 크기·줄 간격은 설정 › 모양 에 있습니다.">
				<Row id="editor.minimap">
					<Toggle on={minimap !== "0"} label="미니맵" onChange={(v) => setMinimap(v ? "1" : "0")} />
				</Row>
			</Group>
		</>
	);
}

/** 설정 › 파일·전송 — rz/sz */
export function FilesPage(_: PageProps) {
	const [zmOn, setZmOn] = useTermSetting(PREF_KEYS.zmOn, "1");
	const [zmDir, setZmDir] = useTermSetting(PREF_KEYS.zmDir, "");
	return (
		<Group title="rz/sz (ZMODEM)" foot="파일 트리의 끌어 놓기·우클릭 › 올리기 같은 전송은 이 설정과 상관없이 늘 됩니다.">
			<Row id="term.zmodem">
				<Toggle on={zmOn !== "0"} label="rz/sz 파일 주고받기" onChange={(v) => setZmOn(v ? "1" : "0")} />
			</Row>
			{zmOn !== "0" && (
				<Row id="term.zmodem.dir">
					<FolderPick value={zmDir} placeholder="그때그때 고르기" title="sz 로 받을 기본 폴더" onChange={setZmDir} />
				</Row>
			)}
		</Group>
	);
}

/** DB 작업대 도구 줄과 같은 고르기 */
const TIMEOUTS = [
	{ value: "0", label: "시간 상한 없음" },
	{ value: "30000", label: "30초" },
	{ value: "60000", label: "1분" },
	{ value: "300000", label: "5분" },
	{ value: "900000", label: "15분" },
	{ value: "1800000", label: "30분" },
];

/** 설정 › 데이터베이스 — DB 작업대 도구 줄의 스위치들을 한곳에(바꾸면 열린 작업대도 따라간다) */
export function DbPage(_: PageProps) {
	const [timeout, setTimeoutV] = useSetting("db.timeout", "0");
	const [autoLimit, setAutoLimit] = useSetting("db.autoLimit", "0");
	const [confirmWrites, setConfirmWrites] = useSetting("db.confirmWrites", "0");
	const [pageSize, setPageSize] = useSetting("db.pageSize", "1000");
	const [thousands, setThousands] = useSetting("db.thousands", "0");
	const [fmtCase, setFmtCase] = useSetting("db.fmtCase", "upper");
	// 자동완성 — 값 "0" 이면 끔(없으면 켬), 열린 SQL 편집기가 바로 따라간다(sqlComplete 의 SQL_COMPLETE_KEYS·onSettingLive)
	const [cAlias, setCAlias] = useSetting("db.completeAlias", "1");
	const [cQualify, setCQualify] = useSetting("db.completeQualify", "1");
	const [cWords, setCWords] = useSetting("db.completeWords", "1");
	// 작업대와 같은 읽기 — 목록에 없는 값이면 그 값을 그대로 보인다
	const tVal = String(Number(timeout) || 0);
	const pVal = String(Number(pageSize) || 1000);
	return (
		<>
			<Group title="실행" foot="DB 작업대 도구 줄에서도 바꿀 수 있습니다. 연결마다의 읽기 전용은 그 연결의 설정에서 정합니다.">
				<Row id="db.timeout">
					<Select
						size="sm"
						aria-label="문장 시간 상한"
						value={tVal}
						onChange={setTimeoutV}
						options={TIMEOUTS.some((o) => o.value === tVal) ? TIMEOUTS : [...TIMEOUTS, { value: tVal, label: `${Number(tVal) / 1000}초` }]}
					/>
				</Row>
				<Row id="db.autoLimit">
					<Toggle on={autoLimit === "1"} label="자동 LIMIT" onChange={(v) => setAutoLimit(v ? "1" : "0")} />
				</Row>
				<Row id="db.confirmWrites">
					<Toggle on={confirmWrites === "1"} label="쓰기 확인" onChange={(v) => setConfirmWrites(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="결과">
				<Row id="db.pageSize">
					<Select
						size="sm"
						aria-label="표 한 쪽 행 수"
						value={pVal}
						onChange={setPageSize}
						options={["100", "500", "1000", "5000", "10000"].concat(["100", "500", "1000", "5000", "10000"].includes(pVal) ? [] : [pVal]).map((n) => ({ value: n, label: `${Number(n).toLocaleString()}행`, hint: n === "1000" ? "기본" : undefined }))}
					/>
				</Row>
				<Row id="db.thousands">
					<Toggle on={thousands === "1"} label="숫자 천 단위 구분" onChange={(v) => setThousands(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="자동완성" foot="열린 SQL 편집기에 바로 적용됩니다. 이름이 여러 표에 겹치는 열은 열 앞 별칭 붙이기를 꺼도 늘 별칭을 붙입니다.">
				<Row id="db.completeAlias">
					<Toggle on={cAlias !== "0"} label="표를 고르면 별칭 붙이기" onChange={(v) => setCAlias(v ? "1" : "0")} />
				</Row>
				<Row id="db.completeQualify">
					<Toggle on={cQualify !== "0"} label="열 앞에 별칭 붙이기" onChange={(v) => setCQualify(v ? "1" : "0")} />
				</Row>
				<Row id="db.completeWords">
					<Toggle on={cWords !== "0"} label="문서 낱말 제안" onChange={(v) => setCWords(v ? "1" : "0")} />
				</Row>
			</Group>
			<Group title="SQL 정렬">
				<Row id="db.fmtCase">
					<div className="seg tiny" role="group" aria-label="정렬 키워드">
						{(
							[
								["upper", "대문자"],
								["lower", "소문자"],
								["preserve", "그대로"],
							] as const
						).map(([k, l]) => (
							<button key={k} type="button" aria-pressed={(fmtCase === "lower" || fmtCase === "preserve" ? fmtCase : "upper") === k} onClick={() => setFmtCase(k)}>
								{l}
							</button>
						))}
					</div>
				</Row>
			</Group>
		</>
	);
}

const ROUTE_WAITS = [3, 4, 5, 8, 10];
const MINI_EVERY: [string, string][] = [
	["auto", "자동(망 상태 따라)"],
	["5000", "5초마다"],
	["15000", "15초마다"],
	["60000", "1분마다"],
	["off", "끔"],
];

/** 설정 › SSH·보안 — 연결 시간·자원 표시 간격, 키·가져오기·연결 관리로 */
export function SshPage({ onOpen }: PageProps) {
	const [wait, setWait] = useSetting("ssh.routeTimeoutSec", "4");
	const [every, setEvery] = useSetting("monitor.mini.every", "auto");
	const w = String(Number(wait) || 4);
	return (
		<>
			<Group title="연결">
				<Row id="ssh.routeTimeoutSec">
					<Select
						size="sm"
						aria-label="경로마다 기다리기"
						value={w}
						onChange={setWait}
						options={(ROUTE_WAITS.includes(Number(w)) ? ROUTE_WAITS : [...ROUTE_WAITS, Number(w)]).map((n) => ({ value: String(n), label: `${n}초`, hint: n === 4 ? "기본" : undefined }))}
					/>
				</Row>
				<Row id="monitor.mini.every">
					<Select
						size="sm"
						aria-label="서버 자원 읽기 간격"
						value={MINI_EVERY.some(([k]) => k === every) ? every : "auto"}
						onChange={setEvery}
						options={MINI_EVERY.map(([k, l]) => ({ value: k, label: l, hint: k === "auto" ? "기본" : undefined }))}
					/>
				</Row>
			</Group>
			<Group title="키·호스트" foot="처음 접속하는 서버는 호스트 키 지문을 보여 주고 확인을 받은 뒤 기억합니다. known_hosts 를 가져오면 거기 적힌 서버는 묻지 않습니다.">
				<LinkRow id="keys" onClick={() => onOpen("keys")} />
				<LinkRow id="import" onClick={() => onOpen("import")} />
				<LinkRow id="connections" onClick={() => onOpen("connections")} />
			</Group>
		</>
	);
}

/** 설정 › 단축키 — 작업대 F1 도움말과 같은 목록(읽기 전용) */
export function ShortcutsPage(_: PageProps) {
	const mac = document.documentElement.dataset.os === "macos";
	const rows = shortcutRows(mac);
	const groups: { title: string; items: [string, string, number][] }[] = [];
	rows.forEach(([k, v], i) => {
		if (!v) groups.push({ title: k, items: [] });
		else groups[groups.length - 1]?.items.push([k, v, i]);
	});
	return (
		<>
			{groups.map((g) => (
				<Group key={g.title} title={g.title}>
					{g.items.map(([k, v, i]) => (
						<Row key={i} id={`shortcut.${i}`} label={v} sub={null}>
							<kbd className="stg-kbd">{k}</kbd>
						</Row>
					))}
				</Group>
			))}
		</>
	);
}
