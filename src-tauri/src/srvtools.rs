//! 서버 도구 칸의 바탕 — 서비스(systemd)·Docker·파일 내용 찾기·웹 포트 화면이 쓴다.
//! - srv_run: 명령 하나를 돌려 종료 코드·표준 출력·오류 출력을 한꺼번에(필요하면 sudo, 시간 제한)
//! - srv_stream_open/close: 끝나지 않는 명령(journalctl -f·docker logs -f·grep)의 출력을 바이너리 채널로 흘려 보낸다.
//!   닫으면 채널 입력을 닫고(EOF) 서버 쪽 감시 셸이 그 프로세스 묶음을 끝낸다 — 출력이 뜸한 명령도 바로 멈춘다.
//! - local_grep: 내 PC 폴더에서 낱말 찾기(묶음으로 흘려 보냄·취소). 정규식은 화면이 파일 목록만 받아 직접 맞춘다.
//! - web_forward_*: 서버 포트 하나를 내 PC 127.0.0.1 빈 포트로 잠깐 잇는다(저장하지 않는 포워딩 — 웹 화면 열기용)
//!
//! 명령은 늘 `sh -c '…'` 로 감싼다(로그인 셸이 fish·csh 여도 같은 문법).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpListener;

use crate::ssh::{err, Conn, SshConns, R};
use crate::sudo::q;

/// srv_run 이 받아 두는 표준 출력 상한 — 넘으면 자르고 truncated
const MAX_OUT: usize = 4 * 1024 * 1024;

// ── 명령 하나 ─────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunOut {
    code: Option<u32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}

/// sudo 를 붙인 꼴 — 계정 설정(안 씀이면 거절, 대상 사용자면 -u)
fn with_sudo(c: &Conn, inner: &str) -> R<String> {
    let cfg = c.sudo.lock().unwrap().clone();
    if cfg.mode == "off" {
        return Err(err("AUTH_FAILED", "이 계정은 sudo 를 쓰지 않게 설정돼 있습니다 — 계정 설정에서 sudo 를 켜세요"));
    }
    let wrapped = format!("sh -c {}", q(inner));
    Ok(if cfg.user.is_empty() || cfg.user == "root" { format!("sudo -n -- {wrapped}") } else { format!("sudo -n -u {} -- {wrapped}", q(&cfg.user)) })
}

fn needs_password(code: Option<u32>, stderr: &str) -> bool {
    code != Some(0) && (stderr.contains("password is required") || stderr.contains("a terminal is required"))
}

async fn exec_once(c: &Conn, cmd: &str) -> R<RunOut> {
    let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.exec(true, cmd).await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.eof().await.map_err(|e| err("OTHER", e.to_string()))?;
    let (mut out, mut errb) = (Vec::new(), Vec::new());
    let (mut code, mut truncated) = (None, false);
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } => {
                if out.len() < MAX_OUT {
                    out.extend_from_slice(&data[..data.len().min(MAX_OUT - out.len())]);
                } else {
                    truncated = true;
                }
            }
            ChannelMsg::ExtendedData { data, .. } => {
                if errb.len() < 64 * 1024 {
                    errb.extend_from_slice(&data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    Ok(RunOut { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&errb).into_owned(), truncated })
}

/// sudo 인증 — 이미 되면 그대로, 암호가 필요하면 이번에 넣은(또는 저장한) 암호로 한 번(없으면 NEED_SECRET)
async fn ensure_sudo(c: &Conn) -> R<()> {
    let probe = exec_once(c, &with_sudo(c, "true")?).await?;
    if probe.code == Some(0) {
        return Ok(());
    }
    if needs_password(probe.code, &probe.stderr) {
        crate::sudo::sudo(c, "true", None).await?;
        return Ok(());
    }
    let msg = probe.stderr.lines().last().unwrap_or("sudo 실패").to_string();
    if msg.contains("not in the sudoers") || msg.contains("may not run sudo") {
        return Err(err("AUTH_FAILED", "이 계정은 sudo 를 쓸 수 없습니다"));
    }
    Err(err("OTHER", msg))
}

pub(crate) async fn run(c: &Conn, cmd: &str, sudo: bool) -> R<RunOut> {
    if !sudo {
        return exec_once(c, &format!("sh -c {}", q(cmd))).await;
    }
    let full = with_sudo(c, cmd)?;
    let o = exec_once(c, &full).await?;
    if !needs_password(o.code, &o.stderr) {
        return Ok(o);
    }
    ensure_sudo(c).await?;
    exec_once(c, &full).await
}

/// 명령 하나 — 실패(0 이 아닌 종료 코드)도 오류가 아니라 결과로 돌려준다. 시간 제한 기본 20초(최대 10분)
#[tauri::command]
pub async fn srv_run(conns: State<'_, SshConns>, conn: u32, cmd: String, sudo: Option<bool>, timeout_ms: Option<u64>) -> R<RunOut> {
    let c = conns.get(conn)?;
    let limit = Duration::from_millis(timeout_ms.unwrap_or(20_000).clamp(500, 600_000));
    tokio::time::timeout(limit, run(&c, &cmd, sudo.unwrap_or(false))).await.map_err(|_| err("NETWORK", "응답이 없습니다(시간 초과)"))?
}

// ── 흘려 보내기 ───────────────────────

struct StreamEntry {
    stop: Arc<AtomicBool>,
}

static STREAMS: LazyLock<Mutex<HashMap<u32, StreamEntry>>> = LazyLock::new(Default::default);
static NEXT: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamEnd {
    id: u32,
    code: Option<u32>,
    /// 사용자가 닫았으면 true
    cancelled: bool,
    message: Option<String>,
}

/// 감시 셸 — 명령은 뒤에서 돌리고, 채널 입력이 닫히면(EOF) 프로세스 묶음째 끝낸다.
/// 명령이 스스로 끝나면 감시도 거두고 그 종료 코드로 나간다.
pub(crate) fn watch_wrap(cmd: &str) -> String {
    format!("exec 3<&0; ( {cmd} ) </dev/null 3<&- & p=$!; ( read _ <&3; kill 0 ) >/dev/null 2>&1 & w=$!; exec 3<&-; wait $p; c=$?; kill $w 2>/dev/null; exit $c")
}

fn next_id() -> u32 {
    NEXT.fetch_add(1, Ordering::Relaxed) + 1
}

/// 끝나지 않는 명령의 출력(표준 출력+오류 출력)을 바이너리 채널로. 끝나면 `srv-stream-end` {id, code, cancelled, message}
#[tauri::command]
pub async fn srv_stream_open(app: AppHandle, conns: State<'_, SshConns>, conn: u32, cmd: String, sudo: Option<bool>, on_data: Channel<InvokeResponseBody>) -> R<u32> {
    let c = conns.get(conn)?;
    let sudo = sudo.unwrap_or(false);
    let inner = watch_wrap(&cmd);
    let full = if sudo {
        ensure_sudo(&c).await?;
        with_sudo(&c, &inner)?
    } else {
        format!("sh -c {}", q(&inner))
    };
    let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.exec(true, full.as_str()).await.map_err(|e| err("OTHER", e.to_string()))?;
    let id = next_id();
    let stop = Arc::new(AtomicBool::new(false));
    STREAMS.lock().unwrap().insert(id, StreamEntry { stop: stop.clone() });
    tauri::async_runtime::spawn(async move {
        let mut code = None;
        let mut sent_eof = false;
        let mut stop_at: Option<Instant> = None;
        loop {
            tokio::select! {
                m = ch.wait() => match m {
                    Some(ChannelMsg::Data { data }) => {
                        if on_data.send(InvokeResponseBody::Raw(data.to_vec())).is_err() {
                            stop.store(true, Ordering::Relaxed);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
            if stop.load(Ordering::Relaxed) {
                if !sent_eof {
                    // 입력을 닫으면 감시 셸이 명령을 끝낸다
                    let _ = ch.eof().await;
                    sent_eof = true;
                    stop_at = Some(Instant::now());
                } else if stop_at.is_some_and(|t| t.elapsed() > Duration::from_secs(2)) {
                    break;
                }
            }
        }
        let _ = ch.close().await;
        let cancelled = stop.load(Ordering::Relaxed);
        STREAMS.lock().unwrap().remove(&id);
        let _ = app.emit("srv-stream-end", StreamEnd { id, code, cancelled, message: None });
    });
    Ok(id)
}

#[tauri::command]
pub fn srv_stream_close(id: u32) {
    if let Some(s) = STREAMS.lock().unwrap().get(&id) {
        s.stop.store(true, Ordering::Relaxed);
    }
}

// ── 내 PC 에서 찾기 ───────────────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepOpts {
    /// 찾을 낱말(정규식이면 화면이 맞추므로 None — 파일 목록만 보낸다)
    pattern: Option<String>,
    #[serde(default)]
    ignore_case: bool,
    /// 파일 이름 거르기 — "*.log", "*.ts" (비우면 모두)
    #[serde(default)]
    globs: Vec<String>,
    /// 들어가지 않을 폴더 이름
    #[serde(default)]
    skip_dirs: Vec<String>,
    /// 0 = 끝까지
    #[serde(default)]
    max_depth: u32,
    /// 바이트, 0 = 제한 없음
    #[serde(default)]
    max_size: u64,
    /// 결과 상한(줄 또는 파일 수)
    #[serde(default)]
    max_hits: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    path: String,
    /// 1부터. 파일 목록만이면 0
    line: u32,
    text: String,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// `*`·`?` 만 아는 간단한 이름 맞추기(대소문자 무시)
pub(crate) fn glob_match(pat: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => (0..=n.len()).any(|i| go(&p[1..], &n[i..])),
            Some('?') => !n.is_empty() && go(&p[1..], &n[1..]),
            Some(c) => n.first() == Some(c) && go(&p[1..], &n[1..]),
        }
    }
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    go(&p, &n)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut o: String = s.chars().take(max).collect();
    o.push('…');
    o
}

/// 찾기 본체 — hits 에 넘기고 false 를 돌려받으면 멈춘다
pub(crate) fn grep_walk(root: &Path, o: &GrepOpts, stop: &AtomicBool, mut hits: impl FnMut(Hit) -> bool) -> (u64, u64) {
    let pat = o.pattern.as_ref().map(|p| if o.ignore_case { p.to_lowercase() } else { p.clone() });
    let max_hits = if o.max_hits == 0 { 5000 } else { o.max_hits } as u64;
    let (mut files, mut found) = (0u64, 0u64);
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for e in entries {
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if (o.max_depth == 0 || depth + 1 < o.max_depth) && !o.skip_dirs.iter().any(|s| s == &name) {
                    subdirs.push((e.path(), depth + 1));
                }
                continue;
            }
            if !ft.is_file() || (!o.globs.is_empty() && !o.globs.iter().any(|g| glob_match(g, &name))) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if o.max_size > 0 && meta.len() > o.max_size {
                continue;
            }
            let path = e.path();
            let Some(pat) = pat.as_ref() else {
                // 파일 목록만 — 바이너리는 앞부분으로 거른다
                let mut head = [0u8; 8192];
                let n = std::fs::File::open(&path).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
                if head[..n].contains(&0) {
                    continue;
                }
                files += 1;
                found += 1;
                if !hits(Hit { path: path_str(&path), line: 0, text: String::new() }) || found >= max_hits {
                    return (files, found);
                }
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let d = crate::textcodec::decode(&bytes, None);
            let Some(text) = d.text.filter(|_| !d.binary) else { continue };
            files += 1;
            for (i, l) in text.lines().enumerate() {
                let hay = if o.ignore_case { l.to_lowercase() } else { l.to_string() };
                if hay.contains(pat.as_str()) {
                    found += 1;
                    if !hits(Hit { path: path_str(&path), line: i as u32 + 1, text: clip(l, 400) }) || found >= max_hits {
                        return (files, found);
                    }
                }
            }
            if stop.load(Ordering::Relaxed) {
                return (files, found);
            }
        }
        // 이름 순으로 깊이 우선(쌓기라 뒤집어 넣는다)
        stack.extend(subdirs.into_iter().rev());
    }
    (files, found)
}

/// 내 PC 폴더에서 찾기 — 결과는 JSON 묶음(Hit 배열)으로 흘려 보내고, 끝나면 `srv-stream-end`(message = "파일 N개 · 찾은 줄 M개")
#[tauri::command]
pub fn local_grep(app: AppHandle, root: String, opts: GrepOpts, on_data: Channel<serde_json::Value>) -> Result<u32, String> {
    if !Path::new(&root).is_dir() {
        return Err("폴더가 없습니다".into());
    }
    if opts.pattern.as_deref().is_some_and(str::is_empty) {
        return Err("찾을 낱말을 넣으세요".into());
    }
    let id = next_id();
    let stop = Arc::new(AtomicBool::new(false));
    STREAMS.lock().unwrap().insert(id, StreamEntry { stop: stop.clone() });
    std::thread::spawn(move || {
        let mut batch: Vec<Hit> = Vec::new();
        let mut last = Instant::now();
        let mut closed = false;
        let (files, found) = grep_walk(Path::new(&root), &opts, &stop, |h| {
            batch.push(h);
            if batch.len() >= 200 || last.elapsed() > Duration::from_millis(150) {
                if on_data.send(serde_json::to_value(std::mem::take(&mut batch)).unwrap_or_default()).is_err() {
                    closed = true;
                    return false;
                }
                last = Instant::now();
            }
            !stop.load(Ordering::Relaxed)
        });
        if !batch.is_empty() && !closed {
            let _ = on_data.send(serde_json::to_value(batch).unwrap_or_default());
        }
        let cancelled = stop.load(Ordering::Relaxed);
        STREAMS.lock().unwrap().remove(&id);
        let _ = app.emit("srv-stream-end", StreamEnd { id, code: Some(0), cancelled, message: Some(format!("파일 {files}개 · 찾은 것 {found}개")) });
    });
    Ok(id)
}

// ── 웹 화면 열기용 잠깐 포워딩 ─────────

struct WebFwd {
    conn: u32,
    via: Weak<Conn>,
    host: String,
    port: u16,
    local_port: u16,
    started_at: i64,
    task: JoinHandle<()>,
}

static WEB: LazyLock<Mutex<HashMap<u32, WebFwd>>> = LazyLock::new(Default::default);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebFwdInfo {
    id: u32,
    conn: u32,
    host: String,
    port: u16,
    local_port: u16,
    started_at: i64,
}

fn info(id: u32, w: &WebFwd) -> WebFwdInfo {
    WebFwdInfo { id, conn: w.conn, host: w.host.clone(), port: w.port, local_port: w.local_port, started_at: w.started_at }
}

fn alive(w: &WebFwd) -> bool {
    !w.task.inner().is_finished() && w.via.upgrade().is_some_and(|c| !c.handle_ref().is_closed())
}

/// 서버의 host:port 를 내 PC 127.0.0.1 로 — 같은 포트 번호가 비어 있으면 그것(1024 이상), 아니면 빈 포트. 이미 열려 있으면 그것
#[tauri::command]
pub async fn web_forward_open(conns: State<'_, SshConns>, conn: u32, host: Option<String>, port: u16) -> R<WebFwdInfo> {
    open_web(&conns.get(conn)?, conn, host, port).await
}

async fn open_web(c: &Arc<Conn>, conn: u32, host: Option<String>, port: u16) -> R<WebFwdInfo> {
    let host = host.filter(|h| !h.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    {
        let mut reg = WEB.lock().unwrap();
        reg.retain(|_, w| alive(w));
        if let Some((id, w)) = reg.iter().find(|(_, w)| w.conn == conn && w.port == port && w.host == host) {
            return Ok(info(*id, w));
        }
    }
    let listener = match (port >= 1024).then_some(()) {
        Some(()) => match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| err("OTHER", format!("내 PC 포트를 열지 못했습니다: {e}")))?,
        },
        None => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| err("OTHER", format!("내 PC 포트를 열지 못했습니다: {e}")))?,
    };
    let local_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let via = Arc::downgrade(c);
    let (h2, w2) = (host.clone(), via.clone());
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                acc = listener.accept() => {
                    let Ok((sock, peer)) = acc else { tokio::time::sleep(Duration::from_millis(200)).await; continue };
                    let Some(c) = w2.upgrade() else { break };
                    let host = h2.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = sock.set_nodelay(true);
                        let Ok(ch) = c.handle_ref().channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await else { return };
                        // 채널을 늘 읽어 앱 안에 모은다(브라우저가 느리게 받아도 같은 연결의 터미널이 멈추지 않게)
                        let (up, down) = (std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0));
                        crate::tunnel::pump_counted(sock, ch.into_stream(), &up, &down).await;
                    });
                }
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if !w2.upgrade().is_some_and(|c| !c.handle_ref().is_closed()) { break; }
                }
            }
        }
    });
    let id = next_id();
    let w = WebFwd { conn, via, host, port, local_port, started_at: crate::store::now(), task };
    let out = info(id, &w);
    WEB.lock().unwrap().insert(id, w);
    Ok(out)
}

/// 열어 둔 잠깐 포워딩 — conn 으로 좁힌다(끊긴 연결 것은 정리)
#[tauri::command]
pub fn web_forward_list(conn: Option<u32>) -> Vec<WebFwdInfo> {
    let mut reg = WEB.lock().unwrap();
    reg.retain(|_, w| {
        let ok = alive(w);
        if !ok {
            w.task.abort();
        }
        ok
    });
    let mut v: Vec<WebFwdInfo> = reg.iter().filter(|(_, w)| conn.is_none_or(|c| c == w.conn)).map(|(id, w)| info(*id, w)).collect();
    v.sort_by_key(|x| x.id);
    v
}

#[tauri::command]
pub fn web_forward_close(id: u32) {
    if let Some(w) = WEB.lock().unwrap().remove(&id) {
        w.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("*.log", "app.LOG"));
        assert!(glob_match("a?c*", "abcdef"));
        assert!(!glob_match("*.log", "app.log.1"));
        assert!(glob_match("*", ""));
    }

    #[test]
    fn walk_finds_lines() {
        let dir = std::env::temp_dir().join(format!("rbshell-grep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("a.log"), "first\nHello World\nbye\n").unwrap();
        std::fs::write(dir.join("sub/b.txt"), "hello again\n").unwrap();
        std::fs::write(dir.join("sub/deep/c.log"), "hello deep\n").unwrap();
        std::fs::write(dir.join("node_modules/x.log"), "hello skipped\n").unwrap();
        std::fs::write(dir.join("bin.log"), b"hello\0binary").unwrap();
        // EUC-KR 파일도 글자로
        let (euc, _, _) = encoding_rs::EUC_KR.encode("안녕 hello 세상\n");
        std::fs::write(dir.join("k.log"), &euc).unwrap();
        let stop = AtomicBool::new(false);
        let mut o = GrepOpts { pattern: Some("hello".into()), ignore_case: true, globs: vec![], skip_dirs: vec!["node_modules".into()], max_depth: 0, max_size: 0, max_hits: 0 };
        let mut got = Vec::new();
        grep_walk(&dir, &o, &stop, |h| {
            got.push((h.path.rsplit('/').next().unwrap().to_string(), h.line));
            true
        });
        got.sort();
        assert_eq!(got, vec![("a.log".into(), 2), ("b.txt".into(), 1), ("c.log".into(), 1), ("k.log".into(), 1)]);
        // 거르기·깊이·대소문자
        o.globs = vec!["*.log".into()];
        o.max_depth = 2;
        o.ignore_case = false;
        let mut got = Vec::new();
        grep_walk(&dir, &o, &stop, |h| {
            got.push(h.text);
            true
        });
        got.sort();
        assert_eq!(got, vec!["안녕 hello 세상".to_string()]);
        // 파일 목록만
        o.pattern = None;
        o.max_depth = 0;
        let mut n = 0;
        grep_walk(&dir, &o, &stop, |_| {
            n += 1;
            true
        });
        assert_eq!(n, 3, "a.log·c.log·k.log (bin.log 는 바이너리)");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn wrap_shape() {
        let w = watch_wrap("journalctl -f");
        assert!(w.starts_with("exec 3<&0; ( journalctl -f ) </dev/null 3<&- &"));
        assert!(w.ends_with("exit $c"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// RB_SRV_TEST=127.0.0.1:포트 · RB_SRV_TEST_USER · RB_SRV_TEST_PW — 실행·sudo·흘려 보내기 닫기
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_run_and_stream_stop() {
        let spec = std::env::var("RB_SRV_TEST").unwrap();
        let user = std::env::var("RB_SRV_TEST_USER").unwrap_or_else(|_| "rbtest".into());
        let pw = std::env::var("RB_SRV_TEST_PW").unwrap();
        let (host, port) = spec.split_once(':').unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-srv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(dir.join("db"), false).unwrap();
        let conns = SshConns::default();
        let cid = crate::ssh::test_connect(&store, &conns, host, port.parse().unwrap(), &user, &pw).await;
        let c = conns.get(cid).unwrap();
        let o = run(&c, "echo hi; echo oops >&2; exit 3", false).await.unwrap();
        assert_eq!((o.code, o.stdout.trim(), o.stderr.trim()), (Some(3), "hi", "oops"));
        c.sudo.lock().unwrap().mode = "nopasswd".into();
        let o = run(&c, "id -u", true).await.unwrap();
        assert_eq!(o.stdout.trim(), "0", "{o:?}");
        // 감시 셸: 입력을 닫으면 sleep 이 바로 끝난다(출력 없는 명령도)
        for sudo in [false, true] {
            let inner = watch_wrap("echo start; sleep 300");
            let full = if sudo { with_sudo(&c, &inner).unwrap() } else { format!("sh -c {}", q(&inner)) };
            let mut ch = c.handle_ref().channel_open_session().await.unwrap();
            ch.exec(true, full.as_str()).await.unwrap();
            let mut seen = String::new();
            while !seen.contains("start") {
                if let Some(ChannelMsg::Data { data }) = ch.wait().await {
                    seen.push_str(&String::from_utf8_lossy(&data));
                }
            }
            ch.eof().await.unwrap();
            let t = Instant::now();
            let ended = tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(m) = ch.wait().await {
                    if matches!(m, ChannelMsg::Close) {
                        break;
                    }
                }
            })
            .await;
            assert!(ended.is_ok(), "sudo={sudo} 닫히지 않음");
            println!("sudo={sudo} 닫힘 {:?}", t.elapsed());
            let left = run(&c, "sleep 0.3; pgrep -f 'slee[p] 300' | wc -l", false).await.unwrap();
            assert_eq!(left.stdout.trim(), "0", "sudo={sudo} 남은 sleep");
        }
        // 잠깐 포워딩: RB_SRV_WEB=서버에서 본 웹 포트(예: 8088) — 내 PC 포트로 HTTP 가 오가고, 같은 포트를 다시 열면 같은 것, 닫으면 목록에서 빠짐
        if let Some(wp) = std::env::var("RB_SRV_WEB").ok().and_then(|x| x.parse::<u16>().ok()) {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let f = open_web(&c, cid, None, wp).await.unwrap();
            let again = open_web(&c, cid, Some("127.0.0.1".into()), wp).await.unwrap();
            assert_eq!(f.id, again.id);
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", f.local_port)).await.unwrap();
            s.write_all(b"GET / HTTP/1.0
Host: x

").await.unwrap();
            let mut body = String::new();
            s.read_to_string(&mut body).await.unwrap();
            println!("web {} → {}", f.local_port, body.lines().next().unwrap_or(""));
            assert!(body.starts_with("HTTP/1."), "{body}");
            assert_eq!(web_forward_list(Some(cid)).len(), 1);
            web_forward_close(f.id);
            assert!(web_forward_list(Some(cid)).is_empty());
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
