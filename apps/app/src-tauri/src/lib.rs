use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    thread,
};

const SECRET_SERVICE: &str = "com.gloscai.lingflow";
const SECRET_FIELDS: &[&str] = &[
    "aiApiKey",
    "googleApiKey",
    "baiduSecretKey",
    "deeplApiKey",
    "microsoftApiKey",
    "youdaoAppSecret",
    "tencentSecretKey",
];
const LOCAL_PROXY_ADDR: &str = "127.0.0.1:47631";

#[derive(Clone)]
struct LocalProxyState(Arc<RwLock<Option<AppRuntimeSettings>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let proxy_state = LocalProxyState(Arc::new(RwLock::new(None)));
    start_local_proxy(proxy_state.clone());

    tauri::Builder::default()
        .manage(proxy_state)
        .invoke_handler(tauri::generate_handler![
            http_request,
            sync_local_proxy_settings,
            read_app_secrets,
            save_app_secrets,
            delete_app_secrets,
            read_clipboard_text,
            system_info,
            window_is_focused
        ])
        .setup(|app| {
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
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

#[derive(serde::Serialize)]
struct SystemInfo {
    os: String,
    arch: String,
    family: String,
}

#[tauri::command]
fn system_info() -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
    }
}

#[tauri::command]
fn window_is_focused(window: tauri::Window) -> bool {
    window.is_focused().unwrap_or(false)
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

#[tauri::command]
fn sync_local_proxy_settings(
    state: tauri::State<LocalProxyState>,
    settings: AppRuntimeSettings,
) -> Result<(), String> {
    let mut current = state.0.write().map_err(|error| error.to_string())?;
    *current = Some(settings);
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppSecrets {
    ai_api_key: Option<String>,
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

fn delete_secret(name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn start_local_proxy(state: LocalProxyState) {
    thread::spawn(move || {
        let server = match tiny_http::Server::http(LOCAL_PROXY_ADDR) {
            Ok(server) => server,
            Err(error) => {
                log::warn!("failed to start LingFlow local proxy: {error}");
                return;
            }
        };

        log::info!("LingFlow local proxy listening on http://{LOCAL_PROXY_ADDR}");

        for request in server.incoming_requests() {
            handle_local_proxy_request(request, &state);
        }
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
            let settings = match state.0.read() {
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
