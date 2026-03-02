const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";
const WORKER_FOR_VIEW_CHANNEL = (workerId) => `codex_desktop:worker:${workerId}:for-view`;

const FALLBACK_SENTRY = {
  codexAppSessionId: `tauri-${Date.now()}`,
  dsn: null,
  environment: "desktop",
  release: null,
};

let sentryInitOptions = FALLBACK_SENTRY;
let buildFlavor = "prod";
let latestSeq = 0;
let syncTimer = null;
let syncInFlight = false;

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

async function startIncrementalSyncLoop() {
  if (syncTimer) {
    return;
  }

  const tick = async () => {
    if (syncInFlight) {
      return;
    }
    syncInFlight = true;
    try {
      const batch = await invoke("bridge_sync_since", { lastSeq: latestSeq });
      if (batch?.events?.length) {
        latestSeq = batch.latestSeq || latestSeq;
      }
    } catch (error) {
      console.warn("[compat] incremental sync failed:", error);
    } finally {
      syncInFlight = false;
    }
  };

  await tick();
  syncTimer = setInterval(() => {
    void tick();
  }, 250);
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
    window.dispatchEvent(
      new MessageEvent("message", {
        data: event.payload,
      }),
    );
  });

  await startIncrementalSyncLoop();
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
    let unlisten;
    void resolveTauriApi()
      .listen(WORKER_FOR_VIEW_CHANNEL(workerId), (event) => {
        callback(event.payload);
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((error) => {
        console.warn("[compat] worker subscription failed:", error);
      });

    return () => {
      if (typeof unlisten === "function") {
        void unlisten();
      }
    };
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

