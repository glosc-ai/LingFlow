use std::{
    collections::{HashMap, HashSet},
    mem::size_of,
    ptr::null_mut,
    sync::{mpsc, Arc, Mutex, OnceLock, RwLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::{
    core::{BOOL, Interface},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
                SetClipboardData,
            },
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

static GLOBAL_MOUSE_UP_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
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
}

struct SelectionCaptureGuard {
    last_capture: Option<Instant>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let proxy_state = LocalProxyState {
        settings: Arc::new(RwLock::new(None)),
        listeners: Arc::new(Mutex::new(HashSet::new())),
    };
    let selection_state = SelectionCaptureState {
        inner: Arc::new(Mutex::new(SelectionCaptureGuard { last_capture: None })),
    };

    tauri::Builder::default()
        .manage(proxy_state)
        .manage(selection_state)
        .invoke_handler(tauri::generate_handler![
            http_request,
            sync_local_proxy_settings,
            read_app_secrets,
            save_app_secrets,
            delete_app_secrets,
            read_clipboard_text,
            capture_foreground_selection,
            read_foreground_selected_text,
            set_overlay_no_activate,
            list_running_process_names,
            foreground_process_name
        ])
        .setup(|app| {
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

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    read_clipboard_text_native()
}

#[tauri::command]
fn foreground_process_name() -> Result<String, String> {
    foreground_process_name_inner()
}

#[tauri::command]
async fn capture_foreground_selection(
    state: tauri::State<'_, SelectionCaptureState>,
    excluded_apps: Vec<String>,
) -> Result<String, String> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || capture_foreground_selection_with_state(inner, excluded_apps))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_foreground_selected_text(
    state: tauri::State<'_, SelectionCaptureState>,
    excluded_apps: Vec<String>,
) -> Result<String, String> {
    capture_foreground_selection(state, excluded_apps).await
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
    excluded_apps: Vec<String>,
) -> Result<String, String> {
    {
        let mut guard = inner
            .try_lock()
            .map_err(|_| "Selection capture is already running".to_string())?;
        if guard
            .last_capture
            .is_some_and(|last_capture| last_capture.elapsed() < Duration::from_millis(350))
        {
            return Err("Selection capture debounced".to_string());
        }
        guard.last_capture = Some(Instant::now());
    }

    capture_foreground_selection_inner(&excluded_apps)
}

fn capture_foreground_selection_inner(excluded_apps: &[String]) -> Result<String, String> {
    let process_name = foreground_process_name_inner()?;
    if is_excluded_process(&process_name, excluded_apps) {
        return Err(format!("{process_name} is excluded from global selection translation"));
    }

    if let Ok(text) = selected_text_from_uia() {
        return Ok(text);
    }

    if let Ok(text) = selected_text_from_standard_edit() {
        return Ok(text);
    }

    selected_text_from_clipboard_fallback()
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
    let (tx, rx) = mpsc::channel::<()>();
    let _ = GLOBAL_MOUSE_UP_TX.set(tx);
    let _ = GLOBAL_MOUSE_DRAG_STATE.set(Mutex::new(None));

    thread::spawn(move || {
        for _ in rx {
            let _ = app_handle.emit(GLOBAL_MOUSE_UP_EVENT, ());
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
            && global_mouse_up_looks_like_selection_drag(message, lparam)
            && !mouse_event_is_on_lingflow_window(lparam)
        {
            if let Some(tx) = GLOBAL_MOUSE_UP_TX.get() {
                let _ = tx.send(());
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

fn global_mouse_up_looks_like_selection_drag(message: u32, lparam: LPARAM) -> bool {
    let Some(state) = GLOBAL_MOUSE_DRAG_STATE.get() else {
        return false;
    };
    let Some(up_point) = mouse_event_point(lparam) else {
        return false;
    };

    let Ok(mut current) = state.lock() else {
        return false;
    };
    let Some(down) = current.take() else {
        return false;
    };

    if !mouse_buttons_match(down.button, message) {
        return false;
    }

    let dx = i64::from(up_point.x) - i64::from(down.point.x);
    let dy = i64::from(up_point.y) - i64::from(down.point.y);
    let distance_squared = dx * dx + dy * dy;
    distance_squared >= 64 && down.started_at.elapsed() >= Duration::from_millis(80)
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

fn selected_text_from_uia() -> Result<String, String> {
    let hwnd = focused_control_window().or_else(|_| foreground_window())?;
    let _com = ComApartment::init()?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| error.message().to_string())?;
    let element = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|error| error.message().to_string())?;
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
    clear_clipboard_native()?;
    send_copy_shortcut_native()?;
    thread::sleep(Duration::from_millis(120));

    let selected_text = read_clipboard_text_native().unwrap_or_default();
    if let Err(error) = set_clipboard_text_native(&original_clipboard) {
        log::warn!("failed to restore clipboard after selection fallback: {error}");
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
        Err("Failed to send Ctrl+C fallback".to_string())
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

fn clear_clipboard_native() -> Result<(), String> {
    let _clipboard = ClipboardSession::open()?;
    unsafe { EmptyClipboard() }.map_err(|error| error.message().to_string())
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

