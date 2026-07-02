use std::{
    collections::{HashMap, HashSet},
    fs,
    mem::size_of,
    path::PathBuf,
    process::Command,
    ptr::null_mut,
    sync::{mpsc, Arc, Mutex, OnceLock, RwLock},
    thread,
    time::{Duration, Instant},
};
use rusqlite::{params, Connection};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size};
use windows::{
    core::{BOOL, Interface},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{
            Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId},
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_C,
            },
            WindowsAndMessaging::{
                CallNextHookEx, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindowThreadProcessId,
                GetWindowLongPtrW, SendMessageW, SetWindowLongPtrW, SetWindowsHookExW, UnhookWindowsHookEx,
                EnumWindows, GetWindowRect, WindowFromPoint, GUITHREADINFO, MSLLHOOKSTRUCT, MSG, GWL_EXSTYLE, WH_MOUSE_LL, WM_GETTEXT, WM_GETTEXTLENGTH,
                WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            },
        },
    },
};

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
const CF_UNICODETEXT_FORMAT: u32 = 13;
const EM_GETSEL_MESSAGE: u32 = 0x00B0;
const GLOBAL_MOUSE_UP_EVENT: &str = "lingflow://global-mouse-up";

static GLOBAL_MOUSE_UP_TX: OnceLock<mpsc::Sender<ScreenPoint>> = OnceLock::new();
static GLOBAL_MOUSE_DRAG_STATE: OnceLock<Mutex<Option<MouseDragState>>> = OnceLock::new();

struct MouseDragState {
    point: POINT,
    started_at: Instant,
    button: u32,
}

#[derive(Clone)]
struct LocalProxyState {
    settings: Arc<RwLock<Option<AppRuntimeSettings>>>,
    listeners: Arc<Mutex<HashSet<String>>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
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
    inner: Arc<Mutex<SelectionCaptureGuard>>,
    diagnostics: Arc<Mutex<SelectionDiagnostics>>,
}

struct SelectionCaptureGuard {
    last_capture: Option<Instant>,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SelectionDiagnostics {
    stage: String,
    cursor_position: Option<ScreenPoint>,
    process_name: Option<String>,
    excluded: bool,
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
        listeners: Arc::new(Mutex::new(HashSet::new())),
        app_handle: Arc::new(Mutex::new(None)),
    };
    let proxy_app_handle = proxy_state.app_handle.clone();
    let selection_state = SelectionCaptureState {
        inner: Arc::new(Mutex::new(SelectionCaptureGuard { last_capture: None })),
        diagnostics: Arc::new(Mutex::new(SelectionDiagnostics::default())),
    };
    let app_data_store = AppDataStoreState {
        connection: Arc::new(Mutex::new(None)),
    };
    let app_data_connection = app_data_store.connection.clone();

    tauri::Builder::default()
        .manage(proxy_state)
        .manage(selection_state)
        .manage(app_data_store)
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
            list_running_process_names,
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
            if let Err(error) = center_main_window_at_screen_ratio(app.handle(), 0.6) {
                log::warn!("failed to size LingFlow main window: {error}");
            }
            start_global_mouse_up_listener(app.handle().clone());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    read_clipboard_text_native()
}

#[tauri::command]
fn foreground_process_name() -> Result<String, String> {
    foreground_process_name_inner()
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
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http and https URLs can be opened".to_string());
    }

    Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", trimmed])
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn capture_foreground_selection(
    state: tauri::State<'_, SelectionCaptureState>,
    excluded_apps: Vec<String>,
    cursor_position: Option<ScreenPoint>,
    clipboard_fallback_enabled: Option<bool>,
    clipboard_fallback_apps: Option<Vec<String>>,
) -> Result<String, String> {
    let inner = state.inner.clone();
    let diagnostics = state.diagnostics.clone();
    tauri::async_runtime::spawn_blocking(move || {
        capture_foreground_selection_with_state(
            inner,
            diagnostics,
            excluded_apps,
            cursor_position,
            clipboard_fallback_enabled.unwrap_or(false),
            clipboard_fallback_apps.unwrap_or_default(),
        )
    })
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_foreground_selected_text(
    state: tauri::State<'_, SelectionCaptureState>,
    excluded_apps: Vec<String>,
) -> Result<String, String> {
    capture_foreground_selection(state, excluded_apps, None, Some(false), Some(Vec::new())).await
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
fn set_overlay_no_activate(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {label} not found"))?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(hwnd.0);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
    }
    Ok(())
}

#[tauri::command]
fn list_running_process_names() -> Result<Vec<String>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| error.message().to_string())?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut names = Vec::<String>::new();

    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while has_entry {
        let end = entry
            .szExeFile
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end]).trim().to_string();
        if !name.is_empty() && !names.iter().any(|item| item.eq_ignore_ascii_case(&name)) {
            names.push(name);
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }

    unsafe {
        CloseHandle(snapshot).map_err(|error| error.message().to_string())?;
    }
    names.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(names)
}

fn capture_foreground_selection_with_state(
    inner: Arc<Mutex<SelectionCaptureGuard>>,
    diagnostics: Arc<Mutex<SelectionDiagnostics>>,
    excluded_apps: Vec<String>,
    cursor_position: Option<ScreenPoint>,
    clipboard_fallback_enabled: bool,
    clipboard_fallback_apps: Vec<String>,
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

    let result = capture_foreground_selection_inner(
        &diagnostics,
        &excluded_apps,
        cursor_position,
        clipboard_fallback_enabled,
        &clipboard_fallback_apps,
    );
    if let Err(error) = &result {
        update_selection_diagnostics(&diagnostics, |current| {
            current.stage = "failed".to_string();
            current.error = Some(error.clone());
        });
    }
    result
}

fn capture_foreground_selection_inner(
    diagnostics: &Arc<Mutex<SelectionDiagnostics>>,
    excluded_apps: &[String],
    cursor_position: Option<ScreenPoint>,
    clipboard_fallback_enabled: bool,
    clipboard_fallback_apps: &[String],
) -> Result<String, String> {
    let process_name = foreground_process_name_inner()?;
    update_selection_diagnostics(diagnostics, |current| {
        current.stage = "process-resolved".to_string();
        current.cursor_position = cursor_position;
        current.process_name = Some(process_name.clone());
    });

    if is_excluded_process(&process_name, excluded_apps) {
        let error = format!("{process_name} is excluded from global selection translation");
        update_selection_diagnostics(diagnostics, |current| {
            current.stage = "excluded".to_string();
            current.excluded = true;
            current.error = Some(error.clone());
        });
        return Err(error);
    }

    match selected_text_from_uia(cursor_position) {
        Ok(text) => {
            push_selection_attempt(diagnostics, "uia", true, format!("{} chars", text.len()));
            update_selection_diagnostics(diagnostics, |current| {
                current.stage = "success".to_string();
                current.result_length = Some(text.len());
            });
            return Ok(text);
        }
        Err(error) => push_selection_attempt(diagnostics, "uia", false, error),
    }

    match selected_text_from_standard_edit() {
        Ok(text) => {
            push_selection_attempt(diagnostics, "standard-edit", true, format!("{} chars", text.len()));
            update_selection_diagnostics(diagnostics, |current| {
                current.stage = "success".to_string();
                current.result_length = Some(text.len());
            });
            return Ok(text);
        }
        Err(error) => push_selection_attempt(diagnostics, "standard-edit", false, error),
    }

    let can_use_clipboard_fallback =
        clipboard_fallback_enabled && (clipboard_fallback_apps.is_empty() || is_excluded_process(&process_name, clipboard_fallback_apps));
    if can_use_clipboard_fallback {
        match selected_text_from_clipboard_fallback() {
            Ok(text) => {
                push_selection_attempt(diagnostics, "clipboard-fallback", true, format!("{} chars", text.len()));
                update_selection_diagnostics(diagnostics, |current| {
                    current.stage = "success".to_string();
                    current.result_length = Some(text.len());
                });
                return Ok(text);
            }
            Err(error) => push_selection_attempt(diagnostics, "clipboard-fallback", false, error),
        }
    } else if clipboard_fallback_enabled {
        push_selection_attempt(
            diagnostics,
            "clipboard-fallback",
            false,
            format!("{process_name} is not in clipboard fallback allow list"),
        );
    }

    Err("No selected text was found through Windows UI Automation".to_string())
}

fn write_selection_diagnostics(diagnostics: &Arc<Mutex<SelectionDiagnostics>>, next: SelectionDiagnostics) {
    if let Ok(mut current) = diagnostics.lock() {
        *current = next;
    }
}

fn update_selection_diagnostics(
    diagnostics: &Arc<Mutex<SelectionDiagnostics>>,
    update: impl FnOnce(&mut SelectionDiagnostics),
) {
    if let Ok(mut current) = diagnostics.lock() {
        update(&mut current);
    }
}

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

fn normalize_selected_text(value: String) -> Result<String, String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        Err("No selected text was found in the foreground window".to_string())
    } else {
        Ok(normalized)
    }
}

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

fn foreground_window() -> Result<HWND, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        Err("No foreground window".to_string())
    } else {
        Ok(hwnd)
    }
}

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

fn start_global_mouse_up_listener(app_handle: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<ScreenPoint>();
    let _ = GLOBAL_MOUSE_UP_TX.set(tx);
    let _ = GLOBAL_MOUSE_DRAG_STATE.set(Mutex::new(None));

    thread::spawn(move || {
        for point in rx {
            let _ = app_handle.emit(GLOBAL_MOUSE_UP_EVENT, point);
        }
    });

    thread::spawn(move || unsafe {
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(global_mouse_hook_proc), None, 0) {
            Ok(hook) => hook,
            Err(error) => {
                log::warn!("failed to install global mouse hook: {error}");
                return;
            }
        };

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {}
        if let Err(error) = UnhookWindowsHookEx(hook) {
            log::warn!("failed to unhook global mouse hook: {error}");
        }
    });
}

unsafe extern "system" fn global_mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if matches!(message, WM_LBUTTONDOWN | WM_RBUTTONDOWN) {
            remember_global_mouse_down(message, lparam);
        } else if matches!(message, WM_LBUTTONUP | WM_RBUTTONUP)
            && !mouse_event_is_on_lingflow_window(lparam)
        {
            if let Some(point) = global_mouse_up_selection_point(message, lparam) {
                if let Some(tx) = GLOBAL_MOUSE_UP_TX.get() {
                    let _ = tx.send(ScreenPoint { x: point.x, y: point.y });
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn remember_global_mouse_down(message: u32, lparam: LPARAM) {
    let Some(state) = GLOBAL_MOUSE_DRAG_STATE.get() else {
        return;
    };
    let Some(point) = mouse_event_point(lparam) else {
        return;
    };
    if let Ok(mut current) = state.lock() {
        *current = Some(MouseDragState {
            point,
            started_at: Instant::now(),
            button: message,
        });
    }
}

fn global_mouse_up_selection_point(message: u32, lparam: LPARAM) -> Option<POINT> {
    let Some(state) = GLOBAL_MOUSE_DRAG_STATE.get() else {
        return None;
    };
    let Some(up_point) = mouse_event_point(lparam) else {
        return None;
    };

    let Ok(mut current) = state.lock() else {
        return None;
    };
    let Some(down) = current.take() else {
        return None;
    };

    if !mouse_buttons_match(down.button, message) {
        return None;
    }

    let dx = i64::from(up_point.x) - i64::from(down.point.x);
    let dy = i64::from(up_point.y) - i64::from(down.point.y);
    let distance_squared = dx * dx + dy * dy;
    if distance_squared >= 64 && down.started_at.elapsed() >= Duration::from_millis(80) {
        Some(up_point)
    } else {
        None
    }
}

fn mouse_buttons_match(down: u32, up: u32) -> bool {
    matches!((down, up), (WM_LBUTTONDOWN, WM_LBUTTONUP) | (WM_RBUTTONDOWN, WM_RBUTTONUP))
}

fn mouse_event_point(lparam: LPARAM) -> Option<POINT> {
    if lparam.0 == 0 {
        return None;
    }

    let hook = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
    Some(POINT {
        x: hook.pt.x,
        y: hook.pt.y,
    })
}

fn mouse_event_is_on_lingflow_window(lparam: LPARAM) -> bool {
    let Some(point) = mouse_event_point(lparam) else {
        return false;
    };
    point_is_inside_current_process_window(point) || window_from_point_belongs_to_current_process(point)
}

fn window_from_point_belongs_to_current_process(point: POINT) -> bool {
    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd.0.is_null() {
        return false;
    }

    window_belongs_to_current_process(hwnd)
}

fn point_is_inside_current_process_window(point: POINT) -> bool {
    let mut context = WindowHitTestContext { point, hit: false };
    let context_ptr = &mut context as *mut WindowHitTestContext;
    let _ = unsafe { EnumWindows(Some(enum_current_process_windows), LPARAM(context_ptr as isize)) };
    context.hit
}

struct WindowHitTestContext {
    point: POINT,
    hit: bool,
}

unsafe extern "system" fn enum_current_process_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let context = unsafe { &mut *(lparam.0 as *mut WindowHitTestContext) };
    if context.hit || !window_belongs_to_current_process(hwnd) {
        return true.into();
    }

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect).is_ok() }
        && context.point.x >= rect.left
        && context.point.x <= rect.right
        && context.point.y >= rect.top
        && context.point.y <= rect.bottom
    {
        context.hit = true;
        return false.into();
    }

    true.into()
}

fn window_belongs_to_current_process(hwnd: HWND) -> bool {
    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    process_id != 0 && process_id == unsafe { GetCurrentProcessId() }
}

fn selected_text_from_uia(cursor_position: Option<ScreenPoint>) -> Result<String, String> {
    let _com = ComApartment::init()?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| error.message().to_string())?;
    let mut errors = Vec::<String>::new();

    if let Some(point) = cursor_position {
        let point = POINT { x: point.x, y: point.y };
        match unsafe { automation.ElementFromPoint(point) } {
            Ok(element) => match selected_text_from_uia_element(&element) {
                Ok(text) => return Ok(text),
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
                    Ok(text) => return Ok(text),
                    Err(error) => errors.push(format!("point-window: {error}")),
                },
                Err(error) => errors.push(format!("point-window lookup: {}", error.message())),
            }
        }
    }

    match focused_control_window() {
        Ok(hwnd) => match unsafe { automation.ElementFromHandle(hwnd) } {
            Ok(element) => match selected_text_from_uia_element(&element) {
                Ok(text) => return Ok(text),
                Err(error) => errors.push(format!("focused-control: {error}")),
            },
            Err(error) => errors.push(format!("focused-control lookup: {}", error.message())),
        },
        Err(error) => errors.push(format!("focused-control hwnd: {error}")),
    }

    let hwnd = foreground_window()?;
    match unsafe { automation.ElementFromHandle(hwnd) } {
        Ok(element) => match selected_text_from_uia_element(&element) {
            Ok(text) => Ok(text),
            Err(error) => {
                errors.push(format!("foreground-window: {error}"));
                Err(errors.join(" | "))
            }
        },
        Err(error) => {
            errors.push(format!("foreground-window lookup: {}", error.message()));
            Err(errors.join(" | "))
        }
    }
}

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

fn selected_text_from_standard_edit() -> Result<String, String> {
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

    if selection_end <= selection_start {
        return Err("Standard edit control has no selection".to_string());
    }

    let text_length = unsafe { SendMessageW(hwnd, WM_GETTEXTLENGTH, Some(WPARAM(0)), Some(LPARAM(0))).0 as usize };
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

fn selected_text_from_clipboard_fallback() -> Result<String, String> {
    let original_clipboard = read_clipboard_text_native().unwrap_or_default();
    send_copy_shortcut_native()?;
    thread::sleep(Duration::from_millis(120));

    let selected_text = read_clipboard_text_native().unwrap_or_default();
    if !original_clipboard.is_empty() && selected_text != original_clipboard {
        if let Err(error) = set_clipboard_text_native(&original_clipboard) {
            log::warn!("failed to restore text clipboard after compatibility fallback: {error}");
        }
    }

    normalize_selected_text(selected_text)
}

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
        Err("Failed to send Ctrl+C compatibility fallback".to_string())
    }
}

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

fn set_clipboard_text_native(value: &str) -> Result<(), String> {
    let _clipboard = ClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| error.message().to_string())?;
    if value.is_empty() {
        return Ok(());
    }

    let mut utf16 = value.encode_utf16().collect::<Vec<u16>>();
    utf16.push(0);
    let byte_len = utf16.len() * size_of::<u16>();
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) }
        .map_err(|error| error.message().to_string())?;
    let ptr = unsafe { GlobalLock(handle) } as *mut u16;
    if ptr.is_null() {
        return Err("Failed to lock clipboard allocation".to_string());
    }
    unsafe {
        ptr.copy_from_nonoverlapping(utf16.as_ptr(), utf16.len());
        let _ = GlobalUnlock(handle);
        SetClipboardData(CF_UNICODETEXT_FORMAT, Some(HANDLE(handle.0))).map_err(|error| error.message().to_string())?;
    }
    Ok(())
}

struct ClipboardSession;

impl ClipboardSession {
    fn open() -> Result<Self, String> {
        unsafe { OpenClipboard(Some(HWND(null_mut()))) }
            .map(|_| ClipboardSession)
            .map_err(|error| error.message().to_string())
    }
}

impl Drop for ClipboardSession {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

struct ComApartment;

impl ComApartment {
    fn init() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .map(|| ComApartment)
            .map_err(|error| error.message().to_string())
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

fn is_excluded_process(process_name: &str, excluded_apps: &[String]) -> bool {
    let normalized_process = process_name.trim().to_ascii_lowercase();
    excluded_apps.iter().any(|item| {
        let normalized_item = item.trim().to_ascii_lowercase();
        !normalized_item.is_empty()
            && (normalized_process == normalized_item
                || normalized_process.trim_end_matches(".exe") == normalized_item.trim_end_matches(".exe"))
    })
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
fn read_app_secrets() -> Result<AppSecrets, String> {
    Ok(AppSecrets {
        ai_api_key: read_secret("aiApiKey")?,
        ai_source_api_keys: read_json_secret("aiSourceApiKeys")?,
        google_api_key: read_secret("googleApiKey")?,
        baidu_secret_key: read_secret("baiduSecretKey")?,
        deepl_api_key: read_secret("deeplApiKey")?,
        microsoft_api_key: read_secret("microsoftApiKey")?,
        youdao_app_secret: read_secret("youdaoAppSecret")?,
        tencent_secret_key: read_secret("tencentSecretKey")?,
    })
}

#[tauri::command]
fn save_app_secrets(secrets: AppSecrets) -> Result<(), String> {
    write_secret("aiApiKey", secrets.ai_api_key)?;
    write_json_secret("aiSourceApiKeys", secrets.ai_source_api_keys)?;
    write_secret("googleApiKey", secrets.google_api_key)?;
    write_secret("baiduSecretKey", secrets.baidu_secret_key)?;
    write_secret("deeplApiKey", secrets.deepl_api_key)?;
    write_secret("microsoftApiKey", secrets.microsoft_api_key)?;
    write_secret("youdaoAppSecret", secrets.youdao_app_secret)?;
    write_secret("tencentSecretKey", secrets.tencent_secret_key)?;
    Ok(())
}

#[tauri::command]
fn delete_app_secrets() -> Result<(), String> {
    for field in SECRET_FIELDS {
        delete_secret(field)?;
    }
    Ok(())
}

fn read_secret(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_secret(name: &str, value: Option<String>) -> Result<(), String> {
    let normalized = value.unwrap_or_default();
    if normalized.trim().is_empty() {
        return delete_secret(name);
    }

    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    entry
        .set_password(&normalized)
        .map_err(|error| error.to_string())
}

fn read_json_secret<T: serde::de::DeserializeOwned>(name: &str) -> Result<Option<T>, String> {
    match read_secret(name)? {
        Some(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

fn write_json_secret<T: serde::Serialize>(name: &str, value: Option<T>) -> Result<(), String> {
    match value {
        Some(value) => {
            let serialized = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            write_secret(name, Some(serialized))
        }
        None => delete_secret(name),
    }
}

fn delete_secret(name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn start_local_proxy(state: LocalProxyState, addr: String) -> Result<(), String> {
    {
        let mut listeners = state.listeners.lock().map_err(|error| error.to_string())?;
        if listeners.contains(&addr) {
            return Ok(());
        }
        listeners.insert(addr.clone());
    }

    let server = match tiny_http::Server::http(&addr) {
        Ok(server) => server,
        Err(error) => {
            if let Ok(mut listeners) = state.listeners.lock() {
                listeners.remove(&addr);
            }
            return Err(format!("failed to start LingFlow local proxy on {addr}: {error}"));
        }
    };

    thread::spawn(move || {
        log::info!("LingFlow local proxy listening on http://{addr}");

        for request in server.incoming_requests() {
            handle_local_proxy_request(request, &state);
        }
    });

    Ok(())
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
