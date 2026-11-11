//! 내 PC 파일 — 원격(SFTP)과 같은 모양의 목록·읽기·저장. 로컬 터미널 작업대의 트리·편집기가 쓴다.
//! 브라우저가 아니라서 바탕화면·문서 같은 폴더도 그대로 열린다.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::textcodec::{self, TextMeta};

const MAX_TEXT: u64 = 8 * 1024 * 1024;
/// 너무 큰 파일은 앞부분만 이만큼 읽어 읽기 전용으로 보인다
pub(crate) const HEAD_TEXT: u64 = 1024 * 1024;

/// 앞부분만 읽은 바이트 — 마지막 줄바꿈까지만 남겨 글자가 중간에 잘리지 않게
pub(crate) fn trim_head(mut b: Vec<u8>) -> Vec<u8> {
    if let Some(i) = b.iter().rposition(|&x| x == b'\n') {
        b.truncate(i + 1);
    }
    b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    mtime: Option<u32>,
    mode: Option<u32>,
    /// 심볼릭 링크면 가리키는 곳
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
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

#[tauri::command(async)]
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
            target: if ft.is_symlink() { std::fs::read_link(e.path()).ok().map(|t| path_str(&t)) } else { None },
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

#[tauri::command(async)]
pub fn local_read_text(path: String, encoding: Option<String>) -> Result<FileText, String> {
    let m = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if m.len() > MAX_TEXT {
        // 앞부분만 읽기 전용으로
        use std::io::Read;
        let mut head = Vec::new();
        std::fs::File::open(&path).and_then(|f| f.take(HEAD_TEXT).read_to_end(&mut head)).map_err(|e| e.to_string())?;
        let d = textcodec::decode(&trim_head(head), encoding.as_deref());
        return Ok(FileText { path, size: m.len(), mtime: mtime(&m), text: d.text, meta: d.meta, binary: d.binary, too_large: true });
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

#[tauri::command(async)]
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

/// 바이너리 파일 쓰기(ERD 그림 저장 등) — 본문은 바이트 그대로, 경로는 머리 x-path(URI 인코딩)
#[tauri::command]
pub fn local_write_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("본문이 없습니다".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(crate::transfer::percent_decode)
        .ok_or("경로가 없습니다")?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

/// 파일 빠른 열기(Alt+O) — base 아래에서 이름에 query 가 든 파일(대소문자 무시, `*` 는 아무 글자).
/// 깊이 8·200개까지, .git·node_modules 는 들어가지 않는다. 너무 오래 걸리면(3초·30만 항목) 거기까지만.
#[tauri::command]
pub async fn local_find(base: String, query: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || find_blocking(&base, &query)).await.map_err(|e| e.to_string())
}

fn name_matches(name: &str, parts: &[String]) -> bool {
    let n = name.to_lowercase();
    let mut at = 0;
    for p in parts {
        match n[at..].find(p.as_str()) {
            Some(i) => at += i + p.len(),
            None => return false,
        }
    }
    true
}

fn find_blocking(base: &str, query: &str) -> Vec<String> {
    let parts: Vec<String> = query.to_lowercase().split('*').filter(|x| !x.is_empty()).map(String::from).collect();
    let mut out = Vec::new();
    if parts.is_empty() {
        return out;
    }
    let started = std::time::Instant::now();
    let mut seen = 0usize;
    let mut stack: Vec<(PathBuf, u32)> = vec![(PathBuf::from(base), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut subdirs = Vec::new();
        for e in rd.flatten() {
            seen += 1;
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth + 1 < 8 && name != ".git" && name != "node_modules" {
                    subdirs.push(e.path());
                }
            } else if name_matches(&name, &parts) {
                out.push(path_str(&e.path()));
                if out.len() >= 200 {
                    return out;
                }
            }
        }
        if seen > 300_000 || started.elapsed().as_secs() >= 3 {
            break;
        }
        // 이름 순서대로 내려가도록 거꾸로 쌓는다(pop 이 앞 이름부터)
        subdirs.sort();
        for d in subdirs.into_iter().rev() {
            stack.push((d, depth + 1));
        }
    }
    out
}
