//! 내 PC ↔ 서버 전송(SFTP) — 파일·폴더(구조 유지), 진행률 이벤트, 취소, 같은 이름 덮어쓰기 여부.
//! 진행률은 `transfer` 이벤트로 100 ms 에 한 번 이하로 보낸다.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{err, sftp_err, Conn, SshConns, R};

const CHUNK: usize = 256 * 1024;

#[derive(Default)]
pub struct Transfers {
    next: AtomicU32,
    cancel: Arc<Mutex<HashSet<u32>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: u32,
    direction: &'static str,
    name: String,
    dest: String,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u32,
    files_total: u32,
    skipped: u32,
    /// running | done | error | cancelled
    state: &'static str,
    error: Option<String>,
    ms: u64,
}

struct Item {
    src: String,
    dest: String,
    size: u64,
    dir: bool,
}

fn rjoin(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn base_name(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn walk_local(src: &Path, dest: &str, out: &mut Vec<Item>) -> std::io::Result<()> {
    let m = std::fs::metadata(src)?;
    if m.is_dir() {
        out.push(Item { src: src.to_string_lossy().into_owned(), dest: dest.into(), size: 0, dir: true });
        let mut kids: Vec<_> = std::fs::read_dir(src)?.flatten().collect();
        kids.sort_by_key(|e| e.file_name());
        for k in kids {
            walk_local(&k.path(), &rjoin(dest, &k.file_name().to_string_lossy()), out)?;
        }
    } else {
        out.push(Item { src: src.to_string_lossy().into_owned(), dest: dest.into(), size: m.len(), dir: false });
    }
    Ok(())
}

async fn walk_remote(c: &Conn, src: &str, dest: PathBuf, out: &mut Vec<Item>) -> R<()> {
    let m = c.sftp.metadata(src.to_string()).await.map_err(sftp_err)?;
    if m.is_dir() {
        out.push(Item { src: src.into(), dest: dest.to_string_lossy().into_owned(), size: 0, dir: true });
        let mut kids: Vec<_> = c.sftp.read_dir(src.to_string()).await.map_err(sftp_err)?.collect();
        kids.sort_by_key(|e| e.file_name());
        for k in kids {
            let name = k.file_name();
            if name == "." || name == ".." {
                continue;
            }
            Box::pin(walk_remote(c, &rjoin(src, &name), dest.join(&name), out)).await?;
        }
    } else {
        out.push(Item { src: src.into(), dest: dest.to_string_lossy().into_owned(), size: m.size.unwrap_or(0), dir: false });
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_start(
    app: AppHandle,
    conns: State<'_, SshConns>,
    transfers: State<'_, Transfers>,
    conn: u32,
    direction: String,
    src: String,
    dest_dir: String,
    overwrite: bool,
) -> R<u32> {
    let c = conns.get(conn)?;
    let id = transfers.next.fetch_add(1, Ordering::Relaxed) + 1;
    let up = direction == "up";
    let name = base_name(&src);
    let items = if up {
        let mut v = Vec::new();
        walk_local(Path::new(&src), &rjoin(&dest_dir, &name), &mut v).map_err(|e| err("OTHER", e.to_string()))?;
        v
    } else {
        let mut v = Vec::new();
        walk_remote(&c, &src, Path::new(&dest_dir).join(&name), &mut v).await?;
        v
    };
    let total: u64 = items.iter().map(|i| i.size).sum();
    let files_total = items.iter().filter(|i| !i.dir).count() as u32;
    let dest = items.first().map(|i| i.dest.clone()).unwrap_or_default();
    let cancel = transfers.cancel.clone();
    let app2 = app.clone();
    let c2: Arc<Conn> = c.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut p = Progress {
            id,
            direction: if up { "up" } else { "down" },
            name,
            dest,
            bytes_done: 0,
            bytes_total: total,
            files_done: 0,
            files_total,
            skipped: 0,
            state: "running",
            error: None,
            ms: 0,
        };
        let _ = app2.emit("transfer", p.clone());
        let mut last_emit = Instant::now();
        let result: Result<(), String> = async {
            let mut buf = vec![0u8; CHUNK];
            for it in &items {
                if cancel.lock().unwrap().remove(&id) {
                    return Err("cancelled".into());
                }
                if it.dir {
                    if up {
                        if c2.sftp.metadata(it.dest.clone()).await.is_err() {
                            c2.sftp.create_dir(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
                        }
                    } else {
                        tokio::fs::create_dir_all(&it.dest).await.map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                let exists = if up { c2.sftp.try_exists(it.dest.clone()).await.unwrap_or(false) } else { Path::new(&it.dest).exists() };
                if exists && !overwrite {
                    p.skipped += 1;
                    p.bytes_done += it.size;
                    continue;
                }
                if up {
                    let mut src = tokio::fs::File::open(&it.src).await.map_err(|e| e.to_string())?;
                    let mut dst = c2.sftp.create(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
                    loop {
                        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        p.bytes_done += n as u64;
                        if last_emit.elapsed() > Duration::from_millis(100) {
                            p.ms = started.elapsed().as_millis() as u64;
                            let _ = app2.emit("transfer", p.clone());
                            last_emit = Instant::now();
                            if cancel.lock().unwrap().remove(&id) {
                                return Err("cancelled".into());
                            }
                        }
                    }
                    dst.shutdown().await.map_err(|e| e.to_string())?;
                } else {
                    let mut src = c2.sftp.open(it.src.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
                    let mut dst = tokio::fs::File::create(&it.dest).await.map_err(|e| e.to_string())?;
                    loop {
                        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        p.bytes_done += n as u64;
                        if last_emit.elapsed() > Duration::from_millis(100) {
                            p.ms = started.elapsed().as_millis() as u64;
                            let _ = app2.emit("transfer", p.clone());
                            last_emit = Instant::now();
                            if cancel.lock().unwrap().remove(&id) {
                                return Err("cancelled".into());
                            }
                        }
                    }
                    dst.flush().await.map_err(|e| e.to_string())?;
                }
                p.files_done += 1;
            }
            Ok(())
        }
        .await;
        p.ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(()) => p.state = "done",
            Err(e) if e == "cancelled" => p.state = "cancelled",
            Err(e) => {
                p.state = "error";
                p.error = Some(e);
            }
        }
        let _ = app2.emit("transfer", p);
    });
    Ok(id)
}

#[tauri::command]
pub fn transfer_cancel(transfers: State<'_, Transfers>, id: u32) {
    transfers.cancel.lock().unwrap().insert(id);
}
