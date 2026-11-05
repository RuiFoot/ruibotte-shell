import { useCallback, useRef, useState } from "react";

export type ConflictChoice = "overwrite" | "skip" | "rename";

/** 같은 이름이 없도록 `이름 (1).확장자` — taken 에 없는 첫 번호 */
export function freeName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let i = 1; i < 1000; i++) {
		const cand = `${stem} (${i})${ext}`;
		if (!taken.has(cand)) return cand;
	}
	return `${stem} (${Date.now()})${ext}`;
}

/**
 * 같은 이름이 있을 때 묻기 — 덮어쓰기·건너뛰기·이름 바꿔 올리기(모두에 적용).
 * ask(이름들, 받는 폴더, 받기인지) 는 고른 것(취소면 null)으로 풀린다. element 를 화면에 그려 둔다.
 */
export function useConflictAsk() {
	const [st, setSt] = useState<{ names: string[]; dest: string; down: boolean } | null>(null);
	const resolver = useRef<((c: ConflictChoice | null) => void) | null>(null);
	const ask = useCallback((names: string[], dest: string, down = false) => {
		resolver.current?.(null);
		setSt({ names, dest, down });
		return new Promise<ConflictChoice | null>((res) => {
			resolver.current = res;
		});
	}, []);
	const done = (c: ConflictChoice | null) => {
		resolver.current?.(c);
		resolver.current = null;
		setSt(null);
	};
	const element = st ? (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && done(null)} onKeyDown={(e) => e.key === "Escape" && done(null)}>
			<div className="sheet" role="dialog" aria-label="같은 이름이 있습니다" style={{ width: "min(520px, calc(100vw - 32px))" }}>
				<h3>같은 이름이 {st.names.length}개 있습니다</h3>
				<p style={{ color: "var(--text-2)", marginTop: 0 }}>
					{st.dest} 에 {st.down ? "받습니다" : "올립니다"}. 이미 있는 것을 어떻게 할까요? (없는 것은 그대로 보냅니다)
				</p>
				<ul className="conflict-list">
					{st.names.slice(0, 200).map((n) => (
						<li key={n}>{n}</li>
					))}
				</ul>
				<div className="sheet-actions wrap">
					<button type="button" className="btn" onClick={() => done(null)}>
						취소
					</button>
					<button type="button" className="btn" onClick={() => done("skip")} title="이미 있는 파일은 그대로 두고 나머지만">
						건너뛰기
					</button>
					<button type="button" className="btn" autoFocus onClick={() => done("rename")} title="이름 (1).확장자 처럼 새 이름으로">
						{st.down ? "이름 바꿔 받기" : "이름 바꿔 올리기"}
					</button>
					<button type="button" className="btn danger" onClick={() => done("overwrite")}>
						덮어쓰기
					</button>
				</div>
			</div>
		</div>
	) : null;
	return { ask, element };
}
