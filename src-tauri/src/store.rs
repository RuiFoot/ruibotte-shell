//! 앱 자체 저장 — SQLite 파일 하나(app.db).
//! 프로필·고정 호스트 키·설정·기록을 둔다. 암호·개인키 암호는 여기 넣지 않는다(OS 자격 증명 저장소, secrets.rs).
//! 위치: 설치판 = OS 앱 데이터 폴더, 포터블 = exe 옆 `<exe 이름>-data/`.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
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
    // 2: SSH 인증 방식·개인키 경로·구형 호환 단계·시작 폴더·DB 이름, 비밀 저장 표시, 고정 호스트 키
    "ALTER TABLE profile ADD COLUMN auth TEXT NOT NULL DEFAULT 'password';
     ALTER TABLE profile ADD COLUMN key_path TEXT;
     ALTER TABLE profile ADD COLUMN legacy TEXT NOT NULL DEFAULT 'off';
     ALTER TABLE profile ADD COLUMN default_path TEXT;
     ALTER TABLE profile ADD COLUMN database TEXT;
     ALTER TABLE profile ADD COLUMN secret_saved_at INTEGER;
     CREATE TABLE host_key (
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (host, port)
     );",
    // 3: 스니펫(터미널 명령·SQL 즐겨찾기 공용)
    "CREATE TABLE snippet (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('shell','sql')),
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
     );",
    // 4: 쿼리 기록(프로필별)
    "CREATE TABLE query_history (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        sql TEXT NOT NULL,
        ms INTEGER,
        rows INTEGER,
        ok INTEGER NOT NULL,
        at INTEGER NOT NULL
     );
     CREATE INDEX query_history_scope ON query_history(scope, at DESC);",
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

    pub fn mark_used(&self, id: i64, secret_saved: Option<bool>) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE profile SET last_used_at=?1 WHERE id=?2", params![now(), id]);
        match secret_saved {
            Some(true) => {
                let _ = conn.execute("UPDATE profile SET secret_saved_at=?1 WHERE id=?2", params![now(), id]);
            }
            Some(false) => {
                let _ = conn.execute("UPDATE profile SET secret_saved_at=NULL WHERE id=?1", [id]);
            }
            None => {}
        }
    }

    pub fn host_key(&self, host: &str, port: u16) -> Option<PinnedKey> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT algorithm, fingerprint, public_key FROM host_key WHERE host=?1 AND port=?2",
            params![host.to_lowercase(), port],
            |r| Ok(PinnedKey { algorithm: r.get(0)?, fingerprint: r.get(1)?, public_key: r.get(2)? }),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn pin_host_key(&self, host: &str, port: u16, k: &PinnedKey) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO host_key (host, port, algorithm, fingerprint, public_key, pinned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(host, port) DO UPDATE SET algorithm=excluded.algorithm, fingerprint=excluded.fingerprint,
               public_key=excluded.public_key, pinned_at=excluded.pinned_at",
            params![host.to_lowercase(), port, k.algorithm, k.fingerprint, k.public_key, now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct PinnedKey {
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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
    /// SSH: "password" | "key"
    #[serde(default = "default_auth")]
    pub auth: String,
    pub key_path: Option<String>,
    /// SSH 구형 호환 단계: "off" | "rsa" | "sha1" | "weakest"
    #[serde(default = "default_legacy")]
    pub legacy: String,
    pub default_path: Option<String>,
    pub database: Option<String>,
    /// 읽기 전용 — OS 저장소에 비밀(암호·키 암호)이 저장돼 있는지
    #[serde(default)]
    pub secret_saved: bool,
}

fn default_auth() -> String {
    "password".into()
}
fn default_legacy() -> String {
    "off".into()
}

const PROFILE_COLS: &str = "id, kind, name, host, port, username, engine, color, favorite, last_used_at,
    auth, key_path, legacy, default_path, database, secret_saved_at";

fn profile_row(r: &Row) -> rusqlite::Result<Profile> {
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
        auth: r.get(10)?,
        key_path: r.get(11)?,
        legacy: r.get(12)?,
        default_path: r.get(13)?,
        database: r.get(14)?,
        secret_saved: r.get::<_, Option<i64>>(15)?.is_some(),
    })
}

#[tauri::command]
pub fn profiles_list(store: State<'_, Store>) -> Result<Vec<Profile>, String> {
    let conn = store.conn.lock().unwrap();
    let mut st = conn
        .prepare(&format!(
            "SELECT {PROFILE_COLS} FROM profile ORDER BY favorite DESC, COALESCE(last_used_at, 0) DESC, name"
        ))
        .map_err(|e| e.to_string())?;
    let rows = st.query_map([], profile_row).map_err(|e| e.to_string())?;
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
    if !["off", "rsa", "sha1", "weakest"].contains(&p.legacy.as_str()) {
        return Err("알 수 없는 구형 호환 단계".into());
    }
    let conn = store.conn.lock().unwrap();
    let t = now();
    let host = p.host.trim().to_string();
    match p.id {
        Some(id) => {
            conn.execute(
                "UPDATE profile SET kind=?1, name=?2, host=?3, port=?4, username=?5, engine=?6, color=?7,
                 favorite=?8, updated_at=?9, auth=?10, key_path=?11, legacy=?12, default_path=?13, database=?14 WHERE id=?15",
                params![p.kind, p.name.trim(), host, p.port, p.username, p.engine, p.color, p.favorite as i64, t,
                    p.auth, p.key_path, p.legacy, p.default_path, p.database, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO profile (kind, name, host, port, username, engine, color, favorite, created_at, updated_at,
                  auth, key_path, legacy, default_path, database)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![p.kind, p.name.trim(), host, p.port, p.username, p.engine, p.color, p.favorite as i64, t,
                    p.auth, p.key_path, p.legacy, p.default_path, p.database],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn profile_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    crate::secrets::forget(&format!("profile:{id}"));
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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub body: String,
}

#[tauri::command]
pub fn snippets_list(store: State<'_, Store>, kind: String) -> Result<Vec<Snippet>, String> {
    let conn = store.conn.lock().unwrap();
    let mut st = conn
        .prepare("SELECT id, kind, name, body FROM snippet WHERE kind = ?1 ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([kind], |r| Ok(Snippet { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, body: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snippet_save(store: State<'_, Store>, s: Snippet) -> Result<i64, String> {
    if s.name.trim().is_empty() || s.body.trim().is_empty() {
        return Err("이름과 내용을 입력하세요".into());
    }
    let conn = store.conn.lock().unwrap();
    match s.id {
        Some(id) => {
            conn.execute("UPDATE snippet SET name=?1, body=?2, updated_at=?3 WHERE id=?4", params![s.name.trim(), s.body, now(), id])
                .map_err(|e| e.to_string())?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO snippet (kind, name, body, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![s.kind, s.name.trim(), s.body, now()],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn snippet_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    let conn = store.conn.lock().unwrap();
    conn.execute("DELETE FROM snippet WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: Option<i64>,
    pub sql: String,
    pub ms: Option<i64>,
    pub rows: Option<i64>,
    pub ok: bool,
    pub at: Option<i64>,
}

/// 쿼리 기록 하나 — 프로필(scope)마다 최근 2000개만 남긴다
#[tauri::command]
pub fn history_add(store: State<'_, Store>, scope: String, item: HistoryItem) -> Result<(), String> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO query_history (scope, sql, ms, rows, ok, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![scope, item.sql, item.ms, item.rows, item.ok as i64, now()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM query_history WHERE scope = ?1 AND id NOT IN (SELECT id FROM query_history WHERE scope = ?1 ORDER BY at DESC LIMIT 2000)",
        [scope],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn history_list(store: State<'_, Store>, scope: String, q: Option<String>) -> Result<Vec<HistoryItem>, String> {
    let conn = store.conn.lock().unwrap();
    // 찾는 말은 글자 그대로(와일드카드 없이) — instr 로
    let like = q.unwrap_or_default().to_lowercase();
    let mut st = conn
        .prepare("SELECT id, sql, ms, rows, ok, at FROM query_history WHERE scope = ?1 AND instr(lower(sql), ?2) > 0 ORDER BY at DESC LIMIT 300")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![scope, like], |r| {
            Ok(HistoryItem { id: r.get(0)?, sql: r.get(1)?, ms: r.get(2)?, rows: r.get(3)?, ok: r.get::<_, i64>(4)? != 0, at: r.get(5)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
