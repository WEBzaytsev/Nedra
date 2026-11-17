use crate::sidecar::Supervisor;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use zeroize::Zeroize;

const SECRET_BYTES: usize = 32;
const MAX_MATERIAL_BYTES: usize = 2048;
const CORE_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(target_os = "macos")]
extern "C" {
    fn nedra_biometric_available() -> i32;
    fn nedra_biometric_enroll(
        material: *mut u8,
        capacity: usize,
        length: *mut usize,
        secret: *mut u8,
    ) -> i32;
    fn nedra_biometric_derive(material: *const u8, length: usize, secret: *mut u8) -> i32;
}

#[cfg(target_os = "macos")]
fn outcome(code: i32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        1 => Err("Touch ID was cancelled.".into()),
        2 => Err("This Touch ID enrollment is no longer valid.".into()),
        3 => Err("Touch ID is unavailable on this Mac.".into()),
        _ => Err("Touch ID failed.".into()),
    }
}

#[cfg(target_os = "macos")]
fn enroll_now() -> Result<(Vec<u8>, [u8; SECRET_BYTES]), String> {
    let mut material = vec![0u8; MAX_MATERIAL_BYTES];
    let mut length = 0usize;
    let mut secret = [0u8; SECRET_BYTES];
    outcome(unsafe {
        nedra_biometric_enroll(
            material.as_mut_ptr(),
            material.len(),
            &mut length,
            secret.as_mut_ptr(),
        )
    })?;
    if length == 0 || length > material.len() {
        secret.zeroize();
        return Err("Touch ID returned invalid enrollment data.".into());
    }
    material.truncate(length);
    Ok((material, secret))
}

#[cfg(target_os = "macos")]
fn derive_now(material: &[u8]) -> Result<[u8; SECRET_BYTES], String> {
    if material.is_empty() || material.len() > MAX_MATERIAL_BYTES {
        return Err("This Touch ID enrollment is invalid.".into());
    }
    let mut secret = [0u8; SECRET_BYTES];
    let result = outcome(unsafe {
        nedra_biometric_derive(material.as_ptr(), material.len(), secret.as_mut_ptr())
    });
    if result.is_err() {
        secret.zeroize();
    }
    result.map(|_| secret)
}

#[cfg(not(target_os = "macos"))]
fn enroll_now() -> Result<(Vec<u8>, [u8; SECRET_BYTES]), String> {
    Err("Touch ID is available only on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
fn derive_now(_material: &[u8]) -> Result<[u8; SECRET_BYTES], String> {
    Err("Touch ID is available only on macOS.".into())
}

async fn native_call(
    core: &Supervisor,
    operation: &str,
    session: Option<&str>,
    body: Vec<u8>,
) -> Result<Value, String> {
    if session.is_some_and(|token| token.len() != 43) {
        return Err("Unlock your vault first.".into());
    }
    let mut header = json!({"native": operation});
    if let Some(token) = session {
        header["session"] = Value::String(token.to_owned());
    }
    let (reply, data) = core
        .request(header, body, CORE_TIMEOUT, None)
        .await
        .map_err(|_| "The desktop core did not finish the Touch ID operation.".to_string())?;
    let result: Value = serde_json::from_slice(&data)
        .map_err(|_| "The desktop core returned an invalid Touch ID response.".to_string())?;
    if reply["status"].as_u64() != Some(200) {
        return Err(result["detail"]
            .as_str()
            .unwrap_or("The Touch ID operation failed.")
            .to_string());
    }
    Ok(result)
}

async fn native_secret_call(
    core: &Supervisor,
    operation: &str,
    session: Option<&str>,
    mut body: Value,
    mut secret: [u8; SECRET_BYTES],
) -> Result<Value, String> {
    let mut encoded = URL_SAFE_NO_PAD.encode(secret);
    secret.zeroize();
    body["secret"] = Value::String(std::mem::take(&mut encoded));
    let bytes = serde_json::to_vec(&body).map_err(|_| "Invalid Touch ID request.".to_string())?;
    if let Some(Value::String(mut value)) = body
        .as_object_mut()
        .and_then(|object| object.remove("secret"))
    {
        value.zeroize();
    }
    native_call(core, operation, session, bytes).await
}

#[tauri::command]
pub fn biometric_available() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { nedra_biometric_available() } == 1;
    #[cfg(not(target_os = "macos"))]
    return false;
}

#[tauri::command]
pub async fn biometric_status(
    session: String,
    core: State<'_, Arc<Supervisor>>,
) -> Result<Value, String> {
    native_call(&core, "biometric_status", Some(&session), Vec::new()).await
}

#[tauri::command]
pub async fn biometric_login_options(
    username: String,
    core: State<'_, Arc<Supervisor>>,
) -> Result<Value, String> {
    if username.len() > 255 {
        return Err("Invalid username.".into());
    }
    let body = serde_json::to_vec(&json!({"username": username}))
        .map_err(|_| "Invalid Touch ID request.".to_string())?;
    native_call(&core, "biometric_login_options", None, body).await
}

#[tauri::command]
pub async fn biometric_enroll(
    session: String,
    name: String,
    current_password: String,
    security_key_assertion: Option<Value>,
    core: State<'_, Arc<Supervisor>>,
) -> Result<Value, String> {
    if name.trim().is_empty() || name.len() > 64 || current_password.len() > 4096 {
        return Err("Invalid Touch ID enrollment details.".into());
    }
    let (material, secret) = tauri::async_runtime::spawn_blocking(enroll_now)
        .await
        .map_err(|_| "Touch ID failed.".to_string())??;
    native_secret_call(
        &core,
        "biometric_enroll",
        Some(&session),
        json!({
            "name": name.trim(),
            "current_password": current_password,
            "material": URL_SAFE_NO_PAD.encode(material),
            "security_key_assertion": security_key_assertion,
        }),
        secret,
    )
    .await
}

#[tauri::command]
pub async fn biometric_login(
    username: String,
    device_id: i64,
    password: Option<String>,
    security_key_assertion: Option<Value>,
    core: State<'_, Arc<Supervisor>>,
) -> Result<Value, String> {
    if username.len() > 255
        || device_id <= 0
        || password.as_ref().is_some_and(|value| value.len() > 4096)
    {
        return Err("Invalid Touch ID login details.".into());
    }
    let material_reply = native_call(
        &core,
        "biometric_material",
        None,
        serde_json::to_vec(&json!({"username": username, "device_id": device_id}))
            .map_err(|_| "Invalid Touch ID request.".to_string())?,
    )
    .await?;
    let material = material_reply["material"]
        .as_str()
        .ok_or("Touch ID is not enrolled for this account.")?;
    if material.len() > MAX_MATERIAL_BYTES * 2 {
        return Err("This Touch ID enrollment is invalid.".into());
    }
    let material = URL_SAFE_NO_PAD
        .decode(material)
        .map_err(|_| "This Touch ID enrollment is invalid.".to_string())?;
    let secret = tauri::async_runtime::spawn_blocking(move || derive_now(&material))
        .await
        .map_err(|_| "Touch ID failed.".to_string())??;
    native_secret_call(
        &core,
        "biometric_login",
        None,
        json!({
            "username": username,
            "device_id": device_id,
            "password": password,
            "security_key_assertion": security_key_assertion,
        }),
        secret,
    )
    .await
}

#[tauri::command]
pub async fn biometric_remove(
    session: String,
    id: i64,
    core: State<'_, Arc<Supervisor>>,
) -> Result<Value, String> {
    if id <= 0 {
        return Err("Invalid Touch ID enrollment.".into());
    }
    native_call(
        &core,
        "biometric_remove",
        Some(&session),
        serde_json::to_vec(&json!({"id": id}))
            .map_err(|_| "Invalid Touch ID request.".to_string())?,
    )
    .await
}
