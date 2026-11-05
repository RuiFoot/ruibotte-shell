//! 로컬 터미널(PTY) — Windows ConPTY·macOS/리눅스 pty.
//! 출력은 JSON 이벤트가 아니라 `ipc::Channel` 바이너리(Raw)로 바로 화면에 보낸다(대량 출력에서 멈추지 않게).
//!
//! 셸 통합(✓/✗·폴더 따라가기)은 셸에 글을 "쳐 넣지" 않고 시작 인자·환경으로 건다.
//! (ConPTY 는 시작하자마자 커서 위치를 묻는데(ESC[6n), 그때 쳐 넣은 글이 대답과 엉켜 PowerShell 이 제대로 뜨지 않았다)
//! - PowerShell: -NoExit -EncodedCommand 로 prompt 함수 감싸기(쓰던 프롬프트·oh-my-posh 유지)
//! - cmd: PROMPT 환경 변수에 OSC 7·133 표식
//! - bash(Git Bash·WSL·리눅스): PROMPT_COMMAND 환경 변수(WSL 은 WSLENV 로 넘김)
//! - zsh(macOS): 임시 ZDOTDIR 의 .zshrc 가 원래 ~/.zshrc 를 읽고 precmd 를 더한다

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

const READ_BUF: usize = 64 * 1024;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Session>>,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: u32,
}

/// 고를 수 있는 셸 하나
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// 고정 이름(설정에 저장) — pwsh · powershell · cmd · gitbash · wsl:<배포판> · gsudo-pwsh · /bin/zsh …
    id: String,
    label: String,
    program: String,
    args: Vec<String>,
    /// pwsh | cmd | bash | zsh | wsl | other — 셸 통합 거는 방법·자동완성 종류
    kind: String,
    /// 관리자 권한(gsudo)
    admin: bool,
}

const BASH_PC: &str = r#"__rb_s=$?; printf "\033]133;D;%s\007\033]7;file://%s%s\007\033]133;A\007" "$__rb_s" "${HOSTNAME:-}" "$PWD"; (exit $__rb_s)"#;

const PWSH_INIT: &str = r#"$global:__rbp = $function:prompt
function global:prompt {
  $c = if ($?) {0} else {1}
  $e = [char]27; $b = [char]7
  $p = $PWD.ProviderPath -replace '\\','/'
  "$e]133;D;$c$b$e]7;file://localhost/$p$b$e]133;A$b" + (& $global:__rbp)
}"#;

/// PowerShell -EncodedCommand 용 — UTF-16LE 를 base64 로
fn ps_encode(s: &str) -> String {
    let bytes: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(windows)]
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// 이 PC 에서 쓸 수 있는 셸들
pub(crate) fn shells() -> Vec<ShellInfo> {
    let mut v = Vec::new();
    #[allow(unused)]
    let mk = |id: &str, label: &str, program: String, args: &[&str], kind: &str| ShellInfo {
        id: id.into(),
        label: label.into(),
        program,
        args: args.iter().map(|s| s.to_string()).collect(),
        kind: kind.into(),
        admin: false,
    };
    #[cfg(windows)]
    {
        // PowerShell 7 — 설치 폴더를 먼저(스토어 실행 별칭 WindowsApps\pwsh.exe 는 마지막)
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let pwsh = [format!("{pf}\\PowerShell\\7\\pwsh.exe"), format!("{pf}\\PowerShell\\7-preview\\pwsh.exe")]
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
            .or_else(|| which("pwsh.exe"));
        if let Some(p) = pwsh.clone() {
            v.push(mk("pwsh", "PowerShell 7", p, &["-NoLogo"], "pwsh"));
        }
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        v.push(mk("powershell", "Windows PowerShell", format!("{sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), &["-NoLogo"], "pwsh"));
        v.push(mk("cmd", "명령 프롬프트(cmd)", format!("{sys}\\System32\\cmd.exe"), &[], "cmd"));
        let git = [format!("{pf}\\Git\\bin\\bash.exe"), std::env::var("LOCALAPPDATA").map(|l| format!("{l}\\Programs\\Git\\bin\\bash.exe")).unwrap_or_default()]
            .into_iter()
            .find(|p| !p.is_empty() && std::path::Path::new(p).is_file());
        if let Some(g) = git {
            v.push(mk("gitbash", "Git Bash", g, &["--login", "-i"], "bash"));
        }
        // WSL 배포판(wsl -l -q 는 UTF-16)
        let wsl = format!("{sys}\\System32\\wsl.exe");
        if std::path::Path::new(&wsl).is_file() {
            use std::os::windows::process::CommandExt;
            if let Ok(o) = std::process::Command::new(&wsl).args(["-l", "-q"]).creation_flags(0x0800_0000).output() {
                let words: Vec<u16> = o.stdout.chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
                for d in String::from_utf16_lossy(&words).lines().map(|l| l.trim().trim_matches('\0')).filter(|l| !l.is_empty() && !l.starts_with("docker-desktop")) {
                    v.push(ShellInfo {
                        id: format!("wsl:{d}"),
                        label: format!("WSL · {d}"),
                        program: wsl.clone(),
                        args: vec!["-d".into(), d.into(), "--cd".into(), "~".into()],
                        kind: "wsl".into(),
                        admin: false,
                    });
                }
            }
        }
        // 관리자 — gsudo 가 있으면 앱 안에서 관리자 셸(UAC 확인 뒤)
        if let Some(gs) = which("gsudo.exe") {
            let target = pwsh.unwrap_or_else(|| format!("{sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
            v.push(ShellInfo {
                id: "gsudo-pwsh".into(),
                label: "관리자 · PowerShell(gsudo)".into(),
                program: gs,
                args: vec![target, "-NoLogo".into()],
                kind: "pwsh".into(),
                admin: true,
            });
        }
    }
    #[cfg(not(windows))]
    {
        let default = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut seen = std::collections::HashSet::new();
        let list = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        for p in std::iter::once(default.as_str()).chain(list.lines().map(str::trim)) {
            if p.is_empty() || p.starts_with('#') || !std::path::Path::new(p).is_file() || !seen.insert(p.to_string()) {
                continue;
            }
            let name = p.rsplit('/').next().unwrap_or(p);
            let kind = if name.contains("zsh") { "zsh" } else if name.contains("bash") { "bash" } else if name.contains("pwsh") { "pwsh" } else { "other" };
            v.push(mk(p, &format!("{name} ({p})"), p.to_string(), &["-l"], kind));
        }
    }
    v
}

#[tauri::command]
pub fn pty_shells() -> Vec<ShellInfo> {
    shells()
}

/// 셸 하나를 띄울 명령 — 셸 통합은 인자·환경으로
fn command_for(sh: &ShellInfo) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&sh.program);
    for a in &sh.args {
        cmd.arg(a);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    match sh.kind.as_str() {
        "pwsh" => {
            cmd.arg("-NoExit");
            cmd.arg("-EncodedCommand");
            cmd.arg(ps_encode(PWSH_INIT));
        }
        "cmd" => {
            // $E = ESC, $P = 지금 폴더, $G = '>' — OSC 는 ST(ESC \) 로 닫는다
            cmd.env("PROMPT", "$E]7;file://localhost/$P$E\\$E]133;A$E\\$P$G");
        }
        "bash" => {
            cmd.env("PROMPT_COMMAND", BASH_PC);
        }
        "wsl" => {
            cmd.env("PROMPT_COMMAND", BASH_PC);
            cmd.env("WSLENV", "PROMPT_COMMAND/u");
        }
        "zsh" => {
            if let Some(dir) = zsh_dotdir() {
                cmd.env("ZDOTDIR", dir);
            }
        }
        _ => {}
    }
    cmd
}

/// zsh: 원래 설정을 읽은 뒤 precmd 를 더하는 임시 ZDOTDIR
fn zsh_dotdir() -> Option<String> {
    let dir = std::env::temp_dir().join("ruibotte-shell-zsh");
    std::fs::create_dir_all(&dir).ok()?;
    let home = std::env::var("HOME").unwrap_or_default();
    let rc = format!(
        "ZDOTDIR={home:?}\n[ -f \"$ZDOTDIR/.zshrc\" ] && source \"$ZDOTDIR/.zshrc\"\n__rb_precmd() {{ local s=$?; printf '\\033]133;D;%s\\007\\033]7;file://%s%s\\007\\033]133;A\\007' \"$s\" \"$HOST\" \"$PWD\"; }}\nprecmd_functions+=(__rb_precmd)\n"
    );
    std::fs::write(dir.join(".zshrc"), rc).ok()?;
    for f in [".zshenv", ".zprofile", ".zlogin"] {
        let src = std::path::Path::new(&home).join(f);
        let body = if src.is_file() { format!("source {:?}\n", src.to_string_lossy()) } else { String::new() };
        let _ = std::fs::write(dir.join(f), body);
    }
    Some(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<u32, String> {
    let all = shells();
    let sh = shell
        .as_deref()
        .and_then(|id| all.iter().find(|s| s.id == id))
        .or_else(|| all.first())
        .cloned()
        .ok_or("쓸 수 있는 셸이 없습니다")?;
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = command_for(&sh);
    // 시작 폴더: 트리에서 "여기서 터미널" 로 열면 그 폴더, 아니면 홈(WSL 은 --cd ~ 로 리눅스 홈)
    match cwd.filter(|c| std::path::Path::new(c).is_dir()) {
        Some(c) => cmd.cwd(c),
        None => {
            if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
                cmd.cwd(home);
            }
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{} 를 띄우지 못했습니다: {e}", sh.label))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = ptys.next.fetch_add(1, Ordering::Relaxed) + 1;
    ptys.map
        .lock()
        .unwrap()
        .insert(id, Session { writer, master: pair.master, child });

    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = app.emit("pty-exit", ExitEvent { id });
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut map = ptys.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("터미널이 닫혔습니다")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.map.lock().unwrap();
    let s = map.get(&id).ok_or("터미널이 닫혔습니다")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(ptys: State<'_, Ptys>, id: u32) {
    if let Some(mut s) = ptys.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

/// 관리자 권한으로 — 셸을 새 창으로(UAC 확인). 앱 안 ConPTY 로는 권한을 올릴 수 없어서 따로 띄운다
#[tauri::command]
pub fn pty_admin_window(shell: Option<String>, cwd: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let all = shells();
        let sh = shell.as_deref().and_then(|id| all.iter().find(|s| s.id == id && !s.admin)).or_else(|| all.first()).ok_or("셸이 없습니다")?;
        let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let args = if sh.args.is_empty() { String::new() } else { format!(" -ArgumentList {}", sh.args.iter().map(|a| q(a)).collect::<Vec<_>>().join(",")) };
        let wd = cwd.filter(|c| std::path::Path::new(c).is_dir()).map(|c| format!(" -WorkingDirectory {}", q(&c))).unwrap_or_default();
        let script = format!("Start-Process -FilePath {}{args}{wd} -Verb RunAs", q(&sh.program));
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (shell, cwd);
        Err("macOS·리눅스는 터미널에서 sudo -s 를 쓰세요".into())
    }
}

/// 지금 앱이 관리자 권한으로 돌고 있는지(Windows: net session 이 되면 관리자)
#[tauri::command]
pub fn app_is_admin() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("net")
            .arg("session")
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 앱 전체를 관리자 권한으로 다시 열기(UAC 확인 뒤 지금 창은 닫힌다)
#[tauri::command]
pub fn app_relaunch_admin(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = format!("Start-Process -FilePath '{}' -Verb RunAs", exe.to_string_lossy().replace('\'', "''"));
        let st = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("관리자 권한 요청이 취소됐습니다".into());
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Windows 에서만 됩니다".into())
    }
}

#[derive(Serialize)]
pub struct BenchResult {
    bytes: usize,
    chunks: usize,
    send_ms: f64,
}

/// 스파이크 1: 지정한 바이트만큼 번호 줄을 만들어 64 KiB 묶음으로 화면에 쏜다.
/// 화면 쪽은 xterm 이 마지막 묶음을 다 그린 시각까지 잰다.
#[tauri::command]
pub async fn bench_stream(bytes: usize, on_data: Channel<InvokeResponseBody>) -> Result<BenchResult, String> {
    let started = Instant::now();
    let mut sent = 0usize;
    let mut chunks = 0usize;
    let mut line_no = 0u64;
    let mut chunk = Vec::with_capacity(READ_BUF + 128);
    while sent < bytes {
        while chunk.len() < READ_BUF && sent + chunk.len() < bytes {
            line_no += 1;
            let line = format!(
                "\x1b[2m{line_no:>8}\x1b[0m  ruibotte-shell bench \x1b[32mok\x1b[0m {}\r\n",
                "abcdefghijklmnopqrstuvwxyz0123456789"
            );
            chunk.extend_from_slice(line.as_bytes());
        }
        sent += chunk.len();
        chunks += 1;
        on_data
            .send(InvokeResponseBody::Raw(std::mem::take(&mut chunk)))
            .map_err(|e| e.to_string())?;
        chunk.reserve(READ_BUF + 128);
    }
    Ok(BenchResult { bytes: sent, chunks, send_ms: started.elapsed().as_secs_f64() * 1000.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_utf16() {
        // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('ab')) == 'YQBiAA=='
        assert_eq!(ps_encode("ab"), "YQBiAA==");
        assert_eq!(ps_encode("a"), "YQA=");
    }

    /// 실제 셸을 ConPTY 로 띄워 셸 통합 표식이 나오는지(DSR 에 대답하며) — cargo test --lib probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_shells() {
        for sh in shells().into_iter().filter(|s| !s.admin) {
            let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut child = pair.slave.spawn_command(command_for(&sh)).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let writer = std::sync::Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
            let out = std::sync::Arc::new(Mutex::new(Vec::new()));
            let (o2, w2) = (out.clone(), writer.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    // 터미널 노릇: 커서 위치 질문(ESC[6n)에 대답
                    if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = w2.lock().unwrap().write_all(b"\x1b[1;1R");
                    }
                    o2.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
            std::thread::sleep(std::time::Duration::from_secs(6));
            let _ = writer.lock().unwrap().write_all(b"cd ..\r");
            std::thread::sleep(std::time::Duration::from_secs(2));
            let s = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
            let marks = s.matches("\x1b]133;A").count();
            let cwd = s.contains("\x1b]7;");
            println!("{:<28} 프롬프트 표식 {marks} · 폴더 표식 {cwd} · {} 바이트", sh.label, s.len());
            let _ = child.kill();
        }
    }
}
