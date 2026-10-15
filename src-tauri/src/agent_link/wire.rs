use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

pub const CONTROL_BYTES: usize = 1024 * 1024;
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const CREDIT_BYTES: usize = 4 * 1024 * 1024;
pub const BULK_BYTES: usize = 128 * 1024 * 1024;
const SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

fn integer(value: &Value, min: u64, max: u64) -> bool {
    value.as_u64().is_some_and(|n| n >= min && n <= max)
        || value.as_f64().is_some_and(|n| {
            n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64
        })
}
fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= 32 && items.iter().all(Value::is_string))
}
fn descriptor(value: &Value) -> bool {
    integer(&value["id"], 1, u32::MAX as u64)
        && integer(&value["bytes"], 0, BULK_BYTES as u64)
        && value["sha256"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
pub fn parse_control(raw: &str) -> Result<Value, String> {
    if raw.len() > CONTROL_BYTES {
        return Err("invalid control frame".into());
    }
    let frame: Value = serde_json::from_str(raw).map_err(|_| "invalid control frame")?;
    if !frame.is_object() {
        return Err("invalid control frame".into());
    }
    let id = integer(&frame["id"], 1, SAFE_INTEGER);
    let content = |key: &str| {
        if frame["stream"].is_null() {
            frame.get(key).is_some()
        } else {
            descriptor(&frame["stream"]) && frame.get(key).is_none()
        }
    };
    let valid = match frame["t"].as_str().unwrap_or("") {
        "hello" => {
            frame["protocol"] == 1
                && frame["machineId"].is_string()
                && frame["name"].is_string()
                && frame["version"].is_string()
                && strings(&frame["capabilities"])
        }
        "welcome" => {
            frame["protocol"] == 1
                && frame["connectionId"].is_string()
                && integer(&frame["heartbeatMs"], 1000, 30000)
        }
        "reject" => frame["reason"].is_string(),
        "ready" => frame["version"].is_string() && strings(&frame["capabilities"]),
        "bulk-hello" => {
            frame["connectionId"].is_string()
                && frame["machineId"].is_string()
                && frame["token"].is_string()
        }
        "bulk-ready" => frame["connectionId"].is_string(),
        "req" => {
            id && frame["cmd"].as_str().is_some_and(|s| !s.is_empty())
                && content("args")
                && integer(&frame["deadlineMs"], 0, 900000)
        }
        "res" => {
            id && if frame["ok"] == true {
                content("data")
            } else {
                frame["ok"] == false
                    && frame["error"]["code"].is_string()
                    && frame["error"]["message"].is_string()
                    && frame["error"]["definitive"].is_boolean()
            }
        }
        "event" => {
            frame["name"].is_string()
                && content("payload")
                && (frame["runId"].is_null() || frame["runId"].is_string())
                && !(!frame["stream"].is_null()
                    && matches!(
                        frame["name"].as_str(),
                        Some("engine://event" | "plugin-agent://event" | "mission-agent://event")
                    )
                    && !frame["runId"].as_str().is_some_and(|s| !s.is_empty()))
        }
        "hb" => {
            integer(&frame["seq"], 1, SAFE_INTEGER)
                && integer(&frame["journalHead"], 0, SAFE_INTEGER)
                && frame["activeRuns"].as_array().is_some_and(|runs| {
                    runs.iter().all(|run| {
                        run["runId"].is_string()
                            && run["engine"].is_string()
                            && run["workspacePath"].is_string()
                            && (run["sessionId"].is_null() || run["sessionId"].is_string())
                            && integer(&run["startedAt"], 0, SAFE_INTEGER)
                            && matches!(
                                run["state"].as_str(),
                                Some("running" | "awaiting-approval" | "awaiting-input")
                            )
                            && integer(&run["updatedAt"], 0, SAFE_INTEGER)
                    })
                })
        }
        "hb-ack" => integer(&frame["seq"], 1, SAFE_INTEGER),
        "cancel" => id && matches!(frame["kind"].as_str(), Some("request" | "stream")),
        "credit" => {
            integer(&frame["id"], 1, u32::MAX as u64)
                && integer(&frame["bytes"], 1, CREDIT_BYTES as u64)
        }
        "open" => {
            id && frame["path"].as_str().is_some_and(|s| s.starts_with('/'))
                && frame["method"].is_string()
                && frame["ws"].is_boolean()
                && frame["headers"].is_object()
        }
        "head" => id && integer(&frame["status"], 100, 599) && frame["headers"].is_object(),
        "body" | "data" => {
            id && descriptor(&frame["stream"])
                && (frame["text"].is_null() || frame["text"].is_boolean())
        }
        "end" | "close" => id,
        "error" => id && frame["message"].is_string(),
        _ => false,
    };
    if valid {
        Ok(frame)
    } else {
        Err("invalid control frame".into())
    }
}

pub fn parse_packet(packet: &[u8]) -> Result<(u32, bool, &[u8]), String> {
    if packet.len() < 5
        || packet.len() > CHUNK_BYTES + 5
        || packet[4] > 1
        || packet.len() == 5 && packet[4] == 0
    {
        return Err("invalid bulk packet".into());
    }
    let id = u32::from_be_bytes(packet[..4].try_into().unwrap());
    if id == 0 {
        return Err("invalid bulk packet".into());
    }
    Ok((id, packet[4] == 1, &packet[5..]))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Descriptor {
    pub id: u32,
    pub bytes: usize,
    pub sha256: String,
}
struct Outgoing {
    bytes: Vec<u8>,
    offset: usize,
    credit: usize,
    granted: bool,
}
struct Incoming {
    descriptor: Descriptor,
    bytes: Vec<u8>,
    credit: usize,
    hash: Sha256,
}
#[derive(Default)]
pub struct Bulk {
    next_id: u32,
    outgoing: HashMap<u32, Outgoing>,
    incoming: HashMap<u32, Incoming>,
    order: VecDeque<u32>,
    cancelled: HashMap<u32, (usize, Instant)>,
    out_bytes: usize,
    in_bytes: usize,
}
impl Bulk {
    #[cfg(test)]
    pub fn send(&mut self, bytes: Vec<u8>) -> Result<Descriptor, String> {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        self.send_hashed(bytes, hash)
    }
    pub fn send_hashed(&mut self, bytes: Vec<u8>, sha256: String) -> Result<Descriptor, String> {
        if bytes.len() > BULK_BYTES || self.out_bytes + bytes.len() > BULK_BYTES {
            return Err("bulk send capacity exceeded".into());
        }
        let id = self
            .next_id
            .checked_add(1)
            .ok_or("bulk stream ids exhausted")?;
        self.next_id = id;
        let descriptor = Descriptor {
            id,
            bytes: bytes.len(),
            sha256,
        };
        self.out_bytes += bytes.len();
        self.outgoing.insert(
            id,
            Outgoing {
                bytes,
                offset: 0,
                credit: 0,
                granted: false,
            },
        );
        self.order.push_back(id);
        Ok(descriptor)
    }
    pub fn credit(&mut self, id: u32, bytes: usize) -> Result<(), String> {
        if bytes == 0 || bytes > CREDIT_BYTES {
            return Err("invalid bulk credit".into());
        }
        if let Some(state) = self.outgoing.get_mut(&id) {
            if state.credit + bytes > CREDIT_BYTES {
                return Err("invalid bulk credit".into());
            }
            state.credit += bytes;
            state.granted = true;
        }
        Ok(())
    }
    pub fn next_packet(&mut self) -> Option<Vec<u8>> {
        for _ in 0..self.order.len() {
            let id = self.order.pop_front()?;
            let Some(state) = self.outgoing.get_mut(&id) else {
                continue;
            };
            let size = CHUNK_BYTES.min(state.bytes.len() - state.offset);
            if !state.granted || state.credit < size {
                self.order.push_back(id);
                continue;
            }
            let end = state.offset + size;
            let finished = end == state.bytes.len();
            let mut packet = Vec::with_capacity(5 + size);
            packet.extend_from_slice(&id.to_be_bytes());
            packet.push(u8::from(finished));
            packet.extend_from_slice(&state.bytes[state.offset..end]);
            state.offset = end;
            state.credit -= size;
            if finished {
                let state = self.outgoing.remove(&id).unwrap();
                self.out_bytes -= state.bytes.len();
            } else {
                self.order.push_back(id);
            }
            return Some(packet);
        }
        None
    }
    pub fn expect(&mut self, stream: Descriptor) -> Result<usize, String> {
        self.cancelled
            .retain(|_, (_, deadline)| *deadline > Instant::now());
        if stream.id == 0
            || stream.bytes > BULK_BYTES
            || self.in_bytes + stream.bytes > BULK_BYTES
            || self.incoming.contains_key(&stream.id)
            || self.cancelled.contains_key(&stream.id)
            || !descriptor(&serde_json::to_value(&stream).map_err(|e| e.to_string())?)
        {
            return Err("invalid bulk descriptor".into());
        }
        self.in_bytes += stream.bytes;
        self.incoming.insert(
            stream.id,
            Incoming {
                bytes: Vec::with_capacity(stream.bytes),
                descriptor: stream,
                credit: CREDIT_BYTES,
                hash: Sha256::new(),
            },
        );
        Ok(CREDIT_BYTES)
    }
    pub fn receive(&mut self, packet: &[u8]) -> Result<(u32, usize, Option<Vec<u8>>), String> {
        let (id, end, bytes) = parse_packet(packet)?;
        if let Some((remaining, deadline)) = self.cancelled.get_mut(&id) {
            if Instant::now() >= *deadline || bytes.len() > *remaining {
                return Err("unexpected cancelled bulk packet".into());
            }
            *remaining -= bytes.len();
            if end {
                self.cancelled.remove(&id);
            }
            return Ok((id, 0, None));
        }
        let state = self.incoming.get_mut(&id).ok_or("unexpected bulk packet")?;
        if bytes.len() > state.credit || state.bytes.len() + bytes.len() > state.descriptor.bytes {
            return Err("unexpected bulk packet".into());
        }
        state.credit -= bytes.len();
        state.hash.update(bytes);
        state.bytes.extend_from_slice(bytes);
        if end {
            let state = self.incoming.remove(&id).unwrap();
            self.in_bytes -= state.descriptor.bytes;
            if state.bytes.len() != state.descriptor.bytes {
                return Err("incomplete bulk payload".into());
            }
            if format!("{:x}", state.hash.finalize()) != state.descriptor.sha256 {
                return Err("bulk checksum mismatch".into());
            }
            Ok((id, 0, Some(state.bytes)))
        } else {
            state.credit += bytes.len();
            Ok((id, bytes.len(), None))
        }
    }
    pub fn cancel_send(&mut self, id: u32) {
        if let Some(state) = self.outgoing.remove(&id) {
            self.out_bytes -= state.bytes.len();
        }
        self.order.retain(|value| *value != id);
    }
    pub fn cancel_receive(&mut self, id: u32) {
        if let Some(state) = self.incoming.remove(&id) {
            self.in_bytes -= state.descriptor.bytes;
            self.cancelled
                .insert(id, (state.credit, Instant::now() + Duration::from_secs(30)));
        }
    }
    #[cfg(test)]
    pub fn outgoing_bytes(&self) -> usize {
        self.out_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rust_and_hub_share_frame_and_binary_header_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-link-v1.frames.json"
        ))
        .unwrap();
        assert_eq!(fixture["limits"]["creditBytes"], CREDIT_BYTES);
        for frame in fixture["valid"].as_array().unwrap() {
            let raw = frame.to_string();
            assert_eq!(
                parse_control(&raw).unwrap_or_else(|e| panic!("{e}: {raw}")),
                *frame
            );
        }
        for frame in fixture["invalid"].as_array().unwrap() {
            assert!(parse_control(frame.as_str().unwrap_or(&frame.to_string())).is_err());
        }
        let decode = |value: &Value| {
            let s = value.as_str().unwrap();
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>()
        };
        for value in fixture["binaryValid"].as_array().unwrap() {
            assert!(parse_packet(&decode(value)).is_ok());
        }
        for value in fixture["binaryInvalid"].as_array().unwrap() {
            assert!(parse_packet(&decode(value)).is_err());
        }
    }
    #[test]
    fn large_unicode_crosses_bounded_chunks_and_is_only_released_after_sha_verification() {
        let expected = "完整结果🙂\n```ts\nconst a = 1;\n```"
            .repeat(200000)
            .into_bytes();
        let mut sender = Bulk::default();
        let mut receiver = Bulk::default();
        let descriptor = sender.send(expected.clone()).unwrap();
        assert!(
            sender.next_packet().is_none(),
            "a descriptor must be acknowledged before data"
        );
        sender
            .credit(descriptor.id, receiver.expect(descriptor.clone()).unwrap())
            .unwrap();
        let mut count = 0;
        let mut complete = None;
        while let Some(packet) = sender.next_packet() {
            count += 1;
            assert!(packet.len() <= CHUNK_BYTES + 5);
            let (id, credit, result) = receiver.receive(&packet).unwrap();
            if credit > 0 {
                sender.credit(id, credit).unwrap();
            }
            if result.is_some() {
                assert!(complete.is_none());
                complete = result;
            }
        }
        assert!(count > 20);
        assert_eq!(complete.unwrap(), expected);
        assert_eq!(sender.outgoing_bytes(), 0);
    }
    #[test]
    fn cancellation_and_equal_ids_in_opposite_directions_do_not_mix_streams() {
        let mut a = Bulk::default();
        let mut b = Bulk::default();
        let da = a.send(vec![1; CHUNK_BYTES * 3]).unwrap();
        let db = b.send(vec![2; CHUNK_BYTES * 2]).unwrap();
        a.credit(da.id, b.expect(da.clone()).unwrap()).unwrap();
        b.credit(db.id, a.expect(db.clone()).unwrap()).unwrap();
        assert_eq!(da.id, db.id);
        let queued = a.next_packet().unwrap();
        b.cancel_receive(da.id);
        a.cancel_send(da.id);
        assert!(b.receive(&queued).unwrap().2.is_none());
        let mut result = None;
        while let Some(packet) = b.next_packet() {
            let (id, credit, body) = a.receive(&packet).unwrap();
            if credit > 0 {
                b.credit(id, credit).unwrap();
            }
            if body.is_some() {
                result = body;
            }
        }
        assert_eq!(result.unwrap(), vec![2; CHUNK_BYTES * 2]);
    }
    #[test]
    fn hashes_empty_streams_and_credit_overflow_are_checked() {
        let mut a = Bulk::default();
        let mut b = Bulk::default();
        let descriptor = a.send(Vec::new()).unwrap();
        a.credit(descriptor.id, b.expect(descriptor).unwrap())
            .unwrap();
        assert_eq!(
            b.receive(&a.next_packet().unwrap()).unwrap().2.unwrap(),
            Vec::<u8>::new()
        );
        let descriptor = a.send(b"ok".to_vec()).unwrap();
        a.credit(descriptor.id, b.expect(descriptor.clone()).unwrap())
            .unwrap();
        assert!(a.credit(descriptor.id, 1).is_err());
        let mut packet = a.next_packet().unwrap();
        packet[5] = b'n';
        assert!(b.receive(&packet).unwrap_err().contains("checksum"));
    }
}
