import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTerminalStream } from "../hooks/useTerminalStream";

interface TerminalViewerProps {
  sessionId: string;
  className?: string;
}

export function TerminalViewer({ sessionId, className = "" }: TerminalViewerProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { setOnChunk } = useTerminalStream(sessionId);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#18181b", // zinc-900
        foreground: "#e4e4e7", // zinc-200
        cursor: "#a1a1aa",
      },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitRef.current = fitAddon;

    // Handle resize
    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Write incoming MQTT chunks to terminal
  const handleChunk = useCallback((chunk: { data: string }) => {
    xtermRef.current?.write(chunk.data);
  }, []);

  useEffect(() => {
    setOnChunk(handleChunk);
  }, [setOnChunk, handleChunk]);

  // Fetch initial snapshot for mid-stream join
  useEffect(() => {
    const baseUrl = import.meta.env.VITE_IMPLEMENTER_URL || "";
    if (!baseUrl || !sessionId) return;

    fetch(`${baseUrl}/sessions/${sessionId}/snapshots`)
      .then((r) => r.json())
      .then((snapshots: Array<{ ansiContent: string }>) => {
        const first = snapshots[0];
        if (first && xtermRef.current) {
          xtermRef.current.write(first.ansiContent);
        }
      })
      .catch(() => { /* implementer may not be reachable */ });
  }, [sessionId]);

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-1 ${className}`}>
      <div ref={termRef} className="h-[500px] w-full" />
    </div>
  );
}
