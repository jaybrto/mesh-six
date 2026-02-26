import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Snapshot {
  id: number;
  sessionId: string;
  ansiContent: string;
  eventType: string;
  capturedAt: string;
}

interface SnapshotTimelineProps {
  sessionId: string;
  className?: string;
}

const EVENT_LABELS: Record<string, string> = {
  session_start: "Session Start",
  session_blocked: "Blocked (Question)",
  answer_injected: "Answer Injected",
  session_completed: "Completed",
  session_failed: "Failed",
  checkpoint: "Checkpoint",
};

const EVENT_COLORS: Record<string, string> = {
  session_start: "text-blue-400",
  session_blocked: "text-amber-400",
  answer_injected: "text-green-400",
  session_completed: "text-emerald-400",
  session_failed: "text-red-400",
  checkpoint: "text-zinc-400",
};

function SnapshotPreview({ snapshot }: { snapshot: Snapshot }) {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: { background: "#18181b", foreground: "#e4e4e7" },
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      rows: 20,
      cols: 120,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    term.write(snapshot.ansiContent);

    return () => term.dispose();
  }, [snapshot.ansiContent]);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-1">
      <div ref={termRef} className="h-[300px] w-full overflow-hidden" />
    </div>
  );
}

export function SnapshotTimeline({ sessionId, className = "" }: SnapshotTimelineProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const baseUrl = import.meta.env.VITE_IMPLEMENTER_URL || "";
    if (!baseUrl) { setLoading(false); return; }

    fetch(`${baseUrl}/sessions/${sessionId}/snapshots`)
      .then((r) => r.json())
      .then((data: Snapshot[]) => {
        setSnapshots(data);
        if (data.length > 0) setSelectedId(data[0]!.id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  const selected = snapshots.find((s) => s.id === selectedId);

  if (loading) {
    return <div className="text-sm text-zinc-500">Loading snapshots...</div>;
  }

  if (snapshots.length === 0) {
    return <div className="text-sm text-zinc-500">No snapshots available for this session.</div>;
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Timeline */}
      <div className="flex flex-wrap gap-2">
        {snapshots.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedId === s.id
                ? "border-mesh-500 bg-mesh-600/20 text-mesh-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
            }`}
          >
            <span className={EVENT_COLORS[s.eventType] || "text-zinc-400"}>
              {EVENT_LABELS[s.eventType] || s.eventType}
            </span>
            <span className="ml-2 text-zinc-600">
              {new Date(s.capturedAt).toLocaleTimeString()}
            </span>
          </button>
        ))}
      </div>

      {/* Preview */}
      {selected && <SnapshotPreview snapshot={selected} />}
    </div>
  );
}
