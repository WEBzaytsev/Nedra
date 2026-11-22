use crate::{clipboard::Clipboard, sidecar::Supervisor};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static POLICY: Mutex<Policy> = Mutex::new(Policy {
    epoch: 0,
    deadline: None,
    hidden_since: None,
    hidden_ms: 60_000,
});

struct Policy {
    epoch: u64,
    deadline: Option<Instant>,
    hidden_since: Option<Instant>,
    hidden_ms: u64,
}

pub fn epoch() -> u64 {
    POLICY.lock().unwrap().epoch
}

pub fn observe(epoch: u64, sent_at: Instant, head: &serde_json::Value, settings: Option<&[u8]>) {
    let mut policy = POLICY.lock().unwrap();
    if policy.epoch != epoch {
        return;
    }
    if let Some(ms) = head["session"]["expires_in_ms"].as_u64() {
        policy.deadline = Some(sent_at + Duration::from_millis(ms.min(43_200_000)));
    }
    if head["status"].as_u64() == Some(200) {
        if let Some(body) = settings {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
                if let Some(ms) = value["hidden_ms"].as_u64() {
                    policy.hidden_ms = ms;
                }
            }
        }
    }
}

impl Policy {
    fn expired(&mut self, now: Instant, hidden: bool) -> bool {
        let Some(deadline) = self.deadline else {
            return false;
        };
        if hidden {
            self.hidden_since.get_or_insert(now);
        } else {
            self.hidden_since = None;
        }
        now >= deadline
            || self.hidden_since.is_some_and(|since| {
                now.duration_since(since).as_millis() >= self.hidden_ms as u128
            })
    }
}
#[cfg(target_os = "macos")]
extern "C" {
    fn nedra_observe_lock(callback: extern "C" fn());
}
pub(super) extern "C" fn lock() {
    if let Some(app) = APP.get() {
        crate::server::disconnect_on_lock(app);
        lock_local(app);
    }
}

pub(crate) fn lock_local(app: &tauri::AppHandle) {
    reset_renderer(app);
    finish_local_lock(app);
}

pub(crate) fn lock_local_for_server(app: &tauri::AppHandle) {
    reset_renderer_state(app);
    finish_local_lock(app);
}

fn finish_local_lock(app: &tauri::AppHandle) {
    app.state::<Arc<Clipboard>>().clear();
    app.state::<Arc<Supervisor>>().lock();
    let _ = app.emit("vault-locked", ());
}
pub fn install(app: tauri::AppHandle) {
    let _ = APP.set(app);
    #[cfg(target_os = "macos")]
    unsafe {
        nedra_observe_lock(lock);
    }

    std::thread::spawn(|| {
        let mut previous = std::time::SystemTime::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = std::time::SystemTime::now();
            if now.duration_since(previous).unwrap_or_default().as_secs() > 8 {
                lock();
            }
            previous = now;
            if let Some(app) = APP.get() {
                let hidden = app.get_webview_window("main").is_some_and(|window| {
                    !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
                });
                let expired = POLICY.lock().unwrap().expired(Instant::now(), hidden);
                if expired {
                    lock();
                }
            }
        }
    });
}

#[tauri::command]
pub fn vault_lock() {
    lock();
}

pub fn reset_renderer(app: &tauri::AppHandle) {
    reset_renderer_state(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        if let Ok(mut url) = window.url() {
            url.set_path("/login");
            url.set_query(None);
            url.set_fragment(None);
            let _ = window.navigate(url);
        }
    }
}

fn reset_renderer_state(app: &tauri::AppHandle) {
    {
        let mut policy = POLICY.lock().unwrap();
        policy.epoch += 1;
        policy.deadline = None;
        policy.hidden_since = None;
    }
    if let Some(files) = app.try_state::<crate::native::Files>() {
        files.invalidate();
    }
    if let Some(extension) = app.try_state::<Arc<crate::extension::Extension>>() {
        extension.on_lock();
    }
    if let Some(keys) = app.try_state::<Arc<crate::security_key::SecurityKeys>>() {
        keys.cancel();
    }
}
