const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";
const WORKER_FOR_VIEW_CHANNEL = (workerId) => `codex_desktop:worker:${workerId}:for-view`;
const LAST_SEQ_STORAGE_KEY = "codex_desktop:last_seq";
const SYNC_VISIBLE_INTERVAL_MS = 200;
const SYNC_HIDDEN_INTERVAL_MS = 1000;

const FALLBACK_SENTRY = {
  codexAppSessionId: `tauri-${Date.now()}`,
  dsn: null,
  environment: "desktop",
  release: null,
};

let sentryInitOptions = FALLBACK_SENTRY;
let buildFlavor = "prod";
let latestSeq = Number(window.sessionStorage.getItem(LAST_SEQ_STORAGE_KEY) || "0");
let syncTimer = null;
let syncInFlight = false;
let flushScheduled = false;
const pendingViewMessages = [];
const workerSubscriptions = new Map();
const workerUnlistenMap = new Map();

function resolveTauriApi() {
  const globalApi = window.__TAURI__;
  if (!globalApi?.core?.invoke || !globalApi?.event?.listen) {
    throw new Error("Tauri global API unavailable. Ensure withGlobalTauri=true.");
  }
  return {
    invoke: globalApi.core.invoke,
    listen: globalApi.event.listen,
  };
}

async function invoke(command, payload = {}) {
  const { invoke: tauriInvoke } = resolveTauriApi();
  return tauriInvoke(command, payload);
}

function persistLatestSeq() {
  try {
    window.sessionStorage.setItem(LAST_SEQ_STORAGE_KEY, String(latestSeq));
  } catch {
    // ignore storage failures
  }
}

function scheduleFlush() {
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  const flush = () => {
    flushScheduled = false;
    while (pendingViewMessages.length > 0) {
      const message = pendingViewMessages.shift();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: message,
        }),
      );
    }
  };

  if (typeof window.requestAnimationFrame === "function" && document.visibilityState === "visible") {
    window.requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

function dispatchViewMessage(payload) {
  pendingViewMessages.push(payload);
  scheduleFlush();
}

function subscribeWorkerMap(workerId, callback) {
  let callbacks = workerSubscriptions.get(workerId);
  if (!callbacks) {
    callbacks = new Set();
    workerSubscriptions.set(workerId, callbacks);
  }
  callbacks.add(callback);
  return () => {
    const current = workerSubscriptions.get(workerId);
    if (!current) {
      return;
    }
    current.delete(callback);
    if (current.size === 0) {
      workerSubscriptions.delete(workerId);
      const unlisten = workerUnlistenMap.get(workerId);
      if (typeof unlisten === "function") {
        void unlisten();
      }
      workerUnlistenMap.delete(workerId);
    }
  };
}

function dispatchWorkerMessage(workerId, payload) {
  const callbacks = workerSubscriptions.get(workerId);
  if (!callbacks || callbacks.size === 0) {
    return;
  }
  callbacks.forEach((callback) => {
    try {
      callback(payload);
    } catch (error) {
      console.warn("[compat] worker callback failed:", error);
    }
  });
}

function applySyncedEvent(event) {
  if (!event?.kind) {
    return;
  }

  if (event.kind === "message-for-view") {
    dispatchViewMessage(event.payload);
    return;
  }

  if (event.kind.startsWith("worker:") && event.kind.endsWith(":for-view")) {
    const workerId = event.kind.slice("worker:".length, -":for-view".length);
    if (workerId.length > 0) {
      dispatchWorkerMessage(workerId, event.payload);
    }
  }
}

async function runSyncTick() {
  if (syncInFlight) {
    return;
  }

  syncInFlight = true;
  try {
    const batch = await invoke("bridge_sync_since", { lastSeq: latestSeq });
    if (!batch) {
      return;
    }
    if (typeof batch.latestSeq === "number" && batch.latestSeq > latestSeq) {
      latestSeq = batch.latestSeq;
      persistLatestSeq();
    }
    if (Array.isArray(batch.events)) {
      batch.events.forEach((event) => applySyncedEvent(event));
    }
  } catch (error) {
    console.warn("[compat] incremental sync failed:", error);
  } finally {
    syncInFlight = false;
  }
}

function restartSyncLoop() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  const interval = document.visibilityState === "visible"
    ? SYNC_VISIBLE_INTERVAL_MS
    : SYNC_HIDDEN_INTERVAL_MS;
  syncTimer = setInterval(() => {
    void runSyncTick();
  }, interval);
}

async function bootBridge() {
  try {
    const [sentry, flavor] = await Promise.all([
      invoke("bridge_get_sentry_init_options"),
      invoke("bridge_get_build_flavor"),
    ]);
    if (sentry && typeof sentry === "object") {
      sentryInitOptions = sentry;
    }
    if (typeof flavor === "string" && flavor.length > 0) {
      buildFlavor = flavor;
    }
  } catch (error) {
    console.warn("[compat] failed to fetch init values:", error);
  }

  const { listen } = resolveTauriApi();
  await listen(MESSAGE_FOR_VIEW_CHANNEL, (event) => {
    dispatchViewMessage(event.payload);
  });

  document.addEventListener("visibilitychange", () => {
    restartSyncLoop();
    void runSyncTick();
  });

  restartSyncLoop();
  await runSyncTick();
}

window.codexWindowType = "electron";

window.electronBridge = {
  windowType: "electron",
  sendMessageFromView: async (message) => {
    await invoke("bridge_send_message", { message });
  },
  getPathForFile: () => null,
  sendWorkerMessageFromView: async (workerId, message) => {
    await invoke("bridge_send_worker_message", { workerId, message });
  },
  subscribeToWorkerMessages: (workerId, callback) => {
    const unsubscribe = subscribeWorkerMap(workerId, callback);
    if (!workerUnlistenMap.has(workerId)) {
      void resolveTauriApi()
        .listen(WORKER_FOR_VIEW_CHANNEL(workerId), (event) => {
          dispatchWorkerMessage(workerId, event.payload);
        })
        .then((dispose) => {
          workerUnlistenMap.set(workerId, dispose);
        })
        .catch((error) => {
          console.warn("[compat] worker subscription failed:", error);
        });
    }
    return unsubscribe;
  },
  showContextMenu: async (menu) => invoke("bridge_show_context_menu", { menu }),
  triggerSentryTestError: async () => {
    await invoke("bridge_trigger_sentry_test_error");
  },
  getSentryInitOptions: () => sentryInitOptions,
  getAppSessionId: () => sentryInitOptions?.codexAppSessionId ?? null,
  getBuildFlavor: () => buildFlavor,
};

void bootBridge();
