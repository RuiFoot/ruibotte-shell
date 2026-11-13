import { disable as autostartOff, enable as autostartOn, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import iconUrl from "../../../assets/icon.svg?url";
import { checkNow, installNow, RELEASES, setAuto, useUpdate } from "../../lib/updater";
import { ago, Group, LinkRow, type PageProps, Row, Toggle, useSetting } from "./ui";

const REPO = "https://github.com/RuiFoot/ruibotte-shell";

/** 업데이트 상태 한 줄 글 */
function useUpdateLabel() {
	const u = useUpdate();
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
	return { u, label };
}

/** 설정 › 일반 — 시작·소프트웨어 업데이트 */
export function GeneralPage({ say }: PageProps) {
	const { u, label } = useUpdateLabel();
	const [autoRestore, setAutoRestore] = useSetting("session.autoRestore", "0");
	/** undefined: 읽는 중 · null: 이 환경에서 못 읽음(눌러 보면 실패 글을 보인다 — 지난 판과 같이) */
	const [autostart, setAutostart] = useState<boolean | null | undefined>(undefined);
	useEffect(() => {
		autostartIsOn()
			.then(setAutostart)
			.catch(() => setAutostart(null));
	}, []);
	const notes = u.notes
		?.split("\n")
		.map((l) => l.replace(/^[#*\-\s]+/, "").trim())
		.filter(Boolean)
		.slice(0, 5)
		.join(" · ");
	return (
		<>
			<Group title="시작">
				<Row id="session.autoRestore">
					<Toggle on={autoRestore === "1"} label="켤 때 지난 연결 다시 열기" onChange={(v) => setAutoRestore(v ? "1" : "0")} />
				</Row>
				<Row id="autostart" sub={autostart === null ? "이 환경에서는 바꿀 수 없어요" : undefined}>
					<Toggle
						on={!!autostart}
						label="로그인할 때 자동 실행"
						disabled={autostart === undefined}
						onChange={async (v) => {
							try {
								if (v) await autostartOn();
								else await autostartOff();
								setAutostart(await autostartIsOn());
							} catch (e) {
								say(String(e));
							}
						}}
					/>
				</Row>
			</Group>
			<Group title="소프트웨어 업데이트" foot={<>{u.checkedAt ? `마지막 확인 ${ago(u.checkedAt)}` : "아직 확인하지 않았어요"} · 받은 파일은 서명을 확인한 뒤에만 설치합니다</>}>
				<Row id="update.status" label={label} sub={u.phase === "available" ? notes : null}>
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
					<div className="stg-row">
						<div className="xfer-row" style={{ border: 0, flex: 1, padding: 0 }}>
							<div className="bar">
								<i style={{ transform: `scaleX(${(u.pct ?? 0) / 100})` }} />
							</div>
						</div>
					</div>
				)}
				<Row id="update.auto">
					<Toggle on={u.auto} onChange={(v) => void setAuto(v)} label="자동으로 확인" />
				</Row>
				{u.portable && <Row id="update.portable" label="포터블판" sub="자동 설치 대신 릴리스 페이지에서 새 exe 를 받아 바꿔 쓰세요. 자료는 exe 옆 폴더에 남습니다." />}
			</Group>
		</>
	);
}

/** 설정 › 정보 — 버전·문제 해결·법적 고지 */
export function AboutPage({ info, goto }: PageProps) {
	const { label } = useUpdateLabel();
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
		void openUrl(`${REPO}/issues/new?title=${encodeURIComponent("[문제] ")}&body=${encodeURIComponent(body)}`);
	};
	return (
		<>
			<div className="stg-about">
				<img src={iconUrl} alt="" />
				<div className="nm">RuiBotte Shell</div>
				<div className="ver">버전 {info?.version ?? "–"}</div>
				<div className="muted">
					{info?.portable ? "포터블" : "설치판"} · {info?.os} {info?.arch} · made by RuiBotte
				</div>
			</div>
			<Group>
				<LinkRow id="about.update" value={label} sub={null} onClick={() => goto("general#update.status")} />
			</Group>
			<Group title="문제 해결">
				<Row id="about.data" sub={info?.dataPath ?? "설정·접속 프로필(app.db)"}>
					<button type="button" className="btn" disabled={!info} onClick={() => info && void revealItemInDir(info.dataPath)}>
						열기
					</button>
				</Row>
				<Row id="about.issue">
					<button type="button" className="btn" onClick={issue}>
						보고하기 ›
					</button>
				</Row>
				<Row id="about.releases">
					<button type="button" className="btn" onClick={() => void openUrl(RELEASES)}>
						열기 ›
					</button>
				</Row>
			</Group>
			<Group title="법적 고지">
				<Row id="about.license">
					<button type="button" className="btn" onClick={() => void openUrl(`${REPO}/blob/main/LICENSE`)}>
						보기 ›
					</button>
				</Row>
				<Row id="about.notice">
					<button type="button" className="btn" onClick={() => void openUrl(`${REPO}/blob/main/NOTICE.md`)}>
						보기 ›
					</button>
				</Row>
			</Group>
		</>
	);
}
