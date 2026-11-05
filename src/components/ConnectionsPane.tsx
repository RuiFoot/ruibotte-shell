import { ChevronDown, ChevronRight, Database, FileDown, FileUp, Folder, FolderPlus, KeyRound, Pencil, Plus, Search, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Profile } from "../lib/ipc";
import { blankProfile, ProfileSheet } from "./ProfileSheet";
import { askText } from "../lib/ask";

type Sel = { kind: "id"; id: number } | { kind: "new"; p: Profile } | null;

/**
 * 연결 관리 — 왼쪽 목록(찾기·종류·묶음별·여러 개 고르기), 오른쪽 그 연결의 설정(바로 고치기·저장·되돌리기·연결 테스트·복제·지우기·접속).
 * 여러 개를 골라 묶음 옮기기·한꺼번에 지우기. 가져오기·내보내기도 여기서.
 */
export function ConnectionsPane({
	profiles,
	reload,
	onConnect,
	onImport,
	onExport,
}: {
	profiles: Profile[];
	reload: () => void;
	onConnect: (p: Profile) => void;
	onImport: () => void;
	onExport: () => void;
}) {
	const [sel, setSel] = useState<Sel>(null);
	const [q, setQ] = useState("");
	const [kind, setKind] = useState<"all" | "ssh" | "db">("all");
	const [checked, setChecked] = useState<Set<number>>(new Set());
	const [folded, setFolded] = useState<Set<string>>(new Set());
	const [formKey, setFormKey] = useState(0);
	const dirty = useRef(false);
	// 연결이 아직 없는 빈 묶음(설정에 보관) — 연결이 들어오면 저절로 목록에서 이어진다
	const [emptyGroups, setEmptyGroups] = useState<string[]>([]);
	const [dropOn, setDropOn] = useState<string | null>(null);
	useEffect(() => {
		void api.settingGet("conn.groups").then((v) => {
			try {
				setEmptyGroups(v ? JSON.parse(v) : []);
			} catch {
				setEmptyGroups([]);
			}
		});
	}, []);
	const saveEmpty = (list: string[]) => {
		const uniq = [...new Set(list)];
		setEmptyGroups(uniq);
		void api.settingSet("conn.groups", JSON.stringify(uniq));
	};

	const go = (next: Sel) => {
		if (dirty.current && !confirm("고친 것을 저장하지 않았습니다. 버리고 옮길까요?")) return;
		dirty.current = false;
		setSel(next);
		setFormKey((k) => k + 1);
	};

	const list = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		return profiles
			.filter((p) => kind === "all" || p.kind === kind)
			.filter((p) => {
				if (!words.length) return true;
				const hay = [p.name, p.host, p.username, p.engine, p.groupName, p.memo, p.database, `${p.host}:${p.port}`].filter(Boolean).join(" ").toLowerCase();
				return words.every((w) => hay.includes(w));
			})
			.sort((a, b) => a.name.localeCompare(b.name, "ko"));
	}, [profiles, q, kind]);
	const groups = useMemo(() => {
		const m = new Map<string, Profile[]>();
		for (const p of list) {
			const g = p.groupName?.trim() || "";
			m.set(g, [...(m.get(g) ?? []), p]);
		}
		if (!q.trim() && kind === "all") for (const g of emptyGroups) if (!m.has(g)) m.set(g, []);
		return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
	}, [list, emptyGroups, q, kind]);
	const allGroups = useMemo(
		() => [...new Set([...profiles.map((p) => p.groupName?.trim()), ...emptyGroups].filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, "ko")),
		[profiles, emptyGroups],
	);
	const inGroup = (g: string) => profiles.filter((p) => (p.groupName?.trim() || "") === g);
	const moveTo = async (ids: number[], g: string) => {
		for (const p of profiles.filter((x) => x.id != null && ids.includes(x.id))) if ((p.groupName?.trim() || "") !== g) await api.profileSave({ ...p, groupName: g || null });
		reload();
	};
	const addGroup = async () => {
		const g = (await askText({ title: "새 묶음", placeholder: "예: 운영 · 고객사 A", okLabel: "만들기" }))?.trim();
		if (!g) return;
		if (allGroups.includes(g)) return alert("이미 있는 묶음입니다");
		saveEmpty([...emptyGroups, g]);
		setFolded((f) => {
			const n = new Set(f);
			n.delete(g);
			return n;
		});
	};
	const renameGroup = async (g: string) => {
		const to = (await askText({ title: "묶음 이름 바꾸기", value: g, okLabel: "바꾸기", choices: allGroups.filter((x) => x !== g).map((x) => ({ value: x, label: `${x}(합치기)` })) }))?.trim();
		if (!to || to === g) return;
		if (allGroups.includes(to) && !confirm(`'${to}' 묶음이 이미 있습니다. 합칠까요?`)) return;
		for (const p of inGroup(g)) await api.profileSave({ ...p, groupName: to });
		saveEmpty(emptyGroups.map((x) => (x === g ? to : x)));
		reload();
	};
	const deleteGroup = async (g: string, withConns: boolean) => {
		const items = inGroup(g);
		if (withConns) {
			if (!confirm(`'${g}' 묶음과 안의 연결 ${items.length}개를 모두 지울까요? 저장한 암호도 함께 지웁니다.`)) return;
			for (const p of items) if (p.id != null) await api.profileDelete(p.id);
			if (sel?.kind === "id" && items.some((p) => p.id === sel.id)) setSel(null);
		} else {
			if (items.length && !confirm(`'${g}' 묶음을 지울까요? 안의 연결 ${items.length}개는 지우지 않고 '묶지 않음'으로 옮깁니다.`)) return;
			for (const p of items) await api.profileSave({ ...p, groupName: null });
		}
		saveEmpty(emptyGroups.filter((x) => x !== g));
		reload();
	};

	const current = sel?.kind === "id" ? profiles.find((p) => p.id === sel.id) : sel?.kind === "new" ? sel.p : undefined;

	const bulkMove = async () => {
		const g = await askText({ title: `고른 ${checked.size}개 묶음 옮기기`, message: "옮길 묶음 이름(비우면 묶지 않음)", allowEmpty: true, okLabel: "옮기기", choices: allGroups.map((x) => ({ value: x })) });
		if (g === null) return;
		await moveTo([...checked], g.trim());
		if (g.trim()) saveEmpty(emptyGroups.filter((x) => x !== g.trim()));
		setChecked(new Set());
	};
	const bulkDelete = async () => {
		if (!confirm(`고른 ${checked.size}개 서버를 지울까요? 딸린 계정과 저장한 암호도 함께 지웁니다.`)) return;
		for (const id of checked) await api.profileDelete(id);
		if (sel?.kind === "id" && checked.has(sel.id)) setSel(null);
		setChecked(new Set());
		reload();
	};

	return (
		<div className="conn-pane">
			<aside className="conn-list">
				<div className="conn-tools">
					<button type="button" className="btn" onClick={() => go({ kind: "new", p: blankProfile("ssh") })}>
						<Plus size={13} /> SSH
					</button>
					<button type="button" className="btn" onClick={() => go({ kind: "new", p: blankProfile("db") })}>
						<Plus size={13} /> DB
					</button>
					<button type="button" className="btn ghost" title="새 묶음(연결을 끌어다 넣거나 체크 뒤 '묶음 옮기기')" onClick={() => void addGroup()}>
						<FolderPlus size={13} /> 묶음
					</button>
					<span style={{ flex: 1 }} />
					<button type="button" className="btn ghost icon" title="가져오기(~/.ssh/config·PuTTY·DataGrip·DBeaver)" onClick={onImport}>
						<FileDown size={14} />
					</button>
					<button type="button" className="btn ghost icon" title="내보내기(ssh config·hosts·PuTTY·MobaXterm·DataGrip·DBeaver·JDBC CSV)" onClick={onExport}>
						<FileUp size={14} />
					</button>
				</div>
				<label className="tree-filter" style={{ margin: "0 8px 6px" }}>
					<Search size={12} />
					<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·주소·계정·묶음·메모" spellCheck={false} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
				</label>
				<div className="seg tiny" role="group" style={{ margin: "0 8px 6px", alignSelf: "flex-start" }}>
					{(
						[
							["all", `전체 ${profiles.length}`],
							["ssh", "SSH"],
							["db", "DB"],
						] as const
					).map(([k, l]) => (
						<button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
							{l}
						</button>
					))}
				</div>
				{checked.size > 0 && (
					<div className="bulk-bar">
						<span>{checked.size}개 고름</span>
						<button type="button" className="btn ghost" onClick={() => void bulkMove()}>
							<Folder size={12} /> 묶음 옮기기
						</button>
						<button type="button" className="btn ghost danger" onClick={() => void bulkDelete()}>
							<Trash2 size={12} /> 지우기
						</button>
						<button type="button" className="btn ghost" onClick={() => setChecked(new Set())}>
							풀기
						</button>
					</div>
				)}
				<div className="conn-items">
					{groups.map(([g, items]) => (
						<div key={g || "-"}>
							<div
								className={`conn-ghead${dropOn === g ? " drop" : ""}`}
								onDragOver={(e) => {
									if (!e.dataTransfer.types.includes("application/x-rbs-conn")) return;
									e.preventDefault();
									setDropOn(g);
								}}
								onDragLeave={() => setDropOn((d) => (d === g ? null : d))}
								onDrop={(e) => {
									e.preventDefault();
									setDropOn(null);
									const ids = JSON.parse(e.dataTransfer.getData("application/x-rbs-conn") || "[]") as number[];
									if (ids.length) void moveTo(ids, g).then(() => setChecked(new Set()));
								}}
							>
								<button
									type="button"
									className="conn-group"
									onClick={() =>
										setFolded((f) => {
											const n = new Set(f);
											if (n.has(g)) n.delete(g);
											else n.add(g);
											return n;
										})
									}
									onDoubleClick={() => g && void renameGroup(g)}
								>
									{folded.has(g) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
									<Folder size={12} /> {g || "묶지 않음"} <small>{items.length}</small>
								</button>
								<span className="conn-gacts">
									<button type="button" className="sb-act" title="이 묶음에 새 SSH 연결" onClick={() => go({ kind: "new", p: { ...blankProfile("ssh"), groupName: g || null } })}>
										<Plus size={12} />
									</button>
									{g && (
										<>
											<button type="button" className="sb-act" title="묶음 이름 바꾸기(두 번 눌러도 됨)" onClick={() => void renameGroup(g)}>
												<Pencil size={12} />
											</button>
											<button
												type="button"
												className="sb-act"
												title="묶음 지우기 — Shift 를 누른 채면 안의 연결까지 지움"
												onClick={(e) => void deleteGroup(g, e.shiftKey)}
											>
												<Trash2 size={12} />
											</button>
										</>
									)}
								</span>
							</div>
							{!folded.has(g) && !items.length && <div className="conn-empty">비어 있음 — 연결을 끌어다 놓으세요</div>}
							{!folded.has(g) &&
								items.map((p) => (
									<div
										key={p.id}
										className="conn-row"
										aria-current={sel?.kind === "id" && sel.id === p.id}
										onClick={() => p.id != null && go({ kind: "id", id: p.id })}
										onDoubleClick={() => onConnect(p)}
										draggable
										onDragStart={(e) => {
											const ids = p.id != null && checked.has(p.id) ? [...checked] : p.id != null ? [p.id] : [];
											e.dataTransfer.setData("application/x-rbs-conn", JSON.stringify(ids));
											e.dataTransfer.effectAllowed = "move";
										}}
										onKeyDown={(e) => e.key === "Enter" && p.id != null && go({ kind: "id", id: p.id })}
										role="button"
										tabIndex={0}
										title={`${p.host}:${p.port} · 계정 ${(p.accounts ?? []).map((a) => a.username).join(", ") || p.username}${p.memo ? `\n${p.memo}` : ""}\n두 번 누르면 서버 카드(계정 골라 접속)`}
									>
										<input
											type="checkbox"
											checked={p.id != null && checked.has(p.id)}
											onClick={(e) => e.stopPropagation()}
											onChange={(e) => {
												const n = new Set(checked);
												if (p.id == null) return;
												if (e.target.checked) n.add(p.id);
												else n.delete(p.id);
												setChecked(n);
											}}
										/>
										<span className="dot" style={{ background: p.color ?? "var(--accent)" }} />
										{p.kind === "ssh" ? <Server size={12} className="ti" /> : <Database size={12} className="ti" />}
										<span className="conn-name">
											{p.favorite ? "★ " : ""}
											{p.name}
										</span>
										{p.secretSaved && <KeyRound size={10} className="ti" />}
										{(p.accounts?.length ?? 0) > 1 && <small className="conn-host">계정 {p.accounts?.length}</small>}
										<small className="conn-host">
											{p.kind === "db" ? `${p.engine} · ` : ""}
											{p.host}
										</small>
									</div>
								))}
						</div>
					))}
					{!list.length && <div className="panel-hint">{q ? "맞는 연결이 없습니다" : "왼쪽 위 + 로 연결을 만드세요"}</div>}
				</div>
			</aside>
			<section className="conn-detail">
				{current ? (
					<ProfileSheet
						key={formKey}
						inline
						initial={current}
						others={profiles}
						extraGroups={emptyGroups}
						onDirty={(d) => {
							dirty.current = d;
						}}
						onClose={() => {
							dirty.current = false;
							setFormKey((k) => k + 1);
						}}
						onSaved={(id) => {
							dirty.current = false;
							reload();
							setSel({ kind: "id", id });
							setFormKey((k) => k + 1);
						}}
						onDeleted={() => {
							dirty.current = false;
							reload();
							setSel(null);
						}}
						onDuplicate={(p) => go({ kind: "new", p })}
						onConnect={onConnect}
						onAccountsChanged={reload}
					/>
				) : (
					<div className="panel-hint">
						왼쪽에서 연결을 고르면 여기서 바로 고칩니다(저장·되돌리기·연결 테스트·복제·지우기).
						<br />두 번 누르면 서버 카드(계정 골라 접속), 체크로 여러 개를 골라 묶음 옮기기·지우기.
					</div>
				)}
			</section>
		</div>
	);
}
