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
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh::{err, sftp_err, Conn, SshConns, R};

const CHUNK: usize = 256 * 1024;

#[derive(Default)]
pub struct Transfers {
    pub(crate) next: AtomicU32,
    pub(crate) cancel: Arc<Mutex<HashSet<u32>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
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

pub(crate) struct Item {
    pub(crate) src: String,
    pub(crate) dest: String,
    pub(crate) size: u64,
    pub(crate) dir: bool,
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
    spawn_items(app, transfers.cancel.clone(), c, id, if up { Mode::Up } else { Mode::Down }, name, items, overwrite);
    Ok(id)
}

#[derive(Clone)]
pub(crate) enum Mode {
    Up,
    Down,
    /// 서버 A → 서버 B(같은 앱 안의 다른 연결)
    Relay(Arc<Conn>),
}

/// 항목 목록을 뒤에서 옮긴다(진행률 transfer 이벤트) — 전송·동기화·중계 공용
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_items(app: AppHandle, cancel: Arc<Mutex<HashSet<u32>>>, c: Arc<Conn>, id: u32, mode: Mode, name: String, items: Vec<Item>, overwrite: bool) {
    let up = matches!(mode, Mode::Up);
    let total: u64 = items.iter().map(|i| i.size).sum();
    let files_total = items.iter().filter(|i| !i.dir).count() as u32;
    let dest = items.first().map(|i| i.dest.clone()).unwrap_or_default();
    let app2 = app.clone();
    let c2: Arc<Conn> = c.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let prog = Arc::new(Mutex::new(Progress {
            id,
            direction: match mode {
                Mode::Up => "up",
                Mode::Down => "down",
                Mode::Relay(_) => "relay",
            },
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
                if let Mode::Relay(b) = &mode {
                    if b.sftp.metadata(it.dest.clone()).await.is_err() {
                        b.sftp.create_dir(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
                    }
                } else if up {
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
                    let mode = mode.clone();
                    async move {
                        if cancel.lock().unwrap().contains(&id) {
                            return Err("cancelled".to_string());
                        }
                        let exists = match &mode {
                            Mode::Up => c2.sftp.try_exists(it.dest.clone()).await.unwrap_or(false),
                            Mode::Down => Path::new(&it.dest).exists(),
                            Mode::Relay(b) => b.sftp.try_exists(it.dest.clone()).await.unwrap_or(false),
                        };
                        if exists && !overwrite {
                            let mut p = prog.lock().unwrap();
                            p.skipped += 1;
                            p.bytes_done += it.size;
                            return Ok(());
                        }
                        let outcome = match &mode {
                            Mode::Relay(b) => relay_one(&c2, b, it, &prog, &cancel, id).await?,
                            _ => copy_one(&c2, it, up, &prog, &cancel, id).await?,
                        };
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
}

pub(crate) struct Outcome {
    pub(crate) verified: bool,
    pub(crate) resumed: bool,
}

/// 서버 A 의 파일을 서버 B 로 — 내 PC 를 거쳐 흘려 보낸다(디스크에 남기지 않음). 양쪽 sha256 을 맞춰 본다
async fn relay_one(a: &Conn, b: &Conn, it: &Item, prog: &Arc<Mutex<Progress>>, cancel: &Arc<Mutex<HashSet<u32>>>, id: u32) -> Result<Outcome, String> {
    use sha2::Digest;
    let part = format!("{}.rbpart", it.dest);
    let mut src = a.sftp.open(it.src.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
    let mut dst = b.sftp.create(part.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.lock().unwrap().contains(&id) {
            return Err("cancelled".into());
        }
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
    let (ha, hb) = (remote_sha256(a, &it.src).await, remote_sha256(b, &part).await);
    for h in [&ha, &hb].into_iter().flatten() {
        if *h != mine {
            let _ = b.sftp.remove_file(part.clone()).await;
            return Err(format!("{} — sha256 이 맞지 않아 지웠습니다", base_name(&it.dest)));
        }
    }
    if b.sftp.try_exists(it.dest.clone()).await.unwrap_or(false) {
        b.sftp.remove_file(it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
    }
    b.sftp.rename(part, it.dest.clone()).await.map_err(|e| sftp_err(e).message_owned())?;
    Ok(Outcome { verified: ha.is_some() && hb.is_some(), resumed: false })
}

/// 서버 A → 서버 B 중계 시작
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn relay_start(
    app: AppHandle,
    conns: State<'_, SshConns>,
    transfers: State<'_, Transfers>,
    from_conn: u32,
    src: String,
    to_conn: u32,
    dest_dir: String,
    overwrite: bool,
) -> R<u32> {
    let a = conns.get(from_conn)?;
    let b = conns.get(to_conn)?;
    let id = transfers.next.fetch_add(1, Ordering::Relaxed) + 1;
    let name = base_name(&src);
    let mut items = Vec::new();
    walk_remote(&a, &src, Path::new(&dest_dir).join(&name), &mut items).await?;
    // 원격 경로는 늘 / — Windows 의 PathBuf 가 \ 로 이은 것을 바로잡는다
    for it in &mut items {
        it.dest = it.dest.replace('\\', "/");
    }
    spawn_items(app, transfers.cancel.clone(), a, id, Mode::Relay(b), name, items, overwrite);
    Ok(id)
}

/// 원격 sha256 — 서버에 sha256sum 이 없으면 None(확인 건너뜀)
pub(crate) async fn remote_sha256(c: &Conn, path: &str) -> Option<String> {
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
pub(crate) async fn copy_one(c: &Conn, it: &Item, up: bool, prog: &Arc<Mutex<Progress>>, cancel: &Arc<Mutex<HashSet<u32>>>, id: u32) -> Result<Outcome, String> {
    use sha2::Digest;
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

/// 진행률을 따로 보이지 않는 한 파일 전송용(경로 매핑 자동 반영)
pub(crate) fn dummy_progress() -> Arc<Mutex<Progress>> {
    Arc::new(Mutex::new(Progress {
        id: 0,
        direction: "up",
        name: String::new(),
        dest: String::new(),
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        skipped: 0,
        verified: 0,
        resumed: 0,
        state: "running",
        error: None,
        ms: 0,
    }))
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

/// 탐색기에서 끌어 놓은 파일 올리기 — 화면이 파일을 조각(몇 MB)으로 보내면 차례대로 쓴다.
/// 본문은 바이너리 그대로, 머리에 x-conn·x-path(URI 인코딩)·x-offset. offset 0 이면 새로 만들기(덮어쓰기)
#[tauri::command]
pub async fn sftp_put_chunk(conns: State<'_, SshConns>, request: tauri::ipc::Request<'_>) -> R<()> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(err("OTHER", "본문이 없습니다"));
    };
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let conn: u32 = get("x-conn").and_then(|v| v.parse().ok()).ok_or_else(|| err("OTHER", "연결 번호가 없습니다"))?;
    let path = get("x-path").map(|p| percent_decode(&p)).ok_or_else(|| err("OTHER", "경로가 없습니다"))?;
    let offset: u64 = get("x-offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    put_chunk(&*conns.get(conn)?, path, offset, data).await
}

pub(crate) async fn put_chunk(c: &Conn, path: String, offset: u64, data: &[u8]) -> R<()> {
    let mut f = if offset == 0 {
        c.sftp.create(path).await.map_err(sftp_err)?
    } else {
        let mut f = c.sftp.open_with_flags(path, russh_sftp::protocol::OpenFlags::WRITE).await.map_err(sftp_err)?;
        f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| err("SFTP", e.to_string()))?;
        f
    };
    f.write_all(data).await.map_err(|e| err("SFTP", e.to_string()))?;
    f.shutdown().await.map_err(|e| err("SFTP", e.to_string()))?;
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 서버 안 복사(cp -a, 같은 이름이 있으면 거절)
#[tauri::command]
pub async fn ssh_copy(conns: State<'_, SshConns>, conn: u32, from: String, to: String) -> R<()> {
    let c = conns.get(conn)?;
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\''"));
    let cmd = format!("[ -e {t} ] && {{ echo '같은 이름이 이미 있습니다' >&2; exit 1; }}; cp -a -- {f} {t}", f = q(&from), t = q(&to));
    let o = crate::sudo::exec(&c, &cmd, None).await?;
    if o.code != Some(0) {
        return Err(err("SFTP", o.stderr.trim().lines().last().unwrap_or("복사하지 못했습니다").to_string()));
    }
    Ok(())
}

/// 내 PC 안 복사(폴더는 안까지, 같은 이름이 있으면 거절)
#[tauri::command]
pub fn local_copy(from: String, to: String) -> Result<(), String> {
    fn copy(a: &Path, b: &Path) -> std::io::Result<()> {
        if a.is_dir() {
            std::fs::create_dir(b)?;
            for e in std::fs::read_dir(a)? {
                let e = e?;
                copy(&e.path(), &b.join(e.file_name()))?;
            }
            Ok(())
        } else {
            std::fs::copy(a, b).map(|_| ())
        }
    }
    let (a, b) = (PathBuf::from(&from), PathBuf::from(&to));
    if b.exists() {
        return Err("같은 이름이 이미 있습니다".into());
    }
    if b.starts_with(&a) {
        return Err("폴더를 자기 안으로 복사할 수 없습니다".into());
    }
    copy(&a, &b).map_err(|e| e.to_string())
}

#[cfg(test)]
mod copy_tests {
    use super::*;

    #[test]
    fn decode_and_local_copy() {
        assert_eq!(percent_decode("%2Fhome%2F%ED%95%9C%EA%B8%80%20a.txt"), "/home/한글 a.txt");
        let d = std::env::temp_dir().join(format!("rbshell-copy-{}", std::process::id()));
        std::fs::create_dir_all(d.join("src/sub")).unwrap();
        std::fs::write(d.join("src/sub/x.txt"), "x").unwrap();
        local_copy(d.join("src").to_string_lossy().into(), d.join("dst").to_string_lossy().into()).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("dst/sub/x.txt")).unwrap(), "x");
        assert!(local_copy(d.join("src").to_string_lossy().into(), d.join("dst").to_string_lossy().into()).is_err());
        assert!(local_copy(d.join("src").to_string_lossy().into(), d.join("src/sub/in").to_string_lossy().into()).is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}

#[cfg(test)]
mod live_put {
    use super::*;

    /// RB_SSH_TEST·RB_SSH_TEST_PW — 조각 올리기(한글 이름) 뒤 서버 sha256 이 같은지
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_put_chunks() {
        let spec = std::env::var("RB_SSH_TEST").unwrap();
        let pw = std::env::var("RB_SSH_TEST_PW").unwrap();
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-put-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(dir.join("db"), false).unwrap();
        let conns = SshConns::default();
        let cid = crate::ssh::test_connect(&store, &conns, &host, port, "rbtest", &pw).await;
        let c = conns.get(cid).unwrap();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let path = "/home/rbtest/올림 시험.bin".to_string();
        let mut off = 0usize;
        for chunk in data.chunks(1 << 20) {
            put_chunk(&c, path.clone(), off as u64, chunk).await.unwrap();
            off += chunk.len();
        }
        use sha2::Digest;
        let want = format!("{:x}", sha2::Sha256::digest(&data));
        let o = crate::sudo::exec(&c, "sha256sum '/home/rbtest/올림 시험.bin'; rm -f '/home/rbtest/올림 시험.bin'", None).await.unwrap();
        let got = String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap_or("").to_string();
        assert_eq!(got, want);
        let _ = std::fs::remove_dir_all(dir);
    }
}
