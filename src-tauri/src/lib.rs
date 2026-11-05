// 명령 오류(SshError)는 화면에 그대로 넘기는 드문 경로라 크기를 줄이지 않는다
#![allow(clippy::result_large_err)]

mod db;
mod grid;
mod importer;
mod jdbc;
mod localfs;
mod monitor;
mod pty;
mod secrets;
mod ssh;
mod store;
mod sudo;
mod sync;
mod textcodec;
mod transfer;
mod viewer;

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(pty::Ptys::default())
        .manage(grid::Grids::default())
        .manage(ssh::SshConns::default())
        .manage(transfer::Transfers::default())
        .manage(db::DbConns::default())
        .manage(viewer::Tails::default())
        .manage(sync::Watches::default())
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
            store::snippets_list,
            store::snippet_save,
            store::snippet_delete,
            store::history_add,
            store::history_list,
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
            ssh::ssh_exec,
            ssh::ssh_test,
            db::db_test,
            secrets::secret_set,
            monitor::ssh_stats,
            monitor::ssh_du,
            monitor::ssh_kill,
            localfs::local_home,
            localfs::local_list,
            localfs::local_read_text,
            localfs::local_write_text,
            localfs::local_mkdir,
            localfs::local_touch,
            localfs::local_rename,
            localfs::local_trash,
            ssh::sftp_mkdir,
            ssh::sftp_touch,
            ssh::sftp_rename,
            ssh::sftp_remove,
            transfer::transfer_start,
            sudo::sudo_check,
            importer::import_candidates,
            db::db_connect,
            db::db_disconnect,
            db::db_query,
            db::db_cancel,
            db::db_rows,
            db::db_result_close,
            db::db_export,
            db::db_tree,
            db::db_table_meta,
            db::db_apply,
            db::db_tx,
            jdbc::jdbc_status,
            jdbc::jdbc_install_java,
            jdbc::jdbc_install_driver,
            jdbc::jdbc_add_driver_file,
            importer::export_ssh_config,
            importer::export_profiles,
            importer::import_db_file,
            sudo::sudo_list,
            sudo::sudo_read_text,
            sudo::sudo_write_text,
            sudo::sudo_op,
            transfer::transfer_cancel,
            transfer::relay_start,
            sync::sync_plan,
            sync::sync_run,
            sync::sync_rsync_command,
            sync::watch_start,
            sync::watch_stop,
            viewer::sftp_read_bytes,
            viewer::local_read_bytes,
            viewer::ssh_tail_open,
            viewer::local_tail_open,
            viewer::tail_close,
            viewer::ssh_download_targz,
        ])
        .run(tauri::generate_context!())
        .expect("RuiBotte Shell 을 시작하지 못했습니다");
}
