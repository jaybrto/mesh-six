import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface RecordingPlayerProps {
  recordingId: number;
  className?: string;
}

type AsciicastEvent = [number, string, string];

export function RecordingPlayer({ recordingId, className = "" }: RecordingPlayerProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#18181b",
        foreground: "#e4e4e7",
        cursor: "#a1a1aa",
      },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      for (const t of timeoutsRef.current) clearTimeout(t);
      term.dispose();
    };
  }, []);

  const play = async () => {
    const baseUrl = import.meta.env.VITE_IMPLEMENTER_URL || "";
    if (!baseUrl) return;

    // Get presigned URL for recording
    const urlRes = await fetch(`${baseUrl}/recordings/${recordingId}/url`);
    const { url } = await urlRes.json() as { url: string };

    // Fetch the asciicast file
    const castRes = await fetch(url);
    const text = await castRes.text();
    const lines = text.trim().split("\n");

    // First line is header (unused but required for valid asciicast format)
    if (lines[0]) JSON.parse(lines[0]);
    const events: AsciicastEvent[] = lines.slice(1).map((l) => JSON.parse(l) as AsciicastEvent);

    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    const totalDuration = lastEvent![0];
    setDuration(totalDuration);
    setPlaying(true);

    // Clear terminal
    xtermRef.current?.clear();

    // Schedule events
    for (const t of timeoutsRef.current) clearTimeout(t);
    timeoutsRef.current = [];

    for (const event of events) {
      const [time, type, data] = event;
      if (type !== "o") continue;

      const timeout = setTimeout(() => {
        xtermRef.current?.write(data);
        setProgress(time);
      }, time * 1000);

      timeoutsRef.current.push(timeout);
    }

    // Mark as done
    const doneTimeout = setTimeout(() => {
      setPlaying(false);
      setProgress(totalDuration);
    }, totalDuration * 1000);
    timeoutsRef.current.push(doneTimeout);
  };

  const stop = () => {
    for (const t of timeoutsRef.current) clearTimeout(t);
    timeoutsRef.current = [];
    setPlaying(false);
    setProgress(0);
    xtermRef.current?.clear();
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center gap-3">
        <button
          onClick={playing ? stop : play}
          className="rounded-md bg-mesh-600 px-3 py-1 text-sm font-medium text-white hover:bg-mesh-500"
        >
          {playing ? "Stop" : "Play"}
        </button>
        {duration > 0 && (
          <span className="text-xs text-zinc-400">
            {progress.toFixed(1)}s / {duration.toFixed(1)}s
          </span>
        )}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        <div ref={termRef} className="h-[400px] w-full" />
      </div>
    </div>
  );
}
