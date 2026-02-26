import { useState, useCallback, useRef } from "react";
import { useMqttSubscription } from "./useMqtt";
import type { TerminalStreamChunk, TerminalSnapshot } from "@mesh-six/core";

// Inline constants to avoid importing server-only modules from @mesh-six/core
// (mem0ai, pg, etc. are not browser-compatible and would break the Vite build)
const TERMINAL_STREAM_TOPIC_PREFIX = "terminal/stream";
const TERMINAL_SNAPSHOT_TOPIC_PREFIX = "terminal/snapshot";

export function useTerminalStream(sessionId: string | null) {
  const [chunks, setChunks] = useState<TerminalStreamChunk[]>([]);
  const [latestSnapshot, setLatestSnapshot] = useState<TerminalSnapshot | null>(null);
  const onChunkRef = useRef<((chunk: TerminalStreamChunk) => void) | null>(null);

  // Subscribe to stream chunks
  useMqttSubscription(
    sessionId ? `${TERMINAL_STREAM_TOPIC_PREFIX}/${sessionId}` : "",
    useCallback((_: string, payload: string) => {
      try {
        const chunk = JSON.parse(payload) as TerminalStreamChunk;
        setChunks((prev) => [...prev, chunk]);
        onChunkRef.current?.(chunk);
      } catch { /* ignore malformed */ }
    }, [])
  );

  // Subscribe to snapshots
  useMqttSubscription(
    sessionId ? `${TERMINAL_SNAPSHOT_TOPIC_PREFIX}/${sessionId}` : "",
    useCallback((_: string, payload: string) => {
      try {
        const snapshot = JSON.parse(payload) as TerminalSnapshot;
        setLatestSnapshot(snapshot);
      } catch { /* ignore */ }
    }, [])
  );

  const setOnChunk = useCallback((fn: (chunk: TerminalStreamChunk) => void) => {
    onChunkRef.current = fn;
  }, []);

  const clearChunks = useCallback(() => setChunks([]), []);

  return { chunks, latestSnapshot, setOnChunk, clearChunks };
}
