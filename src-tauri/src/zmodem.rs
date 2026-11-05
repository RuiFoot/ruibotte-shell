//! ZMODEM(rz/sz) 받기 파일 — 프로토콜은 화면(zmodem.js)이 다루고, 여기서는 받은 바이트를 파일로 쓰기만 한다.
//! 열기 → 덧붙이기(묶음) → 닫기(취소면 지움). 올리기는 기존 local_read_bytes 로 조각을 읽는다.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct ZmFiles {
    next: AtomicU32,
    map: Mutex<HashMap<u32, (BufWriter<File>, PathBuf)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZmOpened {
    id: u32,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZmFileInfo {
    path: String,
    name: String,
    size: u64,
    /// 초(유닉스 시각)
    mtime: Option<u64>,
}

/// 원격이 알려 준 이름에서 경로를 떼고 파일 이름만(.. · 빈 이름 · 제어 글자 막기)
fn base_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let t: String = last.chars().map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let t = t.trim().to_string();
    if t.is_empty() || t == "." || t == ".." {
        "received.bin".into()
    } else {
        t
    }
}

/// 같은 이름이 있으면 "이름 (2).확장자"
fn unique(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i + 1..])),
        _ => (name, None),
    };
    for i in 2..10_000 {
        let n = match ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let q = dir.join(n);
        if !q.exists() {
            return q;
        }
    }
    p
}

#[tauri::command]
pub fn zm_save_open(files: State<'_, ZmFiles>, dir: String, name: String) -> Result<ZmOpened, String> {
    let d = PathBuf::from(&dir);
    if !d.is_dir() {
        return Err("받을 폴더가 없습니다".into());
    }
    let path = unique(&d, &base_name(&name));
    let f = File::create(&path).map_err(|e| format!("파일을 만들지 못했습니다: {e}"))?;
    let id = files.next.fetch_add(1, Ordering::Relaxed) + 1;
    files.map.lock().unwrap().insert(id, (BufWriter::with_capacity(256 * 1024, f), path.clone()));
    Ok(ZmOpened { id, path: path.to_string_lossy().into_owned() })
}

/// 받은 조각 덧붙이기 — 본문은 바이트 그대로, 번호는 머리 x-id
#[tauri::command]
pub fn zm_save_write(files: State<'_, ZmFiles>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("본문이 없습니다".into());
    };
    let id: u32 = request.headers().get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or("번호가 없습니다")?;
    let mut map = files.map.lock().unwrap();
    let (w, _) = map.get_mut(&id).ok_or("파일이 닫혔습니다")?;
    w.write_all(data).map_err(|e| format!("쓰지 못했습니다: {e}"))
}

/// 닫기 — keep=false(취소·실패)면 받다 만 파일을 지운다
#[tauri::command]
pub fn zm_save_close(files: State<'_, ZmFiles>, id: u32, keep: bool) -> Result<(), String> {
    let Some((mut w, path)) = files.map.lock().unwrap().remove(&id) else {
        return Ok(());
    };
    let r = w.flush();
    drop(w);
    if !keep {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    r.map_err(|e| e.to_string())
}

/// 올릴 파일들의 크기·시각
#[tauri::command]
pub fn zm_file_info(paths: Vec<String>) -> Result<Vec<ZmFileInfo>, String> {
    paths
        .into_iter()
        .map(|p| {
            let m = std::fs::metadata(&p).map_err(|e| format!("{p}: {e}"))?;
            if !m.is_file() {
                return Err(format!("{p}: 파일이 아닙니다"));
            }
            let name = Path::new(&p).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
            Ok(ZmFileInfo { path: p, name, size: m.len(), mtime })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_names() {
        assert_eq!(base_name("../../etc/passwd"), "passwd");
        assert_eq!(base_name("C:\\x\\a.txt"), "a.txt");
        assert_eq!(base_name(".."), "received.bin");
        assert_eq!(base_name(".bashrc"), ".bashrc");
        assert_eq!(base_name("a:b?.log"), "a_b_.log");
    }
}
