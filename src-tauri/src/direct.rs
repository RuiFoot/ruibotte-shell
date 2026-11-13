//! 서버 A → 서버 B 바로 보내기 — A 에서 rsync(B 에도 있으면, 없으면 scp)로 B 에 접속해 보낸다(내 PC 회선을 거치지 않음).
//! A 가 B 에 스스로 로그인할 수 있어야 한다(A 의 키가 B 에 등록됨). 암호는 묻지 않는다(BatchMode) —
//! 안 되면 전송 칸에 까닭을 보이고 "내 PC 거쳐서" 로 다시 보내게 한다.
//! 진행률은 `transfer` 이벤트(direction "direct")로 내 PC ↔ 서버 전송과 같은 칸에 나온다.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{err, Conn, SshConns, R};
use crate::sudo::q;
use crate::transfer::{base_name, rjoin, walk_remote, Progress, Transfers};

/// A 에서 본 B 의 접속 주소(B 프로필의 주소·계정)
#[derive(Deserialize, Clone)]
pub struct Target {
    user: String,
    host: String,
    port: u16,
}

const E_NOSSH: u32 = 90;
const E_LOGIN: u32 = 91;
const E_NOTOOL: u32 = 92;
const E_SCPBAD: u32 = 93;

fn check_target(t: &Target) -> R<()> {
    let host_ok = !t.host.is_empty() && !t.host.starts_with('-') && t.host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']'));
    let user_ok = !t.user.is_empty() && !t.user.starts_with('-') && t.user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !host_ok || !user_ok || t.port == 0 {
        return Err(err("OTHER", "받는 서버 주소·계정에 쓸 수 없는 글자가 있어 서버끼리 바로 보낼 수 없습니다 — 내 PC 거쳐서 보내세요"));
    }
    Ok(())
}

/// scp 의 받는 경로는 옛 scp 에서 B 의 셸이 한 번 더 풀어 읽는다 — 공백·따옴표 같은 글자가 있으면 쓰지 않는다
fn scp_safe(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '+' | '-' | '@' | '%' | '=' | ',' | '~'))
}

/// 실패 까닭을 사람 말로 — 마지막 줄의 ssh·rsync 오류를 보고 고른다
fn explain(code: Option<u32>, stderr: &str, t: &Target) -> String {
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
    let to = format!("{}@{}:{}", t.user, t.host, t.port);
    let has = |k: &str| stderr.contains(k);
    if code == Some(E_NOSSH) {
        return "보내는 서버에 ssh 명령이 없습니다".into();
    }
    if code == Some(E_NOTOOL) {
        return "보내는 서버에 rsync·scp 가 없습니다".into();
    }
    if code == Some(E_SCPBAD) {
        return "받는 서버에 rsync 가 없어 scp 로 보내야 하는데, 경로에 공백·특수 문자가 있거나 같은 이름 건너뛰기를 골라 scp 로는 할 수 없습니다".into();
    }
    if has("Permission denied") {
        return format!("보내는 서버가 {to} 에 키로 로그인하지 못했습니다 — 보내는 서버의 공개 키를 받는 서버 authorized_keys 에 넣어야 합니다");
    }
    if has("Host key verification failed") || has("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        return format!("보내는 서버에 저장된 {}의 호스트 키가 맞지 않습니다(known_hosts)", t.host);
    }
    if has("Could not resolve") || has("Name or service not known") {
        return format!("보내는 서버에서 {} 이름을 찾지 못했습니다", t.host);
    }
    if has("timed out") || has("No route to host") || has("Connection refused") || has("Network is unreachable") {
        return format!("보내는 서버에서 {to} 에 닿지 않습니다 — 서버끼리 막혀 있으면 내 PC 거쳐서 보내세요");
    }
    match code {
        Some(23) | Some(24) => format!("일부 파일을 보내지 못했습니다 — {last}"),
        _ if !last.is_empty() => last,
        Some(c) => format!("끝 코드 {c}"),
        None => "연결이 끊겼습니다".into(),
    }
}

/// rsync --info=progress2 한 줄 → (보낸 바이트, 보낸 파일 수)
fn parse_progress(line: &str) -> Option<(u64, Option<u32>)> {
    let t = line.trim();
    let first = t.split_whitespace().next()?;
    if !first.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let bytes: u64 = first.replace([',', '.'], "").parse().ok()?;
    let files = t.split("xfr#").nth(1).and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok());
    Some((bytes, files))
}

#[allow(clippy::too_many_arguments)]
/// A 에서 돌릴 sh 스크립트 — 호스트 키 방식 고르기, B 로그인·rsync 확인, rsync(또는 scp) 실행
fn script(t: &Target, src: &str, dest: &str, dest_dir: &str, is_dir: bool, dest_exists: bool, renamed: bool, overwrite: bool) -> String {
    let spec = if t.host.contains(':') && !t.host.starts_with('[') { format!("{}@[{}]", t.user, t.host) } else { format!("{}@{}", t.user, t.host) };
    let ssh_host = format!("{}@{}", t.user, t.host.trim_start_matches('[').trim_end_matches(']'));
    // accept-new 는 OpenSSH 7.6+ — 옛 ssh 는 known_hosts 에 있는 서버만(yes)
    let opts = |p: &str| format!("{p} {} -o BatchMode=yes -o StrictHostKeyChecking=$H -o ConnectTimeout=10 -o ServerAliveInterval=15", t.port);
    let ssh = opts("ssh -p");
    let rsync_src = if is_dir { format!("{}/", src.trim_end_matches('/')) } else { src.to_string() };
    let rsync_dst = format!("{spec}:{dest}{}", if is_dir { "/" } else { "" });
    let rsync = format!(
        "rsync -a -s --info=progress2 --no-inc-recursive{} -e \"{ssh}\" -- {} {}",
        if overwrite { "" } else { " --ignore-existing" },
        q(&rsync_src),
        q(&rsync_dst)
    );
    // scp -r 은 받는 폴더가 이미 있으면 그 안에 만든다 — 있는 폴더를 덮어쓸 때는 부모 폴더로 보낸다
    let scp_target = if is_dir && dest_exists { dest_dir } else { dest };
    let scp_ok = scp_safe(scp_target) && (overwrite || !dest_exists) && !(is_dir && dest_exists && renamed);
    let scp = if scp_ok {
        format!("echo RB_TOOL=scp; echo RB_PID=$$; exec {} -r -p -q -- {} {}", opts("scp -P"), q(src), q(&format!("{spec}:{scp_target}")))
    } else {
        format!("exit {E_SCPBAD}")
    };
    format!(
        "H=accept-new; ssh -G -o StrictHostKeyChecking=accept-new localhost >/dev/null 2>&1 || H=yes\n\
         command -v ssh >/dev/null 2>&1 || exit {E_NOSSH}\n\
         R=$({ssh} -- {host} 'command -v rsync >/dev/null 2>&1 && echo RB_R1 || echo RB_R0' </dev/null 2>&1) || {{ printf '%s\\n' \"$R\" >&2; exit {E_LOGIN}; }}\n\
         if command -v rsync >/dev/null 2>&1 && printf '%s' \"$R\" | grep -q RB_R1; then echo RB_TOOL=rsync; echo RB_PID=$$; exec {rsync}; fi\n\
         command -v scp >/dev/null 2>&1 || exit {E_NOTOOL}\n\
         {scp}\n",
        host = q(&ssh_host),
    )
}

/// 서버 A 의 파일·폴더를 서버 B 로 바로(A 가 B 에 접속) — 진행률은 transfer 이벤트
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn direct_start(
    app: AppHandle,
    conns: State<'_, SshConns>,
    transfers: State<'_, Transfers>,
    from_conn: u32,
    src: String,
    to_conn: u32,
    dest_dir: String,
    overwrite: bool,
    dest_name: Option<String>,
    target: Target,
) -> R<u32> {
    check_target(&target)?;
    let a = conns.get(from_conn)?;
    let b = conns.get(to_conn)?;
    let id = transfers.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let renamed = dest_name.as_deref().is_some_and(|n| n != base_name(&src));
    let name = dest_name.filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\')).unwrap_or_else(|| base_name(&src));
    let dest = rjoin(&dest_dir, &name);
    // 크기·파일 수(진행률 분모)
    let mut items = Vec::new();
    walk_remote(&a, &src, Path::new(&dest).to_path_buf(), &mut items).await?;
    let is_dir = items.first().is_some_and(|i| i.dir);
    let total: u64 = items.iter().map(|i| i.size).sum();
    let files_total = items.iter().filter(|i| !i.dir).count() as u32;
    let dest_exists = b.sftp.try_exists(dest.clone()).await.unwrap_or(false);
    let sh = script(&target, &src, &dest, &dest_dir, is_dir, dest_exists, renamed, overwrite);
    let prog = Arc::new(Mutex::new(Progress {
        id,
        direction: "direct",
        name,
        dest: dest.clone(),
        bytes_done: 0,
        bytes_total: total,
        files_done: 0,
        files_total,
        skipped: 0,
        verified: 0,
        resumed: 0,
        state: "running",
        error: None,
        ms: 0,
        dest_conn: Some(to_conn),
        conn: Some(from_conn),
    }));
    let _ = app.emit("transfer", prog.lock().unwrap().clone());
    let cancel = transfers.cancel.clone();
    transfers.begin(id);
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let (code, stderr, cancelled) = run(&a, &b, &sh, &dest, &prog, &cancel, id, &app, started).await;
        crate::transfer::finish(&app, id);
        let mut p = prog.lock().unwrap().clone();
        p.ms = started.elapsed().as_millis() as u64;
        if cancelled {
            p.state = "cancelled";
        } else if code == Some(0) {
            p.state = "done";
            p.bytes_done = p.bytes_total.max(p.bytes_done);
            p.files_done = p.files_total;
        } else {
            p.state = "error";
            p.error = Some(explain(code, &stderr, &target));
        }
        let _ = app.emit("transfer", p);
    });
    Ok(id)
}

/// 스크립트를 돌리며 진행률을 읽는다 → (끝 코드, stderr 끝부분, 취소됨)
#[allow(clippy::too_many_arguments)]
async fn run(a: &Arc<Conn>, b: &Arc<Conn>, sh: &str, dest: &str, prog: &Arc<Mutex<Progress>>, cancel: &Arc<Mutex<std::collections::HashSet<u32>>>, id: u32, app: &AppHandle, started: Instant) -> (Option<u32>, String, bool) {
    let mut ch = match a.handle_ref().channel_open_session().await {
        Ok(c) => c,
        Err(e) => return (None, e.to_string(), false),
    };
    if let Err(e) = ch.exec(true, format!("sh -c {}", q(sh)).as_str()).await {
        return (None, e.to_string(), false);
    }
    let _ = ch.eof().await;
    let mut code = None;
    let mut stderr = String::new();
    let mut line = String::new();
    let mut pid: Option<u32> = None;
    let mut scp = false;
    let mut cancelled = false;
    let mut cancel_at: Option<Instant> = None;
    let mut last_poll = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    loop {
        tokio::select! {
            m = ch.wait() => {
                let Some(m) = m else { break };
                match m {
                    ChannelMsg::Data { data } => {
                        for c in String::from_utf8_lossy(&data).chars() {
                            if c != '\r' && c != '\n' {
                                line.push(c);
                                continue;
                            }
                            let l = std::mem::take(&mut line);
                            if let Some(v) = l.strip_prefix("RB_PID=") {
                                pid = v.trim().parse().ok();
                            } else if let Some(v) = l.strip_prefix("RB_TOOL=") {
                                scp = v.trim() == "scp";
                            } else if let Some((n, f)) = parse_progress(&l) {
                                let mut p = prog.lock().unwrap();
                                p.bytes_done = if p.bytes_total > 0 { n.min(p.bytes_total) } else { n };
                                if let Some(f) = f {
                                    p.files_done = f.min(p.files_total);
                                }
                            }
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        stderr.push_str(&String::from_utf8_lossy(&data));
                        if stderr.len() > 8000 {
                            let cut = stderr.len() - 4000;
                            let cut = (cut..stderr.len()).find(|i| stderr.is_char_boundary(*i)).unwrap_or(0);
                            stderr.drain(..cut);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    _ => {}
                }
            }
            _ = tick.tick() => {
                if !cancelled && cancel.lock().unwrap().contains(&id) {
                    cancelled = true;
                    cancel_at = Some(Instant::now());
                    match pid {
                        // rsync·scp 는 TERM 을 받으면 B 로 가는 ssh 까지 정리하고 끝난다
                        Some(p) => { let _ = crate::sudo::exec(a, &format!("kill -TERM {p} 2>/dev/null"), None).await; }
                        None => { let _ = ch.close().await; }
                    }
                }
                if cancel_at.is_some_and(|t| t.elapsed() > Duration::from_secs(5)) {
                    let _ = ch.close().await;
                    break;
                }
                // scp 는 진행률을 내지 않는다 — 받는 쪽 크기를 1초마다 재 본다
                if scp && last_poll.elapsed() > Duration::from_secs(1) {
                    last_poll = Instant::now();
                    if let Ok(o) = crate::sudo::exec(b, &format!("du -sk -- {} 2>/dev/null", q(dest)), None).await {
                        if let Some(k) = String::from_utf8_lossy(&o.stdout).split_whitespace().next().and_then(|s| s.parse::<u64>().ok()) {
                            let mut p = prog.lock().unwrap();
                            p.bytes_done = (k * 1024).min(p.bytes_total);
                        }
                    }
                }
                let mut p = prog.lock().unwrap();
                p.ms = started.elapsed().as_millis() as u64;
                let _ = app.emit("transfer", p.clone());
            }
        }
    }
    (code, stderr, cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress2_line() {
        assert_eq!(parse_progress("     32,768   0%    0.00kB/s    0:00:00 (xfr#1, to-chk=3/5)"), Some((32768, Some(1))));
        assert_eq!(parse_progress("  1,048,576 100%  12.34MB/s    0:00:01 (xfr#12, to-chk=0/40)"), Some((1048576, Some(12))));
        assert_eq!(parse_progress("sending incremental file list"), None);
    }

    #[test]
    fn target_guard() {
        assert!(check_target(&Target { user: "deploy".into(), host: "10.0.0.2".into(), port: 22 }).is_ok());
        assert!(check_target(&Target { user: "a;rm".into(), host: "h".into(), port: 22 }).is_err());
        assert!(check_target(&Target { user: "u".into(), host: "-oProxyCommand=x".into(), port: 22 }).is_err());
    }
}
