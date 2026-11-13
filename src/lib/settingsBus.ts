import { api } from "./ipc";

/**
 * 앱 설정(setting) 한 칸을 저장하고, 같은 값을 보는 다른 화면에 바로 알린다.
 * 설정 화면과 각 칸의 빠른 스위치(편집기 미니맵·DB 도구 줄·경로 기다리기·상태 간격 등)가 서로의 값을 따라가게 한다.
 * 저장 키·값은 그대로 — api.settingSet 를 부르던 자리를 이것으로 바꿔도 저장되는 것은 같다.
 */
export const SETTING_EVENT = "rb-setting";
export type SettingChange = { key: string; value: string };

export function setSettingLive(key: string, value: string) {
	void api.settingSet(key, value).catch(() => undefined);
	window.dispatchEvent(new CustomEvent<SettingChange>(SETTING_EVENT, { detail: { key, value } }));
}

/** 이 키들이 바뀌면 fn — 끊는 함수를 돌려준다 */
export function onSettingLive(keys: readonly string[], fn: (key: string, value: string) => void): () => void {
	const on = (e: Event) => {
		const d = (e as CustomEvent<SettingChange>).detail;
		if (d && keys.includes(d.key)) fn(d.key, d.value);
	};
	window.addEventListener(SETTING_EVENT, on);
	return () => window.removeEventListener(SETTING_EVENT, on);
}
