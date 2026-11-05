import { Lock, LockOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./ipc";

/**
 * 작업대 배치 잠금 — 접속한 뒤 잡아 둔 칸 배치(트리·편집기·터미널·결과 자리와 크기)를
 * 실수로 끌거나 나누거나 닫지 않게 묶는다. 배치 종류(layoutKey)마다 따로 기억한다.
 *
 * 잠그면: 칸 끌어 옮기기·나누기 금지(dockview disableDnd), 칸 경계 크기 조절 금지(dockview locked),
 * 구조 칸(트리·터미널·결과 등) 닫기 숨김, "배치 초기화" 막기. 파일 열기·새 편집기 탭·새 터미널 탭처럼
 * 이미 있는 자리 안에 탭을 더하는 일은 그대로 된다.
 */
export function useLayoutLock(layoutKey: string): [boolean, (v: boolean) => void] {
	const key = `layout.lock.${layoutKey}`;
	const [locked, setLockedState] = useState(false);
	useEffect(() => {
		let alive = true;
		void api
			.settingGet(key)
			.then((v) => alive && setLockedState(v === "1"))
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [key]);
	const setLocked = useCallback(
		(v: boolean) => {
			setLockedState(v);
			void api.settingSet(key, v ? "1" : "0").catch(() => undefined);
		},
		[key],
	);
	return [locked, setLocked];
}

/** 머리줄 자물쇠 단추 — Ctrl+Alt+L 도 같은 동작으로 붙인다 */
export function LayoutLockButton({ locked, onChange }: { locked: boolean; onChange: (v: boolean) => void }) {
	return (
		<button
			type="button"
			className={`btn ghost icon layout-lock${locked ? " on" : ""}`}
			aria-pressed={locked}
			title={locked ? "배치 잠김 — 칸을 끌거나 나누거나 크기를 바꿀 수 없음(눌러 풀기, Ctrl+Alt+L)" : "배치 잠그기 — 지금 칸 배치를 고정(Ctrl+Alt+L)"}
			onClick={() => onChange(!locked)}
		>
			{locked ? <Lock size={14} /> : <LockOpen size={14} />}
		</button>
	);
}
