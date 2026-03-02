import React, { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  IconAutomation,
  IconClose,
  IconLogo,
  IconMagic,
  IconMaximize,
  IconMenu,
  IconMinimize,
  IconSearch,
  IconSend,
  IconSettings,
  IconSkill,
  IconSquare,
  IconThread,
} from "./icons";
import { useBridgeSync } from "./hooks/useBridgeSync";

function createThreads(count) {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index + 1}`,
    title:
      index === 0
        ? "查看项目概况JINVALIDJSON need closing? oh"
        : `工作线程 #${index + 1} · 性能回放与同步`,
    workspace: index % 2 === 0 ? "CodexDesktop-Rebuild" : "renewNet",
    updatedAt: now - index * 120000,
    unread: index % 17 === 0 ? (index % 5) + 1 : 0,
    pinned: index % 29 === 0,
  }));
}

function createMessages(threadId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${threadId}-msg-${index + 1}`,
    role: index % 3 === 0 ? "assistant" : "user",
    text:
      index % 3 === 0
        ? "已完成增量同步，后台事件将持续推进；回到前台自动补齐并保持 UI 连续。"
        : "收到，继续优化滚动性能与事件一致性。",
    ts: Date.now() - (count - index) * 45000,
  }));
}

function formatAgo(ts) {
  const diffMin = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 60) return `${diffMin} 分`;
  const hours = Math.round(diffMin / 60);
  return `${hours} 小时`;
}

export default function App() {
  const [threads, setThreads] = useState(() => createThreads(2600));
  const [selectedThreadId, setSelectedThreadId] = useState("thread-1");
  const [messagesByThread, setMessagesByThread] = useState(() => ({
    "thread-1": createMessages("thread-1", 500),
  }));
  const [composer, setComposer] = useState("");
  const [sidebarFilter, setSidebarFilter] = useState("");

  const threadViewportRef = useRef(null);
  const messageViewportRef = useRef(null);

  const visibleThreads = useMemo(() => {
    if (!sidebarFilter.trim()) {
      return threads;
    }
    const keyword = sidebarFilter.trim().toLowerCase();
    return threads.filter((thread) => thread.title.toLowerCase().includes(keyword));
  }, [threads, sidebarFilter]);

  const selectedMessages = useMemo(() => {
    if (!messagesByThread[selectedThreadId]) {
      return createMessages(selectedThreadId, 220);
    }
    return messagesByThread[selectedThreadId];
  }, [messagesByThread, selectedThreadId]);

  const threadVirtualizer = useVirtualizer({
    count: visibleThreads.length,
    getScrollElement: () => threadViewportRef.current,
    estimateSize: () => 58,
    overscan: 14,
  });

  const messageVirtualizer = useVirtualizer({
    count: selectedMessages.length,
    getScrollElement: () => messageViewportRef.current,
    estimateSize: () => 88,
    overscan: 18,
  });

  const upsertIncomingMessage = useCallback(
    (payload, source = "sync") => {
      const text =
        typeof payload === "string"
          ? payload
          : payload?.text || payload?.content || JSON.stringify(payload ?? {});
      const threadId = payload?.threadId || selectedThreadId;
      const nextMessage = {
        id: `${threadId}-incoming-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "assistant",
        text: `${text}${source === "realtime" ? "" : " (补齐)"}`,
        ts: Date.now(),
      };

      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? createMessages(threadId, 120);
        return {
          ...prev,
          [threadId]: [...current, nextMessage],
        };
      });

      setThreads((prev) =>
        prev.map((thread) =>
          thread.id === threadId
            ? { ...thread, updatedAt: Date.now(), title: thread.title, unread: thread.id === selectedThreadId ? 0 : thread.unread + 1 }
            : thread,
        ),
      );
    },
    [selectedThreadId],
  );

  useBridgeSync({
    onBatch: (events) => {
      events.forEach((event) => {
        if (event.kind === "message-for-view") {
          upsertIncomingMessage(event.payload, "sync");
        }
      });
    },
    onRealtime: (payload) => upsertIncomingMessage(payload, "realtime"),
  });

  const sendMessage = () => {
    const text = composer.trim();
    if (!text) return;

    const ownMessage = {
      id: `${selectedThreadId}-own-${Date.now()}`,
      role: "user",
      text,
      ts: Date.now(),
    };

    setMessagesByThread((prev) => ({
      ...prev,
      [selectedThreadId]: [...(prev[selectedThreadId] ?? []), ownMessage],
    }));
    setComposer("");

    const tauri = window.__TAURI__;
    if (tauri?.core?.invoke) {
      void tauri.core.invoke("bridge_send_message", {
        message: {
          threadId: selectedThreadId,
          text,
        },
      });
    }
  };

  return (
    <div className="h-full w-full bg-codex-bg text-codex-text">
      <div className="h-full w-full p-2">
        <div className="h-full w-full rounded-xl border border-codex-border bg-codex-panel shadow-panel">
          <div className="flex h-full">
            <aside className="flex w-[300px] shrink-0 flex-col border-r border-codex-border bg-codex-panel2">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2 text-zinc-300">
                  <IconLogo className="h-4 w-4 text-zinc-400" />
                  <span className="text-sm font-medium">Codex</span>
                </div>
              </div>

              <div className="px-3 pb-2">
                <button className="mb-2 flex w-full items-center gap-2 rounded-md border border-codex-border px-3 py-2 text-sm hover:bg-zinc-800/70">
                  <IconThread />
                  新线程
                </button>
                <button className="mb-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70">
                  <IconAutomation />
                  自动化
                </button>
                <button className="mb-3 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70">
                  <IconSkill />
                  技能
                </button>
                <div className="flex items-center gap-2 rounded-md border border-codex-border bg-zinc-900/60 px-2 py-1.5">
                  <IconSearch className="h-4 w-4 text-codex-muted" />
                  <input
                    value={sidebarFilter}
                    onChange={(event) => setSidebarFilter(event.target.value)}
                    className="w-full bg-transparent text-sm outline-none placeholder:text-codex-muted"
                    placeholder="筛选线程"
                  />
                </div>
              </div>

              <div className="px-3 pb-1 text-xs text-codex-muted">线程</div>

              <div ref={threadViewportRef} className="scrollbar-thin flex-1 overflow-auto px-2">
                <div
                  className="relative w-full"
                  style={{ height: `${threadVirtualizer.getTotalSize()}px` }}
                >
                  {threadVirtualizer.getVirtualItems().map((virtualRow) => {
                    const thread = visibleThreads[virtualRow.index];
                    const active = thread?.id === selectedThreadId;
                    return (
                      <button
                        key={thread.id}
                        onClick={() => {
                          setSelectedThreadId(thread.id);
                          setThreads((prev) =>
                            prev.map((item) => (item.id === thread.id ? { ...item, unread: 0 } : item)),
                          );
                        }}
                        className={`absolute left-0 top-0 w-full rounded-lg px-2 py-2 text-left ${
                          active ? "bg-zinc-800/80" : "hover:bg-zinc-800/50"
                        }`}
                        style={{
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div className="line-clamp-1 text-sm font-medium">{thread.title}</div>
                        <div className="mt-1 flex items-center justify-between text-xs text-codex-muted">
                          <span className="line-clamp-1">{thread.workspace}</span>
                          <span className="ml-2 shrink-0">{formatAgo(thread.updatedAt)}</span>
                        </div>
                        {thread.unread > 0 && (
                          <span className="mt-1 inline-flex rounded-full bg-codex-accent/20 px-2 py-0.5 text-[11px] text-blue-300">
                            {thread.unread}
                          </span>
                        )}
                      </button>
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
              <header className="flex h-12 items-center justify-between border-b border-codex-border px-4">
                <div className="flex min-w-0 items-center gap-3">
                  <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
                    <IconMenu />
                  </button>
                  <h1 className="truncate text-sm font-semibold">
                    {threads.find((thread) => thread.id === selectedThreadId)?.title ?? "Codex 会话"}
                  </h1>
                </div>
                <div className="flex items-center gap-1 text-zinc-400">
                  <button className="rounded p-1 hover:bg-zinc-800">
                    <IconMinimize />
                  </button>
                  <button className="rounded p-1 hover:bg-zinc-800">
                    <IconMaximize />
                  </button>
                  <button className="rounded p-1 hover:bg-zinc-800">
                    <IconClose />
                  </button>
                </div>
              </header>

              <section
                ref={messageViewportRef}
                className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-[#0f1216] px-6 py-5"
              >
                <div className="mx-auto w-full max-w-5xl">
                  <div
                    className="relative w-full"
                    style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
                  >
                    {messageVirtualizer.getVirtualItems().map((virtualRow) => {
                      const message = selectedMessages[virtualRow.index];
                      const isAssistant = message.role === "assistant";
                      return (
                        <div
                          key={message.id}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
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
                                <span>{formatAgo(message.ts)}</span>
                              </div>
                              <p className="whitespace-pre-wrap">{message.text}</p>
                            </article>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>

              <footer className="border-t border-codex-border bg-[#111419] px-6 py-4">
                <div className="mx-auto flex w-full max-w-5xl items-end gap-3">
                  <button className="rounded-md border border-codex-border px-3 py-2 text-zinc-300 hover:bg-zinc-800">
                    <IconMagic />
                  </button>
                  <textarea
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    placeholder="要求后续变更"
                    className="min-h-[64px] flex-1 resize-none rounded-xl border border-codex-border bg-zinc-900/70 px-4 py-3 text-sm outline-none ring-codex-accent/30 placeholder:text-codex-muted focus:ring-2"
                  />
                  <button
                    onClick={sendMessage}
                    className="rounded-full bg-codex-accent p-3 text-white transition hover:brightness-110"
                  >
                    <IconSend className="h-5 w-5" />
                  </button>
                </div>
              </footer>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

