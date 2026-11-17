//! logind sleep/session-lock and common desktop screen saver notifications.
use zbus::blocking::{Connection, Proxy};

pub fn install() {
    std::thread::spawn(|| {
        let _ = watch_sleep();
    });
    std::thread::spawn(|| {
        let _ = watch_session();
    });
    for (service, path) in [
        (
            "org.freedesktop.ScreenSaver",
            "/org/freedesktop/ScreenSaver",
        ),
        ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
    ] {
        std::thread::spawn(move || {
            let _ = watch_screensaver(service, path);
        });
    }
}
fn watch_sleep() -> zbus::Result<()> {
    let bus = Connection::system()?;
    let proxy = Proxy::new(
        &bus,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    for message in proxy.receive_signal("PrepareForSleep")? {
        if message.body().deserialize::<(bool,)>()?.0 {
            super::lock::lock();
        }
    }
    Ok(())
}
fn watch_session() -> zbus::Result<()> {
    let bus = Connection::system()?;
    let manager = Proxy::new(
        &bus,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    let path: zbus::zvariant::OwnedObjectPath =
        manager.call("GetSessionByPID", &(std::process::id(),))?;
    let session = Proxy::new(
        &bus,
        "org.freedesktop.login1",
        path,
        "org.freedesktop.login1.Session",
    )?;
    for _ in session.receive_signal("Lock")? {
        super::lock::lock();
    }
    Ok(())
}
fn watch_screensaver(service: &str, path: &str) -> zbus::Result<()> {
    let bus = Connection::session()?;
    let proxy = Proxy::new(&bus, service, path, service)?;
    for message in proxy.receive_signal("ActiveChanged")? {
        if message.body().deserialize::<(bool,)>()?.0 {
            super::lock::lock();
        }
    }
    Ok(())
}
