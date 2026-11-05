//! 포트 포워딩·DB 터널 — SSH 연결 위로 TCP 를 실어 나른다.
//! - local: 내 PC bind_host:bind_port 를 열고, 들어온 연결마다 서버에 direct-tcpip 채널(→ 대상)
//! - remote: 서버에 tcpip-forward 를 걸고, 서버가 그 포트로 들어온 연결을 채널로 열면 내 PC 쪽 대상으로
//! - dynamic: 내 PC 127.0.0.1 에 SOCKS5(CONNECT 만·인증 없음) — 요청한 곳으로 direct-tcpip
//! - DB 터널: 127.0.0.1 빈 포트 → DB 주소:포트. 같은 SSH 계정을 거치는 DB 연결끼리 SSH 연결 하나를 나눠 쓴다
//!   (마지막 DB 연결이 닫히면 그 SSH 연결도 닫는다)

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use russh::client::{Handle, Msg};
use russh::{Channel, Disconnect};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::ssh::{self, Client, Conn, SshConns, SshError};
use crate::store::{Forward, Store};

// ── 숫자 ─────────────────────────────

/// 규칙(또는 DB 터널) 하나의 지금 상태 — 열린 연결 수·누적 연결 수·주고받은 바이트·마지막 오류
#[derive(Default)]
pub(crate) struct Stats {
    open: AtomicU32,
    total: AtomicU64,
    /// 내 쪽 → 대상
    up: AtomicU64,
    /// 대상 → 내 쪽
    down: AtomicU64,
    error: Mutex<Option<String>>,
}

impl Stats {
    fn fail(&self, m: String) {
        *self.error.lock().unwrap() = Some(m);
    }
    fn last_error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }
}

/// 연결 하나가 살아 있는 동안 "열림" 수를 하나 올려 둔다(끝나거나 취소되면 내린다)
struct OpenGuard(Arc<Stats>);
impl OpenGuard {
    fn new(s: &Arc<Stats>) -> Self {
        s.open.fetch_add(1, Ordering::Relaxed);
        s.total.fetch_add(1, Ordering::Relaxed);
        OpenGuard(s.clone())
    }
}
impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 양쪽을 이어 준다 — 한쪽이 다 보내면 반대쪽 쓰기를 닫고(EOF), 둘 다 끝나면 끝
async fn pump<A, B>(a: A, b: B, st: &Stats)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut ar, mut aw) = tokio::io::split(a);
    let (mut br, mut bw) = tokio::io::split(b);
    let up = async {
        copy_count(&mut ar, &mut bw, &st.up).await;
        let _ = bw.shutdown().await;
    };
    let down = async {
        copy_count(&mut br, &mut aw, &st.down).await;
        let _ = aw.shutdown().await;
    };
    tokio::join!(up, down);
}

async fn copy_count<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(r: &mut R, w: &mut W, n: &AtomicU64) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(k) => {
                if w.write_all(&buf[..k]).await.is_err() {
                    break;
                }
                n.fetch_add(k as u64, Ordering::Relaxed);
            }
        }
    }
}

// ── 어느 SSH 연결로 ──────────────────

/// 작업대 연결(화면이 닫으면 사라짐) 또는 DB 터널 전용 연결
#[derive(Clone)]
enum Via {
    Conn(Weak<Conn>),
    Link(Arc<Link>),
}

impl Via {
    async fn open(&self, host: &str, port: u16, peer: SocketAddr) -> Result<Channel<Msg>, String> {
        let (oh, op) = (peer.ip().to_string(), peer.port() as u32);
        let r = match self {
            Via::Conn(w) => {
                let c = w.upgrade().ok_or("SSH 연결이 닫혔습니다")?;
                let r = c.handle_ref().channel_open_direct_tcpip(host, port as u32, oh, op).await;
                r
            }
            Via::Link(l) => l.handle().channel_open_direct_tcpip(host, port as u32, oh, op).await,
        };
        r.map_err(|e| format!("서버에서 {host}:{port} 로 가는 길을 열지 못했습니다 — 서버가 거절했거나(AllowTcpForwarding) 서버에서 그 주소에 닿지 않습니다 ({e})"))
    }
}

/// 내 PC 쪽 포트 열기 — 흔한 실패는 쉬운 말로
async fn listen(host: &str, port: u16) -> Result<TcpListener, String> {
    TcpListener::bind((host, port)).await.map_err(|e| bind_err(host, port, &e))
}

fn bind_err(host: &str, port: u16, e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::AddrInUse => format!("내 PC 의 {port} 포트를 이미 다른 프로그램이 쓰고 있습니다. 다른 포트를 고르세요."),
        K::PermissionDenied => format!("{port} 포트를 열 권한이 없습니다. 1024 아래 포트는 관리자 권한이 필요하고, Windows 가 예약해 둔 포트일 수도 있습니다 — 다른 포트를 고르세요."),
        K::AddrNotAvailable => format!("이 PC 에 {host} 주소가 없습니다. 보통 127.0.0.1 을 씁니다."),
        _ => format!("{host}:{port} 를 열지 못했습니다: {e}"),
    }
}

/// local — 들어온 연결마다 서버에서 대상으로
fn serve_local(listener: TcpListener, via: Via, host: String, port: u16, st: Arc<Stats>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut set = JoinSet::new();
        loop {
            tokio::select! {
                acc = listener.accept() => match acc {
                    Ok((sock, peer)) => {
                        let _ = sock.set_nodelay(true);
                        let (via, host, st) = (via.clone(), host.clone(), st.clone());
                        set.spawn(async move {
                            let _g = OpenGuard::new(&st);
                            match via.open(&host, port, peer).await {
                                Ok(ch) => pump(sock, ch.into_stream(), &st).await,
                                Err(m) => st.fail(m),
                            }
                        });
                    }
                    // 열 수 있는 파일이 모자라는 등 — 잠깐 쉬었다 다시
                    Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
                },
                Some(_) = set.join_next(), if !set.is_empty() => {}
            }
        }
    })
}

/// dynamic — SOCKS5 로 행선지를 받아 서버에서 그곳으로
fn serve_dynamic(listener: TcpListener, via: Via, st: Arc<Stats>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut set = JoinSet::new();
        loop {
            tokio::select! {
                acc = listener.accept() => match acc {
                    Ok((mut sock, peer)) => {
                        let _ = sock.set_nodelay(true);
                        let (via, st) = (via.clone(), st.clone());
                        set.spawn(async move {
                            let _g = OpenGuard::new(&st);
                            let dest = match tokio::time::timeout(Duration::from_secs(10), socks_request(&mut sock)).await {
                                Ok(Ok(d)) => d,
                                Ok(Err(m)) => return st.fail(m),
                                Err(_) => return,
                            };
                            match via.open(&dest.0, dest.1, peer).await {
                                Ok(ch) => {
                                    if socks_reply(&mut sock, 0).await.is_ok() {
                                        pump(sock, ch.into_stream(), &st).await;
                                    }
                                }
                                Err(m) => {
                                    let _ = socks_reply(&mut sock, 5).await;
                                    st.fail(m);
                                }
                            }
                        });
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
                },
                Some(_) = set.join_next(), if !set.is_empty() => {}
            }
        }
    })
}

/// SOCKS5 인사·요청 읽기 → (행선지, 포트). 인증 없는 방식·CONNECT 만 받는다(아니면 거절 답을 보내고 오류)
async fn socks_request<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<(String, u16), String> {
    let io = |e: std::io::Error| format!("SOCKS 요청을 읽지 못했습니다: {e}");
    let mut h = [0u8; 2];
    s.read_exact(&mut h).await.map_err(io)?;
    if h[0] != 5 {
        return Err("SOCKS5 만 받습니다(프로그램의 프록시 종류를 SOCKS5 로)".into());
    }
    let mut methods = vec![0u8; h[1] as usize];
    s.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0) {
        let _ = s.write_all(&[5, 0xff]).await;
        return Err("SOCKS 사용자 이름·암호 인증은 받지 않습니다(인증 없이 쓰세요)".into());
    }
    s.write_all(&[5, 0]).await.map_err(io)?;
    let mut r = [0u8; 4];
    s.read_exact(&mut r).await.map_err(io)?;
    if r[0] != 5 {
        return Err("SOCKS 요청 모양이 틀렸습니다".into());
    }
    if r[1] != 1 {
        let _ = socks_reply(s, 7).await;
        return Err("SOCKS CONNECT 만 됩니다(BIND·UDP 는 안 됨)".into());
    }
    let host = match r[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut n = [0u8; 1];
            s.read_exact(&mut n).await.map_err(io)?;
            let mut name = vec![0u8; n[0] as usize];
            s.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8(name).map_err(|_| "SOCKS 행선지 이름이 올바르지 않습니다".to_string())?
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            let _ = socks_reply(s, 8).await;
            return Err("SOCKS 주소 종류를 모릅니다".into());
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await.map_err(io)?;
    Ok((host, u16::from_be_bytes(p)))
}

/// SOCKS5 답 — 0 성공, 5 연결 거절, 7 명령 안 됨, 8 주소 종류 안 됨
async fn socks_reply<S: AsyncWrite + Unpin>(s: &mut S, code: u8) -> std::io::Result<()> {
    s.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

// ── 원격 포워딩 ──────────────────────

#[derive(Clone)]
pub(crate) struct RemoteTarget {
    host: String,
    port: u16,
    stats: Arc<Stats>,
}

/// 서버 쪽 포트 → 내 PC 쪽 대상 (SSH 처리기가 함께 본다)
pub(crate) type RemoteMap = Arc<Mutex<HashMap<u32, RemoteTarget>>>;

/// 서버가 열어 준 채널 하나를 내 PC 쪽 대상에 잇는다
pub(crate) fn serve_remote(channel: Channel<Msg>, t: RemoteTarget) {
    tauri::async_runtime::spawn(async move {
        let _g = OpenGuard::new(&t.stats);
        match tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((t.host.as_str(), t.port))).await {
            Ok(Ok(sock)) => {
                let _ = sock.set_nodelay(true);
                pump(sock, channel.into_stream(), &t.stats).await;
            }
            Ok(Err(e)) => t.stats.fail(format!("내 PC 에서 {}:{} 에 붙지 못했습니다: {e}", t.host, t.port)),
            Err(_) => t.stats.fail(format!("내 PC 에서 {}:{} 가 응답하지 않습니다", t.host, t.port)),
        }
    });
}

// ── 켜 둔 규칙 ───────────────────────

struct Active {
    conn: u32,
    via: Weak<Conn>,
    rule: Forward,
    stats: Arc<Stats>,
    task: Option<JoinHandle<()>>,
    /// 실제로 받는 포트(원격 0 이면 서버가 고른 것)
    port: u16,
    started_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    id: i64,
    conn: u32,
    label: String,
    error: String,
}

#[derive(Default)]
struct Registry {
    active: HashMap<i64, Active>,
    /// 접속할 때 저절로 켜지 못한 규칙(연결별)
    failed: Vec<Failed>,
}

static REG: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

/// 규칙을 짧게 — "3306→db:3306", "SOCKS 1080", "서버 8080→localhost:3000"
pub(crate) fn short(f: &Forward, port: u16) -> String {
    let t = format!("{}:{}", f.target_host.as_deref().unwrap_or(""), f.target_port.unwrap_or(0));
    match f.kind.as_str() {
        "dynamic" => format!("SOCKS {port}"),
        "remote" => format!("서버 {port}→{t}"),
        _ => format!("{port}→{t}"),
    }
}

/// 규칙 하나 켜기 — 이미 이 연결에서 켜져 있으면 그대로
pub(crate) async fn start(c: &Arc<Conn>, conn: u32, f: Forward) -> Result<(), String> {
    let id = f.id.ok_or("저장하지 않은 규칙입니다")?;
    // 다른 연결(끊긴 것 포함)에서 켜져 있으면: 끊긴 연결이면 정리하고, 살아 있으면 거절
    let other = {
        let reg = REG.lock().unwrap();
        reg.active.get(&id).map(|a| (a.conn, a.via.upgrade().map(|c| !c.handle_ref().is_closed()).unwrap_or(false)))
    };
    match other {
        Some((cid, _)) if cid == conn => return Ok(()),
        Some((_, true)) => return Err("이 규칙은 같은 서버의 다른 연결에서 이미 켜져 있습니다".into()),
        Some((_, false)) => stop(id).await,
        None => {}
    }
    let stats = Arc::new(Stats::default());
    let via = Via::Conn(Arc::downgrade(c));
    let (task, port) = match f.kind.as_str() {
        "local" => {
            let l = listen(&f.bind_host, f.bind_port).await?;
            let port = l.local_addr().map(|a| a.port()).unwrap_or(f.bind_port);
            let th = f.target_host.clone().unwrap_or_default();
            (Some(serve_local(l, via, th, f.target_port.unwrap_or(0), stats.clone())), port)
        }
        "dynamic" => {
            let l = listen("127.0.0.1", f.bind_port).await?;
            let port = l.local_addr().map(|a| a.port()).unwrap_or(f.bind_port);
            (Some(serve_dynamic(l, via, stats.clone())), port)
        }
        "remote" => {
            let got = c.handle_ref().tcpip_forward(f.bind_host.clone(), f.bind_port as u32).await.map_err(|e| match e {
                russh::Error::RequestDenied => format!(
                    "서버가 {}:{} 원격 포워딩을 거절했습니다 — 서버에서 이미 쓰는 포트이거나, 1024 아래 포트(root 만), sshd 의 AllowTcpForwarding·GatewayPorts 설정 때문일 수 있습니다",
                    f.bind_host, f.bind_port
                ),
                other => format!("원격 포워딩을 걸지 못했습니다: {other}"),
            })?;
            let port = if f.bind_port == 0 { got as u16 } else { f.bind_port };
            let target = RemoteTarget { host: f.target_host.clone().unwrap_or_default(), port: f.target_port.unwrap_or(0), stats: stats.clone() };
            c.remote.lock().unwrap().insert(port as u32, target);
            (None, port)
        }
        _ => return Err("알 수 없는 포워딩 종류".into()),
    };
    let mut reg = REG.lock().unwrap();
    reg.failed.retain(|x| !(x.id == id && x.conn == conn));
    reg.active.insert(id, Active { conn, via: Arc::downgrade(c), rule: f, stats, task, port, started_at: crate::store::now() });
    Ok(())
}

/// 규칙 하나 끄기 — 듣던 포트를 닫고 그 위의 연결도 끊는다(원격이면 서버에 걸어 둔 것도 거둔다)
pub(crate) async fn stop(id: i64) {
    let a = REG.lock().unwrap().active.remove(&id);
    let Some(a) = a else { return };
    if let Some(t) = &a.task {
        t.abort();
    }
    if a.rule.kind == "remote" {
        if let Some(c) = a.via.upgrade() {
            c.remote.lock().unwrap().remove(&(a.port as u32));
            if !c.handle_ref().is_closed() {
                let _ = tokio::time::timeout(Duration::from_secs(5), c.handle_ref().cancel_tcpip_forward(a.rule.bind_host.clone(), a.port as u32)).await;
            }
        }
    }
}

/// 연결이 닫히거나 끊겼을 때 — 그 연결의 규칙을 모두 끈다
pub(crate) async fn stop_conn(conn: u32) {
    let ids: Vec<i64> = {
        let mut reg = REG.lock().unwrap();
        reg.failed.retain(|x| x.conn != conn);
        reg.active.iter().filter(|(_, a)| a.conn == conn).map(|(id, _)| *id).collect()
    };
    for id in ids {
        stop(id).await;
    }
}

/// 접속하면 켜기 — 실패한 것은 상태에 남겨 화면이 보여 준다
pub(crate) async fn auto_start(c: &Arc<Conn>, conn: u32, rules: Vec<Forward>) {
    for f in rules {
        let (id, label) = (f.id.unwrap_or(0), f.label.clone().unwrap_or_else(|| short(&f, f.bind_port)));
        if let Err(error) = start(c, conn, f).await {
            REG.lock().unwrap().failed.push(Failed { id, conn, label, error });
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInfo {
    id: i64,
    conn: u32,
    profile_id: i64,
    kind: String,
    label: Option<String>,
    /// 짧은 표시 — "3306→db:3306"
    short: String,
    bind_host: String,
    port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
    open: u32,
    total: u64,
    up: u64,
    down: u64,
    error: Option<String>,
    started_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    active: Vec<ActiveInfo>,
    failed: Vec<Failed>,
}

fn status_of(conn: Option<u32>, profile: Option<i64>) -> ForwardStatus {
    let reg = REG.lock().unwrap();
    let keep = |c: u32, p: i64| conn.is_none_or(|x| x == c) && profile.is_none_or(|x| x == p);
    let mut active: Vec<ActiveInfo> = reg
        .active
        .iter()
        .filter(|(_, a)| keep(a.conn, a.rule.profile_id))
        .map(|(id, a)| ActiveInfo {
            id: *id,
            conn: a.conn,
            profile_id: a.rule.profile_id,
            kind: a.rule.kind.clone(),
            label: a.rule.label.clone(),
            short: short(&a.rule, a.port),
            bind_host: a.rule.bind_host.clone(),
            port: a.port,
            target_host: a.rule.target_host.clone(),
            target_port: a.rule.target_port,
            open: a.stats.open.load(Ordering::Relaxed),
            total: a.stats.total.load(Ordering::Relaxed),
            up: a.stats.up.load(Ordering::Relaxed),
            down: a.stats.down.load(Ordering::Relaxed),
            error: a.stats.last_error(),
            started_at: a.started_at,
        })
        .collect();
    active.sort_by_key(|a| a.id);
    let failed = reg.failed.iter().filter(|f| conn.is_none_or(|x| x == f.conn)).cloned().collect();
    ForwardStatus { active, failed }
}

/// 켜 둔 규칙과 숫자 — conn·profileId 로 좁힌다(둘 다 없으면 전부)
#[tauri::command]
pub fn forward_status(conn: Option<u32>, profile_id: Option<i64>) -> ForwardStatus {
    status_of(conn, profile_id)
}

/// 규칙 켜기 — 그 연결의 서버 규칙만
#[tauri::command]
pub async fn forward_start(store: State<'_, Store>, conns: State<'_, SshConns>, conn: u32, id: i64) -> Result<(), String> {
    let c = conns.get(conn).map_err(|e| e.message_owned())?;
    let f = store.forward(id)?;
    if c.profile_id != Some(f.profile_id) {
        return Err("다른 서버의 규칙입니다".into());
    }
    start(&c, conn, f).await
}

#[tauri::command]
pub async fn forward_stop(id: i64) -> Result<(), String> {
    stop(id).await;
    Ok(())
}

/// 규칙 지우기 — 켜져 있으면 끄고
#[tauri::command]
pub async fn forward_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    stop(id).await;
    REG.lock().unwrap().failed.retain(|x| x.id != id);
    store.forward_delete(id)
}

// ── DB 터널 ──────────────────────────

/// DB 터널 전용 SSH 연결 — 같은 계정을 거치는 DB 연결끼리 나눠 쓴다
pub(crate) struct Link {
    handle: Option<Handle<Client>>,
    jump: Option<Handle<Client>>,
}

impl Link {
    fn handle(&self) -> &Handle<Client> {
        self.handle.as_ref().expect("열린 SSH 연결")
    }
    fn closed(&self) -> bool {
        self.handle.as_ref().is_none_or(|h| h.is_closed())
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            let j = self.jump.take();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(5), h.disconnect(Disconnect::ByApplication, "", "ko")).await;
                drop(j);
            });
        }
    }
}

/// 계정 id → 터널 전용 SSH 연결
static LINKS: LazyLock<Mutex<HashMap<i64, Weak<Link>>>> = LazyLock::new(Default::default);

/// DB 연결 하나의 터널 — 놓으면(DB 연결을 닫으면) 듣던 포트를 닫는다
pub(crate) struct DbTunnel {
    /// 엔진이 붙을 127.0.0.1 포트
    pub(crate) port: u16,
    stats: Arc<Stats>,
    link: Arc<Link>,
    task: JoinHandle<()>,
}

impl DbTunnel {
    /// 거친 SSH 연결이 끊겼는지
    pub(crate) fn closed(&self) -> bool {
        self.link.closed()
    }
    /// 터널에서 난 마지막 오류(서버에서 DB 로 가는 길을 못 연 경우 등)
    pub(crate) fn last_error(&self) -> Option<String> {
        self.stats.last_error()
    }
}

impl Drop for DbTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// DB 를 어느 SSH 서버·계정으로 거칠지와 그 SSH 의 비밀·지문 확인
#[derive(Clone, Default)]
pub(crate) struct TunnelSpec {
    pub(crate) profile_id: i64,
    pub(crate) account_id: Option<i64>,
    pub(crate) secret: Option<String>,
    pub(crate) trust: Option<String>,
    pub(crate) save: bool,
}

/// DB 터널 열기 — 같은 계정의 SSH 연결이 살아 있으면 다시 쓰고, 없으면 붙는다(고정 키·저장 비밀, 없으면 오류로 묻기)
pub(crate) async fn open_db_tunnel(store: &Store, spec: &TunnelSpec, host: &str, port: u16) -> Result<DbTunnel, SshError> {
    let req = ssh::tunnel_req(store, spec.profile_id, spec.account_id, spec.secret.clone(), spec.trust.clone(), spec.save)?;
    let key = ssh::req_account(&req).unwrap_or(-spec.profile_id);
    let reuse = LINKS.lock().unwrap().get(&key).and_then(Weak::upgrade).filter(|l| !l.closed());
    let link = match reuse {
        Some(l) => l,
        None => {
            let a = ssh::open_authed(store, &req).await?;
            let l = Arc::new(Link { handle: Some(a.handle), jump: a.jump });
            let mut links = LINKS.lock().unwrap();
            links.retain(|_, w| w.strong_count() > 0);
            links.insert(key, Arc::downgrade(&l));
            l
        }
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| ssh::err("OTHER", format!("터널용 내 PC 포트를 열지 못했습니다: {e}")))?;
    let lport = listener.local_addr().map(|a| a.port()).map_err(|e| ssh::err("OTHER", e.to_string()))?;
    let stats = Arc::new(Stats::default());
    let task = serve_local(listener, Via::Link(link.clone()), host.to_string(), port, stats.clone());
    Ok(DbTunnel { port: lport, stats, link, task })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    async fn ask(req: &[u8]) -> (Result<(String, u16), String>, Vec<u8>) {
        let (mut a, mut b) = tokio::io::duplex(256);
        a.write_all(req).await.unwrap();
        let r = socks_request(&mut b).await;
        drop(b);
        let mut back = Vec::new();
        let _ = a.read_to_end(&mut back).await;
        (r, back)
    }

    #[tokio::test]
    async fn socks_parses_connect() {
        // 이름으로
        let mut q = vec![5, 1, 0, 5, 1, 0, 3, 2];
        q.extend_from_slice(b"db");
        q.extend_from_slice(&5432u16.to_be_bytes());
        let (r, back) = ask(&q).await;
        assert_eq!(r.unwrap(), ("db".to_string(), 5432));
        assert_eq!(back, vec![5, 0]);
        // IPv4
        let (r, _) = ask(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 80]).await;
        assert_eq!(r.unwrap(), ("10.0.0.7".to_string(), 80));
        // 인증 방식만 내밀면 거절(0xff)
        let (r, back) = ask(&[5, 1, 2]).await;
        assert!(r.is_err());
        assert_eq!(back, vec![5, 0xff]);
        // BIND 는 7
        let (r, back) = ask(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 1]).await;
        assert!(r.is_err());
        assert_eq!(back[2..4], [5, 7]);
        // SOCKS4 는 거절
        assert!(ask(&[4, 1]).await.0.is_err());
    }

    #[test]
    fn short_labels() {
        let f = |kind: &str| Forward {
            id: Some(1),
            profile_id: 1,
            kind: kind.into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 3306,
            target_host: Some("db".into()),
            target_port: Some(3306),
            auto_start: false,
            label: None,
        };
        assert_eq!(short(&f("local"), 3306), "3306→db:3306");
        assert_eq!(short(&f("remote"), 18080), "서버 18080→db:3306");
        assert_eq!(short(&f("dynamic"), 1080), "SOCKS 1080");
    }

    #[test]
    fn bind_errors_are_plain() {
        let e = std::io::Error::from(std::io::ErrorKind::AddrInUse);
        assert!(bind_err("127.0.0.1", 3306, &e).contains("이미 다른 프로그램"));
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(bind_err("127.0.0.1", 80, &e).contains("권한"));
    }

    /// 실제 sshd 로 — RB_TUN_SSH=호스트:포트, RB_TUN_KEY=개인키 파일(사용자 rbtest) 일 때만(cargo test -- --ignored)
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_forwards_local_dynamic_remote() {
        let (store, dir, pid, aid) = live_server("fwd").await;
        let conns = SshConns::default();
        let req = ssh::tunnel_req(&store, pid, Some(aid), None, None, false).unwrap();
        let ok = ssh::connect(&store, &conns, req).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        let cid = ssh_id(&ok);
        let c = conns.get(cid).unwrap();
        let rule = |id: i64, kind: &str, port: u16, th: &str, tp: u16| Forward {
            id: Some(id),
            profile_id: pid,
            kind: kind.into(),
            bind_host: "127.0.0.1".into(),
            bind_port: port,
            target_host: Some(th.into()),
            target_port: Some(tp),
            auto_start: false,
            label: None,
        };
        let port_of = |id: i64| status_of(Some(cid), None).active.iter().find(|a| a.id == id).map(|a| a.port).unwrap();

        // 1) 로컬: 내 PC 빈 포트 → 서버에서 본 127.0.0.1:22 (sshd 인사말이 와야 한다)
        start(&c, cid, rule(9001, "local", 0, "127.0.0.1", 22)).await.unwrap();
        let lp = port_of(9001);
        let mut s = TcpStream::connect(("127.0.0.1", lp)).await.unwrap();
        let mut buf = [0u8; 7];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"SSH-2.0");
        drop(s);
        println!("로컬 {lp} → 127.0.0.1:22 인사말 받음");

        // 2) 같은 포트를 또 열면 쉬운 말 오류
        let e = start(&c, cid, rule(9002, "local", lp, "127.0.0.1", 22)).await.err().unwrap();
        println!("포트 충돌 → {e}");
        assert!(e.contains("이미 다른 프로그램"));

        // 3) SOCKS5: 이름으로 localhost:22
        start(&c, cid, Forward { target_host: None, target_port: None, ..rule(9003, "dynamic", 0, "", 0) }).await.unwrap();
        let sp = port_of(9003);
        let mut s = TcpStream::connect(("127.0.0.1", sp)).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut hello = [0u8; 2];
        s.read_exact(&mut hello).await.unwrap();
        assert_eq!(hello, [5, 0]);
        let mut q = vec![5, 1, 0, 3, 9];
        q.extend_from_slice(b"localhost");
        q.extend_from_slice(&22u16.to_be_bytes());
        s.write_all(&q).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        assert_eq!(rep[1], 0, "SOCKS 성공 답");
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"SSH-2.0");
        drop(s);
        println!("SOCKS {sp} → localhost:22 인사말 받음");

        // 4) 원격: 서버 빈 포트 → 내 PC 의 작은 서버(hello)
        let mine = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let mp = mine.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = mine.accept().await {
                let _ = s.write_all(b"hello").await;
            }
        });
        start(&c, cid, rule(9004, "remote", 0, "127.0.0.1", mp)).await.unwrap();
        let rp = port_of(9004);
        let mut ch = c.handle_ref().channel_open_session().await.unwrap();
        ch.exec(true, format!("bash -c 'exec 3<>/dev/tcp/127.0.0.1/{rp}; head -c 5 <&3'")).await.unwrap();
        let mut out = Vec::new();
        while let Some(m) = ch.wait().await {
            if let russh::ChannelMsg::Data { data } = m {
                out.extend_from_slice(&data);
            }
        }
        assert_eq!(out, b"hello");
        println!("원격 서버 {rp} → 내 PC {mp} 'hello' 받음");

        // 5) 숫자
        tokio::time::sleep(Duration::from_millis(300)).await;
        for a in status_of(Some(cid), None).active {
            println!("  {} 연결 {}/{} ↑{} ↓{} 오류 {:?}", a.short, a.open, a.total, a.up, a.down, a.error);
            assert!(a.total >= 1 && a.up + a.down > 0);
        }

        // 6) tmux 없는 서버
        println!("tmux 있음? {}", ssh::tmux_available(&c).await);

        // 7) 연결을 닫으면 모두 꺼진다
        stop_conn(cid).await;
        assert!(status_of(Some(cid), None).active.is_empty());
        assert!(TcpStream::connect(("127.0.0.1", lp)).await.is_err(), "듣던 포트가 닫혀야 한다");
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn ssh_id(ok: &ssh::ConnectOk) -> u32 {
        serde_json::to_value(ok).unwrap()["connId"].as_u64().unwrap() as u32
    }

    /// 시험용 서버 — 키 계정 하나, 호스트 키는 터널 요청으로 확인·고정
    pub(crate) async fn live_server(tag: &str) -> (Store, std::path::PathBuf, i64, i64) {
        let spec = std::env::var("RB_TUN_SSH").expect("RB_TUN_SSH=host:port");
        let key = std::env::var("RB_TUN_KEY").expect("RB_TUN_KEY");
        let (host, port) = spec.split_once(':').unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-tun-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone(), false).unwrap();
        let pid = crate::store::profile_save_core(&store, host, port.parse().unwrap(), "rbtest");
        let mut a = store.default_account(pid).unwrap();
        a.auth = "key".into();
        a.key_path = Some(key);
        let aid = store.account_save(&a).unwrap();
        // 처음엔 지문을 묻고, 확인하면 고정
        let req = ssh::tunnel_req(&store, pid, Some(aid), None, None, false).unwrap();
        let e = ssh::open_authed(&store, &req).await.err().expect("처음엔 지문 확인");
        let (code, _, fp, ..) = e.parts();
        assert_eq!(code, "HOSTKEY_UNKNOWN");
        let fp = fp.unwrap().to_string();
        let req = ssh::tunnel_req(&store, pid, Some(aid), None, Some(fp), false).unwrap();
        ssh::open_authed(&store, &req).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        (store, dir, pid, aid)
    }

    pub(crate) fn link_count() -> usize {
        LINKS.lock().unwrap().values().filter(|w| w.strong_count() > 0).count()
    }

    /// 실제로 두 번 열면 두 번째는 "이미 쓰는 중"
    #[tokio::test]
    async fn port_conflict_message() {
        let a = listen("127.0.0.1", 0).await.unwrap();
        let p = a.local_addr().unwrap().port();
        let e = listen("127.0.0.1", p).await.err().unwrap();
        assert!(e.contains(&p.to_string()), "{e}");
    }
}
