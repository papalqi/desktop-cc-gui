use super::wire::{Bulk, Descriptor, CONTROL_BYTES};
use crate::relay_update::{Activity, UpdateState};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};

struct Incoming {
    frame: Value,
    started: Instant,
    _activity: Option<Activity>,
}
#[derive(Default)]
struct State {
    bulk: Bulk,
    incoming: HashMap<u32, Incoming>,
    outgoing: HashMap<u32, (Instant, Option<Activity>, OwnedSemaphorePermit)>,
}
pub struct Transport {
    state: Mutex<State>,
    pub changed: Notify,
    control: mpsc::Sender<String>,
    update: Option<Arc<UpdateState>>,
    capacity: Arc<Semaphore>,
}
impl Transport {
    pub fn new(control: mpsc::Sender<String>, update: Option<Arc<UpdateState>>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            control,
            update,
            capacity: Arc::new(Semaphore::new(super::wire::BULK_BYTES)),
        })
    }
    fn activity(&self) -> Result<Option<Activity>, String> {
        self.update
            .as_ref()
            .map(|state| state.activity(true))
            .transpose()
    }
    pub fn control(&self, frame: Value) -> Result<(), String> {
        let raw = frame.to_string();
        if raw.len() > CONTROL_BYTES {
            return Err("control frame exceeds protocol limit".into());
        }
        self.control
            .try_send(raw)
            .map_err(|_| "control writer is unavailable".into())
    }
    pub async fn content(
        &self,
        mut frame: Value,
        key: &str,
        bytes: Vec<u8>,
        binary: bool,
    ) -> Result<(), String> {
        if !binary && bytes.len() <= CONTROL_BYTES / 2 {
            frame[key] = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            return self.control(frame);
        }
        let activity = self.activity()?;
        if bytes.len() > super::wire::BULK_BYTES {
            return Err("bulk payload exceeds protocol limit".into());
        }
        let permit = self
            .capacity
            .clone()
            .acquire_many_owned(bytes.len() as u32)
            .await
            .map_err(|_| "bulk transport ended")?;
        // Hashing a large RPC result must never occupy the control reader or its mutex.
        let (bytes, hash) = tokio::task::spawn_blocking(move || {
            let hash = format!("{:x}", Sha256::digest(&bytes));
            (bytes, hash)
        })
        .await
        .map_err(|e| e.to_string())?;
        let stream = {
            let mut state = self.state.lock();
            let stream = state.bulk.send_hashed(bytes, hash)?;
            state
                .outgoing
                .insert(stream.id, (Instant::now(), activity, permit));
            stream
        };
        frame
            .as_object_mut()
            .ok_or("invalid content envelope")?
            .remove(key);
        frame["stream"] = serde_json::to_value(&stream).map_err(|e| e.to_string())?;
        if let Err(error) = self.control(frame) {
            self.cancel_outgoing(stream.id);
            return Err(error);
        }
        Ok(())
    }
    pub fn expect(&self, frame: Value) -> Result<(), String> {
        let stream: Descriptor = serde_json::from_value(frame["stream"].clone())
            .map_err(|_| "invalid bulk descriptor")?;
        let id = stream.id;
        let activity = self.activity()?;
        let bytes = {
            let mut state = self.state.lock();
            let bytes = state.bulk.expect(stream)?;
            state.incoming.insert(
                id,
                Incoming {
                    frame,
                    started: Instant::now(),
                    _activity: activity,
                },
            );
            bytes
        };
        self.control(json!({"t":"credit","id":id,"bytes":bytes}))
    }
    pub fn receive(&self, packet: &[u8]) -> Result<Option<(Value, Vec<u8>)>, String> {
        let (id, credit, body) = self.state.lock().bulk.receive(packet)?;
        if let Some(entry) = self.state.lock().incoming.get_mut(&id) {
            entry.started = Instant::now();
        }
        if credit > 0 {
            self.control(json!({"t":"credit","id":id,"bytes":credit}))?;
        }
        Ok(body.and_then(|bytes| {
            self.state
                .lock()
                .incoming
                .remove(&id)
                .map(|entry| (entry.frame, bytes))
        }))
    }
    pub fn credit(&self, id: u32, bytes: usize) -> Result<(), String> {
        self.state.lock().bulk.credit(id, bytes)?;
        self.changed.notify_one();
        Ok(())
    }
    pub fn next_packet(&self) -> Option<Vec<u8>> {
        self.state.lock().bulk.next_packet()
    }
    pub fn sent(&self, packet: &[u8]) {
        let id = u32::from_be_bytes(packet[..4].try_into().unwrap());
        let mut state = self.state.lock();
        if packet[4] == 1 {
            state.outgoing.remove(&id);
        } else if let Some(entry) = state.outgoing.get_mut(&id) {
            entry.0 = Instant::now();
        }
    }
    pub fn cancel_outgoing(&self, id: u32) {
        let mut state = self.state.lock();
        state.bulk.cancel_send(id);
        state.outgoing.remove(&id);
    }
    pub fn cancel_incoming(&self, id: u32) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            state.bulk.cancel_receive(id);
            state.incoming.remove(&id);
        }
        self.control(json!({"t":"cancel","kind":"stream","id":id}))
    }
    pub fn cancel_request(&self, id: u64) -> Result<(), String> {
        let ids: Vec<u32> = {
            let state = self.state.lock();
            state
                .incoming
                .iter()
                .filter(|(_, entry)| entry.frame["t"] == "req" && entry.frame["id"] == id)
                .map(|(&id, _)| id)
                .collect()
        };
        for stream in ids {
            self.cancel_incoming(stream)?;
        }
        Ok(())
    }
    pub fn timed_out(&self) -> bool {
        let state = self.state.lock();
        state
            .incoming
            .values()
            .any(|entry| entry.started.elapsed().as_secs() >= 30)
            || state
                .outgoing
                .values()
                .any(|(started, _, _)| started.elapsed().as_secs() >= 30)
    }
    pub fn close(&self) {
        self.capacity.close();
        *self.state.lock() = State::default();
        self.changed.notify_one();
    }
}
