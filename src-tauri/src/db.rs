//! DB 접속 — PostgreSQL(tokio-postgres)·MySQL/MariaDB(mysql_async).
//! - PG 는 simple query(텍스트 형식)로 받아 어떤 타입이든 서버가 보여 주는 글 그대로 표시한다.
//! - 결과 행은 Rust 쪽에 두고 화면은 보이는 구간만 받는다(`db_rows`). 행 상한을 넘으면 서버 쪽에서 취소.
//! - 읽기 전용: 세션을 READ ONLY 로 + 문장 첫 낱말 검사(이중).
//! - 취소: PG CancelRequest, MySQL 은 다른 연결로 KILL QUERY.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures_util::{pin_mut, StreamExt, TryStreamExt};
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tiberius::FromSql;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::secrets;
use crate::store::Store;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    /// NEED_SECRET | AUTH_FAILED | NETWORK | READ_ONLY | BUSY | CANCELLED | SQL | CLOSED | OTHER
    /// SSH 터널: SSH_HOSTKEY_UNKNOWN | SSH_HOSTKEY_MISMATCH | SSH_NEED_SECRET | SSH_AUTH_FAILED
    code: &'static str,
    message: String,
    /// SSH 터널 호스트 키 확인용(지문·알고리즘·고정된 지문)
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned_fingerprint: Option<String>,
}
fn e(code: &'static str, m: impl Into<String>) -> DbError {
    DbError { code, message: m.into(), ..Default::default() }
}

/// SSH 터널 오류 → DB 접속 오류(화면이 SSH 지문·암호를 물을 수 있게 코드를 나눈다)
fn ssh_db_err(x: crate::ssh::SshError) -> DbError {
    let (code, msg, fp, alg, pinned) = x.parts();
    let code = match code {
        "HOSTKEY_UNKNOWN" => "SSH_HOSTKEY_UNKNOWN",
        "HOSTKEY_MISMATCH" => "SSH_HOSTKEY_MISMATCH",
        "NEED_SECRET" => "SSH_NEED_SECRET",
        "AUTH_FAILED" => "SSH_AUTH_FAILED",
        "OTHER" => "OTHER",
        _ => "NETWORK",
    };
    let message = if code == "NETWORK" && x.parts().0 == "NEGOTIATION" {
        format!("거칠 SSH 서버: {msg} — 그 SSH 서버 설정에서 구형 호환을 켜세요")
    } else {
        format!("거칠 SSH 서버: {msg}")
    };
    DbError { code, message, fingerprint: fp.map(Into::into), algorithm: alg.map(Into::into), pinned_fingerprint: pinned.map(Into::into) }
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
            // MariaDB max_statement_time · MySQL max_execution_time
            1969 | 3024 => e("TIMEOUT", "시간 상한을 넘겨 멈췄습니다"),
            _ => e("SQL", format!("{} ({})", s.message, s.code)),
        },
        mysql_async::Error::Driver(mysql_async::DriverError::MysqlOldPasswordDisabled) => {
            e("AUTH_FAILED", "아주 오래된 MySQL 암호 방식(old_password)입니다. 프로필 고급에서 구형 호환을 켜세요.")
        }
        mysql_async::Error::Io(_) => e("NETWORK", x.to_string()),
        mysql_async::Error::Driver(mysql_async::DriverError::ConnectionClosed) => e("CLOSED", "연결이 끊겼습니다"),
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
    Pg { client: tokio_postgres::Client, cancel: tokio_postgres::CancelToken, tls: Option<tokio_postgres_rustls::MakeRustlsConnect> },
    My { conn: tokio::sync::Mutex<mysql_async::Conn>, opts: mysql_async::Opts, thread: u32, mariadb: bool },
    Ms { client: tokio::sync::Mutex<MsClient> },
    Jdbc { side: crate::jdbc::Sidecar },
}

impl Engine {
    /// 화면이 감출 기능 — readOnlySession(세션 자체를 읽기 전용으로), cancel(실행 중 취소)
    fn features(&self) -> Vec<&'static str> {
        match self {
            Engine::Pg { .. } | Engine::My { .. } => vec!["readOnlySession", "cancel"],
            Engine::Ms { .. } | Engine::Jdbc { .. } => vec!["cancel"],
        }
    }
}

pub(crate) struct DbConn {
    engine: Engine,
    read_only: bool,
    busy: tokio::sync::Mutex<()>,
    /// 수동 트랜잭션이 열려 있는지
    in_tx: AtomicBool,
    /// 수동 커밋 모드 — 쓰기 문장 앞에서 트랜잭션을 저절로 연다(커밋·되돌리기 뒤에도 유지)
    manual: AtomicBool,
    /// 열린 트랜잭션 안에서 실행한 문장 수
    tx_stmts: AtomicU32,
    /// 서버 세션에 걸어 둔 문장 시간 상한(ms, 0 = 없음, u64::MAX = 모름)
    timeout_set: AtomicU64,
    /// 다시 연결·데이터베이스 바꾸기용 접속 정보(암호는 메모리에만)
    req: DbConnectReq,
    /// 같은 번호로 다시 연결하면 바뀐다 — 옛 연결의 끊김 알림을 거르기 위해
    gen: u64,
    /// 끊김을 이미 알렸는지
    closed: AtomicBool,
    /// SSH 터널을 거치면 — 이 연결을 닫으면(놓으면) 터널도 닫힌다
    tunnel: Option<Arc<crate::tunnel::DbTunnel>>,
    /// 취소를 눌렀는지 — 받는 중인 행 묶음 사이에서 앱이 직접 멈춘다(문장마다 처음에 지운다)
    stop_req: AtomicBool,
    /// 취소를 기다리는 쪽 깨우기(SQL Server 처럼 서버 취소가 엔진 루프 안에서만 되는 경우)
    stop_notify: tokio::sync::Notify,
    /// 취소 뒤 응답 순서가 어긋남(SQL Server) — 다시 연결할 때까지 이 연결로 아무것도 하지 않는다
    broken: AtomicBool,
}

static GEN: AtomicU64 = AtomicU64::new(1);

impl DbConn {
    fn new(engine: Engine, req: DbConnectReq, gen: u64, tunnel: Option<Arc<crate::tunnel::DbTunnel>>) -> Self {
        DbConn {
            engine,
            read_only: req.read_only,
            busy: Default::default(),
            in_tx: Default::default(),
            manual: Default::default(),
            tx_stmts: Default::default(),
            timeout_set: AtomicU64::new(0),
            req,
            gen,
            closed: Default::default(),
            tunnel,
            stop_req: Default::default(),
            stop_notify: Default::default(),
            broken: Default::default(),
        }
    }
    fn is_mysql(&self) -> bool {
        matches!(self.engine, Engine::My { .. })
    }
    fn tx_state(&self) -> TxState {
        TxState { in_tx: self.in_tx.load(Ordering::Relaxed), stmts: self.tx_stmts.load(Ordering::Relaxed), manual: self.manual.load(Ordering::Relaxed) }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct TxState {
    in_tx: bool,
    stmts: u32,
    manual: bool,
}

/// 연결이 끊겼다고 화면에 알린다(같은 연결로 한 번만, 다시 연결한 뒤의 옛 연결 소식은 거른다)
fn notify_closed(app: &AppHandle, id: u32, gen: u64) {
    let dbs = app.state::<DbConns>();
    let c = dbs.map.lock().unwrap().get(&id).cloned();
    if let Some(c) = c {
        if c.gen == gen && !c.closed.swap(true, Ordering::Relaxed) {
            let _ = app.emit("db-closed", json!({ "conn": id }));
        }
    }
}

/// 살아 있는지 1분마다 확인(유휴 끊김 방지도 겸함) — 연결이 없어지면 끝난다
fn spawn_keepalive(app: AppHandle, id: u32) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let c = {
                let dbs = app.state::<DbConns>();
                let got = dbs.map.lock().unwrap().get(&id).cloned();
                got
            };
            let Some(c) = c else { return };
            if c.closed.load(Ordering::Relaxed) {
                continue;
            }
            let Ok(guard) = c.busy.try_lock() else { continue };
            let r = tokio::time::timeout(Duration::from_secs(15), ping(&c)).await;
            drop(guard);
            let dead = match r {
                Err(_) => true,
                Ok(Err(x)) => matches!(x.code, "CLOSED" | "NETWORK"),
                Ok(Ok(())) => false,
            };
            if dead {
                notify_closed(&app, id, c.gen);
            }
        }
    });
}

async fn ping(c: &DbConn) -> R<()> {
    match &c.engine {
        Engine::Pg { client, .. } => client.simple_query("SELECT 1").await.map(|_| ()).map_err(pg_err),
        Engine::My { conn, .. } => conn.lock().await.ping().await.map_err(my_err),
        Engine::Ms { client } => {
            client.lock().await.simple_query("SELECT 1").await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
            Ok(())
        }
        Engine::Jdbc { .. } => Ok(()),
    }
}

#[derive(Default)]
pub struct DbConns {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Arc<DbConn>>>,
    results: Mutex<HashMap<u32, Arc<ResultSet>>>,
}

impl DbConns {
    fn get(&self, id: u32) -> R<Arc<DbConn>> {
        let c = self.any(id)?;
        if c.broken.load(Ordering::Relaxed) {
            return Err(e("CLOSED", "실행 중에 멈춘 SQL Server 연결이라 응답 순서를 믿을 수 없습니다 — 다시 연결하세요"));
        }
        Ok(c)
    }
    /// 망가진 연결도 — 다시 연결·닫기용
    fn any(&self, id: u32) -> R<Arc<DbConn>> {
        self.map.lock().unwrap().get(&id).cloned().ok_or_else(|| e("CLOSED", "연결이 닫혔습니다"))
    }
}

type Row = Vec<Option<String>>;

pub(crate) struct ResultSet {
    columns: Vec<Col>,
    /// 받는 중에도 화면이 db_rows 로 앞쪽을 읽는다 — 엔진 루프가 한 행씩 넣는다
    rows: RwLock<Vec<Row>>,
    /// 정렬·거르기 보기 — 화면 행 번호 → 원래 행 번호. None 이면 받은 순서 그대로
    view: Mutex<Option<Vec<usize>>>,
    /// 다 받았는지(취소·상한으로 멈춘 것도 끝) — 받는 중에는 정렬·거르기·내보내기를 하지 않는다
    done: AtomicBool,
}

impl ResultSet {
    fn new(columns: Vec<Col>, rows: Vec<Row>, done: bool) -> Self {
        ResultSet { columns, rows: RwLock::new(rows), view: Mutex::new(None), done: AtomicBool::new(done) }
    }
    fn len(&self) -> usize {
        self.rows.read().unwrap().len()
    }
    /// 정렬·거르기를 반영한 행 — 부르는 쪽이 rows 읽기 잠금을 쥐고 넘긴다
    fn visible<'a>(&self, rows: &'a [Row]) -> Vec<&'a Row> {
        match &*self.view.lock().unwrap() {
            Some(v) => v.iter().filter_map(|&i| rows.get(i)).collect(),
            None => rows.iter().collect(),
        }
    }
    fn need_done(&self) -> R<()> {
        if self.done.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(e("BUSY", "아직 받는 중입니다 — 다 받은 뒤(또는 취소한 뒤 받은 행으로) 정렬·거르기·내보내기를 할 수 있습니다"))
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Col {
    name: String,
    /// int | numeric | text | date | bool | json | binary
    kind: &'static str,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectReq {
    profile_id: Option<i64>,
    /// 접속할 계정 — 주면 그 계정의 사용자명·저장한 암호를 쓴다(없으면 서버의 기본 계정 암호)
    #[serde(default)]
    account_id: Option<i64>,
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
    /// SSL: off | prefer | require(인증서 확인 안 함) | verify(인증서 확인)
    #[serde(default)]
    ssl: Option<String>,
    /// SSH 터널(거칠 SSH 서버·계정·그 비밀) — 화면이 늘 함께 보낸다
    #[serde(default, flatten)]
    tunnel: TunnelReq,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TunnelReq {
    /// 거칠 SSH 서버(프로필) — 없으면 바로 접속
    #[serde(default)]
    ssh_profile_id: Option<i64>,
    /// 그 서버의 계정(없으면 기본 계정)
    #[serde(default)]
    ssh_account_id: Option<i64>,
    /// SSH 암호(또는 개인키 암호) — 비우면 그 계정에 저장한 것
    #[serde(default)]
    ssh_secret: Option<String>,
    /// 화면에서 확인한 SSH 서버 지문(처음 접속일 때)
    #[serde(default)]
    ssh_trust_fingerprint: Option<String>,
    #[serde(default)]
    ssh_save_secret: bool,
}

impl TunnelReq {
    fn spec(&self) -> Option<crate::tunnel::TunnelSpec> {
        self.ssh_profile_id.map(|profile_id| crate::tunnel::TunnelSpec {
            profile_id,
            account_id: self.ssh_account_id,
            secret: self.ssh_secret.clone().filter(|s| !s.is_empty()),
            trust: self.ssh_trust_fingerprint.clone(),
            save: self.ssh_save_secret,
        })
    }
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
    let mut req = req;
    if let Some(aid) = req.account_id {
        let a = store.account(aid).map_err(|m| e("OTHER", m))?;
        req.username = a.username;
        req.profile_id = Some(a.profile_id);
    }
    connect(&store, &dbs, req, Some(&app)).await
}

/// SSH 터널 열기(거칠 서버가 있으면)
async fn open_tunnel(store: &Store, req: &DbConnectReq) -> R<Option<Arc<crate::tunnel::DbTunnel>>> {
    let Some(spec) = req.tunnel.spec() else { return Ok(None) };
    let t = crate::tunnel::open_db_tunnel(store, &spec, &req.host, req.port).await.map_err(ssh_db_err)?;
    Ok(Some(Arc::new(t)))
}

/// 터널 위에서 엔진이 실패하면 — 터널이 남긴 오류(서버에서 DB 로 가는 길을 못 엶 등)가 더 정확하다
fn tunnel_fail(t: &Option<Arc<crate::tunnel::DbTunnel>>, x: DbError) -> DbError {
    match t.as_ref().and_then(|t| t.last_error()) {
        Some(m) if !matches!(x.code, "AUTH_FAILED" | "NEED_SECRET" | "NEED_JAVA" | "NEED_DRIVER") => e("NETWORK", format!("SSH 터널: {m}")),
        _ => x,
    }
}

/// 거친 SSH 연결이 끊기면 DB 연결도 끊겼다고 알린다
fn spawn_tunnel_watch(app: AppHandle, id: u32, gen: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let c = {
                let dbs = app.state::<DbConns>();
                let got = dbs.map.lock().unwrap().get(&id).cloned();
                got
            };
            let Some(c) = c else { return };
            if c.gen != gen {
                return; // 다시 연결함 — 새 연결이 따로 지켜본다
            }
            if c.tunnel.as_ref().is_some_and(|t| t.closed()) {
                notify_closed(&app, id, gen);
                return;
            }
        }
    });
}

pub(crate) async fn connect(store: &Store, dbs: &DbConns, req: DbConnectReq, app: Option<&AppHandle>) -> R<DbConnectOk> {
    let mut used_saved = false;
    let aid = match (req.account_id, req.profile_id) {
        (Some(aid), _) => Some(aid),
        (None, Some(pid)) => store.default_account(pid).ok().and_then(|a| a.id),
        _ => None,
    };
    let pw = match req.password.clone().filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => {
            let s = aid.and_then(|id| secrets::get(&secrets::account_key(id)));
            used_saved = s.is_some();
            s
        }
    };
    let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    let tunnel = open_tunnel(store, &req).await?;
    let dial = tunnel.as_ref().map(|t| t.port);
    let (engine, version) = open_engine(&req, pw.clone(), app, id, gen, dial).await.map_err(|x| tunnel_fail(&tunnel, x))?;
    if let Some(id) = aid {
        let mut saved = None;
        if req.save_secret && !used_saved {
            if let Some(p) = &pw {
                saved = Some(secrets::set(&secrets::account_key(id), p).is_ok());
            }
        }
        store.mark_account_used(id, saved);
    } else if let Some(pid) = req.profile_id {
        store.mark_used(pid);
    }
    let features = engine.features();
    let database = req.database.clone();
    let mut keep = req;
    keep.password = pw;
    keep.save_secret = false;
    // 다시 연결할 때는 고정된 지문·메모리의 SSH 비밀로(저장은 한 번만)
    keep.tunnel.ssh_trust_fingerprint = None;
    keep.tunnel.ssh_save_secret = false;
    let watch = tunnel.is_some();
    dbs.map.lock().unwrap().insert(id, Arc::new(DbConn::new(engine, keep, gen, tunnel)));
    if let Some(a) = app {
        spawn_keepalive(a.clone(), id);
        if watch {
            spawn_tunnel_watch(a.clone(), id, gen);
        }
    }
    Ok(DbConnectOk { conn_id: id, features, version, database, used_saved_secret: used_saved })
}

/// 엔진 하나 열기 — 처음 연결·다시 연결·데이터베이스 바꾸기가 함께 쓴다
/// dial: SSH 터널의 127.0.0.1 포트 — 주면 거기로 붙고, TLS 인증서 확인(verify)에는 원래 호스트 이름을 쓴다
async fn open_engine(req: &DbConnectReq, pw: Option<String>, app: Option<&AppHandle>, id: u32, gen: u64, dial: Option<u16>) -> R<(Engine, String)> {
    let timeout = Duration::from_secs(12);
    let watch = app.cloned();
    let (dial_host, dial_port) = match dial {
        Some(p) => ("127.0.0.1".to_string(), p),
        None => (req.host.clone(), req.port),
    };
    let out = if req.engine == "postgres" {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&req.host).port(dial_port).user(&req.username).connect_timeout(timeout).application_name("RuiBotte Shell");
        if dial.is_some() {
            // 붙는 곳은 터널, 이름(TLS·인증서 확인)은 원래 호스트
            cfg.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        }
        cfg.keepalives(true).keepalives_idle(Duration::from_secs(60));
        cfg.dbname(req.database.as_deref().filter(|d| !d.is_empty()).unwrap_or("postgres"));
        if let Some(p) = &pw {
            cfg.password(p);
        }
        let mode = req.ssl.as_deref().unwrap_or("prefer");
        let tls = (mode != "off").then(|| tls_connector(mode == "verify"));
        cfg.ssl_mode(match mode {
            "off" => tokio_postgres::config::SslMode::Disable,
            "require" | "verify" => tokio_postgres::config::SslMode::Require,
            _ => tokio_postgres::config::SslMode::Prefer,
        });
        // 연결 일꾼이 끝나면(서버가 끊음·망 끊김) 화면에 알린다
        let on_end = move || {
            if let Some(a) = &watch {
                notify_closed(a, id, gen);
            }
        };
        let res = match &tls {
            Some(t) => cfg.connect(t.clone()).await.map(|(c, conn)| {
                let task = tauri::async_runtime::spawn(async move {
                    let _ = conn.await;
                    on_end();
                });
                (c, task)
            }),
            None => cfg.connect(tokio_postgres::NoTls).await.map(|(c, conn)| {
                let task = tauri::async_runtime::spawn(async move {
                    let _ = conn.await;
                    on_end();
                });
                (c, task)
            }),
        };
        let (client, _task) = match res {
            Ok(x) => x,
            Err(x) => {
                let msg = x.to_string();
                if pw.is_none() && (msg.contains("password") || msg.contains("authentication") || msg.contains("invalid configuration")) {
                    return Err(e("NEED_SECRET", "암호를 입력하세요"));
                }
                return Err(pg_err(x));
            }
        };
        if req.read_only {
            client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await.map_err(pg_err)?;
        }
        let v = client.simple_query("SHOW server_version").await.map_err(pg_err)?;
        let version = v
            .iter()
            .find_map(|m| if let tokio_postgres::SimpleQueryMessage::Row(r) = m { r.get(0).map(|s| format!("PostgreSQL {s}")) } else { None })
            .unwrap_or_default();
        let cancel = client.cancel_token();
        (Engine::Pg { client, cancel, tls }, version)
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
        let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((dial_host.as_str(), dial_port)))
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
        let url = crate::jdbc::build_url(je, &dial_host, dial_port, req.database.as_deref().unwrap_or(""));
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
        let mode = req.ssl.as_deref().unwrap_or("off");
        let ssl = match mode {
            "require" | "prefer" => Some(mysql_async::SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)),
            "verify" => Some(mysql_async::SslOpts::default().with_danger_tls_hostname_override(dial.map(|_| req.host.clone()))),
            _ => None,
        };
        let build = |ssl: Option<mysql_async::SslOpts>| -> mysql_async::Opts {
            mysql_async::OptsBuilder::default()
                .ssl_opts(ssl)
                .ip_or_hostname(dial_host.clone())
                .tcp_port(dial_port)
                .user(Some(req.username.clone()))
                .pass(pw.clone())
                .db_name(req.database.clone().filter(|d| !d.is_empty()))
                .prefer_socket(false)
                .secure_auth(!req.legacy)
                .into()
        };
        let open = |opts: mysql_async::Opts| async move {
            match tokio::time::timeout(timeout, mysql_async::Conn::new(opts)).await {
                Err(_) => Err(e("NETWORK", format!("{}:{} 에 닿지 못했습니다", req.host, req.port))),
                Ok(Err(x)) => Err(my_err(x)),
                Ok(Ok(c)) => Ok(c),
            }
        };
        let mut opts = build(ssl);
        let mut first = open(opts.clone()).await;
        // "되면 사용(prefer)" — TLS 를 못 하는 서버면 평문으로 한 번 더(인증 실패·시간 초과는 그대로)
        if mode == "prefer" {
            if let Err(x) = &first {
                let m = x.message.to_lowercase();
                if x.code != "AUTH_FAILED" && !m.contains("닿지 못했습니다") {
                    opts = build(None);
                    first = open(opts.clone()).await;
                }
            }
        }
        let mut conn = match first {
            Err(err) => {
                if pw.is_none() && err.code == "AUTH_FAILED" {
                    return Err(e("NEED_SECRET", "암호를 입력하세요"));
                }
                return Err(err);
            }
            Ok(c) => c,
        };
        if req.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(my_err)?;
        }
        let v: Option<String> = conn.query_first("SELECT VERSION()").await.map_err(my_err)?;
        let thread = conn.id();
        let version = v.unwrap_or_default();
        let mariadb = version.to_lowercase().contains("mariadb");
        (Engine::My { conn: tokio::sync::Mutex::new(conn), opts, thread, mariadb }, version)
    };
    Ok(out)
}

/// 같은 연결 번호로 다시 연결 — 끊긴 뒤 다시 잇기, PostgreSQL 데이터베이스 바꾸기(database 를 줄 때).
/// 열린 트랜잭션은 사라진다(화면이 먼저 묻는다).
#[tauri::command]
pub async fn db_reconnect(app: AppHandle, store: State<'_, Store>, dbs: State<'_, DbConns>, conn: u32, database: Option<String>) -> R<DbConnectOk> {
    let old = dbs.any(conn)?;
    let mut req = old.req.clone();
    if let Some(d) = database.filter(|d| !d.is_empty()) {
        req.database = Some(d);
    }
    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    // 터널이 살아 있으면 그대로, 끊겼으면(SSH 가 끊김) 다시 연다
    let tunnel = match &old.tunnel {
        Some(t) if !t.closed() => Some(t.clone()),
        Some(_) => open_tunnel(&store, &req).await?,
        None => None,
    };
    let dial = tunnel.as_ref().map(|t| t.port);
    let (engine, version) = open_engine(&req, req.password.clone(), Some(&app), conn, gen, dial).await.map_err(|x| tunnel_fail(&tunnel, x))?;
    let features = engine.features();
    let db = req.database.clone();
    let watch = tunnel.is_some();
    let prev = dbs.map.lock().unwrap().insert(conn, Arc::new(DbConn::new(engine, req, gen, tunnel)));
    if watch {
        spawn_tunnel_watch(app.clone(), conn, gen);
    }
    if let Some(p) = prev {
        // 옛 연결은 기다리지 않고 정리(끊긴 연결이면 오래 걸릴 수 있다)
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(5), shutdown(&p)).await;
        });
    }
    Ok(DbConnectOk { conn_id: conn, features, version, database: db, used_saved_secret: false })
}

/// PostgreSQL 데이터베이스 목록(바꾸기 고르기용)
#[tauri::command]
pub async fn db_databases(dbs: State<'_, DbConns>, conn: u32) -> R<Vec<String>> {
    let c = dbs.get(conn)?;
    let sql = match &c.engine {
        Engine::Pg { .. } => "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1",
        Engine::My { .. } => "SHOW DATABASES",
        Engine::Ms { .. } => "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name",
        Engine::Jdbc { .. } => return Ok(Vec::new()),
    };
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    Ok(rows_of(&c, sql).await?.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
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
        shutdown(&c).await;
    }
}

async fn shutdown(c: &DbConn) {
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

/// 낱말 읽기 결과 — 단어(대문자)·여는 괄호·닫는 괄호·그 밖
#[derive(Debug, PartialEq)]
enum Tok {
    Word(String),
    Open,
    Close,
    Other,
}

/// 주석·문자열·따옴표 이름·PostgreSQL $$ 글을 건너뛰고 단어와 괄호만 낸다
fn tokens(sql: &str, mysql: bool) -> Vec<Tok> {
    let b: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let n = b.len();
    let skip_quoted = |i: &mut usize, q: char, backslash: bool| {
        *i += 1;
        while *i < n {
            let c = b[*i];
            if backslash && c == '\\' {
                *i += 2;
                continue;
            }
            if c == q {
                if *i + 1 < n && b[*i + 1] == q {
                    *i += 2;
                    continue;
                }
                *i += 1;
                return;
            }
            *i += 1;
        }
    };
    while i < n {
        let c = b[i];
        if c == '-' && i + 1 < n && b[i + 1] == '-' || (mysql && c == '#') {
            while i < n && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < n && b[i + 1] == '*' {
            i += 2;
            while i < n && !(b[i] == '*' && i + 1 < n && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == '\'' {
            skip_quoted(&mut i, '\'', mysql);
            out.push(Tok::Other);
        } else if c == '"' {
            skip_quoted(&mut i, '"', false);
            out.push(Tok::Other);
        } else if c == '`' {
            skip_quoted(&mut i, '`', false);
            out.push(Tok::Other);
        } else if c == '$' && !mysql {
            // $태그$ … $태그$
            let mut j = i + 1;
            while j < n && (b[j].is_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            if j < n && b[j] == '$' {
                let tag: String = b[i..=j].iter().collect();
                let rest: String = b[j + 1..].iter().collect();
                match rest.find(&tag) {
                    Some(k) => i = j + 1 + rest[..k].chars().count() + tag.chars().count(),
                    None => i = n,
                }
                out.push(Tok::Other);
            } else {
                i += 1;
                out.push(Tok::Other);
            }
        } else if c == '(' {
            out.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            out.push(Tok::Close);
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let s = i;
            while i < n && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '$' || b[i] == '#') {
                i += 1;
            }
            out.push(Tok::Word(b[s..i].iter().collect::<String>().to_uppercase()));
        } else if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() {
            while i < n && (b[i].is_alphanumeric() || b[i] == '.') {
                i += 1;
            }
        } else {
            out.push(Tok::Other);
            i += 1;
        }
    }
    out
}

/// 문장 판정 — 원본 Orbit SqlSplitter.classify 와 같은 규칙
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Classified {
    /// read | dml | ddl | tx | set | explain | other | empty
    kind: &'static str,
    keyword: String,
    /// 데이터·스키마를 바꿀 수 있는 문장
    writes: bool,
    /// 한 번 더 확인할 문장(DDL·GRANT·WHERE 없는 UPDATE/DELETE·쓰기 EXPLAIN ANALYZE)
    dangerous: bool,
    reason: String,
    explain_analyze: bool,
    /// 읽기 전용 연결에서 실행해도 되는가
    read_only_safe: bool,
}

const DML_WORDS: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "LOAD"];
const DDL_WORDS: &[&str] = &["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "COMMENT"];
const TX_WORDS: &[&str] = &["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END", "ABORT"];
const READ_WORDS: &[&str] = &["SELECT", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE", "USE", "HELP", "PRAGMA"];
const MAIN_AFTER_WITH: &[&str] = &["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"];

fn cls(kind: &'static str, keyword: &str, writes: bool, dangerous: bool, reason: impl Into<String>) -> Classified {
    let read_only_safe = matches!(kind, "read" | "empty");
    Classified { kind, keyword: keyword.into(), writes, dangerous, reason: reason.into(), explain_analyze: false, read_only_safe }
}

pub(crate) fn classify(sql: &str, mysql: bool) -> Classified {
    let toks = tokens(sql, mysql);
    let mut top: Vec<String> = Vec::new();
    let mut paren_first: Vec<String> = Vec::new();
    let mut depth = 0usize;
    let mut after_open = false;
    for t in &toks {
        match t {
            Tok::Open => {
                depth += 1;
                after_open = true;
            }
            Tok::Close => {
                depth = depth.saturating_sub(1);
                after_open = false;
            }
            Tok::Word(w) => {
                if after_open {
                    paren_first.push(w.clone());
                    after_open = false;
                }
                if depth == 0 || top.is_empty() {
                    top.push(w.clone());
                }
            }
            Tok::Other => after_open = false,
        }
    }
    let Some(first) = top.first().cloned() else {
        return cls("empty", "", false, false, "");
    };
    let explain_like = first == "EXPLAIN" || (first == "ANALYZE" && mysql && top.len() > 1 && (MAIN_AFTER_WITH.contains(&top[1].as_str()) || top[1] == "FORMAT"));
    if explain_like {
        // EXPLAIN ANALYZE … 와 EXPLAIN (ANALYZE, BUFFERS) … 둘 다 — 괄호 안 옵션도 본다
        let analyze = first == "ANALYZE" || toks.iter().take(16).any(|t| matches!(t, Tok::Word(w) if w == "ANALYZE"));
        // 안쪽 문장 — 첫 본 문장 낱말부터
        let at = top.iter().position(|w| ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE", "REPLACE"].contains(&w.as_str()));
        let inner_writes = at
            .map(|_| {
                let upper = sql.to_ascii_uppercase();
                let mut best: Option<usize> = None;
                for k in ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE", "REPLACE"] {
                    if let Some(i) = word_index(&upper, k) {
                        best = Some(best.map_or(i, |b: usize| b.min(i)));
                    }
                }
                best.map(|i| classify(&sql[i..], mysql).writes).unwrap_or(false)
            })
            .unwrap_or(false);
        let w = analyze && inner_writes;
        return Classified {
            kind: "explain",
            keyword: "EXPLAIN".into(),
            writes: w,
            dangerous: w,
            reason: if w { "EXPLAIN ANALYZE 는 쓰기 문장을 실제로 실행합니다".into() } else { String::new() },
            explain_analyze: analyze,
            read_only_safe: !w,
        };
    }
    let mut keyword = first.clone();
    if first == "WITH" {
        keyword = top.iter().skip(1).find(|w| MAIN_AFTER_WITH.contains(&w.as_str())).cloned().unwrap_or_else(|| "SELECT".into());
        let writable_cte = paren_first.iter().any(|w| DML_WORDS.contains(&w.as_str()));
        if writable_cte && keyword == "SELECT" {
            return cls("dml", "WITH", true, false, "WITH 안에서 행을 바꿉니다");
        }
    }
    let k = keyword.as_str();
    if READ_WORDS.contains(&k) {
        if k == "SELECT" && top.iter().any(|w| w == "INTO") {
            return cls("ddl", "SELECT INTO", true, true, "SELECT INTO 는 새 표·변수에 씁니다");
        }
        return cls("read", k, false, false, "");
    }
    if DML_WORDS.contains(&k) {
        let bulk = (k == "UPDATE" || k == "DELETE") && !top.iter().any(|w| w == "WHERE");
        return cls("dml", k, true, bulk, if bulk { format!("{k} 에 WHERE 가 없습니다 — 표의 모든 행이 바뀝니다") } else { String::new() });
    }
    if DDL_WORDS.contains(&k) {
        let why = if k == "GRANT" || k == "REVOKE" { format!("권한을 바꾸는 문장({k})입니다") } else { format!("스키마를 바꾸는 문장({k})입니다") };
        return cls("ddl", k, true, true, why);
    }
    if TX_WORDS.contains(&k) {
        return cls("tx", k, false, false, "");
    }
    if k == "SET" {
        // 읽기 전용을 풀 수 있는 SET 은 읽기 문장이 아니다
        let escape = top.iter().any(|w| ["READ", "TRANSACTION", "CHARACTERISTICS", "ROLE", "SESSION_AUTHORIZATION", "TX_READ_ONLY", "TRANSACTION_READ_ONLY"].contains(&w.as_str()));
        return cls(if escape { "other" } else { "set" }, "SET", escape, false, "");
    }
    cls("other", k, true, false, "")
}

/// 낱말 경계에 맞는 첫 위치(바이트)
fn word_index(upper: &str, word: &str) -> Option<usize> {
    let bytes = upper.as_bytes();
    let mut from = 0;
    while let Some(off) = upper[from..].find(word) {
        let i = from + off;
        let left = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        let e = i + word.len();
        let right = e >= bytes.len() || !(bytes[e].is_ascii_alphanumeric() || bytes[e] == b'_');
        if left && right {
            return Some(i);
        }
        from = i + 1;
    }
    None
}

/// 문장들 판정(실행 전 확인 창용) — 실제 막기는 db_query 가 같은 규칙으로 한다
#[tauri::command]
pub fn db_classify(sqls: Vec<String>, engine: String) -> Vec<Classified> {
    let my = engine == "mysql" || engine == "mariadb";
    sqls.iter().map(|s| classify(s, my)).collect()
}

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
    /// 받는 중에 멈춤 — cancelled(취소) · timeout(시간 상한) · memory(메모리 상한). 받은 행은 결과에 남는다
    stopped: Option<&'static str>,
    ms: u64,
    first_row_ms: Option<u64>,
    tx: TxState,
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

/// 문장 하나 실행. 행은 max_rows 까지만 받고 넘으면 서버 쪽 취소.
/// timeout_ms — 문장 시간 상한(PostgreSQL statement_timeout · MySQL max_execution_time · MariaDB max_statement_time, 그 밖은 앱이 재다가 취소)
/// stream — 화면이 고른 번호. 주면 받는 동안 `db-rows-progress` 로 결과 번호·받은 행 수를 알리고(첫 묶음 50행 또는 15ms, 그다음 0.1초마다 500행 넘게 늘었거나 0.25초가 지나면),
/// 취소·시간 상한으로 멈춰도 받은 행이 있으면 결과로 돌려준다(stopped)
#[tauri::command]
pub async fn db_query(app: AppHandle, dbs: State<'_, DbConns>, conn: u32, sql: String, max_rows: Option<usize>, timeout_ms: Option<u64>, stream: Option<u32>) -> R<QueryOk> {
    let emit = |p: Progress| {
        let _ = app.emit("db-rows-progress", p);
    };
    let progress: Option<&ProgressFn<'_>> = if stream.is_some() { Some(&emit) } else { None };
    let r = query_opts(&dbs, conn, sql, max_rows, timeout_ms, stream.zip(progress)).await;
    if let Ok(c) = dbs.any(conn) {
        // 끊김 — 또는 SQL Server 를 응답 중에 멈춰 연결이 어긋남(받은 행은 결과로 남기고 다시 연결하게)
        if c.broken.load(Ordering::Relaxed) || matches!(&r, Err(x) if matches!(x.code, "CLOSED" | "NETWORK")) {
            notify_closed(&app, conn, c.gen);
        }
    }
    r
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn query(dbs: &DbConns, conn: u32, sql: String, max_rows: Option<usize>) -> R<QueryOk> {
    query_opts(dbs, conn, sql, max_rows, None, None).await
}

/// 받는 중 알림 — 화면은 stream 번호로 자기 결과 탭을 찾는다
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    stream: u32,
    result_id: u32,
    columns: Vec<Col>,
    row_count: usize,
    ms: u64,
    first_row_ms: Option<u64>,
}

pub(crate) type ProgressFn<'a> = dyn Fn(Progress) + Send + Sync + 'a;

/// 첫 묶음 — 이만큼 모이거나 FIRST_MS 가 지나면 바로 알린다
const FIRST_BATCH: usize = 50;
const FIRST_MS: u64 = 15;
/// 그다음 알림 — TICK_MS 마다 보고 EVERY_ROWS 넘게 늘었거나 IDLE_MS 가 지났으면
const TICK_MS: u64 = 100;
const EVERY_ROWS: usize = 500;
const IDLE_MS: u64 = 250;
/// 결과 하나가 쓸 메모리 상한(어림 — 칸마다 24바이트 + 글자). 넘으면 거기서 멈추고 알린다
const MEMORY_CAP: usize = 512 * 1024 * 1024;

/// 받는 중인 결과 — 엔진 루프가 행을 넣고, 진행 알림이 읽는다
struct Live<'a> {
    dbs: &'a DbConns,
    c: &'a DbConn,
    max: usize,
    started: Instant,
    cur: Mutex<Option<(u32, Arc<ResultSet>)>>,
    first_row_ms: AtomicU64,
    bytes: AtomicUsize,
    /// rows(행 상한) · memory(메모리 상한) · cancelled(취소)
    stop: Mutex<Option<&'static str>>,
    first_batch: tokio::sync::Notify,
    /// 넣은 행 수(모든 집합) — 엔진 루프가 가끔 양보해 알림 타이머가 돌게 한다
    pushed: AtomicUsize,
}

impl<'a> Live<'a> {
    fn new(dbs: &'a DbConns, c: &'a DbConn, max: usize, started: Instant) -> Self {
        Live { dbs, c, max, started, cur: Mutex::new(None), first_row_ms: AtomicU64::new(u64::MAX), bytes: AtomicUsize::new(0), stop: Mutex::new(None), first_batch: Default::default(), pushed: AtomicUsize::new(0) }
    }
    /// 새 결과 집합 — 바로 등록해 받는 동안에도 db_rows 로 읽게 한다(앞 집합은 버린다: 여러 집합이면 마지막 것)
    fn begin(&self, columns: Vec<Col>) -> Arc<ResultSet> {
        let rs = Arc::new(ResultSet::new(columns, Vec::new(), false));
        let id = self.dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
        let old = self.cur.lock().unwrap().replace((id, rs.clone()));
        let mut m = self.dbs.results.lock().unwrap();
        if let Some((o, _)) = old {
            m.remove(&o);
        }
        m.insert(id, rs.clone());
        self.bytes.store(0, Ordering::Relaxed);
        rs
    }
    /// 한 행 넣기 — false 면 그만 받는다(까닭은 stopped)
    fn push(&self, rs: &ResultSet, row: Row) -> bool {
        if self.first_row_ms.load(Ordering::Relaxed) == u64::MAX {
            self.first_row_ms.store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
        if self.c.stop_req.load(Ordering::Relaxed) {
            self.halt("cancelled");
            return false;
        }
        let size = 24 + row.iter().map(|v| 24 + v.as_ref().map_or(0, |s| s.len())).sum::<usize>();
        let mut g = rs.rows.write().unwrap();
        if g.len() >= self.max {
            drop(g);
            self.halt("rows");
            return false;
        }
        if self.bytes.fetch_add(size, Ordering::Relaxed) + size > MEMORY_CAP {
            drop(g);
            self.halt("memory");
            return false;
        }
        g.push(row);
        if g.len() == FIRST_BATCH {
            self.first_batch.notify_one();
        }
        true
    }
    /// 행이 계속 버퍼에 쌓여 있으면 엔진 루프가 쉬지 않아 같은 작업의 알림이 굶는다 — 256행마다 한 번 양보
    async fn pace(&self) {
        let n = self.pushed.fetch_add(1, Ordering::Relaxed) + 1;
        if n == FIRST_BATCH || n & 255 == 0 {
            tokio::task::yield_now().await;
        }
    }
    fn halt(&self, why: &'static str) {
        let mut s = self.stop.lock().unwrap();
        if s.is_none() {
            *s = Some(why);
        }
    }
    fn stopped(&self) -> Option<&'static str> {
        *self.stop.lock().unwrap()
    }
    fn current(&self) -> Option<(u32, Arc<ResultSet>)> {
        self.cur.lock().unwrap().clone()
    }
    fn rows(&self) -> usize {
        self.current().map_or(0, |(_, r)| r.len())
    }
    fn first_row_ms(&self) -> Option<u64> {
        Some(self.first_row_ms.load(Ordering::Relaxed)).filter(|v| *v != u64::MAX)
    }
    /// 실패 — 받던 결과를 버린다
    fn discard(&self) {
        if let Some((id, _)) = self.cur.lock().unwrap().take() {
            self.dbs.results.lock().unwrap().remove(&id);
        }
    }
}

/// 받는 동안 알림 — 실행이 끝나면 select 가 이 future 를 버린다
async fn ticker(live: &Live<'_>, progress: Option<(u32, &ProgressFn<'_>)>) {
    let Some((stream, emit)) = progress else {
        return std::future::pending().await;
    };
    let mut sent: (u32, usize) = (0, 0);
    let mut last = Instant::now();
    let mut first = true;
    loop {
        if first {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(FIRST_MS)) => {}
                _ = live.first_batch.notified() => {}
            }
        } else {
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        }
        let Some((id, rs)) = live.current() else { continue };
        let n = rs.len();
        let due = id != sent.0 || (n > sent.1 && (first || n - sent.1 >= EVERY_ROWS || last.elapsed() >= Duration::from_millis(IDLE_MS)));
        if !due {
            continue;
        }
        emit(Progress { stream, result_id: id, columns: rs.columns.clone(), row_count: n, ms: live.started.elapsed().as_millis() as u64, first_row_ms: live.first_row_ms() });
        sent = (id, n);
        last = Instant::now();
        if n > 0 {
            first = false;
        }
    }
}

/// 서버 세션에 문장 시간 상한을 건다 — 서버가 맡으면 true(아니면 앱이 잰다)
async fn set_server_timeout(c: &DbConn, ms: u64) -> bool {
    let sql = match &c.engine {
        Engine::Pg { .. } => format!("SET statement_timeout = {ms}"),
        Engine::My { mariadb: true, .. } => format!("SET SESSION max_statement_time = {}", ms as f64 / 1000.0),
        Engine::My { .. } => format!("SET SESSION max_execution_time = {ms}"),
        _ => return false,
    };
    if c.timeout_set.load(Ordering::Relaxed) == ms {
        return true;
    }
    let ok = match &c.engine {
        Engine::Pg { client, .. } => client.batch_execute(&sql).await.is_ok(),
        Engine::My { conn, .. } => conn.lock().await.query_drop(sql.as_str()).await.is_ok(),
        _ => false,
    };
    c.timeout_set.store(if ok { ms } else { u64::MAX }, Ordering::Relaxed);
    // MySQL max_execution_time 은 SELECT 에만 듣는다 — 나머지는 앱이 재다가 취소
    ok
}

/// 실행 중인 문장 취소 — 앱 쪽 멈춤 표시(받는 루프가 본다) + 엔진별 서버 취소
async fn cancel_conn(c: &DbConn) -> R<()> {
    c.stop_req.store(true, Ordering::Relaxed);
    c.stop_notify.notify_waiters();
    server_cancel(c).await
}

/// 서버 쪽 취소만(엔진별). SQL Server 는 엔진 루프가 흐름을 놓고 Attention 을 보낸다
async fn server_cancel(c: &DbConn) -> R<()> {
    match &c.engine {
        Engine::Pg { cancel, tls, .. } => match tls {
            Some(t) => cancel.cancel_query(t.clone()).await.map_err(pg_err),
            None => cancel.cancel_query(tokio_postgres::NoTls).await.map_err(pg_err),
        },
        Engine::My { opts, thread, .. } => {
            let mut k = mysql_async::Conn::new(opts.clone()).await.map_err(my_err)?;
            k.query_drop(format!("KILL QUERY {thread}")).await.map_err(my_err)?;
            let _ = k.disconnect().await;
            Ok(())
        }
        Engine::Ms { .. } => Ok(()),
        Engine::Jdbc { side } => {
            side.call(json!({"op": "cancel"})).await.map_err(|m| e("CLOSED", m))?;
            Ok(())
        }
    }
}

/// 트랜잭션 열기 — 바쁨 잠금은 부르는 쪽이 쥐고 있다
async fn tx_raw(c: &DbConn, op: &str) -> R<()> {
    let sql = match (op, &c.engine) {
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
    c.tx_stmts.store(0, Ordering::Relaxed);
    if op == "rollback" {
        // 트랜잭션 안에서 건 SET 은 되돌려진다
        c.timeout_set.store(u64::MAX, Ordering::Relaxed);
    }
    Ok(())
}

/// 사용자가 친 BEGIN·COMMIT·ROLLBACK 도 트랜잭션 표시에 반영
fn track_tx(c: &DbConn, cl: &Classified, sql: &str) {
    if cl.kind == "tx" {
        let up = sql.to_ascii_uppercase();
        match cl.keyword.as_str() {
            "BEGIN" | "START" => {
                // MySQL BEGIN … END 블록이 아닌 경우만(문장 하나로 오면 트랜잭션 시작)
                c.in_tx.store(true, Ordering::Relaxed);
                c.tx_stmts.store(0, Ordering::Relaxed);
            }
            "COMMIT" | "END" | "ABORT" => {
                c.in_tx.store(false, Ordering::Relaxed);
                c.tx_stmts.store(0, Ordering::Relaxed);
            }
            "ROLLBACK" if word_index(&up, "TO").is_none() => {
                c.in_tx.store(false, Ordering::Relaxed);
                c.tx_stmts.store(0, Ordering::Relaxed);
                c.timeout_set.store(u64::MAX, Ordering::Relaxed);
            }
            _ => {}
        }
    } else if c.in_tx.load(Ordering::Relaxed) {
        c.tx_stmts.fetch_add(1, Ordering::Relaxed);
    }
}

pub(crate) async fn query_opts(dbs: &DbConns, conn: u32, sql: String, max_rows: Option<usize>, timeout_ms: Option<u64>, progress: Option<(u32, &ProgressFn<'_>)>) -> R<QueryOk> {
    let c = dbs.get(conn)?;
    let max = max_rows.unwrap_or(100_000).clamp(1, 1_000_000);
    let cl = classify(&sql, c.is_mysql());
    // 읽기 전용은 앱 화면이 아니라 여기서 막는다(화면을 거치지 않는 호출도)
    if c.read_only && !cl.read_only_safe {
        let why = if cl.reason.is_empty() { format!("{} 문장", cl.keyword) } else { cl.reason.clone() };
        return Err(e("READ_ONLY", format!("읽기 전용 연결이라 조회 문장만 실행합니다 — {why}")));
    }
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    c.stop_req.store(false, Ordering::Relaxed);
    // 수동 커밋 — 쓰기 문장 앞에서 트랜잭션을 연다
    if c.manual.load(Ordering::Relaxed) && !c.in_tx.load(Ordering::Relaxed) && cl.writes && cl.kind != "tx" {
        tx_raw(&c, "begin").await?;
    }
    let limit = timeout_ms.filter(|ms| *ms > 0);
    let server_side = match limit {
        Some(ms) => set_server_timeout(&c, ms).await && !(matches!(c.engine, Engine::My { mariadb: false, .. }) && cl.keyword != "SELECT"),
        None => {
            if c.timeout_set.load(Ordering::Relaxed) != 0 {
                set_server_timeout(&c, 0).await;
            }
            true
        }
    };
    let stream = progress.is_some();
    let started = Instant::now();
    let live = Live::new(dbs, &c, max, started);
    let fut = async {
        let run = exec(&c, &sql, &live);
        let tick = ticker(&live, progress);
        pin_mut!(run, tick);
        tokio::select! {
            r = &mut run => r,
            _ = &mut tick => unreachable!("알림은 끝나지 않는다"),
        }
    };
    pin_mut!(fut);
    let mut timed_out = false;
    let got = match limit {
        Some(ms) if !server_side => {
            tokio::select! {
                r = &mut fut => r,
                _ = tokio::time::sleep(Duration::from_millis(ms)) => {
                    timed_out = true;
                    // SQL Server 도 이제 엔진 루프가 Attention 으로 멈춘다(연결을 버리지 않는다)
                    let _ = cancel_conn(&c).await;
                    fut.await
                }
            }
        }
        _ => fut.await,
    };
    let timed_out = timed_out || limit.is_some_and(|ms| started.elapsed().as_millis() as u64 + 100 >= ms);
    let mut stopped = live.stopped();
    let got = match got {
        // 받는 중에 취소·시간 상한 — 받은 행이 있으면 그것을 결과로
        Err(x) if matches!(x.code, "CANCELLED" | "TIMEOUT") && stream && live.rows() > 0 => {
            stopped = Some("cancelled");
            Ok(None)
        }
        Ok(_) if stopped == Some("cancelled") && (!stream || live.rows() == 0) => Err(e("CANCELLED", "취소했습니다")),
        other => other,
    };
    if stopped == Some("cancelled") && timed_out {
        stopped = Some("timeout");
    }
    let got = match got {
        Err(x) if x.code == "CANCELLED" && timed_out => Err(e("TIMEOUT", format!("{} 초 시간 상한을 넘겨 멈췄습니다", limit.unwrap_or(0) / 1000))),
        other => other,
    };
    track_tx(&c, &cl, &sql);
    let affected = match got {
        Ok(a) => a,
        Err(x) => {
            live.discard();
            return Err(x);
        }
    };
    let cur = live.current();
    if let Some((_, rs)) = &cur {
        rs.done.store(true, Ordering::Relaxed);
    }
    Ok(QueryOk {
        result_id: cur.as_ref().map(|(id, _)| *id),
        columns: cur.as_ref().map(|(_, r)| r.columns.clone()).unwrap_or_default(),
        row_count: cur.as_ref().map_or(0, |(_, r)| r.len()),
        affected,
        truncated: matches!(stopped, Some("rows" | "memory")),
        stopped: stopped.filter(|s| *s != "rows"),
        ms: started.elapsed().as_millis() as u64,
        first_row_ms: live.first_row_ms(),
        tx: c.tx_state(),
    })
}

/// SQL Server — 흐름을 놓은 뒤 Attention 으로 서버 문장을 멈춘다. 계산 중(보낸 응답이 없을 때)이면 확인이 바로 와 연결을 그대로 쓴다.
/// 응답을 보내던 중이면 확인(DONE_ATTN)이 그 응답 뒤에 따로 와 tiberius 가 못 읽고, 다음 문장부터 응답이 하나씩 밀린다
/// (실측: 한 번 더 보내도 서버가 빈 Attention 에도 확인을 보내 다시 밀림) — 그 연결은 쓰지 않게 막고 다시 연결하게 한다
async fn ms_cancel(g: &mut MsClient, c: &DbConn) {
    if g.cancel_query().await.is_err() {
        c.broken.store(true, Ordering::Relaxed);
    }
}

/// 문장 실행 — 행은 live 에 넣고, 반영 행 수를 돌려준다
async fn exec(c: &DbConn, sql: &str, live: &Live<'_>) -> R<Option<u64>> {
    let mut affected = None;
    match &c.engine {
        Engine::Pg { client, .. } => {
            let stream = client.simple_query_raw(sql).await.map_err(pg_err)?;
            pin_mut!(stream);
            let mut set: Option<Arc<ResultSet>> = None;
            let mut halted = false;
            while let Some(m) = stream.next().await {
                match m {
                    Ok(tokio_postgres::SimpleQueryMessage::RowDescription(cols)) => {
                        set = Some(live.begin(cols.iter().map(|c| Col { name: c.name().to_string(), kind: "text" }).collect()));
                    }
                    Ok(tokio_postgres::SimpleQueryMessage::Row(r)) => {
                        let Some(rs) = &set else { continue };
                        if !live.push(rs, (0..r.len()).map(|i| r.get(i).map(String::from)).collect()) {
                            halted = true;
                            let _ = server_cancel(c).await;
                            break;
                        }
                        live.pace().await;
                    }
                    Ok(tokio_postgres::SimpleQueryMessage::CommandComplete(n)) => affected = Some(n),
                    Ok(_) => {}
                    Err(x) => return Err(pg_err(x)),
                }
            }
            if halted {
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
            let mut res = g.query_iter(sql).await.map_err(my_err)?;
            let cols = res.columns_ref().to_vec();
            let set = (!cols.is_empty()).then(|| live.begin(cols.iter().map(|c| Col { name: c.name_str().to_string(), kind: my_kind(c.column_type()) }).collect()));
            let mut halted = false;
            loop {
                let row = match res.next().await {
                    Ok(Some(r)) => r,
                    Ok(None) => break,
                    // 취소를 눌러 멈춘 뒤 서버가 KILL QUERY 로 끊은 것
                    Err(x) => {
                        let err = my_err(x);
                        if halted && err.code == "CANCELLED" {
                            return Ok(None);
                        }
                        return Err(err);
                    }
                };
                // MySQL 은 남은 행을 읽어 버려야 연결을 다시 쓸 수 있다
                if halted {
                    continue;
                }
                if let Some(rs) = &set {
                    if !live.push(rs, row.unwrap().into_iter().map(my_value).collect()) {
                        halted = true;
                        // 행·메모리 상한 — 아직 이 결과를 읽는 중이라(문장이 끝나지 않음) KILL QUERY 는 이 문장만 멈춘다.
                        // 남은 행을 다 읽어 버리는 것보다 빠르다(100만 행 중 1만 상한: 5.7초 → 바로)
                        if live.stopped() != Some("cancelled") {
                            let _ = server_cancel(c).await;
                        }
                    }
                    live.pace().await;
                }
            }
            affected = Some(res.affected_rows());
            res.drop_result().await.map_err(my_err)?;
        }
        Engine::Ms { client } => {
            let mut g = client.lock().await;
            let fw = first_word(sql);
            // 취소는 이 루프가 받는다 — 흐름을 놓고 Attention 으로 서버 문장을 멈춘다
            let stop = c.stop_notify.notified();
            pin_mut!(stop);
            stop.as_mut().enable();
            let mut halted = c.stop_req.load(Ordering::Relaxed);
            // first_word 는 소문자, READ_WORDS 는 대문자 — 예전엔 SELECT 도 execute 로 가서 행을 못 받았다
            if READ_WORDS.iter().any(|w| w.eq_ignore_ascii_case(&fw)) || fw == "with" || fw == "exec" || fw == "execute" || fw == "sp_help" {
                let mut set: Option<(usize, Arc<ResultSet>)> = None;
                if !halted {
                    let opened = tokio::select! {
                        biased;
                        _ = &mut stop => None,
                        r = g.simple_query(sql) => Some(r.map_err(ms_err)?),
                    };
                    // 행·메모리 상한이면 남은 행을 읽어 버린다(응답 중 Attention 은 tiberius 가 확인을 못 읽어 연결이 어긋난다)
                    let mut draining = false;
                    match opened {
                        None => halted = true,
                        Some(mut stream) => loop {
                            let item = tokio::select! {
                                biased;
                                _ = &mut stop => {
                                    halted = true;
                                    break;
                                }
                                r = stream.try_next() => r.map_err(ms_err)?,
                            };
                            let Some(item) = item else { break };
                            match item {
                                tiberius::QueryItem::Metadata(m) => {
                                    if set.is_none() {
                                        set = Some((m.result_index(), live.begin(m.columns().iter().map(|c| Col { name: c.name().to_string(), kind: ms_kind(c.column_type()) }).collect())));
                                    }
                                }
                                tiberius::QueryItem::Row(r) => {
                                    let Some((idx, rs)) = &set else { continue };
                                    if draining || r.result_index() != *idx {
                                        continue;
                                    }
                                    if !live.push(rs, r.into_iter().map(ms_value).collect()) {
                                        if live.stopped() == Some("cancelled") {
                                            halted = true;
                                            break;
                                        }
                                        draining = true;
                                        continue;
                                    }
                                    live.pace().await;
                                }
                            }
                        },
                    }
                }
                if halted {
                    ms_cancel(&mut g, c).await;
                    live.halt("cancelled");
                    return Err(e("CANCELLED", "취소했습니다"));
                }
            } else {
                let done = if halted {
                    None
                } else {
                    tokio::select! {
                        biased;
                        _ = &mut stop => None,
                        r = g.execute(sql, &[]) => Some(r.map_err(ms_err)?),
                    }
                };
                match done {
                    Some(res) => affected = Some(res.total()),
                    None => {
                        ms_cancel(&mut g, c).await;
                        return Err(e("CANCELLED", "취소했습니다"));
                    }
                }
            }
        }
        Engine::Jdbc { side } => {
            let max = live.max;
            let (id, mut rx) = side
                .request(json!({"op": "query", "sql": sql, "maxRows": max, "firstBatch": FIRST_BATCH, "firstBatchMs": FIRST_MS, "batch": EVERY_ROWS}))
                .await
                .map_err(|m| e("CLOSED", m))?;
            let mut set: Option<Arc<ResultSet>> = None;
            let mut halted = false;
            let outcome = loop {
                let Some(v) = rx.recv().await else {
                    break Err(e("CLOSED", "JDBC 브리지가 끝났습니다"));
                };
                match v["type"].as_str() {
                    Some("columns") => {
                        set = Some(
                            live.begin(
                                v["columns"]
                                    .as_array()
                                    .map(|a| a.iter().map(|c| Col { name: c["name"].as_str().unwrap_or("").to_string(), kind: kind_of(c["kind"].as_str().unwrap_or("")) }).collect())
                                    .unwrap_or_default(),
                            ),
                        );
                    }
                    Some("rows") if !halted => {
                        let Some(rs) = &set else { continue };
                        for r in v["rows"].as_array().into_iter().flatten() {
                            if !live.push(rs, r.as_array().map(|x| x.iter().map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default()) {
                                halted = true;
                                // 메모리 상한 — 브리지에도 멈추라고(사용자 취소는 이미 보냈다)
                                if live.stopped() == Some("memory") {
                                    let _ = side.call(json!({"op": "cancel"})).await;
                                }
                                break;
                            }
                        }
                        tokio::task::yield_now().await;
                    }
                    Some("done") => {
                        affected = v["affected"].as_u64();
                        if v["truncated"].as_bool().unwrap_or(false) {
                            live.halt("rows");
                        }
                        if v["cancelled"].as_bool().unwrap_or(false) {
                            live.halt("cancelled");
                        }
                        break Ok(());
                    }
                    Some("error") => {
                        let err = jdbc_err(&v);
                        if halted && err.code == "CANCELLED" {
                            break Ok(());
                        }
                        break Err(err);
                    }
                    _ => {}
                }
            };
            side.done(id);
            outcome?;
        }
    }
    Ok(affected)
}

#[tauri::command]
pub async fn db_cancel(dbs: State<'_, DbConns>, conn: u32) -> R<()> {
    let c = dbs.get(conn)?;
    cancel_conn(&c).await
}

#[tauri::command]
pub fn db_rows(dbs: State<'_, DbConns>, result: u32, from: usize, to: usize) -> R<Vec<Vec<Option<String>>>> {
    Ok(db_rows_core(&dbs, result, from, to))
}

pub(crate) fn db_rows_core(dbs: &DbConns, result: u32, from: usize, to: usize) -> Vec<Vec<Option<String>>> {
    let Some(r) = dbs.results.lock().unwrap().get(&result).cloned() else {
        return Vec::new();
    };
    let rows = r.rows.read().unwrap();
    let view = r.view.lock().unwrap();
    match &*view {
        Some(v) => {
            let to = to.min(v.len());
            v[from.min(to)..to].iter().filter_map(|&i| rows.get(i).cloned()).collect()
        }
        None => {
            let to = to.min(rows.len());
            rows[from.min(to)..to].to_vec()
        }
    }
}

/// 받은 행을 정렬·거르기 — 서버에 다시 묻지 않는다. 숫자 열은 숫자로, NULL 은 늘 맨 뒤.
/// 거르기: 낱말을 띄어 쓰면 모두 들어간 행(대소문자 무시, 아무 열). 돌려주는 값은 보이는 행 수
pub(crate) fn view_core(r: &ResultSet, sort: Option<usize>, desc: bool, filter: Option<&str>) -> usize {
    let words: Vec<String> = filter.unwrap_or("").split_whitespace().map(|w| w.to_lowercase()).collect();
    let rows = r.rows.read().unwrap();
    if sort.is_none() && words.is_empty() {
        *r.view.lock().unwrap() = None;
        return rows.len();
    }
    let mut idx: Vec<usize> = (0..rows.len())
        .filter(|&i| {
            words.is_empty() || {
                let hay: String = rows[i].iter().map(|v| v.as_deref().unwrap_or("null").to_lowercase()).collect::<Vec<_>>().join("");
                words.iter().all(|w| hay.contains(w.as_str()))
            }
        })
        .collect();
    if let Some(c) = sort.filter(|c| *c < r.columns.len()) {
        let numeric = matches!(r.columns[c].kind, "int" | "numeric");
        let key = |i: usize| rows[i].get(c).cloned().flatten();
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
    r.need_done()?;
    Ok(view_core(&r, sort, desc, filter.as_deref()))
}

#[tauri::command]
pub fn db_result_close(dbs: State<'_, DbConns>, result: u32) {
    dbs.results.lock().unwrap().remove(&result);
}

/// 결과를 파일로 — csv(UTF-8 BOM, 엑셀이 한글을 바로 읽게) · tsv · json · sql(INSERT 문 — insert_prefix 는 화면이 엔진에 맞게 만든 `INSERT INTO 표 (열…) VALUES `)
#[tauri::command]
pub fn db_export(dbs: State<'_, DbConns>, result: u32, format: String, path: String, insert_prefix: Option<String>, mysql: Option<bool>) -> R<usize> {
    let r = dbs.results.lock().unwrap().get(&result).cloned().ok_or_else(|| e("CLOSED", "결과가 없습니다"))?;
    r.need_done()?;
    let all = r.rows.read().unwrap();
    let vis = r.visible(&all);
    let mut out = String::new();
    match format.as_str() {
        "sql" => {
            let prefix = insert_prefix.unwrap_or_default();
            let my = mysql.unwrap_or(false);
            for row in &vis {
                let vals: Vec<String> = row
                    .iter()
                    .zip(&r.columns)
                    .map(|(v, c)| match v {
                        None => "NULL".to_string(),
                        Some(x) if matches!(c.kind, "int" | "numeric") && x.trim().parse::<f64>().is_ok() => x.trim().to_string(),
                        Some(x) => lit(x, my),
                    })
                    .collect();
                out.push_str(&format!("{prefix}({});\n", vals.join(", ")));
            }
        }
        "json" => {
            let arr: Vec<serde_json::Map<String, serde_json::Value>> = vis
                .iter()
                .map(|row| {
                    r.columns
                        .iter()
                        .zip(row.iter())
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
            for row in &vis {
                out.push_str(&row.iter().map(|v| v.as_deref().map(cell).unwrap_or_default()).collect::<Vec<_>>().join(&sep.to_string()));
                out.push_str("\r\n");
            }
        }
    }
    std::fs::write(&path, out).map_err(|x| e("OTHER", x.to_string()))?;
    Ok(vis.len())
}

// ── 실행 계획 ───────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainOk {
    /// pg-json | my-json | text
    format: &'static str,
    plan: String,
    ms: u64,
    /// 쓰기 문장을 ANALYZE 로 실제 실행한 뒤 되돌렸는지
    rolled_back: bool,
}

/// 실행 계획 — PostgreSQL EXPLAIN (FORMAT JSON), MySQL EXPLAIN FORMAT=JSON, MariaDB ANALYZE FORMAT=JSON,
/// SQL Server SHOWPLAN_TEXT(글). analyze 면 실제로 실행한다 — 쓰기 문장이면 실행 뒤 되돌린다.
#[tauri::command]
pub async fn db_explain(dbs: State<'_, DbConns>, conn: u32, sql: String, analyze: bool) -> R<ExplainOk> {
    let c = dbs.get(conn)?;
    let inner = classify(&sql, c.is_mysql());
    if c.read_only && (!inner.read_only_safe || (analyze && inner.writes)) {
        return Err(e("READ_ONLY", "읽기 전용 연결이라 쓰기 문장의 실행 계획은 볼 수 없습니다"));
    }
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    let started = Instant::now();
    let body = sql.trim().trim_end_matches(';').to_string();
    let wrap = analyze && inner.writes;
    let in_tx = c.in_tx.load(Ordering::Relaxed);
    let first_col = |rows: Vec<Vec<Option<String>>>| rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect::<Vec<_>>().join("\n");
    let (format, plan) = match &c.engine {
        Engine::Pg { client, .. } => {
            let q = if analyze { format!("EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, VERBOSE) {body}") } else { format!("EXPLAIN (FORMAT JSON, VERBOSE, COSTS) {body}") };
            if wrap {
                client.batch_execute(if in_tx { "SAVEPOINT rb_explain" } else { "BEGIN" }).await.map_err(pg_err)?;
            }
            let r = rows_of(&c, &q).await;
            if wrap {
                client.batch_execute(if in_tx { "ROLLBACK TO SAVEPOINT rb_explain; RELEASE SAVEPOINT rb_explain" } else { "ROLLBACK" }).await.map_err(pg_err)?;
            }
            ("pg-json", first_col(r?))
        }
        Engine::My { conn, mariadb, .. } => {
            let (q, f) = match (analyze, *mariadb) {
                (false, _) => (format!("EXPLAIN FORMAT=JSON {body}"), "my-json"),
                (true, true) => (format!("ANALYZE FORMAT=JSON {body}"), "my-json"),
                (true, false) => (format!("EXPLAIN ANALYZE {body}"), "text"),
            };
            if wrap {
                conn.lock().await.query_drop(if in_tx { "SAVEPOINT rb_explain" } else { "START TRANSACTION" }).await.map_err(my_err)?;
            }
            let r = rows_of(&c, &q).await;
            if wrap {
                conn.lock().await.query_drop(if in_tx { "ROLLBACK TO SAVEPOINT rb_explain" } else { "ROLLBACK" }).await.map_err(my_err)?;
            }
            (f, first_col(r?))
        }
        Engine::Ms { client } => {
            if analyze {
                return Err(e("OTHER", "SQL Server 는 예상 계획(SHOWPLAN)만 봅니다"));
            }
            let mut g = client.lock().await;
            g.simple_query("SET SHOWPLAN_TEXT ON").await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
            let r = match g.simple_query(body.as_str()).await {
                Ok(st) => st.into_results().await.map_err(ms_err),
                Err(x) => Err(ms_err(x)),
            };
            // 오류여도 반드시 끈다(안 끄면 다음 문장이 실행되지 않고 계획만 나온다)
            g.simple_query("SET SHOWPLAN_TEXT OFF").await.map_err(ms_err)?.into_results().await.map_err(ms_err)?;
            let sets = r?;
            let text = sets.into_iter().flatten().filter_map(|row| row.into_iter().next().and_then(ms_value)).collect::<Vec<_>>().join("\n");
            ("text", text)
        }
        Engine::Jdbc { .. } => return Err(e("OTHER", "이 엔진은 계획 트리를 지원하지 않습니다")),
    };
    Ok(ExplainOk { format, plan, ms: started.elapsed().as_millis() as u64, rolled_back: wrap })
}

// ── CSV 가져오기 ─────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvData {
    rows: Vec<Vec<String>>,
    /// 쉼표·탭·세미콜론
    delimiter: String,
    encoding: String,
}

/// CSV 한 덩이 나누기(RFC 4180 — 따옴표 안 줄바꿈·"" 이스케이프)
pub(crate) fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(ch) = chars.next() {
        any = true;
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cell.push(ch);
            }
        } else if ch == '"' && cell.is_empty() {
            quoted = true;
        } else if ch == delim {
            row.push(std::mem::take(&mut cell));
        } else if ch == '\r' {
            // \r\n 은 \n 에서 끊는다
        } else if ch == '\n' {
            row.push(std::mem::take(&mut cell));
            out.push(std::mem::take(&mut row));
            any = false;
        } else {
            cell.push(ch);
        }
    }
    if any || !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        out.push(row);
    }
    out
}

/// CSV 파일 읽기 — 인코딩(UTF-8·EUC-KR 등)과 구분자를 짐작한다. 행 상한 100만
#[tauri::command]
pub fn db_read_csv(path: String) -> R<CsvData> {
    let bytes = std::fs::read(&path).map_err(|x| e("OTHER", x.to_string()))?;
    let d = crate::textcodec::decode(&bytes, None);
    let Some(text) = d.text else {
        return Err(e("OTHER", "글 파일이 아닙니다"));
    };
    let head = text.lines().next().unwrap_or("");
    let delim = [('\t', head.matches('\t').count()), (';', head.matches(';').count()), (',', head.matches(',').count())]
        .into_iter()
        .max_by_key(|x| x.1)
        .filter(|x| x.1 > 0)
        .map(|x| x.0)
        .unwrap_or(',');
    let mut rows = parse_csv(&text, delim);
    rows.truncate(1_000_000);
    Ok(CsvData { rows, delimiter: delim.to_string(), encoding: d.meta.encoding })
}

/// 바이너리 칸 저장 — 16진 글(0x… 또는 \x…)을 바이트로 바꿔 파일에 쓴다
#[tauri::command]
pub fn db_save_hex(path: String, hex: String) -> R<usize> {
    let h = hex.trim();
    let h = h.strip_prefix("0x").or_else(|| h.strip_prefix("0X")).or_else(|| h.strip_prefix("\\x")).unwrap_or(h);
    if h.len() % 2 != 0 {
        return Err(e("OTHER", "16진 글 길이가 홀수입니다"));
    }
    let bytes = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16)).collect::<Result<Vec<u8>, _>>().map_err(|_| e("OTHER", "16진 글이 아닙니다"))?;
    std::fs::write(&path, &bytes).map_err(|x| e("OTHER", x.to_string()))?;
    Ok(bytes.len())
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
            // PostgreSQL 은 카탈로그로 — 구체화 뷰·분할 표·외부 표까지
            let sql = if !my && !ms {
                format!(
                    "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATVIEW' WHEN 'p' THEN 'PARTITIONED' WHEN 'f' THEN 'FOREIGN' ELSE 'TABLE' END
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = {} AND c.relkind IN ('r','p','v','m','f')
                     ORDER BY CASE WHEN c.relkind IN ('r','p','f') THEN 0 ELSE 1 END, c.relname",
                    lit(schema, false)
                )
            } else {
                format!("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = {} ORDER BY table_type, table_name", lit(schema, my))
            };
            Ok(rows_of(&c, &sql)
                .await?
                .iter()
                .map(|r| {
                    let t = s(r, 1);
                    let (kind, detail) = match t.as_str() {
                        "MATVIEW" => ("view", Some("구체화 뷰".to_string())),
                        "PARTITIONED" => ("table", Some("분할 표".to_string())),
                        "FOREIGN" => ("table", Some("외부 표".to_string())),
                        x if x.contains("VIEW") => ("view", None),
                        _ => ("table", None),
                    };
                    DbNode { name: s(r, 0), kind, detail }
                })
                .collect())
        }
        [schema, table] => {
            // 열 — 형식·NOT NULL·PK·인덱스(4번째 칸: PK | IDX | 빈칸)
            let sql = if my {
                format!(
                    "SELECT column_name, column_type, is_nullable, CASE column_key WHEN 'PRI' THEN 'PK' WHEN '' THEN '' ELSE 'IDX' END
                     FROM information_schema.columns WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
                    lit(schema, true),
                    lit(table, true)
                )
            } else if ms {
                format!(
                    "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
                            CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                              WHERE i.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND i.is_primary_key = 1 AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME) THEN 'PK'
                                 WHEN EXISTS (SELECT 1 FROM sys.index_columns ic
                                              WHERE ic.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME) THEN 'IDX'
                                 ELSE '' END
                     FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = {} AND c.TABLE_NAME = {} ORDER BY c.ORDINAL_POSITION",
                    lit(schema, false),
                    lit(table, false)
                )
            } else {
                // information_schema 는 구체화 뷰 열을 안 보여 줘서 pg_attribute 로
                format!(
                    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
                            CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = cl.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) THEN 'PK'
                                 WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = cl.oid AND a.attnum = ANY(i.indkey)) THEN 'IDX' ELSE '' END
                     FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
                     WHERE n.nspname = {} AND cl.relname = {} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
                    lit(schema, false),
                    lit(table, false)
                )
            };
            Ok(rows_of(&c, &sql)
                .await?
                .iter()
                .map(|r| DbNode {
                    name: s(r, 0),
                    kind: "column",
                    detail: Some(format!(
                        "{}{}{}",
                        s(r, 1),
                        if s(r, 2) == "NO" { " · NOT NULL" } else { "" },
                        match s(r, 3).as_str() {
                            "PK" => " · PK",
                            "IDX" => " · 인덱스",
                            _ => "",
                        }
                    )),
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
    tx: TxState,
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
    // 수동 커밋 — 트랜잭션을 열고 그 안의 세이브포인트로 반영
    if c.manual.load(Ordering::Relaxed) && !c.in_tx.load(Ordering::Relaxed) && !stmts.is_empty() {
        tx_raw(&c, "begin").await?;
    }
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
    if in_tx {
        c.tx_stmts.fetch_add(stmts.len() as u32, Ordering::Relaxed);
    }
    Ok(ApplyOk { affected, in_tx, tx: c.tx_state() })
}

/// 수동 트랜잭션 — begin | commit | rollback
#[tauri::command]
pub async fn db_tx(dbs: State<'_, DbConns>, conn: u32, op: String) -> R<TxState> {
    tx_state_op(&dbs, conn, op).await
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn tx(dbs: &DbConns, conn: u32, op: String) -> R<bool> {
    Ok(tx_state_op(dbs, conn, op).await?.in_tx)
}

async fn tx_state_op(dbs: &DbConns, conn: u32, op: String) -> R<TxState> {
    let c = dbs.get(conn)?;
    let Ok(_busy) = c.busy.try_lock() else {
        return Err(e("BUSY", "앞 문장이 아직 실행 중입니다"));
    };
    tx_raw(&c, &op).await?;
    Ok(c.tx_state())
}

/// 수동 커밋 모드 켜기·끄기(끄면 열린 트랜잭션은 그대로 — 화면이 먼저 커밋·되돌리기를 묻는다)
#[tauri::command]
pub fn db_tx_mode(dbs: State<'_, DbConns>, conn: u32, manual: bool) -> R<TxState> {
    let c = dbs.get(conn)?;
    c.manual.store(manual, Ordering::Relaxed);
    Ok(c.tx_state())
}

#[tauri::command]
pub fn db_tx_state(dbs: State<'_, DbConns>, conn: u32) -> R<TxState> {
    Ok(dbs.get(conn)?.tx_state())
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
    fn classify_rules() {
        let c = |s: &str| classify(s, false);
        let m = |s: &str| classify(s, true);
        assert!(c("select 1").read_only_safe);
        assert!(c("  -- x\n (SELECT 1)").read_only_safe);
        assert!(!c("GRANT SELECT ON t TO u").read_only_safe);
        assert!(c("REVOKE ALL ON t FROM u").dangerous);
        let w = c("WITH x AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT * FROM x");
        assert!(w.writes && !w.read_only_safe);
        assert_eq!(c("WITH x AS (SELECT 1) UPDATE t SET a = 1").keyword, "UPDATE");
        assert!(c("WITH x AS (SELECT 1) DELETE FROM t").dangerous);
        assert!(c("EXPLAIN SELECT * FROM t").read_only_safe);
        assert!(c("EXPLAIN ANALYZE SELECT * FROM t").read_only_safe);
        let ea = c("EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t WHERE id = 1");
        assert!(ea.writes && ea.dangerous && !ea.read_only_safe);
        assert!(m("ANALYZE FORMAT=JSON UPDATE t SET a = 1 WHERE id = 2").writes);
        assert!(c("UPDATE t SET a = 1").dangerous);
        assert!(!c("UPDATE t SET a = 1 WHERE id = 2").dangerous);
        assert!(c("SELECT * INTO new_t FROM t").writes);
        assert!(!c("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE").read_only_safe);
        assert_eq!(c("SET search_path = x").kind, "set");
        // 문자열·주석·$$ 안의 낱말은 보지 않는다
        assert!(c("SELECT 'delete from t' /* drop */ FROM t").read_only_safe);
        assert!(c("SELECT $$ insert $$, $a$ x $a$").read_only_safe);
        assert!(m("SELECT 1 # drop table").read_only_safe);
        assert_eq!(c("").kind, "empty");
        assert_eq!(c("COMMIT").kind, "tx");
    }

    #[test]
    fn csv_parse() {
        let r = parse_csv("a,b\r\n\"x,1\",\"say \"\"hi\"\"\"\n3,\"멀티\n줄\"\n", ',');
        assert_eq!(r, vec![vec!["a", "b"], vec!["x,1", "say \"hi\""], vec!["3", "멀티\n줄"]]);
        assert_eq!(parse_csv("a\tb", '\t'), vec![vec!["a", "b"]]);
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
            account_id: None,
            engine: engine.into(),
            host: host.into(),
            port,
            username: if my { "root".into() } else { "postgres".into() },
            password: pw.map(Into::into),
            database: Some(if my { "shop".into() } else { "postgres".into() }),
            read_only,
            save_secret: false,
            legacy: false,
            ssl: None,
            tunnel: Default::default(),
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
            account_id: None,
            engine: "mssql".into(),
            host: host.into(),
            port: port.parse().unwrap(),
            username: "sa".into(),
            password: Some(pw.clone()),
            database: Some("master".into()),
            read_only: ro,
            save_secret: false,
            legacy: false,
            ssl: None,
            tunnel: Default::default(),
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
            let ok = connect(&store, &dbs, DbConnectReq { profile_id: None, account_id: None, engine: engine.into(), host: "127.0.0.1".into(), port, username: user.into(), password: Some(p), database: Some(db.into()), read_only: false, save_secret: false, legacy: false, ssl: None, tunnel: Default::default() }, None).await.unwrap();
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
        let r = ResultSet::new(vec![col("n", "int"), col("s", "text")], vec![row(Some("10"), "Kim"), row(None, "lee"), row(Some("9"), "Park"), row(Some("100"), "kimchi")], true);
        let vis = || r.visible(&r.rows.read().unwrap()).into_iter().cloned().collect::<Vec<_>>();
        assert_eq!(view_core(&r, Some(0), false, None), 4);
        let got: Vec<_> = vis().iter().map(|x| x[0].clone()).collect();
        assert_eq!(got, vec![Some("9".into()), Some("10".into()), Some("100".into()), None]);
        assert_eq!(view_core(&r, Some(0), true, None), 4);
        assert_eq!(vis()[0][0].as_deref(), Some("100"));
        assert_eq!(vis()[3][0], None);
        assert_eq!(view_core(&r, None, false, Some("KIM")), 2);
        assert_eq!(view_core(&r, Some(1), false, Some("kim 10")), 2);
        assert_eq!(view_core(&r, None, false, Some("null")), 1);
        assert_eq!(view_core(&r, None, false, None), 4);
        assert!(r.view.lock().unwrap().is_none());
    }
}

/// PostgreSQL TLS — verify 면 공인 루트로 인증서 확인, 아니면 암호화만(사내 자체 서명 인증서)
fn tls_connector(verify: bool) -> tokio_postgres_rustls::MakeRustlsConnect {
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().expect("TLS 판");
    let config = if verify {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder.dangerous().with_custom_certificate_verifier(std::sync::Arc::new(NoVerify(provider))).with_no_client_auth()
    };
    tokio_postgres_rustls::MakeRustlsConnect::new(config)
}

/// 인증서를 확인하지 않는 검증기(libpq sslmode=require 와 같은 뜻)
#[derive(Debug)]
struct NoVerify(std::sync::Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod live_tls {
    use super::*;

    /// RB_PGTLS=127.0.0.1:25433 · RB_PGTLS_PW — SSL 만 받는 서버: off 는 거절, prefer·require 는 SSL 로, verify 는 자체 서명이라 거절
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_pg_tls() {
        let spec = std::env::var("RB_PGTLS").unwrap();
        let pw = std::env::var("RB_PGTLS_PW").unwrap();
        let (host, port) = spec.split_once(':').unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(dir.join("db"), false).unwrap();
        let dbs = DbConns::default();
        let req = |ssl: &str| DbConnectReq {
            profile_id: None,
            account_id: None,
            engine: "postgres".into(),
            host: host.into(),
            port: port.parse().unwrap(),
            username: "postgres".into(),
            password: Some(pw.clone()),
            database: Some("postgres".into()),
            read_only: false,
            save_secret: false,
            legacy: false,
            ssl: Some(ssl.into()),
            tunnel: Default::default(),
        };
        let off = connect(&store, &dbs, req("off"), None).await;
        println!("off → {:?}", off.as_ref().err().map(|x| &x.message));
        assert!(off.is_err());
        for m in ["prefer", "require"] {
            let ok = connect(&store, &dbs, req(m), None).await.unwrap();
            let q = query(&dbs, ok.conn_id, "select ssl::text from pg_stat_ssl where pid = pg_backend_pid()".into(), Some(10)).await.unwrap();
            let rows = db_rows_core(&dbs, q.result_id.unwrap(), 0, 10);
            println!("{m} → ssl={:?} ({})", rows[0][0], ok.version);
            assert_eq!(rows[0][0].as_deref(), Some("true"));
        }
        let verify = connect(&store, &dbs, req("verify"), None).await;
        println!("verify → {:?}", verify.as_ref().err().map(|x| &x.message));
        assert!(verify.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// SSH 터널로 DB — RB_TUN_SSH·RB_TUN_KEY(tunnel 시험과 같음), RB_TUN_PG=SSH 서버에서 본 PG 주소:포트, RB_TUN_MY=MariaDB, RB_TUN_DB_PW
#[cfg(test)]
mod live_tunnel {
    use super::*;

    fn req(engine: &str, target: &str, pw: &str, pid: i64, aid: i64) -> DbConnectReq {
        let (host, port) = target.split_once(':').unwrap();
        DbConnectReq {
            profile_id: None,
            account_id: None,
            engine: engine.into(),
            host: host.into(),
            port: port.parse().unwrap(),
            username: if engine == "postgres" { "postgres".into() } else { "root".into() },
            password: Some(pw.into()),
            database: None,
            read_only: false,
            save_secret: false,
            legacy: false,
            ssl: Some("off".into()),
            tunnel: TunnelReq { ssh_profile_id: Some(pid), ssh_account_id: Some(aid), ..Default::default() },
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_db_through_ssh_tunnel() {
        let pw = std::env::var("RB_TUN_DB_PW").expect("RB_TUN_DB_PW");
        let pg = std::env::var("RB_TUN_PG").expect("RB_TUN_PG");
        let (store, dir, pid, aid) = crate::tunnel::tests::live_server("db").await;
        let dbs = DbConns::default();

        // PG 둘 — SSH 연결 하나를 나눠 쓴다
        let t = Instant::now();
        let a = connect(&store, &dbs, req("postgres", &pg, &pw, pid, aid), None).await.unwrap_or_else(|x| panic!("{} {}", x.code, x.message));
        println!("PG 터널 경유 접속 {} ms · {}", t.elapsed().as_millis(), a.version);
        let b = connect(&store, &dbs, req("postgres", &pg, &pw, pid, aid), None).await.unwrap();
        assert_eq!(crate::tunnel::tests::link_count(), 1, "같은 계정이면 SSH 연결 하나");
        let q = query(&dbs, a.conn_id, "select inet_server_addr()::text, inet_client_addr()::text".into(), Some(10)).await.unwrap();
        let rows = db_rows_core(&dbs, q.result_id.unwrap(), 0, 1);
        println!("PG 서버 주소 {:?} · PG 가 본 손님 주소 {:?}(= SSH 서버)", rows[0][0], rows[0][1]);
        let tun = dbs.get(a.conn_id).unwrap().tunnel.clone().unwrap();
        println!("엔진이 붙은 곳 127.0.0.1:{}", tun.port);
        drop(tun);

        // MariaDB
        if let Ok(my) = std::env::var("RB_TUN_MY") {
            let m = connect(&store, &dbs, req("mariadb", &my, &pw, pid, aid), None).await.unwrap_or_else(|x| panic!("{} {}", x.code, x.message));
            let q = query(&dbs, m.conn_id, "select @@hostname, version()".into(), Some(10)).await.unwrap();
            println!("MariaDB 터널 경유 {:?} · {}", db_rows_core(&dbs, q.result_id.unwrap(), 0, 1)[0], m.version);
            close(&dbs, m.conn_id).await;
        }

        // 서버에서 닿지 않는 대상 — 터널 오류를 그대로
        let bad = connect(&store, &dbs, req("postgres", "127.0.0.1:1", &pw, pid, aid), None).await.err().unwrap();
        println!("닿지 않는 대상 → {} {}", bad.code, bad.message);
        assert!(bad.message.contains("SSH 터널"));

        // 다 닫으면 SSH 연결도 닫힌다
        close(&dbs, a.conn_id).await;
        close(&dbs, b.conn_id).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(crate::tunnel::tests::link_count(), 0, "마지막 DB 연결을 닫으면 SSH 연결도");
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 받는 중 알림·취소·시간 상한 — `RB_STREAM_TEST=pg:127.0.0.1:25442,maria:127.0.0.1:23316,ms:127.0.0.1:21443,jdbc:127.0.0.1:25442`
/// 와 `RB_DB_TEST_PW`(jdbc 는 `RB_JDBC_JAVA`·`RB_JDBC_JAR` — PostgreSQL JDBC 드라이버로 사이드카 프로토콜 확인)
#[cfg(test)]
mod live_stream {
    use super::*;
    use std::path::PathBuf;

    fn req(engine: &str, host: &str, port: u16, pw: &str) -> DbConnectReq {
        let (user, db) = match engine {
            "postgres" => ("postgres", "postgres"),
            "mssql" => ("sa", "master"),
            _ => ("root", "shop"),
        };
        DbConnectReq {
            profile_id: None,
            account_id: None,
            engine: engine.into(),
            host: host.into(),
            port,
            username: user.into(),
            password: Some(pw.into()),
            database: Some(db.into()),
            read_only: false,
            save_secret: false,
            legacy: false,
            ssl: None,
            tunnel: Default::default(),
        }
    }

    type Log = Mutex<Vec<(u64, usize, Instant)>>;

    async fn run(dbs: &DbConns, c: u32, sql: &str, max: usize, timeout: Option<u64>, log: &Log) -> R<QueryOk> {
        log.lock().unwrap().clear();
        let f = |p: Progress| log.lock().unwrap().push((p.ms, p.row_count, Instant::now()));
        query_opts(dbs, c, sql.into(), Some(max), timeout, Some((1, &f))).await
    }

    fn report(name: &str, q: &R<QueryOk>, log: &Log, t: Instant) {
        let l = log.lock().unwrap();
        let first = l.first().map(|x| format!("{} ms 에 {}행", x.2.duration_since(t).as_millis(), x.1));
        match q {
            Ok(q) => println!(
                "{name}: {}행 truncated {} stopped {:?} 전체 {} ms · 보냄→첫 행 {:?} ms · 알림 {}번(첫 알림 {:?}) · 마지막 알림 {:?}",
                q.row_count,
                q.truncated,
                q.stopped,
                q.ms,
                q.first_row_ms,
                l.len(),
                first,
                l.last().map(|x| (x.0, x.1))
            ),
            Err(x) => println!("{name}: 오류 {} {} · 알림 {}번", x.code, x.message, l.len()),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_stream_all_engines() {
        let spec = std::env::var("RB_STREAM_TEST").expect("RB_STREAM_TEST");
        let pw = std::env::var("RB_DB_TEST_PW").expect("RB_DB_TEST_PW");
        let dir = std::env::temp_dir().join(format!("rbshell-stream-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let dbs = DbConns::default();
        let log: Log = Mutex::new(Vec::new());
        for item in spec.split(',') {
            let mut it = item.split(':');
            let kind = it.next().unwrap();
            let host = it.next().unwrap();
            let port: u16 = it.next().unwrap().parse().unwrap();
            println!("== {kind}");
            let mut c = if kind == "jdbc" {
                let java = std::env::var("RB_JDBC_JAVA").expect("RB_JDBC_JAVA");
                let jar = PathBuf::from(std::env::var("RB_JDBC_JAR").expect("RB_JDBC_JAR"));
                let side = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("rb-jdbc.jar");
                let s = crate::jdbc::Sidecar::spawn_with(std::path::Path::new(&java), &side, &[jar]).await.unwrap();
                let url = format!("jdbc:postgresql://{host}:{port}/postgres");
                let v = s.call(json!({"op": "connect", "url": url, "user": "postgres", "password": pw, "driver": "org.postgresql.Driver"})).await.unwrap();
                assert_eq!(v["type"], "ok", "{v}");
                let id = dbs.next.fetch_add(1, Ordering::Relaxed) + 1;
                dbs.map.lock().unwrap().insert(id, Arc::new(DbConn::new(Engine::Jdbc { side: s }, req("postgres", host, port, &pw), 1, None)));
                id
            } else {
                let engine = match kind {
                    "pg" => "postgres",
                    "ms" => "mssql",
                    _ => "mariadb",
                };
                connect(&store, &dbs, req(engine, host, port, &pw), None).await.unwrap().conn_id
            };
            let (million, slow) = match kind {
                "pg" | "jdbc" => (
                    "SELECT g AS id, 'user ' || g AS name, now() - g * interval '1 minute' AS at FROM generate_series(1, 1000000) g",
                    "SELECT g, pg_sleep(0.002) FROM generate_series(1, 100000) g",
                ),
                "ms" => (
                    "SELECT TOP 1000000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS id, CONCAT(N'user ', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))) AS name, SYSDATETIME() AS at FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c",
                    // 응답을 보내는 중에 멈추기(그 연결은 막히고 새로 접속)
                    "SELECT TOP 1000000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS id, CONCAT(N'user ', ROW_NUMBER() OVER (ORDER BY (SELECT NULL))) AS name, SYSDATETIME() AS at FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c",
                ),
                _ => ("SELECT seq AS id, CONCAT('user ', seq) AS name, NOW() - INTERVAL seq MINUTE AS at FROM seq_1_to_1000000", "SELECT seq, SLEEP(0.002) FROM seq_1_to_100000"),
            };
            // 100만 행 — 첫 알림이 일찍 오는지, 받는 중에도 앞 행을 읽을 수 있는지
            let t = Instant::now();
            let q = {
                let fut = run(&dbs, c, million, 1_000_000, None, &log);
                pin_mut!(fut);
                let mut peeked = false;
                loop {
                    tokio::select! {
                        r = &mut fut => break r,
                        _ = tokio::time::sleep(Duration::from_millis(20)), if !peeked => {
                            if log.lock().unwrap().first().is_some_and(|x| x.1 > 0) {
                                let id = dbs.results.lock().unwrap().keys().max().copied().unwrap();
                                let rows = db_rows_core(&dbs, id, 0, 2);
                                println!("  받는 중 {} ms 에 앞 두 행 읽기 {:?}", t.elapsed().as_millis(), rows);
                                peeked = true;
                            }
                        }
                    }
                }
            };
            report("100만 행", &q, &log, t);
            let q = q.unwrap();
            assert!(q.row_count >= 999_000, "{}", q.row_count);
            assert!(log.lock().unwrap().len() >= 2);
            // 행 상한
            let t = Instant::now();
            let q = run(&dbs, c, million, 10_000, None, &log).await;
            report("상한 1만", &q, &log, t);
            assert!(q.as_ref().unwrap().truncated && q.as_ref().unwrap().row_count == 10_000);
            // 취소 — 받은 행은 남는다
            let t = Instant::now();
            let q = {
                let fut = run(&dbs, c, slow, 1_000_000, None, &log);
                let cancel = async {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    cancel_conn(&dbs.get(c).unwrap()).await
                };
                let (q, k) = tokio::join!(fut, cancel);
                println!("  취소 요청 → {:?}", k.err().map(|x| x.message));
                q
            };
            report("취소(1.2초 뒤)", &q, &log, t);
            let next = query(&dbs, c, "SELECT 1".into(), None).await;
            println!("  다음 문장 {:?}", next.as_ref().map(|x| x.row_count).map_err(|x| x.message.clone()));
            if next.is_err() && kind == "ms" && dbs.any(c).unwrap().broken.load(Ordering::Relaxed) {
                println!("  (SQL Server 응답 중 멈춤 → 연결 막음, 새로 접속)");
                c = connect(&store, &dbs, req("mssql", host, port, &pw), None).await.unwrap().conn_id;
            } else {
                assert!(next.is_ok());
            }
            // 시간 상한 — 받은 행은 남는다
            let t = Instant::now();
            let q = run(&dbs, c, slow, 1_000_000, Some(1000), &log).await;
            report("시간 상한 1초", &q, &log, t);
            let next = query(&dbs, c, "SELECT 1".into(), None).await;
            println!("  다음 문장 {:?}", next.as_ref().map(|x| x.row_count).map_err(|x| x.message.clone()));
            if next.is_err() && kind == "ms" && dbs.any(c).unwrap().broken.load(Ordering::Relaxed) {
                println!("  (SQL Server 응답 중 멈춤 → 연결 막음, 새로 접속)");
                c = connect(&store, &dbs, req("mssql", host, port, &pw), None).await.unwrap().conn_id;
            } else {
                assert!(next.is_ok());
            }
            if kind == "ms" {
                // 계산 중(아직 보낸 응답 없음)에 취소 — 실측: 이때도 tiberius 0.13 이 확인을 못 읽어 연결을 막는다
                let t = Instant::now();
                let fut = run(&dbs, c, "WAITFOR DELAY '00:00:05'; SELECT 1 AS n", 100, None, &log);
                let cancel = async {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    cancel_conn(&dbs.get(c).unwrap()).await
                };
                let (q, _) = tokio::join!(fut, cancel);
                report("계산 중 취소", &q, &log, t);
                let next = query(&dbs, c, "SELECT 1".into(), None).await;
                let broken = dbs.any(c).unwrap().broken.load(Ordering::Relaxed);
                println!("  다음 문장 {:?} · 막힘 {broken}", next.as_ref().map(|x| x.row_count).map_err(|x| x.message.clone()));
                assert!(next.is_ok() || broken);
            }
            dbs.map.lock().unwrap().remove(&c);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
