mod grid;
mod localfs;
mod pty;
mod secrets;
mod ssh;
mod store;
mod textcodec;

use serde::Serialize;
use tauri::{Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    version: String,
    os: &'static str,
    arch: &'static str,
    data_path: String,
    portable: bool,
    /// true = OS 가 창 바탕을 흐리게 그린다(화면은 투명 바탕), false = 불투명 바탕
    os_backdrop: bool,
}

struct Backdrop(bool);

#[tauri::command]
fn app_info(app: tauri::AppHandle, store: State<'_, store::Store>, backdrop: State<'_, Backdrop>) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        data_path: store.path.to_string_lossy().into_owned(),
        portable: store.portable,
        os_backdrop: backdrop.0,
    }
}

/// 창 바탕 흐림은 OS 가 그린다(CSS blur 비용 0) — Windows 11 Mica, macOS vibrancy.
/// 지원하지 않는 OS(Windows 10 등)면 화면이 불투명 바탕으로 물러난다.
fn apply_backdrop(window: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        window_vibrancy::apply_mica(window, None).is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        apply_vibrancy(window, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::FollowsWindowActiveState), Some(12.0))
            .is_ok()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = window;
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .manage(grid::Grids::default())
        .manage(ssh::SshConns::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let (dir, portable) = store::data_dir(app_data);
            app.manage(store::Store::open(dir, portable)?);
            let glass = app.get_webview_window("main").map(|w| apply_backdrop(&w)).unwrap_or(false);
            app.manage(Backdrop(glass));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::bench_stream,
            grid::grid_demo_open,
            grid::grid_rows,
            grid::grid_close,
            store::profiles_list,
            store::profile_save,
            store::profile_delete,
            store::setting_get,
            store::setting_set,
            secrets::secret_forget,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_shell_open,
            ssh::ssh_shell_write,
            ssh::ssh_shell_resize,
            ssh::ssh_shell_close,
            ssh::sftp_list,
            ssh::sftp_read_text,
            ssh::sftp_write_text,
            ssh::sftp_realpath,
            localfs::local_home,
            localfs::local_list,
            localfs::local_read_text,
            localfs::local_write_text,
        ])
        .run(tauri::generate_context!())
        .expect("RuiBotte Shell 을 시작하지 못했습니다");
}
