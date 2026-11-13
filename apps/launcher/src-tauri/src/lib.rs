//! TM Horizon native shell (Tauri 2).

/// "Launcher Preview" release (built with TMHUB_RELEASE_PREVIEW=1): nothing that needs the TM Horizon Hub or our
/// servers. Hub addresses are refused (hubindex::hub_url_ok), hub logins and requests never leave the PC, the hub
/// data refresh and the old update check are off, and only GitHub-hosted catalog downloads are installed.
/// Every host the build can contact: docs/release/outbound-hosts.md.
pub const RELEASE_PREVIEW: bool = cfg!(release_preview);

pub mod addons;
pub mod bg;
pub mod datamigrate;
pub mod clientbridge;
pub mod copies;
pub mod fileassoc;
pub mod gbxopen;
pub mod moreprojects;
pub mod clips;
pub mod classiccmds;
pub mod commands;
pub mod consoles;
pub mod discord;
pub mod features;
pub mod fsx;
pub mod gbx;
pub mod gallery;
pub mod hubindex;
pub mod hublogin;
pub mod repodoc;
pub mod gameinstall;
pub mod horizonhost;
pub mod hosting;
pub mod horizoncmds;
pub mod imgcache;
pub mod instances;
pub mod instancetml;
pub mod launch;
pub mod linuxcmds;
pub mod linuxsetup;
pub mod maps;
pub mod mapinspect;
pub mod media;
pub mod thumbs;
pub mod modindex;
pub mod lzo1x;
pub mod net;
pub mod news;
pub mod ownnews;
pub mod openplanet;
pub mod defender;
pub mod dxvk;
pub mod optimize;
pub mod perfbench;
pub mod replayarchive;
pub mod startwatch;
pub mod tipwin;
pub mod syscfg;
pub mod opsetup;
mod perf;
pub mod proxymods;
pub mod eswcmods;
pub mod catalogmods;
pub mod updates;
pub mod tmlsetup;
pub mod packs;
pub mod platform;
pub mod report;
pub mod scan;
pub mod serverquery;
pub mod settings;
pub mod skidmarks;
pub mod skins;
pub mod skinlib;
pub mod state;
pub mod steamfix;
pub mod suggest;
pub mod stats;
pub mod tas;
pub mod tmloader;
pub mod backup;
pub mod health;
pub mod history;
pub mod playtime;
pub mod tmxfolder;
pub mod tmxqueue;
pub mod tmvscontent;
pub mod tmxupload;
pub mod updater;
pub mod vdf;
pub mod web;

use tauri::{Emitter, Manager};

fn links(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| a.to_lowercase().starts_with("tmhub:")).cloned().collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Old identifier (app.tmhub.launcher) -> com.tmhorizon.launcher, before anything opens the data folders.
    let migrated = datamigrate::migrate(&datamigrate::bases(), datamigrate::OLD_ID, datamigrate::NEW_ID);
    if !migrated.is_empty() {
        datamigrate::MIGRATED.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(d) = dirs::data_local_dir() {
            let _ = std::fs::write(d.join(datamigrate::NEW_ID).join("migrated-from-tmhub.txt"), migrated.join("\n"));
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The logon task while the launcher already runs: start the servers, keep the window as it is.
            if argv.iter().any(|a| a == hosting::autostart::START_FLAG) {
                let st = app.state::<state::AppState>();
                for d in hosting::load_all(&st.data_dir).into_iter().filter(|d| d.autostart) {
                    let _ = hosting::start(&st.data_dir, &d.id);
                }
                return;
            }
            // A second start (e.g. a tmhub:// link) goes to the running window.
            let l = links(&argv);
            if !l.is_empty() {
                let _ = app.emit_to("main", "deep-link", l);
            }
            // A .Gbx double-clicked in Explorer ("Open .Gbx files with TM Horizon"): the open dialog.
            let f = fileassoc::files_in_args(&argv);
            if !f.is_empty() {
                let _ = app.emit_to("main", "open-gbx", f);
            }
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[web::LABEL]).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let p = app.path();
            // First start (no saved window state yet): about 80% of the screen's work area, at least
            // the minimum size. After that the window-state plugin restores the last size.
            if !p.app_config_dir()?.join(tauri_plugin_window_state::DEFAULT_FILENAME).exists() {
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(Some(m)) = w.current_monitor() {
                        let wa = m.work_area();
                        let sf = m.scale_factor();
                        let width = (wa.size.width as f64 * 0.8).max(1100.0 * sf).min(wa.size.width as f64);
                        let height = (wa.size.height as f64 * 0.8).max(700.0 * sf).min(wa.size.height as f64);
                        let _ = w.set_size(tauri::PhysicalSize::new(width, height));
                        let _ = w.center();
                    }
                }
            }
            let st = state::AppState::new(p.app_config_dir()?, p.app_local_data_dir()?, p.app_cache_dir()?);
            st.pending_links.lock().unwrap().extend(links(&std::env::args().collect::<Vec<_>>()));
            st.pending_files.lock().unwrap().extend(fileassoc::files_in_args(&std::env::args().collect::<Vec<_>>()));
            horizonhost::set_stats_dir(p.app_local_data_dir()?.join("host-stats"));
            hosting::init(app.handle(), &st.data_dir);
            if datamigrate::MIGRATED.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = hosting::app::apply_autostart(&st.data_dir); // the task named tm-hub.exe before
                // tmhub:// links registered by the old exe: point them at this one.
                if crate::platform::protocol_command(commands::PROTOCOL).is_some_and(|c| c.to_lowercase().contains("tm-hub.exe")) {
                    if let Ok(exe) = std::env::current_exe() {
                        let _ = crate::platform::register_protocol(commands::PROTOCOL, &exe, "TM Horizon");
                    }
                }
            }
            let autostart = std::env::args().any(|a| a == hosting::autostart::START_FLAG);
            let data_dir = st.data_dir.clone();
            app.manage(st);
            // Statistics: refresh the replay header cache in the background (low priority, after a few seconds).
            stats::cmd::start_background(app.handle());
            // Play time of every game process while the launcher runs (also games started outside it).
            playtime::start_watcher(app.handle().clone());
            // Discord: "In TM Horizon" while only the launcher is open, "Playing <game>" for a started game.
            {
                let h = app.handle().clone();
                discord::run_manager(
                    move || {
                        let st = h.state::<state::AppState>();
                        let s = st.settings();
                        discord::Cfg {
                            enabled: s.discord_presence,
                            show_tas: s.discord_tas,
                            forever_default: if st.install("tmuf").is_some() && st.install("tmnf").is_none() { "tmuf".into() } else { "tmnf".into() },
                        }
                    },
                    crate::platform::running_process_names,
                );
            }
            // Picture cache: at most 300 MB, least recently used out first (a minute after start).
            {
                let cache = app.state::<state::AppState>().cache_dir.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    imgcache::prune(&cache, imgcache::MAX_TOTAL);
                });
            }
            if autostart {
                hosting::app::start_autostart_servers(app.handle(), &data_dir);
            }
            app.manage(tmxupload::Service::with_dirs(&p.app_config_dir()?, &p.app_local_data_dir()?.join("tmx-upload")));
            tmxupload::app::start(app.handle());
            app.manage(clientbridge::app::start(app.handle(), &p.app_config_dir()?));
            Ok(())
        })
        // Closing the window while own servers run: ask first (keep running in the tray, or stop).
        .on_window_event(|window, event| {
            // The tooltip window must not keep the app alive after the main window is gone.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                if let Some(t) = window.app_handle().get_webview_window(tipwin::LABEL) {
                    let _ = t.destroy();
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && hosting::mgr().running_count() > 0 {
                    api.prevent_close();
                    let _ = window.emit("host-close-ask", hosting::mgr().running_count());
                } else if window.label() == "main" && updater::on_close(window.app_handle()) {
                    // A downloaded update installs now (automatic updates, no game running); the app exits after it.
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            classiccmds::console_status,
            classiccmds::console_emulator_install,
            classiccmds::console_emulator_pick,
            classiccmds::console_emulator_forget,
            classiccmds::console_dump_pick,
            classiccmds::console_dump_clear,
            classiccmds::console_options,
            classiccmds::console_textures_folder,
            classiccmds::steamfix_status,
            classiccmds::steamfix_apply_ini,
            classiccmds::steamfix_undo_ini,
            classiccmds::steamfix_download,
            classiccmds::steamfix_run,
            classiccmds::highlands_info,
            classiccmds::highlands_pick,
            classiccmds::highlands_check,
            classiccmds::highlands_install,
            classiccmds::suggestion_dismiss,
            classiccmds::suggestions_done,
            commands::scan,
            commands::tml_snapshot,
            commands::mod_index_cached,
            commands::mod_index_refresh,
            commands::hub_data_cached,
            commands::hub_data_refresh,
            commands::launch_game,
            commands::launch_prewarm,
            news::exchange_news_older,
            commands::set_selected_install,
            health::health_check,
            history::cmd::history_list,
            history::cmd::history_undo,
            history::cmd::history_info,
            backup::backup_plan,
            backup::backup_create,
            backup::backup_pick,
            backup::backup_restore_plan,
            backup::backup_restore,
            playtime::playtime_all,
            stats::cmd::stats_report,
            stats::cmd::stats_tmx,
            stats::cmd::stats_map_thumb,
            moreprojects::more_projects,
            fileassoc::gbx_assoc_status,
            fileassoc::gbx_assoc_set,
            gbxopen::gbx_open_info,
            gbxopen::gbx_open_in,
            gbxopen::take_pending_files,
            features::img_cache_info,
            skidmarks::skid_state,
            skidmarks::skid_set,
            skidmarks::skid_tml_install,
            skidmarks::skid_tml_remove,
            classiccmds::highlands_state,
            classiccmds::highlands_set_enabled,
            features::img_cache_clear,
            commands::launch_preview,
            commands::open_map,
            commands::open_external,
            gbx::gbx_info,
            gbx::gbx_pick,
            mapinspect::cmd::map_inspect_bytes,
            mapinspect::cmd::map_inspect_find,
            mapinspect::cmd::map_inspect_list,
            skinlib::cmd::skins_installed,
            skinlib::cmd::skins_preview,
            skinlib::cmd::skins_set_enabled,
            skinlib::cmd::skins_remove,
            commands::reveal_path,
            commands::install_mod,
            commands::set_profile_mod,
            commands::list_clips,
            media::media_list,
            media::media_delete,
            media::media_thumb,
            commands::web_show,
            commands::web_bounds,
            commands::web_hide,
            commands::web_tip_show,
            commands::web_tip_hide,
            commands::web_nav,
            commands::web_navigate,
            commands::web_clear,
            commands::save_settings,
            commands::protocol_register,
            commands::protocol_unregister,
            commands::take_pending_links,
            commands::add_folder,
            commands::open_maniaplanet,
            commands::remove_folder,
            commands::scan_drives,
            commands::cancel_drive_scan,
            commands::game_source,
            commands::game_download,
            commands::game_run_setup,
            commands::check_update,
            commands::win,
            features::report_collect,
            features::report_save,
            features::pack_encode,
            features::pack_decode,
            features::pack_check,
            features::pack_import,
            features::packs_list,
            features::pack_remove,
            features::pack_save_file,
            features::pack_open_file,
            features::profile_create,
            features::profile_delete,
            features::set_profile_mod_version,
            features::tas_info,
            features::tas_open,
            features::forevertas_start,
            features::tick_start,
            features::cached_image,
            features::open_game_folder,
            commands::cached_snapshot,
            commands::perf_log,
            commands::game_running,
            features::proxy_mods,
            features::eswc_mod_prepare,
            features::eswc_mod_apply,
            features::eswc_mod_remove,
            features::eswc_backups,
            features::eswc_restore,
            features::catalog_mod_prepare,
            features::catalog_mod_apply,
            features::catalog_mod_backups,
            features::catalog_mod_restore,
            horizoncmds::horizon_source,
            horizoncmds::horizon_updates,
            horizoncmds::horizon_source_set,
            horizoncmds::horizon_source_pick,
            horizoncmds::horizon_targets,
            horizoncmds::horizon_status,
            horizoncmds::horizon_prepare,
            horizoncmds::horizon_apply,
            horizoncmds::horizon_remove,
            horizoncmds::horizon_restore,
            horizoncmds::horizon_migrate_autosave,
            horizoncmds::horizon_plugin_install,
            horizoncmds::horizon_plugin_remove,
            horizoncmds::horizon_plugin_enable,
            horizoncmds::horizon_log,
            horizoncmds::horizon_play,
            horizoncmds::horizon_tml_status,
            horizoncmds::horizon_tml_prepare,
            horizoncmds::horizon_tml_apply,
            horizoncmds::horizon_tml_remove,
            horizoncmds::horizon_tml_set_profile,
            horizoncmds::horizon_catalog,
            instances::instance_list,
            instances::instance_check,
            instances::instance_create,
            instances::instance_duplicate,
            instances::instance_delete,
            instances::instance_usage,
            instances::instance_set_tml_profile,
            features::mod_installs,
            features::mod_updates_check,
            features::mod_set_auto,
            features::mod_update,
            features::mod_rollback,
            tmlsetup::tmloader_setup_download,
            tmlsetup::tmloader_setup_run,
            gallery::mod_gallery,
            repodoc::mod_readme,
            repodoc::mod_releases,
            features::download_targets,
            features::download_copy,
            features::site_icon,
            features::web_follow,
            features::web_check,
            addons::cmd::addons_list,
            addons::cmd::addons_prepare,
            addons::cmd::addons_apply,
            addons::cmd::addons_set_enabled,
            addons::cmd::addons_remove,
            addons::cmd::addons_check,
            features::op_catalog,
            news::exchange_news,
            features::op_installed,
            features::op_install,
            features::op_remove,
            opsetup::openplanet_status,
            opsetup::openplanet_setup_download,
            opsetup::openplanet_setup_run,
            features::tick_locate,
            features::mod_servers,
            linuxcmds::linux_info,
            linuxcmds::linux_save,
            linuxsetup::linux_setup_status,
            linuxsetup::linux_setup_start,
            linuxsetup::linux_setup_cancel,
            linuxsetup::linux_setup_options,
            linuxsetup::linux_setup_log,
            updater::update_status,
            updater::update_settings,
            updater::update_check,
            updater::update_install,
            updater::update_restart,
            updater::update_stage,
            updater::update_apply,
            ownnews::horizon_news,
            hubindex::hub_index_cached,
            hubindex::hub_index_refresh,
            hubindex::hub_tmf_servers,
            hubindex::hub_live_servers,
            hublogin::hub_login_start,
            hublogin::hub_login_cancel,
            hublogin::hub_login_status,
            hublogin::hub_logout,
            hublogin::hub_request,
            tmxupload::app::tmx_upload_status,
            tmxupload::app::tmx_upload_set,
            tmxupload::app::tmx_upload_file,
            tmxupload::app::tmx_upload_clear,
            tmxupload::app::tmx_upload_retry,
            tmxupload::app::tmx_upload_check,
            tmxupload::app::tmx_upload_pick,
            clientbridge::app::client_bridge_status,
            clientbridge::app::client_bridge_answer,
            clientbridge::app::client_bridge_forget,
            clientbridge::app::client_notify,
            serverquery::server_registry,
            serverquery::server_registry_add,
            serverquery::server_registry_set_community,
            serverquery::server_registry_remove,
            serverquery::server_registry_export,
            serverquery::server_registry_import,
            serverquery::server_registry_reset_seeds,
            serverquery::server_query_enable,
            serverquery::server_status,
            serverquery::server_status_all,
            serverquery::server_status_cached,
            tmvscontent::app::tmvs_content_state,
            tmvscontent::app::tmvs_content_index,
            tmvscontent::app::tmvs_content_install,
            tmvscontent::app::tmvs_content_remove,
            tmvscontent::app::tmvs_share_code,
            tmvscontent::app::tmvs_pick_folder,
            hosting::app::host_overview,
            hosting::app::host_new,
            hosting::app::host_save,
            hosting::app::host_delete,
            hosting::app::host_start,
            hosting::app::host_stop,
            hosting::app::host_status,
            hosting::app::host_player,
            hosting::app::host_log,
            hosting::app::host_leftover,
            hosting::app::host_set_hub,
            hosting::app::host_reach,
            hosting::app::host_firewall,
            hosting::app::host_firewall_add,
            hosting::app::host_listing_submit,
            hosting::app::host_listing_withdraw,
            hosting::app::host_local_maps,
            hosting::app::host_pick_maps,
            hosting::app::host_map_thumb,
            hosting::app::host_maps_meta,
            hosting::app::host_tmx_preview,
            hosting::app::host_tmx_add,
            hosting::app::host_discard,
            hosting::app::host_dismiss_notice,
            hosting::app::host_seen,
            hosting::app::host_console,
            hosting::app::host_console_do,
            hosting::app::host_running_count,
            hosting::app::host_close_choice,
            optimize::optimize_state,
            optimize::optimize_plan,
            optimize::optimize_apply,
            optimize::optimize_undo,
            optimize::perf_prefs,
            optimize::perf_prefs_set,
            syscfg::syscfg_state,
            syscfg::syscfg_plan,
            syscfg::syscfg_apply,
            syscfg::syscfg_undo,
            dxvk::dxvk_state,
            dxvk::dxvk_plan,
            dxvk::dxvk_on,
            dxvk::dxvk_off,
            perfbench::bench_state,
            perfbench::bench_pick_map,
            perfbench::bench_start,
            perfbench::bench_open_folder,
            replayarchive::replay_state,
            replayarchive::replay_plan,
            replayarchive::replay_archive,
            replayarchive::replay_undo,
            replayarchive::replay_search,
            replayarchive::replay_restore,
            startwatch::startwatch_state,
            startwatch::startwatch_set,
            startwatch::startwatch_open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TM Horizon");
}
