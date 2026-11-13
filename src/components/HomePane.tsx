import { BookOpen, ChevronDown, ChevronRight, Database, FileDown, FileUp, Folder, KeyRound, ListTree, Pencil, Pin, Play, Search, Server, SquareTerminal, Star, Zap } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { type Account, api, type Profile } from "../lib/ipc";
import { Select } from "./Select";
import { agoMs } from "./ServerCard";

export const LEVEL_BADGE: Record<string, string> = { rsa: "구형 SSH · RSA", sha1: "구형 SSH · SHA-1", weakest: "구형 SSH · 최후" };

/** 빠른 접속 — 검색 칸에 친 user@host:port · host:port · host */
export type QuickSpec = { user: string; host: string; port: number };
/** 주소로 읽히면 풀고, 아니면 null(띄어쓰기·쉼표가 섞이면 검색어로 본다). IPv6 는 [::1]:22 처럼 */
export function parseQuick(text: string): QuickSpec | null {
	const m = /^(?:([^@\s/:]+)@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(text.trim());
	if (!m) return null;
	const port = m[3] ? Number(m[3]) : 22;
	if (!port || port > 65535) return null;
	const host = m[2].startsWith("[") ? m[2].slice(1, -1) : m[2];
	// 점·대괄호·@·: 하나 없이 낱말만이면 이름 찾기일 수도 — 그래도 주소로는 받는다(맞는 저장 연결이 없을 때만 쓰임)
	return { user: m[1] ?? "", host, port };
}

function greeting(): string {
	const h = new Date().getHours();
	if (h < 6) return "늦은 밤이에요";
	if (h < 12) return "좋은 아침이에요";
	if (h < 18) return "좋은 오후예요";
	return "좋은 저녁이에요";
}

type Kind = "all" | "ssh" | "db" | "fav";
type Sort = "fav" | "name" | "recent" | "host";

/**
 * 홈 — 검색어·거르기·정렬·접은 묶음은 여기 안에 둔다(한 글자 칠 때마다 앱 전체·숨은 탭이 다시 그려지지 않게).
 * 앱이 넘기는 콜백은 모두 안정된 참조여야 memo 가 듣는다.
 */
export const HomePane = memo(function HomePane(props: {
	profiles: Profile[];
	mod: string;
	/** 지난번 열려 있던 연결(보이는 이름들) — 비면 띠를 숨긴다 */
	resumeLabel: string;
	onResume: () => void;
	onDismissResume: () => void;
	onConnect: (p: Profile) => void;
	onConnectAs: (p: Profile, a?: Account) => void;
	onQuick: (s: QuickSpec) => void;
	onMenu: (x: number, y: number, p: Profile) => void;
	onEdit: (p: Profile) => void;
	onNew: (kind: "ssh" | "db") => void;
	onOpen: (what: "local" | "dict" | "connections") => void;
	onImport: () => void;
	onExport: () => void;
	reload: () => void;
	quickTitle: (p: Profile) => string;
}) {
	const { profiles, mod, onConnect, onConnectAs, onMenu, onEdit, reload, quickTitle } = props;
	const [q, setQ] = useState("");
	const [kindF, setKindF] = useState<Kind>("all");
	const [groupF, setGroupF] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<Sort>("fav");
	const [pinnedGroups, setPinnedGroups] = useState<string[]>([]);
	const [viewPinned, setViewPinned] = useState(false);
	const [folded, setFolded] = useState<Set<string>>(new Set());
	useEffect(() => {
		void api.settingGet("home.view").then((v) => {
			if (!v) return;
			try {
				const o = JSON.parse(v) as { q?: string; kind?: Kind; group?: string | null; sort?: Sort };
				setQ(o.q ?? "");
				setKindF(o.kind ?? "all");
				setGroupF(o.group ?? null);
				setSortBy(o.sort ?? "fav");
				setViewPinned(true);
			} catch {
				// 무시
			}
		});
		void api.settingGet("home.pinnedGroups").then((v) => {
			try {
				setPinnedGroups(v ? (JSON.parse(v) as string[]) : []);
			} catch {
				setPinnedGroups([]);
			}
		});
	}, []);
	const togglePinGroup = (g: string) => {
		const next = pinnedGroups.includes(g) ? pinnedGroups.filter((x) => x !== g) : [...pinnedGroups, g];
		setPinnedGroups(next);
		void api.settingSet("home.pinnedGroups", JSON.stringify(next));
	};
	const pinView = (on: boolean) => {
		setViewPinned(on);
		void api.settingSet("home.view", on ? JSON.stringify({ q, kind: kindF, group: groupF, sort: sortBy }) : "");
	};
	const allGroups = useMemo(() => [...new Set(profiles.map((p) => p.groupName?.trim()).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ko")), [profiles]);
	const filtered = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = profiles.filter((p) => {
			if (kindF === "ssh" && p.kind !== "ssh") return false;
			if (kindF === "db" && p.kind !== "db") return false;
			if (kindF === "fav" && !p.favorite) return false;
			if (groupF !== null && (p.groupName?.trim() || "") !== groupF) return false;
			if (!words.length) return true;
			const hay = [p.name, p.host, p.username, p.engine, p.groupName, p.memo, p.database, `${p.host}:${p.port}`].filter(Boolean).join(" ").toLowerCase();
			return words.every((w) => hay.includes(w));
		});
		list = [...list].sort((a, b) => {
			if (sortBy === "name") return a.name.localeCompare(b.name, "ko");
			if (sortBy === "host") return a.host.localeCompare(b.host) || a.port - b.port;
			if (sortBy === "recent") return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
			return Number(b.favorite) - Number(a.favorite) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name, "ko");
		});
		return list;
	}, [profiles, q, kindF, groupF, sortBy]);
	/** 묶음별로 — 고정한 묶음 먼저(고정한 순서), 그다음 이름순, 묶지 않음은 맨 뒤 */
	const groups = useMemo(() => {
		const m = new Map<string, Profile[]>();
		for (const p of filtered) {
			const g = p.groupName?.trim() || "";
			m.set(g, [...(m.get(g) ?? []), p]);
		}
		const rank = (g: string) => (pinnedGroups.includes(g) ? pinnedGroups.indexOf(g) : 1000);
		return [...m.entries()].sort(([a], [b]) => rank(a) - rank(b) || (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
	}, [filtered, pinnedGroups]);
	// 화면에 보이는 순서의 첫 결과(접은 묶음 안 것은 건너뛴다) — Enter 로 접속
	const first = useMemo(() => {
		for (const [g, items] of groups) if (!folded.has(g) || pinnedGroups.includes(g)) return items[0];
		return undefined;
	}, [groups, folded, pinnedGroups]);
	const quick = q.trim() && !first ? parseQuick(q) : null;
	const onEnter = () => {
		if (!q.trim()) return;
		if (first) {
			onConnect(first);
			return;
		}
		const s = parseQuick(q);
		if (s) props.onQuick(s);
	};

	return (
		<div className="home-inner">
			<h1>{greeting()}</h1>
			<p className="sub">어디에 접속할까요?</p>
			{props.resumeLabel && (
				<div className="resume-bar">
					<span>지난번에 열려 있던 연결 — {props.resumeLabel}</span>
					<button type="button" className="btn primary" onClick={props.onResume}>
						다시 열기
					</button>
					<button type="button" className="btn ghost" onClick={props.onDismissResume}>
						닫기
					</button>
				</div>
			)}
			<label className="search" title="Enter — 첫 결과에 접속 · 맞는 연결이 없으면 user@host:port 로 바로 접속(저장하지 않음)">
				<Search size={17} />
				<input
					id="home-search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) {
							e.preventDefault();
							// 누르고 있어도 한 번만(같은 곳에 접속 창이 줄줄이 쌓이지 않게)
							if (!e.repeat) onEnter();
						} else if (e.key === "Escape" && q) {
							e.preventDefault();
							setQ("");
						}
					}}
					placeholder="서버·데이터베이스 찾기 · user@host 로 바로 접속"
					spellCheck={false}
					autoComplete="off"
				/>
				<kbd>{mod}K</kbd>
			</label>
			<div className="quick">
				<QuickCard color="#0a84ff" icon={<Server size={18} />} title="SSH 서버" desc="터미널·파일·편집기" onClick={() => props.onNew("ssh")} />
				<QuickCard color="#30d158" icon={<Database size={18} />} title="데이터베이스" desc="PostgreSQL·MariaDB·MySQL" onClick={() => props.onNew("db")} />
				<QuickCard color="#5e5ce6" icon={<SquareTerminal size={18} />} title="내 PC 터미널" desc={`이 PC 폴더·셸 (${mod}T)`} onClick={() => props.onOpen("local")} />
				<QuickCard color="#ff9f0a" icon={<BookOpen size={18} />} title="명령어 사전" desc="358개 리눅스 명령 한국어" onClick={() => props.onOpen("dict")} />
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
				<h2 style={{ margin: 0, flex: 1 }}>
					내 연결 <small className="count">{filtered.length === profiles.length ? profiles.length : `${filtered.length} / ${profiles.length}`}</small>
				</h2>
				<button type="button" className="btn ghost" onClick={() => props.onOpen("connections")} title="연결 만들기·고치기·지우기·묶음 — 한 화면에서">
					<ListTree size={14} /> 연결 관리
				</button>
				<button type="button" className="btn ghost" onClick={props.onImport} title="~/.ssh/config·PuTTY 에서">
					<FileDown size={14} /> 가져오기
				</button>
				<button type="button" className="btn ghost" onClick={props.onExport} title="ssh config 로">
					<FileUp size={14} /> 내보내기
				</button>
			</div>
			<div className="find-bar">
				<div className="seg tiny" role="group">
					{(
						[
							["all", "전체"],
							["ssh", "SSH"],
							["db", "DB"],
							["fav", "즐겨찾기"],
						] as const
					).map(([k, l]) => (
						<button key={k} type="button" aria-pressed={kindF === k} onClick={() => setKindF(k)}>
							{k === "fav" && <Star size={11} className="ic-inline" aria-hidden />}
							{l}
						</button>
					))}
				</div>
				{allGroups.length > 0 && (
					<div className="chips" style={{ margin: 0 }}>
						{allGroups.map((g) => (
							<button key={g} type="button" className={`chip${groupF === g ? " on" : ""}`} onClick={() => setGroupF(groupF === g ? null : g)}>
								{pinnedGroups.includes(g) && <Pin size={11} className="ic-inline" aria-label="고정" />}
								{g}
							</button>
						))}
					</div>
				)}
				<span style={{ flex: 1 }} />
				<Select<Sort>
					size="sm"
					value={sortBy}
					onChange={setSortBy}
					title="정렬"
					options={[
						{ value: "fav", label: "즐겨찾기·최근 순" },
						{ value: "recent", label: "최근 접속 순" },
						{ value: "name", label: "이름 순" },
						{ value: "host", label: "주소 순" },
					]}
				/>
				<button
					type="button"
					className={`btn ghost${viewPinned ? " on" : ""}`}
					title={viewPinned ? "시작 화면 고정 풀기" : "지금 조회(검색어·종류·묶음·정렬)를 앱을 켤 때 그대로 보이게 고정"}
					onClick={() => pinView(!viewPinned)}
				>
					<Pin size={12} className="ic-inline" aria-hidden /> {viewPinned ? "고정됨" : "이 조회 고정"}
				</button>
				{(q || kindF !== "all" || groupF !== null) && (
					<button
						type="button"
						className="btn ghost"
						onClick={() => {
							setQ("");
							setKindF("all");
							setGroupF(null);
						}}
					>
						모두 보기
					</button>
				)}
			</div>
			{filtered.length ? (
				groups.map(([g, items]) => (
					<section key={g || "-"} className="pgroup">
						{(g || groups.length > 1) && (
							<button
								type="button"
								className="pgroup-head"
								onClick={() =>
									setFolded((f) => {
										const n = new Set(f);
										if (n.has(g)) n.delete(g);
										else n.add(g);
										return n;
									})
								}
							>
								{folded.has(g) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
								<Folder size={13} /> {g || "묶지 않음"} <small>{items.length}</small>
								{g && (
									<span
										role="button"
										tabIndex={-1}
										className={`pin${pinnedGroups.includes(g) ? " on" : ""}`}
										title={pinnedGroups.includes(g) ? "고정 풀기" : "이 묶음 고정(맨 위·늘 펼침)"}
										onClick={(e) => {
											e.stopPropagation();
											togglePinGroup(g);
										}}
									>
										<Pin size={12} aria-hidden />
									</span>
								)}
							</button>
						)}
						{(!folded.has(g) || pinnedGroups.includes(g)) && (
							<div className="plist">
								{items.map((p) => (
									<div
										key={p.id}
										className="pcard"
										title={`${p.memo ? `${p.memo}\n` : ""}눌러 서버 정보·계정 고르기${q.trim() && p === first ? "\n검색 칸에서 Enter — 이 연결" : ""}`}
										role="button"
										tabIndex={0}
										onClick={() => onConnect(p)}
										onKeyDown={(e) => e.key === "Enter" && onConnect(p)}
										onContextMenu={(e) => {
											e.preventDefault();
											onMenu(e.clientX, e.clientY, p);
										}}
									>
										<span style={{ width: 10, height: 10, borderRadius: "50%", flex: "none", background: p.color ?? "var(--accent)" }} />
										<div className="meta">
											<b>
												<button
													type="button"
													className={`star${p.favorite ? " on" : ""}`}
													title={p.favorite ? "즐겨찾기 빼기" : "즐겨찾기(목록 맨 위)"}
													onClick={(e) => {
														e.stopPropagation();
														void api.profileSave({ ...p, favorite: !p.favorite }).then(reload);
													}}
												>
													<Star size={13} fill={p.favorite ? "currentColor" : "none"} aria-hidden />
												</button>
												<span className="nm">{p.name}</span>
											</b>
											<small>
												{p.legacy !== "off" && <span className="badge warn pc-legacy">{LEVEL_BADGE[p.legacy]}</span>}
												{p.secretSaved && <KeyRound size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
												{p.kind === "db" ? `${p.engine} · ` : ""}
												{p.username ? `${p.username}@` : ""}
												{p.host}:{p.port}
												{(p.accounts?.length ?? 0) > 1 && <span className="last-used"> · 계정 {p.accounts?.length}</span>}
												{p.lastUsedAt ? <span className="last-used"> · {agoMs(p.lastUsedAt)}</span> : null}
											</small>
											{p.memo && <small className="memo">{p.memo}</small>}
										</div>
										<button
											type="button"
											className="btn pc-connect"
											title={quickTitle(p)}
											onClick={(e) => {
												e.stopPropagation();
												onConnectAs(p);
											}}
										>
											<Play size={12} /> 접속
										</button>
										<button
											type="button"
											className="btn ghost icon"
											aria-label="설정"
											title="설정(고치기·복제·지우기) — 우클릭 메뉴도 있습니다"
											onClick={(e) => {
												e.stopPropagation();
												onEdit(p);
											}}
										>
											<Pencil size={13} />
										</button>
									</div>
								))}
							</div>
						)}
					</section>
				))
			) : quick ? (
				<div className="empty">
					맞는 저장 연결이 없습니다.{" "}
					<button type="button" className="btn primary" onClick={() => props.onQuick(quick)} title="저장하지 않고 바로 접속 — 접속한 뒤 작업대의 「저장」으로 연결 목록에 넣을 수 있습니다">
						<Zap size={13} /> {quick.user ? `${quick.user}@` : ""}
						{quick.host}
						{quick.port !== 22 ? `:${quick.port}` : ""} 바로 접속 (Enter)
					</button>
				</div>
			) : (
				<div className="empty">{q ? "맞는 연결이 없습니다." : "저장한 연결이 없습니다. 위에서 SSH 서버나 데이터베이스를 추가하세요."}</div>
			)}
		</div>
	);
});

function QuickCard(props: { color: string; icon: ReactNode; title: string; desc: string; onClick: () => void }) {
	return (
		<button type="button" className="qcard" onClick={props.onClick}>
			<span className="ic" style={{ background: props.color }}>
				{props.icon}
			</span>
			<span className="qtext">
				<b>{props.title}</b>
				<small>{props.desc}</small>
			</span>
		</button>
	);
}
