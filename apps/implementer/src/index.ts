import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import pg from "pg";
import {
  AgentRegistry,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
  createMinioClient,
  getMinioPresignedUrl,
  type MinioConfig,
} from "@mesh-six/core";
import {
  APP_PORT,
  DAPR_HOST,
  DAPR_HTTP_PORT,
  AGENT_ID,
  AGENT_NAME,
  DATABASE_URL,
} from "./config.js";
import { getOrCreateActor } from "./actor.js";
import { SessionMonitor } from "./monitor.js";
import {
  insertSession,
  getSession,
  listSessions,
  getSessionQuestions,
  getLatestCheckpoint,
  getSessionSnapshots,
  getSessionRecordings,
  getRecordingById,
} from "./session-db.js";
import { shutdownAllStreams } from "./terminal-relay.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: String(DAPR_HTTP_PORT) });
const registry = new AgentRegistry(daprClient);

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    { name: "implementation", weight: 1.0, preferred: true, requirements: [] },
    { name: "bug-fix-implementation", weight: 0.9, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
};

// --- Active session monitors (sessionId → monitor) ---
const activeMonitors = new Map<string, SessionMonitor>();

// --- HTTP Server ---
const app = new Hono();

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    activeSessions: activeMonitors.size,
  })
);

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

  // Kick off async — always ACK to Dapr immediately
  handleTask(task).catch((err) => {
    console.error(`[${AGENT_ID}] handleTask failed for ${task.id}:`, err);
  });

  return c.json({ status: "SUCCESS" });
});

// Terminal streaming REST endpoints
app.get("/sessions/:id/snapshots", async (c) => {
  const sessionId = c.req.param("id");
  const snapshots = await getSessionSnapshots(sessionId);
  return c.json(snapshots);
});

app.get("/sessions/:id/recordings", async (c) => {
  const sessionId = c.req.param("id");
  const recordings = await getSessionRecordings(sessionId);
  return c.json(recordings);
});

app.get("/recordings/:id/url", async (c) => {
  const id = Number(c.req.param("id"));
  const recording = await getRecordingById(id);
  if (!recording) return c.json({ error: "Recording not found" }, 404);
  const minioConfig: MinioConfig = {
    endpoint: process.env.MINIO_ENDPOINT || "http://minio.default.svc.cluster.local:9000",
    accessKeyId: process.env.MINIO_ACCESS_KEY || "",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "",
    bucket: process.env.MINIO_BUCKET || "mesh-six-recordings",
  };
  const client = createMinioClient(minioConfig);
  const url = await getMinioPresignedUrl(client, minioConfig.bucket, recording.s3Key);
  return c.json({ url });
});

// Session REST API — mobile app / dashboard consumption
app.get("/sessions", async (c) => {
  const status = c.req.query("status") as
    | "idle" | "running" | "blocked" | "completed" | "failed" | "interrupted"
    | undefined;
  const repoOwner = c.req.query("repoOwner");
  const repoName = c.req.query("repoName");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : undefined;
  const result = await listSessions({ status, repoOwner, repoName, limit, offset });
  return c.json(result);
});

app.get("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const session = await getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const [questions, checkpoint] = await Promise.all([
    getSessionQuestions(sessionId),
    getLatestCheckpoint(sessionId),
  ]);
  return c.json({ ...session, questions, latestCheckpoint: checkpoint });
});

app.post("/sessions/:id/answer", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json() as { answerText?: string };
  if (!body.answerText) return c.json({ error: "answerText is required" }, 400);

  const session = await getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (!session.actorId) return c.json({ error: "Session has no actor" }, 400);

  const actor = getOrCreateActor(session.actorId);
  const result = await actor.injectAnswer({ answerText: body.answerText });
  return c.json(result, result.ok ? 200 : 400);
});

// Direct invocation endpoint — for synchronous calls (e.g., actor status queries)
app.post("/invoke", async (c) => {
  const body = await c.req.json() as {
    method: string;
    actorId?: string;
    params?: Record<string, unknown>;
  };

  if (body.method === "getStatus" && body.actorId) {
    const actor = getOrCreateActor(body.actorId);
    return c.json(actor.getStatus());
  }

  return c.json({ error: `Unknown method: ${body.method}` }, 400);
});

// Dapr actor endpoints (required by Dapr sidecar for actor runtime)
app.get("/dapr/config", (c) =>
  c.json({
    entities: ["ImplementerActor"],
    actorIdleTimeout: "30m",
    drainOngoingCallTimeout: "60s",
    drainRebalancedActors: true,
    reentrancy: { enabled: false },
  })
);

app.put("/actors/:actorType/:actorId/method/:methodName", async (c) => {
  const { actorType: _actorType, actorId, methodName } = c.req.param();
  const actor = getOrCreateActor(actorId);

  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }

    switch (methodName) {
      case "onActivate": {
        const p = body as Parameters<typeof actor.onActivate>[0];
        const result = await actor.onActivate(p);
        return c.json(result);
      }
      case "startSession": {
        const p = body as Parameters<typeof actor.startSession>[0];
        const result = await actor.startSession(p);
        return c.json(result);
      }
      case "injectAnswer": {
        const p = body as Parameters<typeof actor.injectAnswer>[0];
        const result = await actor.injectAnswer(p);
        return c.json(result);
      }
      case "getStatus":
        return c.json(actor.getStatus());
      case "onDeactivate":
        await actor.onDeactivate();
        return c.json({ ok: true });
      default:
        return c.json({ error: `Unknown method: ${methodName}` }, 400);
    }
  } catch (err) {
    console.error(`[${AGENT_ID}] Actor method error:`, err);
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Core task handler
// ---------------------------------------------------------------------------

async function handleTask(task: TaskRequest): Promise<void> {
  const startTime = Date.now();

  const payload = task.payload as {
    issueNumber?: number;
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    implementationPrompt?: string;
  };

  const { issueNumber, repoOwner, repoName, branch, implementationPrompt } = payload;

  if (!issueNumber || !repoOwner || !repoName || !branch || !implementationPrompt) {
    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "invalid_payload", message: "Missing required fields: issueNumber, repoOwner, repoName, branch, implementationPrompt" },
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return;
  }

  const actorId = `${repoOwner}-${repoName}-${issueNumber}`;
  const sessionId = crypto.randomUUID();

  // Insert session record
  await insertSession({
    id: sessionId,
    issueNumber,
    repoOwner,
    repoName,
    actorId,
  });

  // Activate actor
  const actor = getOrCreateActor(actorId);
  actor.setDependencies(daprClient, pool);
  const activateResult = await actor.onActivate({
    sessionId,
    issueNumber,
    repoOwner,
    repoName,
    branch,
  });

  if (!activateResult.ok) {
    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "activation_failed", message: activateResult.error ?? "Actor activation failed" },
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return;
  }

  // Start the implementation session
  const startResult = await actor.startSession({ implementationPrompt });
  if (!startResult.ok) {
    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "session_start_failed", message: startResult.error ?? "Session start failed" },
      durationMs: Date.now() - startTime,
      completedAt: new Date().toISOString(),
    };
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return;
  }

  // Start session monitor
  const actorState = actor.getStatus().state!;
  const monitor = new SessionMonitor({
    sessionId,
    taskId: task.id,
    actorState,
    daprClient,
    pool,
    onComplete: (_result) => {
      activeMonitors.delete(sessionId);
    },
  });

  activeMonitors.set(sessionId, monitor);
  monitor.start();

  console.log(`[${AGENT_ID}] Session ${sessionId} started for task ${task.id}`);
}

// --- Lifecycle ---
let heartbeatInterval: Timer | null = null;

async function start(): Promise<void> {
  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  heartbeatInterval = setInterval(async () => {
    try {
      await registry.heartbeat(AGENT_ID);
    } catch (err) {
      console.error(`[${AGENT_ID}] Heartbeat failed:`, err);
    }
  }, 30_000);

  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);

  // Stop all terminal streams
  await shutdownAllStreams(pool).catch((err) =>
    console.error(`[${AGENT_ID}] Failed to shutdown streams:`, err)
  );

  // Stop all active monitors
  for (const monitor of activeMonitors.values()) {
    monitor.stop();
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  try {
    await registry.markOffline(AGENT_ID);
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to mark offline:`, err);
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error(`[${AGENT_ID}] Failed to start:`, err);
  process.exit(1);
});
