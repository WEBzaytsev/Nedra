use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

fn refused(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.to_string())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};

    pub fn own_uid() -> u32 {
        unsafe { libc::getuid() }
    }

    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
        let mut uid = 0;
        let mut gid = 0;

        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }

    #[cfg(target_os = "linux")]
    pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;

        let rc = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(cred.uid)
    }

    pub struct Stream(UnixStream);

    impl Stream {
        pub fn try_clone(&self) -> io::Result<Stream> {
            Ok(Stream(self.0.try_clone()?))
        }
        pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(timeout)
        }
        pub fn shutdown(&self) {
            let _ = self.0.shutdown(std::net::Shutdown::Both);
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    pub struct Listener {
        inner: UnixListener,
        path: PathBuf,
        inode: u64,
        stopped: Arc<AtomicBool>,
    }

    pub fn listen(path: &Path) -> io::Result<Listener> {
        let parent = path
            .parent()
            .ok_or_else(|| refused("socket path has no folder"))?;
        crate::identity::private_dir(parent)?;
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_socket() || meta.uid() != own_uid() {
                return Err(refused("something else is at the socket path"));
            }
            if UnixStream::connect(path).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another Nedra is listening",
                ));
            }
            std::fs::remove_file(path)?;
        }
        let inner = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let inode = std::fs::symlink_metadata(path)?.ino();
        Ok(Listener {
            inner,
            path: path.to_path_buf(),
            inode,
            stopped: Arc::new(AtomicBool::new(false)),
        })
    }

    impl Listener {
        pub fn accept(&self) -> Option<Stream> {
            loop {
                let (stream, _) = match self.inner.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) if !self.stopped.load(Ordering::SeqCst) => {
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                    Err(_) => return None,
                };
                if self.stopped.load(Ordering::SeqCst) {
                    return None;
                }
                match peer_uid(&stream) {
                    Ok(uid) if uid == own_uid() => return Some(Stream(stream)),
                    _ => continue,
                }
            }
        }

        pub fn stopper(&self) -> Stopper {
            Stopper {
                path: self.path.clone(),
                inode: self.inode,
                stopped: self.stopped.clone(),
            }
        }
    }

    pub struct Stopper {
        path: PathBuf,
        inode: u64,
        stopped: Arc<AtomicBool>,
    }

    impl Stopper {
        pub fn stop(&self) {
            if self.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = UnixStream::connect(&self.path);
            if std::fs::symlink_metadata(&self.path).is_ok_and(|m| m.ino() == self.inode) {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    pub fn connect(path: &Path) -> io::Result<Stream> {
        let stream = UnixStream::connect(path)?;
        if peer_uid(&stream)? != own_uid() {
            return Err(refused("the endpoint belongs to another user"));
        }
        Ok(Stream(stream))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
        GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    unsafe impl Send for Owned {}
    unsafe impl Sync for Owned {}

    fn token_user(process: HANDLE) -> io::Result<Vec<u8>> {
        let mut token = null_mut();

        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Owned(token);
        let mut size = 0u32;

        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut size) };
        let mut buf = vec![0u8; size as usize];

        if unsafe {
            GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), size, &mut size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(buf)
    }

    fn sid_of(buf: &[u8]) -> *mut core::ffi::c_void {
        unsafe { (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid }
    }

    fn own_user() -> io::Result<Vec<u8>> {
        token_user(unsafe { GetCurrentProcess() })
    }

    pub fn current_user_sid() -> io::Result<String> {
        let user = own_user()?;
        let mut text = null_mut();

        if unsafe { ConvertSidToStringSidW(sid_of(&user), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0;

        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        unsafe { LocalFree(text.cast()) };
        Ok(sid)
    }

    fn same_user(pid: u32) -> io::Result<bool> {
        let process = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
        if process.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let (theirs, ours) = (token_user(process.0)?, own_user()?);

        Ok(unsafe { EqualSid(sid_of(&theirs), sid_of(&ours)) } != 0)
    }

    fn event() -> io::Result<Owned> {
        let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Owned(handle))
    }

    fn finish(
        pipe: HANDLE,
        overlapped: &mut OVERLAPPED,
        started: i32,
        timeout: Option<Duration>,
    ) -> io::Result<usize> {
        if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        let ms = timeout.map_or(u32::MAX, |t| t.as_millis().min(u32::MAX as u128 - 1) as u32);

        let waited = unsafe { WaitForSingleObject(overlapped.hEvent, ms) };
        if waited == WAIT_TIMEOUT {
            unsafe { CancelIoEx(pipe, overlapped) };
            let mut n = 0;
            unsafe { GetOverlappedResult(pipe, overlapped, &mut n, 1) };
            return Err(io::Error::new(io::ErrorKind::TimedOut, "read timed out"));
        }
        if waited != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0;

        if unsafe { GetOverlappedResult(pipe, overlapped, &mut n, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(n as usize)
    }

    #[derive(Clone)]
    pub struct Stream {
        pipe: Arc<Owned>,
        server: bool,
        timeout: Arc<std::sync::Mutex<Option<Duration>>>,
    }

    impl Stream {
        pub fn try_clone(&self) -> io::Result<Stream> {
            Ok(self.clone())
        }
        pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
            *self.timeout.lock().unwrap() = timeout;
            Ok(())
        }
        pub fn shutdown(&self) {
            unsafe { CancelIoEx(self.pipe.0, null()) };
            if self.server {
                unsafe { DisconnectNamedPipe(self.pipe.0) };
            }
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let done = event()?;
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = done.0;
            let len = buf.len().min(u32::MAX as usize) as u32;

            let started = unsafe {
                ReadFile(
                    self.pipe.0,
                    buf.as_mut_ptr(),
                    len,
                    null_mut(),
                    &mut overlapped,
                )
            };
            let timeout = *self.timeout.lock().unwrap();
            match finish(self.pipe.0, &mut overlapped, started, timeout) {
                Err(e) if e.raw_os_error() == Some(109) => Ok(0),
                other => other,
            }
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let done = event()?;
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = done.0;
            let len = buf.len().min(u32::MAX as usize) as u32;

            let started =
                unsafe { WriteFile(self.pipe.0, buf.as_ptr(), len, null_mut(), &mut overlapped) };
            finish(self.pipe.0, &mut overlapped, started, None)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }
    unsafe impl Send for Descriptor {}
    unsafe impl Sync for Descriptor {}

    pub struct Listener {
        name: Vec<u16>,
        descriptor: Descriptor,
        first: AtomicBool,
        stopped: Arc<AtomicBool>,
    }

    pub fn listen(name: &str) -> io::Result<Listener> {
        let sddl = wide(&format!("D:P(A;;GA;;;{})", current_user_sid()?));
        let mut descriptor = null_mut();

        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let listener = Listener {
            name: wide(name),
            descriptor: Descriptor(descriptor),
            first: AtomicBool::new(true),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        Ok(listener)
    }

    impl Listener {
        fn instance(&self) -> io::Result<Owned> {
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor.0,
                bInheritHandle: 0,
            };
            let first = if self.first.swap(false, Ordering::SeqCst) {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };

            let pipe = unsafe {
                CreateNamedPipeW(
                    self.name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | first,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    64 * 1024,
                    64 * 1024,
                    0,
                    &attributes,
                )
            };
            if pipe == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(Owned(pipe))
        }

        pub fn claim(&self) -> io::Result<Owned2> {
            Ok(Owned2(Some(self.instance()?)))
        }

        pub fn accept_with(&self, waiting: &mut Owned2) -> Option<Stream> {
            loop {
                if self.stopped.load(Ordering::SeqCst) {
                    return None;
                }
                let pipe = match waiting.0.take() {
                    Some(pipe) => pipe,
                    None => match self.instance() {
                        Ok(pipe) => pipe,
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(200));
                            continue;
                        }
                    },
                };
                let done = match event() {
                    Ok(done) => done,
                    Err(_) => return None,
                };
                let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
                overlapped.hEvent = done.0;

                let started = unsafe { ConnectNamedPipe(pipe.0, &mut overlapped) };
                let connected = if started == 0 && unsafe { GetLastError() } == ERROR_PIPE_CONNECTED
                {
                    true
                } else {
                    loop {
                        if self.stopped.load(Ordering::SeqCst) {
                            unsafe { CancelIoEx(pipe.0, &overlapped) };
                            let mut n = 0;
                            unsafe { GetOverlappedResult(pipe.0, &overlapped, &mut n, 1) };
                            return None;
                        }
                        match finish_connect(pipe.0, &mut overlapped, started) {
                            Some(result) => break result,
                            None => continue,
                        }
                    }
                };
                if !connected {
                    continue;
                }
                let mut pid = 0;

                let ok = unsafe { GetNamedPipeClientProcessId(pipe.0, &mut pid) } != 0;
                if ok && same_user(pid).unwrap_or(false) {
                    return Some(Stream {
                        pipe: Arc::new(pipe),
                        server: true,
                        timeout: Default::default(),
                    });
                }
                unsafe { DisconnectNamedPipe(pipe.0) };
            }
        }

        pub fn stopper(&self) -> Stopper {
            Stopper {
                stopped: self.stopped.clone(),
            }
        }
    }

    fn finish_connect(pipe: HANDLE, overlapped: &mut OVERLAPPED, started: i32) -> Option<bool> {
        if started != 0 {
            return Some(true);
        }

        let waited = unsafe { WaitForSingleObject(overlapped.hEvent, 250) };
        if waited == WAIT_TIMEOUT {
            return None;
        }
        let mut n = 0;
        Some(unsafe { GetOverlappedResult(pipe, overlapped, &mut n, 0) } != 0)
    }

    pub struct Owned2(Option<Owned>);

    pub struct Stopper {
        stopped: Arc<AtomicBool>,
    }

    impl Stopper {
        pub fn stop(&self) {
            self.stopped.store(true, Ordering::SeqCst);
        }
    }

    pub fn connect(name: &str) -> io::Result<Stream> {
        let name = wide(name);

        let pipe = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let pipe = Owned(pipe);
        let mut pid = 0;

        if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) } == 0 || !same_user(pid)? {
            return Err(refused("the endpoint belongs to another user"));
        }
        Ok(Stream {
            pipe: Arc::new(pipe),
            server: false,
            timeout: Default::default(),
        })
    }
}

pub fn endpoint(identity: &crate::identity::Identity) -> io::Result<Endpoint> {
    #[cfg(unix)]
    return identity.socket_path().map(Endpoint);
    #[cfg(windows)]
    return identity.pipe_name().map(Endpoint);
}

#[cfg(unix)]
pub struct Endpoint(pub std::path::PathBuf);
#[cfg(windows)]
pub struct Endpoint(pub String);

impl Endpoint {
    pub fn connect(&self) -> io::Result<Stream> {
        connect(&self.0)
    }
}

pub struct Server {
    #[cfg(unix)]
    listener: Listener,
    #[cfg(windows)]
    listener: Listener,
    #[cfg(windows)]
    waiting: std::sync::Mutex<Owned2>,
}

impl Server {
    pub fn bind(endpoint: &Endpoint) -> io::Result<Server> {
        #[cfg(unix)]
        return Ok(Server {
            listener: listen(&endpoint.0)?,
        });
        #[cfg(windows)]
        {
            let listener = listen(&endpoint.0)?;
            let waiting = std::sync::Mutex::new(listener.claim()?);
            Ok(Server { listener, waiting })
        }
    }

    pub fn accept(&self) -> Option<Stream> {
        #[cfg(unix)]
        return self.listener.accept();
        #[cfg(windows)]
        return self.listener.accept_with(&mut self.waiting.lock().unwrap());
    }

    pub fn stopper(&self) -> Stopper {
        self.listener.stopper()
    }
}
