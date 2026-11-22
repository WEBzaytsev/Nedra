use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::{Origin, Url};

#[derive(Default)]
pub struct ServerRuntime {
    generation: AtomicU64,
    opening: AtomicBool,
    exiting: AtomicBool,
    finalize: Mutex<()>,
    session: Mutex<Option<(Url, String)>>,
}

impl ServerRuntime {
    fn begin(&self) -> u64 {
        self.opening.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn cancel(&self) -> bool {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.opening.swap(false, Ordering::SeqCst)
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn finish(&self, generation: u64) -> bool {
        if self.is_current(generation) {
            self.opening.store(false, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    fn mark_exiting(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.cancel();
    }

    fn is_exiting(&self) -> bool {
        self.exiting.load(Ordering::SeqCst)
    }

    fn revoke_open_session(&self) {
        if let Ok(mut session) = self.session.lock() {
            if let Some((target, token)) = session.take() {
                if let Ok(client) = client() {
                    schedule_revoke(client, &target, token);
                }
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerChoice {
    pub origin: Option<String>,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ConnectionStart {
    request: String,
    secret: String,
    verification_url: String,
    expires_in_ms: u64,
}

#[derive(Deserialize)]
struct ConnectionPoll {
    state: String,
    session_token: Option<String>,
}

fn emit_status(
    app: &tauri::AppHandle,
    state: &'static str,
    origin: Option<&Url>,
    error: Option<&str>,
) {
    let _ = app.emit_to(
        "main",
        "server-status",
        ServerStatus {
            state,
            origin: origin.map(ToString::to_string),
            error: error.map(ToOwned::to_owned),
        },
    );
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| {
            dir.join(if cfg!(debug_assertions) {
                "development/server-choice.json"
            } else {
                "server-choice.json"
            })
        })
        .map_err(|_| "Application data directory unavailable".into())
}

fn origin(input: &str) -> Result<Url, String> {
    if input.chars().any(char::is_control) {
        return Err("Enter a valid HTTPS server address".into());
    }
    let url = Url::parse(input.trim()).map_err(|_| "Enter a valid HTTPS server address")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Enter an HTTPS origin without a path, credentials or parameters".into());
    }
    Ok(url)
}

fn load(app: &tauri::AppHandle) -> Result<ServerChoice, String> {
    let file = path(app)?;
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error)
            if cfg!(windows)
                && error.kind() == std::io::ErrorKind::NotFound
                && file.with_extension("bak").exists() =>
        {
            fs::read(file.with_extension("bak")).map_err(|_| "Could not read the server choice")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ServerChoice {
                origin: None,
                selected: false,
            });
        }
        Err(_) => return Err("Could not read the server choice".into()),
    };
    let choice: ServerChoice = serde_json::from_slice(&bytes)
        .map_err(|_| "The saved server choice is invalid; it was not changed")?;
    if let Some(value) = &choice.origin {
        if origin(value)?.as_str() != value {
            return Err("The saved server address is invalid".into());
        }
    }
    Ok(choice)
}

fn save(app: &tauri::AppHandle, choice: &ServerChoice) -> Result<(), String> {
    let file = path(app)?;
    let parent = file
        .parent()
        .ok_or("Application data directory unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "Could not save the server choice")?;
    let temporary = file.with_extension("new");
    fs::write(
        &temporary,
        serde_json::to_vec(choice).map_err(|_| "Could not save the server choice")?,
    )
    .map_err(|_| "Could not save the server choice")?;
    // Windows rename cannot replace the destination; preserve the previous choice on interruption.
    if cfg!(windows) && file.exists() {
        let backup = file.with_extension("bak");
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| "Could not save the server choice")?;
        }
        fs::rename(&file, &backup).map_err(|_| "Could not save the server choice")?;
        if fs::rename(&temporary, &file).is_err() {
            let _ = fs::rename(&backup, &file);
            return Err("Could not save the server choice".into());
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    fs::rename(temporary, file).map_err(|_| "Could not save the server choice".into())
}

fn allowed_navigation(expected: &Origin, url: &Url) -> bool {
    url.origin() == *expected && url.username().is_empty() && url.password().is_none()
}

fn connected_choice(target: &Url) -> ServerChoice {
    ServerChoice {
        origin: Some(target.to_string()),
        selected: true,
    }
}

fn closed_choice(mut choice: ServerChoice) -> ServerChoice {
    choice.selected = false;
    choice
}

fn local_choice() -> ServerChoice {
    ServerChoice {
        origin: None,
        selected: true,
    }
}

#[cfg(any(windows, test))]
fn webview_version_at_least(version: &str, minimum: &[u64]) -> bool {
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    if parts.is_empty() {
        return false;
    }
    parts.resize(minimum.len(), 0);
    parts.as_slice() >= minimum
}

#[cfg(windows)]
fn ensure_private_session_support() -> Result<(), String> {
    let version = tauri::webview_version()
        .map_err(|_| "The installed WebView2 runtime version is unavailable")?;
    if webview_version_at_least(&version, &[101, 0, 1210, 39]) {
        Ok(())
    } else {
        Err("Update Microsoft Edge WebView2 before connecting to a server".into())
    }
}

#[cfg(not(windows))]
fn ensure_private_session_support() -> Result<(), String> {
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the server connection".into())
}

async fn start_connection(target: &Url) -> Result<(reqwest::Client, ConnectionStart), String> {
    let client = client()?;
    let endpoint = target
        .join("api/desktop/connections")
        .map_err(|_| "Could not initialize the server connection")?;
    let response = client
        .post(endpoint)
        .send()
        .await
        .map_err(|_| "The server is unreachable or its certificate is invalid")?;
    if !response.status().is_success() {
        return Err("The server does not support Desktop approval requests".into());
    }
    let start: ConnectionStart = serde_json::from_slice(
        &response
            .bytes()
            .await
            .map_err(|_| "The server returned an invalid Desktop approval request")?,
    )
    .map_err(|_| "The server returned an invalid Desktop approval request")?;
    let verification = target
        .join(&start.verification_url)
        .map_err(|_| "The server returned an invalid approval address")?;
    if !allowed_navigation(&target.origin(), &verification)
        || verification.path() != "/desktop-connect"
        || start.expires_in_ms == 0
        || start.expires_in_ms > 10 * 60 * 1000
    {
        return Err("The server returned an invalid approval address".into());
    }
    Ok((
        client,
        ConnectionStart {
            verification_url: verification.to_string(),
            ..start
        },
    ))
}

async fn cancel_approval(client: &reqwest::Client, target: &Url, start: &ConnectionStart) {
    if let Ok(endpoint) = target.join("api/desktop/connections/cancel") {
        let _ = client
            .post(endpoint)
            .json(&serde_json::json!({"request": start.request, "secret": start.secret}))
            .send()
            .await;
    }
}

async fn revoke_session(client: &reqwest::Client, target: &Url, token: &str) {
    if let Ok(endpoint) = target.join("api/master_password/lock") {
        let _ = client
            .post(endpoint)
            .header("x-nedra-session", token)
            .send()
            .await;
    }
}

fn schedule_revoke(client: reqwest::Client, target: &Url, token: String) {
    let target = target.clone();
    tauri::async_runtime::spawn(async move { revoke_session(&client, &target, &token).await });
}

async fn await_approval(
    client: &reqwest::Client,
    target: &Url,
    start: &ConnectionStart,
    runtime: &ServerRuntime,
    generation: u64,
) -> Result<String, String> {
    let endpoint = target
        .join("api/desktop/connections/poll")
        .map_err(|_| "Could not initialize the server connection")?;
    let body = serde_json::to_vec(&serde_json::json!({
        "request": start.request,
        "secret": start.secret,
    }))
    .map_err(|_| "Could not initialize the server connection")?;
    let deadline = Instant::now() + Duration::from_millis(start.expires_in_ms);
    loop {
        if !runtime.is_current(generation) {
            return Err("Connection cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("The approval request expired".into());
        }
        let response = client
            .post(endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.clone())
            .send()
            .await
            .map_err(|_| "The server became unavailable while waiting for approval")?;
        if !response.status().is_success() {
            return Err("The server refused the approval request".into());
        }
        let poll: ConnectionPoll = serde_json::from_slice(
            &response
                .bytes()
                .await
                .map_err(|_| "The server returned an invalid approval status")?,
        )
        .map_err(|_| "The server returned an invalid approval status")?;
        match poll.state.as_str() {
            "pending" => tokio::time::sleep(Duration::from_secs(1)).await,
            "approved" => {
                let token = poll
                    .session_token
                    .filter(|value| {
                        value.len() == 43
                            && value.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
                            })
                    })
                    .ok_or("The server returned an invalid Desktop session")?;
                return Ok(token);
            }
            "denied" => return Err("Desktop access was denied".into()),
            "expired" => return Err("The approval request expired".into()),
            "revoked" => return Err("Desktop access was revoked".into()),
            _ => return Err("The server refused the approval request".into()),
        }
    }
}

#[tauri::command]
pub fn server_choice(app: tauri::AppHandle) -> Result<ServerChoice, String> {
    load(&app)
}

#[tauri::command]
pub async fn server_connect(
    app: tauri::AppHandle,
    address: String,
) -> Result<ServerChoice, String> {
    let target = match origin(&address) {
        Ok(target) => target,
        Err(error) => {
            emit_status(&app, "failed", None, Some(&error));
            return Err(error);
        }
    };
    if app.get_webview_window("server").is_some() {
        let error = "Close the current server window first".to_string();
        emit_status(&app, "failed", Some(&target), Some(&error));
        return Err(error);
    }
    if let Err(error) = ensure_private_session_support() {
        emit_status(&app, "failed", Some(&target), Some(&error));
        return Err(error);
    }

    let runtime = app.state::<ServerRuntime>();
    let generation = runtime.begin();
    emit_status(&app, "opening", Some(&target), None);
    let (client, approval) = match start_connection(&target).await {
        Ok(value) => value,
        Err(error) => {
            let _finalize = runtime
                .finalize
                .lock()
                .map_err(|_| "Server connection state unavailable")?;
            if runtime.finish(generation) {
                emit_status(&app, "failed", Some(&target), Some(&error));
            }
            return Err(error);
        }
    };
    if !runtime.is_current(generation) {
        cancel_approval(&client, &target, &approval).await;
        return Err("Connection cancelled".into());
    }
    if let Err(error) = crate::native::open_external(approval.verification_url.clone()) {
        cancel_approval(&client, &target, &approval).await;
        let _finalize = runtime
            .finalize
            .lock()
            .map_err(|_| "Server connection state unavailable")?;
        if runtime.finish(generation) {
            emit_status(&app, "failed", Some(&target), Some(&error));
        }
        return Err(error);
    }
    let session = match await_approval(&client, &target, &approval, &runtime, generation).await {
        Ok(session) => session,
        Err(error) => {
            cancel_approval(&client, &target, &approval).await;
            let _finalize = runtime
                .finalize
                .lock()
                .map_err(|_| "Server connection state unavailable")?;
            if runtime.finish(generation) {
                emit_status(&app, "failed", Some(&target), Some(&error));
            }
            return Err(error);
        }
    };

    let _finalize = runtime
        .finalize
        .lock()
        .map_err(|_| "Server connection state unavailable")?;
    if !runtime.is_current(generation) {
        schedule_revoke(client, &target, session);
        return Err("Connection cancelled".into());
    }
    let main = match app.get_webview_window("main") {
        Some(main) => main,
        None => {
            schedule_revoke(client, &target, session);
            let error = "Application window unavailable".to_string();
            runtime.finish(generation);
            emit_status(&app, "failed", Some(&target), Some(&error));
            return Err(error);
        }
    };
    if let Ok(mut current) = runtime.session.lock() {
        *current = Some((target.clone(), session.clone()));
    } else {
        schedule_revoke(client, &target, session);
        runtime.finish(generation);
        return Err("Server connection state unavailable".into());
    }
    // Keep the shell on its current page while locking the local vault. Navigating
    // it here can remount DesktopGate, auto-connect again and revoke this session.
    crate::lock::lock_local_for_server(&app);
    let mut bootstrap = target.join("desktop-session").map_err(|_| {
        runtime.revoke_open_session();
        "Could not initialize the server connection"
    })?;
    bootstrap.set_fragment(Some(&format!("session={session}")));
    let window = match WebviewWindowBuilder::new(&app, "server", WebviewUrl::External(bootstrap))
        .title(format!("Nedra — {}", target.host_str().unwrap_or_default()))
        .inner_size(1100.0, 800.0)
        .min_inner_size(640.0, 560.0)
        .incognito(true)
        .on_navigation({
            let expected = target.origin();
            move |url| allowed_navigation(&expected, url)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
    {
        Ok(window) => window,
        Err(_) => {
            runtime.revoke_open_session();
            let error = "Could not open the server window".to_string();
            runtime.finish(generation);
            emit_status(&app, "failed", Some(&target), Some(&error));
            return Err(error);
        }
    };
    let choice = connected_choice(&target);
    if let Err(error) = save(&app, &choice) {
        runtime.revoke_open_session();
        let _ = window.close();
        let _ = main.show();
        runtime.finish(generation);
        emit_status(&app, "failed", Some(&target), Some(&error));
        return Err(error);
    }
    let _ = main.hide();
    let _ = window.show();
    let _ = window.set_focus();
    runtime.finish(generation);
    emit_status(&app, "open", Some(&target), None);
    Ok(choice)
}

fn disconnect(app: &tauri::AppHandle) -> Result<ServerChoice, String> {
    let runtime = app.state::<ServerRuntime>();
    let _finalize = runtime
        .finalize
        .lock()
        .map_err(|_| "Server connection state unavailable")?;
    runtime.cancel();
    runtime.revoke_open_session();
    let choice = load(app).and_then(|choice| {
        let choice = closed_choice(choice);
        save(app, &choice)?;
        Ok(choice)
    });
    let had_window = if let Some(server) = app.get_webview_window("server") {
        let _ = server.close();
        true
    } else {
        false
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if !had_window {
        let parsed = choice
            .as_ref()
            .ok()
            .and_then(|choice| choice.origin.as_deref())
            .and_then(|value| Url::parse(value).ok());
        emit_status(app, "closed", parsed.as_ref(), None);
    }
    choice
}

#[tauri::command]
pub fn server_disconnect(app: tauri::AppHandle) -> Result<ServerChoice, String> {
    disconnect(&app)
}

pub fn disconnect_on_lock(app: &tauri::AppHandle) {
    let runtime = app.state::<ServerRuntime>();
    let Ok(_finalize) = runtime.finalize.lock() else {
        return;
    };
    let was_opening = runtime.cancel();
    runtime.revoke_open_session();
    let had_window = if let Some(server) = app.get_webview_window("server") {
        if let Ok(choice) = load(app) {
            let choice = closed_choice(choice);
            let _ = save(app, &choice);
        }
        let _ = server.close();
        true
    } else {
        false
    };
    if was_opening && !had_window {
        emit_status(app, "closed", None, None);
    }
}

pub fn app_exit_requested(app: &tauri::AppHandle) {
    let runtime = app.state::<ServerRuntime>();
    runtime.mark_exiting();
    runtime.revoke_open_session();
}

pub fn server_window_destroyed(app: &tauri::AppHandle) -> bool {
    let runtime = app.state::<ServerRuntime>();
    runtime.cancel();
    runtime.revoke_open_session();
    if runtime.is_exiting() {
        return false;
    }
    let mut saved_origin = None;
    if let Ok(choice) = load(app) {
        let choice = closed_choice(choice);
        saved_origin = choice.origin.clone();
        let _ = save(app, &choice);
    }
    let parsed = saved_origin
        .as_deref()
        .and_then(|value| Url::parse(value).ok());
    emit_status(app, "closed", parsed.as_ref(), None);
    true
}

#[tauri::command]
pub fn server_local(app: tauri::AppHandle) -> Result<ServerChoice, String> {
    let runtime = app.state::<ServerRuntime>();
    let _finalize = runtime
        .finalize
        .lock()
        .map_err(|_| "Server connection state unavailable")?;
    runtime.cancel();
    if app.get_webview_window("server").is_some() {
        return Err("Close the server window first".into());
    }
    crate::lock::lock_local(&app);
    let choice = local_choice();
    save(&app, &choice)?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
    }
    Ok(choice)
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_navigation, closed_choice, connected_choice, local_choice, origin,
        webview_version_at_least, ServerChoice, ServerRuntime,
    };

    #[test]
    fn only_plain_https_origins() {
        assert!(origin("https://vault.example").is_ok());
        for value in [
            "http://vault.example",
            "https://user@vault.example",
            "https://vault.example/other",
            "https://vault.example/?next=other",
            "https://vault.example/#x",
            "https://vault.example\n",
            "https://vault.exa\tmple",
        ] {
            assert!(origin(value).is_err(), "{value}");
        }
    }

    #[test]
    fn navigation_stays_on_the_exact_origin() {
        let expected = origin("https://vault.example:8443").unwrap().origin();
        for value in [
            "https://vault.example:8443/login",
            "https://vault.example:8443/api/items?next=/vault#entry",
        ] {
            assert!(allowed_navigation(
                &expected,
                &url::Url::parse(value).unwrap()
            ));
        }
        for value in [
            "http://vault.example:8443/",
            "https://vault.example/",
            "https://other.example:8443/",
            "https://user@vault.example:8443/",
        ] {
            assert!(!allowed_navigation(
                &expected,
                &url::Url::parse(value).unwrap()
            ));
        }
    }

    #[test]
    fn remote_window_is_outside_native_capabilities() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("remote").is_none());
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission == "allow-server-disconnect"));
    }

    #[test]
    fn cancelling_invalidates_an_in_flight_connection() {
        let runtime = ServerRuntime::default();
        let first = runtime.begin();
        assert!(runtime.is_current(first));
        runtime.cancel();
        assert!(!runtime.is_current(first));
        let second = runtime.begin();
        assert!(runtime.is_current(second));
        assert!(!runtime.is_current(first));
    }

    #[test]
    fn exit_preserves_selection_while_close_and_lock_clear_it() {
        let runtime = ServerRuntime::default();
        let opening = runtime.begin();
        runtime.mark_exiting();
        assert!(runtime.is_exiting());
        assert!(!runtime.is_current(opening));

        let selected = connected_choice(&origin("https://vault.example").unwrap());
        assert!(selected.selected);
        assert_eq!(selected.origin.as_deref(), Some("https://vault.example/"));
        let closed = closed_choice(selected);
        assert!(!closed.selected);
        assert_eq!(closed.origin.as_deref(), Some("https://vault.example/"));
    }

    #[test]
    fn persisted_choice_contains_only_mode_and_origin() {
        let server = connected_choice(&origin("https://vault.example:8443").unwrap());
        assert_eq!(
            serde_json::to_value(server).unwrap(),
            serde_json::json!({
                "origin": "https://vault.example:8443/",
                "selected": true
            })
        );
        assert_eq!(
            serde_json::to_value(local_choice()).unwrap(),
            serde_json::json!({"origin": null, "selected": true})
        );
        assert!(serde_json::from_value::<ServerChoice>(serde_json::json!({
            "origin": "https://vault.example/",
            "selected": true,
            "password": "must-not-be-accepted"
        }))
        .is_err());
    }

    #[test]
    fn private_webview2_version_gate_fails_closed() {
        assert!(webview_version_at_least(
            "101.0.1210.39",
            &[101, 0, 1210, 39]
        ));
        assert!(webview_version_at_least("134.0.0.0", &[101, 0, 1210, 39]));
        assert!(!webview_version_at_least(
            "101.0.1210.38",
            &[101, 0, 1210, 39]
        ));
        assert!(!webview_version_at_least("invalid", &[101, 0, 1210, 39]));
    }
}
