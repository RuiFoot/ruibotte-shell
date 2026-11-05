import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Snippet = { id?: number; kind: "shell" | "sql"; name: string; body: string };

/**
 * 스니펫 팔레트(Alt+P) — 자주 쓰는 명령을 이름으로 찾아 넣기. Enter = 넣기, Ctrl+Enter = 넣고 실행.
 * 저장은 앱 DB(snippet 표). "+" 로 지금 줄을 스니펫으로.
 */
export function SnippetPalette({
	kind = "shell",
	onClose,
	onPick,
	currentLine,
}: {
	kind?: "shell" | "sql";
	onClose: () => void;
	onPick: (body: string, run: boolean) => void;
	currentLine?: () => string;
}) {
	const [list, setList] = useState<Snippet[]>([]);
	const [q, setQ] = useState("");
	const [sel, setSel] = useState(0);
	const [edit, setEdit] = useState<Snippet | null>(null);
	const box = useRef<HTMLDivElement>(null);

	const load = () => void invoke<Snippet[]>("snippets_list", { kind }).then(setList);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 처음 한 번
	useEffect(load, []);

	const shown = useMemo(() => {
		const w = q.trim().toLowerCase();
		return w ? list.filter((s) => `${s.name} ${s.body}`.toLowerCase().includes(w)) : list;
	}, [list, q]);

	return (
		<div className="scrim" style={{ placeItems: "start center", paddingTop: "10vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="palette" ref={box}>
				{edit ? (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void invoke("snippet_save", { s: edit }).then(() => {
								setEdit(null);
								load();
							});
						}}
						style={{ padding: 14 }}
					>
						<div className="field">
							<label htmlFor="sn-name">이름</label>
							<input id="sn-name" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="예: 디스크 사용량" />
						</div>
						<div className="field">
							<label htmlFor="sn-body">{kind === "sql" ? "SQL" : "명령"}</label>
							<textarea id="sn-body" value={edit.body} rows={4} onChange={(e) => setEdit({ ...edit, body: e.target.value })} className="fp" style={{ width: "100%", border: 0, resize: "vertical", color: "var(--text)" }} />
						</div>
						<div className="sheet-actions">
							<button type="button" className="btn" onClick={() => setEdit(null)}>
								취소
							</button>
							<button type="submit" className="btn primary">
								저장
							</button>
						</div>
					</form>
				) : (
					<>
						<div className="palette-head">
							<input
								autoFocus
								value={q}
								placeholder={kind === "sql" ? "즐겨찾는 SQL 찾기" : "스니펫 찾기 — Enter 넣기, Ctrl+Enter 실행"}
								onChange={(e) => {
									setQ(e.target.value);
									setSel(0);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape") onClose();
									if (e.key === "ArrowDown") setSel((s) => Math.min(shown.length - 1, s + 1));
									if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
									if (e.key === "Enter" && shown[sel]) {
										e.preventDefault();
										onPick(shown[sel].body, e.ctrlKey || e.metaKey);
									}
								}}
							/>
							<button type="button" className="btn ghost icon" title="새 스니펫(지금 줄로)" onClick={() => setEdit({ kind, name: "", body: currentLine?.() ?? "" })}>
								<Plus size={15} />
							</button>
						</div>
						<div className="palette-list">
							{shown.length === 0 && <div className="sb-empty" style={{ padding: 14 }}>{list.length ? "맞는 스니펫이 없습니다" : "아직 없습니다. + 로 추가하세요."}</div>}
							{shown.map((s, i) => (
								<div
									key={s.id}
									className="palette-item"
									aria-selected={i === sel}
									onMouseEnter={() => setSel(i)}
									onClick={(e) => onPick(s.body, e.ctrlKey || e.metaKey)}
									onDoubleClick={() => setEdit(s)}
									role="option"
									tabIndex={-1}
									onKeyDown={() => {}}
								>
									<b>{s.name}</b>
									<code>{s.body.split("\n")[0]}</code>
									<button
										type="button"
										className="btn ghost icon"
										title="지우기"
										onClick={(e) => {
											e.stopPropagation();
											if (s.id != null && confirm(`${s.name} 을(를) 지울까요?`)) void invoke("snippet_delete", { id: s.id }).then(load);
										}}
									>
										<Trash2 size={13} />
									</button>
								</div>
							))}
						</div>
						<div className="palette-foot">Enter 넣기 · Ctrl+Enter 넣고 실행 · 두 번 눌러 고치기</div>
					</>
				)}
			</div>
		</div>
	);
}
