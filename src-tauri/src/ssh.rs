//! SSH 접속 — russh 클라이언트 하나에 터미널 채널 여러 개 + SFTP 채널 하나.
//! - 호스트 키: 처음엔 지문을 보여 주고 사용자가 확인하면 고정(TOFU). 바뀌면 인증 전에 끊는다.
//! - 구형 호환 단계(off·rsa·sha1·weakest): 그 연결에만 오래된 알고리즘을 더한다.
//!   협상이 실패하면 서버가 내민 목록으로 가장 낮은 단계를 제안한다.
//! - 비밀(암호·개인키 암호)은 접속에 성공한 뒤에만, 사용자가 원할 때 OS 자격 증명 저장소에 넣는다.

// 오류는 화면에 그대로 넘기는 드문 경로라 크기를 줄이지 않는다
#![allow(clippy::result_large_err)]

use std::borrow::Cow;
use std::collections::HashMap;
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
}

impl SshError {
    pub(crate) fn message_owned(self) -> String {
        self.message
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

fn map_russh(e: russh::Error) -> SshError {
    match e {
        russh::Error::NoCommonAlgo { kind, ours: _, theirs } => {
            let suggest = suggest_level(&theirs);
            SshError {
                code: "NEGOTIATION",
                message: format!("서버와 맞는 {kind:?} 알고리즘이 없습니다"),
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
    seen: Arc<Mutex<Option<PinnedKey>>>,
    /// 원격 포워딩(서버 포트 → 내 PC 쪽 대상) — 서버가 그 포트로 들어온 연결을 채널로 열어 준다
    remote: crate::tunnel::RemoteMap,
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
            (None, None) => false,
        };
        *self.seen.lock().unwrap() = Some(seen);
        Ok(ok)
    }
}

// ── 연결 상태 ────────────────────────

pub(crate) struct Conn {
    handle: Handle<Client>,
    /// 점프 호스트 연결 — 대상 연결이 살아 있는 동안 함께 둔다
    _jump: Option<Handle<Client>>,
    pub(crate) sftp: SftpSession,
    shells: tokio::sync::Mutex<HashMap<u32, ChannelWriteHalf<Msg>>>,
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
    pub(crate) jump: Option<Handle<Client>>,
    seen_key: PinnedKey,
    newly_pinned: bool,
    used_saved: bool,
    account: Option<Account>,
    remote: crate::tunnel::RemoteMap,
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
    })
}

/// 요청의 계정 id(터널 SSH 연결을 나눠 쓰는 열쇠)
pub(crate) fn req_account(req: &ConnectReq) -> Option<i64> {
    req.account_id
}

pub(crate) async fn connect(store: &Store, conns: &SshConns, req: ConnectReq) -> R<ConnectOk> {
    let a = open_authed(store, &req).await?;
    let Authed { handle, jump, seen_key, newly_pinned, used_saved, account, remote } = a;
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
            tmux_used: Default::default(),
            remote,
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
    })
}

/// 붙고(점프 호스트를 거치면 거쳐) 호스트 키를 확인하고 인증한다. 처음 키면 고정, 원하면 비밀 저장
pub(crate) async fn open_authed(store: &Store, req: &ConnectReq) -> R<Authed> {
    let pinned = store.host_key(&req.host, req.port);
    let seen = Arc::new(Mutex::new(None));
    let remote = crate::tunnel::RemoteMap::default();
    let handler = Client { pinned: pinned.clone(), trust: req.trust_fingerprint.clone(), seen: seen.clone(), remote: remote.clone() };
    let config = Arc::new(client::Config {
        preferred: preferred(&req.legacy),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        nodelay: true,
        ..Default::default()
    });

    // 점프 호스트를 거치면: 점프 서버에 붙어 인증하고, 그 안에서 대상으로 TCP 채널을 열어 그 위에 SSH 를 다시 연다
    let jump = match req.jump_id {
        Some(jid) => Some(connect_jump(store, jid).await?),
        None => None,
    };
    let connected = match &jump {
        Some(j) => {
            let ch = j
                .channel_open_direct_tcpip(req.host.clone(), req.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| err("NETWORK", format!("점프 호스트에서 {}:{} 로 가는 길을 열지 못했습니다: {e}", req.host, req.port)))?;
            tokio::time::timeout(CONNECT_TIMEOUT, client::connect_stream(config, ch.into_stream(), handler)).await
        }
        None => tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (req.host.as_str(), req.port), handler)).await,
    }
    .map_err(|_| err("NETWORK", format!("{}:{} 에 {}초 안에 닿지 못했습니다", req.host, req.port, CONNECT_TIMEOUT.as_secs())))?;
    let mut handle = match connected {
        Ok(h) => h,
        Err(e) => {
            // 호스트 키를 거절한 경우: 모르는 키인지 바뀐 키인지 알려 준다
            if let Some(s) = seen.lock().unwrap().clone() {
                let accepted = req.trust_fingerprint.as_deref() == Some(&s.fingerprint)
                    || pinned.as_ref().map(|p| p.fingerprint == s.fingerprint).unwrap_or(false);
                if !accepted {
                    let mismatch = pinned.is_some();
                    return Err(SshError {
                        code: if mismatch { "HOSTKEY_MISMATCH" } else { "HOSTKEY_UNKNOWN" },
                        message: if mismatch {
                            "서버의 호스트 키가 고정한 키와 다릅니다. 서버를 다시 설치했거나 다른 서버로 연결되고 있을 수 있습니다.".into()
                        } else {
                            "처음 접속하는 서버입니다. 지문을 확인하세요.".into()
                        },
                        fingerprint: Some(s.fingerprint),
                        algorithm: Some(s.algorithm),
                        pinned_fingerprint: pinned.map(|p| p.fingerprint),
                        ..Default::default()
                    });
                }
            }
            return Err(map_russh(e));
        }
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
    let ok = if req.auth == "agent" {
        agent_auth(&mut handle, &req.username).await?
    } else if req.auth == "key" {
        let path = req.key_path.clone().filter(|p| !p.is_empty()).ok_or_else(|| err("OTHER", "개인키 파일을 고르세요"))?;
        let key = match load_secret_key(&path, secret.as_deref()) {
            Ok(k) => k,
            Err(russh::keys::Error::KeyIsEncrypted) => return Err(err("NEED_SECRET", "개인키 암호를 입력하세요")),
            Err(e) => return Err(err("AUTH_FAILED", format!("개인키를 읽지 못했습니다: {e}"))),
        };
        let hash = handle.best_supported_rsa_hash().await.map_err(map_russh)?.flatten();
        handle
            .authenticate_publickey(&req.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(map_russh)?
            .success()
    } else {
        let Some(pw) = secret.clone() else {
            return Err(err("NEED_SECRET", "암호를 입력하세요"));
        };
        let mut ok = handle.authenticate_password(&req.username, &pw).await.map_err(map_russh)?.success();
        if !ok {
            // 암호 방식이 꺼지고 keyboard-interactive 만 켠 서버(흔함)
            ok = keyboard_interactive(&mut handle, &req.username, &pw).await.unwrap_or(false);
        }
        ok
    };
    if !ok {
        if used_saved {
            if let Some(id) = aid {
                secrets::forget(&secrets::account_key(id));
                store.mark_account_used(id, Some(false));
            }
        }
        return Err(err("AUTH_FAILED", if used_saved { "저장한 암호가 맞지 않아 지웠습니다. 다시 입력하세요." } else { "계정 또는 암호가 맞지 않습니다" }));
    }

    // 접속 성공 — 처음 키면 고정, 원하면 비밀 저장
    let seen_key = seen.lock().unwrap().clone().ok_or_else(|| err("OTHER", "호스트 키를 받지 못했습니다"))?;
    let newly_pinned = pinned.as_ref().map(|p| p.fingerprint != seen_key.fingerprint).unwrap_or(true);
    if newly_pinned {
        store.pin_host_key(&req.host, req.port, &seen_key).map_err(|e| err("OTHER", e))?;
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
    Ok(Authed { handle, jump, seen_key, newly_pinned, used_saved, account, remote })
}

/// 점프 호스트 접속 — 고정된 호스트 키·저장된 비밀만 쓴다(여기서는 묻지 않는다)
async fn connect_jump(store: &Store, jid: i64) -> R<Handle<Client>> {
    let p = store.profile(jid).map_err(|e| err("OTHER", format!("점프 호스트 프로필: {e}")))?;
    let pinned = store
        .host_key(&p.host, p.port)
        .ok_or_else(|| err("OTHER", format!("점프 호스트 {} 의 호스트 키가 아직 고정되지 않았습니다. 그 프로필로 한 번 직접 접속해 지문을 확인하세요.", p.name)))?;
    let handler = Client { pinned: Some(pinned), trust: None, seen: Arc::new(Mutex::new(None)), remote: Default::default() };
    let config = Arc::new(client::Config {
        preferred: preferred(&p.legacy),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        nodelay: true,
        ..Default::default()
    });
    let mut h = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (p.host.as_str(), p.port), handler))
        .await
        .map_err(|_| err("NETWORK", format!("점프 호스트 {} 에 닿지 못했습니다", p.name)))?
        .map_err(|e| {
            let mut x = map_russh(e);
            x.message = format!("점프 호스트 {}: {}", p.name, x.message);
            x
        })?;
    // 점프 호스트는 그 서버의 기본 계정으로
    let a = store.default_account(jid).map_err(|e| err("OTHER", format!("점프 호스트 {}: {e}", p.name)))?;
    let p = crate::store::Profile { username: a.username.clone(), auth: a.auth.clone(), key_path: a.key_path.clone(), ..p };
    let secret = a.id.and_then(|id| secrets::get(&secrets::account_key(id)));
    let ok = if p.auth == "agent" {
        agent_auth(&mut h, &p.username).await.map_err(|mut x| {
            x.message = format!("점프 호스트 {}: {}", p.name, x.message);
            x
        })?
    } else if p.auth == "key" {
        let path = p.key_path.clone().unwrap_or_default();
        let key = load_secret_key(&path, secret.as_deref()).map_err(|e| err("AUTH_FAILED", format!("점프 호스트 개인키: {e}")))?;
        let hash = h.best_supported_rsa_hash().await.map_err(map_russh)?.flatten();
        h.authenticate_publickey(&p.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(map_russh)?.success()
    } else {
        let pw = secret.ok_or_else(|| err("OTHER", format!("점프 호스트 {} 의 암호가 저장돼 있지 않습니다. 그 서버의 기본 계정으로 접속하며 \"암호 저장\"을 켜 주세요.", p.name)))?;
        let mut ok = h.authenticate_password(&p.username, &pw).await.map_err(map_russh)?.success();
        if !ok {
            ok = keyboard_interactive(&mut h, &p.username, &pw).await.unwrap_or(false);
        }
        ok
    };
    if !ok {
        return Err(err("AUTH_FAILED", format!("점프 호스트 {} 인증에 실패했습니다", p.name)));
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

async fn keyboard_interactive(handle: &mut Handle<Client>, user: &str, pw: &str) -> Result<bool, russh::Error> {
    use russh::client::KeyboardInteractiveAuthResponse as K;
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None::<String>).await?;
    for _ in 0..4 {
        match resp {
            K::Success => return Ok(true),
            K::Failure { .. } => return Ok(false),
            K::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| pw.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
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
pub async fn ssh_disconnect(conns: State<'_, SshConns>, conn: u32) -> R<()> {
    crate::tunnel::stop_conn(conn).await;
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
    let ch = c.handle.channel_open_session().await.map_err(map_russh)?;
    ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(map_russh)?;
    ch.request_shell(true).await.map_err(map_russh)?;
    let (read, write) = ch.split();
    let shell = c.next_shell.fetch_add(1, Ordering::Relaxed) + 1;
    if use_tmux {
        let n = c.tmux_alloc(shell);
        let _ = write.data(tmux_line(n, cwd.as_deref()).as_bytes()).await;
        c.shells.lock().await.insert(shell, write);
        spawn_shell_reader(app, c.clone(), conn, shell, read, on_data);
        return Ok(shell);
    }
    // 셸 통합(bash) — 서버 파일은 바꾸지 않고 이 셸에만 PROMPT_COMMAND 를 얹는다. 프롬프트마다:
    //   OSC 133;D;종료코드(앞 명령 끝) · OSC 7 지금 폴더(트리 따라가기) · OSC 6974 uid(root 표시) · OSC 133;A(프롬프트 시작)
    //   (exit $__rb_s) 로 $? 를 되돌려 원래 PROMPT_COMMAND·PS1 이 같은 값을 본다. 끝맺음은 모두 BEL.
    // 앞 공백 = 셸 기록에 남지 않게(HISTCONTROL=ignorespace). 끝에 clear 로 이 줄을 화면에서 지운다.
    let mut line = String::from(
        r#" [ -n "$BASH_VERSION" ] && PROMPT_COMMAND='__rb_s=$?; printf "\033]133;D;%s\007\033]7;file://%s%s\007\033]6974;%s\007\033]133;A\007" "$__rb_s" "${HOSTNAME:-}" "$PWD" "$EUID"; (exit $__rb_s)'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}""#,
    );
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        line.push_str(&format!("; cd '{}'", dir.replace('\'', "'\\''")));
    }
    line.push_str("; clear");
    // tmux 로 열라고 했는데 서버에 없으면 이 연결에서 한 번만 알린다
    if c.tmux && c.tmux_ok.compare_exchange(2, 3, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
        line.push_str(r"; printf '\r\n[RuiBotte] 서버에 tmux 가 없어 일반 셸로 열었습니다. 끊기면 이어지지 않습니다(설치 예: sudo apt install tmux).\r\n'");
    }
    line.push('\n');
    let _ = write.data(line.as_bytes()).await;
    c.shells.lock().await.insert(shell, write);
    spawn_shell_reader(app, c.clone(), conn, shell, read, on_data);
    Ok(shell)
}

/// 셸 출력을 화면으로 — 끝나면 채널·tmux 번호를 정리하고 알린다
fn spawn_shell_reader(app: AppHandle, c: Arc<Conn>, conn: u32, shell: u32, mut read: russh::ChannelReadHalf, on_data: Channel<InvokeResponseBody>) {
    tauri::async_runtime::spawn(async move {
        let mut code = None;
        while let Some(msg) = read.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if on_data.send(InvokeResponseBody::Raw(data.to_vec())).is_err() {
                        break;
                    }
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        c.shells.lock().await.remove(&shell);
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

/// 짧은 명령 하나 — 표준출력(1 MiB 상한)
async fn exec_out(c: &Conn, cmd: &str, limit: Duration) -> R<String> {
    let run = async {
        let mut ch = c.handle.channel_open_session().await.map_err(map_russh)?;
        ch.exec(true, cmd).await.map_err(map_russh)?;
        let mut out = Vec::new();
        while let Some(m) = ch.wait().await {
            if let ChannelMsg::Data { data } = m {
                out.extend_from_slice(&data);
                if out.len() > 1024 * 1024 {
                    break;
                }
            }
        }
        Ok::<_, SshError>(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(limit, run).await.map_err(|_| err("NETWORK", "응답이 없습니다"))?
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

#[tauri::command]
pub async fn ssh_shell_write(conns: State<'_, SshConns>, conn: u32, shell: u32, data: String, encoding: Option<String>) -> R<()> {
    let c = conns.get(conn)?;
    let shells = c.shells.lock().await;
    let w = shells.get(&shell).ok_or_else(|| err("CLOSED", "터미널이 닫혔습니다"))?;
    // 터미널 인코딩이 UTF-8 이 아니면(EUC-KR 서버) 입력 글자를 그 인코딩으로 바꿔 보낸다
    match encoding.as_deref().filter(|e| !e.eq_ignore_ascii_case("utf-8")) {
        Some(label) => {
            let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
            let (bytes, _, _) = enc.encode(&data);
            w.data(bytes.as_ref()).await.map_err(map_russh)
        }
        None => w.data(data.as_bytes()).await.map_err(map_russh),
    }
}

/// sudo 암호를 이 터미널에 넣는다(암호 묻는 줄에서) — 값은 화면으로 돌아가지 않는다. 넣을 암호가 없으면 false
#[tauri::command]
pub async fn ssh_shell_sudo_pw(conns: State<'_, SshConns>, conn: u32, shell: u32) -> R<bool> {
    let c = conns.get(conn)?;
    let Some(pw) = crate::sudo::password_of(&c) else {
        return Ok(false);
    };
    let shells = c.shells.lock().await;
    let w = shells.get(&shell).ok_or_else(|| err("CLOSED", "터미널이 닫혔습니다"))?;
    w.data(format!("{pw}\n").as_bytes()).await.map_err(map_russh)?;
    Ok(true)
}

#[tauri::command]
pub async fn ssh_shell_resize(conns: State<'_, SshConns>, conn: u32, shell: u32, cols: u32, rows: u32) -> R<()> {
    let c = conns.get(conn)?;
    let shells = c.shells.lock().await;
    if let Some(w) = shells.get(&shell) {
        w.window_change(cols, rows, 0, 0).await.map_err(map_russh)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_close(conns: State<'_, SshConns>, conn: u32, shell: u32) -> R<()> {
    if let Ok(c) = conns.get(conn) {
        if let Some(w) = c.shells.lock().await.remove(&shell) {
            let _ = w.close().await;
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
    let c = conns.get(conn)?;
    let dir = c.sftp.read_dir(path.clone()).await.map_err(sftp_err)?;
    let mut out: Vec<FsEntry> = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let m = e.metadata();
        let mut kind = if m.is_dir() {
            "dir"
        } else if m.is_symlink() {
            "link"
        } else if m.is_regular() {
            "file"
        } else {
            "other"
        };
        let full = join(&path, &name);
        let target = if kind == "link" { c.sftp.read_link(full.clone()).await.ok() } else { None };
        if kind == "link" {
            // 링크가 가리키는 것이 폴더면 폴더처럼 펼친다
            if let Ok(t) = c.sftp.metadata(full.clone()).await {
                if t.is_dir() {
                    kind = "dir";
                }
            }
        }
        out.push(FsEntry { name, path: full, kind, size: m.size.unwrap_or(0), mtime: m.mtime, mode: m.permissions, target });
    }
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

/// 저장 — 연 뒤 서버에서 바뀌었으면(mtime·크기) 덮어쓰지 않고 알린다(expectMtime 을 주면)
#[tauri::command]
pub async fn sftp_write_text(
    conns: State<'_, SshConns>,
    conn: u32,
    path: String,
    text: String,
    meta: TextMeta,
    expect_mtime: Option<u32>,
) -> R<Saved> {
    let c = conns.get(conn)?;
    if let Some(exp) = expect_mtime {
        if let Ok(m) = c.sftp.metadata(path.clone()).await {
            if m.mtime.is_some_and(|t| t != exp) {
                return Err(err("CONFLICT", "연 뒤에 서버에서 파일이 바뀌었습니다. 다시 열어 확인하세요."));
            }
        }
    }
    let bytes = textcodec::encode(&text, &meta).map_err(|e| err("ENCODING", e))?;
    // 같은 파일에 덮어써 소유자·권한을 지킨다(TRUNCATE)
    c.sftp.write(path.clone(), &bytes).await.map_err(sftp_err)?;
    let m = c.sftp.metadata(path).await.map_err(sftp_err)?;
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
    let run = async {
        let mut ch = c.handle.channel_open_session().await.map_err(map_russh)?;
        ch.exec(true, cmd.as_str()).await.map_err(map_russh)?;
        let mut out = Vec::new();
        while let Some(m) = ch.wait().await {
            if let ChannelMsg::Data { data } = m {
                out.extend_from_slice(&data);
                if out.len() > 1024 * 1024 {
                    break;
                }
            }
        }
        Ok::<_, SshError>(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(10), run).await.map_err(|_| err("NETWORK", "응답이 없습니다"))?
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
    Box::pin(remove_rec(&c, path)).await
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
