use std::{
    collections::HashMap,
    fs,
    net::TcpStream,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    thread,
};
use rusqlite::{params, Connection};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WindowEvent};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "windows")]
use std::{
    mem::size_of,
    ptr::null_mut,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use windows::{
    core::Interface,
    Win32::{
        Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, POINT, WPARAM},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            DataExchange::{CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{
            Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId},
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_C,
            },
            WindowsAndMessaging::{
                GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW, GetWindowThreadProcessId,
                SendMessageW, SetWindowLongPtrW, WindowFromPoint, GUITHREADINFO, GWL_EXSTYLE,
                WM_GETTEXT, WM_GETTEXTLENGTH, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            },
        },
    },
};

#[cfg(target_os = "windows")]
const SECRET_SERVICE: &str = "com.gloscai.lingflow";
const SECRET_FIELDS: &[&str] = &[
    "aiApiKey",
    "aiSourceApiKeys",
    "googleApiKey",
    "baiduSecretKey",
    "deeplApiKey",
    "microsoftApiKey",
    "youdaoAppSecret",
    "tencentSecretKey",
];
const DEFAULT_LOCAL_PROXY_HOST: &str = "127.0.0.1";
const DEFAULT_LOCAL_PROXY_PORT: u16 = 47631;
const LOCAL_PROXY_QUEUE_CAPACITY: usize = 128;
const LOCAL_PROXY_WORKER_COUNT: usize = 16;
#[cfg(desktop)]
const TRAY_MENU_SHOW: &str = "show-main-window";
#[cfg(desktop)]
const TRAY_MENU_QUIT: &str = "quit-app";
#[cfg(not(target_os = "windows"))]
const SECRET_DATA_PREFIX: &str = "secret:";

#[cfg(target_os = "windows")]
const CF_UNICODETEXT_FORMAT: u32 = 13;
#[cfg(target_os = "windows")]
const EM_GETSEL_MESSAGE: u32 = 0x00B0;
#[derive(Clone)]
struct LocalProxyState {
    settings: Arc<RwLock<Option<AppRuntimeSettings>>>,
    listener: Arc<Mutex<Option<ActiveLocalProxy>>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

struct ActiveLocalProxy {
    addr: String,
    server: Arc<tiny_http::Server>,
}

impl AppRuntimeSettings {
    fn local_proxy_addr(&self) -> String {
        let host = self
            .local_proxy_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_LOCAL_PROXY_HOST);
        let port = self.local_proxy_port.unwrap_or(DEFAULT_LOCAL_PROXY_PORT);
        format!("{host}:{port}")
    }
}

#[derive(Clone)]
struct SelectionCaptureState {
    #[cfg(target_os = "windows")]
    inner: Arc<Mutex<SelectionCaptureGuard>>,
    diagnostics: Arc<Mutex<SelectionDiagnostics>>,
}

#[cfg(target_os = "windows")]
struct SelectionCaptureGuard {
    last_capture: Option<Instant>,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SelectionDiagnostics {
    stage: String,
    cursor_position: Option<ScreenPoint>,
    process_name: Option<String>,
    attempts: Vec<SelectionAttempt>,
    result_length: Option<usize>,
    error: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SelectionAttempt {
    strategy: String,
    ok: bool,
    detail: String,
}

struct AppDataStoreState {
    connection: Arc<Mutex<Option<Connection>>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    release_url: String,
    release_name: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    assets: Vec<UpdateAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let proxy_state = LocalProxyState {
        settings: Arc::new(RwLock::new(None)),
        listener: Arc::new(Mutex::new(None)),
        app_handle: Arc::new(Mutex::new(None)),
    };
    let proxy_app_handle = proxy_state.app_handle.clone();
    let selection_state = SelectionCaptureState {
        #[cfg(target_os = "windows")]
        inner: Arc::new(Mutex::new(SelectionCaptureGuard { last_capture: None })),
        diagnostics: Arc::new(Mutex::new(SelectionDiagnostics::default())),
    };
    let app_data_store = AppDataStoreState {
        connection: Arc::new(Mutex::new(None)),
    };
    let app_data_connection = app_data_store.connection.clone();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .manage(proxy_state)
        .manage(selection_state)
        .manage(app_data_store)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            http_request,
            sync_local_proxy_settings,
            read_app_data,
            write_app_data,
            delete_app_data,
            read_app_secrets,
            save_app_secrets,
            delete_app_secrets,
            read_clipboard_text,
            capture_foreground_selection,
            read_foreground_selected_text,
            selection_diagnostics,
            set_overlay_no_activate,
            foreground_process_name,
            check_for_updates,
            open_external_url
        ])
        .setup(move |app| {
            let connection = open_app_data_store(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(std::io::ErrorKind::Other, error))
            })?;
            if let Ok(mut current_connection) = app_data_connection.lock() {
                *current_connection = Some(connection);
            }
            if let Ok(mut current_app_handle) = proxy_app_handle.lock() {
                *current_app_handle = Some(app.handle().clone());
            }
            if cfg!(not(any(target_os = "android", target_os = "ios"))) {
                if let Err(error) = center_main_window_at_screen_ratio(app.handle(), 0.6) {
                    log::warn!("failed to size LingFlow main window: {error}");
                }
                #[cfg(desktop)]
                if let Err(error) = setup_system_tray(app.handle()) {
                    log::warn!("failed to setup LingFlow tray icon: {error}");
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray_enabled(window.app_handle()) {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        log::warn!("failed to hide LingFlow main window: {error}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn setup_system_tray(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app_handle, TRAY_MENU_SHOW, "显示灵流", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app_handle, TRAY_MENU_QUIT, "退出灵流", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app_handle, &[&show, &quit]).map_err(|error| error.to_string())?;

    let mut builder = TrayIconBuilder::with_id("lingflow-main")
        .tooltip("灵流")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => restore_main_window(app),
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                restore_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app_handle.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app_handle).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(desktop)]
fn restore_main_window(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.show() {
        log::warn!("failed to show LingFlow main window: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("failed to focus LingFlow main window: {error}");
    }
}

fn close_to_tray_enabled(app_handle: &tauri::AppHandle) -> bool {
    let state = app_handle.state::<LocalProxyState>();
    state
        .settings
        .read()
        .ok()
        .and_then(|settings| settings.as_ref().and_then(|settings| settings.close_to_tray))
        .unwrap_or(false)
}

fn center_main_window_at_screen_ratio(app_handle: &tauri::AppHandle, ratio: f64) -> Result<(), String> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(());
    };
    let Some(monitor) = window.current_monitor().map_err(|error| error.to_string())? else {
        return Ok(());
    };

    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let ratio = ratio.clamp(0.2, 1.0);
    let width = ((monitor_size.width as f64) * ratio).round() as u32;
    let height = ((monitor_size.height as f64) * ratio).round() as u32;
    let x = monitor_position.x + ((monitor_size.width.saturating_sub(width) / 2) as i32);
    let y = monitor_position.y + ((monitor_size.height.saturating_sub(height) / 2) as i32);

    window
        .set_size(Size::Physical(PhysicalSize { width, height }))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition { x, y }))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest_parts = parse_version_parts(latest);
    let current_parts = parse_version_parts(current);
    for index in 0..latest_parts.len().max(current_parts.len()) {
        let latest_part = *latest_parts.get(index).unwrap_or(&0);
        let current_part = *current_parts.get(index).unwrap_or(&0);
        if latest_part > current_part {
            return true;
        }
        if latest_part < current_part {
            return false;
        }
    }
    false
}

fn parse_version_parts(value: &str) -> Vec<u64> {
    value
        .split(['.', '-', '+'])
        .map(|part| {
            part.chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
        })
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        read_clipboard_text_native()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Clipboard reading is only available on the Windows desktop client".to_string())
    }
}

#[tauri::command]
fn foreground_process_name() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        foreground_process_name_inner()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Foreground process detection is only available on the Windows desktop client".to_string())
    }
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    let release = reqwest::Client::new()
        .get("https://api.github.com/repos/glosc-ai/LingFlow/releases/latest")
        .header("User-Agent", "LingFlow")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !release.status().is_success() {
        return Err(format!("GitHub Releases request failed with HTTP {}", release.status()));
    }

    let release_text = release.text().await.map_err(|error| error.to_string())?;
    let release = serde_json::from_str::<GitHubRelease>(&release_text).map_err(|error| error.to_string())?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let has_update = is_newer_version(&latest_version, &current_version);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        release_url: release.html_url,
        release_name: release.name,
        published_at: release.published_at,
        body: release.body,
        assets: release
            .assets
            .into_iter()
            .map(|asset| UpdateAsset {
                name: asset.name,
                browser_download_url: asset.browser_download_url,
                size: asset.size,
            })
            .collect(),
    })
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http and https URLs can be opened".to_string());
    }

    app.opener()
        .open_url(trimmed.to_string(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn capture_foreground_selection(
    state: tauri::State<'_, SelectionCaptureState>,
    cursor_position: Option<ScreenPoint>,
    clipboard_fallback_enabled: Option<bool>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let inner = state.inner.clone();
        let diagnostics = state.diagnostics.clone();
        tauri::async_runtime::spawn_blocking(move || {
            capture_foreground_selection_with_state(
                inner,
                diagnostics,
                cursor_position,
                clipboard_fallback_enabled.unwrap_or(false),
            )
        })
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, cursor_position, clipboard_fallback_enabled);
        Err("Global selection translation is not available on Android or other non-Windows clients".to_string())
    }
}

#[tauri::command]
async fn read_foreground_selected_text(
    state: tauri::State<'_, SelectionCaptureState>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        capture_foreground_selection(state, None, Some(false)).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("Foreground selection reading is only available on the Windows desktop client".to_string())
    }
}

#[tauri::command]
fn selection_diagnostics(state: tauri::State<SelectionCaptureState>) -> Result<SelectionDiagnostics, String> {
    state
        .diagnostics
        .lock()
        .map(|diagnostics| diagnostics.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_overlay_no_activate(app: tauri::AppHandle, label: String, enabled: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("Window {label} not found"))?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let hwnd = HWND(hwnd.0);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let no_activate = enabled.unwrap_or(true);
            let next_style = if no_activate {
                style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize
            } else {
                (style & !(WS_EX_NOACTIVATE.0 as isize)) | WS_EX_TOOLWINDOW.0 as isize
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_style);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, label, enabled);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn capture_foreground_selection_with_state(
    inner: Arc<Mutex<SelectionCaptureGuard>>,
    diagnostics: Arc<Mutex<SelectionDiagnostics>>,
    cursor_position: Option<ScreenPoint>,
    allow_safe_copy: bool,
) -> Result<String, String> {
    write_selection_diagnostics(&diagnostics, SelectionDiagnostics {
        stage: "started".to_string(),
        cursor_position,
        ..Default::default()
    });
    {
        let mut guard = inner
            .try_lock()
            .map_err(|_| {
                let error = "Selection capture is already running".to_string();
                write_selection_diagnostics(&diagnostics, SelectionDiagnostics {
                    stage: "busy".to_string(),
                    cursor_position,
                    error: Some(error.clone()),
                    ..Default::default()
                });
                error
            })?;
        if guard
            .last_capture
            .is_some_and(|last_capture| last_capture.elapsed() < Duration::from_millis(350))
        {
            let error = "Selection capture debounced".to_string();
            write_selection_diagnostics(&diagnostics, SelectionDiagnostics {
                stage: "debounced".to_string(),
                cursor_position,
                error: Some(error.clone()),
                ..Default::default()
            });
            return Err(error);
        }
        guard.last_capture = Some(Instant::now());
    }

    thread::sleep(Duration::from_millis(50));

    let result = capture_foreground_selection_inner(
        &diagnostics,
        cursor_position,
        allow_safe_copy,
    );
    if let Err(error) = &result {
        update_selection_diagnostics(&diagnostics, |current| {
            current.stage = "failed".to_string();
            current.error = Some(error.clone());
        });
    }
    result
}

#[cfg(target_os = "windows")]
fn capture_foreground_selection_inner(
    diagnostics: &Arc<Mutex<SelectionDiagnostics>>,
    cursor_position: Option<ScreenPoint>,
    allow_safe_copy: bool,
) -> Result<String, String> {
    let process_name = foreground_process_name_inner()?;
    update_selection_diagnostics(diagnostics, |current| {
        current.stage = "process-resolved".to_string();
        current.cursor_position = cursor_position;
        current.process_name = Some(process_name.clone());
    });

    match selected_text_from_uia(cursor_position, allow_safe_copy) {
        Ok(text) if !text.is_empty() => {
            push_selection_attempt(diagnostics, "uia", true, format!("{} chars", text.len()));
            update_selection_diagnostics(diagnostics, |current| {
                current.stage = "success".to_string();
                current.result_length = Some(text.len());
            });
            return Ok(text);
        }
        Ok(_) => push_selection_attempt(diagnostics, "uia", false, "UIA returned empty text"),
        Err(error) => push_selection_attempt(diagnostics, "uia", false, error),
    }

    update_selection_diagnostics(diagnostics, |current| {
        current.stage = "empty".to_string();
        current.result_length = Some(0);
        current.error = None;
    });
    Ok(String::new())
}

#[cfg(target_os = "windows")]
fn write_selection_diagnostics(diagnostics: &Arc<Mutex<SelectionDiagnostics>>, next: SelectionDiagnostics) {
    if let Ok(mut current) = diagnostics.lock() {
        *current = next;
    }
}

#[cfg(target_os = "windows")]
fn update_selection_diagnostics(
    diagnostics: &Arc<Mutex<SelectionDiagnostics>>,
    update: impl FnOnce(&mut SelectionDiagnostics),
) {
    if let Ok(mut current) = diagnostics.lock() {
        update(&mut current);
    }
}

#[cfg(target_os = "windows")]
fn push_selection_attempt(
    diagnostics: &Arc<Mutex<SelectionDiagnostics>>,
    strategy: impl Into<String>,
    ok: bool,
    detail: impl Into<String>,
) {
    update_selection_diagnostics(diagnostics, |current| {
        current.attempts.push(SelectionAttempt {
            strategy: strategy.into(),
            ok,
            detail: detail.into(),
        });
    });
}

#[cfg(target_os = "windows")]
fn normalize_selected_text(value: String) -> Result<String, String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        Err("No selected text was found in the foreground window".to_string())
    } else {
        Ok(normalized)
    }
}

#[cfg(target_os = "windows")]
fn foreground_process_name_inner() -> Result<String, String> {
    let hwnd = foreground_window()?;
    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return Err("Could not resolve foreground process id".to_string());
    }

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(|error| error.message().to_string())?;
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .map_err(|error| {
            let _ = CloseHandle(process);
            error.message().to_string()
        })?;
        CloseHandle(process).map_err(|error| error.message().to_string())?;
    }

    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    let process_name = path
        .rsplit(['\\', '/'])
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&path);
    Ok(process_name.to_string())
}

#[cfg(target_os = "windows")]
fn foreground_window() -> Result<HWND, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        Err("No foreground window".to_string())
    } else {
        Ok(hwnd)
    }
}

#[cfg(target_os = "windows")]
fn focused_control_window() -> Result<HWND, String> {
    let foreground = foreground_window()?;
    let thread_id = unsafe { GetWindowThreadProcessId(foreground, None) };
    if thread_id == 0 {
        return Ok(foreground);
    }

    let mut gui_thread_info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetGUIThreadInfo(thread_id, &mut gui_thread_info).is_ok() };
    if ok && !gui_thread_info.hwndFocus.0.is_null() {
        Ok(gui_thread_info.hwndFocus)
    } else {
        Ok(foreground)
    }
}

#[cfg(target_os = "windows")]
fn selected_text_from_uia(cursor_position: Option<ScreenPoint>, allow_safe_copy: bool) -> Result<String, String> {
    let _com = ComApartment::init()?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| error.message().to_string())?;
    let mut errors = Vec::<String>::new();

    if let Some(point) = cursor_position {
        let point = POINT { x: point.x, y: point.y };
        match unsafe { automation.ElementFromPoint(point) } {
            Ok(element) => match selected_text_from_uia_element(&element) {
                Ok(text) if !text.is_empty() => return Ok(text),
                Ok(_) => errors.push("point-element: empty selected text".to_string()),
                Err(error) => errors.push(format!("point-element: {error}")),
            },
            Err(error) => errors.push(format!("point-element lookup: {}", error.message())),
        }

        let point_hwnd = unsafe { WindowFromPoint(point) };
        if point_hwnd.0.is_null() {
            errors.push("point-window: WindowFromPoint returned null".to_string());
        } else {
            match unsafe { automation.ElementFromHandle(point_hwnd) } {
                Ok(element) => match selected_text_from_uia_element(&element) {
                    Ok(text) if !text.is_empty() => return Ok(text),
                    Ok(_) => errors.push("point-window: empty selected text".to_string()),
                    Err(error) => errors.push(format!("point-window: {error}")),
                },
                Err(error) => errors.push(format!("point-window lookup: {}", error.message())),
            }
        }
    }

    match unsafe { automation.GetFocusedElement() } {
        Ok(element) => match selected_text_from_uia_element(&element) {
            Ok(text) if !text.is_empty() => return Ok(text),
            Ok(_) => errors.push("uia-focused-element: empty selected text".to_string()),
            Err(error) => errors.push(format!("uia-focused-element: {error}")),
        },
        Err(error) => errors.push(format!("uia-focused-element lookup: {}", error.message())),
    }

    match focused_control_window() {
        Ok(hwnd) => match unsafe { automation.ElementFromHandle(hwnd) } {
            Ok(element) => match selected_text_from_uia_element(&element) {
                Ok(text) if !text.is_empty() => return Ok(text),
                Ok(_) => errors.push("focused-control: empty selected text".to_string()),
                Err(error) => errors.push(format!("focused-control: {error}")),
            },
            Err(error) => errors.push(format!("focused-control lookup: {}", error.message())),
        },
        Err(error) => errors.push(format!("focused-control hwnd: {error}")),
    }

    match foreground_window() {
        Ok(hwnd) => match unsafe { automation.ElementFromHandle(hwnd) } {
            Ok(element) => match selected_text_from_uia_element(&element) {
                Ok(text) if !text.is_empty() => return Ok(text),
                Ok(_) => errors.push("foreground-window: empty selected text".to_string()),
                Err(error) => errors.push(format!("foreground-window: {error}")),
            },
            Err(error) => errors.push(format!("foreground-window lookup: {}", error.message())),
        },
        Err(error) => errors.push(format!("foreground-window hwnd: {error}")),
    }

    match selected_text_from_standard_edit_selection() {
        Ok(text) if !text.is_empty() => return Ok(text),
        Ok(_) => {
            errors.push("standard-edit-selection: empty selected text".to_string());
        }
        Err(error) => {
            errors.push(format!("standard-edit-selection: {error}"));
        }
    };

    if allow_safe_copy {
        match selected_text_via_safe_copy() {
            Ok(text) if !text.is_empty() => Ok(text),
            Ok(_) => {
                errors.push("safe-copy: empty selected text".to_string());
                Err(errors.join(" | "))
            }
            Err(error) => {
                errors.push(format!("safe-copy: {error}"));
                Err(errors.join(" | "))
            }
        }
    } else {
        errors.push("safe-copy: skipped until the selection icon is clicked".to_string());
        Err(errors.join(" | "))
    }
}

#[cfg(target_os = "windows")]
fn selected_text_from_uia_element(element: &windows::Win32::UI::Accessibility::IUIAutomationElement) -> Result<String, String> {
    let pattern = unsafe { element.GetCurrentPattern(UIA_TextPatternId) }
        .map_err(|error| error.message().to_string())?;
    let text_pattern: IUIAutomationTextPattern =
        pattern.cast().map_err(|error| error.message().to_string())?;
    let ranges = unsafe { text_pattern.GetSelection() }.map_err(|error| error.message().to_string())?;
    let length = unsafe { ranges.Length() }.map_err(|error| error.message().to_string())?;
    let mut selected = String::new();

    for index in 0..length {
        let range = unsafe { ranges.GetElement(index) }.map_err(|error| error.message().to_string())?;
        let text = unsafe { range.GetText(-1) }.map_err(|error| error.message().to_string())?;
        selected.push_str(&text.to_string());
    }

    normalize_selected_text(selected)
}

#[cfg(target_os = "windows")]
fn selected_text_from_standard_edit_selection() -> Result<String, String> {
    let hwnd = focused_control_window()?;
    let mut selection_start = 0u32;
    let mut selection_end = 0u32;

    unsafe {
        SendMessageW(
            hwnd,
            EM_GETSEL_MESSAGE,
            Some(WPARAM((&mut selection_start as *mut u32) as usize)),
            Some(LPARAM((&mut selection_end as *mut u32) as isize)),
        );
    }

    if selection_start == selection_end {
        return Err("Standard edit control has no active selection".to_string());
    }

    if selection_start > selection_end {
        std::mem::swap(&mut selection_start, &mut selection_end);
    }

    let text_length = unsafe {
        SendMessageW(hwnd, WM_GETTEXTLENGTH, Some(WPARAM(0)), Some(LPARAM(0))).0 as usize
    };
    if text_length == 0 {
        return Err("Standard edit control has no text".to_string());
    }

    let mut buffer = vec![0u16; text_length + 1];
    unsafe {
        SendMessageW(
            hwnd,
            WM_GETTEXT,
            Some(WPARAM(buffer.len())),
            Some(LPARAM(buffer.as_mut_ptr() as isize)),
        );
    }

    let text = String::from_utf16_lossy(&buffer[..text_length]);
    let utf16 = text.encode_utf16().collect::<Vec<u16>>();
    let start = selection_start as usize;
    let end = selection_end as usize;
    if start >= end || end > utf16.len() {
        return Err("Standard edit selection range is invalid".to_string());
    }

    normalize_selected_text(String::from_utf16_lossy(&utf16[start..end]))
}

#[cfg(target_os = "windows")]
fn selected_text_via_safe_copy() -> Result<String, String> {
    let _restore = ClipboardRestoreGuard::capture()?;
    clear_clipboard_native()?;
    send_copy_shortcut_native()?;
    thread::sleep(Duration::from_millis(30));
    normalize_selected_text(read_clipboard_text_native().unwrap_or_default())
}

#[cfg(target_os = "windows")]
fn clear_clipboard_native() -> Result<(), String> {
    let _clipboard = ClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| error.message().to_string())
}

#[cfg(target_os = "windows")]
fn send_copy_shortcut_native() -> Result<(), String> {
    let inputs = [
        keyboard_input(VK_CONTROL.0 as u16, false),
        keyboard_input(VK_C.0 as u16, false),
        keyboard_input(VK_C.0 as u16, true),
        keyboard_input(VK_CONTROL.0 as u16, true),
    ];
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err("Failed to send Ctrl+C safe copy fallback".to_string())
    }
}

#[cfg(target_os = "windows")]
fn keyboard_input(vk: u16, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if key_up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
struct ClipboardRestoreGuard {
    backup: Vec<ClipboardBackupItem>,
}

#[cfg(target_os = "windows")]
struct ClipboardBackupItem {
    format: u32,
    bytes: Vec<u8>,
}

#[cfg(target_os = "windows")]
impl ClipboardRestoreGuard {
    fn capture() -> Result<Self, String> {
        Ok(Self {
            backup: backup_clipboard_native()?,
        })
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardRestoreGuard {
    fn drop(&mut self) {
        if let Err(error) = restore_clipboard_native(&self.backup) {
            log::warn!("failed to restore clipboard after safe copy fallback: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
fn backup_clipboard_native() -> Result<Vec<ClipboardBackupItem>, String> {
    let _clipboard = ClipboardSession::open()?;
    let mut backup = Vec::new();
    let mut format = 0u32;

    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }

        let handle = unsafe { GetClipboardData(format) }
            .map_err(|error| error.message().to_string())?;
        if handle.0.is_null() {
            continue;
        }

        let global = HGLOBAL(handle.0);
        let byte_len = unsafe { GlobalSize(global) };
        if byte_len == 0 {
            return Err(format!("Clipboard format {format} cannot be safely backed up"));
        }

        let ptr = unsafe { GlobalLock(global) } as *const u8;
        if ptr.is_null() {
            return Err(format!("Failed to lock clipboard format {format}"));
        }

        let bytes = unsafe { std::slice::from_raw_parts(ptr, byte_len) }.to_vec();
        unsafe {
            let _ = GlobalUnlock(global);
        }
        backup.push(ClipboardBackupItem { format, bytes });
    }

    Ok(backup)
}

#[cfg(target_os = "windows")]
fn restore_clipboard_native(backup: &[ClipboardBackupItem]) -> Result<(), String> {
    let _clipboard = ClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| error.message().to_string())?;

    for item in backup {
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, item.bytes.len()) }
            .map_err(|error| error.message().to_string())?;
        let ptr = unsafe { GlobalLock(handle) } as *mut u8;
        if ptr.is_null() {
            unsafe {
                let _ = GlobalFree(Some(handle));
            }
            return Err(format!("Failed to lock clipboard restore allocation for format {}", item.format));
        }

        unsafe {
            ptr.copy_from_nonoverlapping(item.bytes.as_ptr(), item.bytes.len());
            let _ = GlobalUnlock(handle);
        }

        if let Err(error) = unsafe { SetClipboardData(item.format, Some(HANDLE(handle.0))) } {
            unsafe {
                let _ = GlobalFree(Some(handle));
            }
            return Err(format!("Failed to restore clipboard format {}: {}", item.format, error.message()));
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_clipboard_text_native() -> Result<String, String> {
    let _clipboard = ClipboardSession::open()?;
    let available = unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT_FORMAT).is_ok() };
    if !available {
        return Ok(String::new());
    }

    let handle = unsafe { GetClipboardData(CF_UNICODETEXT_FORMAT) }
        .map_err(|error| error.message().to_string())?;
    if handle.0.is_null() {
        return Ok(String::new());
    }
    let global = HGLOBAL(handle.0);

    let ptr = unsafe { GlobalLock(global) } as *const u16;
    if ptr.is_null() {
        return Err("Failed to lock clipboard text".to_string());
    }

    let byte_len = unsafe { GlobalSize(global) };
    let char_len = byte_len / size_of::<u16>();
    let slice = unsafe { std::slice::from_raw_parts(ptr, char_len) };
    let nul_pos = slice.iter().position(|value| *value == 0).unwrap_or(slice.len());
    let text = String::from_utf16_lossy(&slice[..nul_pos]);
    unsafe {
        let _ = GlobalUnlock(global);
    }
    Ok(text)
}

#[cfg(target_os = "windows")]
struct ClipboardSession;

#[cfg(target_os = "windows")]
impl ClipboardSession {
    fn open() -> Result<Self, String> {
        unsafe { OpenClipboard(Some(HWND(null_mut()))) }
            .map(|_| ClipboardSession)
            .map_err(|error| error.message().to_string())
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardSession {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

#[cfg(target_os = "windows")]
struct ComApartment;

#[cfg(target_os = "windows")]
impl ComApartment {
    fn init() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .map(|| ComApartment)
            .map_err(|error| error.message().to_string())
    }
}

#[cfg(target_os = "windows")]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

#[derive(serde::Deserialize)]
struct HttpRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct HttpResponse {
    status: u16,
    body: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderUsageReport {
    provider: String,
    characters: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExternalSelectionReport {
    text: String,
    x: f64,
    y: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct ScreenPoint {
    x: i32,
    y: i32,
}


#[tauri::command]
async fn http_request(request: HttpRequest) -> Result<HttpResponse, String> {
    http_request_inner(request).await
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeSettings {
    provider: Option<String>,
    target_language: Option<String>,
    source_language: Option<String>,
    local_proxy_host: Option<String>,
    local_proxy_port: Option<u16>,
    close_to_tray: Option<bool>,
    ai_fallback_enabled: Option<bool>,
    ai_sources: Option<Vec<AiServiceSource>>,
    ai_base_url: Option<String>,
    ai_model: Option<String>,
    ai_api_key: Option<String>,
    google_api_key: Option<String>,
    baidu_app_id: Option<String>,
    baidu_secret_key: Option<String>,
    deepl_api_key: Option<String>,
    deepl_api_type: Option<String>,
    microsoft_api_key: Option<String>,
    microsoft_region: Option<String>,
    microsoft_endpoint: Option<String>,
    youdao_app_key: Option<String>,
    youdao_app_secret: Option<String>,
    tencent_secret_id: Option<String>,
    tencent_secret_key: Option<String>,
    tencent_region: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AiServiceSource {
    id: String,
    name: String,
    base_url: String,
    api_key: String,
    models: Vec<String>,
    enabled: Option<bool>,
}

#[tauri::command]
fn sync_local_proxy_settings(
    state: tauri::State<LocalProxyState>,
    settings: AppRuntimeSettings,
) -> Result<(), String> {
    let proxy_addr = settings.local_proxy_addr();
    let mut current = state.settings.write().map_err(|error| error.to_string())?;
    *current = Some(settings);
    drop(current);

    start_local_proxy(state.inner().clone(), proxy_addr)?;
    Ok(())
}


fn app_data_store_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    Ok(app_data_dir.join("lingflow.sqlite"))
}

fn open_app_data_store(app_handle: &tauri::AppHandle) -> Result<Connection, String> {
    let database_path = app_data_store_path(app_handle)?;
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS app_data (
             key TEXT PRIMARY KEY NOT NULL,
             value TEXT NOT NULL,
             updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

#[tauri::command]
fn read_app_data(state: tauri::State<AppDataStoreState>, key: String) -> Result<Option<String>, String> {
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    let mut statement = connection
        .prepare("SELECT value FROM app_data WHERE key = ?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query(params![key]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => row.get::<_, String>(0).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
fn write_app_data(state: tauri::State<AppDataStoreState>, key: String, value: String) -> Result<(), String> {
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    connection
        .execute(
            "INSERT INTO app_data (key, value, updated_at) VALUES (?1, ?2, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_app_data(state: tauri::State<AppDataStoreState>, key: String) -> Result<(), String> {
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    connection
        .execute("DELETE FROM app_data WHERE key = ?1", params![key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppSecrets {
    ai_api_key: Option<String>,
    ai_source_api_keys: Option<HashMap<String, String>>,
    google_api_key: Option<String>,
    baidu_secret_key: Option<String>,
    deepl_api_key: Option<String>,
    microsoft_api_key: Option<String>,
    youdao_app_secret: Option<String>,
    tencent_secret_key: Option<String>,
}

#[tauri::command]
fn read_app_secrets(state: tauri::State<AppDataStoreState>) -> Result<AppSecrets, String> {
    Ok(AppSecrets {
        ai_api_key: read_secret(state.inner(), "aiApiKey")?,
        ai_source_api_keys: read_json_secret(state.inner(), "aiSourceApiKeys")?,
        google_api_key: read_secret(state.inner(), "googleApiKey")?,
        baidu_secret_key: read_secret(state.inner(), "baiduSecretKey")?,
        deepl_api_key: read_secret(state.inner(), "deeplApiKey")?,
        microsoft_api_key: read_secret(state.inner(), "microsoftApiKey")?,
        youdao_app_secret: read_secret(state.inner(), "youdaoAppSecret")?,
        tencent_secret_key: read_secret(state.inner(), "tencentSecretKey")?,
    })
}

#[tauri::command]
fn save_app_secrets(state: tauri::State<AppDataStoreState>, secrets: AppSecrets) -> Result<(), String> {
    write_secret(state.inner(), "aiApiKey", secrets.ai_api_key)?;
    write_json_secret(state.inner(), "aiSourceApiKeys", secrets.ai_source_api_keys)?;
    write_secret(state.inner(), "googleApiKey", secrets.google_api_key)?;
    write_secret(state.inner(), "baiduSecretKey", secrets.baidu_secret_key)?;
    write_secret(state.inner(), "deeplApiKey", secrets.deepl_api_key)?;
    write_secret(state.inner(), "microsoftApiKey", secrets.microsoft_api_key)?;
    write_secret(state.inner(), "youdaoAppSecret", secrets.youdao_app_secret)?;
    write_secret(state.inner(), "tencentSecretKey", secrets.tencent_secret_key)?;
    Ok(())
}

#[tauri::command]
fn delete_app_secrets(state: tauri::State<AppDataStoreState>) -> Result<(), String> {
    for field in SECRET_FIELDS {
        delete_secret(state.inner(), field)?;
    }
    Ok(())
}

fn read_secret(state: &AppDataStoreState, name: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = state;
        let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        read_secret_from_app_data(state, name)
    }
}

fn write_secret(state: &AppDataStoreState, name: &str, value: Option<String>) -> Result<(), String> {
    let normalized = value.unwrap_or_default();
    if normalized.trim().is_empty() {
        return delete_secret(state, name);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = state;
        let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
        entry
            .set_password(&normalized)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        write_secret_to_app_data(state, name, &normalized)
    }
}

fn read_json_secret<T: serde::de::DeserializeOwned>(state: &AppDataStoreState, name: &str) -> Result<Option<T>, String> {
    match read_secret(state, name)? {
        Some(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

fn write_json_secret<T: serde::Serialize>(state: &AppDataStoreState, name: &str, value: Option<T>) -> Result<(), String> {
    match value {
        Some(value) => {
            let serialized = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            write_secret(state, name, Some(serialized))
        }
        None => delete_secret(state, name),
    }
}

fn delete_secret(state: &AppDataStoreState, name: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = state;
        let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        delete_secret_from_app_data(state, name)
    }
}

#[cfg(not(target_os = "windows"))]
fn secret_data_key(name: &str) -> String {
    format!("{SECRET_DATA_PREFIX}{name}")
}

#[cfg(not(target_os = "windows"))]
fn read_secret_from_app_data(state: &AppDataStoreState, name: &str) -> Result<Option<String>, String> {
    let key = secret_data_key(name);
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    let mut statement = connection
        .prepare("SELECT value FROM app_data WHERE key = ?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query(params![key]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => row.get::<_, String>(0).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

#[cfg(not(target_os = "windows"))]
fn write_secret_to_app_data(state: &AppDataStoreState, name: &str, value: &str) -> Result<(), String> {
    let key = secret_data_key(name);
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    connection
        .execute(
            "INSERT INTO app_data (key, value, updated_at) VALUES (?1, ?2, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn delete_secret_from_app_data(state: &AppDataStoreState, name: &str) -> Result<(), String> {
    let key = secret_data_key(name);
    let guard = state.connection.lock().map_err(|error| error.to_string())?;
    let connection = guard.as_ref().ok_or_else(|| "LingFlow app data store is not ready".to_string())?;
    connection
        .execute("DELETE FROM app_data WHERE key = ?1", params![key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn start_local_proxy(state: LocalProxyState, addr: String) -> Result<(), String> {
    let mut active = state.listener.lock().map_err(|error| error.to_string())?;
    if active
        .as_ref()
        .is_some_and(|listener| listener.addr == addr)
    {
        return Ok(());
    }

    let mut previous = active.take();
    let server = match tiny_http::Server::http(&addr) {
        Ok(server) => Arc::new(server),
        Err(initial_error)
            if previous.as_ref().is_some_and(|listener| {
                local_proxy_port(&listener.addr) == local_proxy_port(&addr)
            }) =>
        {
            let previous_addr = previous.as_ref().map(|listener| listener.addr.clone());
            if let Some(listener) = previous.take() {
                stop_local_proxy(listener);
            }

            match bind_local_proxy_with_retry(&addr) {
                Ok(server) => server,
                Err(error) => {
                    if let Some(previous_addr) = previous_addr {
                        if let Ok(restored) = bind_local_proxy_with_retry(&previous_addr) {
                            spawn_local_proxy_server(
                                state.clone(),
                                previous_addr.clone(),
                                restored.clone(),
                            );
                            *active = Some(ActiveLocalProxy {
                                addr: previous_addr,
                                server: restored,
                            });
                        }
                    }
                    return Err(format!(
                        "failed to switch LingFlow local proxy to {addr}: {initial_error}; retry failed: {error}"
                    ));
                }
            }
        }
        Err(error) => {
            *active = previous;
            return Err(format!(
                "failed to start LingFlow local proxy on {addr}: {error}"
            ));
        }
    };

    if let Some(listener) = previous.take() {
        stop_local_proxy(listener);
    }
    spawn_local_proxy_server(state.clone(), addr.clone(), server.clone());
    *active = Some(ActiveLocalProxy { addr, server });
    Ok(())
}

fn local_proxy_port(addr: &str) -> Option<&str> {
    addr.rsplit_once(':').map(|(_, port)| port)
}

fn stop_local_proxy(listener: ActiveLocalProxy) {
    listener.server.unblock();
    for _ in 0..20 {
        if Arc::strong_count(&listener.server) <= 1 {
            break;
        }
        thread::sleep(std::time::Duration::from_millis(5));
    }

    let wildcard_port = listener
        .addr
        .strip_prefix("0.0.0.0:")
        .and_then(|port| port.parse::<u16>().ok());
    drop(listener);

    if let Some(port) = wildcard_port {
        // 避免新建的 127.0.0.1 监听抢走唤醒连接，确保旧通配 accept 循环退出。
        let _ = TcpStream::connect(("127.0.0.2", port));
    }
}

fn bind_local_proxy_with_retry(addr: &str) -> Result<Arc<tiny_http::Server>, String> {
    let mut last_error = None;
    for _ in 0..20 {
        match tiny_http::Server::http(addr) {
            Ok(server) => return Ok(Arc::new(server)),
            Err(error) => last_error = Some(error.to_string()),
        }
        thread::sleep(std::time::Duration::from_millis(25));
    }
    Err(last_error.unwrap_or_else(|| "unknown bind error".to_string()))
}

fn spawn_local_proxy_server(state: LocalProxyState, addr: String, server: Arc<tiny_http::Server>) {
    thread::spawn(move || {
        log::info!("LingFlow local proxy listening on http://{addr}");

        let (request_sender, request_receiver) =
            std::sync::mpsc::sync_channel::<tiny_http::Request>(LOCAL_PROXY_QUEUE_CAPACITY);
        let request_receiver = Arc::new(Mutex::new(request_receiver));
        for _ in 0..LOCAL_PROXY_WORKER_COUNT {
            let worker_receiver = request_receiver.clone();
            let worker_state = state.clone();
            thread::spawn(move || loop {
                let request = match worker_receiver.lock() {
                    Ok(receiver) => match receiver.recv() {
                        Ok(request) => request,
                        Err(_) => break,
                    },
                    Err(_) => break,
                };
                handle_local_proxy_request(request, &worker_state);
            });
        }

        for request in server.incoming_requests() {
            if request_sender.send(request).is_err() {
                break;
            }
        }
        log::info!("LingFlow local proxy stopped listening on http://{addr}");
    });
}

fn handle_local_proxy_request(mut request: tiny_http::Request, state: &LocalProxyState) {
    let origin = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Origin"))
        .map(|header| header.value.as_str().to_string());

    if request.method() == &tiny_http::Method::Options {
        respond_text(request, 204, "", origin.as_deref());
        return;
    }

    if !is_allowed_proxy_origin(origin.as_deref()) {
        respond_json(
            request,
            403,
            &serde_json::json!({
              "error": "LingFlow local proxy only accepts browser extension requests"
            }),
            origin.as_deref(),
        );
        return;
    }

    let path = request.url().split('?').next().unwrap_or("/");
    match (request.method(), path) {
        (&tiny_http::Method::Get, "/health") => {
            respond_json(
                request,
                200,
                &serde_json::json!({
                  "ok": true,
                  "service": "LingFlow local proxy"
                }),
                origin.as_deref(),
            );
        }
        (&tiny_http::Method::Get, "/settings") => {
            let settings = match state.settings.read() {
                Ok(current) => current.clone(),
                Err(error) => {
                    respond_json(
                        request,
                        500,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            match settings {
                Some(settings) => respond_json(request, 200, &settings, origin.as_deref()),
                None => respond_json(
                    request,
                    503,
                    &serde_json::json!({
                      "error": "LingFlow desktop client has not synced settings yet"
                    }),
                    origin.as_deref(),
                ),
            }
        }
        (&tiny_http::Method::Post, "/usage") => {
            let mut body = String::new();
            if let Err(error) = request.as_reader().read_to_string(&mut body) {
                respond_json(
                    request,
                    400,
                    &serde_json::json!({ "error": error.to_string() }),
                    origin.as_deref(),
                );
                return;
            }

            let report = match serde_json::from_str::<ProviderUsageReport>(&body) {
                Ok(value) => value,
                Err(error) => {
                    respond_json(
                        request,
                        400,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            if report.provider.trim().is_empty() || report.characters == 0 {
                respond_json(
                    request,
                    400,
                    &serde_json::json!({ "error": "provider and positive characters are required" }),
                    origin.as_deref(),
                );
                return;
            }

            let app_handle = match state.app_handle.lock() {
                Ok(current) => current.clone(),
                Err(error) => {
                    respond_json(
                        request,
                        500,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            if let Some(app_handle) = app_handle {
                if let Err(error) = app_handle.emit("lingflow://provider-usage", report.clone()) {
                    respond_json(
                        request,
                        500,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            }

            respond_json(request, 200, &serde_json::json!({ "ok": true }), origin.as_deref());
        }
        (&tiny_http::Method::Post, "/selection") => {
            let mut body = String::new();
            if let Err(error) = request.as_reader().read_to_string(&mut body) {
                respond_json(
                    request,
                    400,
                    &serde_json::json!({ "error": error.to_string() }),
                    origin.as_deref(),
                );
                return;
            }

            let report = match serde_json::from_str::<ExternalSelectionReport>(&body) {
                Ok(value) => value,
                Err(error) => {
                    respond_json(
                        request,
                        400,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            if report.text.trim().is_empty() {
                respond_json(
                    request,
                    400,
                    &serde_json::json!({ "error": "selected text is required" }),
                    origin.as_deref(),
                );
                return;
            }

            let app_handle = match state.app_handle.lock() {
                Ok(current) => current.clone(),
                Err(error) => {
                    respond_json(
                        request,
                        500,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            if let Some(app_handle) = app_handle {
                if let Err(error) = app_handle.emit("lingflow://external-selection", report.clone()) {
                    respond_json(
                        request,
                        500,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            }

            respond_json(request, 200, &serde_json::json!({ "ok": true }), origin.as_deref());
        }
        (&tiny_http::Method::Post, "/http-request") => {
            let mut body = String::new();
            if let Err(error) = request.as_reader().read_to_string(&mut body) {
                respond_json(
                    request,
                    400,
                    &serde_json::json!({ "error": error.to_string() }),
                    origin.as_deref(),
                );
                return;
            }

            let http_request = match serde_json::from_str::<HttpRequest>(&body) {
                Ok(value) => value,
                Err(error) => {
                    respond_json(
                        request,
                        400,
                        &serde_json::json!({ "error": error.to_string() }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            let response = match tauri::async_runtime::block_on(http_request_inner(http_request)) {
                Ok(value) => value,
                Err(error) => {
                    respond_json(
                        request,
                        502,
                        &serde_json::json!({ "error": error }),
                        origin.as_deref(),
                    );
                    return;
                }
            };

            respond_json(request, 200, &response, origin.as_deref());
        }
        _ => {
            respond_json(
                request,
                404,
                &serde_json::json!({ "error": "not found" }),
                origin.as_deref(),
            );
        }
    }
}

async fn http_request_inner(request: HttpRequest) -> Result<HttpResponse, String> {
    let client = reqwest::Client::new();
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| error.to_string())?;
    let mut builder = client.request(method, request.url);

    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }

    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpResponse { status, body })
}

fn is_allowed_proxy_origin(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(value) => {
            value.starts_with("chrome-extension://")
                || value.starts_with("ms-browser-extension://")
                || value.starts_with("extension://")
        }
    }
}

fn respond_json<T: serde::Serialize>(
    request: tiny_http::Request,
    status: u16,
    body: &T,
    origin: Option<&str>,
) {
    match serde_json::to_string(body) {
        Ok(value) => respond_text(request, status, &value, origin),
        Err(error) => respond_text(request, 500, &format!(r#"{{"error":"{error}"}}"#), origin),
    }
}

fn respond_text(request: tiny_http::Request, status: u16, body: &str, origin: Option<&str>) {
    let mut response = tiny_http::Response::from_string(body.to_string()).with_status_code(status);
    response.add_header(
        tiny_http::Header::from_bytes("content-type", "application/json; charset=utf-8").unwrap(),
    );
    response.add_header(
        tiny_http::Header::from_bytes("access-control-allow-methods", "GET, POST, OPTIONS")
            .unwrap(),
    );
    response.add_header(
        tiny_http::Header::from_bytes("access-control-allow-headers", "content-type").unwrap(),
    );

    if let Some(origin) = origin.filter(|value| is_allowed_proxy_origin(Some(value))) {
        response.add_header(
            tiny_http::Header::from_bytes("access-control-allow-origin", origin).unwrap(),
        );
    }

    if let Err(error) = request.respond(response) {
        log::warn!("failed to respond from LingFlow local proxy: {error}");
    }
}
