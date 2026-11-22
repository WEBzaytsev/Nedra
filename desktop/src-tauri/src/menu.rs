use tauri::AppHandle;

#[cfg(any(target_os = "macos", test))]
fn russian_locale(locale: Option<&str>) -> bool {
    locale
        .map(|value| value.to_ascii_lowercase().starts_with("ru"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
const REPOSITORY: &str = "https://github.com/WEBzaytsev/Nedra";

#[cfg(target_os = "macos")]
fn help_page(id: &str) -> Option<String> {
    match id {
        "help-website" => Some(REPOSITORY.to_string()),
        "help-releases" => Some(format!("{REPOSITORY}/releases")),
        "help-issue" => Some(format!("{REPOSITORY}/issues/new")),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{help_page, AppHandle, REPOSITORY};
    use tauri::menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder,
    };
    use tauri::{Emitter, Manager, Wry};

    pub struct VaultItems(pub Vec<MenuItem<Wry>>);

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let preferred = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|output| {
                output
                    .lines()
                    .map(|line| line.trim().trim_end_matches(',').trim_matches('"'))
                    .find(|line| line.chars().next().is_some_and(char::is_alphabetic))
                    .map(str::to_owned)
            });
        let lang = std::env::var("LANG").ok();
        let russian = super::russian_locale(preferred.as_deref().or(lang.as_deref()));
        let text = |english, russian_text| if russian { russian_text } else { english };
        let mut vault = Vec::new();
        let mut action = |id: &str, text: &str, accelerator: Option<&str>| {
            let mut builder = MenuItemBuilder::with_id(id, text).enabled(false);
            if let Some(keys) = accelerator {
                builder = builder.accelerator(keys);
            }
            let item = builder.build(app)?;
            vault.push(item.clone());
            Ok::<_, tauri::Error>(item)
        };
        let check_updates = action(
            "check-updates",
            text("Check for Updates…", "Проверить обновления…"),
            None,
        )?;
        let settings = action(
            "settings",
            text("Settings…", "Настройки…"),
            Some("CmdOrCtrl+,"),
        )?;
        let lock = action(
            "lock",
            text("Lock Vault", "Заблокировать хранилище"),
            Some("CmdOrCtrl+Shift+L"),
        )?;
        let new_login = action(
            "new-login",
            text("New Login", "Новый вход"),
            Some("CmdOrCtrl+N"),
        )?;
        let new_note = action(
            "new-note",
            text("New Secure Note", "Новая защищённая заметка"),
            Some("CmdOrCtrl+Shift+N"),
        )?;
        let import = action("import", text("Import…", "Импортировать…"), None)?;
        let backup = action(
            "backup",
            text("Back Up Vault…", "Создать резервную копию…"),
            None,
        )?;
        let find = action("find", text("Find…", "Найти…"), Some("CmdOrCtrl+F"))?;
        let trash = action("trash", text("Trash", "Корзина"), None)?;
        let health = action("health", text("Vault Health", "Состояние хранилища"), None)?;
        let theme = MenuItemBuilder::with_id(
            "toggle-theme",
            text("Switch Light/Dark Theme", "Переключить светлую/тёмную тему"),
        )
        .build(app)?;

        let about = AboutMetadataBuilder::new()
            .name(Some("Nedra"))
            .version(Some(app.package_info().version.to_string()))
            .website(Some(REPOSITORY))
            .build();
        let app_menu = SubmenuBuilder::new(app, "Nedra")
            .about(Some(about))
            .separator()
            .item(&check_updates)
            .item(&settings)
            .separator()
            .item(&lock)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let file = SubmenuBuilder::new(app, text("File", "Файл"))
            .item(&new_login)
            .item(&new_note)
            .separator()
            .item(&import)
            .item(&backup)
            .separator()
            .close_window()
            .build()?;
        let edit = SubmenuBuilder::new(app, text("Edit", "Правка"))
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .separator()
            .item(&find)
            .build()?;
        let view = SubmenuBuilder::new(app, text("View", "Вид"))
            .item(&trash)
            .item(&health)
            .separator()
            .item(&theme)
            .separator()
            .fullscreen()
            .build()?;
        let window = SubmenuBuilder::new(app, text("Window", "Окно"))
            .minimize()
            .maximize()
            .separator()
            .close_window()
            .build()?;
        let help = SubmenuBuilder::new(app, text("Help", "Справка"))
            .text("help-website", text("Nedra on GitHub", "Nedra на GitHub"))
            .text(
                "help-releases",
                text("Release Notes", "Примечания к выпуску"),
            )
            .separator()
            .text(
                "help-issue",
                text("Report an Issue…", "Сообщить о проблеме…"),
            )
            .build()?;
        app.set_menu(
            MenuBuilder::new(app)
                .items(&[&app_menu, &file, &edit, &view, &window, &help])
                .build()?,
        )?;
        app.manage(VaultItems(vault));
        app.on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(url) = help_page(id) {
                let _ = crate::native::open_external(url);
            } else {
                let _ = app.emit_to("main", "menu-action", id);
            }
        });
        Ok(())
    }

    pub fn set_unlocked(app: AppHandle, unlocked: bool) {
        if let Some(items) = app.try_state::<VaultItems>() {
            for item in &items.0 {
                let _ = item.set_enabled(unlocked);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    native::install(app)
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn menu_state(app: AppHandle, unlocked: bool) {
    #[cfg(target_os = "macos")]
    native::set_unlocked(app, unlocked);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, unlocked);
}

#[cfg(test)]
mod tests {
    use super::russian_locale;

    #[test]
    fn recognizes_russian_locale_without_changing_english_fallback() {
        assert!(russian_locale(Some("ru_RU.UTF-8")));
        assert!(!russian_locale(Some("en_US.UTF-8")));
        assert!(!russian_locale(None));
    }
}
