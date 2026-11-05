import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

const EVERY = 6 * 60 * 60 * 1000;

export type UpdateState =
	| { phase: "idle" }
	| { phase: "available"; version: string; update: Update }
	| { phase: "installing"; version: string; pct: number }
	| { phase: "error"; message: string };

/**
 * 앱 안 업데이트 — GitHub Releases 의 latest.json 을 시작 1분 뒤·6시간마다 확인(ruibotte-deck 과 같은 주기).
 * 받은 파일은 minisign 서명을 검증한 뒤에만 설치한다(플러그인이 강제). 개발 실행에서는 조용히 넘어간다.
 */
export function useUpdater() {
	const [state, setState] = useState<UpdateState>({ phase: "idle" });

	useEffect(() => {
		if (import.meta.env.DEV) return;
		let stop = false;
		const run = async () => {
			try {
				const u = await check();
				if (!stop && u) setState({ phase: "available", version: u.version, update: u });
			} catch {
				// 오프라인·사내망 차단이면 다음 주기에 다시
			}
		};
		const first = setTimeout(run, 60_000);
		const timer = setInterval(run, EVERY);
		return () => {
			stop = true;
			clearTimeout(first);
			clearInterval(timer);
		};
	}, []);

	async function install() {
		if (state.phase !== "available") return;
		const { update, version } = state;
		let total = 0;
		let got = 0;
		setState({ phase: "installing", version, pct: 0 });
		try {
			await update.downloadAndInstall((e) => {
				if (e.event === "Started") total = e.data.contentLength ?? 0;
				if (e.event === "Progress") {
					got += e.data.chunkLength;
					if (total) setState({ phase: "installing", version, pct: Math.round((100 * got) / total) });
				}
			});
			await relaunch();
		} catch (e) {
			setState({ phase: "error", message: String(e) });
		}
	}

	return { state, install };
}
