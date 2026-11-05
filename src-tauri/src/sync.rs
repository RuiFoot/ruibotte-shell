//! 폴더 동기화(rsync 모드) — 내 PC 폴더 ↔ 서버 폴더.
//! - 계획(dry-run): 양쪽을 훑어 새 파일·바뀐 파일(크기·시각, 체크섬 모드는 sha256)·지울 파일(선택)을 고른다. 제외 패턴(* ? **) 지원.
//! - 실행: 지우기 먼저, 옮기기는 공용 전송(동시 3·이어받기·sha256 확인)으로.
//! - rsync 명령 만들기: 같은 설정의 rsync 명령(서버에 rsync 가 있을 때 터미널에서 쓰기).
//! - 경로 매핑 자동 반영: 내 PC 폴더를 감시하다 바뀐 파일을 서버로(서버 쪽이 마지막 반영 뒤에 바뀌었으면 덮어쓰지 않고 충돌로 알림).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{err, sftp_err, Conn, SshConns, R};
use crate::transfer::{spawn_items, Item, Mode, Transfers};

const MAX_ENTRIES: usize = 50_000;

#[derive(Clone, Debug)]
struct Meta {
    size: u64,
    mtime: u64,
    dir: bool,
}

/// 아주 작은 glob — * (한 단계) · ** (여러 단계) · ? . 경로 전체나 이름에 맞으면 제외
fn glob_match(pat: &str, text: &str) -> bool {
    fn rec(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) if p.get(1) == Some(&b'*') => (0..=t.len()).any(|i| rec(&p[2..], &t[i..])),
            (Some(b'*'), _) => (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != b'/').any(|i| rec(&p[1..], &t[i..])),
            (Some(b'?'), Some(c)) if *c != b'/' => rec(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a == b => rec(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let name = text.rsplit('/').next().unwrap_or(text);
    rec(pat.as_bytes(), text.as_bytes()) || rec(pat.as_bytes(), name.as_bytes())
}

fn excluded(rel: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|p| !p.trim().is_empty() && glob_match(p.trim().trim_end_matches('/'), rel))
}

fn scan_local(root: &Path, excludes: &[String]) -> Result<HashMap<String, Meta>, String> {
    let mut out = HashMap::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let dir = root.join(&rel);
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for e in rd.flatten() {
            let r = rel.join(e.file_name());
            let rs = r.to_string_lossy().replace('\\', "/");
            if excluded(&rs, excludes) || rs.ends_with(".rbpart") {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            if m.is_dir() {
                stack.push(r);
            }
            out.insert(rs, Meta { size: m.len(), mtime, dir: m.is_dir() });
            if out.len() > MAX_ENTRIES {
                return Err(format!("{MAX_ENTRIES}개가 넘어 멈췄습니다. 제외 패턴으로 줄이세요"));
            }
        }
    }
    Ok(out)
}

async fn scan_remote(c: &Conn, root: &str, excludes: &[String]) -> R<HashMap<String, Meta>> {
    let mut out = HashMap::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { root.to_string() } else { format!("{}/{rel}", root.trim_end_matches('/')) };
        let rd = match c.sftp.read_dir(dir.clone()).await {
            Ok(r) => r,
            Err(e) if rel.is_empty() => {
                // 서버 쪽 폴더가 아직 없으면 빈 것으로
                if e.to_string().contains("No such file") {
                    return Ok(out);
                }
                return Err(sftp_err(e));
            }
            Err(_) => continue,
        };
        for e in rd {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let rs = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if excluded(&rs, excludes) || rs.ends_with(".rbpart") {
                continue;
            }
            let m = e.metadata();
            if m.is_dir() {
                stack.push(rs.clone());
            }
            out.insert(rs, Meta { size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as u64, dir: m.is_dir() });
            if out.len() > MAX_ENTRIES {
                return Err(err("OTHER", format!("{MAX_ENTRIES}개가 넘어 멈췄습니다. 제외 패턴으로 줄이세요")));
            }
        }
    }
    Ok(out)
}

fn local_sha256(p: &Path) -> Option<String> {
    use sha2::Digest;
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(hex::encode(h.finalize()))
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncOpts {
    local: String,
    remote: String,
    /// "up" = 내 PC → 서버, "down" = 서버 → 내 PC
    direction: String,
    #[serde(default)]
    delete: bool,
    #[serde(default)]
    checksum: bool,
    #[serde(default)]
    excludes: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncAction {
    path: String,
    /// copy | delete
    action: &'static str,
    /// new | changed | extra
    reason: &'static str,
    size: u64,
    dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    actions: Vec<SyncAction>,
    same: usize,
    bytes: u64,
    ms: u64,
}

async fn plan(c: &Conn, o: &SyncOpts) -> R<SyncPlan> {
    let t0 = std::time::Instant::now();
    let local = scan_local(Path::new(&o.local), &o.excludes).map_err(|e| err("OTHER", e))?;
    let remote = scan_remote(c, &o.remote, &o.excludes).await?;
    let up = o.direction == "up";
    let (src, dst) = if up { (&local, &remote) } else { (&remote, &local) };
    let mut actions = Vec::new();
    let mut same = 0;
    let mut maybe_same: Vec<String> = Vec::new();
    let mut keys: Vec<&String> = src.keys().collect();
    keys.sort();
    for k in keys {
        let s = &src[k];
        match dst.get(k) {
            None => actions.push(SyncAction { path: k.clone(), action: "copy", reason: "new", size: s.size, dir: s.dir }),
            Some(d) if s.dir || d.dir => {
                if s.dir != d.dir {
                    actions.push(SyncAction { path: k.clone(), action: "copy", reason: "changed", size: s.size, dir: s.dir });
                } else {
                    same += 1;
                }
            }
            Some(d) => {
                if s.size != d.size || (!o.checksum && s.mtime > d.mtime + 2) {
                    actions.push(SyncAction { path: k.clone(), action: "copy", reason: "changed", size: s.size, dir: false });
                } else if o.checksum {
                    maybe_same.push(k.clone());
                } else {
                    same += 1;
                }
            }
        }
    }
    // 체크섬: 크기가 같은 파일만 sha256 비교(서버는 sha256sum 200개씩)
    if o.checksum && !maybe_same.is_empty() {
        let mut remote_hash: HashMap<String, String> = HashMap::new();
        for chunk in maybe_same.chunks(200) {
            let root = o.remote.trim_end_matches('/');
            let args: Vec<String> = chunk.iter().map(|k| format!("'{}'", k.replace('\'', "'\\''"))).collect();
            let cmd = format!("cd '{}' && sha256sum -- {} 2>/dev/null", root.replace('\'', "'\\''"), args.join(" "));
            let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
            ch.exec(true, cmd.as_str()).await.map_err(|e| err("OTHER", e.to_string()))?;
            let mut out = Vec::new();
            while let Some(m) = ch.wait().await {
                if let russh::ChannelMsg::Data { data } = m {
                    out.extend_from_slice(&data);
                }
            }
            for line in String::from_utf8_lossy(&out).lines() {
                if let Some((h, p)) = line.split_once("  ") {
                    remote_hash.insert(p.to_string(), h.to_string());
                }
            }
        }
        for k in maybe_same {
            let lh = local_sha256(&Path::new(&o.local).join(&k));
            match (lh, remote_hash.get(&k)) {
                (Some(a), Some(b)) if a == *b => same += 1,
                _ => actions.push(SyncAction { path: k.clone(), action: "copy", reason: "changed", size: src[&k].size, dir: false }),
            }
        }
    }
    if o.delete {
        let mut extra: Vec<&String> = dst.keys().filter(|k| !src.contains_key(*k)).collect();
        extra.sort(); // 폴더가 안의 것보다 먼저 — 폴더를 지우면 안의 것은 건너뜀
        for k in extra {
            // 지울 폴더 안의 것은 폴더 하나로 충분
            if extra_parent_deleted(k, &actions) {
                continue;
            }
            actions.push(SyncAction { path: k.clone(), action: "delete", reason: "extra", size: dst[k].size, dir: dst[k].dir });
        }
    }
    let bytes = actions.iter().filter(|a| a.action == "copy" && !a.dir).map(|a| a.size).sum();
    Ok(SyncPlan { actions, same, bytes, ms: t0.elapsed().as_millis() as u64 })
}

fn extra_parent_deleted(k: &str, actions: &[SyncAction]) -> bool {
    actions.iter().any(|a| a.action == "delete" && a.dir && k.starts_with(&format!("{}/", a.path)))
}

#[tauri::command]
pub async fn sync_plan(conns: State<'_, SshConns>, conn: u32, opts: SyncOpts) -> R<SyncPlan> {
    let c = conns.get(conn)?;
    plan(&c, &opts).await
}

/// 계획을 다시 세워(그사이 바뀐 것까지) 실행 — 지우기 먼저, 옮기기는 공용 전송
#[tauri::command]
pub async fn sync_run(app: AppHandle, conns: State<'_, SshConns>, transfers: State<'_, Transfers>, conn: u32, opts: SyncOpts) -> R<u32> {
    let c = conns.get(conn)?;
    let p = plan(&c, &opts).await?;
    let up = opts.direction == "up";
    let rroot = opts.remote.trim_end_matches('/').to_string();
    let lroot = PathBuf::from(&opts.local);
    for a in p.actions.iter().filter(|a| a.action == "delete") {
        if up {
            let path = format!("{rroot}/{}", a.path);
            if a.dir {
                let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
                ch.exec(true, format!("rm -rf -- '{}'", path.replace('\'', "'\\''")).as_str()).await.map_err(|e| err("OTHER", e.to_string()))?;
                while ch.wait().await.is_some() {}
            } else {
                c.sftp.remove_file(path).await.map_err(sftp_err)?;
            }
        } else {
            let path = lroot.join(&a.path);
            let _ = trash::delete(&path);
        }
    }
    if up {
        let _ = c.sftp.create_dir(rroot.clone()).await;
    } else {
        let _ = std::fs::create_dir_all(&lroot);
    }
    let items: Vec<Item> = p
        .actions
        .iter()
        .filter(|a| a.action == "copy")
        .map(|a| {
            let l = lroot.join(&a.path).to_string_lossy().into_owned();
            let r = format!("{rroot}/{}", a.path);
            let (src, dest) = if up { (l, r) } else { (r, l) };
            Item { src, dest, size: a.size, dir: a.dir }
        })
        .collect();
    let id = transfers.next.fetch_add(1, Ordering::Relaxed) + 1;
    let name = Path::new(if up { &opts.local } else { &opts.remote }).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "동기화".into());
    spawn_items(app, transfers.cancel.clone(), c, id, if up { Mode::Up } else { Mode::Down }, format!("{name} 동기화"), items, true);
    Ok(id)
}

/// 같은 설정의 rsync 명령 — 서버 쪽에서 쓰거나 내 PC 의 rsync(WSL 등)로
#[tauri::command]
pub fn sync_rsync_command(opts: SyncOpts, user: String, host: String, port: u16) -> String {
    let mut flags = String::from("-avz --partial --progress");
    if opts.delete {
        flags.push_str(" --delete");
    }
    if opts.checksum {
        flags.push_str(" --checksum");
    }
    for x in opts.excludes.iter().filter(|x| !x.trim().is_empty()) {
        flags.push_str(&format!(" --exclude='{}'", x.trim()));
    }
    let ssh = if port == 22 { String::new() } else { format!(" -e 'ssh -p {port}'") };
    let local = format!("{}/", opts.local.trim_end_matches(['/', '\\']).replace('\\', "/"));
    let remote = format!("{user}@{host}:{}/", opts.remote.trim_end_matches('/'));
    let dry = format!("# 먼저 미리보기: rsync {flags} --dry-run{ssh} ...");
    if opts.direction == "up" {
        format!("{dry}\nrsync {flags}{ssh} '{local}' '{remote}'")
    } else {
        format!("{dry}\nrsync {flags}{ssh} '{remote}' '{local}'")
    }
}

// ── 경로 매핑 자동 반영 ─────────────

#[derive(Default)]
pub struct Watches {
    next: AtomicU32,
    map: Mutex<HashMap<u32, notify::RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WatchEvent {
    id: u32,
    path: String,
    /// sent | conflict | error
    state: &'static str,
    message: Option<String>,
}

/// 내 PC 폴더를 감시해 바뀐 파일을 서버의 같은 자리로. 서버 쪽이 마지막 반영 뒤 바뀌었으면 충돌로 알리고 덮어쓰지 않는다
#[tauri::command]
pub fn watch_start(app: AppHandle, conns: State<'_, SshConns>, watches: State<'_, Watches>, conn: u32, local: String, remote: String, excludes: Vec<String>) -> R<u32> {
    let c = conns.get(conn)?;
    let id = watches.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_)) {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        }
    })
    .map_err(|e| err("OTHER", e.to_string()))?;
    w.watch(Path::new(&local), RecursiveMode::Recursive).map_err(|e| err("OTHER", e.to_string()))?;
    watches.map.lock().unwrap().insert(id, w);
    let lroot = PathBuf::from(&local);
    let rroot = remote.trim_end_matches('/').to_string();
    // 서버 파일의 마지막으로 본 mtime — 우리가 올린 뒤의 값
    let known: Arc<Mutex<HashMap<String, u32>>> = Default::default();
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(first) = rx.recv().await else { break };
            // 0.5초 모아서 한 번에(저장 한 번에 이벤트가 여러 번 온다)
            let mut batch: HashSet<PathBuf> = HashSet::from([first]);
            tokio::time::sleep(Duration::from_millis(500)).await;
            while let Ok(p) = rx.try_recv() {
                batch.insert(p);
            }
            for p in batch {
                let Ok(rel) = p.strip_prefix(&lroot) else { continue };
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel.is_empty() || excluded(&rel, &excludes) || rel.ends_with(".rbpart") || !p.is_file() {
                    continue;
                }
                let dest = format!("{rroot}/{rel}");
                let now = c.sftp.metadata(dest.clone()).await.ok().and_then(|m| m.mtime);
                let last = known.lock().unwrap().get(&rel).copied();
                if let (Some(n), Some(l)) = (now, last) {
                    if n != l {
                        let _ = app.emit("watch", WatchEvent { id, path: rel.clone(), state: "conflict", message: Some("서버 쪽이 바뀌어 덮어쓰지 않았습니다".into()) });
                        continue;
                    }
                }
                if let Some(parent) = dest.rsplit_once('/').map(|x| x.0) {
                    let _ = c.sftp.create_dir(parent.to_string()).await;
                }
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let item = Item { src: p.to_string_lossy().into_owned(), dest: dest.clone(), size, dir: false };
                let prog = crate::transfer::dummy_progress();
                let cancel: Arc<Mutex<HashSet<u32>>> = Default::default();
                match crate::transfer::copy_one(&c, &item, true, &prog, &cancel, 0).await {
                    Ok(_) => {
                        if let Some(m) = c.sftp.metadata(dest).await.ok().and_then(|m| m.mtime) {
                            known.lock().unwrap().insert(rel.clone(), m);
                        }
                        let _ = app.emit("watch", WatchEvent { id, path: rel, state: "sent", message: None });
                    }
                    Err(e) => {
                        let _ = app.emit("watch", WatchEvent { id, path: rel, state: "error", message: Some(e) });
                    }
                }
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn watch_stop(watches: State<'_, Watches>, id: u32) {
    watches.map.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("*.log", "app/logs/a.log"));
        assert!(glob_match("node_modules", "web/node_modules"));
        assert!(glob_match("build/**", "build/x/y.js"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("*.log", "app/a.txt"));
        assert!(!glob_match("src/*.js", "src/x/y.js"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// RB_SSH_TEST·RB_SSH_TEST_PW — 계획: 새·바뀐(크기·체크섬)·지울·제외
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_sync_plan() {
        let spec = std::env::var("RB_SSH_TEST").unwrap();
        let pw = std::env::var("RB_SSH_TEST_PW").unwrap();
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-sync-{}", std::process::id()));
        let l = dir.join("l");
        std::fs::create_dir_all(l.join("sub")).unwrap();
        std::fs::write(l.join("a.txt"), "same").unwrap();
        std::fs::write(l.join("b.txt"), "local-bigger").unwrap();
        std::fs::write(l.join("c.txt"), "abcd").unwrap();
        std::fs::write(l.join("sub/new.txt"), "n").unwrap();
        std::fs::write(l.join("x.log"), "skip").unwrap();
        let store = crate::store::Store::open(dir.join("db"), false).unwrap();
        let conns = SshConns::default();
        let cid = crate::ssh::test_connect(&store, &conns, &host, port, "rbtest", &pw).await;
        let c = conns.get(cid).unwrap();
        let r = "/home/rbtest/rbsync";
        let mut ch = c.handle_ref().channel_open_session().await.unwrap();
        ch.exec(true, "rm -rf /home/rbtest/rbsync && mkdir -p /home/rbtest/rbsync/old && printf same > /home/rbtest/rbsync/a.txt && printf b > /home/rbtest/rbsync/b.txt && printf wxyz > /home/rbtest/rbsync/c.txt && touch -d '2030-01-01' /home/rbtest/rbsync/c.txt && printf o > /home/rbtest/rbsync/old/z.txt").await.unwrap();
        while ch.wait().await.is_some() {}
        let o = |checksum: bool, delete: bool| SyncOpts { local: l.to_string_lossy().into(), remote: r.into(), direction: "up".into(), delete, checksum, excludes: vec!["*.log".into()] };
        let show = |p: &SyncPlan| p.actions.iter().map(|a| format!("{}:{}:{}", a.action, a.reason, a.path)).collect::<Vec<_>>();
        let p1 = plan(&c, &o(false, false)).await.unwrap();
        println!("크기·시각: {:?} 같음 {}", show(&p1), p1.same);
        let p2 = plan(&c, &o(true, true)).await.unwrap();
        println!("체크섬+지우기: {:?} 같음 {}", show(&p2), p2.same);
        let s2 = show(&p2);
        assert!(s2.contains(&"copy:changed:c.txt".to_string()), "같은 크기·다른 내용은 체크섬에서 잡혀야");
        assert!(s2.contains(&"copy:changed:b.txt".to_string()));
        assert!(s2.contains(&"copy:new:sub/new.txt".to_string()));
        assert!(s2.contains(&"delete:extra:old".to_string()));
        assert!(!s2.iter().any(|x| x.contains("x.log")));
        assert!(!s2.iter().any(|x| x.ends_with(":a.txt")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
