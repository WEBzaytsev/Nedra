//! Session and power notifications on the app's native window.
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

unsafe extern "system" fn notification(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    // WM_WTSSESSION_CHANGE: WTS_SESSION_LOCK / LOGOFF / DISCONNECT
    // WM_POWERBROADCAST: PBT_APMSUSPEND
    if (msg == 0x02b1 && [0x7, 0x6, 0x4, 0x2].contains(&wparam)) || (msg == 0x0218 && wparam == 4) {
        super::lock::lock();
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

pub fn install(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?.0 as HWND;
    unsafe {
        if SetWindowSubclass(hwnd, Some(notification), 1, 0) == 0
            || WTSRegisterSessionNotification(hwnd, 0) == 0
        {
            return Err("Could not register Windows session locking".into());
        }
    }
    Ok(())
}
