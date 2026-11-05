/**
 * DB 도구 SQL — 엔진마다 다른 카탈로그를 한 곳에. 결과는 보통의 결과 탭으로 보여 준다.
 * 지원하지 않는 엔진은 null(화면이 메뉴를 감춘다).
 */
import { invoke } from "@tauri-apps/api/core";

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type Tool = "sizes" | "sessions" | "locks";

export function toolSql(engine: string, tool: Tool, schema?: string | null): string | null {
	const pg = engine === "postgres";
	const my = engine === "mariadb" || engine === "mysql";
	const ms = engine === "mssql";
	if (tool === "sizes") {
		if (pg)
			return `SELECT n.nspname AS 스키마, c.relname AS 표, c.reltuples::bigint AS 대략_행수, pg_size_pretty(pg_total_relation_size(c.oid)) AS 전체_크기, pg_size_pretty(pg_relation_size(c.oid)) AS 데이터, pg_size_pretty(pg_indexes_size(c.oid)) AS 인덱스
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','m')${schema ? ` AND n.nspname = ${lit(schema)}` : " AND n.nspname NOT IN ('pg_catalog','information_schema')"}
ORDER BY pg_total_relation_size(c.oid) DESC`;
		if (my)
			return `SELECT table_schema AS 스키마, table_name AS 표, table_rows AS 대략_행수, ROUND((data_length + index_length) / 1048576, 2) AS 전체_MB, ROUND(data_length / 1048576, 2) AS 데이터_MB, ROUND(index_length / 1048576, 2) AS 인덱스_MB, engine AS 엔진
FROM information_schema.tables WHERE table_type = 'BASE TABLE'${schema ? ` AND table_schema = ${lit(schema)}` : " AND table_schema NOT IN ('mysql','sys','performance_schema','information_schema')"}
ORDER BY data_length + index_length DESC`;
		if (ms)
			return `SELECT s.name AS 스키마, t.name AS 표, SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END) AS 행수, CAST(SUM(p.reserved_page_count) * 8.0 / 1024 AS decimal(12,2)) AS 전체_MB
FROM sys.dm_db_partition_stats p JOIN sys.tables t ON t.object_id = p.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
${schema ? `WHERE s.name = ${lit(schema)} ` : ""}GROUP BY s.name, t.name ORDER BY SUM(p.reserved_page_count) DESC`;
		if (engine === "oracle") return `SELECT owner AS 스키마, segment_name AS 표, ROUND(SUM(bytes) / 1048576, 2) AS MB FROM dba_segments WHERE segment_type LIKE 'TABLE%'${schema ? ` AND owner = ${lit(schema)}` : ""} GROUP BY owner, segment_name ORDER BY 3 DESC`;
		return null;
	}
	if (tool === "sessions") {
		if (pg)
			return `SELECT pid, usename AS 계정, datname AS DB, client_addr AS 주소, state AS 상태, now() - query_start AS 실행_시간, wait_event_type AS 대기, left(query, 300) AS 쿼리
FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST`;
		if (my) return "SELECT id, user AS 계정, host AS 주소, db AS DB, command AS 명령, time AS 초, state AS 상태, LEFT(info, 300) AS 쿼리 FROM information_schema.processlist WHERE id <> CONNECTION_ID() ORDER BY time DESC";
		if (ms)
			return `SELECT s.session_id, s.login_name AS 계정, s.host_name AS 주소, DB_NAME(r.database_id) AS DB, s.status AS 상태, r.total_elapsed_time / 1000 AS 초, r.wait_type AS 대기, LEFT(t.text, 300) AS 쿼리
FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID ORDER BY r.total_elapsed_time DESC`;
		if (engine === "oracle") return "SELECT sid, serial#, username AS 계정, machine AS 주소, status AS 상태, last_call_et AS 초, sql_id FROM v$session WHERE type = 'USER' ORDER BY last_call_et DESC";
		return null;
	}
	if (tool === "locks") {
		if (pg)
			return `SELECT blocked.pid AS 막힌_pid, left(blocked.query, 200) AS 막힌_쿼리, blocking.pid AS 막은_pid, left(blocking.query, 200) AS 막은_쿼리, now() - blocked.query_start AS 기다린_시간
FROM pg_stat_activity blocked JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid)) ORDER BY 5 DESC`;
		if (my) return "SELECT * FROM sys.innodb_lock_waits";
		if (ms) return "SELECT r.session_id AS 막힌_세션, r.blocking_session_id AS 막은_세션, r.wait_type AS 대기, r.wait_time / 1000 AS 초, LEFT(t.text, 200) AS 쿼리 FROM sys.dm_exec_requests r OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.blocking_session_id <> 0";
		return null;
	}
	return null;
}

/** 세션 멈추기(쿼리만) — 행의 첫 칸(pid/id/session_id) */
export function killSql(engine: string, id: string): string | null {
	if (!/^\d+$/.test(id)) return null;
	if (engine === "postgres") return `SELECT pg_cancel_backend(${id})`;
	if (engine === "mariadb" || engine === "mysql") return `KILL QUERY ${id}`;
	if (engine === "mssql") return `KILL ${id}`;
	return null;
}

export function explainSql(engine: string, stmt: string): string[] | null {
	if (engine === "postgres") return [`EXPLAIN (FORMAT TEXT, VERBOSE, COSTS) ${stmt}`];
	if (engine === "mariadb" || engine === "mysql") return [`EXPLAIN ${stmt}`];
	if (engine === "oracle") return [`EXPLAIN PLAN FOR ${stmt}`, "SELECT plan_table_output AS 계획 FROM TABLE(DBMS_XPLAN.DISPLAY())"];
	return null;
}

/** 객체 찾기 — 표·뷰·열 이름에 낱말이 든 것 */
export function searchSql(engine: string, q: string): string | null {
	const like = lit(`%${q.toLowerCase()}%`);
	if (engine === "postgres" || engine === "mssql" || engine === "mariadb" || engine === "mysql") {
		const sys = engine === "postgres" ? "('pg_catalog','information_schema')" : engine === "mssql" ? "('sys','INFORMATION_SCHEMA')" : "('mysql','sys','performance_schema','information_schema')";
		return `SELECT '표' AS 종류, table_schema AS 스키마, table_name AS 이름, table_type AS 설명 FROM information_schema.tables WHERE LOWER(table_name) LIKE ${like} AND table_schema NOT IN ${sys}
UNION ALL SELECT '열', table_schema, table_name + '.' + column_name, data_type FROM information_schema.columns WHERE LOWER(column_name) LIKE ${like} AND table_schema NOT IN ${sys}`.replace(
			/table_name \+ '\.' \+ column_name/,
			engine === "mssql" ? "table_name + '.' + column_name" : "CONCAT(table_name, '.', column_name)",
		);
	}
	if (engine === "oracle")
		return `SELECT '표' AS 종류, owner AS 스키마, table_name AS 이름 FROM all_tables WHERE LOWER(table_name) LIKE ${like}
UNION ALL SELECT '열', owner, table_name || '.' || column_name FROM all_tab_columns WHERE LOWER(column_name) LIKE ${like}`;
	return null;
}

export type Fk = { table: string; column: string; refTable: string; refColumn: string };

export function fkSql(engine: string, schema: string): string | null {
	if (engine === "postgres")
		return `SELECT cl.relname, a.attname, rcl.relname, ra.attname
FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_class rcl ON rcl.oid = c.confrelid
CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(a, ra_)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.a JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.ra_
WHERE c.contype = 'f' AND n.nspname = ${lit(schema)}`;
	if (engine === "mariadb" || engine === "mysql")
		return `SELECT table_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = ${lit(schema)} AND referenced_table_name IS NOT NULL`;
	if (engine === "mssql")
		return `SELECT tp.name, cp.name, tr.name, cr.name FROM sys.foreign_key_columns fkc
JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
JOIN sys.schemas s ON s.schema_id = tp.schema_id WHERE s.name = ${lit(schema)}`;
	return null;
}

export function ddlSql(engine: string, schema: string, table: string, view: boolean): string | null {
	if (engine === "mariadb" || engine === "mysql") return `SHOW CREATE ${view ? "VIEW" : "TABLE"} \`${schema.replace(/`/g, "``")}\`.\`${table.replace(/`/g, "``")}\``;
	if (engine === "postgres") {
		if (view) return `SELECT 'CREATE OR REPLACE VIEW ' || quote_ident(${lit(schema)}) || '.' || quote_ident(${lit(table)}) || E' AS\\n' || pg_get_viewdef(to_regclass(quote_ident(${lit(schema)}) || '.' || quote_ident(${lit(table)})), true)`;
		return `SELECT 'CREATE TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E' (\\n' ||
 string_agg('  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), ''), E',\\n' ORDER BY a.attnum)
 || COALESCE((SELECT string_agg(E',\\n  CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid), '') FROM pg_constraint WHERE conrelid = c.oid), '') || E'\\n);'
 || COALESCE((SELECT E'\\n' || string_agg(indexdef || ';', E'\\n') FROM pg_indexes WHERE schemaname = n.nspname AND tablename = c.relname AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = c.oid)), '')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)} GROUP BY n.nspname, c.relname, c.oid`;
	}
	if (engine === "mssql" && view) return `SELECT OBJECT_DEFINITION(OBJECT_ID(${lit(`${schema}.${table}`)}))`;
	if (engine === "oracle") return `SELECT DBMS_METADATA.GET_DDL('${view ? "VIEW" : "TABLE"}', ${lit(table)}, ${lit(schema)}) FROM dual`;
	return null;
}

type QueryOk = { resultId?: number | null; rowCount: number };

/** 조회 하나를 돌려 모든 행(상한) — 도구 내부용 */
export async function queryRows(conn: number, sql: string, max = 20000): Promise<(string | null)[][]> {
	const ok = await invoke<QueryOk>("db_query", { conn, sql, maxRows: max });
	if (!ok.resultId) return [];
	const rows = await invoke<(string | null)[][]>("db_rows", { result: ok.resultId, from: 0, to: ok.rowCount });
	void invoke("db_result_close", { result: ok.resultId });
	return rows;
}

/** 표의 인덱스 */
export function indexSql(engine: string, schema: string | null, table: string): string | null {
	const s = schema ?? "";
	if (engine === "postgres") return `SELECT indexname AS 인덱스, indexdef AS 정의 FROM pg_indexes WHERE ${schema ? `schemaname = ${lit(s)} AND ` : ""}tablename = ${lit(table)} ORDER BY 1`;
	if (engine === "mysql" || engine === "mariadb")
		return `SELECT index_name AS 인덱스, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS 열, MAX(non_unique) = 0 AS 고유, MAX(index_type) AS 종류 FROM information_schema.statistics WHERE ${schema ? `table_schema = ${lit(s)}` : "table_schema = DATABASE()"} AND table_name = ${lit(table)} GROUP BY index_name ORDER BY 1`;
	if (engine === "mssql")
		return `SELECT i.name AS 인덱스, i.type_desc AS 종류, i.is_unique AS 고유, i.is_primary_key AS 기본키, STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS 열 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = OBJECT_ID(${lit(schema ? `${s}.${table}` : table)}) GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key ORDER BY 1`;
	if (engine === "oracle" || engine === "tibero")
		return `SELECT i.index_name AS 인덱스, i.uniqueness AS 고유, LISTAGG(c.column_name, ', ') WITHIN GROUP (ORDER BY c.column_position) AS 열, i.status AS 상태 FROM all_indexes i JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name WHERE i.table_owner = ${lit(s.toUpperCase())} AND i.table_name = ${lit(table.toUpperCase())} GROUP BY i.index_name, i.uniqueness, i.status ORDER BY 1`;
	return null;
}

/** 스키마의 함수·프로시저·패키지 */
export function routinesSql(engine: string, schema: string | null): string | null {
	const s = schema ?? "";
	if (engine === "postgres")
		return `SELECT p.proname AS 이름, CASE p.prokind WHEN 'p' THEN '프로시저' WHEN 'f' THEN '함수' WHEN 'a' THEN '집계' WHEN 'w' THEN '윈도' ELSE p.prokind::text END AS 종류, pg_get_function_identity_arguments(p.oid) AS 인자, pg_get_function_result(p.oid) AS 반환 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${lit(s || "public")} ORDER BY 1`;
	if (engine === "mysql" || engine === "mariadb")
		return `SELECT routine_name AS 이름, routine_type AS 종류, dtd_identifier AS 반환, created AS 만든_때 FROM information_schema.routines WHERE ${schema ? `routine_schema = ${lit(s)}` : "routine_schema = DATABASE()"} ORDER BY 1`;
	if (engine === "mssql") return `SELECT name AS 이름, type_desc AS 종류, create_date AS 만든_때, modify_date AS 고친_때 FROM sys.objects WHERE type IN ('P','FN','IF','TF','TR') ${schema ? `AND SCHEMA_NAME(schema_id) = ${lit(s)} ` : ""}ORDER BY 1`;
	if (engine === "oracle" || engine === "tibero")
		return `SELECT object_name AS 이름, object_type AS 종류, status AS 상태, last_ddl_time AS 고친_때 FROM all_objects WHERE owner = ${lit(s.toUpperCase())} AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE') ORDER BY 1`;
	return null;
}

/** 스키마의 시퀀스 */
export function sequencesSql(engine: string, schema: string | null): string | null {
	const s = schema ?? "";
	if (engine === "postgres") return `SELECT sequencename AS 시퀀스, last_value AS 지금_값, increment_by AS 증가, max_value AS 최대 FROM pg_sequences WHERE schemaname = ${lit(s || "public")} ORDER BY 1`;
	if (engine === "mssql") return `SELECT name AS 시퀀스, current_value AS 지금_값, increment AS 증가 FROM sys.sequences ${schema ? `WHERE SCHEMA_NAME(schema_id) = ${lit(s)} ` : ""}ORDER BY 1`;
	if (engine === "oracle" || engine === "tibero") return `SELECT sequence_name AS 시퀀스, last_number AS 지금_값, increment_by AS 증가 FROM all_sequences WHERE sequence_owner = ${lit(s.toUpperCase())} ORDER BY 1`;
	return null;
}

/** 세션 연결 끊기(쿼리만 멈추기가 아니라 세션째) */
export function terminateSql(engine: string, id: string): string | null {
	if (!/^\d+$/.test(id)) return null;
	if (engine === "postgres") return `SELECT pg_terminate_backend(${id})`;
	if (engine === "mariadb" || engine === "mysql") return `KILL ${id}`;
	if (engine === "mssql") return `KILL ${id}`;
	return null;
}

/** 읽기 전용 계정 만들기 SQL 틀 — 이름·암호·대상은 고쳐서 쓴다 */
export function readOnlyUserSql(engine: string, schema: string | null): string | null {
	const s = schema ?? "public";
	if (engine === "postgres")
		return `-- 읽기 전용 계정 만들기(PostgreSQL) — 이름·암호를 바꾸고 실행하세요
CREATE ROLE readonly_user LOGIN PASSWORD '바꿀_암호';
GRANT CONNECT ON DATABASE current_db_name TO readonly_user;
GRANT USAGE ON SCHEMA ${s} TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO readonly_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO readonly_user;
-- 앞으로 만들 표에도 SELECT 권한
ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO readonly_user;
-- 세션도 읽기 전용으로
ALTER ROLE readonly_user SET default_transaction_read_only = on;
`;
	if (engine === "mariadb" || engine === "mysql")
		return `-- 읽기 전용 계정 만들기(MySQL·MariaDB) — 이름·암호·접속 주소를 바꾸고 실행하세요
CREATE USER 'readonly_user'@'%' IDENTIFIED BY '바꿀_암호';
GRANT SELECT, SHOW VIEW ON \`${schema ?? "db_name"}\`.* TO 'readonly_user'@'%';
FLUSH PRIVILEGES;
`;
	if (engine === "mssql")
		return `-- 읽기 전용 계정 만들기(SQL Server) — 이름·암호를 바꾸고 실행하세요
CREATE LOGIN readonly_user WITH PASSWORD = '바꿀_암호!1';
CREATE USER readonly_user FOR LOGIN readonly_user;
ALTER ROLE db_datareader ADD MEMBER readonly_user;
`;
	if (engine === "oracle" || engine === "tibero")
		return `-- 읽기 전용 계정 만들기(Oracle) — 이름·암호를 바꾸고 실행하세요
CREATE USER readonly_user IDENTIFIED BY "바꿀_암호";
GRANT CREATE SESSION TO readonly_user;
-- 표마다: GRANT SELECT ON ${schema ?? "SCHEMA"}.표이름 TO readonly_user;
`;
	return null;
}

/** 표 보기 한 쪽 — WHERE·ORDER BY·쪽 나누기(엔진별 LIMIT/OFFSET · OFFSET FETCH) */
export function pagedSelect(engine: string, table: string, opts: { where?: string; order?: string; offset: number; limit: number }): string {
	let sql = `SELECT * FROM ${table}`;
	if (opts.where?.trim()) sql += ` WHERE ${opts.where.trim()}`;
	const { offset, limit } = opts;
	if (engine === "mssql") return `${sql} ORDER BY ${opts.order ?? "(SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
	if (opts.order) sql += ` ORDER BY ${opts.order}`;
	if (engine === "oracle" || engine === "tibero") return `${sql} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
	if (engine === "cubrid" || engine === "altibase") return `${sql} LIMIT ${offset}, ${limit}`;
	return `${sql} LIMIT ${limit} OFFSET ${offset}`;
}
