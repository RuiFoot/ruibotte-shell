//! 접속 정보 가져오기·내보내기 — OpenSSH `~/.ssh/config`, PuTTY 세션(Windows 레지스트리).
//! 암호는 다루지 않는다. 구형 알고리즘 줄(+ssh-rsa·sha1·dss)은 구형 호환 단계로 옮긴다.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::store::{Profile, Store};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source: &'static str,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: Option<String>,
    pub legacy: String,
    /// 같은 주소·포트 서버에 같은 사용자 계정이 이미 있으면
    pub duplicate: bool,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn expand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        home().join(rest).to_string_lossy().replace('\\', "/")
    } else {
        p.to_string()
    }
}

/// 알고리즘 줄들로 구형 단계 고르기
fn legacy_from(algos: &str) -> String {
    let a = algos.to_lowercase();
    if a.contains("ssh-dss") || a.contains("group1-sha1") || a.contains("3des") {
        "weakest".into()
    } else if a.contains("group14-sha1") || a.contains("exchange-sha1") || a.contains("-cbc") || a.contains("hmac-sha1") {
        "sha1".into()
    } else if a.contains("ssh-rsa") {
        "rsa".into()
    } else {
        "off".into()
    }
}

pub fn parse_ssh_config(text: &str) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut cur: Option<(Vec<String>, Candidate, String)> = None;
    let flush = |cur: &mut Option<(Vec<String>, Candidate, String)>, out: &mut Vec<Candidate>| {
        if let Some((names, mut c, algos)) = cur.take() {
            c.legacy = legacy_from(&algos);
            for n in names {
                if n.contains(['*', '?', '!']) {
                    continue; // 와일드카드 블록은 건너뜀
                }
                let mut x = c.clone();
                x.name = n.clone();
                if x.host.is_empty() {
                    x.host = n;
                }
                out.push(x);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match k.as_str() {
            "host" => {
                flush(&mut cur, &mut out);
                let names = v.split_whitespace().map(String::from).collect();
                cur = Some((
                    names,
                    Candidate { source: "ssh-config", name: String::new(), host: String::new(), port: 22, username: String::new(), key_path: None, legacy: "off".into(), duplicate: false },
                    String::new(),
                ));
            }
            "match" => flush(&mut cur, &mut out),
            _ => {
                if let Some((_, c, algos)) = cur.as_mut() {
                    match k.as_str() {
                        "hostname" => c.host = v,
                        "port" => c.port = v.parse().unwrap_or(22),
                        "user" => c.username = v,
                        "identityfile" => c.key_path = Some(expand(&v)),
                        "hostkeyalgorithms" | "pubkeyacceptedalgorithms" | "pubkeyacceptedkeytypes" | "kexalgorithms" | "ciphers" | "macs" => {
                            algos.push(' ');
                            algos.push_str(&v);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(windows)]
fn putty_sessions() -> Vec<Candidate> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(sessions) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\SimonTatham\\PuTTY\\Sessions") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in sessions.enum_keys().flatten() {
        let Ok(s) = sessions.open_subkey(&key) else { continue };
        let proto: String = s.get_value("Protocol").unwrap_or_default();
        let host: String = s.get_value("HostName").unwrap_or_default();
        if proto != "ssh" || host.is_empty() {
            continue;
        }
        let port: u32 = s.get_value("PortNumber").unwrap_or(22);
        let mut user: String = s.get_value("UserName").unwrap_or_default();
        let mut host = host;
        if let Some((u, h)) = host.clone().split_once('@') {
            if user.is_empty() {
                user = u.into();
            }
            host = h.into();
        }
        let key_file: String = s.get_value("PublicKeyFile").unwrap_or_default();
        let kex: String = s.get_value("KEX").unwrap_or_default();
        let hk: String = s.get_value("HostKey").unwrap_or_default();
        let name = urlencoding::decode(&key).map(|c| c.into_owned()).unwrap_or(key);
        out.push(Candidate {
            source: "putty",
            name,
            host,
            port: port as u16,
            username: user,
            key_path: (!key_file.is_empty()).then_some(key_file),
            // PuTTY 는 목록 순서로 경고선을 둔다 — 경고선 위에 낡은 알고리즘이 있으면 그 단계로
            legacy: {
                let above = |list: &str| list.split(",WARN").next().unwrap_or("").to_string();
                legacy_from(&format!("{} {}", above(&kex).replace("dh-group1-sha1", "diffie-hellman-group1-sha1").replace("dh-group14-sha1", "diffie-hellman-group14-sha1").replace("dh-gex-sha1", "diffie-hellman-group-exchange-sha1"), above(&hk).replace("dsa", "ssh-dss")))
            },
            duplicate: false,
        });
    }
    out
}

#[cfg(not(windows))]
fn putty_sessions() -> Vec<Candidate> {
    Vec::new()
}

/// 가져올 후보 — `~/.ssh/config` 와 PuTTY 세션. 이미 있는 것은 duplicate 표시
#[tauri::command]
pub fn import_candidates(store: State<'_, Store>, ssh_config_path: Option<String>) -> Result<Vec<Candidate>, String> {
    let path = ssh_config_path.map(PathBuf::from).unwrap_or_else(|| home().join(".ssh").join("config"));
    let mut all = std::fs::read_to_string(&path).map(|t| parse_ssh_config(&t)).unwrap_or_default();
    all.extend(putty_sessions());
    let existing = crate::store::profiles_list(store)?;
    for c in &mut all {
        c.duplicate = existing
            .iter()
            .any(|p| p.kind == "ssh" && p.host.eq_ignore_ascii_case(&c.host) && p.port == c.port && p.accounts.iter().any(|a| a.username == c.username));
    }
    Ok(all)
}

/// 내 SSH 서버를 ssh config 로(암호 없음, 계정은 기본 계정). 구형 단계는 켠 만큼 알고리즘 줄을 붙인다
#[tauri::command]
pub fn export_ssh_config(store: State<'_, Store>) -> Result<String, String> {
    let list: Vec<Profile> = crate::store::profiles_list(store)?;
    let mut s = String::from("# RuiBotte Shell 에서 내보냄 — 암호는 들어 있지 않습니다\n");
    for p in list.iter().filter(|p| p.kind == "ssh") {
        let alias: String = p.name.chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect();
        s.push_str(&format!("\nHost {alias}\n    HostName {}\n", p.host));
        if p.port != 22 {
            s.push_str(&format!("    Port {}\n", p.port));
        }
        if !p.username.is_empty() {
            s.push_str(&format!("    User {}\n", p.username));
        }
        if let (true, Some(k)) = (p.auth == "key", p.key_path.as_deref()) {
            s.push_str(&format!("    IdentityFile {k}\n"));
        }
        let lvl = p.legacy.as_str();
        if lvl != "off" {
            let hk = if lvl == "weakest" { "+ssh-rsa,ssh-dss" } else { "+ssh-rsa" };
            s.push_str(&format!("    HostKeyAlgorithms {hk}\n    PubkeyAcceptedAlgorithms +ssh-rsa\n"));
        }
        if lvl == "sha1" || lvl == "weakest" {
            let kex = if lvl == "weakest" {
                "+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1"
            } else {
                "+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1"
            };
            let ciphers = if lvl == "weakest" { "+aes128-cbc,aes256-cbc,3des-cbc" } else { "+aes128-cbc,aes256-cbc" };
            s.push_str(&format!("    KexAlgorithms {kex}\n    Ciphers {ciphers}\n    MACs +hmac-sha1\n"));
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks_and_legacy() {
        let c = parse_ssh_config(
            "Host *\n  ServerAliveInterval 30\n\nHost dev web\n  HostName 10.0.0.5\n  User app\n  Port 2222\n\nHost old\n  HostName old.example.com\n  HostKeyAlgorithms +ssh-rsa\n  KexAlgorithms +diffie-hellman-group14-sha1\n",
        );
        assert_eq!(c.len(), 3);
        assert_eq!((c[0].name.as_str(), c[0].host.as_str(), c[0].port, c[0].username.as_str()), ("dev", "10.0.0.5", 2222, "app"));
        assert_eq!(c[1].name, "web");
        assert_eq!(c[2].legacy, "sha1");
    }
}

// ── 내보내기 전 형식 ─────────────────

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn jdbc_url(p: &Profile) -> String {
    let db = p.database.clone().unwrap_or_default();
    match p.engine.as_deref().unwrap_or("postgres") {
        "postgres" => format!("jdbc:postgresql://{}:{}/{}", p.host, p.port, db),
        "mariadb" => format!("jdbc:mariadb://{}:{}/{}", p.host, p.port, db),
        "mysql" => format!("jdbc:mysql://{}:{}/{}", p.host, p.port, db),
        "mssql" => format!("jdbc:sqlserver://{}:{};databaseName={}", p.host, p.port, db),
        "oracle" => format!("jdbc:oracle:thin:@//{}:{}/{}", p.host, p.port, db),
        "cubrid" => format!("jdbc:cubrid:{}:{}:{}:::", p.host, p.port, db),
        "tibero" => format!("jdbc:tibero:thin:@{}:{}:{}", p.host, p.port, db),
        "altibase" => format!("jdbc:Altibase://{}:{}/{}", p.host, p.port, db),
        _ => String::new(),
    }
}

/// 내보내기 — ssh-config · hosts · putty-reg · mobaxterm · datagrip · dbeaver · jdbc-csv (암호는 넣지 않는다)
#[tauri::command]
pub fn export_profiles(store: State<'_, Store>, format: String) -> Result<String, String> {
    if format == "ssh-config" {
        return export_ssh_config(store);
    }
    let list: Vec<Profile> = crate::store::profiles_list(store)?;
    let ssh: Vec<&Profile> = list.iter().filter(|p| p.kind == "ssh").collect();
    let dbs: Vec<&Profile> = list.iter().filter(|p| p.kind == "db").collect();
    Ok(match format.as_str() {
        "hosts" => {
            let mut s = String::from("# RuiBotte Shell — hosts 파일에 붙일 줄(이름으로 부르기). IP 가 아닌 주소는 빠집니다\n");
            for p in &ssh {
                if p.host.parse::<std::net::IpAddr>().is_ok() {
                    let alias: String = p.name.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).collect();
                    s.push_str(&format!("{}\t{}\n", p.host, alias.to_lowercase()));
                }
            }
            s
        }
        "putty-reg" => {
            let mut s = String::from("Windows Registry Editor Version 5.00\n\n; RuiBotte Shell 에서 내보낸 PuTTY 세션 — 암호는 없습니다\n");
            for p in &ssh {
                let key = urlencoding::encode(&p.name).into_owned();
                s.push_str(&format!("\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\{key}]\n"));
                s.push_str(&format!("\"HostName\"=\"{}\"\n\"PortNumber\"=dword:{:08x}\n\"Protocol\"=\"ssh\"\n\"UserName\"=\"{}\"\n", p.host, p.port, p.username));
                if p.auth == "key" {
                    if let Some(k) = &p.key_path {
                        s.push_str(&format!("\"PublicKeyFile\"=\"{}\"\n", k.replace('\\', "\\\\")));
                    }
                }
                if p.legacy == "weakest" {
                    s.push_str("\"KEX\"=\"ecdh,dh-gex-sha1,dh-group14-sha1,dh-group1-sha1,rsa,WARN\"\n\"HostKey\"=\"ed25519,ecdsa,rsa,dsa,WARN\"\n");
                } else if p.legacy != "off" {
                    s.push_str("; 구형 서버 — PuTTY 기본 설정으로도 대개 붙습니다\n");
                }
            }
            s
        }
        "mobaxterm" => {
            let mut s = String::from("[Bookmarks]\nSubRep=RuiBotte Shell\nImgNum=41\n");
            for p in &ssh {
                s.push_str(&format!(
                    "{}=#109#0%{}%{}%{}%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1\n",
                    p.name.replace('=', "-"),
                    p.host,
                    p.port,
                    p.username
                ));
            }
            s
        }
        "datagrip" => {
            let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- RuiBotte Shell 에서 내보냄 — 암호 없음 -->\n<project version=\"4\">\n  <component name=\"DataSourceManagerImpl\" format=\"xml\" multifile-model=\"true\">\n");
            for (i, p) in dbs.iter().enumerate() {
                let driver = match p.engine.as_deref() {
                    Some("postgres") => "postgresql",
                    Some("mariadb") => "mariadb",
                    Some("mysql") => "mysql.8",
                    Some("mssql") => "sqlserver.ms",
                    Some("oracle") => "oracle",
                    _ => "generic",
                };
                s.push_str(&format!(
                    "    <data-source source=\"LOCAL\" name=\"{}\" uuid=\"rbshell-{:08}\">\n      <driver-ref>{driver}</driver-ref>\n      <synchronize>true</synchronize>\n      <jdbc-url>{}</jdbc-url>\n      <user-name>{}</user-name>\n    </data-source>\n",
                    xml_esc(&p.name),
                    i,
                    xml_esc(&jdbc_url(p)),
                    xml_esc(&p.username)
                ));
            }
            s.push_str("  </component>\n</project>\n");
            s
        }
        "dbeaver" => {
            let mut conns = serde_json::Map::new();
            for (i, p) in dbs.iter().enumerate() {
                let (provider, driver) = match p.engine.as_deref() {
                    Some("postgres") => ("postgresql", "postgres-jdbc"),
                    Some("mariadb") => ("mysql", "mariaDB"),
                    Some("mysql") => ("mysql", "mysql8"),
                    Some("mssql") => ("sqlserver", "microsoft"),
                    Some("oracle") => ("oracle", "oracle_thin"),
                    _ => ("generic", "generic"),
                };
                conns.insert(
                    format!("rbshell-{i}"),
                    serde_json::json!({
                        "provider": provider, "driver": driver, "name": p.name, "save-password": false,
                        "configuration": { "host": p.host, "port": p.port.to_string(), "database": p.database.clone().unwrap_or_default(), "user": p.username, "url": jdbc_url(p), "type": "dev" }
                    }),
                );
            }
            serde_json::to_string_pretty(&serde_json::json!({ "folders": {}, "connections": conns })).map_err(|e| e.to_string())?
        }
        "jdbc-csv" => {
            let mut s = String::from("이름,엔진,JDBC URL,계정\n");
            for p in &dbs {
                s.push_str(&format!("\"{}\",{},\"{}\",{}\n", p.name.replace('"', "\"\""), p.engine.clone().unwrap_or_default(), jdbc_url(p), p.username));
            }
            s
        }
        _ => return Err("알 수 없는 형식".into()),
    })
}

/// JDBC URL → (엔진, 호스트, 포트, DB)
fn parse_jdbc(url: &str) -> Option<(&'static str, String, u16, String)> {
    let u = url.trim();
    let hp = |s: &str, def: u16| -> (String, u16) {
        let s = s.trim_start_matches("//");
        match s.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse().unwrap_or(def)),
            _ => (s.to_string(), def),
        }
    };
    for (pre, eng, def) in [("jdbc:postgresql:", "postgres", 5432u16), ("jdbc:mariadb:", "mariadb", 3306), ("jdbc:mysql:", "mysql", 3306)] {
        if let Some(rest) = u.strip_prefix(pre) {
            let rest = rest.trim_start_matches("//");
            let (hostport, path) = rest.split_once('/').unwrap_or((rest, ""));
            let (h, p) = hp(hostport, def);
            return Some((eng, h, p, path.split('?').next().unwrap_or("").to_string()));
        }
    }
    if let Some(rest) = u.strip_prefix("jdbc:sqlserver://") {
        let (hostport, props) = rest.split_once(';').unwrap_or((rest, ""));
        let (h, p) = hp(hostport, 1433);
        let db = props.split(';').find_map(|kv| kv.strip_prefix("databaseName=").or_else(|| kv.strip_prefix("database="))).unwrap_or("").to_string();
        return Some(("mssql", h, p, db));
    }
    if let Some(rest) = u.strip_prefix("jdbc:oracle:thin:@") {
        let rest = rest.trim_start_matches("//");
        let (hostport, svc) = rest.split_once('/').unwrap_or((rest, ""));
        let (h, p) = hp(hostport, 1521);
        return Some(("oracle", h, p, svc.to_string()));
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCandidate {
    source: &'static str,
    name: String,
    engine: &'static str,
    host: String,
    port: u16,
    database: String,
    username: String,
}

/// DataGrip(dataSources.xml·dataSources.local.xml)·DBeaver(data-sources.json) 파일에서 DB 접속 가져오기
#[tauri::command]
pub fn import_db_file(path: String) -> Result<Vec<DbCandidate>, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if path.to_lowercase().ends_with(".json") {
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        for (_, c) in v["connections"].as_object().into_iter().flatten() {
            let cfg = &c["configuration"];
            let url = cfg["url"].as_str().unwrap_or("");
            let (engine, host, port, db) = match parse_jdbc(url) {
                Some(x) => x,
                None => {
                    let eng = match c["provider"].as_str().unwrap_or("") {
                        "postgresql" => "postgres",
                        "mysql" => "mysql",
                        "sqlserver" => "mssql",
                        "oracle" => "oracle",
                        _ => continue,
                    };
                    (eng, cfg["host"].as_str().unwrap_or("").into(), cfg["port"].as_str().and_then(|p| p.parse().ok()).unwrap_or(0), cfg["database"].as_str().unwrap_or("").into())
                }
            };
            out.push(DbCandidate { source: "dbeaver", name: c["name"].as_str().unwrap_or("").into(), engine, host, port, database: db, username: cfg["user"].as_str().unwrap_or("").into() });
        }
    } else {
        // 아주 단순한 XML 읽기 — <data-source name="…"> 안의 <jdbc-url>·<user-name>
        for block in text.split("<data-source").skip(1) {
            let name = block.split("name=\"").nth(1).and_then(|x| x.split('"').next()).unwrap_or("").replace("&amp;", "&");
            let tag = |t: &str| block.split(&format!("<{t}>")).nth(1).and_then(|x| x.split(&format!("</{t}>")).next()).map(|x| x.replace("&amp;", "&"));
            if let Some((engine, host, port, db)) = tag("jdbc-url").and_then(|u| parse_jdbc(&u)) {
                out.push(DbCandidate { source: "datagrip", name, engine, host, port, database: db, username: tag("user-name").unwrap_or_default() });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod jdbc_tests {
    use super::*;

    #[test]
    fn parses_jdbc_urls() {
        assert_eq!(parse_jdbc("jdbc:postgresql://db.x:5433/app?ssl=true"), Some(("postgres", "db.x".into(), 5433, "app".into())));
        assert_eq!(parse_jdbc("jdbc:mysql://h/shop"), Some(("mysql", "h".into(), 3306, "shop".into())));
        assert_eq!(parse_jdbc("jdbc:sqlserver://s:1444;databaseName=erp;encrypt=false"), Some(("mssql", "s".into(), 1444, "erp".into())));
        assert_eq!(parse_jdbc("jdbc:oracle:thin:@//o:1521/ORCLPDB1"), Some(("oracle", "o".into(), 1521, "ORCLPDB1".into())));
    }
}
