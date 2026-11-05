//! 터미널 세션 기록 — 서버(또는 내 PC 셸)별 폴더에 터미널 출력을 파일로 남긴다.
//! 화면은 출력 바이트를 묶어(0.25~1초) 보내고, 여기서 색 코드 지우기·줄 앞 시각 붙이기를 한 뒤 버퍼에 쓴다.
//! 기본 자리: <앱 데이터>/logs/<서버 이름>/YYYY-MM-DD_HHMMSS.log

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::store::Store;

#[derive(Default)]
pub struct SessionLogs {
    next: AtomicU32,
    map: Mutex<HashMap<u32, LogFile>>,
}

struct LogFile {
    w: BufWriter<File>,
    clean: Option<Cleaner>,
    /// 줄 앞 시각(분 단위 시간대 차이) — None 이면 붙이지 않는다
    stamp: Option<i32>,
    line_start: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOpened {
    id: u32,
    path: String,
}

/// 파일·폴더 이름으로 쓸 수 있게 — 글자·숫자·-_. 와 공백만 남기고 60자까지
pub(crate) fn safe_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | '@') { c } else { '_' })
        .take(60)
        .collect();
    let t = t.trim().trim_matches('.').to_string();
    if t.is_empty() {
        "terminal".into()
    } else {
        t
    }
}

fn default_dir(store: &Store) -> PathBuf {
    store.path.join("logs")
}

fn now_hms(offset_min: i32) -> String {
    let off = time::UtcOffset::from_whole_seconds(offset_min.saturating_mul(60)).unwrap_or(time::UtcOffset::UTC);
    let t = time::OffsetDateTime::now_utc().to_offset(off);
    format!("{:02}:{:02}:{:02}.{:03}", t.hour(), t.minute(), t.second(), t.millisecond())
}

fn now_full(offset_min: i32) -> String {
    let off = time::UtcOffset::from_whole_seconds(offset_min.saturating_mul(60)).unwrap_or(time::UtcOffset::UTC);
    let t = time::OffsetDateTime::now_utc().to_offset(off);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", t.year(), u8::from(t.month()), t.day(), t.hour(), t.minute(), t.second())
}

/// 같은 이름이 있으면 _2, _3 … 을 붙인다
fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    for i in 2..10_000 {
        let name = match &ext {
            Some(e) => format!("{stem}_{i}.{e}"),
            None => format!("{stem}_{i}"),
        };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
    }
    path
}

/// 터미널 제어 코드 지우기 — ESC [ … (CSI), ESC ] … BEL/ST (OSC), DCS·APC·PM·SOS, 단문 ESC, 그 밖 C0(줄바꿈·탭 빼고)
#[derive(Default, Clone, Copy, PartialEq, Debug)]
enum St {
    #[default]
    Text,
    Esc,
    Csi,
    /// OSC·DCS·APC 같은 문자열 — BEL 이나 ESC \ 로 끝난다
    Str,
    StrEsc,
    /// ESC ( B 같은 글자 집합 고르기 — 한 바이트 더 먹는다
    Skip1,
}

#[derive(Default)]
pub(crate) struct Cleaner {
    st: St,
}

impl Cleaner {
    /// 바이트를 넣으면 남길 바이트를 out 에 덧붙인다
    pub(crate) fn feed(&mut self, b: u8, out: &mut Vec<u8>) {
        self.st = match self.st {
            St::Text => match b {
                0x1b => St::Esc,
                b'\n' | b'\t' => {
                    out.push(b);
                    St::Text
                }
                // \r(줄 처음으로)·BEL·BS 같은 제어 글자는 버린다 — CRLF 는 LF 로 남는다
                0x00..=0x1f | 0x7f => St::Text,
                _ => {
                    out.push(b);
                    St::Text
                }
            },
            St::Esc => match b {
                b'[' => St::Csi,
                b']' | b'P' | b'X' | b'^' | b'_' => St::Str,
                b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b'#' | b'%' | b' ' => St::Skip1,
                0x1b => St::Esc,
                _ => St::Text,
            },
            St::Csi => match b {
                0x40..=0x7e => St::Text,
                0x1b => St::Esc,
                _ => St::Csi,
            },
            St::Str => match b {
                0x07 => St::Text,
                0x1b => St::StrEsc,
                _ => St::Str,
            },
            St::StrEsc => match b {
                b'\\' => St::Text,
                0x1b => St::StrEsc,
                _ => St::Str,
            },
            St::Skip1 => St::Text,
        };
    }
}

impl LogFile {
    fn write_chunk(&mut self, data: &[u8]) -> std::io::Result<()> {
        let cleaned;
        let body: &[u8] = match &mut self.clean {
            Some(c) => {
                let mut out = Vec::with_capacity(data.len());
                for &b in data {
                    c.feed(b, &mut out);
                }
                cleaned = out;
                &cleaned
            }
            None => data,
        };
        let Some(off) = self.stamp else {
            return self.w.write_all(body);
        };
        // 줄 앞 시각 — 묶음 하나에 시각 하나(묶음 간격만큼 오차)
        let ts = format!("[{}] ", now_hms(off));
        let mut start = 0;
        for (i, &b) in body.iter().enumerate() {
            if self.line_start {
                self.w.write_all(ts.as_bytes())?;
                self.line_start = false;
            }
            if b == b'\n' {
                self.w.write_all(&body[start..=i])?;
                start = i + 1;
                self.line_start = true;
            }
        }
        if start < body.len() {
            if self.line_start {
                self.w.write_all(ts.as_bytes())?;
                self.line_start = false;
            }
            self.w.write_all(&body[start..])?;
        }
        Ok(())
    }
}

/// 기록 시작 — server: 서버(또는 셸) 이름, dir: 저장 폴더(비우면 앱 데이터의 logs),
/// file_stamp: 화면이 만든 지역 시각 "YYYY-MM-DD_HHMMSS", tz_offset_min: 지역 시간대(UTC 기준 분, 동쪽 +)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_log_open(
    store: State<'_, Store>,
    logs: State<'_, SessionLogs>,
    server: String,
    dir: Option<String>,
    file_stamp: String,
    tz_offset_min: i32,
    strip_ansi: bool,
    timestamps: bool,
) -> Result<LogOpened, String> {
    let base = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| default_dir(&store));
    let folder = base.join(safe_name(&server));
    std::fs::create_dir_all(&folder).map_err(|e| format!("기록 폴더를 만들지 못했습니다: {e}"))?;
    let path = unique(folder.join(format!("{}.log", safe_name(&file_stamp))));
    let f = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("기록 파일을 열지 못했습니다: {e}"))?;
    let mut lf = LogFile {
        w: BufWriter::with_capacity(64 * 1024, f),
        clean: strip_ansi.then(Cleaner::default),
        stamp: timestamps.then_some(tz_offset_min),
        line_start: true,
    };
    let head = format!("# RuiBotte Shell 터미널 기록 — {server} · 시작 {}\n", now_full(tz_offset_min));
    lf.w.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    let id = logs.next.fetch_add(1, Ordering::Relaxed) + 1;
    logs.map.lock().unwrap().insert(id, lf);
    Ok(LogOpened { id, path: path.to_string_lossy().into_owned() })
}

/// 출력 묶음 덧붙이기 — 본문은 바이트 그대로, 기록 번호는 머리 x-id
#[tauri::command]
pub fn session_log_write(logs: State<'_, SessionLogs>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("본문이 없습니다".into());
    };
    let id: u32 = request.headers().get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or("기록 번호가 없습니다")?;
    let mut map = logs.map.lock().unwrap();
    let lf = map.get_mut(&id).ok_or("기록이 닫혔습니다")?;
    lf.write_chunk(data).and_then(|_| lf.w.flush()).map_err(|e| format!("기록하지 못했습니다: {e}"))
}

#[tauri::command]
pub fn session_log_close(logs: State<'_, SessionLogs>, id: u32, tz_offset_min: Option<i32>) -> Result<(), String> {
    let Some(mut lf) = logs.map.lock().unwrap().remove(&id) else {
        return Ok(());
    };
    let end = format!("{}# 기록 끝 {}\n", if lf.line_start { "" } else { "\n" }, now_full(tz_offset_min.unwrap_or(0)));
    let _ = lf.w.write_all(end.as_bytes());
    lf.w.flush().map_err(|e| e.to_string())
}

/// 기본 기록 폴더(설정 화면에 보이기용)
#[tauri::command]
pub fn session_log_default_dir(store: State<'_, Store>) -> String {
    default_dir(&store).to_string_lossy().into_owned()
}

/// 기록 폴더를 파일 탐색기로 연다(없으면 만든다) — server 를 주면 그 서버 폴더
#[tauri::command]
pub fn session_log_reveal(app: AppHandle, store: State<'_, Store>, dir: Option<String>, server: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| default_dir(&store));
    let p = match server {
        Some(s) if !s.trim().is_empty() => base.join(safe_name(&s)),
        _ => base,
    };
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(s: &[u8]) -> String {
        let mut c = Cleaner::default();
        let mut out = Vec::new();
        for &b in s {
            c.feed(b, &mut out);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn strips_sgr_osc_and_cr() {
        assert_eq!(clean(b"\x1b[1;31mERROR\x1b[0m done\r\n"), "ERROR done\n");
        assert_eq!(clean(b"\x1b]133;A\x07$ ls\r\n"), "$ ls\n");
        assert_eq!(clean(b"\x1b]0;title\x1b\\ok\n"), "ok\n");
        assert_eq!(clean(b"\x1b(Bplain\x1b[?2004h\n"), "plain\n");
        assert_eq!(clean("한글\x1b[K\n".as_bytes()), "한글\n");
    }

    #[test]
    fn split_escape_across_chunks() {
        let mut c = Cleaner::default();
        let mut out = Vec::new();
        for &b in b"a\x1b[3" {
            c.feed(b, &mut out);
        }
        for &b in b"2mb\n" {
            c.feed(b, &mut out);
        }
        assert_eq!(out, b"ab\n");
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("../../etc"), "_.._etc");
        assert_eq!(safe_name("web 1:22"), "web 1_22");
        assert_eq!(safe_name(""), "terminal");
    }
}
