import { useState, useCallback } from "react";
import type { AgentRegistration } from "@mesh-six/core";
import { useMqttSubscription } from "../hooks/useMqtt";
import { StatusBadge } from "../components/StatusBadge";
import { RelativeTime } from "../components/RelativeTime";
import { ConnectionIndicator } from "../components/ConnectionIndicator";

export function AgentRegistryView() {
  const [agents, setAgents] = useState<Map<string, AgentRegistration>>(new Map());

  const handleMessage = useCallback((_topic: string, payload: string) => {
    try {
      const data = JSON.parse(payload) as AgentRegistration;
      if (data.appId) {
        setAgents((prev) => {
          const next = new Map(prev);
          next.set(data.appId, data);
          return next;
        });
      }
    } catch {
      // ignore malformed messages
    }
  }, []);

  useMqttSubscription("agent/registry/#", handleMessage);

  const agentList = Array.from(agents.values());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Agent Registry</h2>
        <ConnectionIndicator />
      </div>

      {agentList.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-12 text-center text-zinc-500">
          Waiting for agent registrations...
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">App ID</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Capabilities</th>
                <th className="px-4 py-3">Last Heartbeat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {agentList.map((agent) => (
                <tr key={agent.appId} className="hover:bg-zinc-900/40">
                  <td className="px-4 py-3 font-medium text-zinc-200">{agent.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">{agent.appId}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={agent.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {agent.capabilities.map((cap) => (
                        <span
                          key={cap.name}
                          className="rounded-full bg-mesh-600/20 px-2 py-0.5 text-xs text-mesh-300"
                        >
                          {cap.name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    <RelativeTime timestamp={agent.lastHeartbeat} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
