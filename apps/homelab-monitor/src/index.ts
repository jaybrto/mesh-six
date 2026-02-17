import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { Pool } from "pg";
import {
  AgentRegistry,
  AgentMemory,
  createAgentMemoryFromEnv,
  EventLog,
  tracedGenerateText,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
} from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "homelab-monitor";
const AGENT_NAME = process.env.AGENT_NAME || "Homelab Monitor";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// Monitoring service endpoints
const GRAFANA_URL = process.env.GRAFANA_URL || "http://grafana.monitoring:3000";
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY || "";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://mimir.monitoring:9009/prometheus";

// --- LLM Provider ---
const llm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
});

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });
const registry = new AgentRegistry(daprClient);

// --- Memory Layer ---
let memory: AgentMemory | null = null;

// --- Event Log ---
let eventLog: EventLog | null = null;
if (DATABASE_URL) {
  const pool = new Pool({ connectionString: DATABASE_URL });
  eventLog = new EventLog(pool);
  console.log(`[${AGENT_ID}] Event log initialized`);
}

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    { name: "cluster-monitoring", weight: 1.0, preferred: true, requirements: [] },
    { name: "log-analysis", weight: 0.9, preferred: false, requirements: [] },
    { name: "alert-triage", weight: 0.85, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "infrastructure-monitoring",
    services: ["grafana", "prometheus", "loki"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Homelab Monitor Agent for Jay's 6-node k3s cluster. Your role is to monitor cluster health, analyze logs, and triage alerts.

## Cluster Topology
- 6-node k3s cluster at k3s.bto.bar
- Monitoring stack: Grafana, Prometheus/Mimir, Loki
- Key namespaces: default, monitoring, litellm, argocd, dapr-system, mesh-six

## Your Capabilities
- Query Grafana dashboards and data sources
- Query Prometheus/Mimir for metrics
- Query Loki for log analysis
- Check pod health and status
- Retrieve and triage active alerts

## Monitoring Guidelines
- Prioritize critical alerts (pod crashes, node issues, resource exhaustion)
- Correlate metrics with logs for root cause analysis
- Track patterns over time using memory
- Provide actionable recommendations
- Be concise but thorough in reporting

Current agent ID: ${AGENT_ID}`;

// --- Tool Definitions ---
const tools = {
  query_grafana: tool({
    description: "Query Grafana for dashboard data or annotations. Use for visualized metrics and saved dashboards.",
    parameters: z.object({
      endpoint: z.string().describe("Grafana API endpoint path (e.g., /api/dashboards/uid/xxx, /api/search, /api/annotations)"),
      params: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    }),
    execute: async ({ endpoint, params }) => {
      console.log(`[${AGENT_ID}] Grafana query: ${endpoint}`);
      try {
        const url = new URL(endpoint, GRAFANA_URL);
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
          }
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (GRAFANA_API_KEY) {
          headers["Authorization"] = `Bearer ${GRAFANA_API_KEY}`;
        }

        const response = await fetch(url.toString(), { headers });
        if (!response.ok) {
          return { error: `Grafana returned ${response.status}: ${response.statusText}` };
        }
        return await response.json();
      } catch (error) {
        return { error: `Grafana query failed: ${error}` };
      }
    },
  }),

  query_loki: tool({
    description: "Query Loki for log entries. Supports LogQL queries for searching and aggregating logs.",
    parameters: z.object({
      query: z.string().describe("LogQL query (e.g., {namespace=\"default\"} |= \"error\")"),
      start: z.string().optional().describe("Start time (RFC3339 or relative like '1h')"),
      end: z.string().optional().describe("End time (RFC3339 or 'now')"),
      limit: z.number().default(100).describe("Maximum number of log lines to return"),
    }),
    execute: async ({ query, start, end, limit }) => {
      console.log(`[${AGENT_ID}] Loki query: ${query}`);
      try {
        // Loki is typically queried through Grafana's datasource proxy
        const url = new URL("/loki/api/v1/query_range", GRAFANA_URL);
        url.searchParams.set("query", query);
        url.searchParams.set("limit", String(limit));

        if (start) url.searchParams.set("start", start);
        if (end) url.searchParams.set("end", end);

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (GRAFANA_API_KEY) {
          headers["Authorization"] = `Bearer ${GRAFANA_API_KEY}`;
        }

        const response = await fetch(url.toString(), { headers });
        if (!response.ok) {
          return { error: `Loki returned ${response.status}: ${response.statusText}` };
        }
        return await response.json();
      } catch (error) {
        return { error: `Loki query failed: ${error}` };
      }
    },
  }),

  query_prometheus: tool({
    description: "Query Prometheus/Mimir for metrics using PromQL. Use for time-series data, resource usage, and SLIs.",
    parameters: z.object({
      query: z.string().describe("PromQL query (e.g., up{job=\"kubelet\"}, node_cpu_seconds_total)"),
      time: z.string().optional().describe("Evaluation timestamp (RFC3339 or Unix)"),
      start: z.string().optional().describe("Range query start time"),
      end: z.string().optional().describe("Range query end time"),
      step: z.string().optional().describe("Range query step (e.g., 15s, 1m, 5m)"),
    }),
    execute: async ({ query, time, start, end, step }) => {
      console.log(`[${AGENT_ID}] Prometheus query: ${query}`);
      try {
        const isRange = start && end;
        const endpoint = isRange ? "/api/v1/query_range" : "/api/v1/query";
        const url = new URL(endpoint, PROMETHEUS_URL);
        url.searchParams.set("query", query);

        if (isRange) {
          url.searchParams.set("start", start);
          url.searchParams.set("end", end);
          if (step) url.searchParams.set("step", step);
        } else if (time) {
          url.searchParams.set("time", time);
        }

        const response = await fetch(url.toString());
        if (!response.ok) {
          return { error: `Prometheus returned ${response.status}: ${response.statusText}` };
        }
        return await response.json();
      } catch (error) {
        return { error: `Prometheus query failed: ${error}` };
      }
    },
  }),

  check_pod_health: tool({
    description: "Check the health status of pods in the cluster. Queries Prometheus for pod-related metrics.",
    parameters: z.object({
      namespace: z.string().optional().describe("Kubernetes namespace to check (empty for all)"),
      podName: z.string().optional().describe("Specific pod name pattern to filter"),
    }),
    execute: async ({ namespace, podName }) => {
      console.log(`[${AGENT_ID}] Pod health check: ns=${namespace || "all"}, pod=${podName || "all"}`);
      try {
        // Query pod status via Prometheus kube-state-metrics
        const labelSelector = [
          namespace ? `namespace="${namespace}"` : "",
          podName ? `pod=~"${podName}.*"` : "",
        ].filter(Boolean).join(",");

        const queries = {
          running: `kube_pod_status_phase{phase="Running"${labelSelector ? "," + labelSelector : ""}}`,
          failed: `kube_pod_status_phase{phase="Failed"${labelSelector ? "," + labelSelector : ""}}`,
          restarts: `increase(kube_pod_container_status_restarts_total{${labelSelector}}[1h])`,
        };

        const results: Record<string, unknown> = {};
        for (const [name, query] of Object.entries(queries)) {
          const url = new URL("/api/v1/query", PROMETHEUS_URL);
          url.searchParams.set("query", query);

          const response = await fetch(url.toString());
          if (response.ok) {
            results[name] = await response.json();
          } else {
            results[name] = { error: `Query failed: ${response.status}` };
          }
        }

        return results;
      } catch (error) {
        return { error: `Pod health check failed: ${error}` };
      }
    },
  }),

  get_alerts: tool({
    description: "Get active alerts from Prometheus Alertmanager or Grafana alerting.",
    parameters: z.object({
      severity: z.enum(["critical", "warning", "info", "all"]).default("all").describe("Filter by severity"),
      namespace: z.string().optional().describe("Filter alerts by namespace"),
    }),
    execute: async ({ severity, namespace }) => {
      console.log(`[${AGENT_ID}] Getting alerts: severity=${severity}, ns=${namespace || "all"}`);
      try {
        // Query alerts via Prometheus Alertmanager API
        const url = new URL("/api/v1/alerts", PROMETHEUS_URL);
        const response = await fetch(url.toString());

        if (!response.ok) {
          return { error: `Alertmanager returned ${response.status}: ${response.statusText}` };
        }

        const data = await response.json() as { data?: { alerts?: Array<{ labels?: Record<string, string> }> } };
        let alerts = data.data?.alerts || [];

        // Filter by severity
        if (severity !== "all") {
          alerts = alerts.filter((a: { labels?: Record<string, string> }) =>
            a.labels?.severity === severity
          );
        }

        // Filter by namespace
        if (namespace) {
          alerts = alerts.filter((a: { labels?: Record<string, string> }) =>
            a.labels?.namespace === namespace
          );
        }

        return {
          totalAlerts: alerts.length,
          alerts,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        return { error: `Alert query failed: ${error}` };
      }
    },
  }),
};

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
    services: {
      grafana: GRAFANA_URL,
      prometheus: PROMETHEUS_URL,
    },
  })
);

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription
app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: `tasks.${AGENT_ID}`,
      route: "/tasks",
    },
  ];
  return c.json(subscriptions);
});

// Task handler (pub/sub)
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id} - ${task.capability}`);

  try {
    const result = await handleTask(task);
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, result);
    console.log(`[${AGENT_ID}] Task ${task.id} completed in ${result.durationMs}ms`);
    return c.json({ status: "SUCCESS" });
  } catch (error) {
    console.error(`[${AGENT_ID}] Task ${task.id} failed:`, error);

    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "unhandled", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" }); // ACK to Dapr even on failure
  }
});

// Direct invocation endpoint
app.post("/invoke", async (c) => {
  const body = await c.req.json();
  const result = await handleTask(body);
  return c.json(result);
});

// --- Core Task Handler ---
async function handleTask(task: TaskRequest): Promise<TaskResult> {
  const startTime = Date.now();

  const query =
    typeof task.payload.query === "string"
      ? task.payload.query
      : JSON.stringify(task.payload);

  const userId =
    typeof task.payload.userId === "string"
      ? task.payload.userId
      : task.requestedBy;

  // Build system prompt with memories
  let systemPrompt = SYSTEM_PROMPT;

  if (memory) {
    try {
      const memories = await memory.search(query, userId, 5);
      if (memories.length > 0) {
        const memoryContext = memories.map((m) => `- ${m.memory}`).join("\n");
        systemPrompt += `\n\n## Relevant Alert History & Patterns\n${memoryContext}`;
        console.log(`[${AGENT_ID}] Found ${memories.length} relevant memories`);
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Generate response with tool use
  const traceId = crypto.randomUUID();
  const { text } = await tracedGenerateText(
    { model: llm(LLM_MODEL), system: systemPrompt, prompt: query, tools, maxSteps: 8 },
    eventLog ? { eventLog, traceId, agentId: AGENT_ID, taskId: task.id } : null
  );

  // Store in memory
  if (memory) {
    try {
      await memory.store(
        [
          { role: "user", content: query },
          { role: "assistant", content: text },
        ],
        userId,
        {
          taskId: task.id,
          capability: task.capability,
        }
      );
      console.log(`[${AGENT_ID}] Stored conversation in memory`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory store failed:`, error);
    }
  }

  return {
    taskId: task.id,
    agentId: AGENT_ID,
    success: true,
    result: { response: text },
    durationMs: Date.now() - startTime,
    completedAt: new Date().toISOString(),
  };
}

// --- Lifecycle ---
let heartbeatInterval: Timer | null = null;

async function start(): Promise<void> {
  if (MEMORY_ENABLED) {
    try {
      memory = createAgentMemoryFromEnv(AGENT_ID);
      console.log(`[${AGENT_ID}] Memory layer initialized`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory initialization failed:`, error);
      memory = null;
    }
  }

  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  heartbeatInterval = setInterval(async () => {
    try {
      await registry.heartbeat(AGENT_ID);
    } catch (error) {
      console.error(`[${AGENT_ID}] Heartbeat failed:`, error);
    }
  }, 30_000);

  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
  console.log(`[${AGENT_ID}] Grafana: ${GRAFANA_URL}, Prometheus: ${PROMETHEUS_URL}`);
}

async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  try {
    await registry.markOffline(AGENT_ID);
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to mark offline:`, error);
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((error) => {
  console.error(`[${AGENT_ID}] Failed to start:`, error);
  process.exit(1);
});
