//! 앱 자체 저장 — SQLite 파일 하나(app.db).
//! 프로필·설정·기록을 둔다. 암호·개인키 같은 비밀은 여기 넣지 않는다(OS 자격 증명 저장소 몫, 다음 판).
//! 위치: 설치판 = OS 앱 데이터 폴더, 포터블 = exe 옆 `<exe 이름>-data/`.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 스키마 판 — 올릴 때마다 MIGRATIONS 에 한 칸을 더한다(지난 칸은 고치지 않는다)
const MIGRATIONS: &[&str] = &[
    // 1: 설정·접속 프로필·최근 사용
    "CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE profile (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('ssh','db')),
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        engine TEXT,
        color TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        extra TEXT NOT NULL DEFAULT '{}',
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
     );
     CREATE INDEX profile_recent ON profile(last_used_at DESC);",
];

pub struct Store {
    conn: Mutex<Connection>,
    pub path: PathBuf,
    pub portable: bool,
}

pub fn data_dir(app_data: PathBuf) -> (PathBuf, bool) {
    // 포터블 판정: 릴리스의 포터블 exe 이름(RuiBotteShell-Portable-*.exe) 또는 exe 옆 portable.flag
    if let Ok(exe) = std::env::current_exe() {
        let named = exe
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase().contains("portable"))
            .unwrap_or(false);
        if let Some(dir) = exe.parent() {
            if named || dir.join("portable.flag").is_file() {
                let name = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                return (dir.join(format!("{name}-data")), true);
            }
        }
    }
    (app_data, false)
}

impl Store {
    pub fn open(dir: PathBuf, portable: bool) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("app.db");
        let mut conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let tx = conn.transaction()?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        tx.commit()?;
        Ok(Self { conn: Mutex::new(conn), path, portable })
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    pub engine: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    pub last_used_at: Option<i64>,
}

#[tauri::command]
pub fn profiles_list(store: State<'_, Store>) -> Result<Vec<Profile>, String> {
    let conn = store.conn.lock().unwrap();
    let mut st = conn
        .prepare(
            "SELECT id, kind, name, host, port, username, engine, color, favorite, last_used_at
             FROM profile ORDER BY favorite DESC, COALESCE(last_used_at, 0) DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok(Profile {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                host: r.get(3)?,
                port: r.get(4)?,
                username: r.get(5)?,
                engine: r.get(6)?,
                color: r.get(7)?,
                favorite: r.get::<_, i64>(8)? != 0,
                last_used_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_save(store: State<'_, Store>, p: Profile) -> Result<i64, String> {
    if p.name.trim().is_empty() || p.host.trim().is_empty() {
        return Err("이름과 주소를 입력하세요".into());
    }
    if p.kind != "ssh" && p.kind != "db" {
        return Err("알 수 없는 종류".into());
    }
    let conn = store.conn.lock().unwrap();
    let t = now();
    match p.id {
        Some(id) => {
            conn.execute(
                "UPDATE profile SET kind=?1, name=?2, host=?3, port=?4, username=?5, engine=?6, color=?7,
                 favorite=?8, updated_at=?9 WHERE id=?10",
                params![p.kind, p.name.trim(), p.host.trim(), p.port, p.username, p.engine, p.color, p.favorite as i64, t, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO profile (kind, name, host, port, username, engine, color, favorite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![p.kind, p.name.trim(), p.host.trim(), p.port, p.username, p.engine, p.color, p.favorite as i64, t],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn profile_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    let conn = store.conn.lock().unwrap();
    conn.execute("DELETE FROM profile WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn setting_get(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    let conn = store.conn.lock().unwrap();
    conn.query_row("SELECT value FROM setting WHERE key=?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn setting_set(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
