use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

struct Owned {
    value: String,
    deadline: Instant,
    generation: i64,
}
struct Inner {
    clipboard: arboard::Clipboard,
    owned: Option<Owned>,
}
pub struct Clipboard(Mutex<Option<Inner>>);

#[cfg(target_os = "macos")]
extern "C" {
    fn nedra_clipboard_generation() -> std::ffi::c_long;
}
fn generation() -> i64 {
    #[cfg(target_os = "macos")]
    {
        unsafe { nedra_clipboard_generation() as i64 }
    }
    #[cfg(windows)]
    {
        unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() as i64 }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        0
    }
}
impl Clipboard {
    pub fn start() -> Arc<Self> {
        let state = Arc::new(Self(Mutex::new(None)));
        let worker = state.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            let mut state = worker.0.lock().unwrap();
            if let Some(inner) = state.as_mut() {
                if inner
                    .owned
                    .as_ref()
                    .is_some_and(|owned| Instant::now() >= owned.deadline)
                {
                    clear_owned(inner);
                }
            }
        });
        state
    }
    pub fn clear(&self) {
        if let Some(inner) = self.0.lock().unwrap().as_mut() {
            clear_owned(inner);
        }
    }
}
fn clear_owned(inner: &mut Inner) {
    if let Some(owned) = inner.owned.take() {
        if generation() == owned.generation
            && inner.clipboard.get_text().ok().as_deref() == Some(&owned.value)
        {
            let _ = inner.clipboard.clear();
        }
    }
}
#[tauri::command]
pub fn clipboard_write(
    value: String,
    timeout_ms: u64,
    clipboard: State<'_, Arc<Clipboard>>,
) -> Result<(), String> {
    if value.len() > 1024 * 1024 {
        return Err("Text is too large to copy.".into());
    }
    let mut state = clipboard.0.lock().unwrap();
    if state.is_none() {
        *state = Some(Inner {
            clipboard: arboard::Clipboard::new().map_err(|_| "Clipboard is unavailable.")?,
            owned: None,
        });
    }
    let inner = state.as_mut().unwrap();
    let set = inner.clipboard.set();
    #[cfg(target_os = "macos")]
    let set = {
        use arboard::SetExtApple;
        set.exclude_from_history()
    };
    #[cfg(windows)]
    let set = {
        use arboard::SetExtWindows;
        set.exclude_from_monitoring()
    };
    set.text(value.clone())
        .map_err(|_| "Could not copy to the clipboard.")?;
    inner.owned = Some(Owned {
        value,
        generation: generation(),
        deadline: Instant::now() + Duration::from_millis(timeout_ms.clamp(1000, 300_000)),
    });
    Ok(())
}
#[tauri::command]
pub fn clipboard_clear(clipboard: State<'_, Arc<Clipboard>>) {
    clipboard.clear();
}
