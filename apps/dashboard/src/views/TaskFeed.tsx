import { useState, useCallback, useRef } from "react";
import { useMqttSubscription } from "../hooks/useMqtt";
import { StatusBadge } from "../components/StatusBadge";
import { RelativeTime } from "../components/RelativeTime";
import { ConnectionIndicator } from "../components/ConnectionIndicator";

interface TaskEvent {
  id: string;
  taskId: string;
  capability: string;
  agent?: string;
  status: string;
  timestamp: string;
  topic: string;
}

const MAX_EVENTS = 200;

export function TaskFeedView() {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const seqRef = useRef(0);

  const handleMessage = useCallback((topic: string, payload: string) => {
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      const taskId = (data.id ?? data.taskId ?? "unknown") as string;
      const capability = (data.capability ?? "unknown") as string;
      const agent = (data.agentId ?? data.dispatchedTo ?? undefined) as string | undefined;
      const status = (data.status ?? (data.success !== undefined ? (data.success ? "completed" : "failed") : "unknown")) as string;
      const timestamp = (data.createdAt ?? data.completedAt ?? new Date().toISOString()) as string;

      const event: TaskEvent = {
        id: `${taskId}-${seqRef.current++}`,
        taskId,
        capability,
        agent,
        status,
        timestamp,
        topic,
      };

      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    } catch {
      // ignore malformed messages
    }
  }, []);

  useMqttSubscription("agent/task/#", handleMessage);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Task Feed</h2>
        <div className="flex items-center gap-4">
          <span className="text-xs text-zinc-500">{events.length} events</span>
          <ConnectionIndicator />
        </div>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-12 text-center text-zinc-500">
          Waiting for task events...
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => (
            <div
              key={event.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <StatusBadge status={event.status} />
                  <span className="font-mono text-xs text-zinc-400">{event.taskId.slice(0, 8)}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                    {event.capability}
                  </span>
                  {event.agent && (
                    <span className="text-xs text-zinc-500">
                      &rarr; {event.agent}
                    </span>
                  )}
                </div>
                <RelativeTime timestamp={event.timestamp} className="text-xs text-zinc-500" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
