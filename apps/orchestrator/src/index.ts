import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { z } from "zod";
import {
  AgentRegistry,
  AgentScorer,
  EventLog,
  TaskResultSchema,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type TaskRequest,
  type TaskResult,
  type TaskStatus,
  type DaprPubSubMessage,
  type DaprSubscription,
} from "@mesh-six/core";
import {
  pool,
  saveTask,
  loadActiveTasks,
  updateTaskStatus,
  deleteTask,
  checkpointAll,
} from "./db";

// --- Configuration ---
const APP_ID = "orchestrator";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

// --- Clients ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });
const registry = new AgentRegistry(daprClient);
const scorer = new AgentScorer(pool);
const eventLog = new EventLog(pool);

// --- In-flight task tracking ---
const activeTasks = new Map<string, TaskStatus & { timeoutId: Timer; payload: Record<string, unknown> }>();

// --- HTTP Server ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({ status: "ok", service: APP_ID, tasks: activeTasks.size })
);

// Dapr subscription endpoint
app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: TASK_RESULTS_TOPIC,
      route: "/results",
    },
  ];
  return c.json(subscriptions);
});

// --- Task Submission API ---
const CreateTaskSchema = z.object({
  capability: z.string(),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().min(0).max(10).default(5),
  timeout: z.number().positive().default(120),
});

app.post("/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = CreateTaskSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { capability, payload, priority, timeout } = parsed.data;

  // Create task request
  const task: TaskRequest = {
    id: crypto.randomUUID(),
    capability,
    payload,
    priority,
    timeout,
    requestedBy: APP_ID,
    createdAt: new Date().toISOString(),
  };

  // Find agents with the capability
  const agents = await registry.findByCapability(capability);
  if (agents.length === 0) {
    return c.json({ error: "No agents available for capability", capability }, 503);
  }

  // Score and select best agent
  const scores = await scorer.scoreAgents(agents, capability);
  if (scores.length === 0) {
    return c.json({ error: "No healthy agents available", capability }, 503);
  }

  const bestAgent = scores[0];
  console.log(
    `[Orchestrator] Dispatching task ${task.id} to ${bestAgent.agentId} (score: ${bestAgent.finalScore.toFixed(3)})`
  );

  // Dispatch via pub/sub to agent-specific topic
  await daprClient.pubsub.publish(
    DAPR_PUBSUB_NAME,
    `tasks.${bestAgent.agentId}`,
    task
  );

  // Emit dispatch event
  await eventLog.emit({
    traceId: task.id,
    taskId: task.id,
    agentId: APP_ID,
    eventType: "task.dispatched",
    payload: {
      capability,
      dispatchedTo: bestAgent.agentId,
      score: bestAgent.finalScore,
      priority,
    },
  }).catch((err) => console.warn("[Orchestrator] Failed to emit dispatch event:", err));

  // Track task with timeout
  const timeoutId = setTimeout(() => handleTimeout(task.id), timeout * 1000);

  const status: TaskStatus & { timeoutId: Timer; payload: Record<string, unknown> } = {
    taskId: task.id,
    capability,
    dispatchedTo: bestAgent.agentId,
    dispatchedAt: new Date().toISOString(),
    status: "dispatched",
    attempts: 1,
    timeoutId,
    payload,
  };

  activeTasks.set(task.id, status);

  // Persist to database (fire-and-forget)
  saveTask({
    taskId: task.id,
    capability,
    dispatchedTo: bestAgent.agentId,
    dispatchedAt: new Date(),
    status: "dispatched",
    attempts: 1,
    timeoutSeconds: timeout,
    payload,
  }).catch((e) => console.warn("[Orchestrator] Failed to persist task:", e));

  return c.json({
    taskId: task.id,
    dispatchedTo: bestAgent.agentId,
    score: bestAgent.finalScore,
    status: "dispatched",
  });
});

// --- Task Result Handler ---
app.post("/results", async (c) => {
  const message: DaprPubSubMessage<TaskResult> = await c.req.json();
  const result = message.data;

  const parsed = TaskResultSchema.safeParse(result);
  if (!parsed.success) {
    console.error("[Orchestrator] Invalid task result:", parsed.error.issues);
    return c.json({ status: "DROP" }); // Don't retry invalid messages
  }

  const validResult = parsed.data;
  const taskStatus = activeTasks.get(validResult.taskId);

  if (!taskStatus) {
    console.warn(`[Orchestrator] Received result for unknown task: ${validResult.taskId}`);
    return c.json({ status: "SUCCESS" });
  }

  // Clear timeout
  clearTimeout(taskStatus.timeoutId);

  // Record in history for scoring
  await scorer.recordTaskResult(validResult, taskStatus.capability);

  // Update status
  taskStatus.status = validResult.success ? "completed" : "failed";
  taskStatus.result = validResult;

  console.log(
    `[Orchestrator] Task ${validResult.taskId} ${taskStatus.status}: ${
      validResult.success ? "success" : validResult.error?.message
    } (${validResult.durationMs}ms)`
  );

  // Handle failure - retry with re-scoring
  if (!validResult.success && taskStatus.attempts < 3) {
    updateTaskStatus(validResult.taskId, "retrying", { error: validResult.error }).catch((e) =>
      console.warn("[Orchestrator] Failed to update task status:", e)
    );
    await retryTask(taskStatus);
  } else {
    activeTasks.delete(validResult.taskId);
    deleteTask(validResult.taskId).catch((e) =>
      console.warn("[Orchestrator] Failed to delete completed task:", e)
    );
  }

  return c.json({ status: "SUCCESS" });
});

// --- Get Task Status ---
app.get("/tasks/:id", (c) => {
  const taskId = c.req.param("id");
  const status = activeTasks.get(taskId);

  if (!status) {
    return c.json({ error: "Task not found", taskId }, 404);
  }

  const { timeoutId, ...safeStatus } = status;
  return c.json(safeStatus);
});

// --- List Agents ---
app.get("/agents", async (c) => {
  const agents = await registry.listAll();
  return c.json({ agents });
});

// --- Score Agents for Capability ---
app.get("/agents/score/:capability", async (c) => {
  const capability = c.req.param("capability");
  const agents = await registry.findByCapability(capability);
  const scores = await scorer.scoreAgents(agents, capability);
  return c.json({ capability, scores });
});

// --- Timeout Handler ---
async function handleTimeout(taskId: string): Promise<void> {
  const taskStatus = activeTasks.get(taskId);
  if (!taskStatus) return;

  console.warn(`[Orchestrator] Task ${taskId} timed out`);

  // Emit timeout event
  await eventLog.emit({
    traceId: taskId,
    taskId: taskId,
    agentId: APP_ID,
    eventType: "task.timeout",
    payload: {
      dispatchedTo: taskStatus.dispatchedTo,
      capability: taskStatus.capability,
      attempts: taskStatus.attempts,
    },
  }).catch((err) => console.warn("[Orchestrator] Failed to emit timeout event:", err));

  // Record failure
  const failResult: TaskResult = {
    taskId,
    agentId: taskStatus.dispatchedTo!,
    success: false,
    error: { type: "timeout", message: "Task execution timed out" },
    durationMs: 0,
    completedAt: new Date().toISOString(),
  };

  await scorer.recordTaskResult(failResult, taskStatus.capability);
  taskStatus.status = "timeout";

  // Retry with re-scoring if attempts remain
  if (taskStatus.attempts < 3) {
    updateTaskStatus(taskId, "timeout", { error: { type: "timeout", message: "Task execution timed out" } }).catch((e) =>
      console.warn("[Orchestrator] Failed to update task status:", e)
    );
    await retryTask(taskStatus);
  } else {
    console.error(`[Orchestrator] Task ${taskId} failed after 3 attempts`);
    activeTasks.delete(taskId);
    deleteTask(taskId).catch((e) =>
      console.warn("[Orchestrator] Failed to delete terminal task:", e)
    );
  }
}

// --- Retry with Re-scoring ---
async function retryTask(taskStatus: TaskStatus & { timeoutId: Timer; payload: Record<string, unknown> }): Promise<void> {
  const agents = await registry.findByCapability(taskStatus.capability);

  // Exclude the failed agent from this retry
  const availableAgents = agents.filter((a) => a.appId !== taskStatus.dispatchedTo);

  if (availableAgents.length === 0) {
    console.error(`[Orchestrator] No alternative agents for retry: ${taskStatus.taskId}`);
    activeTasks.delete(taskStatus.taskId);
    deleteTask(taskStatus.taskId).catch((e) =>
      console.warn("[Orchestrator] Failed to delete task with no agents:", e)
    );
    return;
  }

  const scores = await scorer.scoreAgents(availableAgents, taskStatus.capability);
  if (scores.length === 0) {
    console.error(`[Orchestrator] No healthy agents for retry: ${taskStatus.taskId}`);
    activeTasks.delete(taskStatus.taskId);
    deleteTask(taskStatus.taskId).catch((e) =>
      console.warn("[Orchestrator] Failed to delete task with no healthy agents:", e)
    );
    return;
  }

  const bestAgent = scores[0];
  taskStatus.attempts++;
  taskStatus.dispatchedTo = bestAgent.agentId;
  taskStatus.dispatchedAt = new Date().toISOString();
  taskStatus.status = "dispatched";

  console.log(
    `[Orchestrator] Retrying task ${taskStatus.taskId} to ${bestAgent.agentId} (attempt ${taskStatus.attempts})`
  );

  // Emit retry event
  await eventLog.emit({
    traceId: taskStatus.taskId,
    taskId: taskStatus.taskId,
    agentId: APP_ID,
    eventType: "task.retry",
    payload: {
      capability: taskStatus.capability,
      attempt: taskStatus.attempts,
      newAgent: bestAgent.agentId,
      score: bestAgent.finalScore,
    },
  }).catch((err) => console.warn("[Orchestrator] Failed to emit retry event:", err));

  // Re-dispatch
  await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, `tasks.${bestAgent.agentId}`, {
    id: taskStatus.taskId,
    capability: taskStatus.capability,
    payload: taskStatus.payload,
    priority: 5,
    timeout: 120,
    requestedBy: APP_ID,
    createdAt: new Date().toISOString(),
  });

  // Reset timeout
  taskStatus.timeoutId = setTimeout(() => handleTimeout(taskStatus.taskId), 120 * 1000);

  // Persist retry state (fire-and-forget)
  saveTask({
    taskId: taskStatus.taskId,
    capability: taskStatus.capability,
    dispatchedTo: bestAgent.agentId,
    dispatchedAt: new Date(),
    status: "dispatched",
    attempts: taskStatus.attempts,
    payload: taskStatus.payload,
  }).catch((e) => console.warn("[Orchestrator] Failed to persist retry:", e));
}

// --- Startup Recovery ---
try {
  const recovered = await loadActiveTasks();
  for (const task of recovered) {
    const elapsedMs = Date.now() - task.dispatchedAt.getTime();
    const remainingMs = Math.max(0, task.timeoutSeconds * 1000 - elapsedMs);
    const timeoutId = setTimeout(() => handleTimeout(task.taskId), remainingMs);

    activeTasks.set(task.taskId, {
      taskId: task.taskId,
      capability: task.capability,
      dispatchedTo: task.dispatchedTo,
      dispatchedAt: task.dispatchedAt.toISOString(),
      status: task.status as "pending" | "dispatched" | "completed" | "failed" | "timeout",
      attempts: task.attempts,
      timeoutId,
      payload: task.payload,
    });
  }
  if (recovered.length > 0) {
    console.log(`[Orchestrator] Recovered ${recovered.length} in-flight tasks from database`);
  }
} catch (e) {
  console.warn("[Orchestrator] Failed to recover tasks from database:", e);
}

// --- Graceful Shutdown ---
async function shutdown() {
  console.log("[Orchestrator] Shutdown signal received, checkpointing tasks...");
  try {
    await checkpointAll(activeTasks);
    console.log("[Orchestrator] Checkpoint complete");
  } catch (e) {
    console.warn("[Orchestrator] Checkpoint failed:", e);
  }
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start Server ---
console.log(`[Orchestrator] Starting on port ${APP_PORT}`);
Bun.serve({ port: APP_PORT, fetch: app.fetch });
