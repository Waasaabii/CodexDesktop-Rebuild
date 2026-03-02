import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  IconArchive,
  IconAutomation,
  IconClose,
  IconEdit,
  IconLogo,
  IconMagic,
  IconMaximize,
  IconMenu,
  IconMinimize,
  IconPin,
  IconSearch,
  IconSend,
  IconSettings,
  IconSkill,
  IconThread,
} from "./icons";
import { useAppSync } from "./hooks/useAppSync";

function formatAgo(ts) {
  const diffMinutes = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (diffMinutes < 60) return `${diffMinutes} 分`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时`;
  const days = Math.round(diffHours / 24);
  return `${days} 天`;
}

function sortThreads(threads, showArchived) {
  return [...threads]
    .filter((thread) => (showArchived ? true : !thread.archived))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return right.pinned ? 1 : -1;
      }
      return right.updatedAtMs - left.updatedAtMs;
    });
}

function dedupeMessages(list) {
  const map = new Map();
  list.forEach((message) => {
    map.set(message.id, message);
  });
  return [...map.values()].sort((left, right) => left.tsMs - right.tsMs);
}

function normalizeThread(raw) {
  return {
    id: raw.id,
    title: raw.title,
    workspace: raw.workspace,
    updatedAtMs: raw.updatedAtMs,
    unread: raw.unread,
    pinned: raw.pinned,
    archived: raw.archived,
    codexThreadId: raw.codexThreadId ?? null,
  };
}

function normalizeMessage(raw) {
  return {
    id: raw.id,
    threadId: raw.threadId,
    role: raw.role,
    text: raw.text,
    tsMs: raw.tsMs,
  };
}

function normalizeSkill(raw) {
  return {
    name: raw?.name ?? "unknown-skill",
    description: raw?.description ?? "",
    scope: raw?.scope ?? "user",
    path: raw?.path ?? "",
  };
}

function normalizeAutomation(raw) {
  return {
    id: raw?.id ?? "",
    name: raw?.name ?? "未命名自动化",
    status: raw?.status ?? "ACTIVE",
    rrule: raw?.rrule ?? "",
    prompt: raw?.prompt ?? "",
    cwds: Array.isArray(raw?.cwds) ? raw.cwds : [],
    path: raw?.path ?? "",
  };
}

export default function App() {
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [messagesByThread, setMessagesByThread] = useState({});
  const [activeView, setActiveView] = useState("chat");
  const [skills, setSkills] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [sidebarFilter, setSidebarFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [booting, setBooting] = useState(true);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  const threadViewportRef = useRef(null);
  const messageViewportRef = useRef(null);

  const tauri = window.__TAURI__;
  const appWindow = useMemo(() => tauri?.window?.getCurrentWindow?.(), [tauri]);
  const canControlWindow = Boolean(appWindow);

  useEffect(() => {
    let disposed = false;
    const syncWindowState = async () => {
      if (!appWindow?.isMaximized) return;
      try {
        const maximized = await appWindow.isMaximized();
        if (!disposed) {
          setIsWindowMaximized(Boolean(maximized));
        }
      } catch (error) {
        console.warn("sync maximize state failed:", error);
      }
    };
    void syncWindowState();
    return () => {
      disposed = true;
    };
  }, [appWindow]);

  const minimizeWindow = async () => {
    if (!appWindow?.minimize) return;
    try {
      await appWindow.minimize();
    } catch (error) {
      console.error("window minimize failed:", error);
    }
  };

  const toggleWindowMaximize = async () => {
    if (!appWindow) return;
    try {
      if (appWindow.toggleMaximize) {
        await appWindow.toggleMaximize();
      } else if (appWindow.isMaximized) {
        const maximized = await appWindow.isMaximized();
        if (maximized && appWindow.unmaximize) {
          await appWindow.unmaximize();
        } else if (!maximized && appWindow.maximize) {
          await appWindow.maximize();
        }
      }
      if (appWindow.isMaximized) {
        const next = await appWindow.isMaximized();
        setIsWindowMaximized(Boolean(next));
      }
    } catch (error) {
      console.error("window maximize toggle failed:", error);
    }
  };

  const closeWindow = async () => {
    if (!appWindow?.close) return;
    try {
      await appWindow.close();
    } catch (error) {
      console.error("window close failed:", error);
    }
  };

  const loadBootstrap = useCallback(async () => {
    if (!tauri?.core?.invoke) return;
    setBooting(true);
    try {
      const bootstrap = await tauri.core.invoke("app_get_bootstrap");
      const normalizedThreads = (bootstrap?.threads ?? []).map(normalizeThread);
      const selected = bootstrap?.selectedThreadId ?? normalizedThreads[0]?.id ?? null;
      const selectedMessages = (bootstrap?.messages ?? []).map(normalizeMessage);

      setThreads(normalizedThreads);
      setSelectedThreadId(selected);
      setMessagesByThread((prev) => ({
        ...prev,
        ...(selected ? { [selected]: dedupeMessages(selectedMessages) } : {}),
      }));
    } catch (error) {
      console.error("bootstrap failed:", error);
    } finally {
      setBooting(false);
    }
  }, [tauri]);

  const loadSkills = useCallback(async () => {
    if (!tauri?.core?.invoke) return;
    setPanelLoading(true);
    setPanelError("");
    try {
      const list = await tauri.core.invoke("app_list_skills");
      setSkills((list ?? []).map(normalizeSkill));
    } catch (error) {
      console.error("load skills failed:", error);
      setPanelError(String(error));
    } finally {
      setPanelLoading(false);
    }
  }, [tauri]);

  const loadAutomations = useCallback(async () => {
    if (!tauri?.core?.invoke) return;
    setPanelLoading(true);
    setPanelError("");
    try {
      const list = await tauri.core.invoke("app_list_automations");
      setAutomations((list ?? []).map(normalizeAutomation));
    } catch (error) {
      console.error("load automations failed:", error);
      setPanelError(String(error));
    } finally {
      setPanelLoading(false);
    }
  }, [tauri]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const handleEvents = useCallback((events) => {
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    setThreads((prevThreads) => {
      let nextThreads = [...prevThreads];
      events.forEach((event) => {
        if (event.kind !== "thread-upsert" || !event.payload?.id) {
          return;
        }
        const payload = normalizeThread(event.payload);
        const index = nextThreads.findIndex((item) => item.id === payload.id);
        if (index >= 0) {
          nextThreads[index] = payload;
        } else {
          nextThreads.push(payload);
        }
      });
      return nextThreads;
    });

    setMessagesByThread((prev) => {
      let changed = false;
      const next = { ...prev };
      events.forEach((event) => {
        if (event.kind !== "message-upsert" || !event.payload?.threadId) {
          return;
        }
        const payload = normalizeMessage(event.payload);
        const bucket = next[payload.threadId] ? [...next[payload.threadId]] : [];
        bucket.push(payload);
        next[payload.threadId] = dedupeMessages(bucket);
        changed = true;
      });
      return changed ? next : prev;
    });
  }, []);

  useAppSync({
    onEvents: handleEvents,
  });

  const filteredThreads = useMemo(() => {
    const keyword = sidebarFilter.trim().toLowerCase();
    const visible = sortThreads(threads, showArchived);
    if (!keyword) {
      return visible;
    }
    return visible.filter((thread) => {
      return (
        thread.title.toLowerCase().includes(keyword) ||
        thread.workspace.toLowerCase().includes(keyword)
      );
    });
  }, [threads, showArchived, sidebarFilter]);

  const selectedMessages = useMemo(() => {
    if (!selectedThreadId) return [];
    return messagesByThread[selectedThreadId] ?? [];
  }, [messagesByThread, selectedThreadId]);

  const threadVirtualizer = useVirtualizer({
    count: filteredThreads.length,
    getScrollElement: () => threadViewportRef.current,
    estimateSize: () => 66,
    overscan: 16,
  });

  const messageVirtualizer = useVirtualizer({
    count: selectedMessages.length,
    getScrollElement: () => messageViewportRef.current,
    estimateSize: () => 94,
    overscan: 20,
  });

  const switchView = async (view) => {
    setActiveView(view);
    if (view === "skills") {
      await loadSkills();
    } else if (view === "automations") {
      await loadAutomations();
    }
  };

  const openThread = async (threadId) => {
    if (!threadId || !tauri?.core?.invoke) return;
    setActiveView("chat");
    setSelectedThreadId(threadId);
    try {
      await tauri.core.invoke("app_select_thread", { threadId });
      if (!messagesByThread[threadId]) {
        const list = await tauri.core.invoke("app_get_messages", { threadId });
        setMessagesByThread((prev) => ({
          ...prev,
          [threadId]: dedupeMessages((list ?? []).map(normalizeMessage)),
        }));
      }
    } catch (error) {
      console.error("open thread failed:", error);
    }
  };

  const createThread = async () => {
    if (!tauri?.core?.invoke) return;
    try {
      const created = await tauri.core.invoke("app_create_thread", {
        title: "新线程",
        workspace: "CodexDesktop-Rebuild",
      });
      const normalized = normalizeThread(created);
      setThreads((prev) => [...prev, normalized]);
      setMessagesByThread((prev) => ({
        ...prev,
        [normalized.id]: [],
      }));
      await openThread(normalized.id);
    } catch (error) {
      console.error("create thread failed:", error);
    }
  };

  const renameThread = async (threadId) => {
    if (!tauri?.core?.invoke) return;
    const thread = threads.find((item) => item.id === threadId);
    const nextTitle = window.prompt("重命名线程", thread?.title ?? "");
    if (!nextTitle || !nextTitle.trim()) return;
    try {
      const updated = await tauri.core.invoke("app_rename_thread", {
        threadId,
        title: nextTitle.trim(),
      });
      const normalized = normalizeThread(updated);
      setThreads((prev) =>
        prev.map((item) => (item.id === normalized.id ? normalized : item)),
      );
    } catch (error) {
      console.error("rename thread failed:", error);
    }
  };

  const togglePin = async (threadId) => {
    if (!tauri?.core?.invoke) return;
    try {
      const updated = await tauri.core.invoke("app_toggle_pin_thread", { threadId });
      const normalized = normalizeThread(updated);
      setThreads((prev) =>
        prev.map((item) => (item.id === normalized.id ? normalized : item)),
      );
    } catch (error) {
      console.error("pin thread failed:", error);
    }
  };

  const toggleArchive = async (threadId, archived) => {
    if (!tauri?.core?.invoke) return;
    try {
      const updated = await tauri.core.invoke("app_set_thread_archived", {
        threadId,
        archived,
      });
      const normalized = normalizeThread(updated);
      setThreads((prev) =>
        prev.map((item) => (item.id === normalized.id ? normalized : item)),
      );
      if (archived && selectedThreadId === threadId) {
        const nextVisible = sortThreads(
          threads.map((item) => (item.id === normalized.id ? normalized : item)),
          false,
        )[0];
        if (nextVisible) {
          await openThread(nextVisible.id);
        }
      }
    } catch (error) {
      console.error("archive thread failed:", error);
    }
  };

  const sendMessage = async () => {
    if (!selectedThreadId || !tauri?.core?.invoke) return;
    const text = composer.trim();
    if (!text || sending) return;
    setComposer("");
    setSending(true);

    try {
      const result = await tauri.core.invoke("app_send_message", {
        threadId: selectedThreadId,
        text,
      });
      const user = normalizeMessage(result.user);
      const assistant = normalizeMessage(result.assistant);

      setMessagesByThread((prev) => {
        const bucket = prev[selectedThreadId] ? [...prev[selectedThreadId]] : [];
        bucket.push(user, assistant);
        return {
          ...prev,
          [selectedThreadId]: dedupeMessages(bucket),
        };
      });
    } catch (error) {
      console.error("send message failed:", error);
      const fallback = {
        id: `assistant-error-${Date.now()}`,
        threadId: selectedThreadId,
        role: "assistant",
        text: `发送失败：${String(error)}`,
        tsMs: Date.now(),
      };
      setMessagesByThread((prev) => {
        const bucket = prev[selectedThreadId] ? [...prev[selectedThreadId]] : [];
        bucket.push(fallback);
        return {
          ...prev,
          [selectedThreadId]: dedupeMessages(bucket),
        };
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-codex-bg text-codex-text">
      <div className="flex h-full w-full border border-codex-border bg-codex-panel">
            <aside className="flex w-[320px] shrink-0 flex-col border-r border-codex-border bg-codex-panel2">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2 text-zinc-300">
                  <IconLogo className="h-4 w-4 text-zinc-400" />
                  <span className="text-sm font-medium">Codex</span>
                </div>
                <button
                  onClick={createThread}
                  className="rounded-md border border-codex-border px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800/70"
                >
                  新建
                </button>
              </div>

              <div className="px-3 pb-2">
                <button
                  onClick={createThread}
                  className={`mb-2 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                    activeView === "chat"
                      ? "border-codex-accent/60 bg-zinc-800/70"
                      : "border-codex-border hover:bg-zinc-800/70"
                  }`}
                >
                  <IconThread />
                  新线程
                </button>
                <button
                  onClick={() => void switchView("automations")}
                  className={`mb-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 ${
                    activeView === "automations" ? "bg-zinc-800/70" : "hover:bg-zinc-800/70"
                  }`}
                >
                  <IconAutomation />
                  自动化
                </button>
                <button
                  onClick={() => void switchView("skills")}
                  className={`mb-3 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 ${
                    activeView === "skills" ? "bg-zinc-800/70" : "hover:bg-zinc-800/70"
                  }`}
                >
                  <IconSkill />
                  技能
                </button>
                <div className="mb-2 flex items-center gap-2 rounded-md border border-codex-border bg-zinc-900/60 px-2 py-1.5">
                  <IconSearch className="h-4 w-4 text-codex-muted" />
                  <input
                    value={sidebarFilter}
                    onChange={(event) => setSidebarFilter(event.target.value)}
                    className="w-full bg-transparent text-sm outline-none placeholder:text-codex-muted"
                    placeholder="筛选线程"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-codex-muted">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                  />
                  显示已归档线程
                </label>
              </div>

              <div className="px-3 pb-1 text-xs text-codex-muted">线程</div>
              <div ref={threadViewportRef} className="scrollbar-thin flex-1 overflow-auto px-2">
                <div className="relative w-full" style={{ height: `${threadVirtualizer.getTotalSize()}px` }}>
                  {threadVirtualizer.getVirtualItems().map((item) => {
                    const thread = filteredThreads[item.index];
                    const active = thread.id === selectedThreadId;
                    return (
                      <div
                        key={thread.id}
                        className={`absolute left-0 top-0 w-full rounded-lg border ${
                          active
                            ? "border-codex-accent/60 bg-zinc-800/80"
                            : "border-transparent hover:bg-zinc-800/50"
                        } px-2 py-2`}
                        style={{
                          height: `${item.size}px`,
                          transform: `translateY(${item.start}px)`,
                        }}
                      >
                        <button onClick={() => openThread(thread.id)} className="w-full text-left">
                          <div className="line-clamp-1 text-sm font-medium">{thread.title}</div>
                          <div className="mt-1 flex items-center justify-between text-xs text-codex-muted">
                            <span className="line-clamp-1">{thread.workspace}</span>
                            <span>{formatAgo(thread.updatedAtMs)}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1">
                            {thread.pinned && (
                              <span className="rounded-full bg-codex-accent/20 px-1.5 py-0.5 text-[10px] text-blue-200">
                                置顶
                              </span>
                            )}
                            {thread.unread > 0 && (
                              <span className="rounded-full bg-codex-accent/20 px-1.5 py-0.5 text-[10px] text-blue-200">
                                {thread.unread}
                              </span>
                            )}
                            {thread.archived && (
                              <span className="rounded-full bg-zinc-700/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
                                已归档
                              </span>
                            )}
                          </div>
                        </button>
                        <div className="mt-1 flex gap-1 text-zinc-400">
                          <button onClick={() => renameThread(thread.id)} className="rounded p-1 hover:bg-zinc-700">
                            <IconEdit className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => togglePin(thread.id)} className="rounded p-1 hover:bg-zinc-700">
                            <IconPin className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => toggleArchive(thread.id, !thread.archived)}
                            className="rounded p-1 hover:bg-zinc-700"
                          >
                            <IconArchive className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-codex-border p-3">
                <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60">
                  <IconSettings />
                  设置
                </button>
              </div>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-11 items-center border-b border-codex-border pl-3 pr-2">
                <div className="flex min-w-0 items-center gap-2">
                  <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
                    <IconMenu />
                  </button>
                  <h1 className="truncate text-sm font-semibold">
                    {activeView === "chat"
                      ? threads.find((thread) => thread.id === selectedThreadId)?.title ?? "Codex 会话"
                      : activeView === "skills"
                        ? "技能"
                        : "自动化"}
                  </h1>
                </div>

                <div data-tauri-drag-region className="mx-3 h-full flex-1" />

                {canControlWindow ? (
                  <div className="flex items-center gap-1 text-zinc-400">
                    <button
                      onClick={() => void minimizeWindow()}
                      className="rounded p-1 hover:bg-zinc-800"
                      aria-label="最小化窗口"
                    >
                      <IconMinimize />
                    </button>
                    <button
                      onClick={() => void toggleWindowMaximize()}
                      className={`rounded p-1 hover:bg-zinc-800 ${isWindowMaximized ? "text-zinc-200" : ""}`}
                      aria-label="切换最大化"
                    >
                      <IconMaximize />
                    </button>
                    <button
                      onClick={() => void closeWindow()}
                      className="rounded p-1 hover:bg-red-500/20 hover:text-red-200"
                      aria-label="关闭窗口"
                    >
                      <IconClose />
                    </button>
                  </div>
                ) : null}
              </header>

              <section
                ref={activeView === "chat" ? messageViewportRef : null}
                className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-[#0f1216] px-6 py-5"
              >
                {activeView === "chat" ? (
                  booting ? (
                    <div className="mx-auto max-w-5xl rounded-xl border border-codex-border bg-zinc-900/50 p-4 text-sm text-codex-muted">
                      正在加载会话...
                    </div>
                  ) : (
                    <div className="mx-auto w-full max-w-5xl">
                      <div
                        className="relative w-full"
                        style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
                      >
                        {messageVirtualizer.getVirtualItems().map((item) => {
                          const message = selectedMessages[item.index];
                          const isAssistant = message.role === "assistant";
                          return (
                            <div
                              key={message.id}
                              className="absolute left-0 top-0 w-full"
                              style={{ transform: `translateY(${item.start}px)` }}
                            >
                              <div className={`mb-3 flex ${isAssistant ? "justify-start" : "justify-end"}`}>
                                <article
                                  className={`max-w-[86%] rounded-xl border px-4 py-3 text-sm leading-6 ${
                                    isAssistant
                                      ? "border-codex-border bg-zinc-900/70 text-zinc-200"
                                      : "border-blue-500/30 bg-blue-500/10 text-zinc-100"
                                  }`}
                                >
                                  <div className="mb-1 flex items-center gap-2 text-xs text-codex-muted">
                                    <span>{isAssistant ? "Codex" : "你"}</span>
                                    <span>·</span>
                                    <span>{formatAgo(message.tsMs)}</span>
                                  </div>
                                  <p className="whitespace-pre-wrap">{message.text}</p>
                                </article>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )
                ) : (
                  <div className="mx-auto w-full max-w-5xl space-y-3">
                    {panelLoading ? (
                      <div className="rounded-xl border border-codex-border bg-zinc-900/50 p-4 text-sm text-codex-muted">
                        正在加载 {activeView === "skills" ? "技能" : "自动化"}...
                      </div>
                    ) : panelError ? (
                      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                        加载失败：{panelError}
                      </div>
                    ) : activeView === "skills" ? (
                      skills.length === 0 ? (
                        <div className="rounded-xl border border-codex-border bg-zinc-900/50 p-4 text-sm text-codex-muted">
                          当前未发现技能。
                        </div>
                      ) : (
                        skills.map((skill) => (
                          <article
                            key={skill.path}
                            className="rounded-xl border border-codex-border bg-zinc-900/60 p-4"
                          >
                            <div className="mb-1 flex items-center justify-between gap-3">
                              <h3 className="text-sm font-semibold text-zinc-100">{skill.name}</h3>
                              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
                                {skill.scope}
                              </span>
                            </div>
                            <p className="mb-2 text-sm text-zinc-300">{skill.description}</p>
                            <p className="text-xs text-codex-muted">{skill.path}</p>
                          </article>
                        ))
                      )
                    ) : automations.length === 0 ? (
                      <div className="rounded-xl border border-codex-border bg-zinc-900/50 p-4 text-sm text-codex-muted">
                        当前没有自动化任务。
                      </div>
                    ) : (
                      automations.map((automation) => (
                        <article
                          key={automation.id || automation.path}
                          className="rounded-xl border border-codex-border bg-zinc-900/60 p-4"
                        >
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <h3 className="text-sm font-semibold text-zinc-100">{automation.name}</h3>
                            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] text-blue-200">
                              {automation.status}
                            </span>
                          </div>
                          <p className="mb-1 text-xs text-codex-muted">ID: {automation.id}</p>
                          {automation.rrule ? (
                            <p className="mb-1 text-xs text-codex-muted">调度: {automation.rrule}</p>
                          ) : null}
                          {automation.cwds.length > 0 ? (
                            <p className="mb-1 text-xs text-codex-muted">工作区: {automation.cwds.join(", ")}</p>
                          ) : null}
                          <p className="mb-2 text-sm text-zinc-300 whitespace-pre-wrap">{automation.prompt}</p>
                          <p className="text-xs text-codex-muted">{automation.path}</p>
                        </article>
                      ))
                    )}
                  </div>
                )}
              </section>

              {activeView === "chat" ? (
                <footer className="border-t border-codex-border bg-[#111419] px-6 py-4">
                  <div className="mx-auto flex w-full max-w-5xl items-end gap-3">
                    <button className="rounded-md border border-codex-border px-3 py-2 text-zinc-300 hover:bg-zinc-800">
                      <IconMagic />
                    </button>
                    <textarea
                      value={composer}
                      onChange={(event) => setComposer(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void sendMessage();
                        }
                      }}
                      disabled={sending}
                      placeholder={sending ? "Codex 正在处理..." : "输入消息并发送"}
                      className="min-h-[64px] flex-1 resize-none rounded-xl border border-codex-border bg-zinc-900/70 px-4 py-3 text-sm outline-none ring-codex-accent/30 placeholder:text-codex-muted focus:ring-2 disabled:opacity-60"
                    />
                    <button
                      onClick={sendMessage}
                      disabled={sending}
                      className="rounded-full bg-codex-accent p-3 text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <IconSend className="h-5 w-5" />
                    </button>
                  </div>
                </footer>
              ) : null}
            </main>
      </div>
    </div>
  );
}
