//! sudo 파일 작업 — 일반 계정으로 접속해 root 파일을 보고 고친다(exec 채널).
//! 암호 줄이 파일 내용으로 섞이지 않게: 늘 `sudo -n` 으로 시도하고, 암호가 필요하다고 하면
//! `sudo -S -p '' -v` 로 한 번 인증한 뒤 다시 `sudo -n` 으로 실행한다.
//! 목록은 GNU find 의 -printf 를 쓴다(리눅스 서버 전제).
//! sudo 설정은 연결한 계정을 따른다: off(안 씀) · ask(켤 때 물음, 이 연결 동안만 기억) · saved(저장한 암호) · nopasswd(암호 없이).
//! sudo 대상 사용자가 root 가 아니면 `sudo -u <사용자>`.

use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;

use crate::secrets;
use crate::ssh::{err, Conn, SshConns, R};
use crate::textcodec::{self, TextMeta};

pub(crate) const MAX_TEXT: usize = 8 * 1024 * 1024;

pub(crate) struct Out {
    pub(crate) code: Option<u32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

pub(crate) fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) async fn exec(c: &Conn, cmd: &str, stdin: Option<&[u8]>) -> R<Out> {
    let mut ch = c.handle_ref().channel_open_session().await.map_err(|e| err("OTHER", e.to_string()))?;
    ch.exec(true, cmd).await.map_err(|e| err("OTHER", e.to_string()))?;
    if let Some(input) = stdin {
        ch.data(input).await.map_err(|e| err("OTHER", e.to_string()))?;
    }
    ch.eof().await.map_err(|e| err("OTHER", e.to_string()))?;
    let mut out = Out { code: None, stdout: Vec::new(), stderr: String::new() };
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } => {
                out.stdout.extend_from_slice(&data);
                if out.stdout.len() > MAX_TEXT + 1024 {
                    return Err(err("SFTP", "파일이 너무 큽니다"));
                }
            }
            ChannelMsg::ExtendedData { data, .. } => out.stderr.push_str(&String::from_utf8_lossy(&data)),
            ChannelMsg::ExitStatus { exit_status } => out.code = Some(exit_status),
            _ => {}
        }
    }
    Ok(out)
}

fn needs_password(o: &Out) -> bool {
    o.code != Some(0) && (o.stderr.contains("password is required") || o.stderr.contains("a terminal is required"))
}

/// 이 연결에서 쓸 sudo 암호 — 이번에 넣은 것(메모리), 없으면 "암호 저장" 계정의 저장한 암호. "암호 없이"면 없음
pub(crate) fn password_of(c: &Conn) -> Option<String> {
    let mode = c.sudo.lock().unwrap().mode.clone();
    if mode == "nopasswd" || mode == "off" {
        return None;
    }
    if let Some(p) = c.sudo_pw.lock().unwrap().clone().filter(|p| !p.is_empty()) {
        return Some(p);
    }
    if mode == "saved" {
        return c.account_id.and_then(|id| secrets::get(&secrets::sudo_key(id)));
    }
    None
}

/// `sudo -n [-u 사용자] -- <cmd>`
fn sudo_cmd(c: &Conn, cmd: &str) -> R<String> {
    let cfg = c.sudo.lock().unwrap().clone();
    if cfg.mode == "off" {
        return Err(err("AUTH_FAILED", "이 계정은 sudo 를 쓰지 않게 설정돼 있습니다 — 계정 설정에서 sudo 를 켜세요"));
    }
    Ok(if cfg.user.is_empty() || cfg.user == "root" { format!("sudo -n -- {cmd}") } else { format!("sudo -n -u {} -- {cmd}", q(&cfg.user)) })
}

/// `sudo -n <cmd>` — 암호가 필요하면 이번에 넣은(또는 저장한) 암호로 한 번 인증하고 다시
pub(crate) async fn sudo(c: &Conn, cmd: &str, stdin: Option<&[u8]>) -> R<Out> {
    sudo_with(c, None, cmd, stdin).await
}

async fn sudo_with(c: &Conn, typed: Option<&str>, cmd: &str, stdin: Option<&[u8]>) -> R<Out> {
    let full = sudo_cmd(c, cmd)?;
    let o = exec(c, &full, stdin).await?;
    if !needs_password(&o) {
        return check(o);
    }
    let nopasswd = c.sudo.lock().unwrap().mode == "nopasswd";
    let password = typed.map(str::to_string).or_else(|| password_of(c));
    let Some(pw) = password.filter(|p| !p.is_empty()) else {
        return Err(if nopasswd {
            err("AUTH_FAILED", "이 계정은 '암호 없이'로 설정했지만 서버가 sudo 암호를 묻습니다 — 계정 설정에서 sudo 방식을 바꾸세요")
        } else {
            err("NEED_SECRET", "sudo 암호가 필요합니다")
        });
    };
    let v = exec(c, "sudo -S -p '' -v", Some(format!("{pw}\n").as_bytes())).await?;
    if v.code != Some(0) {
        return Err(err("AUTH_FAILED", if v.stderr.contains("not in the sudoers") { "이 계정은 sudo 를 쓸 수 없습니다" } else { "sudo 암호가 맞지 않습니다" }));
    }
    check(exec(c, &full, stdin).await?)
}

fn check(o: Out) -> R<Out> {
    if o.code == Some(0) {
        return Ok(o);
    }
    let msg = o.stderr.lines().last().unwrap_or("실패").to_string();
    if msg.contains("not in the sudoers") || msg.contains("may not run sudo") {
        return Err(err("AUTH_FAILED", "이 계정은 sudo 를 쓸 수 없습니다"));
    }
    Err(err("SFTP", msg))
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) kind: &'static str,
    pub(crate) size: u64,
    pub(crate) mtime: Option<u32>,
}

pub(crate) fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// sudo 를 켤 때 한 번 — 되는지 보고(넣은 암호는 이 연결 동안 기억), 원하면 그 계정의 sudo 암호로 OS 저장소에
#[tauri::command]
pub async fn sudo_check(store: State<'_, crate::store::Store>, conns: State<'_, SshConns>, conn: u32, password: Option<String>, save: bool) -> R<bool> {
    let c = conns.get(conn)?;
    let typed = password.filter(|p| !p.is_empty());
    sudo_with(&c, typed.as_deref(), "true", None).await?;
    if let Some(p) = typed {
        *c.sudo_pw.lock().unwrap() = Some(p.clone());
        if let (true, Some(id)) = (save, c.account_id) {
            if store.account_sudo_secret_set(id, &p).is_ok() {
                c.sudo.lock().unwrap().mode = "saved".into();
            }
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn sudo_list(conns: State<'_, SshConns>, conn: u32, path: String) -> R<Vec<FsEntry>> {
    let c = conns.get(conn)?;
    let o = sudo(&c, &format!("find {} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'", q(&path)), None).await?;
    let mut out: Vec<FsEntry> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(4, '\t');
            let (t, s, m, n) = (it.next()?, it.next()?, it.next()?, it.next()?);
            Some(FsEntry {
                kind: match t {
                    "d" => "dir",
                    "f" => "file",
                    "l" => "link",
                    _ => "other",
                },
                size: s.parse().unwrap_or(0),
                mtime: m.split('.').next().and_then(|x| x.parse().ok()),
                path: join(&path, n),
                name: n.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) mtime: Option<u32>,
    pub(crate) text: Option<String>,
    pub(crate) meta: TextMeta,
    pub(crate) binary: bool,
    pub(crate) too_large: bool,
}

#[tauri::command]
pub async fn sudo_read_text(conns: State<'_, SshConns>, conn: u32, path: String, encoding: Option<String>) -> R<FileText> {
    let c = conns.get(conn)?;
    let st = sudo(&c, &format!("stat -c '%s %Y' -- {}", q(&path)), None).await?;
    let st = String::from_utf8_lossy(&st.stdout).to_string();
    let mut it = st.split_whitespace();
    let size: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let mtime: Option<u32> = it.next().and_then(|x| x.parse().ok());
    if size as usize > MAX_TEXT {
        // 앞부분만 읽기 전용으로
        let o = sudo(&c, &format!("head -c {} -- {}", crate::localfs::HEAD_TEXT, q(&path)), None).await?;
        let d = textcodec::decode(&crate::localfs::trim_head(o.stdout), encoding.as_deref());
        return Ok(FileText { path, size, mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: true });
    }
    let o = sudo(&c, &format!("cat -- {}", q(&path)), None).await?;
    let d = textcodec::decode(&o.stdout, encoding.as_deref());
    Ok(FileText { path, size, mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub(crate) size: u64,
    pub(crate) mtime: Option<u32>,
}

/// 저장 = `sudo tee` — 같은 파일(inode)에 써서 소유자·권한을 지킨다
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sudo_write_text(
    conns: State<'_, SshConns>,
    conn: u32,
    path: String,
    text: String,
    meta: TextMeta,
    expect_mtime: Option<u32>,
) -> R<Saved> {
    let c = conns.get(conn)?;
    if let Some(exp) = expect_mtime {
        let st = sudo(&c, &format!("stat -c '%Y' -- {}", q(&path)), None).await?;
        let now: Option<u32> = String::from_utf8_lossy(&st.stdout).trim().parse().ok();
        if now.is_some_and(|t| t != exp) {
            return Err(err("CONFLICT", "연 뒤에 서버에서 파일이 바뀌었습니다. 다시 열어 확인하세요."));
        }
    }
    let bytes = textcodec::encode(&text, &meta).map_err(|e| err("ENCODING", e))?;
    sudo(&c, &format!("tee -- {} > /dev/null", q(&path)), Some(&bytes)).await?;
    let st = sudo(&c, &format!("stat -c '%s %Y' -- {}", q(&path)), None).await?;
    let st = String::from_utf8_lossy(&st.stdout).to_string();
    let mut it = st.split_whitespace();
    Ok(Saved { size: it.next().and_then(|x| x.parse().ok()).unwrap_or(bytes.len() as u64), mtime: it.next().and_then(|x| x.parse().ok()) })
}

#[tauri::command]
pub async fn sudo_op(conns: State<'_, SshConns>, conn: u32, op: String, path: String, to: Option<String>) -> R<()> {
    let c = conns.get(conn)?;
    if path.trim_end_matches('/').is_empty() {
        return Err(err("SFTP", "최상위 폴더는 다룰 수 없습니다"));
    }
    let cmd = match op.as_str() {
        "mkdir" => format!("mkdir -- {}", q(&path)),
        "touch" => format!("sh -c 'set -C; : > \"$1\"' _ {}", q(&path)),
        "rename" => format!("mv -n -- {} {}", q(&path), q(to.as_deref().ok_or_else(|| err("OTHER", "새 이름이 없습니다"))?)),
        "remove" => format!("rm -rf -- {}", q(&path)),
        _ => return Err(err("OTHER", "알 수 없는 작업")),
    };
    sudo(&c, &cmd, None).await?;
    Ok(())
}
