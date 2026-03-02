use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_RETAINED_EVENTS: usize = 30_000;
const EVENT_CHANNEL: &str = "codex_app:event";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub updated_at_ms: u64,
    pub unread: u32,
    pub pinned: bool,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub text: String,
    pub ts_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    pub emitted_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatch {
    pub latest_seq: u64,
    pub events: Vec<AppEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub threads: Vec<ThreadSummary>,
    pub selected_thread_id: Option<String>,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResult {
    pub user: ChatMessage,
    pub assistant: ChatMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredData {
    threads: Vec<ThreadSummary>,
    messages: HashMap<String, Vec<ChatMessage>>,
    selected_thread_id: Option<String>,
}

#[derive(Debug)]
pub struct AppState {
    seq: AtomicU64,
    events: Mutex<VecDeque<AppEvent>>,
    data: Mutex<StoredData>,
    file_path: PathBuf,
}

impl AppState {
    pub fn new(file_path: PathBuf) -> Self {
        let data = load_or_create_store(&file_path);
        Self {
            seq: AtomicU64::new(0),
            events: Mutex::new(VecDeque::new()),
            data: Mutex::new(data),
            file_path,
        }
    }

    fn append_event(&self, kind: impl Into<String>, payload: Value) -> AppEvent {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = AppEvent {
            seq,
            kind: kind.into(),
            payload,
            emitted_at_ms: now_ms(),
        };
        let mut queue = self.events.lock().expect("events queue poisoned");
        queue.push_back(event.clone());
        while queue.len() > MAX_RETAINED_EVENTS {
            let _ = queue.pop_front();
        }
        event
    }

    fn latest_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    fn events_since(&self, last_seq: u64) -> Vec<AppEvent> {
        let queue = self.events.lock().expect("events queue poisoned");
        queue
            .iter()
            .filter(|event| event.seq > last_seq)
            .cloned()
            .collect()
    }

    fn sorted_threads(threads: &[ThreadSummary]) -> Vec<ThreadSummary> {
        let mut sorted = threads.to_vec();
        sorted.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then_with(|| right.updated_at_ms.cmp(&left.updated_at_ms))
                .then_with(|| left.title.cmp(&right.title))
        });
        sorted
    }

    fn persist_data(&self, data: &StoredData) -> Result<(), String> {
        let encoded = serde_json::to_string_pretty(data).map_err(|err| err.to_string())?;
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(&self.file_path, encoded).map_err(|err| err.to_string())
    }

    fn bootstrap_payload(&self) -> BootstrapPayload {
        let data = self.data.lock().expect("data poisoned");
        let selected_thread_id = data
            .selected_thread_id
            .clone()
            .or_else(|| data.threads.first().map(|thread| thread.id.clone()));

        let messages = selected_thread_id
            .as_ref()
            .and_then(|thread_id| data.messages.get(thread_id))
            .cloned()
            .unwrap_or_default();

        BootstrapPayload {
            threads: AppState::sorted_threads(&data.threads),
            selected_thread_id,
            messages,
        }
    }

    fn messages_for_thread(&self, thread_id: &str) -> Vec<ChatMessage> {
        let data = self.data.lock().expect("data poisoned");
        data.messages.get(thread_id).cloned().unwrap_or_default()
    }

    fn create_thread_local(
        &self,
        title: Option<String>,
        workspace: Option<String>,
    ) -> Result<(ThreadSummary, AppEvent), String> {
        let now = now_ms();
        let thread = ThreadSummary {
            id: Uuid::new_v4().to_string(),
            title: title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "新线程".to_string()),
            workspace: workspace
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "CodexDesktop-Rebuild".to_string()),
            updated_at_ms: now,
            unread: 0,
            pinned: false,
            archived: false,
        };

        let mut data = self.data.lock().expect("data poisoned");
        data.threads.push(thread.clone());
        data.messages.insert(thread.id.clone(), Vec::new());
        data.selected_thread_id = Some(thread.id.clone());
        self.persist_data(&data)?;
        drop(data);

        let event = self.append_event("thread-upsert", json!(thread));
        Ok((thread, event))
    }

    fn select_thread_local(&self, thread_id: &str) -> Result<(ThreadSummary, AppEvent), String> {
        let mut data = self.data.lock().expect("data poisoned");
        let index = data
            .threads
            .iter()
            .position(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;

        data.selected_thread_id = Some(thread_id.to_string());
        let updated = {
            let thread = data
                .threads
                .get_mut(index)
                .expect("thread index out of bounds");
            thread.unread = 0;
            thread.updated_at_ms = now_ms();
            thread.clone()
        };
        self.persist_data(&data)?;
        drop(data);

        let event = self.append_event("thread-upsert", json!(updated));
        Ok((updated, event))
    }

    fn rename_thread_local(
        &self,
        thread_id: &str,
        title: String,
    ) -> Result<(ThreadSummary, AppEvent), String> {
        let next_title = title.trim().to_string();
        if next_title.is_empty() {
            return Err("title cannot be empty".to_string());
        }

        let mut data = self.data.lock().expect("data poisoned");
        let thread = data
            .threads
            .iter_mut()
            .find(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;
        thread.title = next_title;
        thread.updated_at_ms = now_ms();
        let updated = thread.clone();
        self.persist_data(&data)?;
        drop(data);

        let event = self.append_event("thread-upsert", json!(updated));
        Ok((updated, event))
    }

    fn toggle_pin_thread_local(&self, thread_id: &str) -> Result<(ThreadSummary, AppEvent), String> {
        let mut data = self.data.lock().expect("data poisoned");
        let thread = data
            .threads
            .iter_mut()
            .find(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;
        thread.pinned = !thread.pinned;
        thread.updated_at_ms = now_ms();
        let updated = thread.clone();
        self.persist_data(&data)?;
        drop(data);

        let event = self.append_event("thread-upsert", json!(updated));
        Ok((updated, event))
    }

    fn set_thread_archived_local(
        &self,
        thread_id: &str,
        archived: bool,
    ) -> Result<(ThreadSummary, AppEvent), String> {
        let mut data = self.data.lock().expect("data poisoned");
        let thread = data
            .threads
            .iter_mut()
            .find(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;
        thread.archived = archived;
        thread.updated_at_ms = now_ms();
        thread.unread = 0;
        let updated = thread.clone();
        self.persist_data(&data)?;
        drop(data);

        let event = self.append_event("thread-upsert", json!(updated));
        Ok((updated, event))
    }

    fn send_message_local(
        &self,
        thread_id: &str,
        text: String,
    ) -> Result<(SendMessageResult, Vec<AppEvent>), String> {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return Err("message cannot be empty".to_string());
        }

        let now = now_ms();
        let user = ChatMessage {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: "user".to_string(),
            text: trimmed.clone(),
            ts_ms: now,
        };
        let assistant = ChatMessage {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: "assistant".to_string(),
            text: ai_reply(&trimmed),
            ts_ms: now_ms(),
        };

        let mut data = self.data.lock().expect("data poisoned");
        let selected_thread_id = data.selected_thread_id.clone();
        let index = data
            .threads
            .iter()
            .position(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;

        let thread_snapshot = {
            let thread = data
                .threads
                .get_mut(index)
                .expect("thread index out of bounds");
            thread.updated_at_ms = now_ms();
            if selected_thread_id.as_deref() != Some(thread.id.as_str()) {
                thread.unread = thread.unread.saturating_add(1);
            } else {
                thread.unread = 0;
            }
            thread.clone()
        };

        {
            let bucket = data.messages.entry(thread_id.to_string()).or_default();
            bucket.push(user.clone());
            bucket.push(assistant.clone());
        }
        self.persist_data(&data)?;
        drop(data);

        let thread_event = self.append_event("thread-upsert", json!(thread_snapshot));
        let user_event = self.append_event("message-upsert", json!(user.clone()));
        let assistant_event = self.append_event("message-upsert", json!(assistant.clone()));

        Ok((
            SendMessageResult {
                user,
                assistant,
            },
            vec![thread_event, user_event, assistant_event],
        ))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn default_store() -> StoredData {
    let thread_id = Uuid::new_v4().to_string();
    let now = now_ms();

    let thread = ThreadSummary {
        id: thread_id.clone(),
        title: "新线程".to_string(),
        workspace: "CodexDesktop-Rebuild".to_string(),
        updated_at_ms: now,
        unread: 0,
        pinned: false,
        archived: false,
    };

    let welcome = ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: thread_id.clone(),
        role: "assistant".to_string(),
        text: "欢迎使用 Tauri 版 Codex。这个版本是纯 Tauri 架构，支持线程持久化、增量同步和长列表性能优化。".to_string(),
        ts_ms: now,
    };

    let mut messages = HashMap::new();
    messages.insert(thread_id.clone(), vec![welcome]);

    StoredData {
        threads: vec![thread],
        messages,
        selected_thread_id: Some(thread_id),
    }
}

fn load_or_create_store(file_path: &PathBuf) -> StoredData {
    match fs::read_to_string(file_path) {
        Ok(content) => serde_json::from_str::<StoredData>(&content).unwrap_or_else(|_| default_store()),
        Err(_) => default_store(),
    }
}

fn ai_reply(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "我收到的是空内容，可以再具体一点吗？".to_string();
    }
    if trimmed.contains("测试") {
        return "测试已记录。当前链路：前端发送 -> Rust 入队 -> 实时事件 + 增量同步。".to_string();
    }
    if trimmed.contains("性能") {
        return "性能建议：优先控制渲染批量、减少消息重排、保持虚拟列表锚点稳定。".to_string();
    }
    format!("已收到：{}。我会继续按纯 Tauri 架构推进。", trimmed)
}

fn emit_event(app: &AppHandle, event: &AppEvent) -> Result<(), String> {
    app.emit(EVENT_CHANNEL, event.clone())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn app_get_bootstrap(state: State<'_, AppState>) -> BootstrapPayload {
    state.bootstrap_payload()
}

#[tauri::command]
pub fn app_get_messages(state: State<'_, AppState>, thread_id: String) -> Vec<ChatMessage> {
    state.messages_for_thread(&thread_id)
}

#[tauri::command]
pub fn app_sync_since(state: State<'_, AppState>, last_seq: u64) -> SyncBatch {
    SyncBatch {
        latest_seq: state.latest_seq(),
        events: state.events_since(last_seq),
    }
}

#[tauri::command]
pub fn app_create_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    workspace: Option<String>,
) -> Result<ThreadSummary, String> {
    let (thread, event) = state.create_thread_local(title, workspace)?;
    emit_event(&app, &event)?;
    Ok(thread)
}

#[tauri::command]
pub fn app_select_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadSummary, String> {
    let (updated, event) = state.select_thread_local(&thread_id)?;
    emit_event(&app, &event)?;
    Ok(updated)
}

#[tauri::command]
pub fn app_rename_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    title: String,
) -> Result<ThreadSummary, String> {
    let (updated, event) = state.rename_thread_local(&thread_id, title)?;
    emit_event(&app, &event)?;
    Ok(updated)
}

#[tauri::command]
pub fn app_toggle_pin_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadSummary, String> {
    let (updated, event) = state.toggle_pin_thread_local(&thread_id)?;
    emit_event(&app, &event)?;
    Ok(updated)
}

#[tauri::command]
pub fn app_set_thread_archived(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    archived: bool,
) -> Result<ThreadSummary, String> {
    let (updated, event) = state.set_thread_archived_local(&thread_id, archived)?;
    emit_event(&app, &event)?;
    Ok(updated)
}

#[tauri::command]
pub fn app_send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
) -> Result<SendMessageResult, String> {
    let (result, events) = state.send_message_local(&thread_id, text)?;
    for event in &events {
        emit_event(&app, event)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        let base = std::env::temp_dir().join(format!("codex-tauri-test-{}", Uuid::new_v4()));
        AppState::new(base.join("state.json"))
    }

    #[test]
    fn create_and_select_thread_flow() {
        let state = test_state();
        let (created, _) = state
            .create_thread_local(Some("T1".to_string()), Some("W".to_string()))
            .expect("create");

        let (selected, _) = state
            .select_thread_local(&created.id)
            .expect("select");

        assert_eq!(selected.id, created.id);
        assert_eq!(selected.unread, 0);

        let bootstrap = state.bootstrap_payload();
        assert!(bootstrap.threads.iter().any(|thread| thread.id == created.id));
        assert_eq!(bootstrap.selected_thread_id, Some(created.id));
    }

    #[test]
    fn send_message_generates_assistant_reply() {
        let state = test_state();
        let thread_id = {
            let bootstrap = state.bootstrap_payload();
            bootstrap.selected_thread_id.expect("selected thread")
        };

        let (result, events) = state
            .send_message_local(&thread_id, "测试消息".to_string())
            .expect("send");

        assert_eq!(result.user.role, "user");
        assert_eq!(result.assistant.role, "assistant");
        assert_eq!(events.len(), 3);
        assert!(result.assistant.text.contains("测试"));

        let messages = state.messages_for_thread(&thread_id);
        assert!(messages.iter().any(|msg| msg.id == result.user.id));
        assert!(messages.iter().any(|msg| msg.id == result.assistant.id));
    }

    #[test]
    fn events_queue_respects_sequence() {
        let state = test_state();
        let first = state.append_event("x", json!({"v": 1}));
        let second = state.append_event("x", json!({"v": 2}));
        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        let events = state.events_since(1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, 2);
    }

    #[test]
    fn archive_pin_and_rename_update() {
        let state = test_state();
        let thread_id = {
            let bootstrap = state.bootstrap_payload();
            bootstrap.selected_thread_id.expect("selected thread")
        };

        let (renamed, _) = state
            .rename_thread_local(&thread_id, "重命名线程".to_string())
            .expect("rename");
        assert_eq!(renamed.title, "重命名线程");

        let (pinned, _) = state.toggle_pin_thread_local(&thread_id).expect("pin");
        assert!(pinned.pinned);

        let (archived, _) = state
            .set_thread_archived_local(&thread_id, true)
            .expect("archive");
        assert!(archived.archived);

        let bootstrap = state.bootstrap_payload();
        let thread = bootstrap
            .threads
            .into_iter()
            .find(|item| item.id == thread_id)
            .expect("thread");
        assert!(thread.pinned);
        assert!(thread.archived);
        assert_eq!(thread.title, "重命名线程");
    }

    #[test]
    fn sync_since_returns_new_events_for_feature_operations() {
        let state = test_state();
        let seq0 = state.latest_seq();
        let thread_id = {
            let bootstrap = state.bootstrap_payload();
            bootstrap.selected_thread_id.expect("selected thread")
        };

        let _ = state
            .rename_thread_local(&thread_id, "A".to_string())
            .expect("rename");
        let _ = state.toggle_pin_thread_local(&thread_id).expect("pin");
        let _ = state
            .send_message_local(&thread_id, "性能测试".to_string())
            .expect("send");

        let events = state.events_since(seq0);
        assert!(events.iter().any(|event| event.kind == "thread-upsert"));
        assert!(events.iter().any(|event| event.kind == "message-upsert"));
        assert!(events.len() >= 5);
    }
}
