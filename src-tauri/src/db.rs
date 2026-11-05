//! DB 접속 — PostgreSQL(tokio-postgres)·MySQL/MariaDB(mysql_async).
//! - PG 는 simple query(텍스트 형식)로 받아 어떤 타입이든 서버가 보여 주는 글 그대로 표시한다.
//! - 결과 행은 Rust 쪽에 두고 화면은 보이는 구간만 받는다(`db_rows`). 행 상한을 넘으면 서버 쪽에서 취소.
//! - 읽기 전용: 세션을 READ ONLY 로 + 문장 첫 낱말 검사(이중).
//! - 취소: PG CancelRequest, MySQL 은 다른 연결로 KILL QUERY.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{pin_mut, StreamExt};
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::secrets;
use crate::store::Store;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    /// NEED_SECRET | AUTH_FAILED | NETWORK | READ_ONLY | BUSY | CANCELLED | SQL | CLOSED | OTHER
    code: &'static str,
    message: String,
}
fn e(code: &'static str, m: impl Into<String>) -> DbError {
    DbError { code, message: m.into() }
}
type R<T> = Result<T, DbError>;

fn pg_err(x: tokio_postgres::Error) -> DbError {
    if let Some(db) = x.as_db_error() {
        let code = db.code().code();
        if code == "57014" {
            return e("CANCELLED", "취소했습니다");
        }
        if code == "28P01" || code == "28000" {
            return e("AUTH_FAILED", db.message());
        }
        if code == "25006" {
            return e("READ_ONLY", "읽기 전용 연결입니다");
        }
        let mut m = format!("{} ({code})", db.message());
        if let Some(d) = db.detail() {
            m.push_str(&format!("\n{d}"));
        }
        if let Some(p) = db.position() {
            m.push_str(&format!("\n위치: {p:?}"));
        }
        return e("SQL", m);
    }
    if x.is_closed() {
        return e("CLOSED", "연결이 끊겼습니다");
    }
    e("NETWORK", x.to_string())
}

fn my_err(x: mysql_async::Error) -> DbError {
    match &x {
        mysql_async::Error::Server(s) => match s.code {
            1045 => e("AUTH_FAILED", s.message.clone()),
            1317 => e("CANCELLED", "취소했습니다"),
            1792 => e("READ_ONLY", "읽기 전용 연결입니다"),
            _ => e("SQL", format!("{} ({})", s.message, s.code)),
        },
        mysql_async::Error::Driver(mysql_async::DriverError::MysqlOldPasswordDisabled) => {
            e("AUTH_FAILED", "아주 오래된 MySQL 암호 방식(old_password)입니다. 프로필 고급에서 구형 호환을 켜세요.")
        }
        mysql_async::Error::Io(_) => e("NETWORK", x.to_string()),
        _ => e("OTHER", x.to_string()),
    }
}

// 연결마다 하나뿐이라 크기 차이는 상관없다
#[allow(clippy::large_enum_variant)]
enum Engine {
    Pg { client: tokio_postgres::Client, cancel: tokio_postgres::CancelToken },
    My { conn: tokio::sync::Mutex<mysql_async::Conn>, opts: mysql_async::Opts, thread: u32 },
}

pub(crate) struct DbConn {
    engine: Engine,
    read_only: bool,
    busy: tokio::sync::Mutex<()>,
}

#[derive(Default)]
pub struct DbConns {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Arc<DbConn>>>,
    results: Mutex<HashMap<u32, Arc<ResultSet>>>,
}

impl DbConns {
    fn get(&self, id: u32) -> R<Arc<DbConn>> {
        self.map.lock().unwrap().get(&id).cloned().ok_or_else(|| e("CLOSED", "연결이 닫혔습니다"))
    }
}

pub(crate) struct ResultSet {
    columns: Vec<Col>,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Serialize, Clone)]
pub struct Col {
    name: String,
    /// int | numeric | text | date | bool | json | binary
    kind: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectReq {
    profile_id: Option<i64>,
    /// postgres | mariadb | mysql
    engine: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    database: Option<String>,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    save_secret: bool,
    /// MySQL old_password 허용(프로필 구형 호환)
    #[serde(default)]
    legacy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectOk {
    conn_id: u32,
    version: String,
    database: Option<String>,
    used_saved_secret: bool,
}

fn lit(s: &str, mysql: bool) -> String {
    let mut v = s.replace('\'', "''");
    if mysql {
        v = v.replace('\\', "\\\\");
    }
    format!("'{v}'")
}

#[tauri::command]
pub async fn db_connect(store: State<'_, Store>, dbs: State<'_, DbConns>, req: DbConnectReq) -> R<DbConnectOk> {
    connect(&store, &dbs, req).await
}

pub(crate) async fn connect(store: &Store, dbs: &DbConns, req: DbConnectReq) -> R<DbConnectOk> {
    let mut used_saved = false;
    let pw = match req.password.clone().filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => {
            let s = req.profile_id.and_then(|id| secrets::get(&format!("profile:{id}")));
            used_saved = s.is_some();
            s
        }
    };
    let timeout = Duration::from_secs(12);
    let (engine, version) = if req.engine == "postgres" {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&req.host).port(req.port).user(&req.username).connect_timeout(timeout).application_name("RuiBotte Shell");
        cfg.dbname(req.database.as_deref().filter(|d| !d.is_empty()).unwrap_or("postgres"));
        if let Some(p) = &pw {
            cfg.password(p);
        }
        let (client, connection) = match cfg.connect(tokio_postgres::NoTls).await {
            Ok(x) => x,
            Err(x) => {
                let msg = x.to_string();
                if pw.is_none() && (msg.contains("password") || msg.contains("authentication") || msg.contains("invalid configuration")) {
                    return Err(e("NEED_SECRET", "암호를 입력하세요"));
                }
                return Err(pg_err(x));
            }
        };
        tauri::async_runtime::spawn(async move {
            let _ = connection.await;
        });
        if req.read_only {
            client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await.map_err(pg_err)?;
        }
        let v = client.simple_query("SHOW server_version").await.map_err(pg_err)?;
        let version = v
            .iter()
            .find_map(|m| if let tokio_postgres::SimpleQueryMessage::Row(r) = m { r.get(0).map(|s| format!("PostgreSQL {s}")) } else { None })
            .unwrap_or_default();
        let cancel = client.cancel_token();
        (Engine::Pg { client, cancel }, version)
    } else {
        let opts: mysql_async::Opts = mysql_async::OptsBuilder::default()
            .ip_or_hostname(req.host.clone())
            .tcp_port(req.port)
            .user(Some(req.username.clone()))
            .pass(pw.clone())
            .db_name(req.database.clone().filter(|d| !d.is_empty()))
            .prefer_socket(false)
            .secure_auth(!req.legacy)
            .into();
        let mut conn = match tokio::time::timeout(timeout, mysql_async::Conn::new(opts.clone())).await {
            Err(_) => return Err(e("NETWORK", format!("{}:{} 에 닿지 못했습니다", req.host, req.port))),
            Ok(Err(x)) => {
                let err = my_err(x);
                if pw.is_none() && err.code == "AUTH_FAILED" {
                    return Err(e("NEED_SECRET", "암호를 입력하세요"));
                }
                return Err(err);
            }
            Ok(Ok(c)) => c,
        };
        if req.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(my_err)?;
        }
        let v: Option<String> = conn.query_first("SELECT VERSION()").await.map_err(my_err)?;
        let thread = conn.id();
        (Engine::My { conn: tokio::sync::Mutex::new(conn), opts, thread }, v.unwrap_or_default())
    };

    if let Some(id) = req.profile_id {
        let mut saved = None;
        if req.save_secret && !used_saved {
            if let Some(p) = &pw {
                saved = Some(secrets::set(&format!("profile:{id}"), p).is_ok());
            }
        }
        store.mark_used(id, saved);
    }
    let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
    dbs.map.lock().unwrap().insert(id, Arc::new(DbConn { engine, read_only: req.read_only, busy: Default::default() }));
    Ok(DbConnectOk { conn_id: id, version, database: req.database, used_saved_secret: used_saved })
}

#[tauri::command]
pub async fn db_disconnect(dbs: State<'_, DbConns>, conn: u32) -> R<()> {
    let c = dbs.map.lock().unwrap().remove(&conn);
    if let Some(c) = c {
        if let Engine::My { conn, .. } = &c.engine {
            let _ = conn.lock().await.query_drop("DO 0").await;
        }
    }
    Ok(())
}

// ── 문장 판정 ───────────────────────

/// 주석·공백·여는 괄호를 건너뛴 첫 낱말(소문자)
fn first_word(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(r) = s.strip_prefix("--") {
            s = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = s.strip_prefix("/*") {
            s = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = s.strip_prefix('(') {
            s = r.trim_start();
        } else {
            break;
        }
    }
    s.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_lowercase()
}

const READ_WORDS: &[&str] = &["select", "show", "explain", "describe", "desc", "with", "values", "table", "help"];

// ── 실행 ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOk {
    /// 결과 집합이 있으면 그 번호(행은 db_rows 로)
    result_id: Option<u32>,
    columns: Vec<Col>,
    row_count: usize,
    affected: Option<u64>,
    truncated: bool,
    ms: u64,
    first_row_ms: Option<u64>,
}

fn my_kind(t: mysql_async::consts::ColumnType) -> &'static str {
    use mysql_async::consts::ColumnType::*;
    match t {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24 | MYSQL_TYPE_YEAR => "int",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL | MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => "numeric",
        MYSQL_TYPE_DATE | MYSQL_TYPE_DATETIME | MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIME | MYSQL_TYPE_NEWDATE | MYSQL_TYPE_DATETIME2 | MYSQL_TYPE_TIMESTAMP2 => "date",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_BIT => "bool",
        MYSQL_TYPE_BLOB | MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_GEOMETRY => "binary",
        _ => "text",
    }
}

fn my_value(v: mysql_async::Value) -> Option<String> {
    use mysql_async::Value::*;
    match v {
        NULL => None,
        Bytes(b) => Some(match String::from_utf8(b) {
            Ok(s) => s,
            Err(x) => format!("0x{}", x.as_bytes().iter().take(64).map(|b| format!("{b:02X}")).collect::<String>()),
        }),
        Int(i) => Some(i.to_string()),
        UInt(u) => Some(u.to_string()),
        Float(f) => Some(f.to_string()),
        Double(d) => Some(d.to_string()),
        Date(y, mo, d, h, mi, s, us) => Some(if us > 0 {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
        } else if h == 0 && mi == 0 && s == 0 {
            format!("{y:04}-{mo:02}-{d:02}")
        } else {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        Time(neg, d, h, mi, s, _) => Some(format!("{}{:02}:{mi:02}:{s:02}", if neg { "-" } else { "" }, d * 24 + h as u32)),
    }
}

/// 문장 하나 실행. 행은 max_rows 까지만 받고 넘으면 서버 쪽 취소
#[tauri::command]
pub async fn db_query(dbs: State<'_, DbConns>, conn: u32, sql: String, max_rows: Option<usize>) -> R<QueryOk> {
    query(&dbs, conn, sql, max_rows).await
}

pub(crate) async fn query(dbs: &DbConns, conn: u32, sql: String, max_rows: Option<usize>) -> R<QueryOk> {
    let c = dbs.get(conn)?;
    let max = max_rows.unwrap_or(100_000).clamp(1, 1_000_000);
    if c.read_only && !READ_WORDS.contains(&first_word(&sql).as_str()) {
        return Err(e("READ_ONLY", "읽기 전용 연결이라 조회 문장만 실행합니다"));
    }
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    let started = Instant::now();
    let mut first_row_ms = None;
    let mut columns: Vec<Col> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut affected = None;
    let mut truncated = false;
    let mut has_set = false;
    match &c.engine {
        Engine::Pg { client, cancel } => {
            let stream = client.simple_query_raw(&sql).await.map_err(pg_err)?;
            pin_mut!(stream);
            while let Some(m) = stream.next().await {
                match m {
                    Ok(tokio_postgres::SimpleQueryMessage::RowDescription(cols)) => {
                        has_set = true;
                        columns = cols.iter().map(|c| Col { name: c.name().to_string(), kind: "text" }).collect();
                        rows.clear();
                    }
                    Ok(tokio_postgres::SimpleQueryMessage::Row(r)) => {
                        if first_row_ms.is_none() {
                            first_row_ms = Some(started.elapsed().as_millis() as u64);
                        }
                        if rows.len() >= max {
                            truncated = true;
                            let _ = cancel.cancel_query(tokio_postgres::NoTls).await;
                            break;
                        }
                        rows.push((0..r.len()).map(|i| r.get(i).map(String::from)).collect());
                    }
                    Ok(tokio_postgres::SimpleQueryMessage::CommandComplete(n)) => affected = Some(n),
                    Ok(_) => {}
                    Err(x) => {
                        let err = pg_err(x);
                        if truncated && err.code == "CANCELLED" {
                            break;
                        }
                        return Err(err);
                    }
                }
            }
            if truncated {
                // 취소 뒤 남은 메시지를 비워 연결을 다음 문장에 쓸 수 있게
                while let Some(m) = stream.next().await {
                    if m.is_err() {
                        break;
                    }
                }
            }
        }
        Engine::My { conn, .. } => {
            let mut g = conn.lock().await;
            let mut res = g.query_iter(sql.as_str()).await.map_err(my_err)?;
            let cols = res.columns_ref().to_vec();
            if !cols.is_empty() {
                has_set = true;
                columns = cols.iter().map(|c| Col { name: c.name_str().to_string(), kind: my_kind(c.column_type()) }).collect();
            }
            while let Some(row) = res.next().await.map_err(my_err)? {
                if first_row_ms.is_none() {
                    first_row_ms = Some(started.elapsed().as_millis() as u64);
                }
                if rows.len() >= max {
                    truncated = true;
                    continue; // MySQL 은 남은 행을 읽어 버려야 연결을 다시 쓸 수 있다
                }
                rows.push(row.unwrap().into_iter().map(my_value).collect());
            }
            affected = Some(res.affected_rows());
            res.drop_result().await.map_err(my_err)?;
        }
    }
    let row_count = rows.len();
    let result_id = if has_set {
        let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
        dbs.results.lock().unwrap().insert(id, Arc::new(ResultSet { columns: columns.clone(), rows }));
        Some(id)
    } else {
        None
    };
    Ok(QueryOk { result_id, columns, row_count, affected, truncated, ms: started.elapsed().as_millis() as u64, first_row_ms })
}

#[tauri::command]
pub async fn db_cancel(dbs: State<'_, DbConns>, conn: u32) -> R<()> {
    let c = dbs.get(conn)?;
    match &c.engine {
        Engine::Pg { cancel, .. } => cancel.cancel_query(tokio_postgres::NoTls).await.map_err(pg_err),
        Engine::My { opts, thread, .. } => {
            let mut k = mysql_async::Conn::new(opts.clone()).await.map_err(my_err)?;
            k.query_drop(format!("KILL QUERY {thread}")).await.map_err(my_err)?;
            let _ = k.disconnect().await;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn db_rows(dbs: State<'_, DbConns>, result: u32, from: usize, to: usize) -> R<Vec<Vec<Option<String>>>> {
    Ok(db_rows_core(&dbs, result, from, to))
}

pub(crate) fn db_rows_core(dbs: &DbConns, result: u32, from: usize, to: usize) -> Vec<Vec<Option<String>>> {
    let Some(r) = dbs.results.lock().unwrap().get(&result).cloned() else {
        return Vec::new();
    };
    let to = to.min(r.rows.len());
    r.rows[from.min(to)..to].to_vec()
}

#[allow(dead_code)]
fn _unused_rows(dbs: &DbConns, result: u32, from: usize, to: usize) -> R<Vec<Vec<Option<String>>>> {
    let r = dbs.results.lock().unwrap().get(&result).cloned().ok_or_else(|| e("CLOSED", "결과가 없습니다"))?;
    let to = to.min(r.rows.len());
    Ok(r.rows[from.min(to)..to].to_vec())
}

#[tauri::command]
pub fn db_result_close(dbs: State<'_, DbConns>, result: u32) {
    dbs.results.lock().unwrap().remove(&result);
}

/// 결과를 파일로 — csv(UTF-8 BOM, 엑셀이 한글을 바로 읽게) · tsv · json
#[tauri::command]
pub fn db_export(dbs: State<'_, DbConns>, result: u32, format: String, path: String) -> R<usize> {
    let r = dbs.results.lock().unwrap().get(&result).cloned().ok_or_else(|| e("CLOSED", "결과가 없습니다"))?;
    let mut out = String::new();
    match format.as_str() {
        "json" => {
            let arr: Vec<serde_json::Map<String, serde_json::Value>> = r
                .rows
                .iter()
                .map(|row| {
                    r.columns
                        .iter()
                        .zip(row)
                        .map(|(c, v)| (c.name.clone(), v.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)))
                        .collect()
                })
                .collect();
            out = serde_json::to_string_pretty(&arr).map_err(|x| e("OTHER", x.to_string()))?;
        }
        f => {
            let sep = if f == "tsv" { '\t' } else { ',' };
            let cell = |s: &str| -> String {
                if sep == ',' && (s.contains([',', '"', '\n', '\r'])) {
                    format!("\"{}\"", s.replace('"', "\"\""))
                } else if sep == '\t' {
                    s.replace(['\t', '\n'], " ")
                } else {
                    s.to_string()
                }
            };
            if f == "csv" {
                out.push('\u{feff}');
            }
            out.push_str(&r.columns.iter().map(|c| cell(&c.name)).collect::<Vec<_>>().join(&sep.to_string()));
            out.push_str("\r\n");
            for row in &r.rows {
                out.push_str(&row.iter().map(|v| v.as_deref().map(cell).unwrap_or_default()).collect::<Vec<_>>().join(&sep.to_string()));
                out.push_str("\r\n");
            }
        }
    }
    std::fs::write(&path, out).map_err(|x| e("OTHER", x.to_string()))?;
    Ok(r.rows.len())
}

// ── 객체 트리 ───────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbNode {
    name: String,
    /// schema | table | view | column
    kind: &'static str,
    detail: Option<String>,
}

async fn rows_of(c: &DbConn, sql: &str) -> R<Vec<Vec<Option<String>>>> {
    match &c.engine {
        Engine::Pg { client, .. } => {
            let msgs = client.simple_query(sql).await.map_err(pg_err)?;
            Ok(msgs
                .into_iter()
                .filter_map(|m| if let tokio_postgres::SimpleQueryMessage::Row(r) = m { Some((0..r.len()).map(|i| r.get(i).map(String::from)).collect()) } else { None })
                .collect())
        }
        Engine::My { conn, .. } => {
            let mut g = conn.lock().await;
            let rows: Vec<mysql_async::Row> = g.query(sql).await.map_err(my_err)?;
            Ok(rows.into_iter().map(|r| r.unwrap().into_iter().map(my_value).collect()).collect())
        }
    }
}

/// 객체 트리 한 층 — path 가 비면 스키마(MySQL 은 데이터베이스), [스키마] 면 표·뷰, [스키마, 표] 면 열
#[tauri::command]
pub async fn db_tree(dbs: State<'_, DbConns>, conn: u32, path: Vec<String>) -> R<Vec<DbNode>> {
    tree(&dbs, conn, path).await
}

pub(crate) async fn tree(dbs: &DbConns, conn: u32, path: Vec<String>) -> R<Vec<DbNode>> {
    let c = dbs.get(conn)?;
    let my = matches!(c.engine, Engine::My { .. });
    let s = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten().unwrap_or_default();
    match path.as_slice() {
        [] => {
            let sql = if my {
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','sys','mysql') ORDER BY 1"
            } else {
                "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' ORDER BY nspname = 'public' DESC, 1"
            };
            Ok(rows_of(&c, sql).await?.iter().map(|r| DbNode { name: s(r, 0), kind: "schema", detail: None }).collect())
        }
        [schema] => {
            let sql = format!(
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = {} ORDER BY table_type, table_name",
                lit(schema, my)
            );
            Ok(rows_of(&c, &sql)
                .await?
                .iter()
                .map(|r| DbNode { name: s(r, 0), kind: if s(r, 1).contains("VIEW") { "view" } else { "table" }, detail: None })
                .collect())
        }
        [schema, table] => {
            let sql = format!(
                "SELECT column_name, {}, is_nullable FROM information_schema.columns WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
                if my { "column_type" } else { "data_type" },
                lit(schema, my),
                lit(table, my)
            );
            Ok(rows_of(&c, &sql)
                .await?
                .iter()
                .map(|r| DbNode {
                    name: s(r, 0),
                    kind: "column",
                    detail: Some(format!("{}{}", s(r, 1), if s(r, 2) == "NO" { " · NOT NULL" } else { "" })),
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_word_skips_comments() {
        assert_eq!(first_word("  -- hi\n /* x */ (SELECT 1)"), "select");
        assert_eq!(first_word("update t set a=1"), "update");
        assert_eq!(first_word("WITH x AS (select 1) select * from x"), "with");
    }

    #[test]
    fn literals_escape() {
        assert_eq!(lit("o'b\\", false), "'o''b\\'");
        assert_eq!(lit("o'b\\", true), "'o''b\\\\'");
    }
}

/// 실제 DB 로 — `RB_DB_TEST=pg:127.0.0.1:25432,maria:127.0.0.1:23306` 와 `RB_DB_TEST_PW` 를 줄 때만
#[cfg(test)]
mod live {
    use super::*;

    fn req(engine: &str, host: &str, port: u16, pw: Option<&str>, read_only: bool) -> DbConnectReq {
        let my = engine != "postgres";
        DbConnectReq {
            profile_id: None,
            engine: engine.into(),
            host: host.into(),
            port,
            username: if my { "root".into() } else { "postgres".into() },
            password: pw.map(Into::into),
            database: Some(if my { "shop".into() } else { "postgres".into() }),
            read_only,
            save_secret: false,
            legacy: false,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_db_round_trip() {
        let spec = std::env::var("RB_DB_TEST").expect("RB_DB_TEST");
        let pw = std::env::var("RB_DB_TEST_PW").expect("RB_DB_TEST_PW");
        let dir = std::env::temp_dir().join(format!("rbshell-dbtest-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let dbs = DbConns::default();
        for item in spec.split(',') {
            let mut it = item.split(':');
            let kind = it.next().unwrap();
            let host = it.next().unwrap();
            let port: u16 = it.next().unwrap().parse().unwrap();
            let engine = if kind == "pg" { "postgres" } else { "mariadb" };
            println!("== {engine}");
            let need = connect(&store, &dbs, req(engine, host, port, None, false)).await.err().unwrap();
            println!("암호 없이 → {} ({})", need.code, need.message);
            let t0 = Instant::now();
            let ok = connect(&store, &dbs, req(engine, host, port, Some(&pw), false)).await.unwrap();
            println!("접속 {} ms · {}", t0.elapsed().as_millis(), ok.version);
            let c = ok.conn_id;
            let gen = if engine == "postgres" {
                "CREATE TABLE IF NOT EXISTS rb_t AS SELECT g AS id, 'user ' || g AS name, now() - g * interval '1 minute' AS at, (g % 7 = 0) AS flag, '{\"k\":1}'::jsonb AS j, NULL::text AS memo FROM generate_series(1, 200000) g"
            } else {
                "CREATE TABLE IF NOT EXISTS rb_t AS WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM s WHERE g < 200000) SELECT g AS id, CONCAT('user ', g) AS name, NOW() - INTERVAL g MINUTE AS at, (g % 7 = 0) AS flag, JSON_OBJECT('k', 1) AS j, CAST(NULL AS CHAR) AS memo FROM s"
            };
            if engine != "postgres" {
                query(&dbs, c, "SET SESSION cte_max_recursion_depth = 1000000".into(), None).await.ok();
                query(&dbs, c, "SET SESSION max_recursive_iterations = 1000000".into(), None).await.ok();
            }
            let made = query(&dbs, c, gen.into(), None).await.unwrap();
            println!("표 만들기 {} ms, affected {:?}", made.ms, made.affected);
            let q = query(&dbs, c, "SELECT * FROM rb_t ORDER BY id".into(), Some(100_000)).await.unwrap();
            println!("20만 행 중 10만 상한 → {} 행, truncated {}, 첫 행 {:?} ms, 전체 {} ms", q.row_count, q.truncated, q.first_row_ms, q.ms);
            assert_eq!(q.row_count, 100_000);
            assert!(q.truncated);
            let page = db_rows_core(&dbs, q.result_id.unwrap(), 0, 2);
            println!("첫 두 행 {:?} · 열 {:?}", page, q.columns.iter().map(|c| format!("{}:{}", c.name, c.kind)).collect::<Vec<_>>());
            // 같은 연결로 다음 문장(취소 뒤 연결이 살아 있는지)
            let one = query(&dbs, c, "SELECT count(*) FROM rb_t".into(), None).await.unwrap();
            println!("다음 문장 OK ({} ms)", one.ms);
            // 취소
            let sleep = if engine == "postgres" { "SELECT pg_sleep(10)" } else { "SELECT SLEEP(10)" };
            let t = Instant::now();
            let fut = query(&dbs, c, sleep.into(), None);
            let canceller = async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let cc = dbs.get(c).unwrap();
                match &cc.engine {
                    Engine::Pg { cancel, .. } => cancel.cancel_query(tokio_postgres::NoTls).await.map_err(pg_err).unwrap(),
                    Engine::My { opts, thread, .. } => {
                        let mut k = mysql_async::Conn::new(opts.clone()).await.unwrap();
                        k.query_drop(format!("KILL QUERY {thread}")).await.unwrap();
                    }
                }
            };
            let (r, _) = tokio::join!(fut, canceller);
            println!("취소 → {:?} 걸린 {} ms", r.as_ref().err().map(|e| e.code).or(Some("결과 받음(MySQL SLEEP 은 1 을 돌려줌)")), t.elapsed().as_millis());
            assert!(t.elapsed() < Duration::from_secs(3));
            // 트리
            let schemas = tree(&dbs, c, vec![]).await.unwrap();
            let first = if engine == "postgres" { "public".to_string() } else { "shop".to_string() };
            assert!(schemas.iter().any(|s| s.name == first));
            let cols = tree(&dbs, c, vec![first.clone(), "rb_t".into()]).await.unwrap();
            println!("열: {:?}", cols.iter().map(|x| format!("{} {}", x.name, x.detail.clone().unwrap_or_default())).collect::<Vec<_>>());
            // 읽기 전용
            let ro = connect(&store, &dbs, req(engine, host, port, Some(&pw), true)).await.unwrap();
            let w = query(&dbs, ro.conn_id, "DELETE FROM rb_t WHERE id = 1".into(), None).await.err().unwrap();
            assert_eq!(w.code, "READ_ONLY");
            let w2 = query(&dbs, ro.conn_id, "WITH x AS (DELETE FROM rb_t WHERE id = 1 RETURNING id) SELECT * FROM x".into(), None).await.err().map(|e| e.code);
            println!("읽기 전용: DELETE → READ_ONLY, CTE 안 DELETE → {w2:?}");
            assert!(matches!(w2, Some("READ_ONLY") | Some("SQL")));
            query(&dbs, c, "DROP TABLE rb_t".into(), None).await.unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
