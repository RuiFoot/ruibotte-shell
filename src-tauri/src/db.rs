//! DB 접속 — PostgreSQL(tokio-postgres)·MySQL/MariaDB(mysql_async).
//! - PG 는 simple query(텍스트 형식)로 받아 어떤 타입이든 서버가 보여 주는 글 그대로 표시한다.
//! - 결과 행은 Rust 쪽에 두고 화면은 보이는 구간만 받는다(`db_rows`). 행 상한을 넘으면 서버 쪽에서 취소.
//! - 읽기 전용: 세션을 READ ONLY 로 + 문장 첫 낱말 검사(이중).
//! - 취소: PG CancelRequest, MySQL 은 다른 연결로 KILL QUERY.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{pin_mut, StreamExt, TryStreamExt};
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tiberius::FromSql;
use tokio_util::compat::TokioAsyncWriteCompatExt;

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

fn ms_err(x: tiberius::error::Error) -> DbError {
    match &x {
        tiberius::error::Error::Server(t) => match t.code() {
            18456 => e("AUTH_FAILED", t.message().to_string()),
            3981 | 3906 => e("READ_ONLY", t.message().to_string()),
            c => e("SQL", format!("{} ({c})", t.message())),
        },
        tiberius::error::Error::Io { .. } => e("NETWORK", x.to_string()),
        _ => e("OTHER", x.to_string()),
    }
}

fn jdbc_err(v: &Value) -> DbError {
    let code = match v["code"].as_str().unwrap_or("") {
        "AUTH_FAILED" => "AUTH_FAILED",
        "NETWORK" => "NETWORK",
        "CANCELLED" => "CANCELLED",
        "BUSY" => "BUSY",
        "CLOSED" => "CLOSED",
        "SQL" => "SQL",
        _ => "OTHER",
    };
    e(code, v["message"].as_str().unwrap_or("JDBC 오류").to_string())
}

type MsClient = tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>;

// 연결마다 하나뿐이라 크기 차이는 상관없다
#[allow(clippy::large_enum_variant)]
enum Engine {
    Pg { client: tokio_postgres::Client, cancel: tokio_postgres::CancelToken },
    My { conn: tokio::sync::Mutex<mysql_async::Conn>, opts: mysql_async::Opts, thread: u32 },
    Ms { client: tokio::sync::Mutex<MsClient> },
    Jdbc { side: crate::jdbc::Sidecar },
}

impl Engine {
    /// 화면이 감출 기능 — readOnlySession(세션 자체를 읽기 전용으로), cancel(실행 중 취소)
    fn features(&self) -> Vec<&'static str> {
        match self {
            Engine::Pg { .. } | Engine::My { .. } => vec!["readOnlySession", "cancel"],
            Engine::Ms { .. } => vec![],
            Engine::Jdbc { .. } => vec!["cancel"],
        }
    }
}

pub(crate) struct DbConn {
    engine: Engine,
    read_only: bool,
    busy: tokio::sync::Mutex<()>,
    /// 수동 트랜잭션이 열려 있는지
    in_tx: std::sync::atomic::AtomicBool,
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
    /// 정렬·거르기 보기 — 화면 행 번호 → 원래 행 번호. None 이면 받은 순서 그대로
    view: Mutex<Option<Vec<usize>>>,
}

impl ResultSet {
    fn visible(&self) -> Vec<&Vec<Option<String>>> {
        match &*self.view.lock().unwrap() {
            Some(v) => v.iter().filter_map(|&i| self.rows.get(i)).collect(),
            None => self.rows.iter().collect(),
        }
    }
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
    features: Vec<&'static str>,
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
pub async fn db_connect(app: AppHandle, store: State<'_, Store>, dbs: State<'_, DbConns>, req: DbConnectReq) -> R<DbConnectOk> {
    connect(&store, &dbs, req, Some(&app)).await
}

pub(crate) async fn connect(store: &Store, dbs: &DbConns, req: DbConnectReq, app: Option<&AppHandle>) -> R<DbConnectOk> {
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
    } else if req.engine == "mssql" {
        let Some(p) = pw.clone() else {
            return Err(e("NEED_SECRET", "암호를 입력하세요"));
        };
        let mut cfg = tiberius::Config::new();
        cfg.host(&req.host);
        cfg.port(req.port);
        if let Some(d) = req.database.as_deref().filter(|d| !d.is_empty()) {
            cfg.database(d);
        }
        cfg.authentication(tiberius::AuthMethod::sql_server(&req.username, &p));
        cfg.application_name("RuiBotte Shell");
        // 사내 SQL Server 는 자체 서명 인증서가 흔하다 — 암호화는 하되 인증서 체인은 묻지 않는다
        cfg.trust_cert();
        let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((req.host.as_str(), req.port)))
            .await
            .map_err(|_| e("NETWORK", format!("{}:{} 에 닿지 못했습니다", req.host, req.port)))?
            .map_err(|x| e("NETWORK", x.to_string()))?;
        let _ = tcp.set_nodelay(true);
        let mut client = tiberius::Client::connect(cfg, tcp.compat_write()).await.map_err(ms_err)?;
        let version = client
            .simple_query("SELECT @@VERSION")
            .await
            .map_err(ms_err)?
            .into_row()
            .await
            .map_err(ms_err)?
            .and_then(|r| r.get::<&str, _>(0).map(|v| v.lines().next().unwrap_or("").trim().to_string()))
            .unwrap_or_default();
        (Engine::Ms { client: tokio::sync::Mutex::new(client) }, version)
    } else if let Some(je) = crate::jdbc::engine(&req.engine) {
        let app = app.ok_or_else(|| e("OTHER", "앱 상태가 없습니다"))?;
        let Some(p) = pw.clone() else {
            return Err(e("NEED_SECRET", "암호를 입력하세요"));
        };
        let side = match crate::jdbc::Sidecar::spawn(app, je.key).await {
            Ok(s) => s,
            Err(m) if m == "NEED_JAVA" => return Err(e("NEED_JAVA", "Java 실행기를 먼저 받아야 합니다")),
            Err(m) if m == "NEED_DRIVER" => return Err(e("NEED_DRIVER", format!("{} 드라이버가 없습니다", je.label))),
            Err(m) => return Err(e("OTHER", m)),
        };
        let url = crate::jdbc::build_url(je, &req.host, req.port, req.database.as_deref().unwrap_or(""));
        let v = side
            .call(json!({"op": "connect", "url": url, "user": req.username, "password": p, "driver": je.driver_class, "readOnly": req.read_only}))
            .await
            .map_err(|m| e("CLOSED", m))?;
        if v["type"] == "error" {
            let err = jdbc_err(&v);
            return Err(err);
        }
        (Engine::Jdbc { side }, v["version"].as_str().unwrap_or("").to_string())
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
    let features = engine.features();
    let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
    dbs.map.lock().unwrap().insert(id, Arc::new(DbConn { engine, read_only: req.read_only, busy: Default::default(), in_tx: Default::default() }));
    Ok(DbConnectOk { conn_id: id, features, version, database: req.database, used_saved_secret: used_saved })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTestOk {
    ms: u64,
    version: String,
}

/// 연결 테스트 — 접속·인증·버전 확인까지 하고 바로 닫는다(암호는 저장하지 않음)
#[tauri::command]
pub async fn db_test(app: AppHandle, store: State<'_, Store>, dbs: State<'_, DbConns>, req: DbConnectReq) -> R<DbTestOk> {
    let t = std::time::Instant::now();
    let mut req = req;
    req.save_secret = false;
    let ok = connect(&store, &dbs, req, Some(&app)).await?;
    let ms = t.elapsed().as_millis() as u64;
    close(&dbs, ok.conn_id).await;
    Ok(DbTestOk { ms, version: ok.version })
}

#[tauri::command]
pub async fn db_disconnect(dbs: State<'_, DbConns>, conn: u32) -> R<()> {
    close(&dbs, conn).await;
    Ok(())
}

async fn close(dbs: &DbConns, conn: u32) {
    let c = dbs.map.lock().unwrap().remove(&conn);
    if let Some(c) = c {
        match &c.engine {
            Engine::My { conn, .. } => {
                let _ = conn.lock().await.query_drop("DO 0").await;
            }
            Engine::Jdbc { side } => {
                let _ = side.call(json!({"op": "close"})).await;
            }
            _ => {}
        }
    }
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

fn ms_kind(t: tiberius::ColumnType) -> &'static str {
    use tiberius::ColumnType::*;
    match t {
        Int1 | Int2 | Int4 | Int8 | Intn => "int",
        Float4 | Float8 | Floatn | Money | Money4 | Decimaln | Numericn => "numeric",
        Datetime | Datetime4 | Datetimen | Daten | Timen | Datetime2 | DatetimeOffsetn => "date",
        Bit | Bitn => "bool",
        BigVarBin | BigBinary | Image => "binary",
        _ => "text",
    }
}

fn ms_value(d: tiberius::ColumnData<'static>) -> Option<String> {
    use tiberius::ColumnData as C;
    match &d {
        C::U8(v) => v.map(|x| x.to_string()),
        C::I16(v) => v.map(|x| x.to_string()),
        C::I32(v) => v.map(|x| x.to_string()),
        C::I64(v) => v.map(|x| x.to_string()),
        C::F32(v) => v.map(|x| x.to_string()),
        C::F64(v) => v.map(|x| x.to_string()),
        C::Bit(v) => v.map(|b| if b { "1".into() } else { "0".into() }),
        C::String(v) => v.as_ref().map(|x| x.to_string()),
        C::Guid(v) => v.map(|g| g.to_string()),
        C::Binary(v) => v.as_ref().map(|b| format!("0x{}", b.iter().take(64).map(|x| format!("{x:02X}")).collect::<String>())),
        C::Numeric(v) => v.map(|n| n.to_string()),
        C::Xml(v) => v.as_ref().map(|x| x.to_string()),
        C::Date(_) => time::Date::from_sql(&d).ok().flatten().map(|x| x.to_string()),
        C::Time(_) => time::Time::from_sql(&d).ok().flatten().map(fmt_time),
        C::DateTimeOffset(_) => time::OffsetDateTime::from_sql(&d).ok().flatten().map(|x| {
            let o = x.offset();
            format!("{} {}{}{:02}:{:02}", x.date(), fmt_time(x.time()), if o.is_negative() { "-" } else { "+" }, o.whole_hours().abs(), o.minutes_past_hour().abs())
        }),
        C::DateTime(_) | C::SmallDateTime(_) | C::DateTime2(_) => time::PrimitiveDateTime::from_sql(&d).ok().flatten().map(|x| format!("{} {}", x.date(), fmt_time(x.time()))),
    }
}

/// 12:03:04.1234567 — 시·분·초는 두 자리, 소수 끝 0 은 뺀다
fn fmt_time(t: time::Time) -> String {
    let ns = t.nanosecond();
    let frac = if ns == 0 { String::new() } else { format!(".{ns:09}").trim_end_matches('0').to_string() };
    format!("{:02}:{:02}:{:02}{frac}", t.hour(), t.minute(), t.second())
}

fn kind_of(s: &str) -> &'static str {
    match s {
        "int" => "int",
        "numeric" => "numeric",
        "date" => "date",
        "bool" => "bool",
        "binary" => "binary",
        "json" => "json",
        _ => "text",
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
        Engine::Ms { client } => {
            let mut g = client.lock().await;
            let fw = first_word(&sql);
            if READ_WORDS.contains(&fw.as_str()) || fw == "exec" || fw == "execute" || fw == "sp_help" {
                let mut stream = g.simple_query(sql.as_str()).await.map_err(ms_err)?;
                let mut set: Option<usize> = None;
                while let Some(item) = stream.try_next().await.map_err(ms_err)? {
                    match item {
                        tiberius::QueryItem::Metadata(m) => {
                            if set.is_none() {
                                set = Some(m.result_index());
                                has_set = true;
                                columns = m.columns().iter().map(|c| Col { name: c.name().to_string(), kind: ms_kind(c.column_type()) }).collect();
                            }
                        }
                        tiberius::QueryItem::Row(r) => {
                            if Some(r.result_index()) != set {
                                continue;
                            }
                            if first_row_ms.is_none() {
                                first_row_ms = Some(started.elapsed().as_millis() as u64);
                            }
                            if rows.len() >= max {
                                truncated = true;
                                continue;
                            }
                            rows.push(r.into_iter().map(ms_value).collect());
                        }
                    }
                }
            } else {
                let res = g.execute(sql.as_str(), &[]).await.map_err(ms_err)?;
                affected = Some(res.total());
            }
        }
        Engine::Jdbc { side } => {
            let (id, mut rx) = side.request(json!({"op": "query", "sql": sql, "maxRows": max})).await.map_err(|m| e("CLOSED", m))?;
            let outcome = loop {
                let Some(v) = rx.recv().await else {
                    break Err(e("CLOSED", "JDBC 브리지가 끝났습니다"));
                };
                match v["type"].as_str() {
                    Some("columns") => {
                        has_set = true;
                        columns = v["columns"]
                            .as_array()
                            .map(|a| a.iter().map(|c| Col { name: c["name"].as_str().unwrap_or("").to_string(), kind: kind_of(c["kind"].as_str().unwrap_or("")) }).collect())
                            .unwrap_or_default();
                    }
                    Some("rows") => {
                        if first_row_ms.is_none() {
                            first_row_ms = Some(started.elapsed().as_millis() as u64);
                        }
                        for r in v["rows"].as_array().into_iter().flatten() {
                            rows.push(r.as_array().map(|x| x.iter().map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default());
                        }
                    }
                    Some("done") => {
                        affected = v["affected"].as_u64();
                        truncated = v["truncated"].as_bool().unwrap_or(false);
                        break Ok(());
                    }
                    Some("error") => break Err(jdbc_err(&v)),
                    _ => {}
                }
            };
            side.done(id);
            outcome?;
        }
    }
    let row_count = rows.len();
    let result_id = if has_set {
        let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
        dbs.results.lock().unwrap().insert(id, Arc::new(ResultSet { columns: columns.clone(), rows, view: Mutex::new(None) }));
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
        Engine::Ms { .. } => Err(e("OTHER", "SQL Server 는 아직 실행 중 취소를 지원하지 않습니다")),
        Engine::Jdbc { side } => {
            side.call(json!({"op": "cancel"})).await.map_err(|m| e("CLOSED", m))?;
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
    let view = r.view.lock().unwrap();
    match &*view {
        Some(v) => {
            let to = to.min(v.len());
            v[from.min(to)..to].iter().filter_map(|&i| r.rows.get(i).cloned()).collect()
        }
        None => {
            let to = to.min(r.rows.len());
            r.rows[from.min(to)..to].to_vec()
        }
    }
}

/// 받은 행을 정렬·거르기 — 서버에 다시 묻지 않는다. 숫자 열은 숫자로, NULL 은 늘 맨 뒤.
/// 거르기: 낱말을 띄어 쓰면 모두 들어간 행(대소문자 무시, 아무 열). 돌려주는 값은 보이는 행 수
pub(crate) fn view_core(r: &ResultSet, sort: Option<usize>, desc: bool, filter: Option<&str>) -> usize {
    let words: Vec<String> = filter.unwrap_or("").split_whitespace().map(|w| w.to_lowercase()).collect();
    if sort.is_none() && words.is_empty() {
        *r.view.lock().unwrap() = None;
        return r.rows.len();
    }
    let mut idx: Vec<usize> = (0..r.rows.len())
        .filter(|&i| {
            words.is_empty() || {
                let hay: String = r.rows[i].iter().map(|v| v.as_deref().unwrap_or("null").to_lowercase()).collect::<Vec<_>>().join("");
                words.iter().all(|w| hay.contains(w.as_str()))
            }
        })
        .collect();
    if let Some(c) = sort.filter(|c| *c < r.columns.len()) {
        let numeric = matches!(r.columns[c].kind, "int" | "numeric");
        let key = |i: usize| r.rows[i].get(c).cloned().flatten();
        idx.sort_by(|&a, &b| {
            use std::cmp::Ordering;
            match (key(a), key(b)) {
                (None, None) => Ordering::Equal,
                (None, _) => Ordering::Greater,
                (_, None) => Ordering::Less,
                (Some(x), Some(y)) => {
                    let o = if numeric {
                        match (x.trim().parse::<f64>(), y.trim().parse::<f64>()) {
                            (Ok(p), Ok(q)) => p.partial_cmp(&q).unwrap_or(Ordering::Equal),
                            _ => x.cmp(&y),
                        }
                    } else {
                        x.to_lowercase().cmp(&y.to_lowercase())
                    };
                    if desc { o.reverse() } else { o }
                }
            }
        });
    }
    let n = idx.len();
    *r.view.lock().unwrap() = Some(idx);
    n
}

#[tauri::command]
pub fn db_view(dbs: State<'_, DbConns>, result: u32, sort: Option<usize>, desc: bool, filter: Option<String>) -> R<usize> {
    let r = dbs.results.lock().unwrap().get(&result).cloned().ok_or_else(|| e("CLOSED", "결과가 없습니다"))?;
    Ok(view_core(&r, sort, desc, filter.as_deref()))
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
                .visible()
                .into_iter()
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
            for row in r.visible() {
                out.push_str(&row.iter().map(|v| v.as_deref().map(cell).unwrap_or_default()).collect::<Vec<_>>().join(&sep.to_string()));
                out.push_str("\r\n");
            }
        }
    }
    std::fs::write(&path, out).map_err(|x| e("OTHER", x.to_string()))?;
    Ok(r.visible().len())
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
        Engine::Ms { client } => {
            let mut g = client.lock().await;
            let rows = g.simple_query(sql).await.map_err(ms_err)?.into_first_result().await.map_err(ms_err)?;
            Ok(rows.into_iter().map(|r| r.into_iter().map(ms_value).collect()).collect())
        }
        Engine::Jdbc { .. } => Ok(Vec::new()),
    }
}

/// 객체 트리 한 층 — path 가 비면 스키마(MySQL 은 데이터베이스), [스키마] 면 표·뷰, [스키마, 표] 면 열
#[tauri::command]
pub async fn db_tree(dbs: State<'_, DbConns>, conn: u32, path: Vec<String>) -> R<Vec<DbNode>> {
    tree(&dbs, conn, path).await
}

pub(crate) async fn tree(dbs: &DbConns, conn: u32, path: Vec<String>) -> R<Vec<DbNode>> {
    let c = dbs.get(conn)?;
    if let Engine::Jdbc { side } = &c.engine {
        let v = side.call(json!({"op": "tree", "path": path})).await.map_err(|m| e("CLOSED", m))?;
        if v["type"] == "error" {
            return Err(jdbc_err(&v));
        }
        return Ok(v["nodes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|n| DbNode {
                        name: n["name"].as_str().unwrap_or("").to_string(),
                        kind: match n["kind"].as_str() {
                            Some("schema") => "schema",
                            Some("view") => "view",
                            Some("column") => "column",
                            _ => "table",
                        },
                        detail: n["detail"].as_str().map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default());
    }
    let my = matches!(c.engine, Engine::My { .. });
    let ms = matches!(c.engine, Engine::Ms { .. });
    let s = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten().unwrap_or_default();
    match path.as_slice() {
        [] => {
            let sql = if my {
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','sys','mysql') ORDER BY 1"
            } else if ms {
                "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name"
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

// ── 표 편집·트랜잭션 ───────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColMeta {
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    pk: bool,
    enum_values: Option<Vec<String>>,
}

fn truthy(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("t" | "true" | "1" | "YES" | "TRUE"))
}

/// 표 열 정보 — 형식·NULL 허용·기본값·PK·enum 값(편집기와 SQL 만들기에 씀)
#[tauri::command]
pub async fn db_table_meta(dbs: State<'_, DbConns>, conn: u32, schema: Option<String>, table: String) -> R<Vec<ColMeta>> {
    let c = dbs.get(conn)?;
    if let Engine::Jdbc { side } = &c.engine {
        let v = side.call(json!({"op": "meta", "schema": schema, "table": table})).await.map_err(|m| e("CLOSED", m))?;
        if v["type"] == "error" {
            return Err(jdbc_err(&v));
        }
        return Ok(v["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| ColMeta {
                name: x["name"].as_str().unwrap_or("").into(),
                data_type: x["dataType"].as_str().unwrap_or("").into(),
                nullable: x["nullable"].as_bool().unwrap_or(true),
                default: x["default"].as_str().map(String::from),
                pk: x["pk"].as_bool().unwrap_or(false),
                enum_values: None,
            })
            .collect());
    }
    let my = matches!(c.engine, Engine::My { .. });
    let s = schema.unwrap_or_default();
    let sql = match &c.engine {
        Engine::Pg { .. } => format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text, pg_get_expr(d.adbin, d.adrelid),
                    coalesce(a.attnum = ANY(i.indkey), false)::text,
                    (SELECT string_agg(enumlabel, chr(31) ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = a.atttypid)
             FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             LEFT JOIN pg_index i ON i.indrelid = cl.oid AND i.indisprimary
             WHERE n.nspname = {} AND cl.relname = {} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            lit(&s, false),
            lit(&table, false)
        ),
        Engine::My { .. } => format!(
            "SELECT column_name, column_type, IF(is_nullable = 'YES', '1', '0'), column_default, IF(column_key = 'PRI', '1', '0'), NULL
             FROM information_schema.columns WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
            lit(&s, true),
            lit(&table, true)
        ),
        _ => format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NULL THEN '' WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)' ELSE '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')' END,
                    CASE c.IS_NULLABLE WHEN 'YES' THEN '1' ELSE '0' END, c.COLUMN_DEFAULT,
                    CASE WHEN k.COLUMN_NAME IS NULL THEN '0' ELSE '1' END, NULL
             FROM INFORMATION_SCHEMA.COLUMNS c
             LEFT JOIN (SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = {s} AND tc.TABLE_NAME = {t}) k ON k.COLUMN_NAME = c.COLUMN_NAME
             WHERE c.TABLE_SCHEMA = {s} AND c.TABLE_NAME = {t} ORDER BY c.ORDINAL_POSITION",
            s = lit(&s, false),
            t = lit(&table, false)
        ),
    };
    let rows = rows_of(&c, &sql).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let data_type = r.get(1).cloned().flatten().unwrap_or_default();
            let enum_values = if my && data_type.starts_with("enum(") {
                Some(data_type[5..data_type.len() - 1].split(',').map(|x| x.trim().trim_matches('\'').replace("''", "'")).collect())
            } else {
                r.get(5).cloned().flatten().map(|x| x.split('\u{1f}').map(String::from).collect())
            };
            ColMeta {
                name: r.first().cloned().flatten().unwrap_or_default(),
                data_type,
                nullable: truthy(&r.get(2).cloned().flatten()),
                default: r.get(3).cloned().flatten(),
                pk: truthy(&r.get(4).cloned().flatten()),
                enum_values,
            }
        })
        .collect())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStmt {
    sql: String,
    params: Vec<Option<String>>,
    /// UPDATE·DELETE 는 정확히 1행이어야 한다(아니면 전부 되돌림)
    expect_one: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOk {
    affected: Vec<u64>,
    in_tx: bool,
}

/// 표 편집 반영 — 한 트랜잭션(수동 트랜잭션이 열려 있으면 그 안의 세이브포인트)
#[tauri::command]
pub async fn db_apply(dbs: State<'_, DbConns>, conn: u32, stmts: Vec<EditStmt>) -> R<ApplyOk> {
    apply(&dbs, conn, stmts).await
}

pub(crate) async fn apply(dbs: &DbConns, conn: u32, stmts: Vec<EditStmt>) -> R<ApplyOk> {
    let c = dbs.get(conn)?;
    if c.read_only {
        return Err(e("READ_ONLY", "읽기 전용 연결이라 고칠 수 없습니다"));
    }
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    let in_tx = c.in_tx.load(Ordering::Relaxed);
    let mut affected = Vec::new();
    let one = |n: u64, i: usize, st: &EditStmt| -> R<()> {
        if st.expect_one && n != 1 {
            return Err(e("SQL", format!("{}번째 문장이 {n}행에 닿았습니다(1행이어야 함) — 모두 되돌렸습니다", i + 1)));
        }
        Ok(())
    };
    match &c.engine {
        Engine::Pg { client, .. } => {
            client.batch_execute(if in_tx { "SAVEPOINT rb_apply" } else { "BEGIN" }).await.map_err(pg_err)?;
            let mut res: R<()> = Ok(());
            for (i, st) in stmts.iter().enumerate() {
                let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = st.params.iter().map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
                match client.execute(st.sql.as_str(), &params).await {
                    Ok(n) => {
                        affected.push(n);
                        if let Err(x) = one(n, i, st) {
                            res = Err(x);
                            break;
                        }
                    }
                    Err(x) => {
                        res = Err(pg_err(x));
                        break;
                    }
                }
            }
            let end = match (&res, in_tx) {
                (Ok(()), false) => "COMMIT",
                (Ok(()), true) => "RELEASE SAVEPOINT rb_apply",
                (Err(_), false) => "ROLLBACK",
                (Err(_), true) => "ROLLBACK TO SAVEPOINT rb_apply",
            };
            client.batch_execute(end).await.map_err(pg_err)?;
            res?;
        }
        Engine::My { conn, .. } => {
            let mut g = conn.lock().await;
            g.query_drop(if in_tx { "SAVEPOINT rb_apply" } else { "START TRANSACTION" }).await.map_err(my_err)?;
            let mut res: R<()> = Ok(());
            for (i, st) in stmts.iter().enumerate() {
                let params: Vec<mysql_async::Value> = st.params.iter().map(|p| p.as_ref().map(|s| mysql_async::Value::Bytes(s.clone().into_bytes())).unwrap_or(mysql_async::Value::NULL)).collect();
                match g.exec_iter(st.sql.as_str(), params).await {
                    Ok(r) => {
                        let n = r.affected_rows();
                        let _ = r.drop_result().await;
                        affected.push(n);
                        if let Err(x) = one(n, i, st) {
                            res = Err(x);
                            break;
                        }
                    }
                    Err(x) => {
                        res = Err(my_err(x));
                        break;
                    }
                }
            }
            let end = match (&res, in_tx) {
                (Ok(()), false) => "COMMIT",
                (Ok(()), true) => "RELEASE SAVEPOINT rb_apply",
                (Err(_), false) => "ROLLBACK",
                (Err(_), true) => "ROLLBACK TO SAVEPOINT rb_apply",
            };
            g.query_drop(end).await.map_err(my_err)?;
            res?;
        }
        Engine::Ms { client } => {
            let mut g = client.lock().await;
            g.simple_query(if in_tx { "SAVE TRANSACTION rb_apply" } else { "BEGIN TRANSACTION" }).await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
            let mut res: R<()> = Ok(());
            for (i, st) in stmts.iter().enumerate() {
                let params: Vec<&dyn tiberius::ToSql> = st.params.iter().map(|p| p as &dyn tiberius::ToSql).collect();
                match g.execute(st.sql.as_str(), &params).await {
                    Ok(r) => {
                        let n = r.total();
                        affected.push(n);
                        if let Err(x) = one(n, i, st) {
                            res = Err(x);
                            break;
                        }
                    }
                    Err(x) => {
                        res = Err(ms_err(x));
                        break;
                    }
                }
            }
            let end = match (&res, in_tx) {
                (Ok(()), false) => "COMMIT TRANSACTION",
                (Ok(()), true) => "SELECT 1",
                (Err(_), false) => "ROLLBACK TRANSACTION",
                (Err(_), true) => "ROLLBACK TRANSACTION rb_apply",
            };
            g.simple_query(end).await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
            res?;
        }
        Engine::Jdbc { side } => {
            let v = side.call(json!({"op": "apply", "stmts": stmts, "inTx": in_tx})).await.map_err(|m| e("CLOSED", m))?;
            if v["type"] == "error" {
                return Err(jdbc_err(&v));
            }
            affected = v["affected"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
        }
    }
    Ok(ApplyOk { affected, in_tx })
}

/// 수동 트랜잭션 — begin | commit | rollback
#[tauri::command]
pub async fn db_tx(dbs: State<'_, DbConns>, conn: u32, op: String) -> R<bool> {
    tx(&dbs, conn, op).await
}

pub(crate) async fn tx(dbs: &DbConns, conn: u32, op: String) -> R<bool> {
    let c = dbs.get(conn)?;
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    let sql = match (op.as_str(), &c.engine) {
        ("begin", Engine::Ms { .. }) => "BEGIN TRANSACTION",
        ("begin", Engine::My { .. }) => "START TRANSACTION",
        ("begin", _) => "BEGIN",
        ("commit", Engine::Ms { .. }) => "IF @@TRANCOUNT > 0 COMMIT TRANSACTION",
        ("commit", _) => "COMMIT",
        ("rollback", Engine::Ms { .. }) => "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
        ("rollback", _) => "ROLLBACK",
        _ => return Err(e("OTHER", "알 수 없는 작업")),
    };
    match &c.engine {
        Engine::Pg { client, .. } => client.batch_execute(sql).await.map_err(pg_err)?,
        Engine::My { conn, .. } => conn.lock().await.query_drop(sql).await.map_err(my_err)?,
        Engine::Ms { client } => {
            client.lock().await.simple_query(sql).await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
        }
        Engine::Jdbc { side } => {
            let v = side.call(json!({"op": "tx", "action": op})).await.map_err(|m| e("CLOSED", m))?;
            if v["type"] == "error" {
                return Err(jdbc_err(&v));
            }
        }
    }
    let open = op == "begin";
    c.in_tx.store(open, Ordering::Relaxed);
    Ok(open)
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
            let need = connect(&store, &dbs, req(engine, host, port, None, false), None).await.err().unwrap();
            println!("암호 없이 → {} ({})", need.code, need.message);
            let t0 = Instant::now();
            let ok = connect(&store, &dbs, req(engine, host, port, Some(&pw), false), None).await.unwrap();
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
                    _ => {}
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
            let ro = connect(&store, &dbs, req(engine, host, port, Some(&pw), true), None).await.unwrap();
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

#[cfg(test)]
mod live_mssql {
    use super::*;

    /// `RB_MSSQL_TEST=127.0.0.1:21433` 와 `RB_MSSQL_TEST_PW` 를 줄 때만
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_mssql_round_trip() {
        let spec = std::env::var("RB_MSSQL_TEST").expect("RB_MSSQL_TEST");
        let pw = std::env::var("RB_MSSQL_TEST_PW").expect("RB_MSSQL_TEST_PW");
        let (host, port) = spec.split_once(':').unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-mstest-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let dbs = DbConns::default();
        let req = |ro: bool| DbConnectReq {
            profile_id: None,
            engine: "mssql".into(),
            host: host.into(),
            port: port.parse().unwrap(),
            username: "sa".into(),
            password: Some(pw.clone()),
            database: Some("master".into()),
            read_only: ro,
            save_secret: false,
            legacy: false,
        };
        let t = Instant::now();
        let ok = connect(&store, &dbs, req(false), None).await.unwrap();
        println!("접속 {} ms · {} · 기능 {:?}", t.elapsed().as_millis(), ok.version, ok.features);
        let c = ok.conn_id;
        let _ = query(&dbs, c, "IF OBJECT_ID('dbo.rb_t') IS NOT NULL DROP TABLE dbo.rb_t".into(), None).await;
        let made = query(&dbs, c, "SELECT TOP 200000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS id, CONCAT(N'사용자 ', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))) AS name, SYSDATETIME() AS at, CAST(1 AS bit) AS flag, NEWID() AS g, CAST(12.34 AS decimal(8,2)) AS amt, CAST(NULL AS nvarchar(10)) AS memo INTO dbo.rb_t FROM sys.all_objects a CROSS JOIN sys.all_objects b".into(), None).await.unwrap();
        println!("표 만들기 {} ms affected {:?}", made.ms, made.affected);
        let q = query(&dbs, c, "SELECT * FROM dbo.rb_t ORDER BY id".into(), Some(100_000)).await.unwrap();
        println!("10만 상한 → {} 행 truncated {} 첫 행 {:?} ms 전체 {} ms", q.row_count, q.truncated, q.first_row_ms, q.ms);
        println!("열 {:?}", q.columns.iter().map(|c| format!("{}:{}", c.name, c.kind)).collect::<Vec<_>>());
        println!("첫 행 {:?}", db_rows_core(&dbs, q.result_id.unwrap(), 0, 1));
        assert_eq!(q.row_count, 100_000);
        let n = query(&dbs, c, "SELECT count(*) AS n FROM dbo.rb_t".into(), None).await.unwrap();
        println!("다음 문장 OK {} ms → {:?}", n.ms, db_rows_core(&dbs, n.result_id.unwrap(), 0, 1));
        let up = query(&dbs, c, "UPDATE dbo.rb_t SET memo = N'x' WHERE id <= 10".into(), None).await.unwrap();
        assert_eq!(up.affected, Some(10));
        let schemas = tree(&dbs, c, vec![]).await.unwrap();
        assert_eq!(schemas[0].name, "dbo");
        let cols = tree(&dbs, c, vec!["dbo".into(), "rb_t".into()]).await.unwrap();
        println!("열 트리 {:?}", cols.iter().map(|x| format!("{} {}", x.name, x.detail.clone().unwrap_or_default())).collect::<Vec<_>>());
        let ro = connect(&store, &dbs, req(true), None).await.unwrap();
        assert_eq!(query(&dbs, ro.conn_id, "DELETE FROM dbo.rb_t".into(), None).await.err().unwrap().code, "READ_ONLY");
        query(&dbs, c, "DROP TABLE dbo.rb_t".into(), None).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod live_edit {
    use super::*;

    fn st(sql: &str, p: &[Option<&str>], one: bool) -> EditStmt {
        EditStmt { sql: sql.into(), params: p.iter().map(|x| x.map(String::from)).collect(), expect_one: one }
    }

    /// RB_DB_TEST_PW + Docker(pg 25432·maria 23306·mssql 21433) — 반영·1행 보장·롤백·수동 트랜잭션
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_apply_all_engines() {
        let pw = std::env::var("RB_DB_TEST_PW").expect("RB_DB_TEST_PW");
        let dir = std::env::temp_dir().join(format!("rbshell-edit-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let dbs = DbConns::default();
        let engines = [("postgres", 25432u16, "postgres", pw.clone(), "postgres"), ("mariadb", 23306, "root", pw.clone(), "shop"), ("mssql", 21433, "sa", format!("Rb!{pw}9a"), "master")];
        for (engine, port, user, p, db) in engines {
            let ok = connect(&store, &dbs, DbConnectReq { profile_id: None, engine: engine.into(), host: "127.0.0.1".into(), port, username: user.into(), password: Some(p), database: Some(db.into()), read_only: false, save_secret: false, legacy: false }, None).await.unwrap();
            let c = ok.conn_id;
            let (ph, cast) = match engine { "postgres" => ("$", true), "mssql" => ("@P", false), _ => ("?", false) };
            let a = |n: usize, ty: &str| if ph == "?" { "?".to_string() } else if cast { format!("${n}::text::{ty}") } else { format!("@P{n}") };
            let _ = query(&dbs, c, "DROP TABLE rb_e".into(), None).await;
            let vc = if engine == "mssql" { "nvarchar" } else { "varchar" };
            query(&dbs, c, format!("CREATE TABLE rb_e (id int PRIMARY KEY, name {vc}(20), amt decimal(8,2), memo {vc}(20))"), None).await.unwrap();
            query(&dbs, c, "INSERT INTO rb_e VALUES (1, 'a', 1.5, NULL), (2, 'b', 2.5, NULL)".into(), None).await.unwrap();
            // 1) 고치기·NULL·새 행·지우기 — 한 번에
            let r = apply(&dbs, c, vec![
                st(&format!("UPDATE rb_e SET name = {}, memo = {} WHERE id = {}", a(1, "varchar"), a(2, "varchar"), a(3, "integer")), &[Some("가나다"), None, Some("1")], true),
                st(&format!("INSERT INTO rb_e (id, name, amt) VALUES ({}, {}, {})", a(1, "integer"), a(2, "varchar"), a(3, "numeric")), &[Some("3"), Some("c"), Some("3.25")], false),
                st(&format!("DELETE FROM rb_e WHERE id = {}", a(1, "integer")), &[Some("2")], true),
            ]).await.unwrap();
            println!("{engine}: 반영 {:?}", r.affected);
            // 2) 1행이 아니면 전부 되돌림
            let bad = apply(&dbs, c, vec![
                st(&format!("UPDATE rb_e SET name = {} WHERE id = {}", a(1, "varchar"), a(2, "integer")), &[Some("x"), Some("1")], true),
                st(&format!("UPDATE rb_e SET name = {} WHERE id > {}", a(1, "varchar"), a(2, "integer")), &[Some("y"), Some("0")], true),
            ]).await.err().unwrap();
            println!("  1행 아님 → {}", bad.message);
            let q = query(&dbs, c, "SELECT id, name, amt, memo FROM rb_e ORDER BY id".into(), None).await.unwrap();
            let rows = db_rows_core(&dbs, q.result_id.unwrap(), 0, 10);
            println!("  지금 표 {rows:?}");
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0][1].as_deref(), Some("가나다"));
            // 3) 수동 트랜잭션 안에서 반영 → 되돌리기
            tx(&dbs, c, "begin".into()).await.unwrap();
            apply(&dbs, c, vec![st(&format!("DELETE FROM rb_e WHERE id = {}", a(1, "integer")), &[Some("1")], true)]).await.unwrap();
            tx(&dbs, c, "rollback".into()).await.unwrap();
            let q = query(&dbs, c, "SELECT count(*) FROM rb_e".into(), None).await.unwrap();
            let n = db_rows_core(&dbs, q.result_id.unwrap(), 0, 1);
            println!("  수동 트랜잭션 되돌린 뒤 행 수 {n:?}");
            assert_eq!(n[0][0].as_deref(), Some("2"));
            query(&dbs, c, "DROP TABLE rb_e".into(), None).await.unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;

    #[test]
    fn sort_and_filter() {
        let col = |n: &str, k: &'static str| Col { name: n.into(), kind: k };
        let row = |a: Option<&str>, b: &str| vec![a.map(str::to_string), Some(b.to_string())];
        let r = ResultSet {
            columns: vec![col("n", "int"), col("s", "text")],
            rows: vec![row(Some("10"), "Kim"), row(None, "lee"), row(Some("9"), "Park"), row(Some("100"), "kimchi")],
            view: Mutex::new(None),
        };
        assert_eq!(view_core(&r, Some(0), false, None), 4);
        let got: Vec<_> = r.visible().iter().map(|x| x[0].clone()).collect();
        assert_eq!(got, vec![Some("9".into()), Some("10".into()), Some("100".into()), None]);
        assert_eq!(view_core(&r, Some(0), true, None), 4);
        assert_eq!(r.visible()[0][0].as_deref(), Some("100"));
        assert_eq!(r.visible()[3][0], None);
        assert_eq!(view_core(&r, None, false, Some("KIM")), 2);
        assert_eq!(view_core(&r, Some(1), false, Some("kim 10")), 2);
        assert_eq!(view_core(&r, None, false, Some("null")), 1);
        assert_eq!(view_core(&r, None, false, None), 4);
        assert!(r.view.lock().unwrap().is_none());
    }
}
