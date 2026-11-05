import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * window.prompt 대신 쓰는 앱 안 입력창 — macOS(WKWebView)에서는 prompt 가 아무것도 띄우지 않고 null 을 돌려주므로
 * 이름 입력·확인 입력은 모두 이것으로 받는다. 취소(Esc·바깥 누르기·취소 단추)면 null.
 */
export type AskOptions = {
	title: string;
	/** 제목 아래 설명(여러 줄 가능) */
	message?: string;
	value?: string;
	placeholder?: string;
	okLabel?: string;
	danger?: boolean;
	/** 누르면 입력칸에 넣는 고르기 칩(묶음 이름·서버 등) */
	choices?: { value: string; label?: string }[];
	/** 칩만 고르게(입력칸 숨김) */
	choiceOnly?: boolean;
	/** 이 값과 같아야 확인 단추가 켜짐(이름을 그대로 쳐서 지우기 확인 등) */
	mustEqual?: string;
	/** 빈 값도 받기 */
	allowEmpty?: boolean;
};

export function askText(o: AskOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const done = (v: string | null) => {
			root.unmount();
			host.remove();
			resolve(v);
		};
		root.render(<AskSheet o={o} done={done} />);
	});
}

function AskSheet({ o, done }: { o: AskOptions; done: (v: string | null) => void }) {
	const [v, setV] = useState(o.value ?? "");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const ok = o.mustEqual != null ? v === o.mustEqual : o.allowEmpty || v.trim() !== "";
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
			<form
				className="sheet ask-sheet"
				onSubmit={(e) => {
					e.preventDefault();
					if (ok) done(v);
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						done(null);
					}
				}}
			>
				<h3>{o.title}</h3>
				{o.message && <p className="ask-msg">{o.message}</p>}
				{!o.choiceOnly && (
					<input ref={ref} value={v} onChange={(e) => setV(e.target.value)} placeholder={o.placeholder ?? o.mustEqual} spellCheck={false} autoComplete="off" />
				)}
				{o.choices && o.choices.length > 0 && (
					<div className="ask-chips">
						{o.choices.map((c) => (
							<button
								key={c.value}
								type="button"
								className={`chip${v === c.value ? " on" : ""}`}
								onClick={() => (o.choiceOnly ? done(c.value) : setV(c.value))}
								title={c.value}
							>
								{c.label ?? c.value}
							</button>
						))}
					</div>
				)}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={() => done(null)}>
						취소
					</button>
					{!o.choiceOnly && (
						<button type="submit" className={`btn ${o.danger ? "danger-solid" : "primary"}`} disabled={!ok}>
							{o.okLabel ?? "확인"}
						</button>
					)}
				</div>
			</form>
		</div>
	);
}
