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
    // 5: 점프 호스트(다른 SSH 프로필을 거쳐 접속)
    "ALTER TABLE profile ADD COLUMN jump_id INTEGER;",
    // 6: 연결 묶음(폴더) — 빈 값이면 묶지 않음
    "ALTER TABLE profile ADD COLUMN group_name TEXT;",
    // 7: DB SSL 방식(off·prefer·require·verify)
    "ALTER TABLE profile ADD COLUMN ssl TEXT;",
    // 8: 연결 메모
    "ALTER TABLE profile ADD COLUMN memo TEXT;",
    // 9: 계정 — 서버(접속 정보) 하나에 계정 여럿. 지금까지의 프로필 계정을 기본 계정으로 옮긴다.
    //    profile 의 username·auth·key_path 열은 그대로 둔다(예전 판으로 되돌려도 읽힘).
    //    예전 판에서 sudo 단추는 늘 있었으니 SSH 계정은 "물어보기"로 시작한다(저장한 sudo 암호가 있으면 옮길 때 "암호 저장"으로).
    //    OS 저장소의 비밀은 SQL 로 옮길 수 없어 secret_move 에 할 일을 적어 두고, 앱을 켤 때 옮긴다(실패하면 다음에 다시).
    "CREATE TABLE account (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
        label TEXT,
        username TEXT NOT NULL DEFAULT '',
        auth TEXT NOT NULL DEFAULT 'password',
        key_path TEXT,
        sudo TEXT NOT NULL DEFAULT 'off',
        sudo_user TEXT NOT NULL DEFAULT 'root',
        is_default INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        secret_saved_at INTEGER,
        sudo_saved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
     );
     CREATE INDEX account_profile ON account(profile_id);
     INSERT INTO account (profile_id, username, auth, key_path, sudo, is_default, last_used_at, secret_saved_at, created_at, updated_at)
        SELECT id, username,
               CASE WHEN kind = 'ssh' AND auth IN ('password','key') THEN auth ELSE 'password' END,
               CASE WHEN kind = 'ssh' THEN key_path ELSE NULL END,
               CASE WHEN kind = 'ssh' THEN 'ask' ELSE 'off' END,
               1, last_used_at, secret_saved_at, created_at, updated_at
        FROM profile;
     CREATE TABLE secret_move (account_id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL);
     INSERT INTO secret_move (account_id, profile_id) SELECT id, profile_id FROM account;",
    // 10: DB 를 SSH 터널로(거칠 SSH 서버·계정), 터미널을 tmux 세션으로, 포트 포워딩 규칙
    "ALTER TABLE profile ADD COLUMN ssh_tunnel_profile_id INTEGER;
     ALTER TABLE profile ADD COLUMN ssh_tunnel_account_id INTEGER;
     ALTER TABLE profile ADD COLUMN tmux INTEGER NOT NULL DEFAULT 0;
     CREATE TABLE forward (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('local','remote','dynamic')),
        bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
        bind_port INTEGER NOT NULL,
        target_host TEXT,
        target_port INTEGER,
        auto_start INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
     );
     CREATE INDEX forward_profile ON forward(profile_id);",
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

    /// 서버 하나(계정은 기본 계정으로 채운다)
    pub fn profile(&self, id: i64) -> Result<Profile, String> {
        let conn = self.conn.lock().unwrap();
        let mut p = conn
            .query_row(&format!("SELECT {PROFILE_COLS} FROM profile WHERE id=?1"), [id], profile_row)
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "프로필이 없습니다".to_string())?;
        let accounts = accounts_of(&conn, Some(id)).map_err(|e| e.to_string())?;
        p.attach(accounts);
        Ok(p)
    }

    /// 서버를 쓴 때(마지막 접속)만 남긴다 — 비밀 저장 표시는 계정에(mark_account_used)
    pub fn mark_used(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE profile SET last_used_at=?1 WHERE id=?2", params![now(), id]);
    }

    /// 계정으로 접속에 성공했을 때 — 마지막 사용과(바뀌었으면) 비밀 저장 표시
    pub fn mark_account_used(&self, id: i64, secret_saved: Option<bool>) {
        let conn = self.conn.lock().unwrap();
        let t = now();
        let _ = conn.execute("UPDATE account SET last_used_at=?1 WHERE id=?2", params![t, id]);
        let _ = conn.execute("UPDATE profile SET last_used_at=?1 WHERE id=(SELECT profile_id FROM account WHERE id=?2)", params![t, id]);
        mark_secret(&conn, id, secret_saved);
    }

    pub fn account(&self, id: i64) -> Result<Account, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {ACCOUNT_COLS} FROM account WHERE id=?1"), [id], account_row)
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "계정이 없습니다".into())
    }

    /// 서버의 기본 계정(없으면 가장 먼저 만든 계정)
    pub fn default_account(&self, profile_id: i64) -> Result<Account, String> {
        let conn = self.conn.lock().unwrap();
        accounts_of(&conn, Some(profile_id))
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or_else(|| "이 서버에 계정이 없습니다. 연결 설정에서 계정을 더하세요.".into())
    }

    pub fn accounts(&self, profile_id: i64) -> Result<Vec<Account>, String> {
        let conn = self.conn.lock().unwrap();
        accounts_of(&conn, Some(profile_id)).map_err(|e| e.to_string())
    }

    /// 계정 만들기·고치기 → id. 그 서버의 첫 계정이면 저절로 기본 계정
    pub fn account_save(&self, a: &Account) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let kind: String = conn
            .query_row("SELECT kind FROM profile WHERE id=?1", [a.profile_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("서버가 없습니다")?;
        let username = a.username.trim();
        if username.is_empty() {
            return Err("사용자명을 입력하세요".into());
        }
        let auth = if kind == "db" { "password" } else { a.auth.as_str() };
        if !["password", "key", "agent"].contains(&auth) {
            return Err("알 수 없는 인증 방식".into());
        }
        let sudo = if kind == "db" { "off" } else { a.sudo.as_str() };
        if !["off", "ask", "saved", "nopasswd"].contains(&sudo) {
            return Err("알 수 없는 sudo 설정".into());
        }
        let sudo_user = Some(a.sudo_user.trim()).filter(|u| !u.is_empty()).unwrap_or("root");
        if sudo_user.contains(|c: char| c.is_whitespace() || c == '\'') {
            return Err("sudo 대상 사용자 이름이 올바르지 않습니다".into());
        }
        let label = a.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
        let key_path = if auth == "key" { a.key_path.as_deref().map(str::trim).filter(|k| !k.is_empty()) } else { None };
        let same: Option<i64> = conn
            .query_row(
                "SELECT id FROM account WHERE profile_id=?1 AND username=?2 AND auth=?3 AND COALESCE(label,'')=?4 AND id<>?5",
                params![a.profile_id, username, auth, label.unwrap_or(""), a.id.unwrap_or(-1)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if same.is_some() {
            return Err("같은 계정이 이미 있습니다 — 라벨로 나누세요".into());
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM account WHERE profile_id=?1", [a.profile_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let t = now();
        let id = match a.id {
            Some(id) => {
                let n = conn
                    .execute(
                        "UPDATE account SET label=?1, username=?2, auth=?3, key_path=?4, sudo=?5, sudo_user=?6, updated_at=?7 WHERE id=?8 AND profile_id=?9",
                        params![label, username, auth, key_path, sudo, sudo_user, t, id, a.profile_id],
                    )
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("계정이 없습니다".into());
                }
                id
            }
            None => {
                conn.execute(
                    "INSERT INTO account (profile_id, label, username, auth, key_path, sudo, sudo_user, is_default, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![a.profile_id, label, username, auth, key_path, sudo, sudo_user, (count == 0) as i64, t],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            }
        };
        if a.is_default || count == 0 {
            set_default(&conn, id).map_err(|e| e.to_string())?;
        }
        // 예전 판 열(되돌리기용)은 기본 계정과 같게 둔다
        sync_legacy_cols(&conn, a.profile_id);
        drop(conn);
        // sudo 암호는 "암호 저장" 일 때만 둔다
        if sudo != "saved" {
            crate::secrets::forget(&crate::secrets::sudo_key(id));
            let conn = self.conn.lock().unwrap();
            let _ = conn.execute("UPDATE account SET sudo_saved_at=NULL WHERE id=?1", [id]);
        }
        Ok(id)
    }

    /// 계정 지우기 — 비밀도 지운다. 기본 계정이면 남은 것 중 최근에 쓴 계정이 기본. 마지막 하나는 지우지 않는다
    pub fn account_delete(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let (pid, was_default): (i64, bool) = conn
            .query_row("SELECT profile_id, is_default FROM account WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("계정이 없습니다")?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM account WHERE profile_id=?1", [pid], |r| r.get(0)).map_err(|e| e.to_string())?;
        if count <= 1 {
            return Err("서버에 남은 마지막 계정이라 지울 수 없습니다. 서버째 지우려면 서버 설정에서 '지우기'를 쓰세요.".into());
        }
        conn.execute("DELETE FROM account WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        if was_default {
            let next: i64 = conn
                .query_row("SELECT id FROM account WHERE profile_id=?1 ORDER BY COALESCE(last_used_at,0) DESC, id LIMIT 1", [pid], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            set_default(&conn, next).map_err(|e| e.to_string())?;
        }
        sync_legacy_cols(&conn, pid);
        drop(conn);
        crate::secrets::forget(&crate::secrets::account_key(id));
        crate::secrets::forget(&crate::secrets::sudo_key(id));
        Ok(())
    }

    pub fn account_set_default(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        set_default(&conn, id).map_err(|e| e.to_string())?;
        if let Ok(pid) = conn.query_row("SELECT profile_id FROM account WHERE id=?1", [id], |r| r.get::<_, i64>(0)) {
            sync_legacy_cols(&conn, pid);
        }
        Ok(())
    }

    /// 계정 암호(또는 개인키 암호) 저장 — 빈 값이면 지운다
    pub fn account_secret_set(&self, id: i64, secret: &str) -> Result<(), String> {
        self.account(id)?;
        let key = crate::secrets::account_key(id);
        if secret.is_empty() {
            crate::secrets::forget(&key);
            mark_secret(&self.conn.lock().unwrap(), id, Some(false));
            return Ok(());
        }
        crate::secrets::set(&key, secret)?;
        mark_secret(&self.conn.lock().unwrap(), id, Some(true));
        Ok(())
    }

    /// sudo 암호 저장 — 저장하면 그 계정 sudo 는 "암호 저장", 지우면 "물어보기"
    pub fn account_sudo_secret_set(&self, id: i64, secret: &str) -> Result<(), String> {
        let a = self.account(id)?;
        let key = crate::secrets::sudo_key(id);
        let conn_mode = |mode: &str, saved: Option<i64>| {
            let conn = self.conn.lock().unwrap();
            conn.execute("UPDATE account SET sudo=?1, sudo_saved_at=?2, updated_at=?3 WHERE id=?4", params![mode, saved, now(), id])
                .map(|_| ())
                .map_err(|e| e.to_string())
        };
        if secret.is_empty() {
            crate::secrets::forget(&key);
            return conn_mode(if a.sudo == "saved" { "ask" } else { a.sudo.as_str() }, None);
        }
        crate::secrets::set(&key, secret)?;
        conn_mode("saved", Some(now()))
    }

    /// 예전 판 비밀("profile:{id}"·"profile:{id}:sudo")을 계정 키로 — 앱을 켤 때 한 번.
    /// 옮기지 못한 것은 secret_move 에 남아 다음에 다시 한다(예전 키도 그대로 남는다)
    pub fn migrate_secrets(&self) -> (usize, usize) {
        let todo: Vec<(i64, i64)> = {
            let conn = self.conn.lock().unwrap();
            let Ok(mut st) = conn.prepare("SELECT account_id, profile_id FROM secret_move") else {
                return (0, 0);
            };
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
        };
        let (mut done, mut failed) = (0, 0);
        for (aid, pid) in todo {
            let main = crate::secrets::move_key(&format!("profile:{pid}"), &crate::secrets::account_key(aid));
            let sudo = crate::secrets::move_key(&format!("profile:{pid}:sudo"), &crate::secrets::sudo_key(aid));
            let conn = self.conn.lock().unwrap();
            if let Ok(true) = main {
                let _ = conn.execute("UPDATE account SET secret_saved_at=COALESCE(secret_saved_at, ?1) WHERE id=?2", params![now(), aid]);
            }
            if let Ok(true) = sudo {
                let _ = conn.execute("UPDATE account SET sudo='saved', sudo_saved_at=?1 WHERE id=?2", params![now(), aid]);
            }
            if main.is_ok() && sudo.is_ok() {
                let _ = conn.execute("DELETE FROM secret_move WHERE account_id=?1", [aid]);
                done += 1;
            } else {
                failed += 1;
            }
        }
        (done, failed)
    }

    pub fn host_key_info(&self, host: &str, port: u16) -> Option<(String, String, i64)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT algorithm, fingerprint, pinned_at FROM host_key WHERE host=?1 AND port=?2",
            params![host.to_lowercase(), port],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
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
    /// 이 SSH 프로필을 거쳐 접속(점프 호스트)
    #[serde(default)]
    pub jump_id: Option<i64>,
    /// 연결 묶음(폴더) 이름 — 홈·사이드바에서 이 이름으로 묶는다
    #[serde(default)]
    pub group_name: Option<String>,
    /// DB SSL: off · prefer · require(인증서 확인 안 함) · verify
    #[serde(default)]
    pub ssl: Option<String>,
    /// 메모(용도·주의 등)
    #[serde(default)]
    pub memo: Option<String>,
    /// 읽기 전용 — 이 서버의 계정들(기본 계정이 맨 앞). username·auth·key_path·secret_saved 는 기본 계정 값으로 채운다
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// DB: 이 SSH 서버(프로필)를 거쳐 접속(SSH 터널)
    #[serde(default)]
    pub ssh_tunnel_profile_id: Option<i64>,
    /// DB: 터널에 쓸 그 SSH 서버의 계정(비우면 기본 계정)
    #[serde(default)]
    pub ssh_tunnel_account_id: Option<i64>,
    /// SSH: 새 터미널을 tmux 세션으로 열기(끊겨도 다시 연결하면 이어짐)
    #[serde(default)]
    pub tmux: bool,
}

impl Profile {
    /// 계정을 붙이고, 예전 필드(username·auth·key_path·secret_saved)를 기본 계정 값으로
    fn attach(&mut self, accounts: Vec<Account>) {
        if let Some(a) = accounts.first() {
            self.username = a.username.clone();
            self.auth = a.auth.clone();
            self.key_path = a.key_path.clone();
            self.secret_saved = a.secret_saved;
        }
        self.accounts = accounts;
    }
}

/// 서버(프로필)에 딸린 계정 하나 — 사용자명·인증 방식·sudo 설정. 비밀은 OS 저장소(secrets.rs)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: Option<i64>,
    pub profile_id: i64,
    /// 보이는 이름(비우면 사용자명)
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub username: String,
    /// "password" | "key" | "agent"(SSH 에이전트 — SSH 만)
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub key_path: Option<String>,
    /// "off"(안 씀) | "ask"(켤 때 물음) | "saved"(저장한 암호) | "nopasswd"(암호 없이)
    #[serde(default = "default_sudo")]
    pub sudo: String,
    /// sudo -u 대상(기본 root)
    #[serde(default = "default_sudo_user")]
    pub sudo_user: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// 읽기 전용 — 계정 암호(또는 키 암호)가 OS 저장소에 있는지
    #[serde(default)]
    pub secret_saved: bool,
    /// 읽기 전용 — sudo 암호가 OS 저장소에 있는지
    #[serde(default)]
    pub sudo_saved: bool,
}

fn default_sudo() -> String {
    "off".into()
}
fn default_sudo_user() -> String {
    "root".into()
}

const ACCOUNT_COLS: &str = "id, profile_id, label, username, auth, key_path, sudo, sudo_user, is_default, last_used_at, secret_saved_at, sudo_saved_at";

fn account_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        label: r.get(2)?,
        username: r.get(3)?,
        auth: r.get(4)?,
        key_path: r.get(5)?,
        sudo: r.get(6)?,
        sudo_user: r.get(7)?,
        is_default: r.get::<_, i64>(8)? != 0,
        last_used_at: r.get(9)?,
        secret_saved: r.get::<_, Option<i64>>(10)?.is_some(),
        sudo_saved: r.get::<_, Option<i64>>(11)?.is_some(),
    })
}

/// 계정 목록 — 기본 계정 먼저, 그다음 최근에 쓴 순. profile_id 가 없으면 전부
fn accounts_of(conn: &Connection, profile_id: Option<i64>) -> rusqlite::Result<Vec<Account>> {
    let order = "ORDER BY profile_id, is_default DESC, COALESCE(last_used_at, 0) DESC, id";
    match profile_id {
        Some(pid) => {
            let mut st = conn.prepare(&format!("SELECT {ACCOUNT_COLS} FROM account WHERE profile_id=?1 {order}"))?;
            let rows = st.query_map([pid], account_row)?;
            rows.collect()
        }
        None => {
            let mut st = conn.prepare(&format!("SELECT {ACCOUNT_COLS} FROM account {order}"))?;
            let rows = st.query_map([], account_row)?;
            rows.collect()
        }
    }
}

fn set_default(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE account SET is_default = (id = ?1) WHERE profile_id = (SELECT profile_id FROM account WHERE id = ?1)", [id])?;
    Ok(())
}

fn mark_secret(conn: &Connection, id: i64, saved: Option<bool>) {
    match saved {
        Some(true) => {
            let _ = conn.execute("UPDATE account SET secret_saved_at=?1 WHERE id=?2", params![now(), id]);
        }
        Some(false) => {
            let _ = conn.execute("UPDATE account SET secret_saved_at=NULL WHERE id=?1", [id]);
        }
        None => {}
    }
}

/// 예전 판이 읽는 profile 열(username·auth·key_path)을 기본 계정과 같게 — 되돌려도 기본 계정으로 접속되게
fn sync_legacy_cols(conn: &Connection, profile_id: i64) {
    let _ = conn.execute(
        "UPDATE profile SET (username, auth, key_path) = (
            SELECT username, CASE WHEN auth = 'agent' THEN 'key' ELSE auth END, key_path FROM account
            WHERE profile_id = ?1 ORDER BY is_default DESC, id LIMIT 1)
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM account WHERE profile_id = ?1)",
        [profile_id],
    );
}

fn default_auth() -> String {
    "password".into()
}
fn default_legacy() -> String {
    "off".into()
}

const PROFILE_COLS: &str = "id, kind, name, host, port, username, engine, color, favorite, last_used_at,
    auth, key_path, legacy, default_path, database, secret_saved_at, jump_id, group_name, ssl, memo,
    ssh_tunnel_profile_id, ssh_tunnel_account_id, tmux";

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
        jump_id: r.get(16)?,
        group_name: r.get(17)?,
        ssl: r.get(18)?,
        memo: r.get(19)?,
        accounts: Vec::new(),
        ssh_tunnel_profile_id: r.get(20)?,
        ssh_tunnel_account_id: r.get(21)?,
        tmux: r.get::<_, i64>(22)? != 0,
    })
}

#[tauri::command]
pub fn profiles_list(store: State<'_, Store>) -> Result<Vec<Profile>, String> {
    store.profiles()
}

impl Store {
    /// 서버 목록 — 계정을 붙이고 예전 필드는 기본 계정 값으로
    pub fn profiles(&self) -> Result<Vec<Profile>, String> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn
            .prepare(&format!("SELECT {PROFILE_COLS} FROM profile ORDER BY favorite DESC, COALESCE(last_used_at, 0) DESC, name"))
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([], profile_row).map_err(|e| e.to_string())?;
        let mut list: Vec<Profile> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let mut by: std::collections::HashMap<i64, Vec<Account>> = std::collections::HashMap::new();
        for a in accounts_of(&conn, None).map_err(|e| e.to_string())? {
            by.entry(a.profile_id).or_default().push(a);
        }
        for p in &mut list {
            let accs = p.id.and_then(|id| by.remove(&id)).unwrap_or_default();
            p.attach(accs);
        }
        Ok(list)
    }

    /// 서버 저장 → id. 새 서버면 username·auth·key_path 로 기본 계정을 함께 만든다(고칠 때는 계정을 건드리지 않는다)
    pub fn profile_save(&self, p: &Profile) -> Result<i64, String> {
        if p.name.trim().is_empty() || p.host.trim().is_empty() {
            return Err("이름과 주소를 입력하세요".into());
        }
        if p.kind != "ssh" && p.kind != "db" {
            return Err("알 수 없는 종류".into());
        }
        if !["off", "rsa", "sha1", "weakest"].contains(&p.legacy.as_str()) {
            return Err("알 수 없는 구형 호환 단계".into());
        }
        let conn = self.conn.lock().unwrap();
        let t = now();
        let host = p.host.trim().to_string();
        let group = p.group_name.as_deref().map(str::trim).filter(|g| !g.is_empty()).map(str::to_string);
        let memo = p.memo.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let auth = if p.kind == "ssh" && ["password", "key", "agent"].contains(&p.auth.as_str()) { p.auth.as_str() } else { "password" };
        let key_path = if auth == "key" { p.key_path.clone() } else { None };
        // SSH 터널은 DB 만, tmux 는 SSH 만. 터널 계정은 그 SSH 서버의 계정이어야 한다
        let tun_p = if p.kind == "db" { p.ssh_tunnel_profile_id.filter(|x| Some(*x) != p.id) } else { None };
        let tun_a = tun_p.and(p.ssh_tunnel_account_id);
        if let Some(tp) = tun_p {
            let kind: Option<String> = conn.query_row("SELECT kind FROM profile WHERE id=?1", [tp], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if kind.as_deref() != Some("ssh") {
                return Err("거칠 SSH 서버가 없습니다".into());
            }
            if let Some(ta) = tun_a {
                let ok: Option<i64> = conn.query_row("SELECT id FROM account WHERE id=?1 AND profile_id=?2", [ta, tp], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                if ok.is_none() {
                    return Err("고른 계정이 그 SSH 서버의 계정이 아닙니다".into());
                }
            }
        }
        let tmux = (p.kind == "ssh" && p.tmux) as i64;
        match p.id {
            Some(id) => {
                conn.execute(
                    "UPDATE profile SET kind=?1, name=?2, host=?3, port=?4, engine=?5, color=?6,
                     favorite=?7, updated_at=?8, legacy=?9, default_path=?10, database=?11, jump_id=?13, group_name=?14, ssl=?15, memo=?16,
                     ssh_tunnel_profile_id=?17, ssh_tunnel_account_id=?18, tmux=?19 WHERE id=?12",
                    params![p.kind, p.name.trim(), host, p.port, p.engine, p.color, p.favorite as i64, t,
                        p.legacy, p.default_path, p.database, id, p.jump_id.filter(|j| *j != id), group, p.ssl, memo, tun_p, tun_a, tmux],
                )
                .map_err(|e| e.to_string())?;
                // 계정이 하나도 없으면(예전 자료 등) 받은 값으로 하나 만든다
                let n: i64 = conn.query_row("SELECT COUNT(*) FROM account WHERE profile_id=?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
                if n == 0 {
                    insert_default_account(&conn, id, p, auth, key_path.as_deref(), t)?;
                }
                Ok(id)
            }
            None => {
                let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO profile (kind, name, host, port, username, engine, color, favorite, created_at, updated_at,
                      auth, key_path, legacy, default_path, database, jump_id, group_name, ssl, memo, ssh_tunnel_profile_id, ssh_tunnel_account_id, tmux)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
                    params![p.kind, p.name.trim(), host, p.port, p.username.trim(), p.engine, p.color, p.favorite as i64, t,
                        if auth == "agent" { "key" } else { auth }, key_path, p.legacy, p.default_path, p.database, p.jump_id, group, p.ssl, memo, tun_p, tun_a, tmux],
                )
                .map_err(|e| e.to_string())?;
                let id = tx.last_insert_rowid();
                insert_default_account(&tx, id, p, auth, key_path.as_deref(), t)?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(id)
            }
        }
    }

    /// 서버 지우기 — 딸린 계정(과 비밀)도 함께
    pub fn profile_delete(&self, id: i64) -> Result<(), String> {
        let ids: Vec<i64> = self.accounts(id)?.into_iter().filter_map(|a| a.id).collect();
        for aid in &ids {
            crate::secrets::forget(&crate::secrets::account_key(*aid));
            crate::secrets::forget(&crate::secrets::sudo_key(*aid));
        }
        // 아직 옮기지 못한 예전 키도
        crate::secrets::forget(&format!("profile:{id}"));
        crate::secrets::forget(&format!("profile:{id}:sudo"));
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM secret_move WHERE profile_id=?1", [id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM profile WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn insert_default_account(conn: &Connection, profile_id: i64, p: &Profile, auth: &str, key_path: Option<&str>, t: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO account (profile_id, username, auth, key_path, sudo, sudo_user, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'off', 'root', 1, ?5, ?5)",
        params![profile_id, p.username.trim(), auth, key_path, t],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn profile_save(store: State<'_, Store>, p: Profile) -> Result<i64, String> {
    store.profile_save(&p)
}

#[tauri::command]
pub fn profile_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    store.profile_delete(id)
}

// ── 계정 명령 ────────────────────────

#[tauri::command]
pub fn accounts_list(store: State<'_, Store>, profile_id: i64) -> Result<Vec<Account>, String> {
    store.accounts(profile_id)
}

#[tauri::command]
pub fn account_save(store: State<'_, Store>, a: Account) -> Result<i64, String> {
    store.account_save(&a)
}

#[tauri::command]
pub fn account_delete(store: State<'_, Store>, id: i64) -> Result<(), String> {
    store.account_delete(id)
}

#[tauri::command]
pub fn account_set_default(store: State<'_, Store>, id: i64) -> Result<(), String> {
    store.account_set_default(id)
}

/// 계정 암호(또는 개인키 암호) 저장 — 빈 값이면 지운다. 값은 다시 화면으로 돌려주지 않는다
#[tauri::command]
pub fn account_secret_set(store: State<'_, Store>, id: i64, secret: String) -> Result<(), String> {
    store.account_secret_set(id, &secret)
}

/// sudo 암호 저장 — 빈 값이면 지운다(그 계정 sudo 는 "물어보기"로)
#[tauri::command]
pub fn account_sudo_secret_set(store: State<'_, Store>, id: i64, secret: String) -> Result<(), String> {
    store.account_sudo_secret_set(id, &secret)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    algorithm: String,
    fingerprint: String,
    pinned_at: i64,
}

/// 고정한 호스트 키(서버 카드에 지문 보이기)
#[tauri::command]
pub fn host_key_get(store: State<'_, Store>, host: String, port: u16) -> Option<HostKeyInfo> {
    store.host_key_info(&host, port).map(|(algorithm, fingerprint, pinned_at)| HostKeyInfo { algorithm, fingerprint, pinned_at })
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

// ── 포트 포워딩 규칙 ─────────────────

/// SSH 서버(프로필)에 저장한 포트 포워딩 규칙 하나
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: Option<i64>,
    pub profile_id: i64,
    /// local(내 PC 포트 → 서버 쪽 대상) | remote(서버 포트 → 내 PC 쪽 대상) | dynamic(내 PC SOCKS5)
    pub kind: String,
    #[serde(default = "default_bind")]
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: Option<String>,
    #[serde(default)]
    pub target_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub label: Option<String>,
}

fn default_bind() -> String {
    "127.0.0.1".into()
}

const FORWARD_COLS: &str = "id, profile_id, kind, bind_host, bind_port, target_host, target_port, auto_start, label";

fn forward_row(r: &Row) -> rusqlite::Result<Forward> {
    Ok(Forward {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        kind: r.get(2)?,
        bind_host: r.get(3)?,
        bind_port: r.get(4)?,
        target_host: r.get(5)?,
        target_port: r.get(6)?,
        auto_start: r.get::<_, i64>(7)? != 0,
        label: r.get(8)?,
    })
}

/// 규칙 값 고르기 — 고칠 곳을 쉬운 말로 알려 준다
pub(crate) fn forward_check(f: &Forward) -> Result<Forward, String> {
    let mut f = f.clone();
    if !["local", "remote", "dynamic"].contains(&f.kind.as_str()) {
        return Err("알 수 없는 포워딩 종류".into());
    }
    let bind = f.bind_host.trim();
    f.bind_host = if bind.is_empty() { "127.0.0.1".into() } else { bind.to_string() };
    if f.kind == "dynamic" {
        // SOCKS 는 인증이 없으니 이 PC 안에서만 받는다
        f.bind_host = "127.0.0.1".into();
        f.target_host = None;
        f.target_port = None;
    } else {
        let th = f.target_host.as_deref().map(str::trim).unwrap_or("");
        if th.is_empty() {
            return Err("보낼 곳(대상 주소)을 입력하세요".into());
        }
        if th.contains(char::is_whitespace) {
            return Err("대상 주소에 빈칸이 있습니다".into());
        }
        f.target_host = Some(th.to_string());
        if f.target_port.unwrap_or(0) == 0 {
            return Err("대상 포트를 입력하세요(1~65535)".into());
        }
    }
    if f.bind_host.contains(char::is_whitespace) {
        return Err("받는 주소에 빈칸이 있습니다".into());
    }
    // 원격은 0 이면 서버가 빈 포트를 고른다
    if f.bind_port == 0 && f.kind != "remote" {
        return Err("받을 포트를 입력하세요(1~65535)".into());
    }
    f.label = f.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
    Ok(f)
}

impl Store {
    pub fn forwards(&self, profile_id: i64) -> Result<Vec<Forward>, String> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(&format!("SELECT {FORWARD_COLS} FROM forward WHERE profile_id=?1 ORDER BY id")).map_err(|e| e.to_string())?;
        let rows = st.query_map([profile_id], forward_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn forward(&self, id: i64) -> Result<Forward, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {FORWARD_COLS} FROM forward WHERE id=?1"), [id], forward_row)
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "포워딩 규칙이 없습니다".into())
    }

    pub fn forward_save(&self, f: &Forward) -> Result<i64, String> {
        let f = forward_check(f)?;
        let conn = self.conn.lock().unwrap();
        let kind: Option<String> = conn.query_row("SELECT kind FROM profile WHERE id=?1", [f.profile_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        if kind.as_deref() != Some("ssh") {
            return Err("포워딩은 SSH 서버에만 둘 수 있습니다".into());
        }
        // 같은 서버에 같은 받는 곳(종류·주소·포트)이 둘이면 둘 다 켤 수 없다
        let same: Option<i64> = conn
            .query_row(
                "SELECT id FROM forward WHERE profile_id=?1 AND kind=?2 AND bind_host=?3 AND bind_port=?4 AND bind_port<>0 AND id<>?5",
                params![f.profile_id, f.kind, f.bind_host, f.bind_port, f.id.unwrap_or(-1)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if same.is_some() {
            return Err(format!("{}:{} 을(를) 받는 규칙이 이미 있습니다", f.bind_host, f.bind_port));
        }
        let t = now();
        match f.id {
            Some(id) => {
                let n = conn
                    .execute(
                        "UPDATE forward SET kind=?1, bind_host=?2, bind_port=?3, target_host=?4, target_port=?5, auto_start=?6, label=?7, updated_at=?8 WHERE id=?9 AND profile_id=?10",
                        params![f.kind, f.bind_host, f.bind_port, f.target_host, f.target_port, f.auto_start as i64, f.label, t, id, f.profile_id],
                    )
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("포워딩 규칙이 없습니다".into());
                }
                Ok(id)
            }
            None => {
                conn.execute(
                    "INSERT INTO forward (profile_id, kind, bind_host, bind_port, target_host, target_port, auto_start, label, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![f.profile_id, f.kind, f.bind_host, f.bind_port, f.target_host, f.target_port, f.auto_start as i64, f.label, t],
                )
                .map_err(|e| e.to_string())?;
                Ok(conn.last_insert_rowid())
            }
        }
    }

    pub fn forward_delete(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM forward WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn forward_list(store: State<'_, Store>, profile_id: i64) -> Result<Vec<Forward>, String> {
    store.forwards(profile_id)
}

#[tauri::command]
pub fn forward_save(store: State<'_, Store>, f: Forward) -> Result<i64, String> {
    store.forward_save(&f)
}

/// 시험용 — SSH 서버 하나(기본 계정 포함) 만들기 → 서버 id
#[cfg(test)]
pub(crate) fn profile_save_core(store: &Store, host: &str, port: u16, user: &str) -> i64 {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO profile (kind, name, host, port, username, created_at, updated_at) VALUES ('ssh', 'jump', ?1, ?2, ?3, 0, 0)",
        params![host, port, user],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO account (profile_id, username, auth, sudo, is_default, created_at, updated_at) VALUES (?1, ?2, 'password', 'ask', 1, 0, 0)",
        params![id, user],
    )
    .unwrap();
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rbshell-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 새 DB 에 마이그레이션을 끝까지 올리고, 묶음 이름이 저장·읽기 되는지
    #[test]
    fn migrations_and_group() {
        let dir = temp_dir("group");
        let store = Store::open(dir.join("db"), false).unwrap();
        let id = profile_save_core(&store, "h", 22, "u");
        store.conn.lock().unwrap().execute("UPDATE profile SET group_name='운영' WHERE id=?1", [id]).unwrap();
        let p = store.profile(id).unwrap();
        assert_eq!(p.group_name.as_deref(), Some("운영"));
        let v: i64 = store.conn.lock().unwrap().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 8판 DB(서버 하나 = 계정 하나)를 9판으로 — 서버마다 기본 계정 하나, 비밀 옮기기 할 일이 남는다. 예전 열은 그대로
    #[test]
    fn migration_9_makes_default_accounts() {
        let dir = temp_dir("m9");
        let path = dir.join("app.db");
        {
            let mut conn = Connection::open(&path).unwrap();
            let tx = conn.transaction().unwrap();
            for (i, sql) in MIGRATIONS.iter().take(8).enumerate() {
                tx.execute_batch(sql).unwrap();
                tx.pragma_update(None, "user_version", (i + 1) as i64).unwrap();
            }
            tx.execute(
                "INSERT INTO profile (kind, name, host, port, username, auth, key_path, secret_saved_at, last_used_at, created_at, updated_at)
                 VALUES ('ssh', '웹', 'web.example', 22, 'app', 'key', '/k/id', 5, 7, 1, 1),
                        ('db', '디비', 'db.example', 5432, 'pg', 'password', NULL, NULL, NULL, 1, 1)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let store = Store::open(dir.clone(), false).unwrap();
        let list = store.profiles().unwrap();
        let web = list.iter().find(|p| p.name == "웹").unwrap();
        assert_eq!(web.accounts.len(), 1);
        let a = &web.accounts[0];
        assert!(a.is_default);
        assert_eq!((a.username.as_str(), a.auth.as_str(), a.key_path.as_deref(), a.sudo.as_str()), ("app", "key", Some("/k/id"), "ask"));
        assert!(a.secret_saved);
        assert_eq!(a.last_used_at, Some(7));
        assert_eq!((web.username.as_str(), web.auth.as_str(), web.secret_saved), ("app", "key", true));
        let db = list.iter().find(|p| p.name == "디비").unwrap();
        assert_eq!((db.accounts[0].username.as_str(), db.accounts[0].sudo.as_str()), ("pg", "off"));
        let todo: i64 = store.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM secret_move", [], |r| r.get(0)).unwrap();
        assert_eq!(todo, 2);
        // 예전 열은 남아 있다(되돌리기)
        let old: (String, String) = store.conn.lock().unwrap().query_row("SELECT username, auth FROM profile WHERE name='웹'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(old, ("app".to_string(), "key".to_string()));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 포워딩 규칙 — 값 고르기, 같은 받는 곳 거절, 서버를 지우면 함께. 터널·tmux 열 저장
    #[test]
    fn forward_rules_and_tunnel_cols() {
        let dir = temp_dir("fwd");
        let store = Store::open(dir.clone(), false).unwrap();
        let pid = profile_save_core(&store, "h", 22, "u");
        let mk = |kind: &str, port: u16, th: Option<&str>, tp: Option<u16>| Forward {
            id: None,
            profile_id: pid,
            kind: kind.into(),
            bind_host: "".into(),
            bind_port: port,
            target_host: th.map(Into::into),
            target_port: tp,
            auto_start: true,
            label: Some("  ".into()),
        };
        assert!(store.forward_save(&mk("local", 15432, None, Some(5432))).is_err(), "대상 없음");
        assert!(store.forward_save(&mk("local", 0, Some("db"), Some(5432))).is_err(), "포트 0");
        let a = store.forward_save(&mk("local", 15432, Some(" db "), Some(5432))).unwrap();
        let f = store.forward(a).unwrap();
        assert_eq!((f.bind_host.as_str(), f.target_host.as_deref(), f.label.as_deref()), ("127.0.0.1", Some("db"), None));
        assert!(store.forward_save(&mk("local", 15432, Some("db2"), Some(1))).is_err(), "같은 받는 곳");
        let d = store.forward_save(&Forward { bind_host: "0.0.0.0".into(), ..mk("dynamic", 1080, Some("x"), Some(1)) }).unwrap();
        let f = store.forward(d).unwrap();
        assert_eq!((f.bind_host.as_str(), f.target_host.as_deref()), ("127.0.0.1", None), "SOCKS 는 이 PC 안에서만");
        assert!(store.forward_save(&mk("remote", 0, Some("localhost"), Some(80))).is_ok(), "원격은 0 = 서버가 고름");
        assert_eq!(store.forwards(pid).unwrap().len(), 3);
        // DB 서버의 터널 열
        let mut p = store.profile(pid).unwrap();
        p.id = None;
        p.kind = "db".into();
        p.name = "디비".into();
        p.ssh_tunnel_profile_id = Some(pid);
        p.ssh_tunnel_account_id = Some(9999);
        assert!(store.profile_save(&p).is_err(), "남의 계정");
        p.ssh_tunnel_account_id = store.default_account(pid).unwrap().id;
        let dbid = store.profile_save(&p).unwrap();
        let got = store.profile(dbid).unwrap();
        assert_eq!((got.ssh_tunnel_profile_id, got.ssh_tunnel_account_id, got.tmux), (Some(pid), p.ssh_tunnel_account_id, false));
        let mut s = store.profile(pid).unwrap();
        s.tmux = true;
        store.profile_save(&s).unwrap();
        assert!(store.profile(pid).unwrap().tmux);
        store.profile_delete(pid).unwrap();
        assert!(store.forward(a).is_err(), "서버를 지우면 규칙도");
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 계정 더하기·기본 바꾸기·지우기 규칙(마지막 하나는 못 지움, 기본을 지우면 다른 것이 기본)
    #[test]
    fn account_rules() {
        let dir = temp_dir("acc");
        let store = Store::open(dir.clone(), false).unwrap();
        let pid = profile_save_core(&store, "h", 22, "u");
        let first = store.default_account(pid).unwrap().id.unwrap();
        let mk = |user: &str| Account {
            id: None,
            profile_id: pid,
            label: None,
            username: user.into(),
            auth: "password".into(),
            key_path: None,
            sudo: "nopasswd".into(),
            sudo_user: "".into(),
            is_default: false,
            last_used_at: None,
            secret_saved: false,
            sudo_saved: false,
        };
        let second = store.account_save(&mk("deploy")).unwrap();
        assert!(store.account_save(&mk("deploy")).is_err(), "같은 계정은 두 번 못 만든다");
        let b = store.account(second).unwrap();
        assert_eq!((b.sudo.as_str(), b.sudo_user.as_str(), b.is_default), ("nopasswd", "root", false));
        store.account_set_default(second).unwrap();
        assert_eq!(store.default_account(pid).unwrap().id, Some(second));
        assert_eq!(store.profile(pid).unwrap().username, "deploy");
        // 예전 열도 기본 계정을 따라간다
        let legacy: String = store.conn.lock().unwrap().query_row("SELECT username FROM profile WHERE id=?1", [pid], |r| r.get(0)).unwrap();
        assert_eq!(legacy, "deploy");
        store.account_delete(second).unwrap();
        assert_eq!(store.default_account(pid).unwrap().id, Some(first));
        assert!(store.account_delete(first).is_err(), "마지막 계정은 못 지운다");
        // 서버를 지우면 계정도 함께
        store.profile_delete(pid).unwrap();
        assert!(store.account(first).is_err());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
