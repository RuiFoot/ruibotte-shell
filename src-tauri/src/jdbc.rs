//! JDBC 브리지 — Oracle·CUBRID·Tibero·Altibase 처럼 Rust 드라이버가 없는 DB 용.
//! - 처음 쓸 때 Java 실행기(Eclipse Temurin JRE 21)를 받는다: Adoptium API 의 sha256 으로 확인한 뒤 앱 데이터 폴더에 푼다.
//! - 드라이버: Oracle(ojdbc11)은 Maven Central 에서 받아 .sha1 로 확인, 나머지는 사용자가 고른 jar 를 복사(sha256 기록).
//! - 사이드카(resources/rb-jdbc.jar)를 별도 프로세스로 띄워 한 줄 JSON 으로 주고받는다. 앱 기본 설치 크기는 그대로.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

pub struct JdbcEngine {
    pub key: &'static str,
    pub label: &'static str,
    pub port: u16,
    pub driver_class: &'static str,
    /// {host} {port} {db}
    pub url: &'static str,
    /// Maven Central (group, artifact) — 없으면 사용자가 jar 를 고른다
    pub maven: Option<(&'static str, &'static str)>,
}

pub const ENGINES: &[JdbcEngine] = &[
    JdbcEngine {
        key: "oracle",
        label: "Oracle",
        port: 1521,
        driver_class: "oracle.jdbc.OracleDriver",
        url: "jdbc:oracle:thin:@//{host}:{port}/{db}",
        maven: Some(("com.oracle.database.jdbc", "ojdbc11")),
    },
    JdbcEngine {
        key: "cubrid",
        label: "CUBRID",
        port: 33000,
        driver_class: "cubrid.jdbc.driver.CUBRIDDriver",
        url: "jdbc:cubrid:{host}:{port}:{db}:::",
        maven: None,
    },
    JdbcEngine {
        key: "tibero",
        label: "Tibero",
        port: 8629,
        driver_class: "com.tmax.tibero.jdbc.TbDriver",
        url: "jdbc:tibero:thin:@{host}:{port}:{db}",
        maven: None,
    },
    JdbcEngine {
        key: "altibase",
        label: "Altibase",
        port: 20300,
        driver_class: "Altibase.jdbc.driver.AltibaseDriver",
        url: "jdbc:Altibase://{host}:{port}/{db}",
        maven: None,
    },
];

pub fn engine(key: &str) -> Option<&'static JdbcEngine> {
    ENGINES.iter().find(|e| e.key == key)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.state::<crate::store::Store>().path.parent().map(Path::to_path_buf).ok_or("앱 폴더를 찾지 못했습니다")?;
    Ok(base.join("jdbc"))
}

fn java_exe(dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "java.exe" } else { "java" };
    let direct = dir.join("bin").join(name);
    if direct.is_file() {
        return Some(direct);
    }
    // 풀린 폴더 한 단계 안(jdk-21…-jre/bin, macOS 는 …/Contents/Home/bin)
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        for cand in [e.path().join("bin").join(name), e.path().join("Contents/Home/bin").join(name)] {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn driver_dir(app: &AppHandle, engine: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join("drivers").join(engine))
}

fn driver_jars(app: &AppHandle, engine: &str) -> Vec<PathBuf> {
    driver_dir(app, engine).map(|d| jars_in(&d)).unwrap_or_default()
}

fn jars_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jar")).collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    key: &'static str,
    label: &'static str,
    port: u16,
    drivers: Vec<String>,
    /// Maven 에서 자동으로 받을 수 있는지
    downloadable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdbcStatus {
    java: Option<String>,
    engines: Vec<EngineStatus>,
}

#[tauri::command(async)]
pub fn jdbc_status(app: AppHandle) -> Result<JdbcStatus, String> {
    let r = root(&app)?;
    Ok(JdbcStatus {
        java: java_exe(&r.join("jre")).map(|p| p.to_string_lossy().into_owned()),
        engines: ENGINES
            .iter()
            .map(|e| EngineStatus {
                key: e.key,
                label: e.label,
                port: e.port,
                drivers: driver_jars(&app, e.key).iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect(),
                downloadable: e.maven.is_some(),
            })
            .collect(),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    what: String,
    done: u64,
    total: u64,
    /// running | done | error
    state: &'static str,
    message: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("RuiBotte-Shell/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// 받아서 파일로 — 진행률 이벤트, 끝나면 (sha256, sha1) 16진
type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

async fn download(progress: Progress<'_>, url: &str, dest: &Path) -> Result<(String, String), String> {
    let resp = client()?.get(url).send().await.map_err(|e| format!("받지 못했습니다: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("받지 못했습니다: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut s256 = sha2::Sha256::new();
    let mut s1 = sha1::Sha1::new();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        s256.update(&chunk);
        s1.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 150 {
            progress(done, total);
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok((hex::encode(s256.finalize()), hex::encode(s1.finalize())))
}

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if archive.extension().is_some_and(|x| x == "zip") {
        zip::ZipArchive::new(f).and_then(|mut z| z.extract(dest)).map_err(|e| e.to_string())
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(dest).map_err(|e| e.to_string())
    }
}

/// Java 실행기 받기(Temurin JRE 21) — 이미 있으면 그대로
#[tauri::command]
pub async fn jdbc_install_java(app: AppHandle) -> Result<String, String> {
    let r = root(&app)?;
    let what = "Java 실행기(Temurin JRE 21)".to_string();
    let a2 = app.clone();
    let w2 = what.clone();
    let progress = move |done: u64, total: u64| {
        let _ = a2.emit("jdbc-install", InstallProgress { what: w2.clone(), done, total, state: "running", message: None });
    };
    match install_java(&r, &progress).await {
        Ok(j) => {
            let _ = app.emit("jdbc-install", InstallProgress { what, done: 1, total: 1, state: "done", message: None });
            Ok(j)
        }
        Err(m) => {
            let _ = app.emit("jdbc-install", InstallProgress { what, done: 0, total: 0, state: "error", message: Some(m.clone()) });
            Err(m)
        }
    }
}

pub(crate) async fn install_java(r: &Path, progress: Progress<'_>) -> Result<String, String> {
    let jre = r.join("jre");
    if let Some(j) = java_exe(&jre) {
        return Ok(j.to_string_lossy().into_owned());
    }
    let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "mac" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    let api = format!("https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse");
    let meta: Value = client()?.get(&api).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let pkg = &meta[0]["binary"]["package"];
    let (link, checksum, name) = (
        pkg["link"].as_str().ok_or("Java 실행기 주소를 찾지 못했습니다")?,
        pkg["checksum"].as_str().ok_or("Java 실행기 확인값을 찾지 못했습니다")?.to_lowercase(),
        pkg["name"].as_str().unwrap_or("jre.zip"),
    );
    std::fs::create_dir_all(r).map_err(|e| e.to_string())?;
    let tmp = r.join(name);
    let (sha256, _) = download(progress, link, &tmp).await?;
    if sha256 != checksum {
        let _ = std::fs::remove_file(&tmp);
        return Err("받은 파일의 sha256 이 Adoptium 값과 맞지 않아 지웠습니다".into());
    }
    let staging = r.join("jre.partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let (t2, s2) = (tmp.clone(), staging.clone());
    tauri::async_runtime::spawn_blocking(move || extract(&t2, &s2)).await.map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_dir_all(&jre);
    std::fs::rename(&staging, &jre).map_err(|e| e.to_string())?;
    let java = java_exe(&jre).ok_or("받은 Java 실행기에서 java 를 찾지 못했습니다")?;
    Ok(java.to_string_lossy().into_owned())
}

/// Maven Central 에서 드라이버 최신판 받기(.sha1 확인)
#[tauri::command]
pub async fn jdbc_install_driver(app: AppHandle, engine: String) -> Result<String, String> {
    let dir = driver_dir(&app, &engine)?;
    let a2 = app.clone();
    let progress = move |done: u64, total: u64| {
        let _ = a2.emit("jdbc-install", InstallProgress { what: "드라이버".into(), done, total, state: "running", message: None });
    };
    let file = install_driver(&dir, &engine, &progress).await?;
    let _ = app.emit("jdbc-install", InstallProgress { what: file.clone(), done: 1, total: 1, state: "done", message: None });
    Ok(file)
}

pub(crate) async fn install_driver(dir: &Path, engine: &str, progress: Progress<'_>) -> Result<String, String> {
    let e = self::engine(engine).ok_or("알 수 없는 엔진")?;
    let (group, artifact) = e.maven.ok_or("이 드라이버는 공개 저장소에 없습니다. jar 파일을 골라 주세요.")?;
    let base = format!("https://repo1.maven.org/maven2/{}/{artifact}", group.replace('.', "/"));
    let meta = client()?.get(format!("{base}/maven-metadata.xml")).send().await.map_err(|x| x.to_string())?.text().await.map_err(|x| x.to_string())?;
    let version = meta
        .split("<release>")
        .nth(1)
        .and_then(|s| s.split("</release>").next())
        .ok_or("최신판을 찾지 못했습니다")?
        .to_string();
    let file = format!("{artifact}-{version}.jar");
    let url = format!("{base}/{version}/{file}");
    let expect = client()?.get(format!("{url}.sha1")).send().await.map_err(|x| x.to_string())?.text().await.map_err(|x| x.to_string())?;
    let expect = expect.split_whitespace().next().unwrap_or("").to_lowercase();
    std::fs::create_dir_all(dir).map_err(|x| x.to_string())?;
    let dest = dir.join(&file);
    let (_, sha1) = download(progress, &url, &dest).await?;
    if sha1 != expect {
        let _ = std::fs::remove_file(&dest);
        return Err("받은 드라이버의 sha1 이 Maven Central 값과 맞지 않아 지웠습니다".into());
    }
    // 같은 엔진의 다른 판은 치운다(클래스 충돌 방지)
    for old in jars_in(dir) {
        if old != dest {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(file)
}

/// 사용자가 고른 jar 를 드라이버로
#[tauri::command(async)]
pub fn jdbc_add_driver_file(app: AppHandle, engine: String, path: String) -> Result<String, String> {
    self::engine(&engine).ok_or("알 수 없는 엔진")?;
    let src = PathBuf::from(&path);
    if src.extension().is_none_or(|x| x != "jar") {
        return Err("jar 파일을 고르세요".into());
    }
    let dir = driver_dir(&app, &engine)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for old in driver_jars(&app, &engine) {
        let _ = std::fs::remove_file(old);
    }
    let name = src.file_name().ok_or("파일 이름이 없습니다")?.to_string_lossy().into_owned();
    std::fs::copy(&src, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

// ── 사이드카 프로세스 ───────────────

type Waiters = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>;

pub struct Sidecar {
    stdin: tokio::sync::Mutex<ChildStdin>,
    waiters: Waiters,
    next: AtomicU64,
    _child: Mutex<Child>,
}

impl Sidecar {
    pub async fn spawn(app: &AppHandle, engine: &str) -> Result<Sidecar, String> {
        let r = root(app)?;
        let java = java_exe(&r.join("jre")).ok_or("NEED_JAVA")?;
        let jars = driver_jars(app, engine);
        if jars.is_empty() {
            return Err("NEED_DRIVER".into());
        }
        let side = app
            .path()
            .resolve("resources/rb-jdbc.jar", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        Self::spawn_with(&java, &side, &jars).await
    }

    pub(crate) async fn spawn_with(java: &Path, side: &Path, jars: &[PathBuf]) -> Result<Sidecar, String> {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let cp = std::iter::once(side.to_path_buf()).chain(jars.iter().cloned()).map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join(sep);
        let mut cmd = Command::new(java);
        cmd.arg("-Xss1m").arg("-XX:+UseSerialGC").arg("-Dfile.encoding=UTF-8").arg("-cp").arg(cp).arg("RbJdbc");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| format!("Java 를 띄우지 못했습니다: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin")?;
        let stdout = child.stdout.take().ok_or("stdout")?;
        let waiters: Waiters = Default::default();
        let w2 = waiters.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = v["id"].as_u64() else { continue };
                let tx = w2.lock().unwrap().get(&id).cloned();
                if let Some(tx) = tx {
                    let _ = tx.send(v);
                }
            }
            // 프로세스가 끝남 — 기다리던 쪽에 알림
            for (_, tx) in w2.lock().unwrap().drain() {
                let _ = tx.send(json!({"type": "error", "code": "CLOSED", "message": "JDBC 브리지가 끝났습니다"}));
            }
        });
        Ok(Sidecar { stdin: tokio::sync::Mutex::new(stdin), waiters, next: AtomicU64::new(1), _child: Mutex::new(child) })
    }

    /// 요청 하나 — 응답 메시지(여러 개일 수 있음)를 받는 통로
    pub async fn request(&self, mut body: Value) -> Result<(u64, mpsc::UnboundedReceiver<Value>), String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        body["id"] = json!(id);
        let (tx, rx) = mpsc::unbounded_channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let mut line = body.to_string();
        line.push('\n');
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok((id, rx))
    }

    pub fn done(&self, id: u64) {
        self.waiters.lock().unwrap().remove(&id);
    }

    /// 응답 한 번만 기다리는 요청
    pub async fn call(&self, body: Value) -> Result<Value, String> {
        let (id, mut rx) = self.request(body).await?;
        let v = rx.recv().await.ok_or("JDBC 브리지가 응답하지 않습니다")?;
        self.done(id);
        Ok(v)
    }
}

pub fn build_url(e: &JdbcEngine, host: &str, port: u16, db: &str) -> String {
    e.url.replace("{host}", host).replace("{port}", &port.to_string()).replace("{db}", db)
}

/// 실제 내려받기·사이드카 — `RB_JDBC_TEST=1` 일 때만(인터넷·Docker Oracle 127.0.0.1:21521 필요)
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_jdbc_download_and_oracle() {
        let pw = std::env::var("RB_DB_TEST_PW").expect("RB_DB_TEST_PW");
        let r = std::env::temp_dir().join("rbshell-jdbc-test");
        let none = |_: u64, _: u64| {};
        let t = std::time::Instant::now();
        let java = install_java(&r, &none).await.unwrap();
        println!("Java 실행기 {java} — {} ms", t.elapsed().as_millis());
        let dir = r.join("drivers").join("oracle");
        let t = std::time::Instant::now();
        let file = install_driver(&dir, "oracle", &none).await.unwrap();
        println!("드라이버 {file} — {} ms", t.elapsed().as_millis());
        let side = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("rb-jdbc.jar");
        let t = std::time::Instant::now();
        let s = Sidecar::spawn_with(Path::new(&java), &side, &jars_in(&dir)).await.unwrap();
        let e = engine("oracle").unwrap();
        let url = build_url(e, "127.0.0.1", 21521, "FREEPDB1");
        let v = s.call(json!({"op": "connect", "url": url, "user": "system", "password": pw, "driver": e.driver_class})).await.unwrap();
        println!("접속 {} ms → {}", t.elapsed().as_millis(), v);
        assert_eq!(v["type"], "ok");
        let (id, mut rx) = s.request(json!({"op": "query", "sql": "SELECT level AS n, 'row ' || level AS name, SYSDATE AS at FROM dual CONNECT BY level <= 50000", "maxRows": 10000})).await.unwrap();
        let mut rows = 0;
        loop {
            let m = rx.recv().await.unwrap();
            match m["type"].as_str() {
                Some("rows") => rows += m["rows"].as_array().unwrap().len(),
                Some("done") => {
                    println!("조회 → {rows}행, truncated {}, {} ms", m["truncated"], m["ms"]);
                    break;
                }
                Some("columns") => println!("열 {}", m["columns"]),
                Some("error") => panic!("{m}"),
                _ => {}
            }
        }
        s.done(id);
        assert_eq!(rows, 10000);
        let tree = s.call(json!({"op": "tree", "path": []})).await.unwrap();
        println!("스키마 {}개", tree["nodes"].as_array().map(|a| a.len()).unwrap_or(0));
        let _ = s.call(json!({"op": "close"})).await;
    }
}
