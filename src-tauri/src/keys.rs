//! SSH 키 관리 — 목록(~/.ssh·앱 keys 폴더), 새로 만들기(ed25519·RSA 4096, 암호 선택),
//! PuTTY .ppk ↔ OpenSSH 바꾸기, 공개키를 서버 authorized_keys 에 넣기(ssh-copy-id 와 같은 동작).
//! 키 처리는 russh 가 쓰는 ssh-key 크레이트(russh::keys::ssh_key)로 한다 — 새 의존성 없음.

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::encoding::base64::{Base64, Encoding as _};
use russh::keys::ssh_key::encoding::Encode;
use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
use russh::keys::ssh_key::{LineEnding, PrivateKey, PublicKey};
use russh::keys::{decode_secret_key, Algorithm, HashAlg};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::ssh::SshConns;
use crate::store::Store;

/// 암호가 필요하다는 오류 — 화면은 이 머리로 알아보고 암호를 묻는다
const NEED_PASSPHRASE: &str = "NEED_PASSPHRASE: 키 암호를 넣어 주세요";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    path: String,
    name: String,
    /// "ssh" = ~/.ssh, "app" = 앱 데이터의 keys, "other" = 그 밖
    place: String,
    /// openssh · pem · pkcs8 · ppk · pub(공개키만)
    format: String,
    algorithm: Option<String>,
    bits: Option<u32>,
    fingerprint: Option<String>,
    comment: Option<String>,
    /// 공개키 한 줄(authorized_keys 형식) — 비밀이 아니다
    public_key: Option<String>,
    encrypted: Option<bool>,
    /// 짝 공개키 파일(.pub)
    pub_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDirs {
    ssh: String,
    app: String,
}

fn home() -> PathBuf {
    let v = if cfg!(windows) { std::env::var_os("USERPROFILE") } else { std::env::var_os("HOME") };
    v.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn ssh_dir() -> PathBuf {
    home().join(".ssh")
}

fn app_dir(store: &Store) -> PathBuf {
    store.path.join("keys")
}

fn bits_of(p: &PublicKey) -> Option<u32> {
    match p.key_data() {
        russh::keys::ssh_key::public::KeyData::Rsa(r) => Some(r.key_size()),
        russh::keys::ssh_key::public::KeyData::Ed25519(_) => Some(256),
        russh::keys::ssh_key::public::KeyData::Ecdsa(e) => Some(match e.curve() {
            russh::keys::EcdsaCurve::NistP256 => 256,
            russh::keys::EcdsaCurve::NistP384 => 384,
            russh::keys::EcdsaCurve::NistP521 => 521,
        }),
        _ => None,
    }
}

fn fill_public(info: &mut KeyInfo, p: &PublicKey) {
    info.algorithm = Some(p.algorithm().to_string());
    info.bits = bits_of(p);
    info.fingerprint = Some(p.fingerprint(HashAlg::Sha256).to_string());
    let c = p.comment().as_str_lossy().to_string();
    if !c.is_empty() {
        info.comment = Some(c);
    }
    info.public_key = p.to_openssh().ok();
}

/// PPK 의 공개 부분(암호를 몰라도 읽힌다)
fn ppk_public(text: &str) -> Option<(PublicKey, bool, String)> {
    let mut lines = text.lines();
    let mut encrypted = false;
    let mut comment = String::new();
    let mut public = None;
    while let Some(l) = lines.next() {
        if let Some(v) = l.strip_prefix("Encryption: ") {
            encrypted = v.trim() != "none";
        } else if let Some(v) = l.strip_prefix("Comment: ") {
            comment = v.trim().to_string();
        } else if let Some(v) = l.strip_prefix("Public-Lines: ") {
            let n: usize = v.trim().parse().ok()?;
            let b64: String = (0..n).filter_map(|_| lines.next()).map(str::trim).collect();
            let bytes = Base64::decode_vec(&b64).ok()?;
            public = PublicKey::from_bytes(&bytes).ok();
        }
    }
    let mut p = public?;
    p.set_comment(comment.clone());
    Some((p, encrypted, comment))
}

/// 파일 하나 살펴보기 — 개인키(또는 공개키만)면 Some
fn inspect(path: &Path, place: &str) -> Option<KeyInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    let pub_path = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
    let mut info = KeyInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        place: place.into(),
        format: String::new(),
        algorithm: None,
        bits: None,
        fingerprint: None,
        comment: None,
        public_key: None,
        encrypted: None,
        pub_path: pub_path.is_file().then(|| pub_path.to_string_lossy().into_owned()),
    };
    let t = text.trim_start();
    if t.starts_with("PuTTY-User-Key-File-") {
        info.format = "ppk".into();
        if let Some((p, enc, _)) = ppk_public(&text) {
            fill_public(&mut info, &p);
            info.encrypted = Some(enc);
        }
    } else if t.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        info.format = "openssh".into();
        if let Ok(k) = PrivateKey::from_openssh(&text) {
            info.encrypted = Some(k.is_encrypted());
            fill_public(&mut info, k.public_key());
        }
    } else if t.starts_with("-----BEGIN RSA PRIVATE KEY-----") || t.starts_with("-----BEGIN EC PRIVATE KEY-----") || t.starts_with("-----BEGIN PRIVATE KEY-----") {
        info.format = if t.starts_with("-----BEGIN PRIVATE KEY-----") { "pkcs8" } else { "pem" }.into();
        let enc = text.contains("ENCRYPTED");
        info.encrypted = Some(enc);
        if !enc {
            if let Ok(k) = decode_secret_key(&text, None) {
                fill_public(&mut info, k.public_key());
            }
        }
    } else if t.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        info.format = "pkcs8".into();
        info.encrypted = Some(true);
    } else {
        return None;
    }
    // 짝 .pub 가 있으면 그쪽 공개키를 믿는다(암호 걸린 PEM 도 지문이 보이게)
    if info.public_key.is_none() {
        if let Some(p) = info.pub_path.as_ref().and_then(|pp| std::fs::read_to_string(pp).ok()).and_then(|s| PublicKey::from_openssh(s.trim()).ok()) {
            fill_public(&mut info, &p);
        }
    }
    Some(info)
}

fn scan(dir: &Path, place: &str, out: &mut Vec<KeyInfo>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    names.sort();
    let skip = ["known_hosts", "known_hosts.old", "authorized_keys", "authorized_keys2", "config", "environment"];
    for p in &names {
        let n = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if skip.contains(&n.as_str()) || n.ends_with(".pub") {
            continue;
        }
        if let Some(i) = inspect(p, place) {
            out.push(i);
        }
    }
    // 개인키 없이 공개키만 있는 것
    for p in &names {
        let n = p.to_string_lossy();
        let Some(stem) = n.strip_suffix(".pub") else {
            continue;
        };
        if Path::new(stem).is_file() && out.iter().any(|k| k.path == stem) {
            continue;
        }
        let Some(pk) = std::fs::read_to_string(p).ok().and_then(|s| PublicKey::from_openssh(s.trim()).ok()) else {
            continue;
        };
        let mut info = KeyInfo {
            path: n.to_string(),
            name: p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            place: place.into(),
            format: "pub".into(),
            algorithm: None,
            bits: None,
            fingerprint: None,
            comment: None,
            public_key: None,
            encrypted: None,
            pub_path: Some(n.to_string()),
        };
        fill_public(&mut info, &pk);
        out.push(info);
    }
}

#[tauri::command]
pub fn keys_dirs(store: State<'_, Store>) -> KeyDirs {
    KeyDirs { ssh: ssh_dir().to_string_lossy().into_owned(), app: app_dir(&store).to_string_lossy().into_owned() }
}

#[tauri::command]
pub fn keys_list(store: State<'_, Store>) -> Vec<KeyInfo> {
    let mut out = Vec::new();
    scan(&ssh_dir(), "ssh", &mut out);
    scan(&app_dir(&store), "app", &mut out);
    out
}

/// 파일 하나(바꾸기 전에 형식·암호 여부 보기)
#[tauri::command(async)]
pub fn keys_inspect(path: String) -> Result<KeyInfo, String> {
    inspect(Path::new(&path), "other").ok_or_else(|| "SSH 개인키 파일이 아닙니다".into())
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn set_mode(_p: &Path, _mode: u32) {}

/// 개인키(600)·공개키(644) 쓰기 — 이미 있으면 거절
fn write_pair(path: &Path, private: &str, public: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    let open_new = |p: &Path| std::fs::OpenOptions::new().write(true).create_new(true).open(p);
    if public.is_some() && Path::new(&format!("{}.pub", path.to_string_lossy())).exists() {
        return Err("같은 이름의 .pub 파일이 이미 있습니다".into());
    }
    let mut f = open_new(path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "같은 이름의 파일이 이미 있습니다".to_string() } else { e.to_string() })?;
    set_mode(path, 0o600);
    f.write_all(private.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(pubs) = public {
        let pp = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
        let mut g = open_new(&pp).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "같은 이름의 .pub 파일이 이미 있습니다".to_string() } else { e.to_string() })?;
        g.write_all(format!("{}\n", pubs.trim_end()).as_bytes()).map_err(|e| e.to_string())?;
        set_mode(&pp, 0o644);
    }
    Ok(())
}

/// 새 키 — algo: "ed25519" | "rsa"(4096), place: "ssh" | "app"
#[tauri::command]
pub async fn keys_generate(store: State<'_, Store>, name: String, algo: String, passphrase: Option<String>, comment: Option<String>, place: String) -> Result<KeyInfo, String> {
    if !valid_file_name(&name) {
        return Err("파일 이름은 영문·숫자·- _ . 로 64자까지(점으로 시작 안 됨)".into());
    }
    let dir = if place == "app" { app_dir(&store) } else { ssh_dir() };
    let place2 = if place == "app" { "app" } else { "ssh" };
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        set_mode(&dir, 0o700);
        let path = dir.join(&name);
        if path.exists() || PathBuf::from(format!("{}.pub", path.to_string_lossy())).exists() {
            return Err("같은 이름의 키가 이미 있습니다".to_string());
        }
        let mut rng = russh::keys::key::safe_rng();
        let mut key = match algo.as_str() {
            "rsa" => {
                let kp = RsaKeypair::random(&mut rng, 4096).map_err(|e| e.to_string())?;
                PrivateKey::new(KeypairData::from(kp), "").map_err(|e| e.to_string())?
            }
            _ => PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(|e| e.to_string())?,
        };
        key.set_comment(comment.unwrap_or_default().trim());
        let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
        let stored = match passphrase.filter(|p| !p.is_empty()) {
            Some(pw) => key.encrypt(&mut rng, pw.as_bytes()).map_err(|e| e.to_string())?,
            None => key,
        };
        let text = stored.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
        write_pair(&path, &text, Some(&public))?;
        inspect(&path, place2).ok_or_else(|| "만든 키를 다시 읽지 못했습니다".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

fn b64_lines(bytes: &[u8]) -> Vec<String> {
    let s = Base64::encode_string(bytes);
    s.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect()
}

/// PuTTY PPK 3 (암호 없음) — ed25519·RSA. 암호 걸린 PPK 쓰기(Argon2)는 지원하지 않는다
fn to_ppk_v3(key: &PrivateKey) -> Result<String, String> {
    let e = |x: russh::keys::ssh_key::encoding::Error| x.to_string();
    let alg = key.algorithm().to_string();
    let public_blob = key.public_key().to_bytes().map_err(|x| x.to_string())?;
    let mut private_blob = Vec::new();
    match key.key_data() {
        // PuTTY 는 ed25519 비밀 32바이트를 길이 붙은 그대로 둔다
        KeypairData::Ed25519(kp) => kp.private.to_bytes().as_slice().encode(&mut private_blob).map_err(e)?,
        KeypairData::Rsa(kp) => {
            let p = kp.private();
            p.d().encode(&mut private_blob).map_err(e)?;
            p.p().encode(&mut private_blob).map_err(e)?;
            p.q().encode(&mut private_blob).map_err(e)?;
            p.iqmp().encode(&mut private_blob).map_err(e)?;
        }
        _ => return Err("PPK 로는 ed25519·RSA 키만 바꿀 수 있습니다".into()),
    }
    let comment = key.comment().as_str_lossy().to_string();
    let mut mac_buf = Vec::new();
    alg.as_str().encode(&mut mac_buf).map_err(e)?;
    "none".encode(&mut mac_buf).map_err(e)?;
    comment.as_str().encode(&mut mac_buf).map_err(e)?;
    public_blob.as_slice().encode(&mut mac_buf).map_err(e)?;
    private_blob.as_slice().encode(&mut mac_buf).map_err(e)?;
    let mac = hmac_sha256(&[], &mac_buf);
    let publ = b64_lines(&public_blob);
    let privl = b64_lines(&private_blob);
    let mut out = format!("PuTTY-User-Key-File-3: {alg}\nEncryption: none\nComment: {comment}\nPublic-Lines: {}\n", publ.len());
    for l in publ {
        out.push_str(&l);
        out.push('\n');
    }
    out.push_str(&format!("Private-Lines: {}\n", privl.len()));
    for l in privl {
        out.push_str(&l);
        out.push('\n');
    }
    out.push_str(&format!("Private-MAC: {}\n", hex::encode(mac)));
    Ok(out)
}

/// 키 파일 읽기(암호 풀기까지) — PPK(2·3, 암호 포함)·OpenSSH·PEM·PKCS#8
fn load_key(src: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let text = std::fs::read_to_string(src).map_err(|e| format!("읽지 못했습니다: {e}"))?;
    let pw = passphrase.filter(|p| !p.is_empty());
    match decode_secret_key(&text, pw) {
        Ok(k) if k.is_encrypted() => match pw {
            Some(p) => k.decrypt(p).map_err(|_| "암호가 맞지 않습니다".to_string()),
            None => Err(NEED_PASSPHRASE.into()),
        },
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(NEED_PASSPHRASE.into()),
        Err(e) => {
            let m = e.to_string();
            if pw.is_none() && (m.contains("ncrypted") || m.contains("passphrase")) {
                Err(NEED_PASSPHRASE.into())
            } else if pw.is_some() && (m.contains("MAC") || m.contains("ecrypt") || m.contains("rypto")) {
                Err("암호가 맞지 않거나 키 파일이 상했습니다".into())
            } else {
                Err(format!("키를 읽지 못했습니다: {m}"))
            }
        }
    }
}

/// 바꾸기 — to: "openssh"(개인키 + .pub, new_passphrase 면 암호 걸기) | "ppk"(PPK 3, 암호 없음)
#[tauri::command]
pub async fn keys_convert(src: String, dst: String, to: String, passphrase: Option<String>, new_passphrase: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if Path::new(&dst).exists() {
            return Err("저장할 자리에 같은 이름의 파일이 이미 있습니다".to_string());
        }
        let key = load_key(&src, passphrase.as_deref())?;
        match to.as_str() {
            "ppk" => {
                if new_passphrase.as_deref().is_some_and(|p| !p.is_empty()) {
                    return Err("암호 걸린 PPK 만들기는 아직 지원하지 않습니다 — 암호 없이 만든 뒤 PuTTYgen 에서 거세요".into());
                }
                let text = to_ppk_v3(&key)?;
                write_pair(Path::new(&dst), &text, None)?;
            }
            _ => {
                let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
                let stored = match new_passphrase.filter(|p| !p.is_empty()) {
                    Some(pw) => key.encrypt(&mut russh::keys::key::safe_rng(), pw.as_bytes()).map_err(|e| e.to_string())?,
                    None => key,
                };
                let text = stored.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
                write_pair(Path::new(&dst), &text, Some(&public))?;
            }
        }
        Ok(dst)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 공개키 한 줄을 안전한 꼴로 — 다시 읽어 종류·본문만, 설명은 영문·숫자·@._- 만 남긴다
fn clean_public_line(line: &str) -> Result<(String, String), String> {
    let p = PublicKey::from_openssh(line.trim()).map_err(|_| "공개키 형식이 아닙니다".to_string())?;
    let mut bare = p.clone();
    bare.set_comment("");
    let body = bare.to_openssh().map_err(|e| e.to_string())?;
    let b64 = body.split_whitespace().nth(1).unwrap_or_default().to_string();
    let c: String = p.comment().as_str_lossy().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-')).take(80).collect();
    let full = if c.is_empty() { body.trim().to_string() } else { format!("{} {c}", body.trim()) };
    Ok((full, b64))
}

/// authorized_keys 에 넣는 셸 글 — POSIX sh 로 돌려 로그인 셸 종류와 상관없게
fn install_script(full: &str, b64: &str) -> String {
    let script = format!(
        concat!(
            "umask 077; d=\"$HOME/.ssh\"; f=\"$d/authorized_keys\"; ",
            "mkdir -p \"$d\" && chmod 700 \"$d\" && touch \"$f\" && chmod 600 \"$f\" || {{ echo RB_FAIL; exit 1; }}; ",
            "if grep -qF \"{b64}\" \"$f\"; then echo RB_EXISTS; else ",
            "if [ -s \"$f\" ] && [ -n \"$(tail -c1 \"$f\")\" ]; then echo >> \"$f\"; fi; ",
            "echo \"{full}\" >> \"$f\" && echo RB_ADDED || echo RB_FAIL; fi"
        ),
        b64 = b64,
        full = full
    );
    format!("sh -c '{script}' 2>&1")
}

/// 공개키를 지금 연결의 서버에 등록 — 이미 있으면 "exists", 넣었으면 "added"
#[tauri::command]
pub async fn keys_install(conns: State<'_, SshConns>, conn: u32, public_key: String) -> Result<String, String> {
    let (full, b64) = clean_public_line(&public_key)?;
    let out = crate::ssh::ssh_exec(conns, conn, install_script(&full, &b64)).await.map_err(|e| e.message_owned())?;
    if out.contains("RB_EXISTS") {
        Ok("exists".into())
    } else if out.contains("RB_ADDED") {
        Ok("added".into())
    } else {
        let msg: String = out.trim().chars().take(300).collect();
        Err(if msg.is_empty() { "서버에서 authorized_keys 를 고치지 못했습니다".into() } else { format!("서버에서 고치지 못했습니다: {msg}") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 시험용 키는 저장소에 넣지 않고 그때그때 만든다(공개 저장소의 비밀 검사 — 시험 자료라도 개인키는 올리지 않음)
    fn fresh_ed25519() -> PrivateKey {
        let mut k = PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap();
        k.set_comment("user@example.com");
        k
    }
    #[test]
    fn ppk_v3_shape() {
        let ppk = to_ppk_v3(&fresh_ed25519()).unwrap();
        assert!(ppk.starts_with("PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: user@example.com
Public-Lines: 2
"));
        assert!(ppk.contains("
Private-Lines: 1
") && ppk.contains("
Private-MAC: "));
    }
    #[test]
    fn ppk_round_trip() {
        let o = fresh_ed25519();
        let ppk = to_ppk_v3(&o).unwrap();
        let k = decode_secret_key(&ppk, None).unwrap();
        assert_eq!(k.public_key().fingerprint(HashAlg::Sha256), o.public_key().fingerprint(HashAlg::Sha256));
        let (p, enc, c) = ppk_public(&ppk).unwrap();
        assert!(!enc);
        assert_eq!(c, "user@example.com");
        assert_eq!(p.fingerprint(HashAlg::Sha256), o.public_key().fingerprint(HashAlg::Sha256));
    }
    #[test]
    fn public_line_is_sanitized() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti me'$(rm)@x";
        let (full, b64) = clean_public_line(line).unwrap();
        assert_eq!(b64, "AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti");
        assert!(!full.contains('\'') && !full.contains('$'));
        assert!(install_script(&full, &b64).starts_with("sh -c '"));
    }

    #[test]
    fn file_names() {
        assert!(valid_file_name("id_ed25519_work"));
        assert!(!valid_file_name("../x"));
        assert!(!valid_file_name(".hidden"));
    }
}
