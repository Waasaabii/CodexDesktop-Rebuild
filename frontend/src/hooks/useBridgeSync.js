import { useEffect, useRef } from "react";

const MESSAGE_CHANNEL = "codex_desktop:message-for-view";
const LAST_SEQ_KEY = "codex_react_tailwind_last_seq";

function getTauri() {
  return window.__TAURI__ ?? null;
}

function readLastSeq() {
  const value = Number(window.sessionStorage.getItem(LAST_SEQ_KEY) || "0");
  return Number.isFinite(value) ? value : 0;
}

function writeLastSeq(seq) {
  window.sessionStorage.setItem(LAST_SEQ_KEY, String(seq));
}

export function useBridgeSync({ onBatch, onRealtime }) {
  const lastSeqRef = useRef(readLastSeq());
  const inFlightRef = useRef(false);

  useEffect(() => {
    const tauri = getTauri();
    if (!tauri?.core?.invoke) {
      return () => {};
    }

    let intervalId;
    let unlisten;
    let disposed = false;

    const syncOnce = async () => {
      if (disposed || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      try {
        const batch = await tauri.core.invoke("bridge_sync_since", {
          lastSeq: lastSeqRef.current,
        });
        if (!batch) {
          return;
        }
        if (typeof batch.latestSeq === "number" && batch.latestSeq > lastSeqRef.current) {
          lastSeqRef.current = batch.latestSeq;
          writeLastSeq(batch.latestSeq);
        }
        if (Array.isArray(batch.events) && batch.events.length > 0 && typeof onBatch === "function") {
          onBatch(batch.events);
        }
      } catch (error) {
        console.warn("[react-sync] sync failed:", error);
      } finally {
        inFlightRef.current = false;
      }
    };

    const resetInterval = () => {
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      const delay = document.visibilityState === "visible" ? 220 : 900;
      intervalId = window.setInterval(() => {
        void syncOnce();
      }, delay);
    };

    resetInterval();
    void syncOnce();

    document.addEventListener("visibilitychange", resetInterval);

    void tauri.event
      ?.listen?.(MESSAGE_CHANNEL, (event) => {
        if (typeof onRealtime === "function") {
          onRealtime(event.payload);
        }
      })
      .then((dispose) => {
        unlisten = dispose;
      });

    return () => {
      disposed = true;
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      document.removeEventListener("visibilitychange", resetInterval);
      if (typeof unlisten === "function") {
        void unlisten();
      }
    };
  }, [onBatch, onRealtime]);
}

