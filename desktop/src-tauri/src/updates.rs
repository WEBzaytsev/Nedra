//! Fixed-source, opt-in installation. No updater plugin permissions reach JS.
use base64::Engine;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://github.com/WEBzaytsev/Nedra/releases";
const CHECK_ERROR: &str = "Could not check GitHub for updates. Your vault is still available.";

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    operation: tokio::sync::Mutex<()>,
    // 0 idle, 1 downloading (cancelable), 2 installing (not cancelable).
    phase: AtomicU8,
    cancel: tokio::sync::Notify,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current: String,
    latest: Option<String>,
    release_url: String,
    notes: Option<String>,
    update_available: bool,
    can_install: bool,
}

fn target() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn filenames(version: &str) -> [String; 2] {
    let suffix = if cfg!(target_os = "macos") {
        "app.tar.gz"
    } else if cfg!(windows) {
        "exe"
    } else {
        "AppImage"
    };
    let target = target();
    [
        format!("Nedra_{version}_{target}.{suffix}"),
        format!("CipherMoth_{version}_{target}.{suffix}"),
    ]
}

fn validate(update: &Update) -> Result<(), String> {
    let newer = semver::Version::parse(&update.version).map_err(|_| CHECK_ERROR)?;
    let current = semver::Version::parse(&update.current_version).map_err(|_| CHECK_ERROR)?;
    if newer <= current || !newer.pre.is_empty() || !newer.build.is_empty() {
        return Err("Only newer stable releases can be installed.".into());
    }
    let names = filenames(&update.version);
    let selected = names
        .iter()
        .find(|name| {
            update.download_url.as_str()
                == format!("{RELEASES}/download/v{}/{name}", update.version)
        })
        .ok_or_else(|| "The update does not match the official platform release.".to_string())?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(update.signature.trim())
        .map_err(|_| "Invalid update signature.")?;
    let text = std::str::from_utf8(&decoded).map_err(|_| "Invalid update signature.")?;
    let signature =
        minisign_verify::Signature::decode(text).map_err(|_| "Invalid update signature.")?;
    // This comment becomes trusted only after Update::download verifies its
    // global signature. Repeat this check after download before installation.
    let signed_file = signature
        .trusted_comment()
        .split('\t')
        .find_map(|s| s.strip_prefix("file:"));
    if signed_file != Some(selected.as_str()) {
        return Err("The signed update is for a different platform.".into());
    }
    Ok(())
}

fn can_install(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        app.env().appimage.is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        true
    }
}

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Status, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    *state.pending.lock().unwrap() = None;
    let builder = app
        .updater_builder()
        .target(target())
        .timeout(Duration::from_secs(20))
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(600))
                .https_only(true)
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let url = attempt.url();
                    if attempt.previous().len() < 5
                        && url.scheme() == "https"
                        && matches!(
                            url.host_str(),
                            Some(
                                "github.com"
                                    | "release-assets.githubusercontent.com"
                                    | "objects.githubusercontent.com"
                            )
                        )
                    {
                        attempt.follow()
                    } else {
                        attempt.error("Update redirect outside GitHub Releases")
                    }
                }))
        });
    #[cfg(feature = "gui-test")]
    let builder = crate::qa::update_builder(builder)?;
    let updater = builder.build().map_err(|_| CHECK_ERROR)?;
    let update = updater.check().await.map_err(|error| {
        #[cfg(feature = "gui-test")]
        eprintln!("QA updater check: {error:?}");
        let _ = error;
        CHECK_ERROR
    })?;
    if let Some(ref update) = update {
        validate(update)?;
    }
    let status = Status {
        current: app.package_info().version.to_string(),
        latest: update.as_ref().map(|u| u.version.clone()),
        release_url: update
            .as_ref()
            .map(|u| format!("{RELEASES}/tag/v{}", u.version))
            .unwrap_or_else(|| format!("{RELEASES}/latest")),
        notes: update
            .as_ref()
            .and_then(|u| u.body.as_ref().map(|s| s.chars().take(2000).collect())),
        update_available: update.is_some(),
        can_install: can_install(&app),
    };
    *state.pending.lock().unwrap() = update;
    Ok(status)
}

#[tauri::command]
pub fn update_cancel(state: tauri::State<'_, Updates>) -> Result<(), String> {
    if state
        .phase
        .compare_exchange(1, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        state.cancel.notify_one();
        Ok(())
    } else {
        Err("There is no cancelable download.".into())
    }
}

#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<(), String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    if !can_install(&app) {
        return Err("Use the Debian package manager to update this installation.".into());
    }
    let update = state
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("Check for updates first.")?;
    validate(&update)?;
    // Consume a previous cancellation permit before starting another download.
    let _ = tokio::time::timeout(Duration::from_millis(1), state.cancel.notified()).await;
    state.phase.store(1, Ordering::SeqCst);
    let mut downloaded = 0u64;
    let result = tokio::select! {
        biased;
        _ = state.cancel.notified() => Err("Update canceled. Your installed application is unchanged.".to_string()),
        result = download_update(&update, &app, &mut downloaded) => result,
    };
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            state.phase.store(0, Ordering::SeqCst);
            return Err(error);
        }
    };
    if let Err(error) = validate(&update) {
        state.phase.store(0, Ordering::SeqCst);
        return Err(error);
    }
    if state
        .phase
        .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Update canceled. Your installed application is unchanged.".into());
    }
    let _ = app.emit("update-installing", ());
    // Download/signature failures never disturb the active vault. Once verified,
    // remove plaintext DOM/grants, clear owned clipboard and stop Python before
    // replacing any files (Windows exits directly from the plugin installer).
    crate::lock::reset_renderer(&app);
    app.state::<Arc<crate::clipboard::Clipboard>>().clear();
    app.state::<Arc<crate::sidecar::Supervisor>>().shutdown();
    let result = update.install(bytes);
    if result.is_err() {
        #[cfg(feature = "gui-test")]
        if std::env::var_os("NEDRA_QA_UPDATE_ENDPOINT").is_some() {
            // Report the real installer's failure without an unattended dialog.
            if let Ok(root) = std::env::var("NEDRA_QA_ROOT") {
                let _ = std::fs::write(std::path::Path::new(&root).join("install-failed"), b"true");
            }
            app.restart();
        }
        let _ = rfd::AsyncMessageDialog::new().set_title("Nedra update")
            .set_description("The update could not be installed. Nedra will reopen. Your vault has not been replaced.")
            .set_level(rfd::MessageLevel::Error).show().await;
    }
    app.restart();
}

async fn download_update(
    update: &Update,
    app: &tauri::AppHandle,
    downloaded: &mut u64,
) -> Result<Vec<u8>, String> {
    #[cfg(feature = "gui-test")]
    let update = &crate::qa::update_download(update)?;
    update.download(|chunk, total| {
            *downloaded += chunk as u64;
            let _ = app.emit("update-progress", serde_json::json!({"downloaded":downloaded,"total":total}));
        }, || {}).await.map_err(|_| "The update could not be downloaded and verified. Your installed application is unchanged.".to_string())
}
