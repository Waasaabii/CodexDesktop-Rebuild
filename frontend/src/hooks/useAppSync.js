import { useEffect, useRef } from "react";

const EVENT_CHANNEL = "codex_app:event";
const LAST_SEQ_KEY = "codex_tauri_last_seq";

function readSeq() {
  const raw = Number(window.sessionStorage.getItem(LAST_SEQ_KEY) || "0");
  return Number.isFinite(raw) ? raw : 0;
}

function writeSeq(seq) {
  window.sessionStorage.setItem(LAST_SEQ_KEY, String(seq));
}

export function useAppSync({ onEvents }) {
  const lastSeqRef = useRef(readSeq());
  const inFlightRef = useRef(false);

  useEffect(() => {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) {
      return () => {};
    }

    let timerId;
    let disposed = false;
    let unlisten;

    const emitEvents = (events) => {
      if (!Array.isArray(events) || events.length === 0) {
        return;
      }
      if (typeof onEvents === "function") {
        onEvents(events);
      }
    };

    const syncOnce = async () => {
      if (disposed || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      try {
        const batch = await tauri.core.invoke("app_sync_since", {
          lastSeq: lastSeqRef.current,
        });
        if (!batch) {
          return;
        }
        if (typeof batch.latestSeq === "number" && batch.latestSeq > lastSeqRef.current) {
          lastSeqRef.current = batch.latestSeq;
          writeSeq(batch.latestSeq);
        }
        emitEvents(batch.events);
      } catch (error) {
        console.warn("[sync] poll failed:", error);
      } finally {
        inFlightRef.current = false;
      }
    };

    const resetTimer = () => {
      if (timerId) {
        window.clearInterval(timerId);
      }
      const delay = document.visibilityState === "visible" ? 220 : 900;
      timerId = window.setInterval(() => {
        void syncOnce();
      }, delay);
    };

    resetTimer();
    void syncOnce();
    document.addEventListener("visibilitychange", resetTimer);

    void tauri.event?.listen?.(EVENT_CHANNEL, (event) => {
      if (!event?.payload) {
        return;
      }
      const payload = event.payload;
      if (typeof payload.seq === "number" && payload.seq > lastSeqRef.current) {
        lastSeqRef.current = payload.seq;
        writeSeq(payload.seq);
      }
      emitEvents([payload]);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      if (timerId) {
        window.clearInterval(timerId);
      }
      document.removeEventListener("visibilitychange", resetTimer);
      if (typeof unlisten === "function") {
        void unlisten();
      }
    };
  }, [onEvents]);
}

