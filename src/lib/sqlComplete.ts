import type { Command } from "@codemirror/view";
import { api } from "./ipc";
import { onSettingLive } from "./settingsBus";
import { createMeta, type MetaDeps } from "./sql-complete/meta";
import { lookOptions } from "./sql-complete/render";
import { type CompleteSettings, createSource, expandStarAt, type SqlSource } from "./sql-complete/source";

/**
 * SQL 편집기의 DB 이름 완성(DataGrip 처럼 문맥을 읽는다) — 자세한 것은 sql-complete/*.
 * - SELECT 목록·WHERE·ON·GROUP BY·ORDER BY·HAVING·SET: 이 문장 FROM/JOIN/UPDATE 표의 열 먼저(별칭.열, 겹치는 이름은 별칭을 붙여), 다음 함수·키워드
 * - FROM·JOIN·UPDATE·INTO·TABLE 뒤: 표·뷰(행 수 추정), 고르면 별칭도 붙인다
 * - JOIN … ON 뒤: 조인 조건(FK, 없으면 이름 규칙·같은 이름 열)
 * - INSERT INTO t ( : t 의 열 · 별칭./표./스키마. 뒤: 그 안
 * 이름 기억은 연결(·데이터베이스)마다 하나 — 작업대가 데이터베이스를 바꾸면 새로 만든다.
 */

/** 설정 키 — 값 "0" 이면 끔(없으면 켬) */
export const SQL_COMPLETE_KEYS = { alias: "db.completeAlias", qualify: "db.completeQualify", words: "db.completeWords" } as const;

const current: CompleteSettings = { alias: true, qualify: true, words: true };
let loaded = false;
function loadSettings() {
	if (loaded) return;
	loaded = true;
	for (const [k, key] of Object.entries(SQL_COMPLETE_KEYS) as [keyof CompleteSettings, string][])
		void api
			.settingGet(key)
			.then((v) => {
				if (v != null) current[k] = v !== "0";
			})
			.catch(() => undefined);
	onSettingLive(Object.values(SQL_COMPLETE_KEYS), (key, v) => {
		const k = (Object.keys(SQL_COMPLETE_KEYS) as (keyof CompleteSettings)[]).find((x) => SQL_COMPLETE_KEYS[x] === key);
		if (k) current[k] = v !== "0";
	});
}
const settings = () => current;

export type { SqlSource };

/** 연결 하나의 완성 소스 */
export function sqlCompletionSource(deps: MetaDeps): SqlSource {
	loadSettings();
	return createSource(createMeta(deps), settings);
}

/** SQL 편집기용 자동완성 설정(cmEditing 의 sql 갈래에 넘긴다) — 문서 낱말·언어 키워드는 이 소스가 함께 낸다 */
export function sqlAutocompleteConfig(source: SqlSource | ((cx: Parameters<SqlSource>[0]) => ReturnType<SqlSource>)) {
	return { override: [source], icons: false, addToOptions: lookOptions, tooltipClass: () => "sqlc" };
}

/** * 펼치기 명령 — get 은 지금 연결의 소스 */
export function expandStarCommand(get: () => SqlSource | null): Command {
	return (view) => {
		const s = get();
		return s ? expandStarAt(view, s) : false;
	};
}
