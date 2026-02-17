import { Hono } from "hono";
import { Pool } from "pg";
import { EventLog, DAPR_PUBSUB_NAME } from "@mesh-six/core";

const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.PG_PRIMARY_URL ||
  "postgres://localhost:5432/mesh_six";

const pool = new Pool({ connectionString: DATABASE_URL });
const eventLog = new EventLog(pool);

const app = new Hono();

// Health
app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr subscriptions — subscribe to task lifecycle topics
const SUBSCRIPTIONS = [
  { pubsubname: DAPR_PUBSUB_NAME, topic: "task-results", route: "/events/task-results" },
  { pubsubname: DAPR_PUBSUB_NAME, topic: "task-progress", route: "/events/task-progress" },
];

app.get("/dapr/subscribe", (c) => c.json(SUBSCRIPTIONS));

// Handle task-results events
app.post("/events/task-results", async (c) => {
  try {
    const envelope = await c.req.json();
    const data = envelope.data ?? envelope;

    await eventLog.emit({
      traceId: data.traceId ?? data.taskId ?? crypto.randomUUID(),
      taskId: data.taskId,
      agentId: data.agentId ?? "unknown",
      eventType: data.success ? "task.result" : "task.result.failure",
      payload: {
        success: data.success,
        durationMs: data.durationMs,
        errorType: data.errorType ?? null,
        capability: data.capability ?? null,
        result: data.result ?? null,
      },
    });
  } catch (err) {
    console.error("[event-logger] Failed to process task-result:", err);
  }

  return c.json({ status: "SUCCESS" });
});

// Handle task-progress events
app.post("/events/task-progress", async (c) => {
  try {
    const envelope = await c.req.json();
    const data = envelope.data ?? envelope;

    await eventLog.emit({
      traceId: data.traceId ?? data.taskId ?? crypto.randomUUID(),
      taskId: data.taskId,
      agentId: data.agentId ?? "unknown",
      eventType: "task.progress",
      payload: {
        status: data.status,
        details: data.details ?? null,
      },
    });
  } catch (err) {
    console.error("[event-logger] Failed to process task-progress:", err);
  }

  return c.json({ status: "SUCCESS" });
});

// Start
console.log(`[event-logger] Starting on port ${APP_PORT}`);
Bun.serve({ port: APP_PORT, fetch: app.fetch });
