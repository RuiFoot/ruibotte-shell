//! sudo 파일 작업 — 일반 계정으로 접속해 root 파일을 보고 고친다(exec 채널).
//! 암호 줄이 파일 내용으로 섞이지 않게: 늘 `sudo -n` 으로 시도하고, 암호가 필요하다고 하면
//! `sudo -S -p '' -v` 로 한 번 인증한 뒤 다시 `sudo -n` 으로 실행한다.
//! 목록은 GNU find 의 -printf 를 쓴다(리눅스 서버 전제).

use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;

use crate::secrets;
use crate::ssh::{err, Conn, SshConns, R};
use crate::textcodec::{self, TextMeta};

const MAX_TEXT: usize = 8 * 1024 * 1024;

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

/// `sudo -n <cmd>` — 암호가 필요하면 저장/입력한 암호로 한 번 인증하고 다시
pub(crate) async fn sudo(c: &Conn, password: Option<&str>, cmd: &str, stdin: Option<&[u8]>) -> R<Out> {
    let full = format!("sudo -n -- {cmd}");
    let o = exec(c, &full, stdin).await?;
    if !needs_password(&o) {
        return check(o);
    }
    let Some(pw) = password.filter(|p| !p.is_empty()) else {
        return Err(err("NEED_SECRET", "sudo 암호가 필요합니다"));
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

pub(crate) fn pw_for(profile_id: Option<i64>, password: Option<String>) -> Option<String> {
    password.filter(|p| !p.is_empty()).or_else(|| profile_id.and_then(|id| secrets::get(&format!("profile:{id}:sudo"))))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    mtime: Option<u32>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// sudo 를 켤 때 한 번 — 되는지 보고, 원하면 sudo 암호를 OS 저장소에
#[tauri::command]
pub async fn sudo_check(conns: State<'_, SshConns>, conn: u32, profile_id: Option<i64>, password: Option<String>, save: bool) -> R<bool> {
    let c = conns.get(conn)?;
    let pw = pw_for(profile_id, password.clone());
    sudo(&c, pw.as_deref(), "true", None).await?;
    if let (true, Some(id), Some(p)) = (save, profile_id, password.filter(|p| !p.is_empty())) {
        let _ = secrets::set(&format!("profile:{id}:sudo"), &p);
    }
    Ok(true)
}

#[tauri::command]
pub async fn sudo_list(conns: State<'_, SshConns>, conn: u32, profile_id: Option<i64>, path: String) -> R<Vec<FsEntry>> {
    let c = conns.get(conn)?;
    let pw = pw_for(profile_id, None);
    let o = sudo(&c, pw.as_deref(), &format!("find {} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'", q(&path)), None).await?;
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
    path: String,
    size: u64,
    mtime: Option<u32>,
    text: Option<String>,
    meta: TextMeta,
    binary: bool,
    too_large: bool,
}

#[tauri::command]
pub async fn sudo_read_text(conns: State<'_, SshConns>, conn: u32, profile_id: Option<i64>, path: String, encoding: Option<String>) -> R<FileText> {
    let c = conns.get(conn)?;
    let pw = pw_for(profile_id, None);
    let st = sudo(&c, pw.as_deref(), &format!("stat -c '%s %Y' -- {}", q(&path)), None).await?;
    let st = String::from_utf8_lossy(&st.stdout).to_string();
    let mut it = st.split_whitespace();
    let size: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let mtime: Option<u32> = it.next().and_then(|x| x.parse().ok());
    if size as usize > MAX_TEXT {
        return Ok(FileText {
            path,
            size,
            mtime,
            text: None,
            meta: TextMeta { encoding: "UTF-8".into(), bom: false, eol: "LF".into(), guessed: false },
            binary: false,
            too_large: true,
        });
    }
    let o = sudo(&c, pw.as_deref(), &format!("cat -- {}", q(&path)), None).await?;
    let d = textcodec::decode(&o.stdout, encoding.as_deref());
    Ok(FileText { path, size, mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    size: u64,
    mtime: Option<u32>,
}

/// 저장 = `sudo tee` — 같은 파일(inode)에 써서 소유자·권한을 지킨다
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sudo_write_text(
    conns: State<'_, SshConns>,
    conn: u32,
    profile_id: Option<i64>,
    path: String,
    text: String,
    meta: TextMeta,
    expect_mtime: Option<u32>,
) -> R<Saved> {
    let c = conns.get(conn)?;
    let pw = pw_for(profile_id, None);
    if let Some(exp) = expect_mtime {
        let st = sudo(&c, pw.as_deref(), &format!("stat -c '%Y' -- {}", q(&path)), None).await?;
        let now: Option<u32> = String::from_utf8_lossy(&st.stdout).trim().parse().ok();
        if now.is_some_and(|t| t != exp) {
            return Err(err("CONFLICT", "연 뒤에 서버에서 파일이 바뀌었습니다. 다시 열어 확인하세요."));
        }
    }
    let bytes = textcodec::encode(&text, &meta).map_err(|e| err("ENCODING", e))?;
    sudo(&c, pw.as_deref(), &format!("tee -- {} > /dev/null", q(&path)), Some(&bytes)).await?;
    let st = sudo(&c, pw.as_deref(), &format!("stat -c '%s %Y' -- {}", q(&path)), None).await?;
    let st = String::from_utf8_lossy(&st.stdout).to_string();
    let mut it = st.split_whitespace();
    Ok(Saved { size: it.next().and_then(|x| x.parse().ok()).unwrap_or(bytes.len() as u64), mtime: it.next().and_then(|x| x.parse().ok()) })
}

#[tauri::command]
pub async fn sudo_op(conns: State<'_, SshConns>, conn: u32, profile_id: Option<i64>, op: String, path: String, to: Option<String>) -> R<()> {
    let c = conns.get(conn)?;
    let pw = pw_for(profile_id, None);
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
    sudo(&c, pw.as_deref(), &cmd, None).await?;
    Ok(())
}
