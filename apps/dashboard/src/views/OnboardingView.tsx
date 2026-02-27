import { useState, useEffect, useCallback, Fragment } from "react";
import { useMqttSubscription } from "../hooks/useMqtt";
import { StatusBadge } from "../components/StatusBadge";
import { RelativeTime } from "../components/RelativeTime";
import { ConnectionIndicator } from "../components/ConnectionIndicator";

interface OnboardingRun {
  id: string;
  repoOwner: string;
  repoName: string;
  status: "pending" | "running" | "waiting_auth" | "completed" | "failed";
  currentPhase: string | null;
  currentActivity: string | null;
  completedActivities: string[];
  errorMessage: string | null;
  oauthDeviceUrl: string | null;
  oauthUserCode: string | null;
  createdAt: string;
  updatedAt: string;
}

const ONBOARDING_URL = import.meta.env.VITE_ONBOARDING_URL || "";

const PHASES = ["initializing", "dev-environment", "auth-settings"];

function getPhaseStatus(
  run: OnboardingRun,
  phaseName: string,
): "completed" | "running" | "failed" | "pending" {
  const phaseIndex = PHASES.indexOf(phaseName);
  const currentIndex = run.currentPhase ? PHASES.indexOf(run.currentPhase) : -1;

  if (run.status === "completed") return "completed";
  if (run.status === "failed" && phaseName === run.currentPhase) return "failed";
  if (phaseName === run.currentPhase) return "running";
  if (phaseIndex < currentIndex) return "completed";
  return "pending";
}

const runStatusMap: Record<string, string> = {
  pending: "pending",
  running: "dispatched",
  waiting_auth: "configuring",
  completed: "completed",
  failed: "failed",
};

function mapRunStatus(status: string): string {
  return runStatusMap[status] ?? "pending";
}

const phaseStatusMap: Record<string, string> = {
  initializing: "dispatched",
  "dev-environment": "degraded",
  "auth-settings": "configuring",
  completed: "completed",
  failed: "failed",
};

function mapPhaseToStatus(phase: string | null): string {
  if (!phase) return "pending";
  return phaseStatusMap[phase] ?? "pending";
}

function formatDuration(createdAt: string, updatedAt?: string): string {
  const start = new Date(createdAt).getTime();
  const end = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const diffMs = end - start;

  if (isNaN(start)) return "-";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

type PhaseStatus = "completed" | "running" | "failed" | "pending";

function PhaseCheckmark({ status }: { status: PhaseStatus }) {
  if (status === "completed") {
    return (
      <svg className="h-5 w-5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
    );
  }
  if (status === "failed") {
    return (
      <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  return <div className="h-5 w-5 rounded-full border-2 border-zinc-600" />;
}

function ExpandedRow({ run }: { run: OnboardingRun }) {
  return (
    <tr>
      <td colSpan={5} className="bg-zinc-900/60 px-4 py-4">
        <div className="space-y-4">
          {/* Phase progress */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Workflow Progress
            </h4>
            <div className="flex items-center gap-6">
              {PHASES.map((phaseName, i) => {
                const status = getPhaseStatus(run, phaseName);
                return (
                  <div key={phaseName} className="flex items-center gap-2">
                    <PhaseCheckmark status={status} />
                    <span
                      className={`text-sm ${
                        status === "running"
                          ? "font-medium text-blue-400"
                          : status === "completed"
                            ? "text-zinc-300"
                            : status === "failed"
                              ? "text-red-400"
                              : "text-zinc-500"
                      }`}
                    >
                      {phaseName}
                    </span>
                    {i < PHASES.length - 1 && (
                      <svg className="ml-2 h-4 w-4 text-zinc-600" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M6 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Current activity */}
          {run.currentActivity && (
            <div className="text-xs text-zinc-400">
              Current activity: <span className="font-medium text-zinc-300">{run.currentActivity}</span>
            </div>
          )}

          {/* OAuth device flow info */}
          {run.status === "waiting_auth" && run.oauthDeviceUrl && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
              <h4 className="mb-2 text-sm font-semibold text-amber-300">
                OAuth Authorization Required
              </h4>
              <p className="mb-2 text-sm text-zinc-300">
                Visit the URL below and enter the code to authorize:
              </p>
              <div className="flex items-center gap-4">
                <a
                  href={run.oauthDeviceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-blue-400 underline hover:text-blue-300"
                >
                  {run.oauthDeviceUrl}
                </a>
                {run.oauthUserCode && (
                  <span className="rounded-md border border-amber-500/40 bg-amber-500/20 px-3 py-1 font-mono text-lg font-bold text-amber-200">
                    {run.oauthUserCode}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Error details */}
          {run.errorMessage && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <h4 className="mb-1 text-sm font-semibold text-red-300">Error</h4>
              <p className="font-mono text-xs text-red-400">{run.errorMessage}</p>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function OnboardingView() {
  const [runs, setRuns] = useState<Map<string, OnboardingRun>>(new Map());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState(false);

  // Fetch onboarding runs from REST API
  useEffect(() => {
    if (!ONBOARDING_URL) return;

    async function fetchRuns() {
      try {
        const response = await fetch(`${ONBOARDING_URL}/onboard`);
        if (!response.ok) {
          setFetchError(true);
          return;
        }
        const data = (await response.json()) as OnboardingRun[];
        setRuns((prev) => {
          const next = new Map(prev);
          for (const run of data) {
            next.set(run.id, run);
          }
          return next;
        });
        setFetchError(false);
      } catch {
        setFetchError(true);
      }
    }

    fetchRuns();
    const interval = setInterval(fetchRuns, 30_000);
    return () => clearInterval(interval);
  }, []);

  // MQTT real-time updates
  const handleMessage = useCallback((_topic: string, payload: string) => {
    try {
      const data = JSON.parse(payload) as OnboardingRun;
      if (data.id) {
        setRuns((prev) => {
          const next = new Map(prev);
          next.set(data.id, data);
          return next;
        });
      }
    } catch {
      // ignore malformed messages
    }
  }, []);

  useMqttSubscription("onboarding/#", handleMessage);

  const runList = Array.from(runs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Onboarding</h2>
        <div className="flex items-center gap-4">
          <button
            disabled
            className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 opacity-50 cursor-not-allowed"
            title="Start Onboarding (coming soon)"
          >
            Start Onboarding
          </button>
          <ConnectionIndicator />
        </div>
      </div>

      {!ONBOARDING_URL && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          VITE_ONBOARDING_URL is not configured. Set it to see onboarding runs.
        </div>
      )}

      {fetchError && ONBOARDING_URL && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Failed to fetch onboarding runs from the onboarding service.
        </div>
      )}

      {runList.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-12 text-center text-zinc-500">
          No onboarding runs found
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-800">
            <thead className="bg-zinc-900/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Project
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Phase
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Started
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Duration / Error
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-900/30">
              {runList.map((run) => (
                <Fragment key={run.id}>
                  <tr
                    onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}
                    className="cursor-pointer transition-colors hover:bg-zinc-900/60"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-200">
                      {run.repoOwner}/{run.repoName}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={mapPhaseToStatus(run.currentPhase)} />
                      <span className="ml-2 text-xs text-zinc-400">
                        {run.currentPhase ?? "-"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={mapRunStatus(run.status)} />
                    </td>
                    <td className="px-4 py-3 text-zinc-400">
                      <RelativeTime timestamp={run.createdAt} />
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">
                      {run.errorMessage ? (
                        <span className="text-red-400" title={run.errorMessage}>
                          {run.errorMessage.length > 50
                            ? `${run.errorMessage.slice(0, 50)}...`
                            : run.errorMessage}
                        </span>
                      ) : (
                        formatDuration(run.createdAt, run.updatedAt)
                      )}
                    </td>
                  </tr>
                  {expandedId === run.id && <ExpandedRow run={run} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
