//! 컨테이너 안 파일 — 서버의 docker(없으면 podman) exec 로 컨테이너 안을 보고 고친다(터미널이 docker exec 로 들어가면 트리·편집기가 따라온다).
//! 컨테이너에는 GNU 도구가 없을 수 있어(alpine·busybox) sh·stat·cat·mv·rm·mkdir 만 쓴다.
//! docker 소켓 권한이 없으면 계정 sudo 설정을 따라 sudo 로(Docker 칸과 같은 규칙). 사용자는 컨테이너 기본 사용자.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::State;

use crate::ssh::{err, Conn, SshConns, R};
use crate::sudo::{exec, join, q, sudo, FileText, FsEntry, Out, Saved, MAX_TEXT};
use crate::textcodec::{self, TextMeta};

#[derive(Clone)]
struct Runtime {
    bin: &'static str,
    sudo: bool,
}

/// 연결마다 한 번 — docker/podman, sudo 가 필요한지
static RUNTIMES: LazyLock<Mutex<HashMap<u32, Runtime>>> = LazyLock::new(Default::default);

async fn runtime(c: &Conn, conn: u32) -> R<Runtime> {
    if let Some(r) = RUNTIMES.lock().unwrap().get(&conn).cloned() {
        return Ok(r);
    }
    let o = exec(c, "for b in docker podman; do if command -v $b >/dev/null 2>&1; then echo $b; $b ps -q >/dev/null 2>&1 && echo ok; break; fi; done", None).await?;
    let s = String::from_utf8_lossy(&o.stdout).to_string();
    let bin = match s.lines().next().unwrap_or("") {
        "docker" => "docker",
        "podman" => "podman",
        _ => return Err(err("OTHER", "이 서버에는 docker·podman 명령이 없습니다")),
    };
    let rt = Runtime { bin, sudo: !s.lines().any(|l| l == "ok") };
    RUNTIMES.lock().unwrap().insert(conn, rt.clone());
    Ok(rt)
}

/// 컨테이너 이름·id — docker 가 허용하는 글자만
pub(crate) fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && !n.starts_with('-') && n.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

/// 컨테이너 안에서 `sh -c <script> _ <args...>`
async fn run(c: &Conn, conn: u32, ctr: &str, script: &str, args: &[&str], stdin: Option<&[u8]>) -> R<Out> {
    if !valid_name(ctr) {
        return Err(err("OTHER", "컨테이너 이름이 올바르지 않습니다"));
    }
    let rt = runtime(c, conn).await?;
    let mut cmd = format!("{} exec{} {} sh -c {} _", rt.bin, if stdin.is_some() { " -i" } else { "" }, q(ctr), q(script));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&q(a));
    }
    let o = if rt.sudo { sudo(c, &cmd, stdin).await.map_err(|e| {
            let (code, m, ..) = e.parts();
            err(code, plain(m, ctr))
        })? } else { exec(c, &cmd, stdin).await? };
    if o.code != Some(0) {
        let last = o.stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("실패");
        return Err(err("SFTP", plain(last, ctr)));
    }
    Ok(o)
}

/// docker·sh 오류를 사람 말로
fn plain(m: &str, ctr: &str) -> String {
    if m.contains("No such container") || m.contains("no such container") {
        format!("컨테이너 {ctr} 가 없습니다(멈췄거나 지워졌을 수 있습니다)")
    } else if m.contains("is not running") {
        format!("컨테이너 {ctr} 가 멈춰 있습니다")
    } else if m.contains("executable file not found") || m.contains("\"sh\"") {
        format!("컨테이너 {ctr} 에 sh 가 없어 파일을 볼 수 없습니다")
    } else if m.contains("permission denied") && m.contains("docker.sock") {
        "docker 소켓 권한이 없습니다 — 계정을 docker 묶음에 넣거나 계정 설정에서 sudo 를 켜세요".into()
    } else {
        m.to_string()
    }
}

/// `stat -c '%s %Y'` 한 줄 → (크기, 수정 시각)
fn size_mtime(o: &Out) -> (u64, Option<u32>) {
    let s = String::from_utf8_lossy(&o.stdout);
    let mut it = s.split_whitespace();
    (it.next().and_then(|x| x.parse().ok()).unwrap_or(0), it.next().and_then(|x| x.parse().ok()))
}

#[tauri::command]
pub async fn ctr_list(conns: State<'_, SshConns>, conn: u32, ctr: String, path: String) -> R<Vec<FsEntry>> {
    let c = conns.get(conn)?;
    // 숨김 파일까지(.[!.]* ..?*). 맞는 것이 없는 무늬는 stat 이 오류를 내고 지나간다
    let o = run(&c, conn, &ctr, r#"cd -- "$1" || exit 1; stat -c '%F|%s|%Y|%n' -- * .[!.]* ..?* 2>/dev/null; exit 0"#, &[&path], None).await?;
    let mut out: Vec<FsEntry> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(4, '|');
            let (t, s, m, n) = (it.next()?, it.next()?, it.next()?, it.next()?);
            if n.is_empty() || n == "." || n == ".." {
                return None;
            }
            Some(FsEntry {
                kind: match t {
                    "directory" => "dir",
                    "symbolic link" => "link",
                    t if t.starts_with("regular") => "file",
                    _ => "other",
                },
                size: s.parse().unwrap_or(0),
                mtime: m.parse().ok(),
                path: join(&path, n),
                name: n.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// 컨테이너의 시작 폴더(exec 기본 작업 폴더)와 홈
#[tauri::command]
pub async fn ctr_where(conns: State<'_, SshConns>, conn: u32, ctr: String) -> R<(String, String)> {
    let c = conns.get(conn)?;
    let o = run(&c, conn, &ctr, r#"pwd; printf '%s\n' "${HOME:-/}""#, &[], None).await?;
    let s = String::from_utf8_lossy(&o.stdout).to_string();
    let mut it = s.lines();
    let cwd = it.next().filter(|x| x.starts_with('/')).unwrap_or("/").to_string();
    let home = it.next().filter(|x| x.starts_with('/')).unwrap_or("/").to_string();
    Ok((cwd, home))
}

#[tauri::command]
pub async fn ctr_read_text(conns: State<'_, SshConns>, conn: u32, ctr: String, path: String, encoding: Option<String>) -> R<FileText> {
    let c = conns.get(conn)?;
    let (size, mtime) = size_mtime(&run(&c, conn, &ctr, r#"stat -c '%s %Y' -- "$1""#, &[&path], None).await?);
    if size as usize > MAX_TEXT {
        // 앞부분만 읽기 전용으로
        let o = run(&c, conn, &ctr, r#"head -c "$2" -- "$1""#, &[&path, &crate::localfs::HEAD_TEXT.to_string()], None).await?;
        let d = textcodec::decode(&crate::localfs::trim_head(o.stdout), encoding.as_deref());
        return Ok(FileText { path, size, mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: true });
    }
    let o = run(&c, conn, &ctr, r#"cat -- "$1""#, &[&path], None).await?;
    let d = textcodec::decode(&o.stdout, encoding.as_deref());
    Ok(FileText { path, size, mtime, text: d.text, meta: d.meta, binary: d.binary, too_large: false })
}

/// 저장 — 컨테이너 안 임시 파일에 다 받은 뒤 `cat 임시 > 파일` 로 같은 파일(inode)에 쓴다(소유자·권한·바인드 마운트를 지키고,
/// 받는 도중 끊겨도 원래 파일이 잘리지 않는다)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ctr_write_text(
    conns: State<'_, SshConns>,
    conn: u32,
    ctr: String,
    path: String,
    text: String,
    meta: TextMeta,
    expect_mtime: Option<u32>,
) -> R<Saved> {
    let c = conns.get(conn)?;
    if let Some(exp) = expect_mtime {
        let (_, now) = size_mtime(&run(&c, conn, &ctr, r#"stat -c '%s %Y' -- "$1""#, &[&path], None).await?);
        if now.is_some_and(|t| t != exp) {
            return Err(err("CONFLICT", "연 뒤에 컨테이너 안에서 파일이 바뀌었습니다. 다시 열어 확인하세요."));
        }
    }
    let bytes = textcodec::encode(&text, &meta).map_err(|e| err("ENCODING", e))?;
    run(&c, conn, &ctr, r#"t="$1.rbsave.$$"; cat > "$t" || { rm -f "$t"; exit 1; }; cat "$t" > "$1"; e=$?; rm -f "$t"; exit $e"#, &[&path], Some(&bytes)).await?;
    let (size, mtime) = size_mtime(&run(&c, conn, &ctr, r#"stat -c '%s %Y' -- "$1""#, &[&path], None).await?);
    Ok(Saved { size, mtime })
}

#[tauri::command]
pub async fn ctr_op(conns: State<'_, SshConns>, conn: u32, ctr: String, op: String, path: String, to: Option<String>) -> R<()> {
    let c = conns.get(conn)?;
    if path.trim_end_matches('/').is_empty() {
        return Err(err("SFTP", "최상위 폴더는 다룰 수 없습니다"));
    }
    let to = to.unwrap_or_default();
    let (script, args): (&str, Vec<&str>) = match op.as_str() {
        "mkdir" => (r#"mkdir -- "$1""#, vec![&path]),
        "touch" => (r#"set -C; : > "$1""#, vec![&path]),
        "rename" if !to.is_empty() => (r#"if [ -e "$2" ] || [ -L "$2" ]; then echo "같은 이름이 있습니다" >&2; exit 1; fi; mv -- "$1" "$2""#, vec![&path, &to]),
        "remove" => (r#"rm -rf -- "$1""#, vec![&path]),
        _ => return Err(err("OTHER", "알 수 없는 작업")),
    };
    run(&c, conn, &ctr, script, &args, None).await?;
    Ok(())
}

/// 연결이 닫히면 잊는다
pub(crate) fn forget(conn: u32) {
    RUNTIMES.lock().unwrap().remove(&conn);
}

#[cfg(test)]
mod tests {
    use super::valid_name;

    #[test]
    fn names() {
        assert!(valid_name("web-1"));
        assert!(valid_name("4fbe3fb1d7bf"));
        assert!(!valid_name("-it"));
        assert!(!valid_name("a;b"));
        assert!(!valid_name(""));
    }
}
