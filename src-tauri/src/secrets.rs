//! 비밀 저장 — OS 자격 증명 저장소(Windows 자격 증명 관리자 · macOS 키체인).
//! 앱 DB 에는 "저장했다"는 표시만 남는다. 값은 화면으로 다시 돌려주지 않는다.

const SERVICE: &str = "RuiBotte Shell";

fn entry(key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.inner.get_password().ok()
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

#[tauri::command]
pub fn secret_forget(profile_id: i64, store: tauri::State<'_, crate::store::Store>) {
    forget(&format!("profile:{profile_id}"));
    store.mark_used(profile_id, Some(false));
}
