import { ChevronDown, ChevronRight, Database, FileDown, FileUp, Folder, KeyRound, Plus, Search, Server, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, type Profile } from "../lib/ipc";
import { blankProfile, ProfileSheet } from "./ProfileSheet";

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
		return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
	}, [list]);
	const allGroups = useMemo(() => [...new Set(profiles.map((p) => p.groupName?.trim()).filter((g): g is string => !!g))].sort(), [profiles]);

	const current = sel?.kind === "id" ? profiles.find((p) => p.id === sel.id) : sel?.kind === "new" ? sel.p : undefined;

	const bulkMove = async () => {
		const g = prompt(`고른 ${checked.size}개를 옮길 묶음(비우면 묶지 않음)${allGroups.length ? `\n있는 묶음: ${allGroups.join(", ")}` : ""}`);
		if (g === null) return;
		for (const p of profiles.filter((x) => x.id != null && checked.has(x.id))) await api.profileSave({ ...p, groupName: g.trim() || null });
		setChecked(new Set());
		reload();
	};
	const bulkDelete = async () => {
		if (!confirm(`고른 ${checked.size}개 연결을 지울까요? 저장한 암호도 함께 지웁니다.`)) return;
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
							>
								{folded.has(g) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
								<Folder size={12} /> {g || "묶지 않음"} <small>{items.length}</small>
							</button>
							{!folded.has(g) &&
								items.map((p) => (
									<div
										key={p.id}
										className="conn-row"
										aria-current={sel?.kind === "id" && sel.id === p.id}
										onClick={() => p.id != null && go({ kind: "id", id: p.id })}
										onDoubleClick={() => onConnect(p)}
										onKeyDown={(e) => e.key === "Enter" && p.id != null && go({ kind: "id", id: p.id })}
										role="button"
										tabIndex={0}
										title={`${p.username ? `${p.username}@` : ""}${p.host}:${p.port}${p.memo ? `\n${p.memo}` : ""}\n두 번 누르면 접속`}
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
					/>
				) : (
					<div className="panel-hint">
						왼쪽에서 연결을 고르면 여기서 바로 고칩니다(저장·되돌리기·연결 테스트·복제·지우기).
						<br />두 번 누르면 접속, 체크로 여러 개를 골라 묶음 옮기기·지우기.
					</div>
				)}
			</section>
		</div>
	);
}
