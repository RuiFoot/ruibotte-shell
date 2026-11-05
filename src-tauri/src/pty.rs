//! 로컬 터미널(PTY) — Windows ConPTY·macOS/리눅스 pty.
//! 출력은 JSON 이벤트가 아니라 `ipc::Channel` 바이너리(Raw)로 바로 화면에 보낸다.
//! 대량 출력에서 멈추지 않게 하려는 것이다(스택 결정 리스크 1).

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

fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        // PowerShell 7 이 있으면 그것, 없으면 Windows PowerShell
        let pwsh = which("pwsh.exe");
        let mut cmd = CommandBuilder::new(pwsh.unwrap_or_else(|| "powershell.exe".into()));
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
}

#[cfg(windows)]
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = default_shell();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        cmd.cwd(home);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
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
