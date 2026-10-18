//! Full-duplex stdio. A writer task owns `ChildStdin`, so a stdout read loop
//! can enqueue a frame and keep draining. An inline `write_all` from that
//! loop deadlocks a peer that fills stdout with `fs.writeSync` before it
//! reads stdin again (the kimi hang).
//!
//! The cloneable handle owns the channel sender. The writer and the watchdog
//! do not, so they cannot keep the channel open. Dropping the last handle
//! closes the channel; the writer then drops stdin (the child sees EOF) and
//! wakes the watchdog. `close` queues that same EOF after every frame already
//! accepted, which is what a turn end does before it kills the child.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Notify};
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

/// State the background tasks need. Deliberately has no sender: an `Arc` of
/// this held by the writer used to be the channel's last sender, so
/// `recv` never returned `None` and the tasks outlived every handle.
struct Shared {
    account: Mutex<Account>,
    fatal: Mutex<Option<String>>,
    closed: AtomicBool,
    run_id: Mutex<String>,
    cap: usize,
    /// Wakes the watchdog the moment the writer exits. A stored permit covers
    /// a stop that happens before the watchdog polls.
    stop_watch: Arc<Notify>,
    #[cfg(test)]
    writer_done: Arc<Notify>,
    #[cfg(test)]
    watchdog_done: Arc<Notify>,
}

/// Cloneable handle. Enqueue never waits on the pipe. The sender lives here,
/// so the last clone's drop closes the channel.
#[derive(Clone)]
pub(crate) struct StdioWriter {
    tx: mpsc::UnboundedSender<Msg>,
    shared: Arc<Shared>,
}

/// Test-only completion signals. Clone them before dropping the handles.
/// Waiting on these is the watchdog/writer lifetime check; nothing polls a
/// global flag.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TaskSignals {
    pub(crate) writer_done: Arc<Notify>,
    pub(crate) watchdog_done: Arc<Notify>,
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
            tx,
            shared: Arc::new(shared_state("closed", QUEUE_CAP, true)),
        }
    }

    pub(crate) fn spawn_with_cap(stdin: ChildStdin, run_id: impl Into<String>, cap: usize) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(shared_state(run_id, cap, false));
        spawn_writer(stdin, Arc::clone(&shared), rx);
        Self { tx, shared }
    }

    pub(crate) fn set_run_id(&self, run_id: impl Into<String>) {
        *lock_mutex(&self.shared.run_id) = run_id.into();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    pub(crate) fn fatal(&self) -> Option<String> {
        lock_mutex(&self.shared.fatal).clone()
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
            let mut account = lock_mutex(&self.shared.account);
            let next = account.queued.saturating_add(len);
            if next > self.shared.cap {
                drop(account);
                let message = cap_exceeded(self.shared.cap);
                set_fatal(&self.shared, &message);
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
                run_id_of(&self.shared)
            );
        }
        if self.tx.send(Msg::Frame(bytes)).is_err() {
            release(&self.shared, len);
            let message = "stdio writer exited".to_string();
            set_fatal(&self.shared, &message);
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
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(Msg::Close);
    }

    /// Signals that fire when this writer's tasks exit. Hold them across the
    /// last handle drop; the tasks do not.
    #[cfg(test)]
    pub(crate) fn task_signals(&self) -> TaskSignals {
        TaskSignals {
            writer_done: Arc::clone(&self.shared.writer_done),
            watchdog_done: Arc::clone(&self.shared.watchdog_done),
        }
    }

    /// Block until the writer has dropped stdin and the watchdog has stopped.
    /// A turn test calls this after `close`, while registry clones may still
    /// exist: `close` ends the tasks, and dropping those clones is separate.
    #[cfg(test)]
    pub(crate) async fn wait_tasks_finished(&self) {
        let signals = self.task_signals();
        let run = run_id_of(&self.shared);
        if tokio::time::timeout(Duration::from_secs(2), signals.writer_done.notified())
            .await
            .is_err()
        {
            panic!("stdio writer task still running for run {run}");
        }
        if tokio::time::timeout(Duration::from_secs(2), signals.watchdog_done.notified())
            .await
            .is_err()
        {
            panic!("stdio watchdog still running for run {run}");
        }
    }
}

fn shared_state(run_id: impl Into<String>, cap: usize, closed: bool) -> Shared {
    Shared {
        account: Mutex::new(Account {
            queued: 0,
            pending_since_ms: 0,
        }),
        fatal: Mutex::new(None),
        closed: AtomicBool::new(closed),
        run_id: Mutex::new(run_id.into()),
        cap,
        stop_watch: Arc::new(Notify::new()),
        #[cfg(test)]
        writer_done: Arc::new(Notify::new()),
        #[cfg(test)]
        watchdog_done: Arc::new(Notify::new()),
    }
}

fn spawn_writer(mut stdin: ChildStdin, shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let stop = Arc::clone(&shared.stop_watch);
    let watch_shared = Arc::clone(&shared);
    #[cfg(test)]
    let watchdog_done = Arc::clone(&shared.watchdog_done);
    tokio::spawn(async move {
        let mut ticker = interval(WATCH_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut warned_since = 0u64;
        // One future for the whole loop. Recreating `notified()` each tick
        // drops a permit that arrived while the stall check won the select.
        let stop_note = stop.notified();
        tokio::pin!(stop_note);
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_note => break,
                _ = ticker.tick() => {
                    let (queued, since) = {
                        let account = lock_mutex(&watch_shared.account);
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
                            run_id_of(&watch_shared)
                        );
                        warned_since = since;
                    }
                }
            }
        }
        #[cfg(test)]
        watchdog_done.notify_one();
    });
    #[cfg(test)]
    let writer_done = Arc::clone(&shared.writer_done);
    let stop = Arc::clone(&shared.stop_watch);
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
                    release(&shared, len);
                    if let Err(error) = wrote {
                        let message = format!("stdio write failed: {error}");
                        set_fatal(&shared, &message);
                        exit_reason = "write failed";
                        eprintln!(
                            "[stdio] writer exit run={} reason={message}",
                            run_id_of(&shared)
                        );
                        break;
                    }
                }
                Msg::Close => {
                    exit_reason = "stdin closed";
                    eprintln!(
                        "[stdio] writer exit run={} reason=stdin closed",
                        run_id_of(&shared)
                    );
                    break;
                }
            }
        }
        if exit_reason == "all handles dropped" {
            eprintln!(
                "[stdio] writer exit run={} reason=all handles dropped",
                run_id_of(&shared)
            );
        }
        drop(stdin);
        stop.notify_one();
        #[cfg(test)]
        writer_done.notify_one();
    });
}

fn release(shared: &Shared, len: usize) {
    let mut account = lock_mutex(&shared.account);
    account.queued = account.queued.saturating_sub(len);
    if account.queued == 0 {
        account.pending_since_ms = 0;
    }
}

fn set_fatal(shared: &Shared, message: &str) {
    let mut fatal = lock_mutex(&shared.fatal);
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

fn run_id_of(shared: &Shared) -> String {
    lock_mutex(&shared.run_id).clone()
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

    fn eof_peer() -> &'static str {
        // Stdin starts paused. Without resume(), a closed pipe never emits
        // `end`, so the peer would stay up even after the writer drops it.
        r#"
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1e9);
"#
    }

    fn spawn_node(script: &str) -> (tokio::process::Child, StdioWriter) {
        let mut child = Command::new("node")
            .args(["-e", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("node");
        let stdin = child.stdin.take().expect("stdin");
        let writer = StdioWriter::spawn(stdin, "drop-test");
        (child, writer)
    }

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

    /// The last handle drop is the writer's lifetime. No `close()` call: a
    /// peer that exits on stdin `end` must see EOF, and the watchdog must
    /// stop because the writer said so, not because a timer lapsed.
    #[tokio::test]
    async fn dropping_all_handles_ends_the_writer_and_closes_stdin() {
        let (mut child, writer) = spawn_node(eof_peer());
        let clone = writer.clone();
        let signals = writer.task_signals();
        drop(writer);
        drop(clone);
        let (child_done, writer_done, watchdog_done) = tokio::join!(
            timeout(Duration::from_secs(2), child.wait()),
            timeout(Duration::from_secs(2), signals.writer_done.notified()),
            timeout(Duration::from_secs(2), signals.watchdog_done.notified()),
        );
        if child_done.is_err() {
            let _ = child.start_kill();
        }
        assert!(
            child_done.is_ok(),
            "stdin EOF from the last handle drop must exit the child within 2s"
        );
        assert!(
            writer_done.is_ok(),
            "writer task must exit when handles drop"
        );
        assert!(
            watchdog_done.is_ok(),
            "watchdog must stop when the writer exits"
        );
    }

    /// Run-id and session-alias registry entries hold their own clones.
    /// Removing the run drops both. Until then the child stays up, because
    /// those clones are still senders.
    #[tokio::test]
    async fn registry_removal_drops_writer_clones_and_closes_stdin() {
        use crate::engine::{ChildEntry, ProcessRegistry};
        use std::collections::HashMap;

        let (mut child, writer) = spawn_node(eof_peer());
        let signals = writer.task_signals();
        let registry = ProcessRegistry::default();
        let run_id = "reg-drop";
        let pid = 42u32;
        let entry = ChildEntry {
            child: None,
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
        };
        registry.insert(run_id.to_string(), entry.clone());
        registry.insert_alias("sess-alias".to_string(), entry);
        registry.set_stdin(run_id, writer.clone());
        drop(writer);
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "registry clones must keep stdin open"
        );
        registry.remove_run_if_pid(run_id, pid);
        assert!(
            registry.get(run_id).is_none() && registry.get("sess-alias").is_none(),
            "both keys must go"
        );
        let finished = timeout(Duration::from_secs(2), child.wait()).await;
        if finished.is_err() {
            let _ = child.start_kill();
        }
        assert!(
            finished.is_ok(),
            "removing the registry entries must drop the last handles"
        );
        assert!(
            timeout(Duration::from_secs(2), signals.writer_done.notified())
                .await
                .is_ok(),
            "writer task must exit after the registry drops its clones"
        );
        assert!(
            timeout(Duration::from_secs(2), signals.watchdog_done.notified())
                .await
                .is_ok(),
            "watchdog must stop after the registry drops its clones"
        );
    }
}
