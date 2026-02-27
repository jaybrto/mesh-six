import { Hono } from "hono";
import { Pool } from "pg";
import { WorkflowRuntime, DaprWorkflowClient } from "@dapr/dapr";
import {
  APP_PORT,
  AGENT_ID,
  DATABASE_URL,
} from "./config.js";
import { insertRun, getRun } from "./db.js";
import { OnboardProjectRequestSchema, AuthCallbackSchema } from "./schemas.js";
import {
  createWorkflowRuntime,
  createWorkflowClient,
  startOnboardingWorkflow,
  raiseOnboardingEvent,
  type OnboardingWorkflowInput,
} from "./workflow.js";
import { startMcpStdio } from "./mcp.js";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: DATABASE_URL });

const app = new Hono();

let workflowRuntime: WorkflowRuntime | null = null;
let workflowClient: DaprWorkflowClient | null = null;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    workflowEnabled: workflowRuntime !== null && workflowClient !== null,
  })
);

app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription — onboarding-service has no pub/sub topics
app.get("/dapr/subscribe", (c) => c.json([]));

// POST /onboard — start a new onboarding run
app.post("/onboard", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = OnboardProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    if (!workflowClient) {
      return c.json({ error: "Workflow client not initialized" }, 503);
    }

    const runId = crypto.randomUUID();
    await insertRun(pool, {
      id: runId,
      repoOwner: parsed.data.repoOwner,
      repoName: parsed.data.repoName,
    });

    const workflowInput: OnboardingWorkflowInput = {
      ...parsed.data,
      runId,
    };

    await startOnboardingWorkflow(workflowClient, workflowInput, runId);

    console.log(`[${AGENT_ID}] Started onboarding run ${runId} for ${parsed.data.repoOwner}/${parsed.data.repoName}`);

    return c.json({ runId, status: "pending" }, 202);
  } catch (err) {
    console.error(`[${AGENT_ID}] POST /onboard failed:`, err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /onboard/:id — get run status
app.get("/onboard/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const run = await getRun(pool, id);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json(run);
  } catch (err) {
    console.error(`[${AGENT_ID}] GET /onboard/:id failed:`, err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /onboard/:id/auth-callback — submit OAuth tokens after device flow
app.post("/onboard/:id/auth-callback", async (c) => {
  try {
    const id = c.req.param("id");
    const run = await getRun(pool, id);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    if (run.status !== "waiting_auth") {
      return c.json({ error: `Run is not waiting for auth (current status: ${run.status})` }, 409);
    }

    const body = await c.req.json();
    const parsed = AuthCallbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    if (!workflowClient) {
      return c.json({ error: "Workflow client not initialized" }, 503);
    }

    await raiseOnboardingEvent(workflowClient, id, "oauth-code-received", parsed.data);

    console.log(`[${AGENT_ID}] OAuth callback received for run ${id}`);

    return c.json({ status: "resumed" });
  } catch (err) {
    console.error(`[${AGENT_ID}] POST /onboard/:id/auth-callback failed:`, err);
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  console.log(`[${AGENT_ID}] Initializing Dapr Workflow runtime...`);

  try {
    workflowRuntime = createWorkflowRuntime(pool);
    await workflowRuntime.start().catch((err: Error) => {
      throw err;
    });
    // Suppress async gRPC stream errors
    (workflowRuntime as any).on?.("error", (err: Error) => {
      console.warn(`[${AGENT_ID}] Workflow runtime stream error (continuing without workflow):`, err.message);
      workflowRuntime = null;
      workflowClient = null;
    });
    console.log(`[${AGENT_ID}] Workflow runtime started`);

    workflowClient = createWorkflowClient();
    console.log(`[${AGENT_ID}] Workflow client initialized`);
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to initialize workflow runtime:`, err);
    workflowRuntime = null;
    workflowClient = null;
  }

  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);

  if (workflowRuntime) {
    try {
      await workflowRuntime.stop();
      console.log(`[${AGENT_ID}] Workflow runtime stopped`);
    } catch (err) {
      console.error(`[${AGENT_ID}] Failed to stop workflow runtime:`, err);
    }
  }

  try {
    await pool.end();
    console.log(`[${AGENT_ID}] Database pool closed`);
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to close database pool:`, err);
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Catch async gRPC stream errors from @dapr/durabletask-js WorkflowRuntime.
// These occur when the Dapr runtime version doesn't fully support the Workflow gRPC API.
process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  if (msg.includes("UNIMPLEMENTED") || msg.includes("grpc") || msg.includes("durabletask")) {
    console.warn(`[${AGENT_ID}] Workflow gRPC error (Dapr runtime/SDK version mismatch) — continuing in non-workflow mode:`, msg.slice(0, 200));
    workflowRuntime = null;
    workflowClient = null;
  } else {
    console.error(`[${AGENT_ID}] Unhandled rejection:`, reason);
    process.exit(1);
  }
});

// Entry point — MCP stdio mode vs HTTP server mode
if (process.argv.includes("--mcp")) {
  startMcpStdio(pool);
} else {
  start().catch((err) => {
    console.error(`[${AGENT_ID}] Failed to start:`, err);
    process.exit(1);
  });
}
