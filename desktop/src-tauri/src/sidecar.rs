use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::protocol::{self, Frame, ReadError};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: u64 = 1;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const MAX_RESTARTS: usize = 3;
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_QUEUED_FRAMES: usize = 16;

#[derive(Debug, Clone, Serialize)]
pub struct CoreError {
    pub code: String,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub type Reply = Result<(Value, Vec<u8>), CoreError>;
#[derive(Default)]
struct PendingMap {
    closed: bool,
    waiting: HashMap<u32, oneshot::Sender<Reply>>,
}

type Pending = Arc<Mutex<PendingMap>>;

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub state: &'static str,
    pub reason: Option<String>,
    pub info: Option<Value>,
    pub ready_ms: Option<u128>,
    pub restarts: u32,
    pub generation: u64,
}

pub struct CoreConfig {
    pub executable: Result<PathBuf, String>,
    pub args: Vec<PathBuf>,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub env: Vec<(String, String)>,
}

struct Running {
    writer: mpsc::SyncSender<(Option<u32>, Vec<u8>)>,
    pending: Pending,
}

enum Control {
    Start,
    Lock(mpsc::Sender<()>),
    Ready { generation: u64, info: Value },
    Exited { generation: u64, reason: String },
    ReadyTimeout { generation: u64 },
    Shutdown(mpsc::Sender<()>),
}

pub struct Supervisor {
    running: Mutex<Option<Running>>,
    status: Mutex<Status>,
    next_id: AtomicU32,
    clients: Mutex<HashMap<String, u32>>,
    control: Mutex<mpsc::Sender<Control>>,
    on_status: Box<dyn Fn(&Status) + Send + Sync>,
    launched: Instant,
}

impl Supervisor {
    pub fn start(
        config: CoreConfig,
        launched: Instant,
        on_status: impl Fn(&Status) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let (control_tx, control_rx) = mpsc::channel();
        let supervisor = Arc::new(Self {
            running: Mutex::new(None),
            status: Mutex::new(Status {
                state: "starting",
                reason: None,
                info: None,
                ready_ms: None,
                restarts: 0,
                generation: 0,
            }),
            next_id: AtomicU32::new(1),
            clients: Mutex::new(HashMap::new()),
            control: Mutex::new(control_tx.clone()),
            on_status: Box::new(on_status),
            launched,
        });
        let worker = supervisor.clone();
        thread::Builder::new()
            .name("core-supervisor".into())
            .spawn(move || worker.supervise(config, control_tx, control_rx))
            .expect("supervisor thread");
        supervisor.send(Control::Start);
        supervisor
    }

    fn send(&self, message: Control) {
        let _ = self.control.lock().unwrap().send(message);
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, update: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut status = self.status.lock().unwrap();
            update(&mut status);
            status.clone()
        };
        (self.on_status)(&snapshot);
    }

    pub fn restart(&self) {
        if self.status().state == "failed" {
            self.send(Control::Start);
        }
    }

    pub fn lock(&self) {
        let (tx, rx) = mpsc::channel();
        self.send(Control::Lock(tx));
        let _ = rx.recv_timeout(Duration::from_secs(3));
    }

    pub fn shutdown(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send(Control::Shutdown(ack_tx));
        let _ = ack_rx.recv_timeout(SHUTDOWN_GRACE + Duration::from_secs(1));
    }

    pub async fn request(
        &self,
        header: Value,
        mut body: Vec<u8>,
        timeout: Duration,
        client_id: Option<String>,
    ) -> Reply {
        let (writer, pending) = match self.running.lock().unwrap().as_ref() {
            Some(running) => (running.writer.clone(), running.pending.clone()),
            None => return Err(CoreError::new("core_unavailable", "the core is not ready")),
        };
        let mut id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            id = self.next_id.fetch_add(1, Ordering::Relaxed);
        }
        let frame = protocol::encode(protocol::REQUEST, id, header.to_string().as_bytes(), &body)
            .map_err(|code| CoreError::new(code, "request exceeds the frame limit"))?;
        use zeroize::Zeroize;
        body.zeroize();
        let (tx, rx) = oneshot::channel();
        {
            let mut map = pending.lock().unwrap();
            if map.closed {
                return Err(CoreError::new("core_exited", "the core stopped"));
            }
            if map.waiting.len() >= 16 {
                return Err(CoreError::new(
                    "busy",
                    "Please wait for the current vault operation.",
                ));
            }
            map.waiting.insert(id, tx);
        }
        if let Some(client) = &client_id {
            self.clients.lock().unwrap().insert(client.clone(), id);
        }
        if let Err(error) = writer.try_send((Some(id), frame)) {
            pending.lock().unwrap().waiting.remove(&id);
            if let Some(client) = &client_id {
                self.clients.lock().unwrap().remove(client);
            }
            return Err(match error {
                mpsc::TrySendError::Full(_) => {
                    CoreError::new("busy", "Please wait for the current vault operation.")
                }
                mpsc::TrySendError::Disconnected(_) => {
                    CoreError::new("core_exited", "the core stopped")
                }
            });
        }
        let outcome = tokio::time::timeout(timeout, rx).await;
        if let Some(client) = &client_id {
            self.clients.lock().unwrap().remove(client);
        }
        match outcome {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(CoreError::new("core_exited", "the core stopped")),
            Err(_) => {
                pending.lock().unwrap().waiting.remove(&id);
                if let Ok(cancel) = protocol::encode(protocol::CANCEL, id, b"{}", b"") {
                    if writer.try_send((None, cancel)).is_err() {
                        let (ack, _) = mpsc::channel();
                        self.send(Control::Lock(ack));
                    }
                }
                Err(CoreError::new("timeout", "the core did not answer in time"))
            }
        }
    }

    pub fn cancel(&self, client_id: &str) -> bool {
        let id = match self.clients.lock().unwrap().get(client_id) {
            Some(id) => *id,
            None => return false,
        };
        if let Some(running) = self.running.lock().unwrap().as_ref() {
            if let Ok(frame) = protocol::encode(protocol::CANCEL, id, b"{}", b"") {
                if running.writer.try_send((None, frame)).is_ok() {
                    return true;
                }
                let (ack, _) = mpsc::channel();
                self.send(Control::Lock(ack));
                return true;
            }
        }
        false
    }

    fn supervise(
        self: Arc<Self>,
        config: CoreConfig,
        control_tx: mpsc::Sender<Control>,
        control_rx: mpsc::Receiver<Control>,
    ) {
        #[cfg(windows)]
        let job = crate::job::Job::kill_on_close();
        let mut generation = 0u64;
        let mut child: Option<Child> = None;
        let mut writer: Option<mpsc::SyncSender<(Option<u32>, Vec<u8>)>> = None;
        let mut pending: Option<Pending> = None;
        let mut became_ready = false;
        let mut incompatible = false;
        let mut crashes: Vec<Instant> = Vec::new();
        let mut spawned_at = Instant::now();
        let mut shutting_down = false;

        while let Ok(message) = control_rx.recv() {
            match message {
                Control::Start => {
                    if shutting_down || child.is_some() {
                        continue;
                    }
                    generation += 1;
                    became_ready = false;
                    let restarts = crashes.len() as u32;
                    self.set_status(|s| {
                        s.state = if restarts > 0 {
                            "restarting"
                        } else {
                            "starting"
                        };
                        s.reason = None;
                        s.info = None;
                        s.generation = generation;
                    });
                    spawned_at = Instant::now();
                    match spawn_core(&config) {
                        Ok(mut spawned) => {
                            #[cfg(windows)]
                            {
                                let assigned = match &job {
                                    Ok(job) => job.assign(&spawned),
                                    Err(error) => Err(std::io::Error::new(
                                        error.kind(),
                                        "Job Object unavailable",
                                    )),
                                };
                                if assigned.is_err() {
                                    let _ = spawned.kill();
                                    let _ = spawned.wait();
                                    self.set_status(|s| {
                                        s.state = "failed";
                                        s.reason = Some(
                                            "Windows could not isolate the vault process.".into(),
                                        );
                                    });
                                    continue;
                                }
                            }

                            let (frames_tx, frames_rx) = mpsc::sync_channel(MAX_QUEUED_FRAMES);
                            let map: Pending = Arc::new(Mutex::new(PendingMap::default()));
                            let stdin = spawned.stdin.take().unwrap();
                            let stdout = spawned.stdout.take().unwrap();
                            let stderr = spawned.stderr.take().unwrap();
                            spawn_writer(stdin, frames_rx, map.clone());
                            spawn_reader(stdout, generation, map.clone(), control_tx.clone());
                            spawn_logger(stderr, config.log_dir.clone());
                            let timer_tx = control_tx.clone();
                            let timer_generation = generation;
                            thread::spawn(move || {
                                thread::sleep(READY_TIMEOUT);
                                let _ = timer_tx.send(Control::ReadyTimeout {
                                    generation: timer_generation,
                                });
                            });
                            writer = Some(frames_tx);
                            pending = Some(map);
                            child = Some(spawned);
                        }
                        Err(error) => {
                            self.set_status(|s| {
                                s.state = "failed";
                                s.reason = Some(format!("could not start the core: {error}"));
                            });
                        }
                    }
                }
                Control::Ready {
                    generation: g,
                    info,
                } if g == generation => {
                    if info.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
                        || info.get("core_version").and_then(Value::as_str)
                            != Some(env!("CARGO_PKG_VERSION"))
                    {
                        if let Some(c) = child.as_mut() {
                            let _ = c.kill();
                        }
                        incompatible = true;
                        continue;
                    }
                    became_ready = true;
                    *self.running.lock().unwrap() = Some(Running {
                        writer: writer.clone().unwrap(),
                        pending: pending.clone().unwrap(),
                    });
                    let ready_ms = spawned_at.elapsed().as_millis();
                    let since_launch = self.launched.elapsed().as_millis();
                    let restarts = crashes.len() as u32;
                    self.set_status(|s| {
                        s.state = "ready";
                        s.info = Some(info);
                        s.ready_ms = Some(ready_ms);
                        s.restarts = restarts;
                        if let Some(Value::Object(map)) = s.info.as_mut() {
                            map.insert("since_launch_ms".into(), json!(since_launch));
                        }
                    });
                }
                Control::ReadyTimeout { generation: g } if g == generation && !became_ready => {
                    if let Some(c) = child.as_mut() {
                        let _ = c.kill();
                    }
                }
                Control::Exited {
                    generation: g,
                    reason,
                } if g == generation => {
                    *self.running.lock().unwrap() = None;
                    writer = None;
                    pending = None;
                    let code = child.take().map(reap).unwrap_or(None);
                    if shutting_down {
                        continue;
                    }
                    if incompatible {
                        incompatible = false;
                        self.set_status(|s| {
                            s.state = "failed";
                            s.reason = Some("The application and vault core versions do not match. Reinstall the application.".into());
                        });
                        continue;
                    }
                    if !became_ready {
                        self.set_status(|s| {
                            s.state = "failed";
                            s.reason = Some(format!(
                                "the core failed to start ({reason}, exit {code:?})"
                            ));
                        });
                        continue;
                    }
                    let now = Instant::now();
                    crashes.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
                    crashes.push(now);
                    if crashes.len() > MAX_RESTARTS {
                        self.set_status(|s| {
                            s.state = "failed";
                            s.reason = Some(format!("the core keeps stopping (exit {code:?})"));
                        });
                        continue;
                    }
                    self.set_status(|s| {
                        s.state = "restarting";
                        s.reason = Some(format!(
                            "the core stopped ({reason}, exit {code:?}); the vault is locked"
                        ));
                    });
                    thread::sleep(Duration::from_millis(200 * crashes.len() as u64));
                    let _ = control_tx.send(Control::Start);
                }
                Control::Lock(ack) => {
                    *self.running.lock().unwrap() = None;
                    if became_ready {
                        if let Some(c) = child.as_mut() {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                    crashes.clear();
                    let _ = ack.send(());
                }
                Control::Shutdown(ack) => {
                    shutting_down = true;
                    *self.running.lock().unwrap() = None;
                    if let Some(w) = writer.take() {
                        if let Ok(frame) = protocol::encode(protocol::SHUTDOWN, 0, b"{}", b"") {
                            let _ = w.try_send((None, frame));
                        }
                    }
                    pending = None;
                    if let Some(mut c) = child.take() {
                        let deadline = Instant::now() + SHUTDOWN_GRACE;
                        loop {
                            match c.try_wait() {
                                Ok(Some(_)) => break,
                                Ok(None) if Instant::now() < deadline => {
                                    thread::sleep(Duration::from_millis(20))
                                }
                                _ => {
                                    let _ = c.kill();
                                    let _ = c.wait();
                                    break;
                                }
                            }
                        }
                    }
                    self.set_status(|s| {
                        s.state = "stopped";
                        s.info = None;
                    });
                    let _ = ack.send(());
                }
                _ => {}
            }
        }
    }
}

fn reap(mut child: Child) -> Option<i32> {
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code().or_else(|| signal_of(&status)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return child.wait().ok().and_then(|s| s.code());
            }
        }
    }
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|s| -s)
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

fn spawn_core(config: &CoreConfig) -> std::io::Result<Child> {
    fs::create_dir_all(&config.data_dir)?;
    fs::create_dir_all(&config.log_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config.data_dir, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&config.log_dir, fs::Permissions::from_mode(0o700))?;
    }
    let executable = config
        .executable
        .as_ref()
        .map_err(|reason| std::io::Error::new(std::io::ErrorKind::NotFound, reason.clone()))?;
    let mut command = Command::new(executable);
    command
        .args(&config.args)
        .arg("--data-dir")
        .arg(&config.data_dir)
        .env_clear()
        .envs(config.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&config.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        let parent = libc::getpid();
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::_exit(4);
            }
            Ok(())
        });
    }
    command.spawn()
}

fn spawn_writer(
    stdin: std::process::ChildStdin,
    frames: mpsc::Receiver<(Option<u32>, Vec<u8>)>,
    pending: Pending,
) {
    thread::Builder::new()
        .name("core-stdin".into())
        .spawn(move || write_frames(stdin, frames, pending))
        .expect("writer thread");
}

fn write_frames(
    mut output: impl Write,
    frames: mpsc::Receiver<(Option<u32>, Vec<u8>)>,
    pending: Pending,
) {
    while let Ok((id, mut frame)) = frames.recv() {
        if id.is_some_and(|id| !pending.lock().unwrap().waiting.contains_key(&id)) {
            use zeroize::Zeroize;
            frame.zeroize();
            continue;
        }
        let written = output
            .write_all(&frame)
            .and_then(|_| output.flush())
            .is_ok();
        use zeroize::Zeroize;
        frame.zeroize();
        if !written {
            return;
        }
    }
}

fn fail_all(pending: &Pending, code: &str) {
    let mut map = pending.lock().unwrap();
    map.closed = true;
    for (_, sender) in map.waiting.drain() {
        let _ = sender.send(Err(CoreError::new(code, "the core stopped")));
    }
}

fn deliver(frame: Frame, pending: &Pending, generation: u64, control: &mpsc::Sender<Control>) {
    match frame.kind {
        protocol::READY => {
            let info = serde_json::from_slice(&frame.header).unwrap_or(Value::Null);
            let _ = control.send(Control::Ready { generation, info });
        }
        protocol::RESPONSE => {
            if let Some(sender) = pending.lock().unwrap().waiting.remove(&frame.id) {
                let header = serde_json::from_slice(&frame.header).unwrap_or(Value::Null);
                let _ = sender.send(Ok((header, frame.body)));
            }
        }
        protocol::ERROR => {
            let header: Value = serde_json::from_slice(&frame.header).unwrap_or(Value::Null);
            let code = header
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("core_error");
            let message = header.get("message").and_then(Value::as_str).unwrap_or("");
            match pending.lock().unwrap().waiting.remove(&frame.id) {
                Some(sender) => {
                    let _ = sender.send(Err(CoreError::new(code, message)));
                }
                None => eprintln!("core error frame for unknown request {}: {code}", frame.id),
            }
        }
        other => eprintln!("unexpected frame kind {other} from the core"),
    }
}

fn spawn_reader(
    stdout: std::process::ChildStdout,
    generation: u64,
    pending: Pending,
    control: mpsc::Sender<Control>,
) {
    thread::Builder::new()
        .name("core-stdout".into())
        .spawn(move || {
            let mut reader = BufReader::with_capacity(1 << 20, stdout);
            let reason = loop {
                match protocol::read_frame(&mut reader) {
                    Ok(frame) => deliver(frame, &pending, generation, &control),
                    Err(ReadError::Eof) => break "exited".to_string(),
                    Err(ReadError::Desync(why)) => break format!("protocol error: {why}"),
                    Err(ReadError::Io(e)) => break format!("pipe error: {:?}", e.kind()),
                }
            };
            fail_all(&pending, "core_exited");
            let _ = control.send(Control::Exited { generation, reason });
        })
        .expect("reader thread");
}

fn open_log(path: &PathBuf) -> Option<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).ok()
}

fn spawn_logger(stderr: std::process::ChildStderr, log_dir: PathBuf) {
    thread::Builder::new()
        .name("core-stderr".into())
        .spawn(move || {
            let path = log_dir.join("core.log");
            let mut file = open_log(&path);
            let reader = BufReader::new(stderr);
            for line in reader.split(b'\n').map_while(Result::ok) {
                if let Some(f) = file.as_mut() {
                    let _ = f.write_all(&line);
                    let _ = f.write_all(b"\n");
                    if f.metadata()
                        .map(|m| m.len() > LOG_ROTATE_BYTES)
                        .unwrap_or(false)
                    {
                        let _ = fs::rename(&path, log_dir.join("core.log.1"));
                        file = open_log(&path);
                    }
                }
                if cfg!(debug_assertions) {
                    eprintln!("[core] {}", String::from_utf8_lossy(&line));
                }
            }
        })
        .expect("logger thread");
}
