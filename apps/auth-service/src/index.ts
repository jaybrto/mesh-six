import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import {
  AUTH_SERVICE_APP_ID,
  DAPR_PUBSUB_NAME,
  type DaprSubscription,
} from "@mesh-six/core";
import { APP_PORT, DAPR_HOST, DAPR_HTTP_PORT } from "./config.js";
import { pool, checkDb } from "./db.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createCredentialsRouter } from "./routes/credentials.js";
import { createProvisionRouter } from "./routes/provision.js";
import { startRefreshTimer } from "./refresh-timer.js";

// -------------------------------------------------------------------------
// Dapr client
// -------------------------------------------------------------------------

const daprClient = new DaprClient({
  daprHost: DAPR_HOST,
  daprPort: String(DAPR_HTTP_PORT),
});

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

const app = new Hono();

// Health endpoint — checks DB connectivity
app.get("/healthz", async (c) => {
  try {
    await checkDb();
    return c.json({ status: "ok", service: AUTH_SERVICE_APP_ID });
  } catch (err) {
    console.error("[auth-service] healthz DB check failed:", err);
    return c.json({ status: "error", service: AUTH_SERVICE_APP_ID, error: String(err) }, 503);
  }
});

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription endpoint
app.get("/dapr/subscribe", (c): Response => {
  // auth-service does not subscribe to any topics itself
  const subscriptions: DaprSubscription[] = [];
  return c.json(subscriptions);
});

// Mount routes
const projectsRouter = createProjectsRouter(pool, daprClient);
const credentialsRouter = createCredentialsRouter(pool, daprClient);
const provisionRouter = createProvisionRouter(pool);

app.route("/projects", projectsRouter);
app.route("/projects", credentialsRouter);
app.route("/projects", provisionRouter);

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

let stopRefreshTimer: (() => void) | null = null;

async function start(): Promise<void> {
  // Verify DB connectivity
  await checkDb();
  console.log("[auth-service] DB connection verified");

  // Start background credential refresh timer
  stopRefreshTimer = startRefreshTimer(pool, daprClient);

  // Start HTTP server
  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[auth-service] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log("[auth-service] Shutting down...");

  if (stopRefreshTimer) {
    stopRefreshTimer();
  }

  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error("[auth-service] Failed to start:", err);
  process.exit(1);
});
