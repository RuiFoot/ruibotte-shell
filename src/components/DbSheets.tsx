import { useState } from "react";

/** 입력 시트 요청 — window.prompt 대신(macOS WKWebView 에서는 prompt 가 늘 null) */
export type AskReq = {
	title: string;
	message?: string;
	placeholder?: string;
	initial?: string;
	/** 이 글을 그대로 쳐야 확인 단추가 켜진다(TRUNCATE·DROP) */
	confirmWord?: string;
	okLabel?: string;
	danger?: boolean;
};

export function AskSheet({ req, onDone }: { req: AskReq; onDone: (v: string | null) => void }) {
	const [v, setV] = useState(req.initial ?? "");
	const ok = req.confirmWord != null ? v === req.confirmWord : v.trim() !== "";
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
			<form
				className="sheet db-ask"
				onSubmit={(e) => {
					e.preventDefault();
					if (ok) onDone(req.confirmWord != null ? v : v.trim());
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onDone(null);
					}
				}}
			>
				<h3>{req.title}</h3>
				{req.message && <p className="db-ask-msg">{req.message}</p>}
				{req.confirmWord != null && (
					<p className="db-ask-msg">
						실행하려면 <code>{req.confirmWord}</code> 를 그대로 치세요.
					</p>
				)}
				<input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={req.placeholder ?? req.confirmWord ?? ""} spellCheck={false} />
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => onDone(null)}>
						취소
					</button>
					<button type="submit" className={`btn ${req.danger ? "danger" : "primary"}`} disabled={!ok}>
						{req.okLabel ?? "확인"}
					</button>
				</div>
			</form>
		</div>
	);
}

/** 큰 편집기 — 긴 글·JSON 을 넓은 칸에서 고친다(Shift+Enter). readOnly 면 보기만 */
export function BigEditSheet({
	col,
	value,
	readOnly,
	nullable,
	onDone,
}: {
	col: string;
	value: string | null;
	readOnly?: boolean;
	nullable?: boolean;
	onDone: (v: string | null | undefined) => void;
}) {
	const [v, setV] = useState(value ?? "");
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onDone(undefined)}>
			<div
				className="sheet"
				style={{ width: "min(880px, calc(100vw - 32px))" }}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Escape") onDone(undefined);
					if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !readOnly) onDone(v);
				}}
			>
				<div className="sheet-title">
					<h3 style={{ fontFamily: "var(--font-mono)" }}>{col}</h3>
					<small style={{ color: "var(--text-3)" }}>{[...v].length.toLocaleString()}자 · Ctrl+Enter 확정 · Esc 취소</small>
				</div>
				<textarea className="fp value-view" autoFocus readOnly={readOnly} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} />
				<div className="sheet-actions">
					{!readOnly && nullable && (
						<button type="button" className="btn" style={{ marginRight: "auto" }} onClick={() => onDone(null)}>
							NULL 로
						</button>
					)}
					{!readOnly && v.trim().startsWith("{") && (
						<button
							type="button"
							className="btn"
							onClick={() => {
								try {
									setV(JSON.stringify(JSON.parse(v), null, 2));
								} catch {
									// JSON 이 아니면 그대로
								}
							}}
						>
							JSON 정리
						</button>
					)}
					<button type="button" className="btn" onClick={() => onDone(undefined)}>
						{readOnly ? "닫기" : "취소"}
					</button>
					{!readOnly && (
						<button type="button" className="btn primary" onClick={() => onDone(v)}>
							확정
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
