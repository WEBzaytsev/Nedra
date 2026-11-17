//! Compiled only into the separately identified native QA artifact.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn nedra_qa_click(x: f64, y: f64) -> bool;
    fn nedra_qa_tab() -> bool;
}

#[cfg(target_os = "macos")]
fn activate_bootstrap_control(result: &serde_json::Value) -> Result<(), String> {
    if result["stage"].as_str() == Some("bootstrap_focus_step") {
        return if unsafe { nedra_qa_tab() } {
            Ok(())
        } else {
            Err("Could not deliver the native QA focus event".into())
        };
    }
    if result["stage"].as_str() != Some("bootstrap_acknowledgement") {
        return Ok(());
    }
    let center = &result["control_center"];
    let x = center["x"].as_f64().ok_or("QA control x is missing")?;
    let y = center["y"].as_f64().ok_or("QA control y is missing")?;
    if unsafe { nedra_qa_click(x, y) } {
        Ok(())
    } else {
        Err("Could not deliver the native QA pointer event".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn activate_bootstrap_control(_: &serde_json::Value) -> Result<(), String> {
    Ok(())
}

pub fn restore_launch_environment() {
    // LaunchServices restarts preserve argv, not the test host's environment.
    // These flags exist only in isolated QA binaries, never production.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let name = match arg.as_str() {
            "--qa-root" => "NEDRA_QA_ROOT",
            "--qa-update-endpoint" => "NEDRA_QA_UPDATE_ENDPOINT",
            "--qa-update-ca" => "NEDRA_QA_UPDATE_CA",
            _ => continue,
        };
        if let Some(value) = args.next() {
            std::env::set_var(name, value);
        }
    }
}

pub fn update_builder(
    builder: tauri_plugin_updater::UpdaterBuilder,
) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
    let Ok(endpoint) = std::env::var("NEDRA_QA_UPDATE_ENDPOINT") else {
        return Ok(builder);
    };
    let url = url::Url::parse(&endpoint).map_err(|_| "Invalid QA endpoint")?;
    if url.scheme() != "https" || url.host_str() != Some("localhost") {
        return Err("QA requires local HTTPS".into());
    }
    let pem = std::fs::read(std::env::var("NEDRA_QA_UPDATE_CA").map_err(|_| "Missing QA CA")?)
        .map_err(|_| "Missing QA CA")?;
    let cert = reqwest::Certificate::from_pem(&pem).map_err(|_| "Invalid QA CA")?;
    builder
        .endpoints(vec![url])
        .map(|b| {
            b.configure_client(move |c| {
                c.add_root_certificate(cert.clone())
                    .https_only(true)
                    .timeout(std::time::Duration::from_secs(30))
            })
        })
        .map_err(|_| "Invalid QA endpoint".into())
}

pub fn update_download(
    update: &tauri_plugin_updater::Update,
) -> Result<tauri_plugin_updater::Update, String> {
    let mut update = update.clone();
    if let Ok(endpoint) = std::env::var("NEDRA_QA_UPDATE_ENDPOINT") {
        let mut url = url::Url::parse(&endpoint).map_err(|_| "Invalid QA endpoint")?;
        url.set_path(update.download_url.path());
        update.download_url = url;
    }
    Ok(update)
}

fn update_request_paths(
    root: &std::path::Path,
    id: &str,
) -> (std::path::PathBuf, std::path::PathBuf) {
    let request = root.join(format!("update-request-{id}.json"));
    (request.with_extension("partial"), request)
}

#[tauri::command]
pub async fn qa_update_step(
    result: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let root =
        std::path::PathBuf::from(std::env::var("NEDRA_QA_ROOT").map_err(|_| "Missing QA root")?);
    let id = uuid::Uuid::new_v4().to_string();
    let response = root.join(format!("update-{id}.json"));
    let request = serde_json::json!({"id":id,"version":app.package_info().version.to_string(),"pid":std::process::id(),"core":app.state::<std::sync::Arc<crate::sidecar::Supervisor>>().status(),"result":result});
    let (partial, request_path) = update_request_paths(&root, &id);
    std::fs::write(&partial, serde_json::to_vec(&request).unwrap())
        .map_err(|_| "QA write failed")?;
    std::fs::rename(partial, request_path).map_err(|_| "QA write failed")?;
    for _ in 0..2400 {
        if response.exists() {
            let bytes = std::fs::read(&response).map_err(|_| "QA read failed")?;
            std::fs::remove_file(response).map_err(|_| "QA cleanup failed")?;
            return serde_json::from_slice(&bytes).map_err(|_| "Invalid QA response".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("QA host timed out".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn concurrent_update_reports_use_distinct_paths() {
        let root = std::path::Path::new("qa");
        let (first_partial, first_request) = super::update_request_paths(root, "first");
        let (second_partial, second_request) = super::update_request_paths(root, "second");
        assert_ne!(first_partial, second_partial);
        assert_ne!(first_request, second_request);
    }
}

#[tauri::command]
pub async fn qa_backup(
    operation: String,
    session: String,
    password: String,
    core: tauri::State<'_, std::sync::Arc<crate::sidecar::Supervisor>>,
) -> Result<serde_json::Value, String> {
    if !["backup_export", "backup_import"].contains(&operation.as_str()) {
        return Err("Invalid QA operation".into());
    }
    let root =
        std::path::PathBuf::from(std::env::var("NEDRA_QA_ROOT").map_err(|_| "QA root missing")?);
    let path = root.join("transport.nedrabackup");
    // Fixed synthetic destination authorized by the test host. This exercises
    // the real native transfer, separately from optional OS-picker automation.
    let result = crate::native::file_request(
        &core,
        &operation,
        path.clone(),
        session,
        serde_json::json!({"master_password": password, "on_conflict": "skip"}),
    )
    .await?;
    Ok(
        serde_json::json!({"result": result, "bytes": std::fs::metadata(path).map_err(|_| "Missing backup")?.len()}),
    )
}

#[tauri::command]
pub async fn qa_report(mut result: serde_json::Value, window: tauri::Window) -> Result<(), String> {
    let root = std::env::var("NEDRA_QA_ROOT").map_err(|_| "QA root missing")?;
    let root = std::path::Path::new(&root);
    #[cfg(target_os = "macos")]
    if result["stage"].as_str() == Some("bootstrap_focus_step") {
        result["native_app_input"] = serde_json::json!(true);
    }
    if result["stage"].as_str() == Some("bootstrap_acknowledgement")
        && result["control_center"].is_object()
    {
        let control_x = result["control_center"]["x"]
            .as_f64()
            .ok_or("QA control x is missing")?;
        let control_y = result["control_center"]["y"]
            .as_f64()
            .ok_or("QA control y is missing")?;
        let scale = window
            .scale_factor()
            .map_err(|_| "Could not read QA window scale")?;
        let inner = window
            .inner_position()
            .map_err(|_| "Could not read QA webview position")?;
        let logical = inner.to_logical::<f64>(scale);
        result["screen_point"] = serde_json::json!({
            "x": logical.x + control_x,
            "y": logical.y + control_y,
        });
        result["screen_pixel"] = serde_json::json!({
            "x": f64::from(inner.x) + control_x * scale,
            "y": f64::from(inner.y) + control_y * scale,
        });
    }
    let ack = if (cfg!(target_os = "macos")
        && [Some("clipboard_timeout"), Some("clipboard_replaced")]
            .contains(&result["stage"].as_str()))
        || [
            Some("extension_pairing"),
            Some("extension_on_complete"),
            Some("extension_off"),
            Some("bootstrap_focus_step"),
            Some("bootstrap_scroll_step"),
            Some("bootstrap_acknowledgement"),
        ]
        .contains(&result["stage"].as_str())
    {
        let nonce = uuid::Uuid::new_v4().to_string();
        result["ack"] = serde_json::json!(nonce);
        Some(root.join(format!("{nonce}.done")))
    } else {
        None
    };
    std::fs::write(
        root.join("webview.partial"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .map_err(|_| "Could not write QA report")?;
    std::fs::rename(root.join("webview.partial"), root.join("webview.json"))
        .map_err(|_| "Could not publish QA report")?;
    if let Some(ack) = ack {
        for _ in 0..600 {
            if ack.exists() {
                activate_bootstrap_control(&result)?;
                #[cfg(target_os = "macos")]
                if [
                    Some("bootstrap_focus_step"),
                    Some("bootstrap_acknowledgement"),
                ]
                .contains(&result["stage"].as_str())
                {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        if result["stage"].as_str() == Some("bootstrap_focus_step") {
                            200
                        } else {
                            2000
                        },
                    ))
                    .await;
                }
                std::fs::remove_file(ack).map_err(|_| "Could not consume QA acknowledgement")?;
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        return Err("The host did not acknowledge the clipboard check".into());
    }
    Ok(())
}

#[tauri::command]
pub fn qa_lock(app: tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        #[cfg(target_os = "macos")]
        unsafe {
            extern "C" {
                fn nedra_test_sleep_notification();
            }
            nedra_test_sleep_notification();
        }
        #[cfg(not(target_os = "macos"))]
        crate::lock::vault_lock();
    })
    .map_err(|_| "Could not deliver native lock event".into())
}
