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
const AGENT_ID = process.env.AGENT_ID || "cost-tracker";
const AGENT_NAME = process.env.AGENT_NAME || "Cost Tracker";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// Prometheus for cluster resource metrics
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
    { name: "cost-reporting", weight: 1.0, preferred: true, requirements: [] },
    { name: "usage-analysis", weight: 0.9, preferred: false, requirements: [] },
    { name: "spend-alerting", weight: 0.85, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "cost-analysis",
    services: ["litellm", "prometheus"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Cost Tracker Agent for the mesh-six platform. You monitor and analyze LLM spending, cluster resource usage, and provide cost optimization recommendations.

## Cost Sources
- LLM API spend via LiteLLM gateway (tracks per-model, per-user spend)
- Cluster resource usage (CPU, memory, storage) via Prometheus
- Energy consumption estimates based on node utilization

## Your Capabilities
- Query LiteLLM spend data by model, user, date range
- List available models and their pricing
- Query cluster resource utilization
- Generate comprehensive cost reports
- Identify cost anomalies and optimization opportunities

## Reporting Guidelines
- Always include time period for cost data
- Compare current spend to historical averages
- Highlight unusual patterns or spikes
- Provide actionable cost optimization recommendations
- Track cost trends over time using memory

Current agent ID: ${AGENT_ID}`;

// --- Helper: LiteLLM API ---
async function litellmRequest(endpoint: string, method: string = "GET", body?: unknown): Promise<unknown> {
  // LiteLLM base URL includes /v1, but spend endpoints are at the root
  const baseUrl = LITELLM_BASE_URL.replace(/\/v1\/?$/, "");
  const url = `${baseUrl}${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${LITELLM_API_KEY}`,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM API ${response.status}: ${text}`);
  }

  return response.json();
}

// --- Tool Definitions ---
const tools = {
  query_litellm_spend: tool({
    description: "Query LiteLLM for spending data. Can filter by model, user, and date range.",
    parameters: z.object({
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD format)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD format)"),
      apiKey: z.string().optional().describe("Filter by specific API key / user"),
      model: z.string().optional().describe("Filter by model name"),
    }),
    execute: async ({ startDate, endDate, apiKey, model }) => {
      console.log(`[${AGENT_ID}] Querying LiteLLM spend: ${startDate || "all"} to ${endDate || "now"}`);
      try {
        const params = new URLSearchParams();
        if (startDate) params.set("start_date", startDate);
        if (endDate) params.set("end_date", endDate);
        if (apiKey) params.set("api_key", apiKey);

        // Get spend logs
        const spendData = await litellmRequest(`/spend/logs?${params.toString()}`);

        // Also try to get aggregated spend if available
        let aggregated: unknown = null;
        try {
          const aggParams = new URLSearchParams();
          if (startDate) aggParams.set("start_date", startDate);
          if (endDate) aggParams.set("end_date", endDate);
          if (model) aggParams.set("model", model);
          aggregated = await litellmRequest(`/global/spend?${aggParams.toString()}`);
        } catch {
          // Aggregated endpoint may not exist in all LiteLLM versions
        }

        return {
          spendLogs: spendData,
          aggregated,
          queryParams: { startDate, endDate, apiKey, model },
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        return { error: `LiteLLM spend query failed: ${error}` };
      }
    },
  }),

  query_litellm_models: tool({
    description: "List available models in LiteLLM with their configuration and pricing info.",
    parameters: z.object({
      includeInactive: z.boolean().default(false).describe("Include inactive/disabled models"),
    }),
    execute: async ({ includeInactive }) => {
      console.log(`[${AGENT_ID}] Listing LiteLLM models`);
      try {
        // Use OpenAI-compatible model list
        const models = await litellmRequest("/v1/models");

        // Try to get model info with pricing
        let modelInfo: unknown = null;
        try {
          modelInfo = await litellmRequest("/model/info");
        } catch {
          // Model info endpoint may not be available
        }

        return {
          models,
          modelInfo,
          includeInactive,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        return { error: `LiteLLM model list failed: ${error}` };
      }
    },
  }),

  query_cluster_resources: tool({
    description: "Query cluster resource utilization (CPU, memory, storage) from Prometheus. Provides cost context for infrastructure spend.",
    parameters: z.object({
      resource: z.enum(["cpu", "memory", "storage", "all"]).default("all").describe("Resource type to query"),
      namespace: z.string().optional().describe("Filter by namespace"),
      timeRange: z.string().default("24h").describe("Time range for aggregation (e.g., 1h, 24h, 7d)"),
    }),
    execute: async ({ resource, namespace, timeRange }) => {
      console.log(`[${AGENT_ID}] Querying cluster resources: ${resource}, range=${timeRange}`);
      try {
        const nsFilter = namespace ? `namespace="${namespace}"` : "";
        const queries: Record<string, string> = {};

        if (resource === "cpu" || resource === "all") {
          queries.cpuUsage = nsFilter
            ? `sum(rate(container_cpu_usage_seconds_total{${nsFilter}}[5m])) by (namespace)`
            : `sum(rate(container_cpu_usage_seconds_total[5m])) by (namespace)`;
          queries.cpuRequests = nsFilter
            ? `sum(kube_pod_container_resource_requests{resource="cpu",${nsFilter}}) by (namespace)`
            : `sum(kube_pod_container_resource_requests{resource="cpu"}) by (namespace)`;
        }

        if (resource === "memory" || resource === "all") {
          queries.memoryUsage = nsFilter
            ? `sum(container_memory_working_set_bytes{${nsFilter}}) by (namespace)`
            : `sum(container_memory_working_set_bytes) by (namespace)`;
          queries.memoryRequests = nsFilter
            ? `sum(kube_pod_container_resource_requests{resource="memory",${nsFilter}}) by (namespace)`
            : `sum(kube_pod_container_resource_requests{resource="memory"}) by (namespace)`;
        }

        if (resource === "storage" || resource === "all") {
          queries.pvUsage = nsFilter
            ? `sum(kubelet_volume_stats_used_bytes{${nsFilter}}) by (namespace)`
            : `sum(kubelet_volume_stats_used_bytes) by (namespace)`;
          queries.pvCapacity = nsFilter
            ? `sum(kubelet_volume_stats_capacity_bytes{${nsFilter}}) by (namespace)`
            : `sum(kubelet_volume_stats_capacity_bytes) by (namespace)`;
        }

        const results: Record<string, unknown> = {};
        for (const [name, query] of Object.entries(queries)) {
          try {
            const url = new URL("/api/v1/query", PROMETHEUS_URL);
            url.searchParams.set("query", query);

            const response = await fetch(url.toString());
            if (response.ok) {
              results[name] = await response.json();
            } else {
              results[name] = { error: `Query failed: ${response.status}` };
            }
          } catch (error) {
            results[name] = { error: `Query error: ${error}` };
          }
        }

        return {
          resource,
          namespace: namespace || "all",
          timeRange,
          results,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        return { error: `Cluster resource query failed: ${error}` };
      }
    },
  }),

  generate_cost_report: tool({
    description: "Generate a comprehensive cost report combining LLM spend and cluster resource data. Provides trends and optimization recommendations.",
    parameters: z.object({
      period: z.enum(["daily", "weekly", "monthly"]).default("weekly").describe("Report period"),
      includeRecommendations: z.boolean().default(true).describe("Include cost optimization recommendations"),
    }),
    execute: async ({ period, includeRecommendations }) => {
      console.log(`[${AGENT_ID}] Generating ${period} cost report`);
      try {
        const now = new Date();
        let startDate: string;

        switch (period) {
          case "daily":
            startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            break;
          case "weekly":
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            break;
          case "monthly":
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            break;
        }
        const endDate = now.toISOString().split("T")[0];

        // Collect LLM spend
        let llmSpend: unknown = null;
        try {
          llmSpend = await litellmRequest(`/spend/logs?start_date=${startDate}&end_date=${endDate}`);
        } catch (error) {
          llmSpend = { error: `Failed to get LLM spend: ${error}` };
        }

        // Collect cluster resource usage
        const resourceResults: Record<string, unknown> = {};
        const resourceQueries = {
          totalCpuUsage: "sum(rate(container_cpu_usage_seconds_total[5m]))",
          totalMemoryUsage: "sum(container_memory_working_set_bytes)",
          nodeCount: "count(kube_node_info)",
          podCount: "count(kube_pod_info)",
        };

        for (const [name, query] of Object.entries(resourceQueries)) {
          try {
            const url = new URL("/api/v1/query", PROMETHEUS_URL);
            url.searchParams.set("query", query);
            const response = await fetch(url.toString());
            if (response.ok) {
              resourceResults[name] = await response.json();
            }
          } catch {
            resourceResults[name] = { error: "Query failed" };
          }
        }

        return {
          period,
          startDate,
          endDate,
          llmSpend,
          clusterResources: resourceResults,
          includeRecommendations,
          generatedAt: new Date().toISOString(),
          note: "The LLM will synthesize this data into a readable report with recommendations",
        };
      } catch (error) {
        return { error: `Cost report generation failed: ${error}` };
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
      litellm: LITELLM_BASE_URL,
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
    return c.json({ status: "SUCCESS" });
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
        systemPrompt += `\n\n## Historical Cost Data & Patterns\n${memoryContext}`;
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
  console.log(`[${AGENT_ID}] LiteLLM: ${LITELLM_BASE_URL}, Prometheus: ${PROMETHEUS_URL}`);
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
