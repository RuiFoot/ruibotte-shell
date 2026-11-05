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
    /// 같은 주소·포트·계정 프로필이 이미 있으면
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
            .any(|p| p.kind == "ssh" && p.host.eq_ignore_ascii_case(&c.host) && p.port == c.port && p.username == c.username);
    }
    Ok(all)
}

/// 내 SSH 프로필을 ssh config 로(암호 없음). 구형 단계는 켠 만큼 알고리즘 줄을 붙인다
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
