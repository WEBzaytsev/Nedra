"""Exercise the QA .app in a native webview, its real UI, and process lifecycle.

Uses only synthetic data in a required absolute directory. No backend listener,
no browser substitution, no production self-test command.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil


class MemorySampler:
    """RSS includes the process tree and newly started macOS WebKit XPCs.

    XPCs belong to launchd, so capture their PIDs separately and retain the
    attribution scope in the report. RSS can double-count shared pages.
    """

    def __init__(self, pid):
        self.pid = pid
        self.baseline = set(psutil.pids())
        self.stop = threading.Event()
        self.peak = 0
        self.webviews = set()
        self.samples = 0
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while not self.stop.wait(0.1):
            try:
                processes = [psutil.Process(self.pid)]
                processes += processes[0].children(recursive=True)
                if __import__("sys").platform == "darwin":
                    for process in psutil.process_iter(["pid", "name"]):
                        if process.pid not in self.baseline and "com.apple.WebKit." in (
                            process.info["name"] or ""
                        ):
                            processes.append(process)
                            self.webviews.add(process.pid)
                rss = 0
                for process in {p.pid: p for p in processes}.values():
                    try:
                        rss += process.memory_info().rss
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                self.peak = max(self.peak, rss)
                self.samples += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

    def finish(self):
        self.stop.set()
        self.thread.join(2)
        return {
            "peak_total_rss": self.peak,
            "samples": self.samples,
            "macos_new_webkit_pids": sorted(self.webviews),
            "scope": (
                "process tree plus WebKit XPCs started during this isolated launch; "
                "RSS includes shared pages"
            ),
        }


def send_windows_key(process, virtual_key=None):
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.__dict__["windll"].user32
    windows = []
    callback_type = ctypes.__dict__["WINFUNCTYPE"](
        ctypes.c_bool, wintypes.HWND, wintypes.LPARAM
    )
    user32.GetWindowThreadProcessId.argtypes = (
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    )
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = (wintypes.HWND,)
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
    user32.ShowWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = (wintypes.HWND,)
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.AttachThreadInput.argtypes = (
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.BOOL,
    )
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.SetFocus.argtypes = (wintypes.HWND,)
    user32.SetFocus.restype = wintypes.HWND
    user32.PeekMessageW.argtypes = (
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
        wintypes.UINT,
    )
    user32.PeekMessageW.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)
    user32.SetCursorPos.restype = wintypes.BOOL
    user32.ChildWindowFromPointEx.argtypes = (
        wintypes.HWND,
        wintypes.POINT,
        wintypes.UINT,
    )
    user32.ChildWindowFromPointEx.restype = wintypes.HWND
    user32.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
    user32.GetAncestor.restype = wintypes.HWND
    user32.ScreenToClient.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.POINT))
    user32.ScreenToClient.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = (
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )
    user32.PostMessageW.restype = wintypes.BOOL
    user32.keybd_event.argtypes = (
        wintypes.BYTE,
        wintypes.BYTE,
        wintypes.DWORD,
        ctypes.c_size_t,
    )

    @callback_type
    def collect_window(window, _):
        window_process = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(window_process))
        if window_process.value == process.pid and user32.IsWindowVisible(window):
            windows.append(window)
        return True

    user32.EnumWindows(collect_window, 0)
    assert windows, f"no visible native window for process {process.pid}"

    def window_area(window):
        rectangle = wintypes.RECT()
        if not user32.GetWindowRect(window, ctypes.byref(rectangle)):
            return 0
        return max(0, rectangle.right - rectangle.left) * max(
            0, rectangle.bottom - rectangle.top
        )

    target_window = max(windows, key=window_area)

    def foreground_is_target_process():
        foreground_process = wintypes.DWORD()
        user32.GetWindowThreadProcessId(
            user32.GetForegroundWindow(), ctypes.byref(foreground_process)
        )
        return foreground_process.value == process.pid

    def target_child_at(point):
        window_rect = wintypes.RECT()
        assert user32.GetWindowRect(target_window, ctypes.byref(window_rect)), (
            "could not resolve the native window rectangle"
        )
        assert window_rect.left <= point.x < window_rect.right and (
            window_rect.top <= point.y < window_rect.bottom
        ), "native input point is outside the application window"
        child = target_window
        for _ in range(16):
            local_point = wintypes.POINT(point.x, point.y)
            assert user32.ScreenToClient(child, ctypes.byref(local_point)), (
                "could not translate the native child-window point"
            )
            nested = user32.ChildWindowFromPointEx(child, local_point, 0x0007)
            if not nested or nested == child:
                break
            child = nested
        root = user32.GetAncestor(child, 2)
        root_process = wintypes.DWORD()
        user32.GetWindowThreadProcessId(root, ctypes.byref(root_process))
        assert root == target_window and root_process.value == process.pid, (
            "native input target is not owned by the application process"
        )
        return child

    def post_key_to_target(virtual_key):
        window_rect = wintypes.RECT()
        assert user32.GetWindowRect(target_window, ctypes.byref(window_rect)), (
            "could not resolve the native window rectangle"
        )
        point = wintypes.POINT(
            (window_rect.left + window_rect.right) // 2,
            (window_rect.top + window_rect.bottom) // 2,
        )
        child = target_child_at(point)
        assert user32.PostMessageW(child, 0x0100, virtual_key, 1), (
            "could not post native key down"
        )
        assert user32.PostMessageW(child, 0x0101, virtual_key, 0xC0000001), (
            "could not post native key up"
        )

    def post_pointer_to_target(point):
        native_point = wintypes.POINT(round(point["x"]), round(point["y"]))
        child = target_child_at(native_point)
        assert user32.ScreenToClient(child, ctypes.byref(native_point)), (
            "could not translate the native pointer position"
        )
        position = (native_point.y & 0xFFFF) << 16 | (native_point.x & 0xFFFF)
        assert user32.PostMessageW(child, 0x0201, 1, position), (
            "could not post native pointer down"
        )
        assert user32.PostMessageW(child, 0x0202, 0, position), (
            "could not post native pointer up"
        )

    user32.PeekMessageW(ctypes.byref(wintypes.MSG()), None, 0, 0, 0)
    current_thread = ctypes.__dict__["windll"].kernel32.GetCurrentThreadId()
    target_thread = user32.GetWindowThreadProcessId(target_window, None)
    foreground_thread = user32.GetWindowThreadProcessId(
        user32.GetForegroundWindow(), None
    )
    attached_threads = []
    for thread in {target_thread, foreground_thread} - {0, current_thread}:
        if user32.AttachThreadInput(current_thread, thread, True):
            attached_threads.append(thread)
    try:
        user32.ShowWindow(target_window, 5)
        user32.BringWindowToTop(target_window)
        for _ in range(10):
            user32.SetForegroundWindow(target_window)
            user32.SetFocus(target_window)
            if foreground_is_target_process():
                break
            user32.keybd_event(0x12, 0, 0, 0)
            user32.keybd_event(0x12, 0, 0x0002, 0)
            time.sleep(0.1)
        if not foreground_is_target_process():
            window_rect = wintypes.RECT()
            assert user32.GetWindowRect(target_window, ctypes.byref(window_rect)), (
                "could not resolve the native window rectangle"
            )
            title_x = (window_rect.left + window_rect.right) // 2
            title_y = window_rect.top + 10
            assert user32.SetCursorPos(title_x, title_y), (
                "could not position the native activation pointer"
            )
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.2)
        foreground = foreground_is_target_process()
        if virtual_key is not None:
            if foreground:
                user32.keybd_event(virtual_key, 0, 0, 0)
                user32.keybd_event(virtual_key, 0, 0x0002, 0)
            else:
                post_key_to_target(virtual_key)
        return user32, foreground, post_pointer_to_target
    finally:
        for thread in reversed(attached_threads):
            user32.AttachThreadInput(current_thread, thread, False)


def send_macos_key(process, key_code, option=False):
    flags = ".maskAlternate" if option else "CGEventFlags(rawValue: 0)"
    source = f"""import AppKit
import CoreGraphics
import Foundation
let targetPid = pid_t({process.pid})
guard let app = NSRunningApplication(processIdentifier: targetPid) else {{
    fatalError("Could not resolve the native application")
}}
for _ in 0..<10 {{
    app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid {{
        break
    }}
    Thread.sleep(forTimeInterval: 0.1)
}}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {{
    fatalError("Could not foreground the native application")
}}
guard let down = CGEvent(
    keyboardEventSource: nil,
    virtualKey: CGKeyCode({key_code}),
    keyDown: true
), let up = CGEvent(
    keyboardEventSource: nil,
    virtualKey: CGKeyCode({key_code}),
    keyDown: false
) else {{
    fatalError("Could not create native keyboard events")
}}
down.flags = {flags}
up.flags = {flags}
down.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.03)
up.post(tap: .cghidEventTap)
print("pressed")
"""
    pressed = subprocess.run(
        ["swift", "-e", source],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert pressed.returncode == 0, (
        f"macOS native key activation failed: stdout={pressed.stdout!r} "
        f"stderr={pressed.stderr!r}"
    )
    assert pressed.stdout.strip() == "pressed", pressed.stdout


def advance_bootstrap_focus(report, path, process):
    if sys.platform.startswith("linux"):
        subprocess.run(["xdotool", "key", "Tab"], check=True, timeout=10)
    elif sys.platform == "win32":
        send_windows_key(process, 0x09)
    elif sys.platform == "darwin":
        if not report.get("native_app_input"):
            send_macos_key(process, 48, option=True)
    else:
        raise AssertionError(f"native bootstrap input is unsupported on {sys.platform}")
    (path.parent / (report["ack"] + ".done")).touch()


def scroll_bootstrap(report, path, process):
    down = report["direction"] == "down"
    if sys.platform.startswith("linux"):
        subprocess.run(
            ["xdotool", "key", "Page_Down" if down else "Page_Up"],
            check=True,
            timeout=10,
        )
    elif sys.platform == "win32":
        send_windows_key(process, 0x22 if down else 0x21)
    elif sys.platform == "darwin":
        send_macos_key(process, 121 if down else 116)
    else:
        raise AssertionError(f"native bootstrap input is unsupported on {sys.platform}")
    (path.parent / (report["ack"] + ".done")).touch()


def acknowledge_bootstrap(report, path, process):
    print(
        "native bootstrap activation: "
        + json.dumps(
            {
                "focused": report.get("focused"),
                "screen_pixel": report.get("screen_pixel"),
                "screen_point": report.get("screen_point"),
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    if sys.platform == "darwin" and (
        report.get("focused") or report.get("screen_point")
    ):
        # The QA app sends one process-local NSEvent after receiving this acknowledgement.
        pass
    elif report.get("focused") and sys.platform.startswith("linux"):
        subprocess.run(["xdotool", "key", "space"], check=True, timeout=10)
    elif report.get("focused") and sys.platform == "win32":
        send_windows_key(process, 0x20)
    elif sys.platform == "win32" and report.get("screen_pixel"):
        point = report["screen_pixel"]
        user32, foreground, post_pointer_to_target = send_windows_key(process)
        if foreground:
            assert user32.SetCursorPos(round(point["x"]), round(point["y"])), (
                "could not position the native pointer"
            )
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
        else:
            post_pointer_to_target(point)
    else:
        raise AssertionError(
            f"native bootstrap control is neither focused nor visible on {sys.platform}"
        )
    # Native key and pointer events are queued after the host call returns.
    # Do not release the renderer before the WebView has processed the event.
    time.sleep(0.5)
    (path.parent / (report["ack"] + ".done")).touch()


def wait_report(
    path,
    process,
    timeout=240,
    dialogs=False,
    started=None,
    app_executable=None,
    extension_results=None,
):
    started = started or time.monotonic()
    interactive = None
    initial_core = None
    deadline = time.monotonic() + timeout
    stages = set()
    while time.monotonic() < deadline:
        if path.exists():
            try:
                report = json.loads(path.read_text(encoding="utf-8"))
            except (PermissionError, json.JSONDecodeError):
                time.sleep(0.05)
                continue
            stage = report.get("stage")
            stage_key = report.get("ack", stage)
            if stage == "bootstrap_focus_step" and stage_key not in stages:
                stages.add(stage_key)
                advance_bootstrap_focus(report, path, process)
            if stage == "bootstrap_scroll_step" and stage_key not in stages:
                stages.add(stage_key)
                scroll_bootstrap(report, path, process)
            if stage == "bootstrap_acknowledgement" and stage_key not in stages:
                stages.add(stage_key)
                acknowledge_bootstrap(report, path, process)
            if (
                stage == "extension_ready"
                and extension_results is not None
                and stage_key not in stages
            ):
                stages.add(stage_key)
                import extension

                extension_results["on"] = extension.check_on(
                    path.parent, report, path, app_executable
                )
            if (
                stage == "extension_on_complete"
                and extension_results is not None
                and stage_key not in stages
            ):
                stages.add(stage_key)
                (path.parent / report["ack"]).with_suffix(".done").touch()
            if (
                stage == "extension_off"
                and extension_results is not None
                and stage_key not in stages
            ):
                stages.add(stage_key)
                import extension

                extension_results["off"] = extension.check_off(path.parent)
                (path.parent / report["ack"]).with_suffix(".done").touch()
            if stage == "interactive" and interactive is None:
                interactive = round(time.monotonic() - started, 3)
                initial_core = report.get("core")
            if stage == "native_idle" and stage not in stages:
                stages.add(stage)
                pid = report["core"]["info"]["pid"]
                idle_deadline = time.monotonic() + 33
                while time.monotonic() < idle_deadline and psutil.pid_exists(pid):
                    try:
                        if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                            break
                    except psutil.NoSuchProcess:
                        break
                    time.sleep(0.1)
                else:
                    assert not psutil.pid_exists(pid), (
                        "idle lock depended on blocked JavaScript timers"
                    )
            if (
                stage
                and stage_key not in stages
                and __import__("sys").platform == "darwin"
            ):
                stages.add(stage_key)
                if stage == "clipboard_timeout":
                    assert (
                        subprocess.check_output(["pbpaste"]).decode()
                        == "Native-clipboard-canary"
                    )
                    subprocess.run(
                        ["osascript", "-e", 'tell application "Finder" to activate'],
                        check=True,
                    )
                    clipboard_deadline = time.monotonic() + 3
                    while (
                        time.monotonic() < clipboard_deadline
                        and subprocess.check_output(["pbpaste"]) != b""
                    ):
                        time.sleep(0.1)
                    assert subprocess.check_output(["pbpaste"]) == b"", (
                        "native clipboard did not clear in background"
                    )
                elif stage == "clipboard_replaced":
                    subprocess.run(["pbcopy"], input=b"User replacement", check=True)
                    time.sleep(1.3)
                    assert (
                        subprocess.check_output(["pbpaste"]) == b"User replacement"
                    ), "clipboard replacement erased"
                elif stage in ("backup_save", "backup_open"):
                    assert dialogs, "Build dialog QA only with --dialogs on macOS"
                    # The OS picker authorizes the path; it never enters JS.
                    destination = path.parent / "nedra-backup.cmbackup"
                    script = """on run argv
tell application id "com.nedra.desktop.qa" to activate
delay 1
tell application "System Events"
    tell process "nedra-desktop"
        set frontmost to true
        keystroke "g" using {command down, shift down}
        delay 0.5
        keystroke (item 1 of argv)
        key code 36
        delay 0.8
        key code 36
    end tell
end tell
end run"""
                    if stage == "backup_save":
                        destination.unlink(missing_ok=True)
                    subprocess.run(
                        ["osascript", "-e", script, str(destination)],
                        check=True,
                        timeout=15,
                    )
                if report.get("ack"):
                    # The app cannot start the next clipboard write until the
                    # host has checked this one, even on a slow CI runner.
                    (path.parent / (report["ack"] + ".done")).touch()
            if not stage:
                assert report.get("ok"), report
                report["launch_to_interactive_s"] = interactive
                report["initial_core"] = initial_core
                return report
        if process.poll() is not None:
            raise RuntimeError(f"App exited {process.returncode}")
        time.sleep(0.1)
    raise TimeoutError("Native webview did not report")


def gone(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not psutil.pid_exists(pid):
            return True
        try:
            if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        time.sleep(0.05)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--dialogs", action="store_true")
    args = parser.parse_args()
    assert args.app.is_absolute() and args.root.is_absolute()
    args.root.mkdir(parents=True, exist_ok=True)
    import extension

    prepare_extension = getattr(extension, "prepare", None)
    if not callable(prepare_extension):
        raise TypeError("desktop extension harness has no profile preparation step")
    prepare_extension(args.root)
    report_path = args.root / "webview.json"
    report_path.unlink(missing_ok=True)
    env = {**os.environ, "NEDRA_QA_ROOT": str(args.root)}
    listeners = (
        {
            (str(c.family), str(c.type), str(c.laddr))
            for c in psutil.net_connections(kind="inet")
            if c.status == psutil.CONN_LISTEN
        }
        if __import__("sys").platform.startswith("linux")
        else set()
    )
    started = time.monotonic()
    with (args.root / "shell.log").open("wb") as log:
        app = subprocess.Popen([str(args.app)], env=env, stdout=log, stderr=log)
        sampler = MemorySampler(app.pid)
        extension_results = {}
        try:
            first = wait_report(
                report_path,
                app,
                dialogs=args.dialogs,
                started=started,
                app_executable=args.app,
                extension_results=extension_results,
            )
            first["launch_to_ui_s"] = round(time.monotonic() - started, 3)
            core_pid = first["core"]["info"]["pid"]
            if __import__("sys").platform.startswith("linux"):
                current = {
                    (str(c.family), str(c.type), str(c.laddr))
                    for c in psutil.net_connections(kind="inet")
                    if c.status == psutil.CONN_LISTEN
                }
                assert not current - listeners, (
                    "new listening socket in isolated test namespace"
                )
            first["shell_rss"] = psutil.Process(app.pid).memory_info().rss
            first["core_rss"] = psutil.Process(core_pid).memory_info().rss
            first["memory"] = sampler.finish()
            if not __import__("sys").platform.startswith("linux"):
                assert not [
                    c
                    for c in psutil.Process(core_pid).net_connections()
                    if c.status == psutil.CONN_LISTEN
                ]
            report_path.unlink()
            psutil.Process(core_pid).kill()
            restarted = wait_report(
                report_path,
                app,
                dialogs=args.dialogs,
                app_executable=args.app,
                extension_results=extension_results,
            )
            assert restarted["core"]["generation"] > first["core"]["generation"]
            assert "retrieve password through native IPC" in restarted["checks"]
            new_core = restarted["core"]["info"]["pid"]
            app.kill()
            app.wait(10)
            assert gone(new_core), "orphaned core after shell SIGKILL"
            report_path.unlink()
            started = time.monotonic()
            app = subprocess.Popen([str(args.app)], env=env, stdout=log, stderr=log)
            reopened = wait_report(
                report_path,
                app,
                dialogs=args.dialogs,
                started=started,
                app_executable=args.app,
                extension_results=extension_results,
            )
            assert not reopened["fresh"]
            core_pid = reopened["core"]["info"]["pid"]
            if __import__("sys").platform == "darwin":
                assert (
                    subprocess.check_output(["pbpaste"])
                    == b"Native-quit-clipboard-canary"
                )
                subprocess.run(
                    [
                        "osascript",
                        "-e",
                        'tell application id "com.nedra.desktop.qa" to quit',
                    ],
                    check=True,
                    timeout=10,
                )
            else:
                app.terminate()
            app.wait(10)
            assert gone(core_pid), "orphaned core after quit"
            if __import__("sys").platform == "darwin":
                assert subprocess.check_output(["pbpaste"]) == b"", (
                    "owned clipboard survived quit"
                )
                reopened["clipboard_cleared_on_quit"] = True
            result = {
                "first": first,
                "crash_restart": restarted,
                "reopen": reopened,
                "orphan_checks": True,
                "desktop_extension": extension_results,
            }
            (args.root / "results.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result, indent=2))
        finally:
            sampler.finish()
            if app.poll() is None:
                app.kill()
                app.wait(10)


if __name__ == "__main__":
    main()
