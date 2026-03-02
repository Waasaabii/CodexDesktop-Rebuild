use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_RETAINED_EVENTS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeEvent {
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    pub emitted_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAck {
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatch {
    pub latest_seq: u64,
    pub events: Vec<BridgeEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryInitOptions {
    pub codex_app_session_id: String,
    pub dsn: Option<String>,
    pub environment: String,
    pub release: Option<String>,
}

#[derive(Debug)]
pub struct BridgeState {
    seq: AtomicU64,
    events: Mutex<VecDeque<BridgeEvent>>,
    sentry_init_options: SentryInitOptions,
    build_flavor: String,
}

impl Default for BridgeState {
    fn default() -> Self {
        let build_flavor = std::env::var("BUILD_FLAVOR").unwrap_or_else(|_| "prod".to_string());
        let sentry_init_options = SentryInitOptions {
            codex_app_session_id: Uuid::new_v4().to_string(),
            dsn: None,
            environment: "desktop".to_string(),
            release: None,
        };

        Self {
            seq: AtomicU64::new(0),
            events: Mutex::new(VecDeque::new()),
            sentry_init_options,
            build_flavor,
        }
    }
}

impl BridgeState {
    fn append_event(&self, kind: impl Into<String>, payload: Value) -> BridgeEvent {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = BridgeEvent {
            seq,
            kind: kind.into(),
            payload,
            emitted_at_ms: now_ms(),
        };

        let mut events = self.events.lock().expect("bridge events poisoned");
        events.push_back(event.clone());
        while events.len() > MAX_RETAINED_EVENTS {
            let _ = events.pop_front();
        }

        event
    }

    fn latest_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    fn events_since(&self, last_seq: u64) -> Vec<BridgeEvent> {
        let events = self.events.lock().expect("bridge events poisoned");
        events
            .iter()
            .filter(|event| event.seq > last_seq)
            .cloned()
            .collect()
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[tauri::command]
pub fn bridge_get_sentry_init_options(state: State<'_, BridgeState>) -> SentryInitOptions {
    state.sentry_init_options.clone()
}

#[tauri::command]
pub fn bridge_get_build_flavor(state: State<'_, BridgeState>) -> String {
    state.build_flavor.clone()
}

#[tauri::command]
pub fn bridge_sync_since(state: State<'_, BridgeState>, last_seq: u64) -> SyncBatch {
    SyncBatch {
        latest_seq: state.latest_seq(),
        events: state.events_since(last_seq),
    }
}

#[tauri::command]
pub fn bridge_show_context_menu(
    state: State<'_, BridgeState>,
    menu: Value,
) -> Result<BridgeAck, String> {
    let event = state.append_event("show-context-menu", menu);
    Ok(BridgeAck { seq: event.seq })
}

#[tauri::command]
pub fn bridge_send_message(
    app: AppHandle,
    state: State<'_, BridgeState>,
    message: Value,
) -> Result<BridgeAck, String> {
    let _inbound = state.append_event("message-from-view", message.clone());
    let outbound = state.append_event("message-for-view", message.clone());
    app.emit("codex_desktop:message-for-view", message)
        .map_err(|err| err.to_string())?;
    Ok(BridgeAck { seq: outbound.seq })
}

#[tauri::command]
pub fn bridge_send_worker_message(
    app: AppHandle,
    state: State<'_, BridgeState>,
    worker_id: String,
    message: Value,
) -> Result<BridgeAck, String> {
    let inbound_kind = format!("worker:{worker_id}:from-view");
    let _inbound = state.append_event(inbound_kind, message.clone());
    let outbound_kind = format!("worker:{worker_id}:for-view");
    let outbound = state.append_event(outbound_kind, message.clone());
    let channel = format!("codex_desktop:worker:{worker_id}:for-view");
    app.emit(&channel, message).map_err(|err| err.to_string())?;
    Ok(BridgeAck { seq: outbound.seq })
}

#[tauri::command]
pub fn bridge_trigger_sentry_test_error(
    state: State<'_, BridgeState>,
    payload: Option<Value>,
) -> Result<BridgeAck, String> {
    let event = state.append_event("sentry-test-error", payload.unwrap_or(Value::Null));
    Err(format!(
        "intentional sentry test error, seq={}",
        event.seq
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_events_in_monotonic_order() {
        let state = BridgeState::default();
        let first = state.append_event("a", Value::Null);
        let second = state.append_event("b", Value::Null);
        let third = state.append_event("c", Value::Null);

        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(third.seq, 3);
        assert_eq!(state.latest_seq(), 3);
    }

    #[test]
    fn sync_since_returns_only_new_items() {
        let state = BridgeState::default();
        let _ = state.append_event("a", Value::String("one".into()));
        let second = state.append_event("b", Value::String("two".into()));
        let _ = state.append_event("c", Value::String("three".into()));

        let events = state.events_since(second.seq);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "c");
    }

    #[test]
    fn sync_since_keeps_for_view_events() {
        let state = BridgeState::default();
        let _ = state.append_event("message-from-view", Value::String("hello".into()));
        let to_view = state.append_event("message-for-view", Value::String("world".into()));

        let events = state.events_since(to_view.seq - 1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "message-for-view");
        assert_eq!(events[0].payload, Value::String("world".into()));
    }
}
