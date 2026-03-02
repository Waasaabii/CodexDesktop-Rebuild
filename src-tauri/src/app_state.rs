use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    process::Command,
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
    #[serde(default)]
    pub codex_thread_id: Option<String>,
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

#[derive(Debug, Default)]
struct CodexTurnOutput {
    thread_id: Option<String>,
    assistant_text: Option<String>,
    stream_errors: Vec<String>,
    raw_events: Vec<Value>,
    stderr: String,
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
            codex_thread_id: None,
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

    fn append_user_message_local(
        &self,
        thread_id: &str,
        text: String,
    ) -> Result<(ChatMessage, String, Option<String>, Vec<AppEvent>), String> {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return Err("message cannot be empty".to_string());
        }

        let now = now_ms();
        let user = ChatMessage {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: "user".to_string(),
            text: trimmed,
            ts_ms: now,
        };

        let mut data = self.data.lock().expect("data poisoned");
        let selected_thread_id = data.selected_thread_id.clone();
        let index = data
            .threads
            .iter()
            .position(|item| item.id == thread_id)
            .ok_or_else(|| "thread not found".to_string())?;

        let (thread_snapshot, workspace, codex_thread_id) = {
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
            let snapshot = thread.clone();
            let workspace = snapshot.workspace.clone();
            let codex_thread_id = snapshot.codex_thread_id.clone();
            (snapshot, workspace, codex_thread_id)
        };

        data.messages
            .entry(thread_id.to_string())
            .or_default()
            .push(user.clone());
        self.persist_data(&data)?;
        drop(data);

        let thread_event = self.append_event("thread-upsert", json!(thread_snapshot));
        let user_event = self.append_event("message-upsert", json!(user.clone()));

        Ok((user, workspace, codex_thread_id, vec![thread_event, user_event]))
    }

    fn append_assistant_message_local(
        &self,
        thread_id: &str,
        text: String,
        codex_thread_id: Option<String>,
    ) -> Result<(ChatMessage, Vec<AppEvent>), String> {
        let now = now_ms();
        let final_text = if text.trim().is_empty() {
            "（Codex 未返回文本输出）".to_string()
        } else {
            text.trim().to_string()
        };

        let assistant = ChatMessage {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: "assistant".to_string(),
            text: final_text,
            ts_ms: now,
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
            if selected_thread_id.as_deref() == Some(thread.id.as_str()) {
                thread.unread = 0;
            }
            if let Some(next_thread_id) = codex_thread_id {
                thread.codex_thread_id = Some(next_thread_id);
            }
            thread.clone()
        };

        data.messages
            .entry(thread_id.to_string())
            .or_default()
            .push(assistant.clone());
        self.persist_data(&data)?;
        drop(data);

        let thread_event = self.append_event("thread-upsert", json!(thread_snapshot));
        let assistant_event = self.append_event("message-upsert", json!(assistant.clone()));
        Ok((assistant, vec![thread_event, assistant_event]))
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
        codex_thread_id: None,
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

fn collect_stream_error(target: &mut Vec<String>, message: Option<&str>) {
    if let Some(message) = message.map(str::trim).filter(|value| !value.is_empty()) {
        target.push(message.to_string());
    }
}

fn parse_codex_jsonl(stdout: &str) -> CodexTurnOutput {
    let mut parsed = CodexTurnOutput::default();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        match event_type {
            "thread.started" => {
                if let Some(thread_id) = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|thread_id| !thread_id.is_empty())
                {
                    parsed.thread_id = Some(thread_id.to_string());
                }
            }
            "item.started" | "item.updated" | "item.completed" => {
                if let Some(item) = event.get("item") {
                    match item.get("type").and_then(Value::as_str) {
                        Some("agent_message") => {
                            if let Some(text) = item
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|text| !text.is_empty())
                            {
                                parsed.assistant_text = Some(text.to_string());
                            }
                        }
                        Some("error") => {
                            collect_stream_error(
                                &mut parsed.stream_errors,
                                item.get("message").and_then(Value::as_str),
                            );
                        }
                        _ => {}
                    }
                }
            }
            "turn.failed" => {
                collect_stream_error(
                    &mut parsed.stream_errors,
                    event
                        .get("error")
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str),
                );
            }
            "error" => {
                collect_stream_error(
                    &mut parsed.stream_errors,
                    event.get("message").and_then(Value::as_str),
                );
            }
            _ => {}
        }

        parsed.raw_events.push(event);
    }

    parsed
}

fn resolve_workspace_dir(workspace: &str) -> PathBuf {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let trimmed_workspace = workspace.trim();
    if trimmed_workspace.is_empty() {
        return current_dir;
    }

    let direct_candidate = PathBuf::from(trimmed_workspace);
    if direct_candidate.is_dir() {
        return direct_candidate;
    }

    let relative_candidate = current_dir.join(trimmed_workspace);
    if relative_candidate.is_dir() {
        return relative_candidate;
    }

    current_dir
}

fn run_codex_turn(
    workspace: &str,
    existing_codex_thread_id: Option<&str>,
    prompt: &str,
) -> Result<CodexTurnOutput, String> {
    let trimmed_prompt = prompt.trim();
    if trimmed_prompt.is_empty() {
        return Err("message cannot be empty".to_string());
    }

    let workspace_dir = resolve_workspace_dir(workspace);
    let mut command = Command::new("codex");

    if let Some(thread_id) = existing_codex_thread_id
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
    {
        command.args([
            "exec",
            "resume",
            "--json",
            "--skip-git-repo-check",
            thread_id,
            trimmed_prompt,
        ]);
    } else {
        command.args(["exec", "--json", "--skip-git-repo-check", trimmed_prompt]);
    }
    command.current_dir(&workspace_dir);

    let process_output = command
        .output()
        .map_err(|error| format!("failed to launch codex CLI: {error}"))?;

    let stdout = String::from_utf8_lossy(&process_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&process_output.stderr)
        .trim()
        .to_string();
    let mut parsed = parse_codex_jsonl(&stdout);
    parsed.stderr = stderr.clone();

    if !process_output.status.success() {
        let exit_code = process_output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let mut fragments = vec![format!("codex exited with code {exit_code}")];
        if !parsed.stream_errors.is_empty() {
            fragments.push(format!("stream: {}", parsed.stream_errors.join(" | ")));
        }
        if !stderr.is_empty() {
            fragments.push(format!("stderr: {stderr}"));
        }
        return Err(fragments.join("; "));
    }

    if parsed.thread_id.is_none() {
        parsed.thread_id = existing_codex_thread_id.map(ToString::to_string);
    }

    Ok(parsed)
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
    let (user, workspace, existing_codex_thread_id, initial_events) =
        state.append_user_message_local(&thread_id, text)?;
    for event in &initial_events {
        emit_event(&app, event)?;
    }

    let started_event = state.append_event(
        "codex-turn-status",
        json!({
            "threadId": thread_id,
            "status": "started",
            "codexThreadId": existing_codex_thread_id,
        }),
    );
    emit_event(&app, &started_event)?;

    let turn_result = run_codex_turn(&workspace, existing_codex_thread_id.as_deref(), &user.text);

    let mut next_codex_thread_id = existing_codex_thread_id.clone();
    let mut turn_status = "completed";
    let mut turn_error: Option<String> = None;

    let assistant_text = match turn_result {
        Ok(output) => {
            let CodexTurnOutput {
                thread_id: runtime_thread_id,
                assistant_text: runtime_assistant_text,
                stream_errors,
                raw_events,
                stderr,
            } = output;

            for raw_event in raw_events {
                let stream_event = state.append_event(
                    "codex-turn-event",
                    json!({
                        "threadId": thread_id,
                        "event": raw_event,
                    }),
                );
                emit_event(&app, &stream_event)?;
            }

            if let Some(thread_id_from_codex) = runtime_thread_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                next_codex_thread_id = Some(thread_id_from_codex);
            }

            let mut next_text = runtime_assistant_text
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "（Codex 未返回文本输出）".to_string());

            if next_text == "（Codex 未返回文本输出）" && !stream_errors.is_empty() {
                next_text = format!("Codex 返回错误：{}", stream_errors.join("；"));
            }

            if !stream_errors.is_empty() {
                let warning_event = state.append_event(
                    "codex-turn-warning",
                    json!({
                        "threadId": thread_id,
                        "messages": stream_errors,
                    }),
                );
                emit_event(&app, &warning_event)?;
            }

            if !stderr.is_empty() {
                let stderr_event = state.append_event(
                    "codex-turn-warning",
                    json!({
                        "threadId": thread_id,
                        "messages": [stderr],
                    }),
                );
                emit_event(&app, &stderr_event)?;
            }

            next_text
        }
        Err(error) => {
            turn_status = "failed";
            turn_error = Some(error.clone());
            format!("Codex 执行失败：{error}")
        }
    };

    let (assistant, message_events) = state.append_assistant_message_local(
        &thread_id,
        assistant_text,
        next_codex_thread_id.clone(),
    )?;
    for event in &message_events {
        emit_event(&app, event)?;
    }

    let completed_event = state.append_event(
        "codex-turn-status",
        json!({
            "threadId": thread_id,
            "status": turn_status,
            "codexThreadId": next_codex_thread_id,
            "error": turn_error,
        }),
    );
    emit_event(&app, &completed_event)?;

    Ok(SendMessageResult { user, assistant })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_codex_jsonl_extracts_thread_and_last_agent_message() {
        let sample = r#"
{"type":"thread.started","thread_id":"thread-123"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"first"}}
{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"second"}}
{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}
"#;

        let parsed = parse_codex_jsonl(sample);
        assert_eq!(parsed.thread_id.as_deref(), Some("thread-123"));
        assert_eq!(parsed.assistant_text.as_deref(), Some("second"));
        assert_eq!(parsed.stream_errors.len(), 0);
        assert_eq!(parsed.raw_events.len(), 4);
    }

    #[test]
    fn parse_codex_jsonl_collects_stream_errors() {
        let sample = r#"
not-json-line
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"item error"}}
{"type":"turn.failed","error":{"message":"turn failed"}}
{"type":"error","message":"stream failed"}
"#;

        let parsed = parse_codex_jsonl(sample);
        assert_eq!(
            parsed.stream_errors,
            vec![
                "item error".to_string(),
                "turn failed".to_string(),
                "stream failed".to_string()
            ]
        );
        assert_eq!(parsed.raw_events.len(), 3);
    }

    #[test]
    fn thread_summary_deserializes_without_codex_thread_id() {
        let value = json!({
            "id": "thread-1",
            "title": "Thread 1",
            "workspace": "workspace",
            "updatedAtMs": 1,
            "unread": 0,
            "pinned": false,
            "archived": false
        });

        let parsed: ThreadSummary = serde_json::from_value(value).expect("deserialize thread summary");
        assert_eq!(parsed.codex_thread_id, None);
    }

    #[test]
    fn append_assistant_message_updates_persisted_codex_thread_id() {
        let mut state_file = std::env::temp_dir();
        state_file.push(format!("codex-tauri-state-{}.json", Uuid::new_v4()));

        let state = AppState::new(state_file.clone());
        let bootstrap = state.bootstrap_payload();
        let thread_id = bootstrap
            .selected_thread_id
            .expect("selected thread should exist");

        let _ = state
            .append_user_message_local(&thread_id, "hello".to_string())
            .expect("append user message");
        let _ = state
            .append_assistant_message_local(
                &thread_id,
                "world".to_string(),
                Some("codex-thread-1".to_string()),
            )
            .expect("append assistant message");

        let refreshed = state.bootstrap_payload();
        let thread = refreshed
            .threads
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .expect("thread should exist");
        assert_eq!(thread.codex_thread_id.as_deref(), Some("codex-thread-1"));

        let persisted = load_or_create_store(&state_file);
        let persisted_thread = persisted
            .threads
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .expect("persisted thread should exist");
        assert_eq!(persisted_thread.codex_thread_id.as_deref(), Some("codex-thread-1"));

        let _ = fs::remove_file(state_file);
    }
}
