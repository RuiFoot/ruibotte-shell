import { Ban, Lock, RefreshCw, Search, Unplug } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Select } from "../Select";
import { confirmAction, errText, secs, usePoll } from "./common";

/**
 * DB 활동 — 지금 도는 세션·쿼리(오래 걸린 순), 잠금으로 누가 누구를 막는지 나무, 자동 새로 고침, 쿼리 취소·세션 끊기(확인).
 * PostgreSQL·MySQL/MariaDB·SQL Server·Oracle. 질의는 작업대가 넘긴 runSql 로(열 순서를 고정한 SELECT 만 보낸다).
 */
export type DbActivityPanelProps = {
	/** engines.ts 의 키 — postgres·mysql·mariadb·mssql·oracle(그 밖은 안내만) */
	engine: string;
	/** 조회 하나를 돌려 행(문자열) — 예: (sql) => queryRows(conn, sql, 2000) */
	runSql: (sql: string) => Promise<(string | null)[][]>;
	visible?: boolean;
};

export type Sess = {
	id: string;
	/** 끊기·취소에 쓰는 값(Oracle 은 "sid,serial#") */
	killId: string;
	user: string;
	db: string;
	client: string;
	app: string;
	state: string;
	wait: string;
	secs: number;
	query: string;
	blockedBy: string[];
	/** 열린 트랜잭션 시간(초, 모르면 -1) */
	txSecs: number;
};
type LockRow = { id: string; kind: string; mode: string; granted: boolean; object: string };

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: string | null | undefined) => (v == null || v === "" ? -1 : Number(v));

export const ACTIVITY_SQL: Record<string, { sessions: string; blocks?: string[]; trx?: string; locks?: (id: string) => string }> = {
	postgres: {
		sessions: `SELECT a.pid::text, a.pid::text, COALESCE(a.usename::text, ''), COALESCE(a.datname::text, ''), COALESCE(host(a.client_addr), ''), COALESCE(a.application_name, ''), COALESCE(a.state, ''),
COALESCE(a.wait_event_type || ':' || a.wait_event, ''), COALESCE(EXTRACT(EPOCH FROM (now() - a.query_start))::bigint, 0)::text, left(COALESCE(a.query, ''), 4000),
array_to_string(pg_blocking_pids(a.pid), ','), COALESCE(EXTRACT(EPOCH FROM (now() - a.xact_start))::bigint::text, '')
FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'`,
		locks: (id) =>
			`SELECT l.pid::text, l.locktype, l.mode, l.granted::text, COALESCE(c.relname::text, l.transactionid::text, l.virtualxid, '') FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation WHERE l.pid = ${Number(id)} ORDER BY l.granted, l.locktype`,
	},
	mysql: {
		sessions:
			"SELECT CAST(ID AS CHAR), CAST(ID AS CHAR), COALESCE(USER, ''), COALESCE(DB, ''), COALESCE(HOST, ''), '', CASE WHEN COMMAND = 'Sleep' THEN 'Sleep' ELSE CONCAT(COMMAND, IF(STATE IS NULL OR STATE = '', '', CONCAT(': ', STATE))) END, '', CAST(TIME AS CHAR), LEFT(COALESCE(INFO, ''), 4000), '', '' FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID()",
		blocks: [
			"SELECT CAST(r.trx_mysql_thread_id AS CHAR), CAST(b.trx_mysql_thread_id AS CHAR) FROM performance_schema.data_lock_waits w JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID",
			"SELECT CAST(r.trx_mysql_thread_id AS CHAR), CAST(b.trx_mysql_thread_id AS CHAR) FROM information_schema.INNODB_LOCK_WAITS w JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id",
		],
		trx: "SELECT CAST(trx_mysql_thread_id AS CHAR), CAST(TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS CHAR), trx_state, CAST(trx_rows_locked AS CHAR) FROM information_schema.INNODB_TRX",
	},
	mssql: {
		sessions: `SELECT CAST(s.session_id AS varchar(12)), CAST(s.session_id AS varchar(12)), COALESCE(s.login_name, ''), COALESCE(DB_NAME(COALESCE(r.database_id, s.database_id)), ''), COALESCE(s.host_name, '') + COALESCE(' ' + c.client_net_address, ''), COALESCE(s.program_name, ''),
COALESCE(r.status, s.status), COALESCE(r.wait_type, ''), CAST(COALESCE(r.total_elapsed_time / 1000, DATEDIFF(SECOND, s.last_request_start_time, GETDATE())) AS varchar(20)), LEFT(COALESCE(t.text, ''), 4000),
CASE WHEN COALESCE(r.blocking_session_id, 0) > 0 THEN CAST(r.blocking_session_id AS varchar(12)) ELSE '' END, CASE WHEN s.open_transaction_count > 0 THEN '0' ELSE '' END
FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID`,
		locks: (id) =>
			`SELECT CAST(request_session_id AS varchar(12)), resource_type, request_mode, CASE WHEN request_status = 'GRANT' THEN 'true' ELSE 'false' END, COALESCE(OBJECT_NAME(CASE WHEN resource_type = 'OBJECT' THEN resource_associated_entity_id END, resource_database_id), resource_description, '') FROM sys.dm_tran_locks WHERE request_session_id = ${Number(id)}`,
	},
	oracle: {
		sessions: `SELECT TO_CHAR(s.sid), s.sid || ',' || s.serial#, NVL(s.username, ''), NVL(s.schemaname, ''), NVL(s.machine, ''), NVL(s.program, ''), s.status, NVL(s.event, ''), TO_CHAR(s.last_call_et), NVL(SUBSTR(q.sql_text, 1, 2000), ''),
NVL(TO_CHAR(s.blocking_session), ''), CASE WHEN s.taddr IS NOT NULL THEN '0' ELSE '' END
FROM v$session s LEFT JOIN v$sqlarea q ON q.sql_id = s.sql_id WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')`,
		locks: (id) =>
			`SELECT TO_CHAR(l.sid), l.type, DECODE(l.lmode, 0, 'none', 1, 'null', 2, 'row-S', 3, 'row-X', 4, 'share', 5, 'S/row-X', 6, 'exclusive', TO_CHAR(l.lmode)), CASE WHEN l.request = 0 THEN 'true' ELSE 'false' END, NVL((SELECT o.owner || '.' || o.object_name FROM dba_objects o WHERE o.object_id = l.id1 AND l.type = 'TM'), TO_CHAR(l.id1)) FROM v$lock l WHERE l.sid = ${Number(id)}`,
	},
};
ACTIVITY_SQL.mariadb = ACTIVITY_SQL.mysql;

/** 취소·끊기 SQL — 없으면 그 엔진은 못 한다 */
export function cancelSql(engine: string, s: Sess): string | null {
	if (engine === "postgres") return `SELECT pg_cancel_backend(${Number(s.id)})`;
	if (engine === "mysql" || engine === "mariadb") return `KILL QUERY ${Number(s.id)}`;
	if (engine === "oracle" && /^\d+,\d+$/.test(s.killId)) return `ALTER SYSTEM CANCEL SQL ${lit(s.killId)}`;
	return null;
}
export function terminateSql(engine: string, s: Sess): string | null {
	if (engine === "postgres") return `SELECT pg_terminate_backend(${Number(s.id)})`;
	if (engine === "mysql" || engine === "mariadb") return `KILL ${Number(s.id)}`;
	if (engine === "mssql") return `KILL ${Number(s.id)}`;
	if (engine === "oracle" && /^\d+,\d+$/.test(s.killId)) return `ALTER SYSTEM KILL SESSION ${lit(s.killId)} IMMEDIATE`;
	return null;
}

export function toSess(r: (string | null)[]): Sess {
	const v = r.map((x) => x ?? "");
	return {
		id: v[0],
		killId: v[1],
		user: v[2],
		db: v[3],
		client: v[4],
		app: v[5],
		state: v[6],
		wait: v[7],
		secs: Math.max(0, num(v[8])),
		query: v[9].replace(/\s+/g, " ").trim(),
		blockedBy: v[10]
			.split(",")
			.map((x) => x.trim())
			.filter((x) => x && x !== "0"),
		txSecs: num(v[11]),
	};
}

/** 막는 관계 나무 — 뿌리 = 남을 막지만 스스로는 막히지 않은 세션(돌고 도는 경우는 막힌 쪽 하나를 뿌리로) */
export function blockTree(list: Sess[]): { s: Sess; depth: number; cycle?: boolean }[] {
	const by = new Map(list.map((s) => [s.id, s]));
	const kids = new Map<string, Sess[]>();
	for (const s of list) for (const b of s.blockedBy) kids.set(b, [...(kids.get(b) ?? []), s]);
	const involved = list.filter((s) => s.blockedBy.length || kids.has(s.id));
	const roots = involved.filter((s) => kids.has(s.id) && !s.blockedBy.some((b) => by.has(b)));
	// 목록에 없는 세션이 막고 있으면 그 막힌 쪽을 뿌리로
	for (const s of involved) if (s.blockedBy.length && s.blockedBy.every((b) => !by.has(b)) && !roots.includes(s)) roots.push(s);
	const out: { s: Sess; depth: number; cycle?: boolean }[] = [];
	const seen = new Set<string>();
	const walk = (s: Sess, d: number) => {
		if (seen.has(s.id)) return out.push({ s, depth: d, cycle: true });
		seen.add(s.id);
		out.push({ s, depth: d });
		for (const k of kids.get(s.id) ?? []) walk(k, d + 1);
	};
	for (const r of roots.sort((a, b) => b.secs - a.secs)) walk(r, 0);
	for (const s of involved) if (!seen.has(s.id)) walk(s, 0);
	return out;
}

const idle = (s: Sess) => /^(idle|sleep|sleeping|inactive|dormant)$/i.test(s.state) || (!s.query && !s.blockedBy.length);

export function DbActivityPanel({ engine, runSql, visible = true }: DbActivityPanelProps) {
	const sql = ACTIVITY_SQL[engine];
	const [list, setList] = useState<Sess[] | null>(null);
	const [err, setErr] = useState("");
	const [blockErr, setBlockErr] = useState("");
	const [every, setEvery] = useState(5);
	const [showIdle, setShowIdle] = useState(false);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [sel, setSel] = useState<string | null>(null);
	const [locks, setLocks] = useState<LockRow[] | null>(null);
	const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; s: Sess } | null>(null);

	const load = useCallback(async () => {
		if (!sql) return;
		setBusy(true);
		try {
			const rows = (await runSql(sql.sessions)).map(toSess);
			// MySQL·MariaDB: 막는 관계·트랜잭션은 따로(판마다 표가 다르다)
			if (sql.blocks) {
				let pairs: (string | null)[][] | null = null;
				for (const b of sql.blocks) {
					try {
						pairs = await runSql(b);
						break;
					} catch {
						/* 다음 판의 표로 */
					}
				}
				setBlockErr(pairs ? "" : "잠금 기다림 표(performance_schema.data_lock_waits·INNODB_LOCK_WAITS)를 읽을 권한이 없어 막는 관계는 보이지 않습니다(PROCESS 권한 필요).");
				const m = new Map<string, string[]>();
				for (const [w, b] of pairs ?? []) if (w && b) m.set(w, [...(m.get(w) ?? []), b]);
				for (const r of rows) r.blockedBy = m.get(r.id) ?? [];
				if (sql.trx) {
					const t = await runSql(sql.trx).catch(() => []);
					const tm = new Map(t.map((x) => [x[0] ?? "", num(x[1])]));
					for (const r of rows) r.txSecs = tm.get(r.id) ?? -1;
				}
			}
			setList(rows);
			setErr("");
		} catch (e) {
			const m = errText(e);
			setErr(engine === "oracle" && /ORA-00942|ORA-01031/.test(m) ? `v$session 을 읽을 권한이 없습니다 — DBA 에게 SELECT_CATALOG_ROLE(또는 v$session·v$sqlarea·v$lock 조회 권한)을 받으세요. (${m})` : m);
		} finally {
			setBusy(false);
		}
	}, [sql, runSql, engine]);

	useEffect(() => {
		void load();
	}, [load]);
	usePoll(load, every, visible && !!sql);

	useEffect(() => {
		setLocks(null);
		if (!sel || !sql?.locks) return;
		runSql(sql.locks(sel))
			.then((r) => setLocks(r.map((x) => ({ id: x[0] ?? "", kind: x[1] ?? "", mode: x[2] ?? "", granted: x[3] === "true" || x[3] === "t" || x[3] === "1", object: x[4] ?? "" }))))
			.catch(() => setLocks([]));
	}, [sel, sql, runSql]);

	const kill = async (s: Sess, how: "cancel" | "terminate") => {
		const q = how === "cancel" ? cancelSql(engine, s) : terminateSql(engine, s);
		if (!q) return;
		const ok = await confirmAction({
			title: how === "cancel" ? `세션 ${s.id} 쿼리 멈추기` : `세션 ${s.id} 연결 끊기`,
			message: `${s.user}${s.client ? ` · ${s.client}` : ""}\n${s.query.slice(0, 200) || "(쿼리 없음)"}\n\n${how === "cancel" ? "돌고 있는 쿼리만 멈춥니다(연결은 남음)." : "연결째 끊습니다. 끝내지 않은 트랜잭션은 되돌려집니다(롤백)."}`,
			okLabel: how === "cancel" ? "쿼리 멈추기" : "연결 끊기",
			danger: true,
		});
		if (!ok) return;
		try {
			await runSql(q);
			setNote({ text: `세션 ${s.id}: ${how === "cancel" ? "쿼리를 멈추라고 보냈습니다" : "연결을 끊었습니다"}` });
		} catch (e) {
			setNote({ text: errText(e), err: true });
		}
		void load();
	};

	const tree = useMemo(() => (list ? blockTree(list) : []), [list]);
	const shown = useMemo(() => {
		const f = filter.trim().toLowerCase();
		return (list ?? [])
			.filter((s) => (showIdle || !idle(s) || s.blockedBy.length || tree.some((t) => t.s.id === s.id)) && (!f || `${s.id} ${s.user} ${s.db} ${s.client} ${s.app} ${s.query}`.toLowerCase().includes(f)))
			.sort((a, b) => b.secs - a.secs);
	}, [list, showIdle, filter, tree]);

	if (!sql)
		return (
			<div className="sp-panel sp-center">
				<p>이 DB 엔진({engine})은 세션·잠금 보기를 아직 지원하지 않습니다.</p>
				<p className="sp-dim">PostgreSQL·MySQL·MariaDB·SQL Server·Oracle 에서 됩니다.</p>
			</div>
		);

	const cur = list?.find((s) => s.id === sel);
	const items = (s: Sess): MenuItem[] => [
		{ label: "쿼리 멈추기", run: () => void kill(s, "cancel"), danger: true, disabled: !cancelSql(engine, s) },
		{ label: "연결 끊기", run: () => void kill(s, "terminate"), danger: true, disabled: !terminateSql(engine, s) },
		{ sep: true },
		{ label: "쿼리 복사", run: () => void navigator.clipboard.writeText(s.query), disabled: !s.query },
	];
	const row = (s: Sess, extra?: ReactNode, key?: string) => (
		<tr
			key={key ?? s.id}
			className={`click${sel === s.id ? " sel" : ""}${s.blockedBy.length ? " blocked" : ""}`}
			onClick={() => setSel(s.id)}
			onContextMenu={(e) => {
				e.preventDefault();
				setSel(s.id);
				setMenu({ x: e.clientX, y: e.clientY, s });
			}}
		>
			<td className="sp-mono num">{s.id}</td>
			<td className={`num${s.secs >= 60 ? " warn" : ""}`}>{secs(s.secs)}</td>
			<td className="sp-clip">{s.user}</td>
			<td className="sp-clip sp-dim">{s.db}</td>
			<td className="sp-clip sp-dim" title={`${s.client} ${s.app}`}>
				{s.client || s.app}
			</td>
			<td className="sp-clip">
				{s.state}
				{s.txSecs >= 0 && <span className="sp-tag" title={s.txSecs > 0 ? `트랜잭션 ${secs(s.txSecs)}` : "트랜잭션 열림"}>{s.txSecs > 0 ? `tx ${secs(s.txSecs)}` : "tx"}</span>}
			</td>
			<td className="sp-clip sp-dim">{s.wait}</td>
			<td className="sp-mono sp-clip sp-q" title={s.query}>
				{extra}
				{s.query}
			</td>
		</tr>
	);

	return (
		<div className="sp-panel sp-dbact">
			<div className="sp-bar">
				<label className="sp-find">
					<Search size={13} />
					<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="사용자·주소·쿼리" spellCheck={false} />
				</label>
				<button type="button" className={`btn ghost tiny${showIdle ? " on" : ""}`} aria-pressed={showIdle} onClick={() => setShowIdle((x) => !x)} title="쉬고 있는 세션도 보기">
					쉬는 세션
				</button>
				<span className="sp-grow" />
				{cur && (
					<>
						<button type="button" className="btn ghost tiny danger" disabled={!cancelSql(engine, cur)} onClick={() => void kill(cur, "cancel")} title={cancelSql(engine, cur) ? "고른 세션의 쿼리 멈추기" : "이 DB 는 쿼리만 멈추기를 못 합니다 — 연결 끊기를 쓰세요"}>
							<Ban size={13} /> 쿼리 멈추기
						</button>
						<button type="button" className="btn ghost tiny danger" disabled={!terminateSql(engine, cur)} onClick={() => void kill(cur, "terminate")} title="고른 세션 연결 끊기">
							<Unplug size={13} /> 연결 끊기
						</button>
					</>
				)}
				<Select
					size="sm"
					value={every}
					onChange={setEvery}
					title="자동 새로 고침"
					options={[
						{ value: 0, label: "자동 끔" },
						{ value: 2, label: "2초마다" },
						{ value: 5, label: "5초마다" },
						{ value: 10, label: "10초마다" },
					]}
				/>
				<button type="button" className="btn ghost tiny" onClick={() => void load()} disabled={busy} title="새로 고침">
					<RefreshCw size={13} className={busy ? "sp-spin" : undefined} />
				</button>
			</div>
			{err && <p className="err sp-pad">{err}</p>}
			{note && <p className={`sp-pad ${note.err ? "err" : "sp-note"}`}>{note.text}</p>}
			<div className="sp-scroll">
				<section className="sp-sec">
					<h4>
						<Lock size={13} /> 막는 관계 {tree.length > 0 && <small className="sp-dim">{tree.filter((t) => t.s.blockedBy.length).length}개 세션이 기다리는 중</small>}
					</h4>
					{blockErr && <p className="sp-dim">{blockErr}</p>}
					{tree.length === 0 ? (
						<p className="sp-dim">{list ? "서로 막고 있는 세션이 없습니다." : "읽는 중…"}</p>
					) : (
						<table className="sp-table">
							<tbody>
								{tree.map((t, i) =>
									row(
										t.s,
										<span className="sp-tree" style={{ paddingLeft: t.depth * 16 }}>
											{t.depth ? "└ 막힘 " : t.s.blockedBy.length ? "막힘(목록 밖이 막음) " : "막는 쪽 "}
											{t.cycle ? "(돌고 도는 막힘) " : ""}
										</span>,
										`${i}:${t.s.id}`,
									),
								)}
							</tbody>
						</table>
					)}
				</section>
				<section className="sp-sec">
					<h4>
						세션 {shown.length}
						{list && shown.length !== list.length && <small className="sp-dim"> / 전체 {list.length}</small>}
					</h4>
					<table className="sp-table">
						<thead>
							<tr>
								<th className="num">ID</th>
								<th className="num">걸린 시간</th>
								<th>사용자</th>
								<th>DB</th>
								<th>클라이언트</th>
								<th>상태</th>
								<th>기다림</th>
								<th>쿼리</th>
							</tr>
						</thead>
						<tbody>{shown.map((s) => row(s))}</tbody>
					</table>
					{list && shown.length === 0 && <div className="sp-empty">{showIdle ? "다른 세션이 없습니다" : "지금 일하는 세션이 없습니다 — [쉬는 세션]으로 모두 보기"}</div>}
				</section>
				{cur && (
					<section className="sp-sec">
						<h4>세션 {cur.id} 쿼리</h4>
						<pre className="sp-pre selectable">{cur.query || "(없음)"}</pre>
						{sql.locks && (
							<>
								<h4>잡고 있거나 기다리는 잠금</h4>
								{locks == null ? (
									<p className="sp-dim">읽는 중…</p>
								) : locks.length === 0 ? (
									<p className="sp-dim">없음(또는 읽을 권한 없음)</p>
								) : (
									<table className="sp-table">
										<thead>
											<tr>
												<th>종류</th>
												<th>모드</th>
												<th>대상</th>
												<th>상태</th>
											</tr>
										</thead>
										<tbody>
											{locks.map((l, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: 같은 잠금이 여럿일 수 있다
												<tr key={i} className={l.granted ? "" : "blocked"}>
													<td>{l.kind}</td>
													<td>{l.mode}</td>
													<td className="sp-mono sp-clip">{l.object}</td>
													<td>{l.granted ? "잡음" : "기다림"}</td>
												</tr>
											))}
										</tbody>
									</table>
								)}
							</>
						)}
					</section>
				)}
			</div>
			{menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.s)} onClose={() => setMenu(null)} />}
		</div>
	);
}
