//! 보기 도구 — 미리보기용 바이트 읽기, 실시간 보기(tail -F), 폴더 tar.gz 로 받기.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;

use crate::ssh::{err, sftp_err, SshConns, R};

const MAX_PREVIEW: u64 = 32 * 1024 * 1024;

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 원격 파일 일부(최대 32 MiB) — 이미지·PDF·헥스 미리보기, 압축 목록.
/// offset: 이 자리부터(음수면 끝에서 그만큼 앞, 파일보다 길면 처음부터). 없으면 처음부터.
#[tauri::command]
pub async fn sftp_read_bytes(conns: State<'_, SshConns>, conn: u32, path: String, max: Option<u64>, offset: Option<i64>) -> R<Response> {
    use tokio::io::AsyncSeekExt;
    let c = conns.get(conn)?;
    let max = max.unwrap_or(MAX_PREVIEW).min(MAX_PREVIEW);
    let start = match offset {
        Some(n) if n < 0 => {
            let size = c.sftp.metadata(path.clone()).await.map_err(sftp_err)?.size.unwrap_or(0);
            size.saturating_sub(n.unsigned_abs())
        }
        Some(n) => n as u64,
        None => 0,
    };
    let mut f = c.sftp.open(path).await.map_err(sftp_err)?;
    if start > 0 {
        f.seek(SeekFrom::Start(start)).await.map_err(|e| err("SFTP", e.to_string()))?;
    }
    let mut out = Vec::new();
    let mut buf = vec![0u8; 256 * 1024];
    while (out.len() as u64) < max {
        let n = f.read(&mut buf).await.map_err(|e| err("SFTP", e.to_string()))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n.min((max - out.len() as u64) as usize)]);
    }
    Ok(Response::new(out))
}

#[tauri::command(async)]
pub fn local_read_bytes(path: String, max: Option<u64>, offset: Option<i64>) -> Result<Response, String> {
    let max = max.unwrap_or(MAX_PREVIEW).min(MAX_PREVIEW);
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    match offset {
        Some(n) if n < 0 => {
            let size = f.metadata().map_err(|e| e.to_string())?.len();
            f.seek(SeekFrom::Start(size.saturating_sub(n.unsigned_abs()))).map_err(|e| e.to_string())?;
        }
        Some(n) if n > 0 => {
            f.seek(SeekFrom::Start(n as u64)).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    let mut out = Vec::new();
    (&mut f).take(max).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(Response::new(out))
}

// ── 실시간 보기 ─────────────────────

#[derive(Default)]
pub struct Tails {
    next: AtomicU32,
    stop: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone)]
struct TailEnd {
    id: u32,
    message: Option<String>,
}

/// 원격 `tail -n N -F` — 출력은 바이너리 채널로
#[tauri::command]
pub async fn ssh_tail_open(app: AppHandle, conns: State<'_, SshConns>, tails: State<'_, Tails>, conn: u32, path: String, lines: u32, on_data: Channel<InvokeResponseBody>) -> R<u32> {
    let c = conns.get(conn)?;
    let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.exec(true, format!("tail -n {lines} -F -- {}", q(&path)).as_str()).await.map_err(|e| err("OTHER", e.to_string()))?;
    let id = tails.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    tails.stop.lock().unwrap().insert(id, stop.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                m = ch.wait() => match m {
                    Some(ChannelMsg::Data { data }) => {
                        if on_data.send(InvokeResponseBody::Raw(data.to_vec())).is_err() { break; }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                _ = tokio::time::sleep(Duration::from_millis(300)) => {
                    if stop.load(Ordering::Relaxed) { break; }
                }
            }
        }
        let _ = ch.close().await;
        let _ = app.emit("tail-end", TailEnd { id, message: None });
    });
    Ok(id)
}

/// 내 PC 파일 실시간 보기 — 0.4초마다 늘어난 만큼(잘리면 처음부터)
#[tauri::command]
pub fn local_tail_open(app: AppHandle, tails: State<'_, Tails>, path: String, lines: u32, on_data: Channel<InvokeResponseBody>) -> Result<u32, String> {
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    // 마지막 N 줄쯤: 끝에서 최대 256 KiB 를 읽어 줄 수로 자른다
    let back = len.min(256 * 1024);
    f.seek(SeekFrom::Start(len - back)).map_err(|e| e.to_string())?;
    let mut head = Vec::new();
    f.read_to_end(&mut head).map_err(|e| e.to_string())?;
    let nl: Vec<usize> = head.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i).collect();
    let start = if nl.len() > lines as usize { nl[nl.len() - lines as usize - 1] + 1 } else { 0 };
    let _ = on_data.send(InvokeResponseBody::Raw(head[start..].to_vec()));
    let id = tails.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    tails.stop.lock().unwrap().insert(id, stop.clone());
    std::thread::spawn(move || {
        let mut pos = len;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(400));
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let now = meta.len();
            if now < pos {
                pos = 0; // 잘림·회전
            }
            if now > pos {
                if let Ok(mut f) = std::fs::File::open(&path) {
                    let _ = f.seek(SeekFrom::Start(pos));
                    let mut chunk = Vec::new();
                    let _ = (&mut f).take(now - pos).read_to_end(&mut chunk);
                    pos += chunk.len() as u64;
                    if on_data.send(InvokeResponseBody::Raw(chunk)).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("tail-end", TailEnd { id, message: None });
    });
    Ok(id)
}

#[tauri::command]
pub fn tail_close(tails: State<'_, Tails>, id: u32) {
    if let Some(s) = tails.stop.lock().unwrap().remove(&id) {
        s.store(true, Ordering::Relaxed);
    }
}

// ── 폴더째 받기 ─────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArchiveProgress {
    path: String,
    dest: String,
    bytes: u64,
    state: &'static str,
    error: Option<String>,
}

/// 원격 폴더를 `tar czf -` 로 흘려 받아 내 PC 의 .tar.gz 로 — 서버에 tar 만 있으면 된다
#[tauri::command]
pub async fn ssh_download_targz(app: AppHandle, conns: State<'_, SshConns>, conn: u32, path: String, dest: String) -> R<u64> {
    let c = conns.get(conn)?;
    let trimmed = path.trim_end_matches('/');
    let (parent, name) = trimmed.rsplit_once('/').map(|(p, n)| (if p.is_empty() { "/" } else { p }, n)).ok_or_else(|| err("OTHER", "경로가 이상합니다"))?;
    let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.exec(true, format!("tar czf - -C {} -- {}", q(parent), q(name)).as_str()).await.map_err(|e| err("OTHER", e.to_string()))?;
    let part = format!("{dest}.rbpart");
    let mut file = std::fs::File::create(&part).map_err(|e| err("OTHER", e.to_string()))?;
    let mut bytes = 0u64;
    let mut stderr = String::new();
    let mut code = None;
    let mut last = std::time::Instant::now();
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } => {
                std::io::Write::write_all(&mut file, &data).map_err(|e| err("OTHER", e.to_string()))?;
                bytes += data.len() as u64;
                if last.elapsed() > Duration::from_millis(200) {
                    let _ = app.emit("archive", ArchiveProgress { path: path.clone(), dest: dest.clone(), bytes, state: "running", error: None });
                    last = std::time::Instant::now();
                }
            }
            ChannelMsg::ExtendedData { data, .. } => stderr.push_str(&String::from_utf8_lossy(&data)),
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    drop(file);
    // tar 는 읽지 못한 파일이 있어도 나머지는 묶고 1 을 돌려준다 — 2 이상만 실패
    if code.unwrap_or(0) >= 2 || bytes == 0 {
        let _ = std::fs::remove_file(&part);
        let msg = stderr.lines().last().unwrap_or("tar 실패").to_string();
        let _ = app.emit("archive", ArchiveProgress { path, dest, bytes, state: "error", error: Some(msg.clone()) });
        return Err(err("SFTP", msg));
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&part, &dest).map_err(|e| err("OTHER", e.to_string()))?;
    let warn = (code == Some(1)).then(|| format!("일부 파일은 읽지 못해 빠졌습니다: {}", stderr.lines().take(3).collect::<Vec<_>>().join(" / ")));
    let _ = app.emit("archive", ArchiveProgress { path, dest, bytes, state: "done", error: warn });
    Ok(bytes)
}
