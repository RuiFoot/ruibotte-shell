import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";
import { api } from "./ipc";

/**
 * 앱 안 업데이트 — ruibotte-deck 과 같은 흐름.
 * - 시작 1분 뒤·6시간마다 GitHub Releases 의 latest.json 을 확인(설정에서 끌 수 있음), "확인" 단추는 바로 다시 묻는다.
 * - 새 판이면 사이드바 아래 알림 + OS 알림(판마다 한 번).
 * - 설치판: 받기(서명 확인) → 조용히 설치 → 다시 실행. 포터블판: 릴리스 페이지에서 새 파일을 받게 안내.
 */

export const RELEASES = "https://github.com/RuiFoot/ruibotte-shell/releases";
const EVERY = 6 * 60 * 60 * 1000;

export type UpdateState = {
	current: string;
	latest?: string;
	notes?: string;
	date?: string;
	checkedAt?: number;
	/** idle | checking | uptodate | available | downloading | installing | error */
	phase: "idle" | "checking" | "uptodate" | "available" | "downloading" | "installing" | "error";
	pct?: number;
	error?: string;
	auto: boolean;
	portable: boolean;
};

let state: UpdateState = { current: "", phase: "idle", auto: true, portable: false };
let pending: Update | null = null;
const subs = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
	state = { ...state, ...patch };
	for (const f of subs) f();
};

async function notifyOnce(version: string) {
	try {
		if ((await api.settingGet("update.notified")) === version) return;
		let ok = await isPermissionGranted();
		if (!ok) ok = (await requestPermission()) === "granted";
		if (ok) sendNotification({ title: `RuiBotte Shell ${version} 업데이트`, body: "설정 › 정보 또는 사이드바 아래에서 바로 설치할 수 있어요" });
		await api.settingSet("update.notified", version);
	} catch {
		// 알림이 막혀 있어도 사이드바 표시는 남는다
	}
}

export async function checkNow(manual = false): Promise<void> {
	if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return;
	if (import.meta.env.DEV) {
		set({ phase: "error", error: "개발 실행에서는 업데이트를 확인하지 않습니다", checkedAt: Date.now() });
		return;
	}
	set({ phase: "checking", error: undefined });
	try {
		const u = await check();
		const now = Date.now();
		void api.settingSet("update.checkedAt", String(now));
		if (u) {
			pending = u;
			set({ phase: "available", latest: u.version, notes: u.body ?? undefined, date: u.date ?? undefined, checkedAt: now });
			if (!manual) void notifyOnce(u.version);
		} else {
			pending = null;
			set({ phase: "uptodate", latest: undefined, notes: undefined, checkedAt: now });
		}
	} catch (e) {
		set({ phase: "error", error: `확인 실패 — ${String(e).slice(0, 160)}`, checkedAt: Date.now() });
	}
}

export async function installNow(): Promise<void> {
	if (state.portable) {
		await openUrl(`${RELEASES}/latest`);
		return;
	}
	const u = pending;
	if (!u) return;
	let total = 0;
	let got = 0;
	set({ phase: "downloading", pct: 0 });
	try {
		await u.downloadAndInstall((e) => {
			if (e.event === "Started") total = e.data.contentLength ?? 0;
			if (e.event === "Progress") {
				got += e.data.chunkLength;
				if (total) set({ pct: Math.round((100 * got) / total) });
			}
			if (e.event === "Finished") set({ phase: "installing" });
		});
		await relaunch();
	} catch (e) {
		set({ phase: "error", error: `설치 실패 — ${String(e).slice(0, 160)}` });
	}
}

export async function setAuto(on: boolean) {
	set({ auto: on });
	await api.settingSet("update.auto", on ? "1" : "0");
}

let started = false;
/** 앱 시작 때 한 번 — 판·포터블 여부·자동 확인 설정을 읽고 주기 확인을 건다 */
export function startUpdater(current: string, portable: boolean) {
	if (started) return;
	started = true;
	set({ current, portable });
	void Promise.all([api.settingGet("update.auto"), api.settingGet("update.checkedAt")]).then(([auto, at]) => {
		set({ auto: auto !== "0", checkedAt: at ? Number(at) : undefined });
	});
	const tick = () => {
		if (state.auto) void checkNow(false);
	};
	window.setTimeout(tick, 60_000);
	window.setInterval(tick, EVERY);
}

export function useUpdate(): UpdateState {
	return useSyncExternalStore(
		(f) => {
			subs.add(f);
			return () => subs.delete(f);
		},
		() => state,
	);
}
