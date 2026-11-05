//! 내 PC ↔ 서버 전송(SFTP) — 파일·폴더(구조 유지), 동시 3개, .rbpart 이어받기, sha256 확인(서버에 sha256sum 이 있을 때),
//! 진행률 이벤트, 취소, 같은 이름 덮어쓰기 여부.
//! 진행률은 `transfer` 이벤트로 100 ms 에 한 번 이하로 보낸다.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use futures_util::TryStreamExt;
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
    /// sha256 을 서버와 맞춰 본 파일 수
    verified: u32,
    /// .rbpart 에서 이어 받은/보낸 파일 수
    resumed: u32,
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
        let prog = Arc::new(Mutex::new(Progress {
            id,
            direction: if up { "up" } else { "down" },
            name,
            dest,
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
        }));
        let _ = app2.emit("transfer", prog.lock().unwrap().clone());
        // 진행률은 따로 150 ms 마다
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let prog = prog.clone();
            let app3 = app2.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        _ = &mut stop_rx => break,
                        _ = tokio::time::sleep(Duration::from_millis(150)) => {
                            let mut p = prog.lock().unwrap();
                            p.ms = started.elapsed().as_millis() as u64;
                            let _ = app3.emit("transfer", p.clone());
                        }
                    }
                }
            });
        }
        let result: Result<(), String> = async {
            // 폴더 먼저(순서대로)
            for it in items.iter().filter(|i| i.dir) {
                if up {
                    if c2.sftp.metadata(it.dest.clone()).await.is_err() {
                        c2.sftp.create_dir(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
                    }
                } else {
                    tokio::fs::create_dir_all(&it.dest).await.map_err(|e| e.to_string())?;
                }
            }
            // 파일은 동시에 3개
            let files: Vec<&Item> = items.iter().filter(|i| !i.dir).collect();
            futures_util::stream::iter(files.into_iter().map(Ok::<&Item, String>))
                .try_for_each_concurrent(3, |it| {
                    let c2 = c2.clone();
                    let prog = prog.clone();
                    let cancel = cancel.clone();
                    async move {
                        if cancel.lock().unwrap().contains(&id) {
                            return Err("cancelled".to_string());
                        }
                        let exists = if up { c2.sftp.try_exists(it.dest.clone()).await.unwrap_or(false) } else { Path::new(&it.dest).exists() };
                        if exists && !overwrite {
                            let mut p = prog.lock().unwrap();
                            p.skipped += 1;
                            p.bytes_done += it.size;
                            return Ok(());
                        }
                        let outcome = copy_one(&c2, it, up, &prog, &cancel, id).await?;
                        let mut p = prog.lock().unwrap();
                        p.files_done += 1;
                        if outcome.verified {
                            p.verified += 1;
                        }
                        if outcome.resumed {
                            p.resumed += 1;
                        }
                        Ok(())
                    }
                })
                .await
        }
        .await;
        let _ = stop_tx.send(());
        cancel.lock().unwrap().remove(&id);
        let mut p = prog.lock().unwrap().clone();
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

struct Outcome {
    verified: bool,
    resumed: bool,
}

/// 원격 sha256 — 서버에 sha256sum 이 없으면 None(확인 건너뜀)
async fn remote_sha256(c: &Conn, path: &str) -> Option<String> {
    let mut ch = c.handle_ref().channel_open_session().await.ok()?;
    let q = format!("sha256sum -- '{}' 2>/dev/null", path.replace('\'', "'\\''"));
    ch.exec(true, q.as_str()).await.ok()?;
    let mut out = Vec::new();
    while let Some(m) = ch.wait().await {
        if let russh::ChannelMsg::Data { data } = m {
            out.extend_from_slice(&data);
        }
    }
    let s = String::from_utf8_lossy(&out);
    let h = s.split_whitespace().next()?.to_lowercase();
    (h.len() == 64).then_some(h)
}

/// 파일 하나 — `<이름>.rbpart` 에 쓰고(있으면 이어서), sha256 이 맞으면 최종 이름으로
async fn copy_one(c: &Conn, it: &Item, up: bool, prog: &Arc<Mutex<Progress>>, cancel: &Arc<Mutex<HashSet<u32>>>, id: u32) -> Result<Outcome, String> {
    use sha2::Digest;
    use tokio::io::AsyncSeekExt;
    let part = format!("{}.rbpart", it.dest);
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut resumed = false;
    let check_cancel = || -> Result<(), String> {
        if cancel.lock().unwrap().contains(&id) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    };
    if up {
        let mut src = tokio::fs::File::open(&it.src).await.map_err(|e| e.to_string())?;
        // 이어 보내기: 원격에 같은 크기 이하의 .rbpart 가 있으면 그 뒤부터
        let have = c.sftp.metadata(part.clone()).await.ok().and_then(|m| m.size).filter(|s| *s > 0 && *s <= it.size).unwrap_or(0);
        let mut dst = if have > 0 {
            resumed = true;
            let mut f = c
                .sftp
                .open_with_flags(part.clone(), russh_sftp::protocol::OpenFlags::WRITE)
                .await
                .map_err(|e| sftp_err(e).message_owned())?;
            f.seek(std::io::SeekFrom::Start(have)).await.map_err(|e| e.to_string())?;
            // 이미 보낸 앞부분도 해시에 넣는다
            let mut left = have;
            while left > 0 {
                let n = src.read(&mut buf[..(left.min(CHUNK as u64) as usize)]).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                left -= n as u64;
            }
            prog.lock().unwrap().bytes_done += have;
            f
        } else {
            c.sftp.create(part.clone()).await.map_err(|e| sftp_err(e).message_owned())?
        };
        loop {
            check_cancel()?;
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            prog.lock().unwrap().bytes_done += n as u64;
        }
        dst.shutdown().await.map_err(|e| e.to_string())?;
        let mine = hex::encode(hasher.finalize());
        let theirs = remote_sha256(c, &part).await;
        if let Some(t) = &theirs {
            if *t != mine {
                let _ = c.sftp.remove_file(part.clone()).await;
                return Err(format!("{} — 보낸 파일의 sha256 이 맞지 않아 지웠습니다", base_name(&it.dest)));
            }
        }
        if c.sftp.try_exists(it.dest.clone()).await.unwrap_or(false) {
            c.sftp.remove_file(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
        }
        c.sftp.rename(part, it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
        Ok(Outcome { verified: theirs.is_some(), resumed })
    } else {
        let have = std::fs::metadata(&part).map(|m| m.len()).ok().filter(|s| *s > 0 && *s <= it.size).unwrap_or(0);
        let mut src = c.sftp.open(it.src.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
        let mut dst = if have > 0 {
            resumed = true;
            // 이미 받은 앞부분을 해시에 넣고 뒤에 붙인다
            let mut old = tokio::fs::File::open(&part).await.map_err(|e| e.to_string())?;
            loop {
                let n = old.read(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            src.seek(std::io::SeekFrom::Start(have)).await.map_err(|e| e.to_string())?;
            prog.lock().unwrap().bytes_done += have;
            tokio::fs::OpenOptions::new().append(true).open(&part).await.map_err(|e| e.to_string())?
        } else {
            tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?
        };
        loop {
            check_cancel()?;
            let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            prog.lock().unwrap().bytes_done += n as u64;
        }
        dst.flush().await.map_err(|e| e.to_string())?;
        drop(dst);
        let mine = hex::encode(hasher.finalize());
        let theirs = remote_sha256(c, &it.src).await;
        if let Some(t) = &theirs {
            if *t != mine {
                let _ = std::fs::remove_file(&part);
                return Err(format!("{} — 받은 파일의 sha256 이 맞지 않아 지웠습니다", base_name(&it.dest)));
            }
        }
        if Path::new(&it.dest).exists() {
            std::fs::remove_file(&it.dest).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&part, &it.dest).map_err(|e| e.to_string())?;
        Ok(Outcome { verified: theirs.is_some(), resumed })
    }
}

#[tauri::command]
pub fn transfer_cancel(transfers: State<'_, Transfers>, id: u32) {
    transfers.cancel.lock().unwrap().insert(id);
}

#[cfg(test)]
mod live {
    use super::*;

    /// `RB_SSH_TEST=127.0.0.1:22122:22123`·`RB_SSH_TEST_PW` 일 때만 — 올리기·받기·sha256·이어받기
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_transfer_verify_resume() {
        let spec = std::env::var("RB_SSH_TEST").expect("RB_SSH_TEST");
        let pw = std::env::var("RB_SSH_TEST_PW").expect("RB_SSH_TEST_PW");
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-xfer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(dir.join("db"), false).unwrap();
        let conns = SshConns::default();
        let ok = crate::ssh::test_connect(&store, &conns, &host, port, "rbtest", &pw).await;
        let c = conns.get(ok).unwrap();
        // 8 MiB 무작위 파일
        let src = dir.join("big.bin");
        let data: Vec<u8> = (0..8 * 1024 * 1024u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        let prog = Arc::new(Mutex::new(Progress {
            id: 1, direction: "up", name: String::new(), dest: String::new(), bytes_done: 0, bytes_total: 0,
            files_done: 0, files_total: 0, skipped: 0, verified: 0, resumed: 0, state: "running", error: None, ms: 0,
        }));
        let cancel: Arc<Mutex<HashSet<u32>>> = Default::default();
        let up = Item { src: src.to_string_lossy().into(), dest: "/home/rbtest/big.bin".into(), size: data.len() as u64, dir: false };
        let t = Instant::now();
        let o = copy_one(&c, &up, true, &prog, &cancel, 1).await.unwrap();
        println!("올리기 8 MiB {} ms, sha256 확인 {}", t.elapsed().as_millis(), o.verified);
        assert!(o.verified);
        // 받기
        let back = dir.join("back.bin");
        let down = Item { src: "/home/rbtest/big.bin".into(), dest: back.to_string_lossy().into(), size: data.len() as u64, dir: false };
        let t = Instant::now();
        let o = copy_one(&c, &down, false, &prog, &cancel, 1).await.unwrap();
        println!("받기 8 MiB {} ms, sha256 확인 {}", t.elapsed().as_millis(), o.verified);
        assert_eq!(std::fs::read(&back).unwrap(), data);
        // 이어받기: 앞 3 MiB 만 있는 .rbpart 를 두고 다시 받기
        std::fs::remove_file(&back).unwrap();
        std::fs::write(format!("{}.rbpart", back.to_string_lossy()), &data[..3 * 1024 * 1024]).unwrap();
        let o = copy_one(&c, &down, false, &prog, &cancel, 1).await.unwrap();
        println!("이어받기 → resumed {} verified {}", o.resumed, o.verified);
        assert!(o.resumed && o.verified);
        assert_eq!(std::fs::read(&back).unwrap(), data);
        // 깨진 .rbpart 는 sha256 이 안 맞아 지우고 실패해야 한다
        std::fs::remove_file(&back).unwrap();
        let mut bad = data[..3 * 1024 * 1024].to_vec();
        bad[100] ^= 0xff;
        std::fs::write(format!("{}.rbpart", back.to_string_lossy()), &bad).unwrap();
        let e = copy_one(&c, &down, false, &prog, &cancel, 1).await.err().unwrap();
        println!("깨진 이어받기 → {e}");
        assert!(e.contains("sha256"));
        let _ = c.sftp.remove_file("/home/rbtest/big.bin".to_string()).await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
