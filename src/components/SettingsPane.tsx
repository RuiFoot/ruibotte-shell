import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SETTINGS_GOTO_EVENT, takeSettingsSection } from "../lib/commands";
import type { AppInfo } from "../lib/ipc";
import "../styles/settings.css";
import { AppearancePage } from "./settings/appearance";
import { AboutPage, GeneralPage } from "./settings/general";
import { CAT_GROUPS, CATS, type CatId, catOf, isCat, SUBS, searchSettings } from "./settings/meta";
import { TerminalPage } from "./settings/terminal";
import type { PageProps } from "./settings/ui";
import { DbPage, EditorPage, FilesPage, ShortcutsPage, SshPage } from "./settings/workspace";

const PAGES: Record<CatId, (p: PageProps) => React.ReactNode> = {
	general: GeneralPage,
	appearance: AppearancePage,
	shortcuts: ShortcutsPage,
	terminal: TerminalPage,
	editor: EditorPage,
	files: FilesPage,
	db: DbPage,
	ssh: SshPage,
	about: AboutPage,
};

/** 하위 화면에서 뒤로 왔을 때 초점을 돌려줄 › 줄 */
const SUB_LINK: Record<string, string> = {
	"appearance/scheme": "term.scheme",
	"terminal/words": "term.highlight",
	"terminal/log": "term.log.auto",
};

/** 마지막으로 본 범주 — 이 PC 에서만 쓰는 편의라 localStorage(없거나 막혀도 일반으로) */
const LAST_KEY = "rb.settings.lastCat";
function lastCat(): CatId {
	try {
		const v = localStorage.getItem(LAST_KEY);
		if (v && isCat(v)) return v;
	} catch {
		// 저장소를 못 쓰면 기본
	}
	return "general";
}
function rememberCat(c: CatId) {
	try {
		localStorage.setItem(LAST_KEY, c);
	} catch {
		// 무시
	}
}

/** 좁은 창(이보다 좁으면 범주 목록 → 본문 한 단계 들어가기) */
const NARROW_PX = 720;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * 설정 — macOS 시스템 설정 구조: 왼쪽 검색 + 범주, 오른쪽 범주 제목과 둥근 묶음 칸.
 * 깊은 항목은 › 줄로 한 단계 들어가고(위 ‹ 뒤로), 좁은 창에서는 범주 목록과 본문을 오간다.
 * 바로 가기: openSettings("terminal") · "terminal/log" · "general#update.auto"
 */
export function SettingsPane({ info, onOpen }: { info: AppInfo | null; onOpen: PageProps["onOpen"] }) {
	const root = useRef<HTMLDivElement>(null);
	const mainRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const [cat, setCat] = useState<CatId>(lastCat);
	const [sub, setSub] = useState<string | null>(null);
	const [q, setQ] = useState("");
	const [narrow, setNarrow] = useState(false);
	/** 좁은 창에서 범주 목록을 보이는 중 */
	const [listMode, setListMode] = useState(true);
	const [msg, setMsg] = useState("");
	/** 그린 뒤 할 일 — 줄 강조·초점 */
	const after = useRef<{ flash?: string; focus?: "content" | "search" | `row:${string}` | `cat:${string}`; top?: boolean } | null>(null);
	const [seq, setSeq] = useState(0);
	/** 그린 뒤 할 일의 차례 — 늦게 도는 찾기·강조 지우기가 다음 이동을 건드리지 않게 */
	const gen = useRef(0);
	const bump = () => setSeq((n) => n + 1);

	const hits = useMemo(() => (q.trim() ? searchSettings(q) : null), [q]);

	/** "범주/하위#줄" 로 */
	const navigate = useCallback((path: string, focus?: "content") => {
		const [place, row] = path.split("#");
		const [c, s] = place.split("/");
		if (!isCat(c)) return;
		setCat(c);
		rememberCat(c);
		setSub(s && SUBS[`${c}/${s}`] ? s : null);
		setListMode(false);
		setMsg("");
		after.current = { flash: row || undefined, focus, top: !row };
		setSeq((n) => n + 1);
	}, []);

	// 명령 팔레트·다른 화면에서 openSettings(...) — 열릴 때 한 번, 열린 뒤에는 알림으로
	useEffect(() => {
		const go = () => {
			const p = takeSettingsSection();
			if (p) navigate(p);
		};
		go();
		window.addEventListener(SETTINGS_GOTO_EVENT, go);
		return () => window.removeEventListener(SETTINGS_GOTO_EVENT, go);
	}, [navigate]);

	// 좁은 창 — 칸 폭으로(창 크기 + 사이드바 접기 모두)
	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		// 처음 잰 폭이 좁으면 범주 목록부터(iOS), 넓게 보다가 좁아지면 보던 본문 그대로
		let was: boolean | null = null;
		const ro = new ResizeObserver(([e]) => {
			const w = e.contentRect.width;
			if (w <= 0) return;
			const n = w < NARROW_PX;
			if (n === was) return;
			if (n && was === false) setListMode(false);
			was = n;
			setNarrow(n);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 그린 뒤: 위로 올리기 · 줄 잠깐 강조(+그 조절기에 초점) · 초점 옮기기
	// biome-ignore lint/correctness/useExhaustiveDependencies: seq 가 바뀔 때마다(이동·뒤로) 한 번
	useEffect(() => {
		const job = after.current;
		if (!job) return;
		after.current = null;
		const my = ++gen.current;
		const main = mainRef.current;
		if (job.top && main) main.scrollTop = 0;
		if (job.focus === "search") return void searchRef.current?.focus();
		if (job.focus?.startsWith("cat:")) return void root.current?.querySelector<HTMLElement>(`[data-cat="${job.focus.slice(4)}"]`)?.focus();
		if (job.focus === "content") main?.querySelector<HTMLElement>(`.stg-body ${FOCUSABLE}`)?.focus({ preventScroll: true });
		const target = job.flash ?? (job.focus?.startsWith("row:") ? job.focus.slice(4) : null);
		if (!target) return;
		const flash = !!job.flash;
		let tries = 0;
		// 값을 읽어 와야 보이는 줄(예: 켜야 나오는 받기 폴더)이 있어 몇 번 더 찾아본다
		const find = () => {
			if (my !== gen.current) return;
			const el = main?.querySelector<HTMLElement>(`[data-set-id="${CSS.escape(target)}"]`);
			if (!el) {
				if (++tries < 6) window.setTimeout(find, 80);
				else if (main) main.scrollTop = 0; // 지금은 안 보이는 줄(켜야 나오는 줄 등) — 범주 맨 위로
				return;
			}
			const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			// 강조할 줄은 가운데로, 뒤로 와서 초점만 돌려주는 줄은 보이게만
			if (flash) el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
			else el.scrollIntoView({ block: "nearest" });
			const ctl = el.matches("button") ? el : el.querySelector<HTMLElement>(FOCUSABLE);
			ctl?.focus({ preventScroll: true });
			if (flash) {
				el.classList.remove("stg-flash");
				void el.offsetWidth;
				el.classList.add("stg-flash");
				window.setTimeout(() => el.classList.remove("stg-flash"), 1800);
			}
		};
		requestAnimationFrame(find);
	}, [seq]);

	const back = useCallback(() => {
		if (sub) {
			const link = SUB_LINK[`${cat}/${sub}`];
			setSub(null);
			after.current = { focus: link ? `row:${link}` : "content" };
			bump();
		} else if (narrow) {
			setListMode(true);
			// 검색 중이면 사이드바는 결과 목록이라 범주 단추가 없다 — 검색 칸으로
			after.current = { focus: q.trim() ? "search" : `cat:${cat}` };
			bump();
		}
	}, [sub, cat, narrow, q]);

	// ⌘F · Ctrl+F — 설정 화면이 보일 때만 검색 칸으로
	useEffect(() => {
		const mac = info?.os === "macos";
		const onKey = (e: globalThis.KeyboardEvent) => {
			const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
			if (!mod || e.shiftKey || e.altKey || e.code !== "KeyF") return;
			if (!root.current || root.current.offsetParent === null || document.querySelector(".scrim")) return;
			e.preventDefault();
			if (root.current.classList.contains("narrow")) setListMode(true);
			after.current = { focus: "search" };
			bump();
			searchRef.current?.focus();
			searchRef.current?.select();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [info?.os]);

	/** 사이드바 ↑↓·Home·End 로 범주 옮기기(넓은 창은 바로 보이고, 좁은 창은 초점만), Enter 로 본문에 */
	const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
		const cur = (e.target as HTMLElement).closest<HTMLElement>("[data-cat]")?.dataset.cat;
		if (!cur) return;
		const i = CATS.findIndex((c) => c.id === cur);
		let j = -1;
		if (e.key === "ArrowDown") j = Math.min(CATS.length - 1, i + 1);
		else if (e.key === "ArrowUp") {
			if (i === 0) {
				e.preventDefault();
				searchRef.current?.focus();
				return;
			}
			j = i - 1;
		} else if (e.key === "Home") j = 0;
		else if (e.key === "End") j = CATS.length - 1;
		else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			navigate(cur, "content");
			return;
		}
		if (j < 0) return;
		e.preventDefault();
		const id = CATS[j].id;
		if (!narrow) navigate(id);
		root.current?.querySelector<HTMLElement>(`[data-cat="${id}"]`)?.focus();
	};

	/** 검색 결과 ↑↓ */
	const onHitKey = (e: KeyboardEvent<HTMLElement>) => {
		const list = [...(root.current?.querySelectorAll<HTMLElement>(".stg-hit") ?? [])];
		const i = list.indexOf(e.target as HTMLElement);
		if (i < 0) return;
		if (e.key === "ArrowDown") list[Math.min(list.length - 1, i + 1)]?.focus();
		else if (e.key === "ArrowUp") (i === 0 ? searchRef.current : list[i - 1])?.focus();
		else if (e.key === "Escape") {
			setQ("");
			searchRef.current?.focus();
		} else return;
		e.preventDefault();
	};

	const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			(root.current?.querySelector<HTMLElement>(hits ? ".stg-hit" : `[data-cat="${cat}"]`) ?? null)?.focus();
		} else if (e.key === "Enter" && hits?.length) {
			e.preventDefault();
			navigate(hits[0].path, "content");
		} else if (e.key === "Escape" && q) {
			e.preventDefault();
			e.stopPropagation();
			setQ("");
		}
	};

	const onMainKey = (e: KeyboardEvent<HTMLElement>) => {
		if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
		if (!sub && !narrow) return;
		// 글을 치던 칸이면 Esc 로 화면을 떠나 쓰던 글을 잃지 않게
		const t = e.target as HTMLElement;
		if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return;
		e.preventDefault();
		back();
	};

	const c = catOf(cat) ?? CATS[0];
	const Page = PAGES[c.id];
	const subLabel = sub ? SUBS[`${cat}/${sub}`]?.label : null;
	const showSide = !narrow || listMode;
	const showMain = !narrow || !listMode;
	const props: PageProps = {
		info,
		sub,
		go: (s) => {
			if (s) navigate(`${cat}/${s}`, "content");
			else back();
		},
		goto: (p) => navigate(p),
		onOpen,
		say: setMsg,
	};

	return (
		<div className={`stg${narrow ? " narrow" : ""}`} ref={root}>
			{showSide && (
				<aside className="stg-side" aria-label="설정">
					<p className="stg-sr" role="status">
						{hits ? (hits.length ? `결과 ${hits.length}개` : "결과 없음") : ""}
					</p>
					<div className="stg-search">
						<Search size={13} aria-hidden />
						<input
							ref={searchRef}
							type="search"
							value={q}
							placeholder="검색"
							aria-label="설정 검색"
							aria-controls={hits ? "stg-hits" : undefined}
							spellCheck={false}
							onChange={(e) => setQ(e.target.value)}
							onKeyDown={onSearchKey}
						/>
						{q && (
							<button type="button" className="stg-clear" aria-label="검색 지우기" onClick={() => (setQ(""), searchRef.current?.focus())}>
								<X size={11} strokeWidth={2.5} />
							</button>
						)}
					</div>
					{hits ? (
						<div className="stg-hits" id="stg-hits" onKeyDown={onHitKey}>
							{hits.length === 0 && <p className="stg-none">“{q.trim()}” 에 맞는 설정이 없습니다</p>}
							{hits.map((h) => (
								<button key={h.id} type="button" className="stg-hit" onClick={() => navigate(h.path, "content")}>
									<span className="stg-ico sm" style={{ background: h.cat.color }} aria-hidden>
										<h.cat.icon size={10} strokeWidth={2.4} />
									</span>
									<span className="stg-hit-text">
										<span className="stg-hit-name">{h.label}</span>
										<small>{h.where}</small>
									</span>
								</button>
							))}
						</div>
					) : (
						<nav className="stg-nav" aria-label="설정 범주" onKeyDown={onNavKey}>
							{CAT_GROUPS.map((g) => (
								<div className="stg-navgrp" key={g[0].id}>
									{g.map((x) => {
										const on = x.id === cat;
										return (
											<button
												key={x.id}
												type="button"
												className="stg-cat"
												data-cat={x.id}
												aria-current={on && !narrow ? "page" : undefined}
												tabIndex={on ? 0 : -1}
												onClick={(e) => navigate(x.id, e.detail === 0 ? "content" : undefined)}
											>
												<span className="stg-ico" style={{ background: x.color }} aria-hidden>
													<x.icon size={13} strokeWidth={2.2} />
												</span>
												<span className="stg-cat-name">{x.label}</span>
												{narrow && <ChevronRight size={14} className="stg-chev" aria-hidden />}
											</button>
										);
									})}
								</div>
							))}
						</nav>
					)}
				</aside>
			)}
			{showMain && (
				<main className="stg-main" ref={mainRef} onKeyDown={onMainKey} aria-label={subLabel ?? c.label}>
					<div className="stg-col">
						<header className="stg-head">
							{(sub || narrow) && (
								<button type="button" className="stg-back" onClick={back}>
									<ChevronLeft size={16} strokeWidth={2.4} aria-hidden />
									{sub ? c.label : "설정"}
								</button>
							)}
							<h1>{subLabel ?? c.label}</h1>
						</header>
						<div className="stg-body">
							<Page key={c.id} {...props} />
							{msg && (
								<p className="err" role="alert">
									{msg}
								</p>
							)}
						</div>
					</div>
				</main>
			)}
		</div>
	);
}
