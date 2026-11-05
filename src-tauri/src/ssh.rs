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
use crate::store::{PinnedKey, Store};
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
}

impl client::Handler for Client {
    type Error = russh::Error;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectReq {
    profile_id: Option<i64>,
    host: String,
    port: u16,
    username: String,
    /// "password" | "key"
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Closed {
    conn: u32,
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, store: State<'_, Store>, conns: State<'_, SshConns>, req: ConnectReq) -> R<ConnectOk> {
    let ok = connect(&store, &conns, req).await?;
    // 끊김 감시 — 서버가 끊거나 네트워크가 끊기면(keepalive 30초×4) 화면에 알린다
    let id = ok.conn_id;
    let c = conns.get(id)?;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if Arc::strong_count(&c) <= 1 {
                break; // 화면이 연결을 닫음
            }
            if c.handle.is_closed() {
                let _ = app.emit("ssh-closed", Closed { conn: id });
                break;
            }
        }
    });
    Ok(ok)
}

pub(crate) async fn connect(store: &Store, conns: &SshConns, req: ConnectReq) -> R<ConnectOk> {
    let pinned = store.host_key(&req.host, req.port);
    let seen = Arc::new(Mutex::new(None));
    let handler = Client { pinned: pinned.clone(), trust: req.trust_fingerprint.clone(), seen: seen.clone() };
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

    // 인증
    let mut used_saved = false;
    let secret = match req.secret.clone().filter(|s| !s.is_empty()) {
        Some(s) => Some(s),
        None => {
            let saved = req.profile_id.and_then(|id| secrets::get(&format!("profile:{id}")));
            used_saved = saved.is_some();
            saved
        }
    };
    let ok = if req.auth == "key" {
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
            if let Some(id) = req.profile_id {
                secrets::forget(&format!("profile:{id}"));
                store.mark_used(id, Some(false));
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
    if let Some(id) = req.profile_id {
        let mut saved = None;
        if req.save_secret {
            if let Some(s) = secret.as_deref().filter(|_| !used_saved) {
                saved = Some(secrets::set(&format!("profile:{id}"), s).is_ok());
            }
        }
        store.mark_used(id, saved);
    }

    let ch = handle.channel_open_session().await.map_err(map_russh)?;
    ch.request_subsystem(true, "sftp").await.map_err(map_russh)?;
    let sftp = SftpSession::new(ch.into_stream()).await.map_err(|e| err("SFTP", format!("SFTP 를 열지 못했습니다: {e}")))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());

    let id = conns.next.fetch_add(1, Ordering::Relaxed) + 1;
    conns.map.lock().unwrap().insert(
        id,
        Arc::new(Conn { handle, _jump: jump, sftp, shells: Default::default(), next_shell: AtomicU32::new(0) }),
    );
    Ok(ConnectOk {
        conn_id: id,
        home,
        fingerprint: seen_key.fingerprint,
        algorithm: seen_key.algorithm,
        newly_pinned,
        used_saved_secret: used_saved,
    })
}

/// 점프 호스트 접속 — 고정된 호스트 키·저장된 비밀만 쓴다(여기서는 묻지 않는다)
async fn connect_jump(store: &Store, jid: i64) -> R<Handle<Client>> {
    let p = store.profile(jid).map_err(|e| err("OTHER", format!("점프 호스트 프로필: {e}")))?;
    let pinned = store
        .host_key(&p.host, p.port)
        .ok_or_else(|| err("OTHER", format!("점프 호스트 {} 의 호스트 키가 아직 고정되지 않았습니다. 그 프로필로 한 번 직접 접속해 지문을 확인하세요.", p.name)))?;
    let handler = Client { pinned: Some(pinned), trust: None, seen: Arc::new(Mutex::new(None)) };
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
    let secret = secrets::get(&format!("profile:{jid}"));
    let ok = if p.auth == "key" {
        let path = p.key_path.clone().unwrap_or_default();
        let key = load_secret_key(&path, secret.as_deref()).map_err(|e| err("AUTH_FAILED", format!("점프 호스트 개인키: {e}")))?;
        let hash = h.best_supported_rsa_hash().await.map_err(map_russh)?.flatten();
        h.authenticate_publickey(&p.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(map_russh)?.success()
    } else {
        let pw = secret.ok_or_else(|| err("OTHER", format!("점프 호스트 {} 의 암호가 저장돼 있지 않습니다. 그 프로필로 접속하며 \"암호 저장\"을 켜 주세요.", p.name)))?;
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
    let ch = c.handle.channel_open_session().await.map_err(map_russh)?;
    ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(map_russh)?;
    ch.request_shell(true).await.map_err(map_russh)?;
    let (mut read, write) = ch.split();
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
    line.push_str("; clear\n");
    let _ = write.data(line.as_bytes()).await;
    let shell = c.next_shell.fetch_add(1, Ordering::Relaxed) + 1;
    c.shells.lock().await.insert(shell, write);
    let conns_map = c.clone();
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
        conns_map.shells.lock().await.remove(&shell);
        let _ = app.emit("ssh-shell-exit", ShellExit { conn, shell, code });
    });
    Ok(shell)
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
        if kind == "link" {
            // 링크가 가리키는 것이 폴더면 폴더처럼 펼친다
            if let Ok(t) = c.sftp.metadata(full.clone()).await {
                if t.is_dir() {
                    kind = "dir";
                }
            }
        }
        out.push(FsEntry { name, path: full, kind, size: m.size.unwrap_or(0), mtime: m.mtime, mode: m.permissions });
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
        return Ok(FileText {
            path,
            size,
            mtime: m.mtime,
            text: None,
            meta: TextMeta { encoding: "UTF-8".into(), bom: false, eol: "LF".into(), guessed: false },
            binary: false,
            too_large: true,
        });
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
        secrets::set(&format!("profile:{jid}"), &pw).unwrap();
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
        secrets::forget(&format!("profile:{jid}"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
