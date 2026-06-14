use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;

static SHOULD_EXIT: AtomicBool = AtomicBool::new(false);

// Helper to get notes path in OS-specific AppConfig directory
fn get_notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("notes.json"))
        .map_err(|e| e.to_string())
}

// Read notes from local JSON file
#[tauri::command]
fn load_notes(app: AppHandle) -> Result<String, String> {
    let path = get_notes_path(&app)?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    Ok(contents)
}

// Write notes to local JSON file
#[tauri::command]
fn save_notes(app: AppHandle, notes_json: String) -> Result<(), String> {
    let path = get_notes_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    file.write_all(notes_json.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Helper function to create a new note window
fn create_note_window_sync(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    always_on_top: Option<bool>,
) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let label = format!("note_{}", id);

        // If window already exists, show and focus it
        if let Some(window) = app_clone.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }

        let url = WebviewUrl::App("index.html".into());
        let mut builder = WebviewWindowBuilder::new(&app_clone, &label, url)
            .title("DeskTab Note")
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .min_inner_size(200.0, 150.0);

        if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        }
        if let (Some(w), Some(h)) = (w, h) {
            builder = builder.inner_size(w, h);
        }
        if let Some(pinned) = always_on_top {
            builder = builder.always_on_top(pinned);
        }

        let _window = builder.build();
    });
}

// Command exposed to the frontend to create a note window
#[tauri::command]
async fn create_note_window(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    always_on_top: Option<bool>,
) -> Result<(), String> {
    create_note_window_sync(app, id, x, y, w, h, always_on_top);
    Ok(())
}

// Helper to open Notes Hub window
fn open_notes_hub(app: AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let label = "hub";
        if let Some(window) = app_clone.get_webview_window(label) {
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }

        let url = WebviewUrl::App("index.html".into());
        let _window = WebviewWindowBuilder::new(&app_clone, label, url)
            .title("DeskTab 便签管理中心")
            .inner_size(750.0, 500.0)
            .min_inner_size(500.0, 400.0)
            .decorations(true)
            .transparent(false)
            .build();
    });
}

// Command exposed to open the Hub
#[tauri::command]
async fn open_hub(app: AppHandle) -> Result<(), String> {
    open_notes_hub(app);
    Ok(())
}

// Set Windows boot autostart in Registry
#[tauri::command]
fn set_autostart(enable: bool) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_WRITE | KEY_READ,
        )
        .map_err(|e| e.to_string())?;

    if enable {
        let exe_path = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        run_key
            .set_value("DeskTab", &exe_path)
            .map_err(|e| e.to_string())?;
    } else {
        let _ = run_key.delete_value("DeskTab");
    }

    Ok(())
}

// Get current autostart state
#[tauri::command]
fn get_autostart() -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?;

    let value: Result<String, _> = run_key.get_value("DeskTab");
    Ok(value.is_ok())
}

// Check reminders and trigger notifications
fn check_and_trigger_reminders(app: &AppHandle) -> Result<(), String> {
    let path = get_notes_path(app)?;
    if !path.exists() {
        return Ok(());
    }

    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;

    let mut notes: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    let mut changed = false;

    if let Some(notes_arr) = notes.as_array_mut() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        for note in notes_arr.iter_mut() {
            if let Some(reminder_val) = note.get("reminder") {
                let triggered = note
                    .get("reminder_triggered")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let deleted = note
                    .get("deleted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !triggered && !deleted {
                    let reminder_time = reminder_val.as_u64().or_else(|| {
                        if let Some(s) = reminder_val.as_str() {
                            s.parse::<u64>().ok()
                        } else if let Some(f) = reminder_val.as_f64() {
                            Some(f as u64)
                        } else {
                            None
                        }
                    });

                    if let Some(time) = reminder_time {
                        if now >= time {
                            let content =
                                note.get("content").and_then(|v| v.as_str()).unwrap_or("");

                            let clean_content = if content.is_empty() {
                                "您设置的便签提醒时间已到。".to_string()
                            } else if content.chars().count() > 60 {
                                format!("{}...", content.chars().take(60).collect::<String>())
                            } else {
                                content.to_string()
                            };

                            let _ = app
                                .notification()
                                .builder()
                                .title("DeskTab 便签提醒")
                                .body(clean_content)
                                .show();

                            note.as_object_mut().unwrap().insert(
                                "reminder_triggered".to_string(),
                                serde_json::Value::Bool(true),
                            );
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    if changed {
        let notes_json = serde_json::to_string(&notes).map_err(|e| e.to_string())?;
        let mut file = File::create(path).map_err(|e| e.to_string())?;
        file.write_all(notes_json.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// Spawn a background thread to check reminders every 5 seconds
fn start_reminder_checker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if let Err(e) = check_and_trigger_reminders(&app) {
            eprintln!("Error in reminder check thread: {}", e);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                for (_, window) in app_clone.webview_windows() {
                    let label = window.label();
                    if label.starts_with("note_") || label == "main" || label == "hub" {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            create_note_window,
            load_notes,
            save_notes,
            open_hub,
            set_autostart,
            get_autostart
        ])
        .setup(|app| {
            // 1. Create system tray menu items
            let open_hub_item = MenuItemBuilder::with_id("open_hub", "便签管理中心").build(app)?;
            let new_note = MenuItemBuilder::with_id("new_note", "新建便签").build(app)?;
            let show_all = MenuItemBuilder::with_id("show_all", "显示所有便签").build(app)?;
            let hide_all = MenuItemBuilder::with_id("hide_all", "隐藏所有便签").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

            // 2. Build the tray menu
            let menu = MenuBuilder::new(app)
                .item(&open_hub_item)
                .separator()
                .item(&new_note)
                .item(&show_all)
                .item(&hide_all)
                .separator()
                .item(&quit)
                .build()?;

            // 3. Create the tray icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "open_hub" => {
                        open_notes_hub(app.clone());
                    }
                    "new_note" => {
                        let id = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis().to_string())
                            .unwrap_or_else(|_| "temp".to_string());
                        create_note_window_sync(app.clone(), id, None, None, None, None, None);
                    }
                    "show_all" => {
                        for (_, window) in app.webview_windows() {
                            let label = window.label();
                            if label.starts_with("note_") || label == "main" {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "hide_all" => {
                        for (_, window) in app.webview_windows() {
                            let label = window.label();
                            if label.starts_with("note_") || label == "main" {
                                let _ = window.hide();
                            }
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // 4. Start the background reminder thread
            start_reminder_checker(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !SHOULD_EXIT.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            _ => {}
        });
}
