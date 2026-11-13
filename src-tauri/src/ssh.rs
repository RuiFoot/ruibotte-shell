//! SSH 접속 — russh 클라이언트 하나에 터미널 채널 여러 개 + SFTP 채널 하나.
//! - 호스트 키: 처음엔 지문을 보여 주고 사용자가 확인하면 고정(TOFU). 바뀌면 인증 전에 끊는다.
//! - 구형 호환 단계(off·rsa·sha1·weakest): 그 연결에만 오래된 알고리즘을 더한다.
//!   협상이 실패하면 서버가 내민 목록으로 가장 낮은 단계를 제안한다.
//! - 비밀(암호·개인키 암호)은 접속에 성공한 뒤에만, 사용자가 원할 때 OS 자격 증명 저장소에 넣는다.

// 오류는 화면에 그대로 넘기는 드문 경로라 크기를 줄이지 않는다
#![allow(clippy::result_large_err)]

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{cipher, kex, mac, ChannelMsg, ChannelWriteHalf, Disconnect, Preferred};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::secrets;
use crate::store::{Account, PinnedKey, Store};
use crate::textcodec::{self, TextMeta};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
/// 인증 전체 상한 — 서버가 keyboard-interactive 로 끝없이 묻거나 에이전트가 답하지 않아도 여기서 끊는다
const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
/// 편집기로 여는 파일 상한 — 넘으면 읽기만 권한다
const MAX_TEXT: u64 = 8 * 1024 * 1024;

// ── 오류 ─────────────────────────────

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshError {
    /// HOSTKEY_UNKNOWN | HOSTKEY_MISMATCH | NEGOTIATION | AUTH_FAILED | NEED_SECRET | NETWORK | CLOSED | SFTP | OTHER
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    theirs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggest: Option<&'static str>,
    /// 쉬운 원인 설명(방화벽·사내망 등)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hint: Option<String>,
    /// 어느 경로에서 난 오류인지(지문 확인 뒤 같은 경로로 다시)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) route_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) route_label: Option<String>,
    /// 앞서 실패·건너뛴 경로들
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attempts: Option<Vec<String>>,
}

impl SshError {
    pub(crate) fn message_owned(self) -> String {
        self.message
    }
    pub(crate) fn message_ref(&self) -> &str {
        &self.message
    }
    pub(crate) fn code_is(&self, code: &str) -> bool {
        self.code == code
    }
}

pub(crate) fn err(code: &'static str, message: impl Into<String>) -> SshError {
    SshError { code, message: message.into(), ..Default::default() }
}

pub(crate) type R<T> = Result<T, SshError>;

/// 서버가 내민 목록에서 켜야 할 가장 낮은 단계
fn suggest_level(theirs: &[String]) -> Option<&'static str> {
    let has = |n: &str| theirs.iter().any(|t| t == n);
    if has("ssh-rsa") && theirs.iter().all(|t| t == "ssh-rsa" || t == "ssh-dss") {
        return Some("rsa");
    }
    let sha1 = has("diffie-hellman-group14-sha1")
        || has("diffie-hellman-group-exchange-sha1")
        || has("hmac-sha1")
        || theirs.iter().any(|t| t.starts_with("aes") && t.ends_with("-cbc"));
    if sha1 {
        return Some("sha1");
    }
    if has("diffie-hellman-group1-sha1") || has("ssh-dss") || has("3des-cbc") {
        return Some("weakest");
    }
    None
}

pub(crate) fn map_russh(e: russh::Error) -> SshError {
    match e {
        russh::Error::NoCommonAlgo { kind, ours: _, theirs } => {
            let suggest = suggest_level(&theirs);
            let name = |l: &str| match l {
                "rsa" => "RSA",
                "sha1" => "SHA1",
                _ => "최후",
            };
            SshError {
                code: "NEGOTIATION",
                message: format!("서버와 맞는 {kind:?} 알고리즘이 없습니다"),
                hint: Some(match suggest {
                    Some(l) => format!("오래된 서버라 구형 알고리즘이 필요합니다 — 서버 설정의 구형 호환을 '{}' 단계로 올리세요.", name(l)),
                    None => "켤 수 있는 구형 호환 단계로도 맞지 않습니다 — 서버의 SSH 설정을 확인하세요.".into(),
                }),
                kind: Some(format!("{kind:?}")),
                suggest,
                theirs: Some(theirs),
                ..Default::default()
            }
        }
        russh::Error::IO(io) => err("NETWORK", format!("연결하지 못했습니다: {io}")),
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout | russh::Error::InactivityTimeout => {
            err("NETWORK", "응답이 없습니다")
        }
        russh::Error::Disconnect | russh::Error::HUP => err("CLOSED", "연결이 끊겼습니다"),
        other => err("OTHER", other.to_string()),
    }
}

/// 채널을 못 연 오류 → 사람 말(서버의 세션 수 제한·셸 금지 계정 등)
pub(crate) fn open_err(e: russh::Error) -> SshError {
    match e {
        russh::Error::ChannelOpenFailure(why) => {
            use russh::ChannelOpenFailure as F;
            let why = match why {
                F::AdministrativelyProhibited => "관리자 설정으로 막힘".to_string(),
                F::ResourceShortage => "서버 자원 부족".to_string(),
                F::ConnectFailed => "연결 실패".to_string(),
                F::UnknownChannelType => "지원하지 않는 채널".to_string(),
                F::Other { code, reason } => format!("{code} {reason}"),
            };
            let mut x = err("OTHER", format!("서버가 새 채널을 열어 주지 않았습니다({why})"));
            x.hint = Some("한 연결에 열 수 있는 세션 수(sshd 의 MaxSessions)를 넘었거나, 이 계정은 명령 실행이 막혀 있을 수 있습니다 — 터미널·탭을 몇 개 닫고 다시 하세요.".into());
            x
        }
        other => map_russh(other),
    }
}

// ── 구형 호환 단계 ───────────────────

fn preferred(level: &str) -> Preferred {
    let base = Preferred::default();
    let mut key: Vec<Algorithm> = base.key.to_vec();
    let mut kexes: Vec<kex::Name> = base.kex.to_vec();
    let mut ciphers: Vec<cipher::Name> = base.cipher.to_vec();
    let mut macs: Vec<mac::Name> = base.mac.to_vec();
    if level == "off" {
        // 기본은 SHA-1 서명 ssh-rsa 도 뺀다(서버마다 켜는 것)
        key.retain(|a| *a != Algorithm::Rsa { hash: None });
    }
    if level == "sha1" || level == "weakest" {
        kexes.extend([kex::DH_G14_SHA1, kex::DH_GEX_SHA1]);
        ciphers.extend([cipher::AES_128_CBC, cipher::AES_192_CBC, cipher::AES_256_CBC]);
        macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    }
    if level == "weakest" {
        kexes.push(kex::DH_G1_SHA1);
        ciphers.push(cipher::TRIPLE_DES_CBC);
        key.push(Algorithm::Dsa);
    }
    Preferred {
        kex: Cow::Owned(kexes),
        key: Cow::Owned(key),
        cipher: Cow::Owned(ciphers),
        mac: Cow::Owned(macs),
        ..base
    }
}

// ── 클라이언트 처리기(호스트 키) ─────

pub(crate) struct Client {
    pinned: Option<PinnedKey>,
    trust: Option<String>,
    /// 이 주소에 고정한 키가 없을 때 — 같은 서버의 다른 경로에서 고정한 지문들(같으면 믿는다)
    also: Vec<String>,
    seen: Arc<Mutex<Option<PinnedKey>>>,
    /// 원격 포워딩(서버 포트 → 내 PC 쪽 대상) — 서버가 그 포트로 들어온 연결을 채널로 열어 준다
    remote: crate::tunnel::RemoteMap,
}

impl Client {
    /// 진단용 — 고정 키·다른 경로 지문으로만 판정(묻지 않는다)
    pub(crate) fn probe(pinned: Option<PinnedKey>, also: Vec<String>, seen: Arc<Mutex<Option<PinnedKey>>>) -> Self {
        Client { pinned, trust: None, also, seen, remote: Default::default() }
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote.lock().unwrap().get(&connected_port).cloned();
        match target {
            Some(t) => {
                reply.accept().await;
                crate::tunnel::serve_remote(channel, t);
            }
            None => {
                let _ = connected_address;
                reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            }
        }
        Ok(())
    }

    async fn check_server_key(&mut self, server: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = server else {
            return Ok(false); // 인증서 호스트 키는 다음 판
        };
        let seen = PinnedKey {
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: key.to_openssh().unwrap_or_default(),
        };
        let ok = match (&self.pinned, &self.trust) {
            (_, Some(t)) => *t == seen.fingerprint,
            (Some(p), None) => p.fingerprint == seen.fingerprint,
            (None, None) => self.also.contains(&seen.fingerprint),
        };
        *self.seen.lock().unwrap() = Some(seen);
        Ok(ok)
    }
}

// ── 연결 상태 ────────────────────────

pub(crate) struct Conn {
    handle: Handle<Client>,
    /// 점프 단계 연결들 — 대상 연결이 살아 있는 동안 함께 둔다
    _jump: Vec<Handle<Client>>,
    /// 붙은 경로
    route: RouteUsed,
    pub(crate) sftp: SftpSession,
    /// 터미널 채널 → 입력 큐. 셸마다 쓰기 전용 작업이 차례대로 보낸다(키 입력 순서 보장, 한 셸이 막혀도 다른 셸은 그대로)
    shells: Mutex<HashMap<u32, ShellIo>>,
    next_shell: AtomicU32,
    /// 이 연결의 계정(sudo 암호 키)·sudo 설정 — 접속할 때의 계정 설정을 따른다
    pub(crate) account_id: Option<i64>,
    pub(crate) sudo: Mutex<SudoCfg>,
    /// "물어보기"로 넣은 sudo 암호 — 이 연결이 살아 있는 동안만(메모리)
    pub(crate) sudo_pw: Mutex<Option<String>>,
    /// 이 연결의 서버(프로필) — 포워딩 규칙·tmux 설정
    pub(crate) profile_id: Option<i64>,
    /// 새 터미널을 tmux 세션(rbs-번호)으로
    tmux: bool,
    /// 서버에 tmux 가 있는지(0 모름·1 있음·2 없음)
    tmux_ok: std::sync::atomic::AtomicU8,
    /// 로그인 셸 이름(bash·zsh·…) — 셸 통합을 걸지 정한다. 처음 셸을 열 때 한 번 묻는다
    login_shell: tokio::sync::OnceCell<String>,
    /// 터미널 채널 → 붙은 tmux 세션 번호(빈 번호부터 다시 써서 다시 연결해도 같은 이름)
    tmux_used: Mutex<HashMap<u32, u32>>,
    /// 원격 포워딩 대상(처리기와 같은 것)
    pub(crate) remote: crate::tunnel::RemoteMap,
}

/// 계정의 sudo 설정 — mode: off·ask·saved·nopasswd, user: sudo -u 대상
#[derive(Clone, Debug)]
pub(crate) struct SudoCfg {
    pub(crate) mode: String,
    pub(crate) user: String,
}

impl SudoCfg {
    fn of(a: Option<&Account>) -> Self {
        match a {
            Some(a) => SudoCfg { mode: a.sudo.clone(), user: a.sudo_user.clone() },
            // 계정 없이 붙은 연결(시험 등)은 예전처럼 물어본다
            None => SudoCfg { mode: "ask".into(), user: "root".into() },
        }
    }
}

#[derive(Default)]
pub struct SshConns {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Arc<Conn>>>,
}

impl Conn {
    pub(crate) fn handle_ref(&self) -> &Handle<Client> {
        &self.handle
    }
}

impl SshConns {
    pub(crate) fn get(&self, id: u32) -> R<Arc<Conn>> {
        self.map.lock().unwrap().get(&id).cloned().ok_or_else(|| err("CLOSED", "연결이 닫혔습니다"))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectReq {
    profile_id: Option<i64>,
    /// 접속할 계정 — 주면 그 계정의 사용자명·인증 방식·키·저장한 비밀을 쓴다(없으면 서버의 기본 계정 비밀)
    #[serde(default)]
    account_id: Option<i64>,
    host: String,
    port: u16,
    username: String,
    /// "password" | "key" | "agent"
    auth: String,
    key_path: Option<String>,
    /// 암호(auth=password) 또는 개인키 암호(auth=key). 비우면 저장된 비밀을 쓴다
    secret: Option<String>,
    legacy: String,
    /// 사용자가 화면에서 확인한 지문 — 고정 키가 없거나 바뀌었을 때만
    trust_fingerprint: Option<String>,
    #[serde(default)]
    save_secret: bool,
    /// 거쳐 갈 SSH 프로필(점프 호스트) — 그 프로필의 호스트 키가 고정돼 있고 비밀이 저장돼 있어야 한다
    #[serde(default)]
    jump_id: Option<i64>,
    /// 이 경로로만(지문 확인 뒤 같은 경로로 다시 붙을 때)
    #[serde(default)]
    pub(crate) route_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOk {
    conn_id: u32,
    home: String,
    fingerprint: String,
    algorithm: String,
    newly_pinned: bool,
    used_saved_secret: bool,
    /// 쓴 계정·사용자명·sudo 설정(작업대가 따른다)
    account_id: Option<i64>,
    username: String,
    sudo: String,
    sudo_user: String,
    /// 붙은 경로
    route: RouteUsed,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Closed {
    conn: u32,
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, store: State<'_, Store>, conns: State<'_, SshConns>, req: ConnectReq) -> R<ConnectOk> {
    // 계정으로 접속 — 사용자명·인증 방식·키는 저장한 계정 값으로
    let mut req = req;
    if let Some(aid) = req.account_id {
        let a = store.account(aid).map_err(|e| err("OTHER", e))?;
        req.username = a.username;
        req.auth = a.auth;
        req.key_path = a.key_path;
        req.profile_id = Some(a.profile_id);
    }
    let ok = connect(&store, &conns, req).await?;
    // 끊김 감시 — 서버가 끊거나 네트워크가 끊기면(keepalive 30초×4) 화면에 알린다. 이 연결의 포워딩도 정리
    let id = ok.conn_id;
    let c = conns.get(id)?;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if Arc::strong_count(&c) <= 1 {
                break; // 화면이 연결을 닫음
            }
            if c.handle.is_closed() {
                crate::tunnel::stop_conn(id).await;
                crate::sync::stop_conn(&app, id);
                let _ = app.emit("ssh-closed", Closed { conn: id });
                let _ = app.emit("forward-changed", Closed { conn: id });
                break;
            }
        }
    });
    // 이 서버의 "접속하면 켜기" 규칙
    if let Ok(c) = conns.get(id) {
        if let Some(pid) = c.profile_id {
            let rules = store.forwards(pid).unwrap_or_default();
            crate::tunnel::auto_start(&c, id, rules.into_iter().filter(|f| f.auto_start).collect()).await;
        }
    }
    Ok(ok)
}

/// 붙어서 인증까지 끝낸 SSH 세션(SFTP 없이) — 작업대 연결과 DB 터널이 함께 쓴다
pub(crate) struct Authed {
    pub(crate) handle: Handle<Client>,
    pub(crate) jump: Vec<Handle<Client>>,
    seen_key: PinnedKey,
    newly_pinned: bool,
    used_saved: bool,
    account: Option<Account>,
    remote: crate::tunnel::RemoteMap,
    pub(crate) route: RouteUsed,
}

impl SshError {
    /// DB 터널 오류로 옮길 때 — (코드, 글, 지문, 알고리즘, 고정된 지문)
    pub(crate) fn parts(&self) -> (&'static str, &str, Option<&str>, Option<&str>, Option<&str>) {
        (self.code, &self.message, self.fingerprint.as_deref(), self.algorithm.as_deref(), self.pinned_fingerprint.as_deref())
    }
}

/// DB 터널용 접속 요청 — 거칠 SSH 서버(프로필)와 계정(없으면 기본, 지워졌으면 기본)으로.
/// secret 을 비우면 그 계정에 저장한 비밀을 쓴다
pub(crate) fn tunnel_req(store: &Store, profile_id: i64, account_id: Option<i64>, secret: Option<String>, trust: Option<String>, save: bool) -> R<ConnectReq> {
    let p = store.profile(profile_id).map_err(|_| err("OTHER", "거칠 SSH 서버가 없습니다. 연결 설정에서 다시 고르세요."))?;
    if p.kind != "ssh" {
        return Err(err("OTHER", "거칠 서버가 SSH 서버가 아닙니다"));
    }
    let a = match account_id.and_then(|id| store.account(id).ok()).filter(|a| a.profile_id == profile_id) {
        Some(a) => a,
        None => store.default_account(profile_id).map_err(|e| err("OTHER", e))?,
    };
    Ok(ConnectReq {
        profile_id: Some(profile_id),
        account_id: a.id,
        host: p.host,
        port: p.port,
        username: a.username,
        auth: a.auth,
        key_path: a.key_path,
        secret,
        legacy: p.legacy,
        trust_fingerprint: trust,
        save_secret: save,
        jump_id: p.jump_id,
        route_id: None,
    })
}

/// 요청의 계정 id(터널 SSH 연결을 나눠 쓰는 열쇠)
pub(crate) fn req_account(req: &ConnectReq) -> Option<i64> {
    req.account_id
}

pub(crate) async fn connect(store: &Store, conns: &SshConns, req: ConnectReq) -> R<ConnectOk> {
    let a = open_authed(store, &req).await?;
    let Authed { handle, jump, seen_key, newly_pinned, used_saved, account, remote, route } = a;
    let aid = account.as_ref().and_then(|a| a.id);
    let ch = handle.channel_open_session().await.map_err(map_russh)?;
    ch.request_subsystem(true, "sftp").await.map_err(map_russh)?;
    let sftp = SftpSession::new(ch.into_stream()).await.map_err(|e| err("SFTP", format!("SFTP 를 열지 못했습니다: {e}")))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());

    let profile_id = account.as_ref().map(|a| a.profile_id).or(req.profile_id);
    let tmux = profile_id.and_then(|id| store.profile(id).ok()).map(|p| p.tmux).unwrap_or(false);
    let id = conns.next.fetch_add(1, Ordering::Relaxed) + 1;
    conns.map.lock().unwrap().insert(
        id,
        Arc::new(Conn {
            handle,
            _jump: jump,
            sftp,
            shells: Default::default(),
            next_shell: AtomicU32::new(0),
            account_id: aid,
            sudo: Mutex::new(SudoCfg::of(account.as_ref())),
            sudo_pw: Mutex::new(None),
            profile_id,
            tmux,
            tmux_ok: Default::default(),
            login_shell: Default::default(),
            tmux_used: Default::default(),
            remote,
            route: route.clone(),
        }),
    );
    let sudo = SudoCfg::of(account.as_ref());
    Ok(ConnectOk {
        conn_id: id,
        home,
        fingerprint: seen_key.fingerprint,
        algorithm: seen_key.algorithm,
        newly_pinned,
        used_saved_secret: used_saved,
        account_id: aid,
        username: req.username.clone(),
        sudo: sudo.mode,
        sudo_user: sudo.user,
        route,
    })
}

/// 열린 연결이 붙은 경로(상태 줄)
#[tauri::command]
pub fn ssh_conn_route(conns: State<'_, SshConns>, conn: u32) -> Option<RouteUsed> {
    conns.get(conn).ok().map(|c| c.route.clone())
}

/// 어느 경로로 붙었는지 — 탭·상태 줄·서버 카드가 보인다
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteUsed {
    pub(crate) id: Option<i64>,
    pub(crate) label: String,
    pub(crate) summary: String,
    /// 이 서버에 저장한 경로 수(1 이하면 화면에 굳이 보이지 않는다)
    pub(crate) total: usize,
    /// 앞 경로가 실패했거나 건너뛰어 이 경로로 왔을 때
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// 경로마다 기다릴 시간(경로가 여럿일 때) — 설정 "ssh.routeTimeoutSec", 기본 4초
pub(crate) fn route_timeout(store: &Store) -> Duration {
    let s = store.setting("ssh.routeTimeoutSec").and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(4);
    Duration::from_secs(s.clamp(2, 30))
}

pub(crate) fn ssh_config(level: &str) -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: preferred(level),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        nodelay: true,
        ..Default::default()
    })
}

/// 전송로를 못 연 오류 → 화면 오류(쉬운 설명을 hint 로)
pub(crate) fn leg_err(e: crate::route::LegErr, prefix: Option<&str>) -> SshError {
    SshError {
        code: "NETWORK",
        message: match prefix {
            Some(p) => format!("{p}: {}", e.message),
            None => e.message,
        },
        hint: e.hint,
        ..Default::default()
    }
}

/// 경로 하나로 대상 서버의 SSH 인사·키 교환까지 — 인증 전
pub(crate) struct Linked {
    pub(crate) handle: Handle<Client>,
    pub(crate) jumps: Vec<Handle<Client>>,
    pub(crate) seen: PinnedKey,
    pub(crate) pinned: Option<PinnedKey>,
    remote: crate::tunnel::RemoteMap,
}

/// 경로의 점프 단계를 차례로 붙이고(각 단계는 그 서버의 고정 키·저장 비밀), 마지막 단계에서 대상까지 길을 연다.
/// 실패하면 (오류, 다음 경로로 넘어가도 되는지)
#[allow(clippy::too_many_arguments)]
pub(crate) async fn link_route(
    store: &Store,
    target_profile: Option<i64>,
    username: &str,
    legacy: &str,
    r: &crate::store::Route,
    trust: Option<&str>,
    also: &[String],
    limit: Duration,
) -> Result<Linked, (SshError, bool)> {
    use crate::route::{first_leg, ProxyAuth};
    let fall = |e: SshError| (e, true);
    let mut seen_hops = std::collections::HashSet::new();
    for h in &r.jumps {
        if Some(h.profile_id) == target_profile || !seen_hops.insert(h.profile_id) {
            return Err(fall(err("OTHER", "점프 단계가 돌고 돕니다(같은 서버를 두 번 거침) — 경로 설정을 고치세요")));
        }
    }
    if r.jumps.len() > 5 {
        return Err(fall(err("OTHER", "점프는 다섯 단계까지입니다")));
    }
    let proxy_auth = ProxyAuth {
        user: r.proxy_user.clone(),
        pass: r.id.filter(|_| r.proxy_secret_saved).and_then(|id| secrets::get(&crate::store::route_proxy_key(id))),
    };
    let mut hops: Vec<Handle<Client>> = Vec::new();
    for (i, hop) in r.jumps.iter().enumerate() {
        let p = store.profile(hop.profile_id).map_err(|_| fall(err("OTHER", format!("점프 {} 단계의 서버가 지워졌습니다", i + 1))))?;
        let a = hop
            .account_id
            .and_then(|id| store.account(id).ok())
            .filter(|a| a.profile_id == hop.profile_id)
            .or_else(|| store.default_account(hop.profile_id).ok())
            .ok_or_else(|| fall(err("OTHER", format!("점프 서버 {} 에 계정이 없습니다", p.name))))?;
        let io: crate::route::BoxIo = match hops.last() {
            None => first_leg(r, &p.host, p.port, &a.username, &proxy_auth, limit)
                .await
                .map_err(|e| fall(leg_err(e, Some(&format!("점프 서버 {}", p.name)))))?,
            Some(prev) => {
                let ch = tokio::time::timeout(limit, prev.channel_open_direct_tcpip(p.host.clone(), p.port as u32, "127.0.0.1", 0))
                    .await
                    .map_err(|_| fall(err("NETWORK", format!("앞 점프 서버에서 {} 로 가는 길이 제때 열리지 않았습니다", p.name))))?
                    .map_err(|e| fall(err("NETWORK", format!("앞 점프 서버에서 {}({}:{}) 로 가는 길을 열지 못했습니다: {e}", p.name, p.host, p.port))))?;
                Box::new(ch.into_stream())
            }
        };
        let h = hop_session(store, &p, &a, io, limit).await.map_err(fall)?;
        hops.push(h);
    }

    // 대상 — 이 경로 주소에 고정한 키, 없으면 같은 서버 다른 경로에서 고정한 키·가져온 known_hosts 의 키와 같으면 믿는다
    let pinned = store.host_key(&r.host, r.port);
    let known = if pinned.is_none() { crate::importer::known_keys(store, &r.host, r.port) } else { Vec::new() };
    let revoked: Vec<String> = known.iter().filter(|k| k.revoked).map(|k| k.fingerprint.clone()).collect();
    let mut also: Vec<String> = also.to_vec();
    also.extend(known.iter().filter(|k| !k.revoked).map(|k| k.fingerprint.clone()));
    also.retain(|f| !revoked.contains(f));
    let also = &also[..];
    let seen = Arc::new(Mutex::new(None));
    let remote = crate::tunnel::RemoteMap::default();
    let handler = Client {
        pinned: pinned.clone(),
        trust: trust.map(str::to_string),
        also: if pinned.is_none() { also.to_vec() } else { Vec::new() },
        seen: seen.clone(),
        remote: remote.clone(),
    };
    let config = ssh_config(legacy);
    let connected = match hops.last() {
        Some(j) => {
            let ch = tokio::time::timeout(limit, j.channel_open_direct_tcpip(r.host.clone(), r.port as u32, "127.0.0.1", 0))
                .await
                .map_err(|_| fall(err("NETWORK", format!("점프 서버에서 {}:{} 로 가는 길이 제때 열리지 않았습니다", r.host, r.port))))?
                .map_err(|e| {
                    let mut x = err("NETWORK", format!("점프 서버에서 {}:{} 로 가는 길을 열지 못했습니다: {e}", r.host, r.port));
                    x.hint = Some("점프 서버에서 그 주소·포트가 닿는지, 점프 서버 sshd 가 포워딩(AllowTcpForwarding)을 허용하는지 확인하세요.".into());
                    fall(x)
                })?;
            tokio::time::timeout(limit, client::connect_stream(config, ch.into_stream(), handler)).await
        }
        None => {
            let io = first_leg(r, &r.host, r.port, username, &proxy_auth, limit).await.map_err(|e| fall(leg_err(e, None)))?;
            tokio::time::timeout(limit, client::connect_stream(config, io, handler)).await
        }
    }
    .map_err(|_| {
        let mut x = err("NETWORK", format!("{}:{} 에서 {}초 안에 SSH 인사가 오지 않았습니다", r.host, r.port, limit.as_secs()));
        x.hint = Some("연결은 됐지만 SSH 서버가 답하지 않습니다 — 중간 장비가 막았거나, 프록시 명령이 제대로 이어 주지 않을 수 있습니다.".into());
        fall(x)
    })?;
    let handle = match connected {
        Ok(h) => h,
        Err(e) => {
            // 호스트 키를 거절한 경우: 모르는 키인지 바뀐 키인지 알려 준다(다음 경로로 넘어가지 않는다)
            if let Some(s) = seen.lock().unwrap().clone() {
                let accepted = trust == Some(s.fingerprint.as_str())
                    || pinned.as_ref().map(|p| p.fingerprint == s.fingerprint).unwrap_or(false)
                    || (pinned.is_none() && also.contains(&s.fingerprint));
                if !accepted {
                    // 가져온 known_hosts 에 이 서버 키가 적혀 있는데 맞지 않으면(종류가 달라도) "바뀜"으로 — 다른 종류 키를 내밀어
                    // 첫 접속 확인으로 넘어가는 길을 막는다(같은 종류를 먼저 고른다). 폐기 표시된 이 키도 바뀜으로
                    let known_other = pinned
                        .is_none()
                        .then(|| {
                            known
                                .iter()
                                .find(|k| k.revoked && k.fingerprint == s.fingerprint)
                                .or_else(|| known.iter().find(|k| !k.revoked && k.algorithm == s.algorithm))
                                .or_else(|| known.iter().find(|k| !k.revoked))
                        })
                        .flatten();
                    let mismatch = pinned.is_some() || known_other.is_some();
                    return Err((
                        SshError {
                            code: if mismatch { "HOSTKEY_MISMATCH" } else { "HOSTKEY_UNKNOWN" },
                            message: match (&pinned, known_other) {
                                (Some(_), _) => "서버의 호스트 키가 고정한 키와 다릅니다. 서버를 다시 설치했거나 다른 서버로 연결되고 있을 수 있습니다.".into(),
                                (None, Some(k)) if k.revoked => "서버가 내민 호스트 키가 가져온 known_hosts 에서 폐기(@revoked)된 키입니다. 다른 서버로 연결되고 있을 수 있습니다.".into(),
                                (None, Some(k)) if k.algorithm == s.algorithm => "서버의 호스트 키가 가져온 known_hosts 에 적힌 키와 다릅니다. 서버를 다시 설치했거나 다른 서버로 연결되고 있을 수 있습니다.".into(),
                                (None, Some(k)) => format!(
                                    "가져온 known_hosts 에는 이 서버의 다른 종류 키({})만 적혀 있는데 서버가 {} 키를 내밀었습니다. 서버 설정이 바뀌었거나 다른 서버로 연결되고 있을 수 있습니다 — 지문을 확인하세요.",
                                    k.algorithm, s.algorithm
                                ),
                                (None, None) => "처음 접속하는 서버입니다. 지문을 확인하세요.".into(),
                            },
                            fingerprint: Some(s.fingerprint),
                            algorithm: Some(s.algorithm),
                            pinned_fingerprint: pinned.map(|p| p.fingerprint).or_else(|| known_other.map(|k| k.fingerprint.clone())),
                            ..Default::default()
                        },
                        false,
                    ));
                }
            }
            let x = map_russh(e);
            let next = matches!(x.code, "NETWORK" | "CLOSED");
            return Err((x, next));
        }
    };
    let seen_key = seen.lock().unwrap().clone().ok_or_else(|| (err("OTHER", "호스트 키를 받지 못했습니다"), false))?;
    Ok(Linked { handle, jumps: hops, seen: seen_key, pinned, remote })
}

/// 붙고(경로를 차례로 시도하며) 호스트 키를 확인하고 인증한다. 처음 키면 고정, 원하면 비밀 저장
pub(crate) async fn open_authed(store: &Store, req: &ConnectReq) -> R<Authed> {
    use crate::route::{plan, route_name, route_summary};
    // 저장한 경로 — 요청 주소가 첫 경로와 같을 때만(설정 화면에서 고치는 중인 주소로 시험할 때는 그 주소 하나로)
    let saved = req.profile_id.map(|pid| store.routes(pid).unwrap_or_default()).unwrap_or_default();
    let use_saved = saved.first().is_some_and(|r| r.host.eq_ignore_ascii_case(req.host.trim()) && r.port == req.port);
    let (mut cands, mut skipped) = if use_saved {
        plan(saved.clone()).await
    } else {
        (vec![crate::route::adhoc(req.profile_id.unwrap_or(0), req.host.trim(), req.port, req.jump_id)], Vec::new())
    };
    if let Some(rid) = req.route_id {
        let mut all = cands.iter().chain(skipped.iter().map(|(r, _)| r));
        if let Some(r) = all.find(|r| r.id == Some(rid)).cloned() {
            cands = vec![r];
            skipped.clear();
        }
    }
    let total = if use_saved { saved.len() } else { 1 };
    let limit = if cands.len() > 1 { route_timeout(store) } else { CONNECT_TIMEOUT };
    let also: Vec<String> = saved.iter().filter_map(|r| store.host_key(&r.host, r.port)).map(|k| k.fingerprint).collect();
    let hop_name = |h: &crate::store::Hop| store.profile(h.profile_id).map(|p| p.name).unwrap_or_else(|_| "(지워진 서버)".into());
    let mut notes: Vec<String> = skipped.iter().map(|(r, why)| format!("{} 건너뜀 — 망 조건이 맞지 않음({why})", route_name(r))).collect();
    let mut linked = None;
    let n = cands.len();
    for (i, r) in cands.iter().enumerate() {
        match link_route(store, req.profile_id, &req.username, &req.legacy, r, req.trust_fingerprint.as_deref(), &also, limit).await {
            Ok(l) => {
                linked = Some((l, r.clone()));
                break;
            }
            Err((mut e, next)) => {
                e.route_id = r.id;
                e.route_label = (total > 1).then(|| route_name(r));
                if !next || i + 1 == n {
                    if n > 1 && next {
                        notes.push(format!("{}: {}", route_name(r), e.message));
                        e.message = format!("경로 {n}개를 모두 시도했지만 붙지 못했습니다. 마지막 오류: {}", e.message);
                    }
                    if !notes.is_empty() {
                        e.attempts = Some(notes);
                    }
                    return Err(e);
                }
                notes.push(format!("{}: {}", route_name(r), e.message));
            }
        }
    }
    let (Linked { mut handle, jumps, seen: seen_key, pinned, remote }, route) = linked.ok_or_else(|| err("NETWORK", "시도할 경로가 없습니다"))?;
    let used = RouteUsed {
        id: route.id,
        label: route_name(&route),
        summary: route_summary(&route, hop_name),
        total,
        note: (!notes.is_empty()).then(|| notes.join("\n")),
    };

    // 인증 — 비밀은 계정 키에서(계정을 안 주면 서버의 기본 계정)
    let account: Option<Account> = match (req.account_id, req.profile_id) {
        (Some(aid), _) => store.account(aid).ok(),
        (None, Some(pid)) => store.default_account(pid).ok(),
        _ => None,
    };
    let aid = account.as_ref().and_then(|a| a.id);
    let mut used_saved = false;
    let secret = match req.secret.clone().filter(|s| !s.is_empty()) {
        Some(s) => Some(s),
        None => {
            let saved = aid.and_then(|id| secrets::get(&secrets::account_key(id)));
            used_saved = saved.is_some();
            saved
        }
    };
    let ok = authenticate(&mut handle, &req.auth, &req.username, req.key_path.as_deref(), secret.as_deref()).await?;
    if !ok {
        if used_saved {
            if let Some(id) = aid {
                secrets::forget(&secrets::account_key(id));
                store.mark_account_used(id, Some(false));
            }
        }
        return Err(err("AUTH_FAILED", if used_saved { "저장한 암호가 맞지 않아 지웠습니다. 다시 입력하세요." } else { "계정 또는 암호가 맞지 않습니다" }));
    }

    // 접속 성공 — 처음 키면 고정(이 경로 주소로), 원하면 비밀 저장
    let newly_pinned = pinned.as_ref().map(|p| p.fingerprint != seen_key.fingerprint).unwrap_or(true);
    if newly_pinned {
        store.pin_host_key(&route.host, route.port, &seen_key).map_err(|e| err("OTHER", e))?;
    }
    if let Some(rid) = route.id {
        store.route_mark_ok(rid);
    }
    if let Some(id) = aid {
        let mut saved = None;
        if req.save_secret && req.auth != "agent" {
            if let Some(s) = secret.as_deref().filter(|_| !used_saved) {
                saved = Some(secrets::set(&secrets::account_key(id), s).is_ok());
            }
        }
        store.mark_account_used(id, saved);
    } else if let Some(pid) = req.profile_id {
        store.mark_used(pid);
    }
    Ok(Authed { handle, jump: jumps, seen_key, newly_pinned, used_saved, account, remote, route: used })
}

/// 인증 하나 — 에이전트·개인키·암호(안 되면 keyboard-interactive). 비밀이 모자라면 NEED_SECRET.
/// 전체에 [`AUTH_TIMEOUT`] 상한(서버·에이전트가 답하지 않아도 접속 화면이 멈추지 않게)
pub(crate) async fn authenticate(handle: &mut Handle<Client>, auth: &str, user: &str, key_path: Option<&str>, secret: Option<&str>) -> R<bool> {
    tokio::time::timeout(AUTH_TIMEOUT, authenticate_inner(handle, auth, user, key_path, secret))
        .await
        .map_err(|_| {
            let mut x = err("NETWORK", format!("서버가 {}초 안에 인증을 끝내지 않았습니다", AUTH_TIMEOUT.as_secs()));
            x.hint = Some(if auth == "agent" {
                "SSH 에이전트가 답하지 않았을 수 있습니다(키 사용 확인 창이 떠 있는지 보세요).".into()
            } else {
                "서버의 인증 단계(PAM·LDAP 등)가 느리거나 멈췄을 수 있습니다.".into()
            });
            x
        })?
}

async fn authenticate_inner(handle: &mut Handle<Client>, auth: &str, user: &str, key_path: Option<&str>, secret: Option<&str>) -> R<bool> {
    if auth == "agent" {
        agent_auth(handle, user).await
    } else if auth == "key" {
        let path = key_path.filter(|p| !p.is_empty()).ok_or_else(|| err("OTHER", "개인키 파일을 고르세요"))?;
        let key = match load_secret_key(path, secret) {
            Ok(k) => k,
            Err(russh::keys::Error::KeyIsEncrypted) => return Err(err("NEED_SECRET", "개인키 암호를 입력하세요")),
            Err(e) => return Err(err("AUTH_FAILED", format!("개인키를 읽지 못했습니다: {e}"))),
        };
        let hash = handle.best_supported_rsa_hash().await.map_err(map_russh)?.flatten();
        Ok(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(map_russh)?.success())
    } else {
        let Some(pw) = secret else {
            return Err(err("NEED_SECRET", "암호를 입력하세요"));
        };
        let ok = handle.authenticate_password(user, pw).await.map_err(map_russh)?.success();
        if ok {
            return Ok(true);
        }
        // 암호 방식이 꺼지고 keyboard-interactive 만 켠 서버(흔함). 암호가 아닌 것(OTP 등)을 물으면 그 문구를 담은 오류로 사람에게
        match keyboard_interactive(handle, user, pw).await {
            Ok(ok) => Ok(ok),
            Err(KbdInt::Human(x)) => Err(*x),
            Err(KbdInt::Net) => Ok(false),
        }
    }
}

/// 점프 단계 하나 — 받은 전송로 위에 SSH 를 열고, 고정된 호스트 키·저장된 비밀만 쓴다(여기서는 묻지 않는다)
pub(crate) async fn hop_session(store: &Store, p: &crate::store::Profile, a: &Account, io: crate::route::BoxIo, limit: Duration) -> R<Handle<Client>> {
    // 고정한 키가 없으면 가져온 known_hosts 의 키로만(맞으면 고정한다). 둘 다 없으면 묻지 않고 멈춘다
    let pinned = store.host_key(&p.host, p.port);
    let known: Vec<String> = match &pinned {
        Some(_) => Vec::new(),
        None => crate::importer::known_keys(store, &p.host, p.port).into_iter().filter(|k| !k.revoked).map(|k| k.fingerprint).collect(),
    };
    if pinned.is_none() && known.is_empty() {
        return Err(err("OTHER", format!("점프 서버 {} 의 호스트 키가 아직 고정되지 않았습니다. 그 서버로 한 번 접속해 지문을 확인하세요.", p.name)));
    }
    let seen = Arc::new(Mutex::new(None));
    let handler = Client { pinned: pinned.clone(), trust: None, also: known.clone(), seen: seen.clone(), remote: Default::default() };
    let named = |mut x: SshError| {
        x.message = format!("점프 서버 {}: {}", p.name, x.message);
        x
    };
    let mut h = tokio::time::timeout(limit, client::connect_stream(ssh_config(&p.legacy), io, handler))
        .await
        .map_err(|_| err("NETWORK", format!("점프 서버 {} 에서 {}초 안에 SSH 인사가 오지 않았습니다", p.name, limit.as_secs())))?
        .map_err(|e| {
            let ok = |f: &str| pinned.as_ref().map(|k| k.fingerprint == f).unwrap_or_else(|| known.iter().any(|k| k == f));
            if let Some(s) = seen.lock().unwrap().as_ref().filter(|s| !ok(&s.fingerprint)) {
                let whose = if pinned.is_some() { "고정한 키" } else { "가져온 known_hosts 의 키" };
                return err("HOSTKEY_MISMATCH", format!("점프 서버 {} 의 호스트 키가 {whose}와 다릅니다({}). 그 서버로 직접 접속해 확인하세요.", p.name, s.fingerprint));
            }
            named(map_russh(e))
        })?;
    let secret = a.id.and_then(|id| secrets::get(&secrets::account_key(id)));
    let ok = authenticate(&mut h, &a.auth, &a.username, a.key_path.as_deref(), secret.as_deref()).await.map_err(|x| {
        if x.code == "NEED_SECRET" {
            err(
                "OTHER",
                format!("점프 서버 {} 의 계정 {} 비밀이 저장돼 있지 않습니다. 그 계정으로 한 번 접속하며 \"암호 저장\"을 켜 주세요.", p.name, a.username),
            )
        } else {
            named(x)
        }
    })?;
    if !ok {
        return Err(err("AUTH_FAILED", format!("점프 서버 {} 인증에 실패했습니다(계정 {})", p.name, a.username)));
    }
    // known_hosts 로 믿은 점프 서버 — 이제 고정한다(다음부터는 고정 키로)
    if pinned.is_none() {
        if let Some(s) = seen.lock().unwrap().clone() {
            let _ = store.pin_host_key(&p.host, p.port, &s);
        }
    }
    Ok(h)
}

/// SSH 에이전트로 인증 — Windows: OpenSSH 에이전트(파이프) → Pageant, 그 밖: SSH_AUTH_SOCK
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> R<bool> {
    use russh::keys::agent::client::AgentClient;
    #[cfg(windows)]
    {
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if let Some(ok) = agent_try(handle, user, a).await? {
                return Ok(ok);
            }
        }
        match AgentClient::connect_pageant().await {
            Ok(a) => agent_try(handle, user, a).await.map(|r| r.unwrap_or(false)),
            Err(_) => Err(err("AUTH_FAILED", "SSH 에이전트를 찾지 못했습니다 — OpenSSH 인증 에이전트 서비스나 Pageant 를 켜고 키를 넣으세요")),
        }
    }
    #[cfg(unix)]
    {
        match AgentClient::connect_env().await {
            Ok(a) => agent_try(handle, user, a).await.map(|r| r.unwrap_or(false)),
            Err(_) => Err(err("AUTH_FAILED", "SSH 에이전트를 찾지 못했습니다(SSH_AUTH_SOCK) — ssh-agent 를 켜고 ssh-add 로 키를 넣으세요")),
        }
    }
}

/// 에이전트의 키를 하나씩 — 키가 없으면 None(다음 에이전트로)
async fn agent_try<S>(handle: &mut Handle<Client>, user: &str, mut agent: russh::keys::agent::client::AgentClient<S>) -> R<Option<bool>>
where
    S: russh::keys::agent::client::AgentStream + Unpin + Send + 'static,
{
    let ids = agent.request_identities().await.map_err(|e| err("AUTH_FAILED", format!("SSH 에이전트: {e}")))?;
    if ids.is_empty() {
        return Ok(None);
    }
    let hash = handle.best_supported_rsa_hash().await.map_err(map_russh)?.flatten();
    for id in ids {
        let key = id.public_key().into_owned();
        if let Ok(r) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(Some(true));
            }
        }
    }
    Ok(Some(false))
}

enum KbdInt {
    /// 저장한 암호로 답할 수 없는 질문 — 사람에게 넘긴다(질문 문구를 담아)
    Human(Box<SshError>),
    /// 망 오류 — 암호 실패와 같이 다룬다
    Net,
}

/// 암호를 묻는 문구인지 — 새 암호·확인·일회용 코드는 아니다
fn asks_password(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    let pw = ["password", "passwort", "mot de passe", "contraseña", "암호", "비밀번호", "パスワード", "密码"].iter().any(|k| p.contains(k));
    // 영어 낱말은 낱말 단위로(호스트·사용자 이름 bob@decode01 의 "code" 에 걸리지 않게), 한국어는 글귀로
    let words: Vec<&str> = p.split(|c: char| !c.is_alphanumeric() && c != '-').filter(|w| !w.is_empty()).collect();
    let other_word = ["new", "again", "retype", "confirm", "otp", "one-time", "verification", "token", "code", "passcode"].iter().any(|k| words.contains(k));
    let other_ko = ["새 ", "확인", "인증 코드", "일회용"].iter().any(|k| p.contains(k));
    pw && !other_word && !other_ko
}

/// keyboard-interactive — 질문이 하나이고 화면에 안 보이는(echo 끔) 암호 질문일 때만 저장 암호로 한 번 답한다.
/// 그 밖의 질문(OTP·여러 질문·두 번째 암호 질문 아닌 것)은 답하지 않고 Human 으로(같은 암호를 아무 질문에나 보내지 않게)
async fn keyboard_interactive(handle: &mut Handle<Client>, user: &str, pw: &str) -> Result<bool, KbdInt> {
    use russh::client::KeyboardInteractiveAuthResponse as K;
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None::<String>).await.map_err(|_| KbdInt::Net)?;
    let mut answered = false;
    for _ in 0..6 {
        match resp {
            K::Success => return Ok(true),
            K::Failure { .. } => return Ok(false),
            K::InfoRequest { prompts, instructions, .. } => {
                // 빈 질문(안내만)은 빈 답으로 넘긴다
                if prompts.is_empty() {
                    resp = handle.authenticate_keyboard_interactive_respond(Vec::new()).await.map_err(|_| KbdInt::Net)?;
                    continue;
                }
                let one_pw = prompts.len() == 1 && !prompts[0].echo && asks_password(&prompts[0].prompt);
                if one_pw && answered {
                    // 답한 뒤 또 암호를 물음 = 틀린 암호
                    return Ok(false);
                }
                if !one_pw {
                    let asked: Vec<String> = prompts.iter().map(|p| p.prompt.trim().to_string()).filter(|s| !s.is_empty()).collect();
                    let mut x = err(
                        "AUTH_FAILED",
                        format!("서버가 암호 말고 다른 것을 묻습니다: «{}» — 이 질문에는 앱이 대신 답하지 않습니다.", if asked.is_empty() { "(빈 질문)".to_string() } else { asked.join(" / ") }),
                    );
                    x.hint = Some(if instructions.trim().is_empty() {
                        "일회용 코드(OTP)·2단계 인증을 쓰는 서버일 수 있습니다 — 터미널의 ssh 로 접속하거나, 서버에서 이 계정에 키 인증을 허용하세요.".into()
                    } else {
                        format!("서버 안내: {}", instructions.trim())
                    });
                    return Err(KbdInt::Human(Box::new(x)));
                }
                answered = true;
                resp = handle.authenticate_keyboard_interactive_respond(vec![pw.to_string()]).await.map_err(|_| KbdInt::Net)?;
            }
        }
    }
    Ok(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOk {
    ms: u64,
    home: String,
    fingerprint: String,
    algorithm: String,
    newly_pinned: bool,
}

/// 연결 테스트 — 붙어서 인증까지 해 보고 바로 끊는다. 처음 보는 호스트 키면 HOSTKEY_UNKNOWN 으로 지문을 돌려준다(화면이 확인 후 다시)
#[tauri::command]
pub async fn ssh_test(store: State<'_, Store>, conns: State<'_, SshConns>, req: ConnectReq) -> R<TestOk> {
    let t = std::time::Instant::now();
    let mut req = req;
    req.save_secret = false;
    let ok = connect(&store, &conns, req).await?;
    let ms = t.elapsed().as_millis() as u64;
    if let Some(c) = conns.map.lock().unwrap().remove(&ok.conn_id) {
        tauri::async_runtime::spawn(async move {
            let _ = c.sftp.close().await;
            let _ = c.handle.disconnect(Disconnect::ByApplication, "", "ko").await;
        });
    }
    Ok(TestOk { ms, home: ok.home, fingerprint: ok.fingerprint, algorithm: ok.algorithm, newly_pinned: ok.newly_pinned })
}

#[tauri::command]
pub async fn ssh_disconnect(app: AppHandle, conns: State<'_, SshConns>, conn: u32) -> R<()> {
    crate::tunnel::stop_conn(conn).await;
    // 이 연결로 올리던 경로 매핑 자동 반영도 멈춘다(끊긴 연결로 계속 시도하지 않게)
    crate::sync::stop_conn(&app, conn);
    crate::container::forget(conn);
    let c = conns.map.lock().unwrap().remove(&conn);
    if let Some(c) = c {
        let _ = c.sftp.close().await;
        let _ = c.handle.disconnect(Disconnect::ByApplication, "", "ko").await;
    }
    Ok(())
}

// ── 터미널 채널 ──────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellExit {
    conn: u32,
    shell: u32,
    code: Option<u32>,
}

#[tauri::command]
pub async fn ssh_shell_open(
    app: AppHandle,
    conns: State<'_, SshConns>,
    conn: u32,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> R<u32> {
    let c = conns.get(conn)?;
    // tmux 로 열기: 서버에 tmux 가 있으면 rbs-<빈 번호> 세션에 붙는다(없으면 만든다)
    let use_tmux = c.tmux && tmux_available(&c).await;
    let kind = if use_tmux { String::new() } else { login_shell(&c).await };
    let ch = c.handle.channel_open_session().await.map_err(open_err)?;
    ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(map_russh)?;
    ch.request_shell(true).await.map_err(map_russh)?;
    let (read, write) = ch.split();
    let shell = c.next_shell.fetch_add(1, Ordering::Relaxed) + 1;
    if use_tmux {
        let n = c.tmux_alloc(shell);
        let _ = write.data(tmux_line(n, cwd.as_deref()).as_bytes()).await;
        let flow = Arc::new(crate::flow::Flow::default());
        let inject = Arc::new(Mutex::new(None));
        c.shells.lock().unwrap().insert(shell, ShellIo { tx: spawn_shell_writer(write), flow: flow.clone(), inject: inject.clone() });
        spawn_shell_reader(app, c.clone(), conn, shell, read, on_data, flow, None, inject);
        return Ok(shell);
    }
    // 셸 통합 — 서버 파일은 바꾸지 않고 이 셸에만 프롬프트 훅을 얹는다(zsh 는 precmd, 그 밖은 bash 일 때만 걸리는 PROMPT_COMMAND, fish·csh 등은 치지 않는다). 프롬프트마다:
    //   OSC 133;D;종료코드(앞 명령 끝) · OSC 6976 어느 셸인지(host · docker:이름 — 트리·편집기가 볼 곳) · OSC 6977 작업 목록(jobs, 줄은 ␤)
    //   · OSC 7 지금 폴더(트리 따라가기) · OSC 6974 uid(root 표시) · OSC 133;A(프롬프트 시작). 끝맺음은 모두 BEL.
    // 앞 공백 = 셸 기록에 남지 않게. 이 줄의 에코는 화면에서 지우지 않고(clear 하지 않음 — MOTD·마지막 로그인 안내가 남는다)
    // 끝에 찍는 준비 표식(OSC 6975)까지 리더가 걸러 낸다(InitFilter).
    let hook = match kind.as_str() {
        "zsh" => Some((
            ZSH_HOOK_HOST,
            " __rb_precmd()",
        )),
        // 프롬프트 훅 문법이 다른 셸 — 아무것도 치지 않는다
        "fish" | "csh" | "tcsh" | "nu" | "elvish" | "xonsh" | "pwsh" | "powershell" => None,
        // bash·sh·dash·ksh, 또는 알아내지 못함(exec 채널 거부·느림) — bash 일 때만 걸리게 감싸서 보낸다(sh·dash 에서는 오류 없이 지나간다).
        // 알아내지 못했다고 빼면 그 연결은 프롬프트 표식이 없어 자동완성·명령 표시가 통째로 꺼진다(0.12.0 회귀)
        _ => Some((
            BASH_HOOK_HOST,
            r#" [ -n "$BASH_VERSION" ]"#,
        )),
    };
    let cd = cwd.filter(|d| !d.is_empty()).map(|dir| format!("cd '{}'", dir.replace('\'', "'\\''")));
    // tmux 로 열라고 했는데 서버에 없으면 이 연결에서 한 번만 알린다
    let notice = (c.tmux && c.tmux_ok.compare_exchange(2, 3, Ordering::Relaxed, Ordering::Relaxed).is_ok())
        .then_some(r"printf '\r\n[RuiBotte] 서버에 tmux 가 없어 일반 셸로 열었습니다. 끊기면 이어지지 않습니다(설치 예: sudo apt install tmux).\r\n'");
    let mut filter = None;
    let mut line = String::new();
    if let Some((h, prefix)) = hook {
        line.push_str(h);
        if let Some(cd) = &cd {
            line.push_str("; ");
            line.push_str(cd);
        }
        line.push_str(r"; printf '\033]6975;rb\007'");
        filter = Some(InitFilter::new(prefix.as_bytes().to_vec()));
    } else if let Some(cd) = &cd {
        // 셸 통합이 없는 셸 — 시작 폴더만(이 줄은 보인다)
        line.push(' ');
        line.push_str(cd);
    }
    if let Some(n) = notice {
        line.push_str(if line.is_empty() { " " } else { "; " });
        line.push_str(n);
    }
    if !line.is_empty() {
        line.push('\n');
        let _ = write.data(line.as_bytes()).await;
    }
    let flow = Arc::new(crate::flow::Flow::default());
    let inject = Arc::new(Mutex::new(None));
    c.shells.lock().unwrap().insert(shell, ShellIo { tx: spawn_shell_writer(write), flow: flow.clone(), inject: inject.clone() });
    spawn_shell_reader(app, c.clone(), conn, shell, read, on_data, flow, filter, inject);
    Ok(shell)
}

/// zsh 프롬프트 훅 — 작업 목록은 $jobstates·$jobtexts 로(포크 없음). 정지 @@R@@ 실행 중, 줄 사이 @@J@@(ASCII — EUC-KR 터미널에서도 안 깨진다)
const ZSH_HOOK_HOST: &str = r#" __rb_precmd() { local s=$? j= r= k; for k in ${(k)jobstates}; do if [[ ${jobstates[$k]} == suspended* ]]; then j+="[$k]  z  ${jobtexts[$k]}@@J@@"; elif [[ ${jobstates[$k]} == running* ]]; then r+="[$k]  z  ${jobtexts[$k]}@@J@@"; fi; done; printf '\033]133;D;%s\007\033]6976;host\007\033]6977;%s\007\033]7;file://%s%s\007\033]6974;%s\007\033]133;A\007' "$s" "$j@@R@@$r" "$HOST" "$PWD" "$EUID"; }; precmd_functions+=(__rb_precmd)"#;
/// bash 프롬프트 훅 — bash 일 때만 걸린다(sh·dash 에서는 오류 없이 지나간다). 작업 목록은 jobs -s(정지) @@R@@ jobs -r(실행 중) —
/// 상태 글자(로캘마다 다름)는 앱이 읽지 않는다. 줄 사이 @@J@@
const BASH_HOOK_HOST: &str = r#" [ -n "$BASH_VERSION" ] && __rb_nl=$'\n' && PROMPT_COMMAND='__rb_s=$?; __rb_j=$(jobs -s; printf "@@R@@"; jobs -r); printf "\033]133;D;%s\007\033]6976;host\007\033]6977;%s\007\033]7;file://%s%s\007\033]6974;%s\007\033]133;A\007" "$__rb_s" "${__rb_j//$__rb_nl/@@J@@}" "${HOSTNAME:-}" "$PWD" "$EUID"; (exit $__rb_s)'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}""#;

/// 컨테이너 셸에 넣는 줄의 머리 — 에코를 거를 때 이 글귀로 줄을 찾는다
const INJECT_PREFIX: &str = " __rb_inj=1";

/// docker exec 로 들어간 컨테이너 셸에 같은 훅을 건다 — bash 는 PROMPT_COMMAND, zsh 는 precmd(eval 로 — 다른 셸이 문법 오류를 내지 않게),
/// 그 밖(sh·ash·dash)은 PS1 앞에 표식을 붙인다($PWD 는 프롬프트마다 풀린다). 끝에 준비 표식(OSC 6975) — 리더가 그때까지 에코를 거른다
fn ctr_hook_line(ctr: &str) -> String {
    let tag = format!("docker:{ctr}");
    let bash_pc = r#"__rb_s=$?; __rb_j=$(jobs -s; printf "@@R@@"; jobs -r); printf "\033]133;D;%s\007\033]6976;TAG\007\033]6977;%s\007\033]7;file://ctr%s\007\033]6974;%s\007\033]133;A\007" "$__rb_s" "${__rb_j//$__rb_nl/@@J@@}" "$PWD" "$EUID"; (exit $__rb_s)"#.replace("TAG", &tag);
    let zsh_def = r#"__rb_precmd() { local s=$? j= r= k; for k in ${(k)jobstates}; do if [[ ${jobstates[$k]} == suspended* ]]; then j+="[$k]  z  ${jobtexts[$k]}@@J@@"; elif [[ ${jobstates[$k]} == running* ]]; then r+="[$k]  z  ${jobtexts[$k]}@@J@@"; fi; done; printf '\033]133;D;%s\007\033]6976;TAG\007\033]6977;%s\007\033]7;file://ctr%s\007\033]6974;%s\007\033]133;A\007' "$s" "$j@@R@@$r" "$PWD" "$EUID"; }; precmd_functions+=(__rb_precmd)"#.replace("TAG", &tag);
    let sh_ps1 = format!(r#"PS1="$(printf '\033]6976;{tag}\007\033]7;file://ctr')"'$PWD'"$(printf '\007\033]133;A\007')$PS1""#);
    format!(
        "{INJECT_PREFIX}; if [ -n \"$BASH_VERSION\" ]; then __rb_nl=$'\\n'; PROMPT_COMMAND={}\"${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}\"; elif [ -n \"$ZSH_VERSION\" ]; then eval {}; else {sh_ps1}; fi; printf '\\033]6975;rb\\007'\n",
        crate::sudo::q(&bash_pc),
        crate::sudo::q(&zsh_def),
    )
}

/// 터미널이 docker exec 로 컨테이너 셸에 들어간 뒤 — 그 셸에 훅을 건다(넣은 줄의 에코는 화면에 안 보이게 거른다)
#[tauri::command]
pub async fn ssh_shell_inject_ctx(conns: State<'_, SshConns>, conn: u32, shell: u32, ctr: String) -> R<()> {
    if !crate::container::valid_name(&ctr) {
        return Err(err("OTHER", "컨테이너 이름이 올바르지 않습니다"));
    }
    let c = conns.get(conn)?;
    {
        let shells = c.shells.lock().unwrap();
        let io = shells.get(&shell).ok_or_else(|| err("CLOSED", "터미널이 닫혔습니다"))?;
        *io.inject.lock().unwrap() = Some(InitFilter::new(INJECT_PREFIX.as_bytes().to_vec()));
    }
    c.shell_send(shell, ShellOp::Data(ctr_hook_line(&ctr).into_bytes()))
}

/// 이 연결의 로그인 셸 이름(bash·zsh·sh·…) — 한 번만 묻는다. 모르면 빈 글자(셸 통합을 걸지 않음)
async fn login_shell(c: &Conn) -> String {
    c.login_shell
        .get_or_init(|| async {
            let out = exec_out(c, r#"printf '%s' "${SHELL##*/}""#, Duration::from_secs(4)).await.unwrap_or_default();
            out.trim().to_string()
        })
        .await
        .clone()
}

/// 셸 통합을 걸려고 친 줄의 에코를 화면에서 걸러 낸다 — 그 줄이 시작한 줄 머리(그 앞 프롬프트 포함)부터 준비 표식(OSC 6975)까지.
/// MOTD 등 그 앞 출력은 그대로 둔다. 표식이 4초 안에 안 오면(셸이 다르거나 느림) 모은 것을 그대로 내보낸다
pub(crate) struct InitFilter {
    prefix: Vec<u8>,
    buf: Vec<u8>,
    until: tokio::time::Instant,
}

const READY_MARK: &[u8] = b"\x1b]6975;rb\x07";

impl InitFilter {
    fn new(prefix: Vec<u8>) -> Self {
        Self { prefix, buf: Vec::new(), until: tokio::time::Instant::now() + Duration::from_secs(4) }
    }
    /// 받은 것을 넣는다 — 다 걸렀으면 true(이후는 바로 보낸다)
    fn feed(&mut self, data: &[u8], out: &mut VecDeque<u8>) -> bool {
        self.buf.extend_from_slice(data);
        if let Some(mi) = find_bytes(&self.buf, READY_MARK) {
            let end = mi + READY_MARK.len();
            let cut = match find_bytes(&self.buf[..mi], &self.prefix) {
                Some(p) => self.buf[..p].iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0),
                None => mi,
            };
            out.extend(&self.buf[..cut]);
            out.extend(&self.buf[end..]);
            self.buf.clear();
            return true;
        }
        if self.buf.len() > 256 * 1024 {
            self.flush(out);
            return true;
        }
        false
    }
    fn flush(&mut self, out: &mut VecDeque<u8>) {
        out.extend(self.buf.drain(..));
    }
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 터미널 채널 하나 — 입력 큐와 출력 흐름 제어
pub(crate) struct ShellIo {
    tx: tokio::sync::mpsc::UnboundedSender<ShellOp>,
    flow: Arc<crate::flow::Flow>,
    /// 셸 안에서 다른 셸(컨테이너)에 훅을 넣을 때 — 리더가 다음 출력부터 그 에코를 거른다
    inject: Arc<Mutex<Option<InitFilter>>>,
}

/// 터미널 채널에 할 일 — 입력·크기·닫기를 한 줄로 세워 차례대로
pub(crate) enum ShellOp {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// 셸 하나의 쓰기 전용 작업 — 명령(invoke)은 큐에 넣고 바로 돌아간다.
/// 밀린 입력(빠른 타이핑·붙여넣기)은 한 번에 묶어 보낸다. 큐가 끊기면(셸 닫힘) 끝난다
fn spawn_shell_writer(write: ChannelWriteHalf<Msg>) -> tokio::sync::mpsc::UnboundedSender<ShellOp> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ShellOp>();
    tauri::async_runtime::spawn(async move {
        let mut next: Option<ShellOp> = None;
        loop {
            let op = match next.take() {
                Some(op) => op,
                None => match rx.recv().await {
                    Some(op) => op,
                    None => break,
                },
            };
            match op {
                ShellOp::Data(mut buf) => {
                    while let Ok(more) = rx.try_recv() {
                        match more {
                            ShellOp::Data(b) => buf.extend_from_slice(&b),
                            other => {
                                next = Some(other);
                                break;
                            }
                        }
                    }
                    if write.data(&buf[..]).await.is_err() {
                        break;
                    }
                }
                ShellOp::Resize(cols, rows) => {
                    let _ = write.window_change(cols, rows, 0, 0).await;
                }
                ShellOp::Close => {
                    let _ = write.close().await;
                    break;
                }
            }
        }
    });
    tx
}

impl Conn {
    /// 이 셸의 입력 큐에 넣기 — 셸이 닫혔으면 CLOSED
    fn shell_send(&self, shell: u32, op: ShellOp) -> R<()> {
        let shells = self.shells.lock().unwrap();
        let io = shells.get(&shell).ok_or_else(|| err("CLOSED", "터미널이 닫혔습니다"))?;
        io.tx.send(op).map_err(|_| err("CLOSED", "터미널이 닫혔습니다"))
    }
}

/// 셸 출력을 화면으로 — 끝나면 채널·tmux 번호를 정리하고 알린다
///
/// 흐름 제어: 화면(xterm)이 그린 만큼 알려 오면(ack) 그만큼 더 보낸다 — 화면에 쌓인 양을 [`crate::flow::WINDOW`] 안으로.
/// SSH 채널 읽기는 멈추지 않는다(russh 는 한 채널이 안 읽히면 연결 전체가 멈춘다) — 그동안 온 것은 여기 모아 두고,
/// 모은 것이 [`crate::flow::MAX_BUF`] 를 넘을 때만 읽기를 쉰다. 바로 보낼 수 있으면 지연 없이 보낸다(타이핑 에코).
#[allow(clippy::too_many_arguments)]
fn spawn_shell_reader(app: AppHandle, c: Arc<Conn>, conn: u32, shell: u32, mut read: russh::ChannelReadHalf, on_data: Channel<InvokeResponseBody>, flow: Arc<crate::flow::Flow>, mut init: Option<InitFilter>, inject: Arc<Mutex<Option<InitFilter>>>) {
    use crate::flow::{MAX_BUF, SEND_CHUNK};
    use futures_util::FutureExt;
    tauri::async_runtime::spawn(async move {
        let mut code = None;
        // 앞에서 덜어 내고 뒤에 붙인다 — Vec 의 drain(..n) 은 남은 것을 매번 앞으로 옮겼다(큰 출력에서 O(n²))
        let mut pending: VecDeque<u8> = VecDeque::new();
        let mut open = true;
        'outer: loop {
            // 보낼 수 있는 만큼 보낸다
            while !pending.is_empty() && flow.can_send() {
                let n = pending.len().min(SEND_CHUNK);
                let chunk: Vec<u8> = pending.drain(..n).collect();
                flow.sent(n);
                if on_data.send(InvokeResponseBody::Raw(chunk)).is_err() {
                    break 'outer;
                }
            }
            if !open {
                if pending.is_empty() {
                    break;
                }
                // 닫힌 뒤 남은 것 — ack 를 기다려 마저(화면이 사라졌으면 잠시 뒤 그냥 버린다)
                if tokio::time::timeout(Duration::from_secs(2), flow.acked()).await.is_err() {
                    flow.reset();
                }
                continue;
            }
            let room = pending.len() < MAX_BUF;
            tokio::select! {
                msg = read.wait(), if room => {
                    let mut msg = msg;
                    // 이미 와 있는 것은 한 번에 모은다(eval 횟수 줄이기)
                    loop {
                        match msg {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if init.is_none() {
                                    init = inject.lock().unwrap().take();
                                }
                                match init.as_mut() {
                                    Some(f) => {
                                        if f.feed(&data, &mut pending) {
                                            init = None;
                                        }
                                    }
                                    None => pending.extend(&data[..]),
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                if let Some(mut f) = init.take() {
                                    f.flush(&mut pending);
                                }
                                open = false;
                                break;
                            }
                            Some(_) => {}
                        }
                        if pending.len() >= SEND_CHUNK {
                            break;
                        }
                        match read.wait().now_or_never() {
                            Some(m) => msg = m,
                            None => break,
                        }
                    }
                }
                _ = flow.acked(), if !pending.is_empty() => {}
                // 셸 통합 표식이 끝내 안 오면 모은 것을 그대로
                _ = tokio::time::sleep_until(init.as_ref().map(|f| f.until).unwrap_or_else(tokio::time::Instant::now)), if init.is_some() => {
                    if let Some(mut f) = init.take() {
                        f.flush(&mut pending);
                    }
                }
                // 화면이 ack 를 못 보내는 상태(닫힘·멈춤)여도 영영 막히지 않게
                _ = tokio::time::sleep(Duration::from_secs(3)), if !pending.is_empty() && !flow.can_send() => flow.reset(),
            }
        }
        c.shells.lock().unwrap().remove(&shell);
        c.tmux_used.lock().unwrap().remove(&shell);
        let _ = app.emit("ssh-shell-exit", ShellExit { conn, shell, code });
    });
}

impl Conn {
    /// 지금 이 연결에서 안 쓰는 가장 작은 tmux 번호를 그 셸 몫으로 — 다시 연결해 터미널을 같은 순서로 열면 같은 세션에 붙는다
    fn tmux_alloc(&self, shell: u32) -> u32 {
        let mut used = self.tmux_used.lock().unwrap();
        let n = free_number(used.values().copied());
        used.insert(shell, n);
        n
    }
}

fn free_number(used: impl Iterator<Item = u32>) -> u32 {
    let used: std::collections::HashSet<u32> = used.collect();
    (1..).find(|n| !used.contains(n)).unwrap_or(1)
}

/// tmux 세션 이름 — 앱이 만든 것은 rbs-<번호>
pub(crate) fn tmux_name(n: u32) -> String {
    format!("rbs-{n}")
}

/// tmux 로 셸을 바꾸는 줄 — 앞 공백 = 셸 기록에 남지 않게. 세션이 있으면 붙고(-A) 없으면 만든다(-c 는 만들 때만)
fn tmux_line(n: u32, cwd: Option<&str>) -> String {
    let mut line = format!(" exec tmux new-session -A -s {}", tmux_name(n));
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        line.push_str(&format!(" -c '{}'", dir.replace('\'', "'\\''")));
    }
    line.push('\n');
    line
}

/// 서버에 tmux 가 있는지 — 연결마다 한 번만 본다
pub(crate) async fn tmux_available(c: &Conn) -> bool {
    match c.tmux_ok.load(Ordering::Relaxed) {
        1 => return true,
        2 | 3 => return false,
        _ => {}
    }
    let out = exec_out(c, "sh -c 'command -v tmux'", Duration::from_secs(6)).await.unwrap_or_default();
    let ok = out.trim().ends_with("tmux");
    let _ = c.tmux_ok.compare_exchange(0, if ok { 1 } else { 2 }, Ordering::Relaxed, Ordering::Relaxed);
    ok
}

/// 짧은 명령 하나 — 표준출력(1 MiB 상한, 넘으면 거기까지)
async fn exec_out(c: &Conn, cmd: &str, limit: Duration) -> R<String> {
    let o = run_exec(c, cmd, None, ExecLimit { idle: limit, total: Some(limit), max_out: 1024 * 1024 }).await?;
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// exec 한 번의 결과
pub(crate) struct ExecOut {
    pub(crate) code: Option<u32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
    /// 표준출력이 max_out 을 넘어 거기서 끊었다
    pub(crate) cut: bool,
}

/// exec 시간·크기 상한 — idle: 출력·진행 없이 기다릴 최대 시간, total: 전체(없으면 idle 만), max_out: 표준출력 상한
#[derive(Clone, Copy)]
pub(crate) struct ExecLimit {
    pub(crate) idle: Duration,
    pub(crate) total: Option<Duration>,
    pub(crate) max_out: usize,
}

/// exec 채널로 명령 하나. 시간 초과·출력 상한으로 빠져나오면 채널을 닫는다(서버에 채널·프로세스를 남기지 않게).
/// stdin 은 조각으로 보내고 조각마다 idle 상한을 건다
pub(crate) async fn run_exec(c: &Conn, cmd: &str, stdin: Option<&[u8]>, lim: ExecLimit) -> R<ExecOut> {
    let deadline = lim.total.map(|t| tokio::time::Instant::now() + t);
    let step = || match deadline {
        Some(d) => lim.idle.min(d.saturating_duration_since(tokio::time::Instant::now())),
        None => lim.idle,
    };
    let slow = || err("NETWORK", "서버가 제때 답하지 않았습니다");
    let ch = tokio::time::timeout(step(), c.handle.channel_open_session()).await.map_err(|_| err("NETWORK", "서버가 새 채널을 제때 열어 주지 않았습니다"))?.map_err(open_err)?;
    let mut ch = ch;
    let mut out = ExecOut { code: None, stdout: Vec::new(), stderr: String::new(), cut: false };
    let mut closed = false;
    let r: R<()> = async {
        tokio::time::timeout(step(), ch.exec(true, cmd)).await.map_err(|_| slow())?.map_err(map_russh)?;
        if let Some(input) = stdin {
            for part in input.chunks(256 * 1024) {
                tokio::time::timeout(step(), ch.data(part)).await.map_err(|_| slow())?.map_err(map_russh)?;
            }
        }
        // 입력 끝 — 표준입력을 읽는 명령이 기다리며 멈추지 않게(입력이 없어도)
        tokio::time::timeout(step(), ch.eof()).await.map_err(|_| slow())?.map_err(map_russh)?;
        loop {
            let left = step();
            if left.is_zero() {
                return Err(slow());
            }
            let Ok(m) = tokio::time::timeout(left, ch.wait()).await else {
                return Err(slow());
            };
            match m {
                Some(ChannelMsg::Data { data }) => {
                    out.stdout.extend_from_slice(&data);
                    if out.stdout.len() > lim.max_out {
                        out.stdout.truncate(lim.max_out);
                        out.cut = true;
                        return Ok(());
                    }
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if out.stderr.len() < 64 * 1024 {
                        out.stderr.push_str(&String::from_utf8_lossy(&data));
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => out.code = Some(exit_status),
                // exec 요청을 서버가 거절(셸 금지 계정 등) — 채널은 열린 채라 기다리면 상한까지 멈춘다
                Some(ChannelMsg::Failure) => return Err(err("OTHER", "서버가 명령 실행을 거절했습니다(이 계정은 셸·명령이 막혀 있을 수 있습니다)")),
                Some(ChannelMsg::Close) | None => {
                    closed = true;
                    return Ok(());
                }
                Some(_) => {}
            }
        }
    }
    .await;
    if !closed {
        // 다 받기 전에 빠져나왔다 — 채널을 닫아 서버 쪽 프로세스에 끝을 알린다
        let _ = tokio::time::timeout(Duration::from_secs(2), ch.close()).await;
    }
    r.map(|_| out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    name: String,
    windows: u32,
    /// 지금 붙어 있는 클라이언트 수(이 앱의 터미널 포함)
    attached: u32,
    /// 만든 때(초)
    created: Option<i64>,
    /// 이 앱이 만든 세션(rbs-번호)
    ours: bool,
}

fn parse_tmux_ls(out: &str) -> Vec<TmuxSession> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let name = it.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let windows = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
            let attached = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
            let created = it.next().and_then(|x| x.trim().parse().ok());
            let ours = name.strip_prefix("rbs-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
            Some(TmuxSession { name, windows, attached, created, ours })
        })
        .collect()
}

/// 서버의 tmux 세션 목록 — tmux 가 없으면 None
#[tauri::command]
pub async fn ssh_tmux_list(conns: State<'_, SshConns>, conn: u32) -> R<Option<Vec<TmuxSession>>> {
    let c = conns.get(conn)?;
    let out = exec_out(&c, "sh -c 'command -v tmux >/dev/null 2>&1 || { echo __rb_no_tmux; exit 0; }; tmux ls -F \"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\" 2>/dev/null; true'", Duration::from_secs(8)).await?;
    if out.contains("__rb_no_tmux") {
        return Ok(None);
    }
    Ok(Some(parse_tmux_ls(&out)))
}

/// tmux 세션 하나 끝내기(그 안의 프로그램도 끝난다 — 화면이 먼저 묻는다)
#[tauri::command]
pub async fn ssh_tmux_kill(conns: State<'_, SshConns>, conn: u32, name: String) -> R<()> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) {
        return Err(err("OTHER", "이 이름의 세션은 여기서 지울 수 없습니다(영문·숫자·-_. 만)"));
    }
    let c = conns.get(conn)?;
    exec_out(&c, &format!("tmux kill-session -t '={name}' 2>&1"), Duration::from_secs(8)).await?;
    Ok(())
}

/// 화면이 그린 바이트 수 — 흐름 제어(그만큼 더 보낸다)
#[tauri::command]
pub fn ssh_shell_ack(conns: State<'_, SshConns>, conn: u32, shell: u32, n: usize) -> R<()> {
    let c = conns.get(conn)?;
    if let Some(io) = c.shells.lock().unwrap().get(&shell) {
        io.flow.ack(n);
    }
    Ok(())
}

/// 키 입력 — 동기 명령으로 둔다: 큐에 넣기만 해서 바로 끝나고, 메인 스레드가 받은 차례대로 넣으니 순서가 지켜진다
/// (async 명령은 호출마다 따로 작업이 돼 빠른 타이핑에서 순서가 섞일 수 있었다)
#[tauri::command]
pub fn ssh_shell_write(conns: State<'_, SshConns>, conn: u32, shell: u32, data: String, encoding: Option<String>) -> R<()> {
    let c = conns.get(conn)?;
    // 터미널 인코딩이 UTF-8 이 아니면(EUC-KR 서버) 입력 글자를 그 인코딩으로 바꿔 보낸다
    let bytes = match encoding.as_deref().filter(|e| !e.eq_ignore_ascii_case("utf-8")) {
        Some(label) => {
            let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
            enc.encode(&data).0.into_owned()
        }
        None => data.into_bytes(),
    };
    c.shell_send(shell, ShellOp::Data(bytes))
}

/// sudo 암호를 이 터미널에 넣는다(암호 묻는 줄에서) — 값은 화면으로 돌아가지 않는다. 넣을 암호가 없으면 false
#[tauri::command]
pub async fn ssh_shell_sudo_pw(conns: State<'_, SshConns>, conn: u32, shell: u32) -> R<bool> {
    let c = conns.get(conn)?;
    let Some(pw) = crate::sudo::password_of(&c) else {
        return Ok(false);
    };
    c.shell_send(shell, ShellOp::Data(format!("{pw}\n").into_bytes()))?;
    Ok(true)
}

#[tauri::command]
pub fn ssh_shell_resize(conns: State<'_, SshConns>, conn: u32, shell: u32, cols: u32, rows: u32) -> R<()> {
    let c = conns.get(conn)?;
    // 닫힌 셸의 크기 변경은 조용히 넘긴다(칸을 닫는 중에 올 수 있다)
    let _ = c.shell_send(shell, ShellOp::Resize(cols, rows));
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_close(conns: State<'_, SshConns>, conn: u32, shell: u32) -> R<()> {
    if let Ok(c) = conns.get(conn) {
        let io = c.shells.lock().unwrap().remove(&shell);
        if let Some(io) = io {
            let _ = io.tx.send(ShellOp::Close);
            io.flow.reset();
        }
    }
    Ok(())
}

// ── SFTP ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    path: String,
    /// "dir" | "file" | "link" | "other"
    kind: &'static str,
    size: u64,
    mtime: Option<u32>,
    mode: Option<u32>,
    /// 심볼릭 링크면 가리키는 곳
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub(crate) fn sftp_err(e: russh_sftp::client::error::Error) -> SshError {
    let msg = e.to_string();
    let friendly = if msg.contains("Permission denied") || msg.contains("PermissionDenied") {
        "권한이 없습니다".to_string()
    } else if msg.contains("No such file") || msg.contains("NoSuchFile") {
        "파일이 없습니다".to_string()
    } else {
        msg
    };
    err("SFTP", friendly)
}

#[tauri::command]
pub async fn sftp_list(conns: State<'_, SshConns>, conn: u32, path: String) -> R<Vec<FsEntry>> {
    list(&conns, conn, path).await
}

pub(crate) async fn list(conns: &SshConns, conn: u32, path: String) -> R<Vec<FsEntry>> {
    use futures_util::StreamExt;
    let c = conns.get(conn)?;
    let dir = c.sftp.read_dir(path.clone()).await.map_err(sftp_err)?;
    let mut out: Vec<FsEntry> = Vec::new();
    let mut links: Vec<FsEntry> = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let m = e.metadata();
        let kind = if m.is_dir() {
            "dir"
        } else if m.is_symlink() {
            "link"
        } else if m.is_regular() {
            "file"
        } else {
            "other"
        };
        let entry = FsEntry { path: join(&path, &name), name, kind, size: m.size.unwrap_or(0), mtime: m.mtime, mode: m.permissions, target: None };
        if kind == "link" {
            links.push(entry);
        } else {
            out.push(entry);
        }
    }
    // 링크는 가리키는 곳·종류를 한꺼번에(링크마다 왕복 두 번을 차례로 기다리지 않게) — 폴더를 가리키면 폴더처럼 펼친다
    let sftp = &c.sftp;
    let resolved: Vec<FsEntry> = futures_util::stream::iter(links.into_iter().map(|mut e| async move {
        let (t, m) = tokio::join!(sftp.read_link(e.path.clone()), sftp.metadata(e.path.clone()));
        e.target = t.ok();
        if m.is_ok_and(|m| m.is_dir()) {
            e.kind = "dir";
        }
        e
    }))
    .buffer_unordered(16)
    .collect()
    .await;
    out.extend(resolved);
    out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    path: String,
    size: u64,
    mtime: Option<u32>,
    text: Option<String>,
    meta: TextMeta,
    binary: bool,
    too_large: bool,
}

#[tauri::command]
pub async fn sftp_read_text(conns: State<'_, SshConns>, conn: u32, path: String, encoding: Option<String>) -> R<FileText> {
    read_text(&conns, conn, path, encoding).await
}

pub(crate) async fn read_text(conns: &SshConns, conn: u32, path: String, encoding: Option<String>) -> R<FileText> {
    let c = conns.get(conn)?;
    let m = c.sftp.metadata(path.clone()).await.map_err(sftp_err)?;
    let size = m.size.unwrap_or(0);
    if size > MAX_TEXT {
        // 앞부분만 읽기 전용으로(끝부분은 실시간 보기로)
        use tokio::io::AsyncReadExt;
        let f = c.sftp.open(path.clone()).await.map_err(sftp_err)?;
        let mut head = Vec::new();
        f.take(crate::localfs::HEAD_TEXT).read_to_end(&mut head).await.map_err(|e| err("SFTP", e.to_string()))?;
        let d = textcodec::decode(&crate::localfs::trim_head(head), encoding.as_deref());
        return Ok(FileText { path, size, mtime: m.mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: true });
    }
    let bytes = c.sftp.read(path.clone()).await.map_err(sftp_err)?;
    let d = textcodec::decode(&bytes, encoding.as_deref());
    Ok(FileText { path, size, mtime: m.mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    size: u64,
    mtime: Option<u32>,
}

/// 연 뒤 서버에서 바뀌었는지 — mtime(주면)·크기(주면) 중 하나라도 다르면 CONFLICT. 파일이 없어졌으면 통과(새로 만든다)
pub(crate) fn check_unchanged(now_mtime: Option<u32>, now_size: Option<u64>, expect_mtime: Option<u32>, expect_size: Option<u64>) -> R<()> {
    let mtime_moved = matches!((expect_mtime, now_mtime), (Some(e), Some(n)) if e != n);
    let size_moved = matches!((expect_size, now_size), (Some(e), Some(n)) if e != n);
    if mtime_moved || size_moved {
        return Err(err("CONFLICT", "연 뒤에 서버에서 파일이 바뀌었습니다. 다시 열어 확인하세요."));
    }
    Ok(())
}

/// 쓴 뒤 크기 확인 — 다르면 SIZE_MISMATCH(잘렸거나 다른 곳에서 동시에 썼다)
pub(crate) fn check_written(now: Option<u64>, want: usize) -> R<()> {
    match now {
        Some(n) if n != want as u64 => {
            let mut x = err("SIZE_MISMATCH", format!("저장한 뒤 서버의 파일 크기({n} 바이트)가 보낸 크기({want} 바이트)와 다릅니다. 다시 열어 내용을 확인하세요."));
            x.hint = Some("디스크가 가득 찼거나(할당량), 저장하는 동안 다른 프로그램이 같은 파일에 썼을 수 있습니다.".into());
            Err(x)
        }
        _ => Ok(()),
    }
}

/// 제자리 덮어쓰기 — 같은 파일(inode)을 잘라서 쓴다(CREATE|TRUNCATE|WRITE): 소유자·권한·하드 링크·심볼릭 링크가 그대로.
/// (russh-sftp 의 `SftpSession::write` 는 WRITE 만 켜서 짧아진 저장에 옛 꼬리가 남고, 없는 파일은 만들지 못했다.)
/// 쓴 뒤 크기를 확인한다
pub(crate) async fn sftp_overwrite(sftp: &SftpSession, path: &str, bytes: &[u8]) -> R<russh_sftp::client::fs::Metadata> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;
    let mut f = sftp.open_with_flags(path.to_string(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err)?;
    let wrote = f.write_all(bytes).await;
    // 쓰다 실패해도 핸들은 닫는다
    let closed = f.shutdown().await;
    wrote.map_err(|e| err("SFTP", format!("쓰지 못했습니다: {e}")))?;
    closed.map_err(|e| err("SFTP", format!("저장을 마치지 못했습니다: {e}")))?;
    let m = sftp.metadata(path.to_string()).await.map_err(sftp_err)?;
    check_written(m.size, bytes.len())?;
    Ok(m)
}

/// 저장 — 연 뒤 서버에서 바뀌었으면(mtime·크기) 덮어쓰지 않고 알린다(expectMtime·expectSize 를 주면)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_write_text(
    conns: State<'_, SshConns>,
    conn: u32,
    path: String,
    text: String,
    meta: TextMeta,
    expect_mtime: Option<u32>,
    expect_size: Option<u64>,
) -> R<Saved> {
    let c = conns.get(conn)?;
    if expect_mtime.is_some() || expect_size.is_some() {
        if let Ok(m) = c.sftp.metadata(path.clone()).await {
            check_unchanged(m.mtime, m.size, expect_mtime, expect_size)?;
        }
    }
    let bytes = textcodec::encode(&text, &meta).map_err(|e| err("ENCODING", e))?;
    let m = sftp_overwrite(&c.sftp, &path, &bytes).await?;
    Ok(Saved { size: m.size.unwrap_or(bytes.len() as u64), mtime: m.mtime })
}

#[tauri::command]
pub async fn sftp_realpath(conns: State<'_, SshConns>, conn: u32, path: String) -> R<String> {
    let c = conns.get(conn)?;
    c.sftp.canonicalize(path).await.map_err(sftp_err)
}

/// 원격에서 짧은 명령 하나 실행해 표준출력을 받는다(자동완성용 compgen 등). 1 MiB·10초 상한
#[tauri::command]
pub async fn ssh_exec(conns: State<'_, SshConns>, conn: u32, cmd: String) -> R<String> {
    let c = conns.get(conn)?;
    exec_out(&c, &cmd, Duration::from_secs(10)).await
}

// ── 파일 조작 ────────────────────────

#[tauri::command]
pub async fn sftp_mkdir(conns: State<'_, SshConns>, conn: u32, path: String) -> R<()> {
    let c = conns.get(conn)?;
    c.sftp.create_dir(path).await.map_err(sftp_err)
}

/// 빈 파일 만들기 — 이미 있으면 거절(덮어쓰지 않음)
#[tauri::command]
pub async fn sftp_touch(conns: State<'_, SshConns>, conn: u32, path: String) -> R<()> {
    let c = conns.get(conn)?;
    if c.sftp.try_exists(path.clone()).await.unwrap_or(false) {
        return Err(err("SFTP", "같은 이름이 이미 있습니다"));
    }
    c.sftp.create(path).await.map_err(sftp_err)?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(conns: State<'_, SshConns>, conn: u32, from: String, to: String) -> R<()> {
    let c = conns.get(conn)?;
    if c.sftp.try_exists(to.clone()).await.unwrap_or(false) {
        return Err(err("SFTP", "같은 이름이 이미 있습니다"));
    }
    c.sftp.rename(from, to).await.map_err(sftp_err)
}

/// 지우기 — 폴더면 안까지(화면이 먼저 확인을 받는다). 최상위(/)는 거절
#[tauri::command]
pub async fn sftp_remove(conns: State<'_, SshConns>, conn: u32, path: String) -> R<u32> {
    if path.trim_end_matches('/').is_empty() {
        return Err(err("SFTP", "최상위 폴더는 지울 수 없습니다"));
    }
    let c = conns.get(conn)?;
    remove(&c, path).await
}

pub(crate) async fn remove(c: &Conn, path: String) -> R<u32> {
    let m = c.sftp.symlink_metadata(path.clone()).await.map_err(sftp_err)?;
    if !m.is_dir() {
        // 파일·링크(링크 자체만)
        c.sftp.remove_file(path).await.map_err(sftp_err)?;
        return Ok(1);
    }
    // 폴더는 서버에서 rm -rf 한 번에(항목마다 SFTP 왕복하지 않게). 셸이 막힌 SFTP 전용 계정이면 SFTP 로 하나씩
    let p = crate::sudo::q(&path);
    // find 는 -- 를 모른다 — - 로 시작하는 상대 경로가 식으로 읽히지 않게 ./ 를 붙인다
    let fp = if path.starts_with('/') { p.clone() } else { crate::sudo::q(&format!("./{path}")) };
    let cmd = format!("n=$(find {fp} 2>/dev/null | wc -l); rm -rf -- {p} && printf '__rb_rm=%s' \"$n\"");
    match run_exec(c, &cmd, None, ExecLimit { idle: Duration::from_secs(300), total: None, max_out: 4096 }).await {
        // 표식이 있어야 rm 이 실제로 돌았다(명령을 무시하는 SFTP 전용 계정은 빈 출력·끝 코드 0)
        Ok(o) if o.code == Some(0) && String::from_utf8_lossy(&o.stdout).contains("__rb_rm=") => {
            let s = String::from_utf8_lossy(&o.stdout);
            Ok(s.rsplit("__rb_rm=").next().and_then(|n| n.trim().parse().ok()).unwrap_or(1))
        }
        Ok(o) if o.stderr.lines().any(|l| l.starts_with("rm: ")) => {
            // rm 이 일부를 못 지웠다(권한 등) — 그 까닭을
            Err(err("SFTP", o.stderr.trim().lines().rfind(|l| l.starts_with("rm: ")).unwrap_or("지우지 못했습니다").to_string()))
        }
        // 시간 초과는 그대로 알린다(서버에서 아직 지우는 중일 수 있어 SFTP 로 다시 돌지 않는다)
        Err(e) if e.code == "NETWORK" => Err(e),
        Ok(_) | Err(_) => Box::pin(remove_rec(c, path)).await,
    }
}

async fn remove_rec(c: &Conn, path: String) -> R<u32> {
    let m = c.sftp.symlink_metadata(path.clone()).await.map_err(sftp_err)?;
    if m.is_dir() {
        let mut n = 0;
        let kids: Vec<_> = c.sftp.read_dir(path.clone()).await.map_err(sftp_err)?.collect();
        for k in kids {
            let name = k.file_name();
            if name == "." || name == ".." {
                continue;
            }
            n += Box::pin(remove_rec(c, join(&path, &name))).await?;
        }
        c.sftp.remove_dir(path).await.map_err(sftp_err)?;
        Ok(n + 1)
    } else {
        c.sftp.remove_file(path).await.map_err(sftp_err)?;
        Ok(1)
    }
}

/// 시험용 — 암호로 접속하고 처음 키를 신뢰한다
#[cfg(test)]
pub(crate) async fn test_connect(store: &Store, conns: &SshConns, host: &str, port: u16, user: &str, pw: &str) -> u32 {
    let req = |trust: Option<String>| ConnectReq {
        profile_id: None,
        host: host.into(),
        port,
        username: user.into(),
        auth: "password".into(),
        key_path: None,
        secret: Some(pw.into()),
        legacy: "off".into(),
        trust_fingerprint: trust,
        save_secret: false,
        jump_id: None,
        account_id: None,
        route_id: None,
    };
    match connect(store, conns, req(None)).await {
        Ok(ok) => ok.conn_id,
        Err(e) => connect(store, conns, req(e.fingerprint)).await.unwrap().conn_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_lowest_level() {
        let s = |v: &[&str]| suggest_level(&v.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        assert_eq!(s(&["ssh-rsa", "ssh-dss"]), Some("rsa"));
        assert_eq!(s(&["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1"]), Some("sha1"));
        assert_eq!(s(&["diffie-hellman-group1-sha1"]), Some("weakest"));
        assert_eq!(s(&["aes128-cbc", "3des-cbc"]), Some("sha1"));
        assert_eq!(s(&["curve25519-sha256"]), None);
    }

    /// 실제 sshd 로 — `RB_SSH_TEST=127.0.0.1:22122:22123` 와 `RB_SSH_TEST_PW` 를 줄 때만(cargo test -- --ignored)
    #[tokio::test]
    #[ignore]
    async fn live_connect_pin_list_read_legacy() {
        let spec = std::env::var("RB_SSH_TEST").expect("RB_SSH_TEST=host:modernPort:legacyPort");
        let pw = std::env::var("RB_SSH_TEST_PW").expect("RB_SSH_TEST_PW");
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let modern: u16 = it.next().unwrap().parse().unwrap();
        let legacy: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-test-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let conns = SshConns::default();
        let req = |port: u16, level: &str, trust: Option<String>, secret: Option<&str>| ConnectReq {
            profile_id: None,
            host: host.clone(),
            port,
            username: "rbtest".into(),
            auth: "password".into(),
            key_path: None,
            secret: secret.map(Into::into),
            legacy: level.into(),
            trust_fingerprint: trust,
            save_secret: false,
            jump_id: None,
            account_id: None,
            route_id: None,
        };

        // 1) 처음 → 지문 확인 요구
        let e = connect(&store, &conns, req(modern, "off", None, Some(&pw))).await.err().unwrap();
        assert_eq!(e.code, "HOSTKEY_UNKNOWN");
        let fp = e.fingerprint.clone().unwrap();
        println!("modern 지문 {fp} ({:?})", e.algorithm);
        // 2) 확인 → 접속·고정
        let t0 = std::time::Instant::now();
        let ok = connect(&store, &conns, req(modern, "off", Some(fp.clone()), Some(&pw))).await.unwrap();
        println!("접속 {} ms, home {}", t0.elapsed().as_millis(), ok.home);
        assert!(ok.newly_pinned);
        // 3) 고정 뒤에는 묻지 않음
        let ok2 = connect(&store, &conns, req(modern, "off", None, Some(&pw))).await.unwrap();
        assert!(!ok2.newly_pinned);
        // 4) 틀린 암호
        let bad = connect(&store, &conns, req(modern, "off", None, Some("wrong-password"))).await.err().unwrap();
        assert_eq!(bad.code, "AUTH_FAILED");
        // 5) 목록·EUC-KR 읽기
        let entries = list(&conns, ok.conn_id, format!("{}/app", ok.home)).await.unwrap();
        println!("app/: {:?}", entries.iter().map(|e| format!("{}:{}", e.name, e.kind)).collect::<Vec<_>>());
        assert!(entries.iter().any(|e| e.name == "logs" && e.kind == "dir"));
        let f = read_text(&conns, ok.conn_id, format!("{}/app/euckr.txt", ok.home), None).await.unwrap();
        println!("euckr.txt → {} {} {:?}", f.meta.encoding, f.meta.eol, f.text);
        assert_eq!(f.meta.encoding, "EUC-KR");
        assert_eq!(f.meta.eol, "CRLF");
        assert!(f.text.unwrap().starts_with("안녕하세요"));

        // 6) 구형 흉내 서버: off 면 협상 실패 + 단계 제안
        let neg = connect(&store, &conns, req(legacy, "off", None, Some(&pw))).await.err().unwrap();
        println!("legacy off → {} {:?} theirs={:?} suggest={:?}", neg.code, neg.kind, neg.theirs, neg.suggest);
        assert_eq!(neg.code, "NEGOTIATION");
        let level = neg.suggest.unwrap();
        // 제안 단계로 올려 가며(단계 하나에 실패하면 다음 제안) 접속
        let mut level = level.to_string();
        let mut fp_legacy = None;
        for _ in 0..3 {
            match connect(&store, &conns, req(legacy, &level, fp_legacy.clone(), Some(&pw))).await {
                Ok(ok) => {
                    println!("legacy {level} 접속 성공, 키 {} {}", ok.algorithm, ok.fingerprint);
                    let _ = std::fs::remove_dir_all(&dir);
                    return;
                }
                Err(e) if e.code == "HOSTKEY_UNKNOWN" => fp_legacy = e.fingerprint,
                Err(e) if e.code == "NEGOTIATION" => {
                    println!("  {level} → 아직 {:?} {:?}", e.kind, e.theirs);
                    level = e.suggest.unwrap_or("weakest").to_string();
                }
                Err(e) => panic!("legacy {level}: {e:?}"),
            }
        }
        panic!("구형 흉내 서버에 붙지 못함");
    }

    #[test]
    fn tmux_numbers_line_and_list() {
        assert_eq!(free_number([].into_iter()), 1);
        assert_eq!(free_number([1, 2, 4].into_iter()), 3);
        assert_eq!(tmux_line(2, None), " exec tmux new-session -A -s rbs-2\n");
        assert_eq!(tmux_line(1, Some("/srv/it's")), " exec tmux new-session -A -s rbs-1 -c '/srv/it'\\''s'\n");
        let l = parse_tmux_ls("rbs-1\t2\t1\t1700000000\nwork\t1\t0\t1700000001\nrbs-x\t1\t0\t\n\n");
        assert_eq!(l.len(), 3);
        assert!(l[0].ours && l[0].windows == 2 && l[0].attached == 1 && l[0].created == Some(1_700_000_000));
        assert!(!l[1].ours && !l[2].ours);
    }

    #[test]
    fn password_prompts_only() {
        assert!(asks_password("Password: "));
        assert!(asks_password("(rbtest@host) Password:"));
        assert!(asks_password("암호:"));
        assert!(!asks_password("Verification code: "));
        assert!(!asks_password("Enter PASSCODE:"));
        assert!(!asks_password("New password: "));
        assert!(!asks_password("Retype new password: "));
        assert!(!asks_password("OTP Password: "));
        assert!(asks_password("Password for bob@decode01:"));
    }

    #[test]
    fn conflict_and_size_checks() {
        assert!(check_unchanged(Some(10), Some(5), Some(10), Some(5)).is_ok());
        assert_eq!(check_unchanged(Some(11), Some(5), Some(10), None).unwrap_err().code, "CONFLICT");
        assert_eq!(check_unchanged(Some(10), Some(6), Some(10), Some(5)).unwrap_err().code, "CONFLICT");
        // 파일이 없어졌으면(값 없음) 비교하지 않는다
        assert!(check_unchanged(None, None, Some(10), Some(5)).is_ok());
        assert!(check_written(Some(3), 3).is_ok());
        assert_eq!(check_written(Some(4), 3).unwrap_err().code, "SIZE_MISMATCH");
    }

    #[test]
    fn levels_add_algorithms() {
        assert!(!preferred("off").key.contains(&Algorithm::Rsa { hash: None }));
        assert!(preferred("rsa").key.contains(&Algorithm::Rsa { hash: None }));
        assert!(preferred("sha1").kex.contains(&kex::DH_G14_SHA1));
        assert!(!preferred("sha1").kex.contains(&kex::DH_G1_SHA1));
        assert!(preferred("weakest").key.contains(&Algorithm::Dsa));
        assert!(preferred("weakest").cipher.contains(&cipher::TRIPLE_DES_CBC));
    }
}

#[cfg(test)]
mod live_jump {
    use super::*;

    /// RB_SSH_TEST(점프=최신 sshd)·RB_JUMP_TARGET(점프 서버에서 본 대상 IP:포트)·RB_SSH_TEST_PW
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_connect_through_jump() {
        let spec = std::env::var("RB_SSH_TEST").unwrap();
        let target = std::env::var("RB_JUMP_TARGET").unwrap();
        let pw = std::env::var("RB_SSH_TEST_PW").unwrap();
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let (th, tp) = target.split_once(':').unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-jump-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let conns = SshConns::default();
        test_connect(&store, &conns, &host, port, "rbtest", &pw).await; // 점프 서버 키 고정
        let jid = crate::store::profile_save_core(&store, &host, port, "rbtest");
        let jacc = store.default_account(jid).unwrap().id.unwrap();
        secrets::set(&secrets::account_key(jacc), &pw).unwrap();
        let req = |trust: Option<String>| ConnectReq {
            profile_id: None,
            host: th.into(),
            port: tp.parse().unwrap(),
            username: "rbtest".into(),
            auth: "password".into(),
            key_path: None,
            secret: Some(pw.clone()),
            legacy: "sha1".into(),
            trust_fingerprint: trust,
            save_secret: false,
            jump_id: Some(jid),
            account_id: None,
            route_id: None,
        };
        let t = std::time::Instant::now();
        let ok = match connect(&store, &conns, req(None)).await {
            Ok(ok) => ok,
            Err(e) => {
                println!("대상 지문 확인 요구 → {} {:?}", e.code, e.fingerprint);
                connect(&store, &conns, req(e.fingerprint)).await.unwrap()
            }
        };
        println!("점프 거쳐 접속 {} ms, 대상 키 {} home {}", t.elapsed().as_millis(), ok.algorithm, ok.home);
        let l = list(&conns, ok.conn_id, ok.home.clone()).await.unwrap();
        assert!(l.iter().any(|e| e.name == "app"));
        secrets::forget(&secrets::account_key(jacc));
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod live_save {
    use super::*;

    /// RB_SSH_TEST·RB_SSH_TEST_PW — 저장 잘림(짧게 고친 저장에 옛 꼬리가 남지 않음)·없는 파일 저장·크기 충돌·
    /// exec 시간 초과·폴더 지우기(rm -rf)·링크 폴더 목록
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_save_truncates_and_exec_limits() {
        let spec = std::env::var("RB_SSH_TEST").unwrap();
        let pw = std::env::var("RB_SSH_TEST_PW").unwrap();
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-save-{}", std::process::id()));
        let store = Store::open(dir.clone(), false).unwrap();
        let conns = SshConns::default();
        let cid = test_connect(&store, &conns, &host, port, "rbtest", &pw).await;
        let c = conns.get(cid).unwrap();
        let base = "/home/rbtest/rb-save-test";
        let _ = run_exec(&c, &format!("rm -rf {base}; mkdir -p {base}/d/e && touch {base}/d/e/f {base}/d/g && ln -s {base}/d {base}/link"), None, ExecLimit { idle: Duration::from_secs(10), total: None, max_out: 1024 }).await.unwrap();

        // 1) 긴 내용 → 짧은 내용: 옛 꼬리가 남으면 안 된다
        let f = format!("{base}/a.txt");
        sftp_overwrite(&c.sftp, &f, "0123456789\n".repeat(100).as_bytes()).await.unwrap();
        let m = sftp_overwrite(&c.sftp, &f, b"short\n").await.unwrap();
        assert_eq!(m.size, Some(6));
        assert_eq!(c.sftp.read(f.clone()).await.unwrap(), b"short\n");
        // 2) 없는 파일 저장 = 새로 만든다
        let n = format!("{base}/new.txt");
        sftp_overwrite(&c.sftp, &n, b"hello").await.unwrap();
        assert_eq!(c.sftp.read(n.clone()).await.unwrap(), b"hello");
        // 3) 크기로 충돌 판정 — mtime 이 같아도(같은 초) 크기가 다르면 CONFLICT
        let now = c.sftp.metadata(f.clone()).await.unwrap();
        assert!(check_unchanged(now.mtime, now.size, now.mtime, Some(6)).is_ok());
        assert_eq!(check_unchanged(now.mtime, now.size, now.mtime, Some(7)).unwrap_err().code, "CONFLICT");
        assert!(check_unchanged(now.mtime, now.size, None, None).is_ok());
        // 4) 링크가 가리키는 폴더는 폴더로
        let l = list(&conns, cid, base.to_string()).await.unwrap();
        let link = l.iter().find(|e| e.name == "link").unwrap();
        assert_eq!(link.kind, "dir");
        assert_eq!(link.target.as_deref(), Some(format!("{base}/d").as_str()));
        // 5) exec 시간 초과는 상한 안에 NETWORK 로 끝나고, 같은 연결은 계속 쓸 수 있다
        let t = std::time::Instant::now();
        let e = run_exec(&c, "sleep 20", None, ExecLimit { idle: Duration::from_secs(1), total: None, max_out: 1024 }).await.err().unwrap();
        assert_eq!(e.code, "NETWORK");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        let cut = run_exec(&c, "yes | head -c 100000", None, ExecLimit { idle: Duration::from_secs(5), total: None, max_out: 1000 }).await.unwrap();
        assert!(cut.cut && cut.stdout.len() == 1000);
        assert_eq!(exec_out(&c, "printf ok", Duration::from_secs(5)).await.unwrap(), "ok");
        // 6) 폴더 지우기 — rm -rf 한 번(링크는 링크만)
        assert_eq!(remove(&c, format!("{base}/link")).await.unwrap(), 1);
        assert!(c.sftp.try_exists(format!("{base}/d/e/f")).await.unwrap(), "링크를 지울 때 가리키는 폴더 안은 남는다");
        let k = remove(&c, format!("{base}/d")).await.unwrap();
        assert_eq!(k, 4, "d, d/e, d/e/f, d/g");
        assert!(!c.sftp.try_exists(format!("{base}/d")).await.unwrap());
        remove(&c, base.to_string()).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
