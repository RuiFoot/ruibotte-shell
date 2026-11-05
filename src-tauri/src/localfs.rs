//! 내 PC 파일 — 원격(SFTP)과 같은 모양의 목록·읽기·저장. 로컬 터미널 작업대의 트리·편집기가 쓴다.
//! 브라우저가 아니라서 바탕화면·문서 같은 폴더도 그대로 열린다.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::textcodec::{self, TextMeta};

const MAX_TEXT: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    mtime: Option<u32>,
    mode: Option<u32>,
}

fn mtime(m: &std::fs::Metadata) -> Option<u32> {
    m.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as u32)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub fn local_home() -> String {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    path_str(&home)
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<FsEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let meta = std::fs::metadata(e.path()).ok(); // 링크는 가리키는 쪽
        let kind = if meta.as_ref().map(|m| m.is_dir()).unwrap_or(ft.is_dir()) {
            "dir"
        } else if ft.is_symlink() && meta.is_none() {
            "link"
        } else {
            "file"
        };
        out.push(FsEntry {
            path: path_str(&e.path()),
            name,
            kind,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta.as_ref().and_then(mtime),
            mode: None,
        });
    }
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
pub fn local_read_text(path: String, encoding: Option<String>) -> Result<FileText, String> {
    let m = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if m.len() > MAX_TEXT {
        return Ok(FileText {
            path,
            size: m.len(),
            mtime: mtime(&m),
            text: None,
            meta: TextMeta { encoding: "UTF-8".into(), bom: false, eol: "LF".into(), guessed: false },
            binary: false,
            too_large: true,
        });
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let d = textcodec::decode(&bytes, encoding.as_deref());
    Ok(FileText { path, size: m.len(), mtime: mtime(&m), text: d.text, meta: d.meta, binary: d.binary, too_large: false })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    size: u64,
    mtime: Option<u32>,
}

#[tauri::command]
pub fn local_write_text(path: String, text: String, meta: TextMeta, expect_mtime: Option<u32>) -> Result<Saved, String> {
    if let (Some(exp), Ok(m)) = (expect_mtime, std::fs::metadata(&path)) {
        if mtime(&m).is_some_and(|t| t != exp) {
            return Err("연 뒤에 파일이 바뀌었습니다. 다시 열어 확인하세요.".into());
        }
    }
    let bytes = textcodec::encode(&text, &meta)?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let m = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(Saved { size: m.len(), mtime: mtime(&m) })
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_touch(path: String) -> Result<(), String> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("같은 이름이 이미 있습니다".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 내 PC 지우기는 휴지통으로(되살릴 수 있게)
#[tauri::command]
pub fn local_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}
