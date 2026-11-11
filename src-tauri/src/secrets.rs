//! 비밀 저장 — OS 자격 증명 저장소(Windows 자격 증명 관리자 · macOS 키체인).
//! 앱 DB 에는 "저장했다"는 표시만 남는다. 값은 화면으로 다시 돌려주지 않는다.
//! 키: 계정 암호(또는 개인키 암호) = "account:{id}", 그 계정의 sudo 암호 = "account:{id}:sudo".
//! 예전 판(서버 하나 = 계정 하나)의 "profile:{id}"·"profile:{id}:sudo" 는 앱을 켤 때 계정 키로 옮긴다(store.rs).

/// 시험(cargo test)은 다른 이름을 써서 실제 앱의 비밀을 건드리지 않는다
const SERVICE: &str = if cfg!(test) { "RuiBotte Shell (test)" } else { "RuiBotte Shell" };

fn entry(key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.inner.get_password().ok()
}

/// 없음(Ok(None))과 저장소 오류(Err)를 가른다 — 옮기기에서 실패를 알아야 원래 키를 남길 수 있다
pub fn lookup(key: &str) -> Result<Option<String>, String> {
    let e = entry(key).ok_or("OS 자격 증명 저장소를 쓸 수 없습니다")?;
    match e.inner.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(x) => Err(x.to_string()),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)
        .ok_or("OS 자격 증명 저장소를 쓸 수 없습니다")?
        .inner
        .set_password(value)
        .map_err(|e| e.to_string())
}

pub fn forget(key: &str) {
    if let Some(e) = entry(key) {
        let _ = e.inner.delete_credential();
    }
}

pub fn account_key(account_id: i64) -> String {
    format!("account:{account_id}")
}

pub fn sudo_key(account_id: i64) -> String {
    format!("account:{account_id}:sudo")
}

/// 예전 키를 새 키로 옮긴다 — 새 키를 다시 읽어 같은 값인 걸 본 뒤에만 예전 키를 지운다.
/// Ok(true) 옮김, Ok(false) 옮길 것 없음, Err 저장소 오류(예전 키는 그대로 남는다)
pub fn move_key(old: &str, new: &str) -> Result<bool, String> {
    let Some(v) = lookup(old)? else {
        return Ok(false);
    };
    if lookup(new)?.as_deref() != Some(v.as_str()) {
        set(new, &v)?;
    }
    if lookup(new)?.as_deref() != Some(v.as_str()) {
        return Err("옮긴 비밀을 다시 읽지 못했습니다".into());
    }
    forget(old);
    Ok(true)
}

/// 예전 명령(서버 기준) — 그 서버의 기본 계정 암호를 저장·바꾸기. 빈 값이면 지운다
#[tauri::command(async)]
pub fn secret_set(profile_id: i64, secret: String, store: tauri::State<'_, crate::store::Store>) -> Result<(), String> {
    let a = store.default_account(profile_id)?;
    store.account_secret_set(a.id.unwrap_or_default(), &secret)
}

#[tauri::command(async)]
pub fn secret_forget(profile_id: i64, store: tauri::State<'_, crate::store::Store>) -> Result<(), String> {
    let a = store.default_account(profile_id)?;
    store.account_secret_set(a.id.unwrap_or_default(), "")
}
