import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { createOpenAI } from "@ai-sdk/openai";
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
const AGENT_ID = process.env.AGENT_ID || "simple-agent";
const AGENT_NAME = process.env.AGENT_NAME || "Simple Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "phi3.5";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// --- LLM Provider (LiteLLM OpenAI-compatible with Ollama) ---
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

// --- Agent Registration Definition ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    { name: "general-query", weight: 0.8, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
};

const BASE_SYSTEM_PROMPT = `You are a helpful assistant running as part of the mesh-six
agent mesh. You can answer general questions and help with basic tasks.
Be concise and direct. If you don't know something, say so.

You are running in a Kubernetes cluster with access to various services.
Current agent ID: ${AGENT_ID}`;

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint for k8s probes
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
  })
);

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription endpoint
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

// Task handler — receives dispatched tasks from orchestrator
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id} — ${task.capability}`);

  try {
    const result = await handleTask(task);

    // Publish result back to orchestrator
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

// Direct invocation endpoint — for synchronous agent-to-agent calls
app.post("/invoke", async (c) => {
  const body = await c.req.json();
  const result = await handleTask(body);
  return c.json(result);
});

// --- Core Task Handler ---
async function handleTask(task: TaskRequest): Promise<TaskResult> {
  const startTime = Date.now();

  // Extract query and user from payload
  const query =
    typeof task.payload.query === "string"
      ? task.payload.query
      : JSON.stringify(task.payload);

  const userId =
    typeof task.payload.userId === "string"
      ? task.payload.userId
      : task.requestedBy;

  // Build system prompt with memories
  let systemPrompt = BASE_SYSTEM_PROMPT;

  if (memory) {
    try {
      // Search for relevant memories
      const memories = await memory.search(query, userId, 5);

      if (memories.length > 0) {
        const memoryContext = memories
          .map((m) => `- ${m.memory}`)
          .join("\n");

        systemPrompt += `\n\n## Relevant Context from Memory\nThe following information may be relevant to this conversation:\n${memoryContext}`;

        console.log(`[${AGENT_ID}] Found ${memories.length} relevant memories for user ${userId}`);
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
      // Continue without memories
    }
  }

  // Generate response
  const traceId = crypto.randomUUID();
  const { text } = await tracedGenerateText(
    { model: llm(LLM_MODEL), system: systemPrompt, prompt: query },
    eventLog ? { eventLog, traceId, agentId: AGENT_ID, taskId: task.id } : null
  );

  // Store conversation in memory
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
      console.log(`[${AGENT_ID}] Stored conversation in memory for user ${userId}`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory store failed:`, error);
      // Continue without storing
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
  // Initialize memory if enabled
  if (MEMORY_ENABLED) {
    try {
      memory = createAgentMemoryFromEnv(AGENT_ID);
      console.log(`[${AGENT_ID}] Memory layer initialized`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory initialization failed, running without memory:`, error);
      memory = null;
    }
  }

  // Register with agent registry
  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  // Start heartbeat interval (every 30s)
  heartbeatInterval = setInterval(async () => {
    try {
      await registry.heartbeat(AGENT_ID);
    } catch (error) {
      console.error(`[${AGENT_ID}] Heartbeat failed:`, error);
    }
  }, 30_000);

  // Start HTTP server
  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);

  // Clear heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Mark as offline in registry
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
