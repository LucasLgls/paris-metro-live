import { useEffect, useState } from "react";
import type { TrainSnapshot } from "@paris-transit/contracts";
import { getTrains, parseTrainEvent, trainStreamUrl } from "../api/client.js";

export type ConnectionState = "live" | "polling" | "reconnecting" | "offline";

/**
 * Follows train snapshots over server-sent events. If the stream fails, it polls every 30 s and
 * retries the stream 30 s later.
 */
export function useTrainStream(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<TrainSnapshot>();
  const [connection, setConnection] = useState<ConnectionState>("reconnecting");

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const fetchCurrent = async () => {
      try {
        const current = await getTrains();
        if (!disposed) {
          setSnapshot(current);
          if (!source) setConnection("polling");
        }
      } catch {
        if (!disposed) setConnection(navigator.onLine ? "reconnecting" : "offline");
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      void fetchCurrent();
      pollTimer = setInterval(() => void fetchCurrent(), 30_000);
    };

    const connect = () => {
      if (disposed || typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      setConnection("reconnecting");
      source = new EventSource(trainStreamUrl);
      source.onopen = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (!disposed) setConnection("live");
      };
      const handleSnapshot = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        const next = parseTrainEvent(event.data);
        if (next && !disposed) setSnapshot(next);
      };
      source.onmessage = handleSnapshot;
      source.addEventListener("vehicles", handleSnapshot);
      source.onerror = () => {
        source?.close();
        source = undefined;
        if (!disposed) {
          setConnection(navigator.onLine ? "polling" : "offline");
          startPolling();
          reconnectTimer = setTimeout(connect, 30_000);
        }
      };
    };

    const handleNetworkChange = () => {
      setConnection(navigator.onLine ? "reconnecting" : "offline");
      if (navigator.onLine && !source) connect();
    };

    window.addEventListener("online", handleNetworkChange);
    window.addEventListener("offline", handleNetworkChange);
    void fetchCurrent().finally(connect);

    return () => {
      disposed = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleNetworkChange);
      window.removeEventListener("offline", handleNetworkChange);
    };
  }, [enabled]);

  return { snapshot, connection };
}
