import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { TerminalViewer } from "../components/TerminalViewer";
import { RecordingPlayer } from "../components/RecordingPlayer";
import { SnapshotTimeline } from "../components/SnapshotTimeline";

type Tab = "live" | "snapshots" | "recordings";

interface Recording {
  id: number;
  sessionId: string;
  s3Key: string;
  durationMs: number;
  sizeBytes: number;
  format: string;
  uploadedAt: string;
}

export function SessionTerminalView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<number | null>(null);

  useEffect(() => {
    if (activeTab !== "recordings" || !sessionId) return;
    const baseUrl = import.meta.env.VITE_IMPLEMENTER_URL || "";
    if (!baseUrl) return;

    fetch(`${baseUrl}/sessions/${sessionId}/recordings`)
      .then((r) => r.json())
      .then((data: Recording[]) => {
        setRecordings(data);
        if (data.length > 0) setSelectedRecording(data[0]!.id);
      })
      .catch(() => {});
  }, [activeTab, sessionId]);

  if (!sessionId) {
    return <div className="text-sm text-zinc-500">No session ID provided.</div>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "live", label: "Live Terminal" },
    { key: "snapshots", label: "Snapshots" },
    { key: "recordings", label: "Recordings" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-200">
          Session: <span className="font-mono text-mesh-400">{sessionId.slice(0, 8)}...</span>
        </h2>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-800 pb-px">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`rounded-t-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === key
                ? "border-b-2 border-mesh-500 text-mesh-300"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "live" && <TerminalViewer sessionId={sessionId} />}

      {activeTab === "snapshots" && <SnapshotTimeline sessionId={sessionId} />}

      {activeTab === "recordings" && (
        <div className="space-y-4">
          {recordings.length === 0 ? (
            <div className="text-sm text-zinc-500">No recordings available.</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {recordings.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRecording(r.id)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selectedRecording === r.id
                        ? "border-mesh-500 bg-mesh-600/20 text-mesh-300"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    {new Date(r.uploadedAt).toLocaleString()} — {(r.sizeBytes / 1024).toFixed(1)}KB
                  </button>
                ))}
              </div>
              {selectedRecording && <RecordingPlayer recordingId={selectedRecording} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}
