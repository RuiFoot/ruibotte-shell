import { type AppTheme, getAppearance, isDark, setAppearance, TERM_SCHEMES, type TermScheme, termFontFamily, termTheme } from "../../lib/theme";
import { Select } from "../Select";
import { FontSelect, Group, LinkRow, type PageProps, Row, SIZES, useAppearance } from "./ui";

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

/** 편집기 강조 색 미리보기 */
function SyntaxPreview() {
	return (
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
	);
}

/** 설정 › 모양 — 앱 테마·터미널 색 구성·편집기 강조 색·글꼴 */
export function AppearancePage({ sub, go }: PageProps) {
	const a = useAppearance();
	const overrides = Object.keys(a.byProfile).length;
	if (sub === "scheme")
		return (
			<>
				<Group foot={`열린 터미널에 바로 적용됩니다. 서버마다 다르게 하려면 서버 설정 › 터미널 색${overrides ? ` — 지금 ${overrides}개 서버가 따로 씀` : ""}`}>
					<div className="stg-row block" data-set-id="term.scheme">
						<div className="scheme-grid" role="group" aria-label="터미널 색 구성">
							{TERM_SCHEMES.map((s) => (
								<SchemeCard key={s.id} s={s} on={a.termScheme === s.id} onPick={() => setAppearance({ termScheme: s.id })} />
							))}
						</div>
					</div>
				</Group>
				{overrides > 0 && (
					<Group>
						<Row id="term.scheme.byProfile" sub={`${overrides}개 서버가 자기 색 구성을 씁니다`}>
							<button type="button" className="btn" onClick={() => confirm("서버마다 고른 터미널 색을 모두 지우고 위 색 구성을 따르게 할까요?") && setAppearance({ byProfile: {} })}>
								모두 앱 설정 따르기
							</button>
						</Row>
					</Group>
				)}
			</>
		);
	const scheme = TERM_SCHEMES.find((s) => s.id === a.termScheme)?.label ?? a.termScheme;
	return (
		<>
			<Group title="테마">
				<Row id="ui.theme" sub={a.app === "system" ? `시스템을 따릅니다 — 지금 ${isDark(a) ? "어둡게" : "밝게"}` : "앱만 이 밝기로 고정합니다"}>
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
			</Group>
			<Group title="색">
				<LinkRow id="term.scheme" sub={overrides ? `열린 터미널에 바로 적용됩니다 · ${overrides}개 서버는 따로 씀` : undefined} value={scheme} onClick={() => go("scheme")} />
				<Row id="editor.syntax" block>
					<SyntaxPreview />
				</Row>
			</Group>
			<Group title="터미널 글꼴">
				<Row id="term.fontFamily">
					<FontSelect value={a.termFont} title="터미널 글꼴" onChange={(v) => setAppearance({ termFont: v })} />
				</Row>
				<Row id="term.fontSize">
					<Select size="sm" aria-label="터미널 글자 크기" value={String(a.termSize)} onChange={(v) => setAppearance({ termSize: Number(v) })} options={SIZES(9, 24)} />
				</Row>
				<Row id="term.lineHeight">
					<Select
						size="sm"
						aria-label="터미널 줄 간격"
						value={String(a.termLine)}
						onChange={(v) => setAppearance({ termLine: Number(v) })}
						options={["1", "1.1", "1.15", "1.2", "1.3", "1.4", "1.5"].map((x) => ({ value: x, label: x === "1.15" ? "1.15 (기본)" : x }))}
					/>
				</Row>
			</Group>
			<Group title="편집기 글꼴">
				<Row id="editor.fontFamily">
					<FontSelect value={a.editorFont} title="편집기 글꼴" onChange={(v) => setAppearance({ editorFont: v })} />
				</Row>
				<Row id="editor.fontSize">
					<Select
						size="sm"
						aria-label="편집기 글자 크기"
						value={String(a.editorSize)}
						onChange={(v) => setAppearance({ editorSize: Number(v) })}
						options={SIZES(10, 22).map((o) => (o.value === "13" ? { ...o, label: "13px (기본)" } : o))}
					/>
				</Row>
				<Row id="editor.lineHeight">
					<Select
						size="sm"
						aria-label="편집기 줄 간격"
						value={String(a.editorLine)}
						onChange={(v) => setAppearance({ editorLine: Number(v) })}
						options={["1.3", "1.4", "1.5", "1.55", "1.6", "1.7", "1.8"].map((x) => ({ value: x, label: x === "1.55" ? "1.55 (기본)" : x }))}
					/>
				</Row>
			</Group>
		</>
	);
}
