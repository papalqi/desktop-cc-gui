//! Full-duplex stdio. A writer task owns `ChildStdin`, so a stdout read loop
//! can enqueue a frame and keep draining. An inline `write_all` from that
//! loop deadlocks a peer that fills stdout with `fs.writeSync` before it
//! reads stdin again (the kimi hang).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

/// Byte cap for frames accepted but not yet written. A turn that exceeds it
/// fails with a typed error and the driver tears the child down.
pub(crate) const QUEUE_CAP: usize = 64 * 1024 * 1024;
const LARGE_FRAME: usize = 256 * 1024;
const WRITE_PENDING_WARN: Duration = Duration::from_secs(30);
const WATCH_INTERVAL: Duration = Duration::from_secs(5);

enum Msg {
    Frame(Vec<u8>),
    Close,
}

struct Account {
    queued: usize,
    /// Unix millis of the oldest unwritten byte. `0` means the queue is idle.
    pending_since_ms: u64,
}

struct Inner {
    tx: mpsc::UnboundedSender<Msg>,
    account: Mutex<Account>,
    fatal: Mutex<Option<String>>,
    closed: AtomicBool,
    run_id: Mutex<String>,
    cap: usize,
}

/// Cloneable handle. Enqueue never waits on the pipe. The last clone's drop
/// closes the channel; the writer then drops stdin (EOF).
#[derive(Clone)]
pub(crate) struct StdioWriter {
    inner: Arc<Inner>,
}

impl StdioWriter {
    pub(crate) fn spawn(stdin: ChildStdin, run_id: impl Into<String>) -> Self {
        Self::spawn_with_cap(stdin, run_id, QUEUE_CAP)
    }

    /// A handle that rejects every enqueue. Used when the pipe is already gone.
    #[cfg(test)]
    pub(crate) fn already_closed() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                tx,
                account: Mutex::new(Account {
                    queued: 0,
                    pending_since_ms: 0,
                }),
                fatal: Mutex::new(None),
                closed: AtomicBool::new(true),
                run_id: Mutex::new("closed".to_string()),
                cap: QUEUE_CAP,
            }),
        }
    }

    pub(crate) fn spawn_with_cap(stdin: ChildStdin, run_id: impl Into<String>, cap: usize) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            tx,
            account: Mutex::new(Account {
                queued: 0,
                pending_since_ms: 0,
            }),
            fatal: Mutex::new(None),
            closed: AtomicBool::new(false),
            run_id: Mutex::new(run_id.into()),
            cap,
        });
        let writer = Self { inner };
        spawn_writer(stdin, Arc::clone(&writer.inner), rx);
        writer
    }

    pub(crate) fn set_run_id(&self, run_id: impl Into<String>) {
        *lock_mutex(&self.inner.run_id) = run_id.into();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    pub(crate) fn fatal(&self) -> Option<String> {
        lock_mutex(&self.inner.fatal).clone()
    }

    /// Queue one already-encoded frame, including its trailing newline.
    /// Returns without waiting for the pipe. Over the byte cap, sets the
    /// fatal error and refuses the frame.
    pub(crate) fn enqueue_frame(&self, bytes: Vec<u8>) -> Result<(), String> {
        if self.is_closed() {
            return Err("stdin is already closed".to_string());
        }
        if let Some(error) = self.fatal() {
            return Err(error);
        }
        let len = bytes.len();
        {
            let mut account = lock_mutex(&self.inner.account);
            let next = account.queued.saturating_add(len);
            if next > self.inner.cap {
                drop(account);
                let message = cap_exceeded(self.inner.cap);
                set_fatal(&self.inner, &message);
                return Err(message);
            }
            if account.queued == 0 {
                account.pending_since_ms = unix_millis();
            }
            account.queued = next;
        }
        if len >= LARGE_FRAME {
            eprintln!(
                "[stdio] debug: frame enqueued run={} bytes={len}",
                run_id_of(&self.inner)
            );
        }
        if self.inner.tx.send(Msg::Frame(bytes)).is_err() {
            release(&self.inner, len);
            let message = "stdio writer exited".to_string();
            set_fatal(&self.inner, &message);
            return Err(message);
        }
        Ok(())
    }

    /// Queue one text line, adding a trailing newline when the caller omitted it.
    pub(crate) fn enqueue_text(&self, line: String) -> Result<(), String> {
        let mut bytes = line.into_bytes();
        if !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        self.enqueue_frame(bytes)
    }

    /// EOF after every frame already queued. Further enqueues fail.
    pub(crate) fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.inner.tx.send(Msg::Close);
    }
}

fn spawn_writer(mut stdin: ChildStdin, inner: Arc<Inner>, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let stop = Arc::new(AtomicBool::new(false));
    let watch_stop = Arc::clone(&stop);
    let watch_inner = Arc::clone(&inner);
    tokio::spawn(async move {
        let mut ticker = interval(WATCH_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut warned_since = 0u64;
        loop {
            ticker.tick().await;
            if watch_stop.load(Ordering::SeqCst) {
                break;
            }
            let (queued, since) = {
                let account = lock_mutex(&watch_inner.account);
                (account.queued, account.pending_since_ms)
            };
            if queued == 0 || since == 0 {
                warned_since = 0;
                continue;
            }
            let pending_ms = unix_millis().saturating_sub(since);
            if pending_ms > WRITE_PENDING_WARN.as_millis() as u64 && warned_since != since {
                eprintln!(
                    "[stdio] warn: write pending run={} queued_bytes={queued} pending_ms={pending_ms}",
                    run_id_of(&watch_inner)
                );
                warned_since = since;
            }
        }
    });
    tokio::spawn(async move {
        let mut exit_reason = "all handles dropped";
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Frame(bytes) => {
                    let len = bytes.len();
                    let wrote = async {
                        stdin.write_all(&bytes).await?;
                        stdin.flush().await
                    }
                    .await;
                    release(&inner, len);
                    if let Err(error) = wrote {
                        let message = format!("stdio write failed: {error}");
                        set_fatal(&inner, &message);
                        exit_reason = "write failed";
                        eprintln!(
                            "[stdio] writer exit run={} reason={message}",
                            run_id_of(&inner)
                        );
                        break;
                    }
                }
                Msg::Close => {
                    exit_reason = "stdin closed";
                    eprintln!(
                        "[stdio] writer exit run={} reason=stdin closed",
                        run_id_of(&inner)
                    );
                    break;
                }
            }
        }
        if exit_reason == "all handles dropped" {
            eprintln!(
                "[stdio] writer exit run={} reason=all handles dropped",
                run_id_of(&inner)
            );
        }
        drop(stdin);
        stop.store(true, Ordering::SeqCst);
    });
}

fn release(inner: &Inner, len: usize) {
    let mut account = lock_mutex(&inner.account);
    account.queued = account.queued.saturating_sub(len);
    if account.queued == 0 {
        account.pending_since_ms = 0;
    }
}

fn set_fatal(inner: &Inner, message: &str) {
    let mut fatal = lock_mutex(&inner.fatal);
    if fatal.is_none() {
        *fatal = Some(message.to_string());
    }
}

fn cap_exceeded(cap: usize) -> String {
    if cap > 0 && cap % (1024 * 1024) == 0 {
        format!("stdio write queue exceeded {} MiB", cap / (1024 * 1024))
    } else {
        format!("stdio write queue exceeded {cap} bytes")
    }
}

fn run_id_of(inner: &Inner) -> String {
    lock_mutex(&inner.run_id).clone()
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::time::timeout;

    #[tokio::test]
    async fn enqueue_over_cap_fails_without_blocking() {
        let mut child = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1e9)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("node");
        let stdin = child.stdin.take().expect("stdin");
        let writer = StdioWriter::spawn_with_cap(stdin, "cap-test", 1024);
        let started = std::time::Instant::now();
        let error = writer
            .enqueue_frame(vec![b'a'; 2048])
            .expect_err("one frame over the cap must be refused");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "over-cap enqueue must not wait on the pipe"
        );
        assert!(error.starts_with("stdio write queue exceeded"), "{error}");
        assert_eq!(writer.fatal().as_deref(), Some(error.as_str()));
        drop(writer);
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        let _ = child.start_kill();
    }
}
