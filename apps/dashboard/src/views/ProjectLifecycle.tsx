import { useState, useCallback } from "react";
import { useMqttSubscription } from "../hooks/useMqtt";
import { ConnectionIndicator } from "../components/ConnectionIndicator";

const STATES = [
  "CREATE",
  "PLANNING",
  "REVIEW",
  "IN_PROGRESS",
  "QA",
  "DEPLOY",
  "VALIDATE",
  "ACCEPTED",
] as const;

type ProjectState = (typeof STATES)[number];

interface Project {
  id: string;
  name: string;
  currentState: ProjectState;
  history: { state: ProjectState; timestamp: string }[];
}

export function ProjectLifecycleView() {
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleMessage = useCallback((_topic: string, payload: string) => {
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      const id = (data.projectId ?? data.id ?? "unknown") as string;
      const state = (data.state ?? data.status ?? "CREATE") as ProjectState;
      const name = (data.name ?? data.projectName ?? id) as string;
      const timestamp = (data.timestamp ?? new Date().toISOString()) as string;

      setProjects((prev) => {
        const next = new Map(prev);
        const existing = next.get(id);
        if (existing) {
          existing.currentState = state;
          existing.history.push({ state, timestamp });
        } else {
          next.set(id, {
            id,
            name,
            currentState: state,
            history: [{ state, timestamp }],
          });
        }
        return next;
      });
    } catch {
      // ignore malformed messages
    }
  }, []);

  useMqttSubscription("agent/project/#", handleMessage);

  const projectList = Array.from(projects.values());
  const selected = selectedId ? projects.get(selectedId) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Project Lifecycle</h2>
        <ConnectionIndicator />
      </div>

      {/* State Machine Visualization */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {STATES.map((state, i) => {
            const isCurrent = selected?.currentState === state;
            const isPast = selected
              ? selected.history.some((h) => h.state === state) && !isCurrent
              : false;
            return (
              <div key={state} className="flex items-center gap-2">
                <div
                  className={`rounded-lg border px-4 py-2 text-xs font-semibold transition-all ${
                    isCurrent
                      ? "border-mesh-500 bg-mesh-600/30 text-mesh-300 shadow-lg shadow-mesh-500/20"
                      : isPast
                        ? "border-zinc-700 bg-zinc-800 text-zinc-300"
                        : "border-zinc-800 bg-zinc-900 text-zinc-500"
                  }`}
                >
                  {state}
                </div>
                {i < STATES.length - 1 && (
                  <svg className="h-4 w-4 text-zinc-600" viewBox="0 0 16 16" fill="none">
                    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
        {!selected && projectList.length > 0 && (
          <p className="mt-4 text-center text-xs text-zinc-500">
            Select a project below to see its state
          </p>
        )}
        {projectList.length === 0 && (
          <p className="mt-4 text-center text-xs text-zinc-500">
            Waiting for project events...
          </p>
        )}
      </div>

      {/* Project List */}
      {projectList.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projectList.map((project) => (
            <button
              key={project.id}
              onClick={() => setSelectedId(project.id === selectedId ? null : project.id)}
              className={`rounded-lg border p-4 text-left transition-all ${
                project.id === selectedId
                  ? "border-mesh-500 bg-mesh-600/10"
                  : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
              }`}
            >
              <div className="font-medium text-zinc-200">{project.name}</div>
              <div className="mt-1 text-xs text-zinc-400">
                State: <span className="font-semibold text-mesh-400">{project.currentState}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {project.history.length} transition{project.history.length !== 1 ? "s" : ""}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Selected Project History */}
      {selected && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-300">
            History: {selected.name}
          </h3>
          <div className="space-y-2">
            {selected.history.map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-zinc-500">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={`rounded px-2 py-0.5 font-semibold ${
                    entry.state === selected.currentState
                      ? "bg-mesh-600/20 text-mesh-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {entry.state}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
