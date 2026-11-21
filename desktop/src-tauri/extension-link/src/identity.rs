use std::io;
use std::path::{Path, PathBuf};

const IDENTIFIER: &str = "com.nedra.desktop";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Identity {
    Production,
    Development,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

#[cfg(unix)]
fn home() -> io::Result<PathBuf> {
    if let Some(home) = env_path("HOME") {
        return Ok(home);
    }

    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_dir.is_null() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no home folder"));
        }
        let dir = std::ffi::CStr::from_ptr((*entry).pw_dir);
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
    }
}

pub fn local_data(identifier: &str) -> io::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    return Ok(home()?.join("Library/Application Support").join(identifier));
    #[cfg(all(unix, not(target_os = "macos")))]
    return Ok(env_path("XDG_DATA_HOME")
        .map(Ok)
        .unwrap_or_else(|| home().map(|h| h.join(".local/share")))?
        .join(identifier));
    #[cfg(windows)]
    return env_path("LOCALAPPDATA")
        .map(|p| p.join(identifier))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no LOCALAPPDATA"));
}

impl Identity {
    pub fn host_name(&self) -> &'static str {
        match self {
            Identity::Production => "com.nedra.desktop",
            Identity::Development => "com.nedra.desktop.dev",
        }
    }

    pub fn base(&self) -> io::Result<PathBuf> {
        match self {
            Identity::Production => local_data(IDENTIFIER),
            Identity::Development => Ok(local_data(IDENTIFIER)?.join("development")),
        }
    }

    pub fn link_dir(&self) -> io::Result<PathBuf> {
        Ok(self.base()?.join("browser-extension"))
    }

    pub fn tauri_identifier(&self) -> &'static str {
        IDENTIFIER
    }

    #[cfg(unix)]
    pub fn socket_path(&self) -> io::Result<PathBuf> {
        let primary = match runtime_dir() {
            Some(runtime) => runtime.join(self.host_name()).join("extension.sock"),
            None => self.base()?.join("run").join("extension.sock"),
        };
        Ok(short_enough(primary))
    }

    #[cfg(windows)]
    pub fn pipe_name(&self) -> io::Result<String> {
        let sid = crate::ipc::current_user_sid()?;
        let tag = match self {
            Identity::Production => String::new(),
            Identity::Development => "-dev".into(),
        };
        Ok(format!(r"\\.\pipe\nedra-extension{tag}-{sid}"))
    }
}

pub fn short_hash(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(unix)]
fn runtime_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return None;
    }

    let uid = unsafe { libc::getuid() };
    let dir =
        env_path("XDG_RUNTIME_DIR").unwrap_or_else(|| PathBuf::from(format!("/run/user/{uid}")));
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    (meta.is_dir() && meta.uid() == uid && meta.mode() & 0o077 == 0).then_some(dir)
}

#[cfg(unix)]
fn short_enough(primary: PathBuf) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    if primary.as_os_str().as_bytes().len() < 100 {
        return primary;
    }
    temp_dir()
        .join(format!(
            "nedra-{}",
            short_hash(primary.as_os_str().as_bytes())
        ))
        .join("s")
}

#[cfg(target_os = "macos")]
fn temp_dir() -> PathBuf {
    let mut buf = vec![0u8; 1024];

    let n = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n > 0 && n <= buf.len() {
        buf.truncate(n - 1);
        use std::os::unix::ffi::OsStringExt;
        return PathBuf::from(std::ffi::OsString::from_vec(buf));
    }
    PathBuf::from("/tmp")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn temp_dir() -> PathBuf {
    PathBuf::from("/tmp")
}

#[cfg(unix)]
pub fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;

    let uid = unsafe { libc::getuid() };
    if !meta.is_dir() || meta.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "folder is not ours",
        ));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}
