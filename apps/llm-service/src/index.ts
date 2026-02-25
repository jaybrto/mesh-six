import { createApp } from "./app.js";
import { ActorRuntime } from "./actor-runtime.js";
import { ActorRouter } from "./router.js";
import { createClaudeCLIActor } from "./claude-cli-actor.js";
import { AGENT_ID, APP_PORT, ACTOR_TYPE, MAX_ACTORS } from "./config.js";
import { DAPR_PUBSUB_NAME, CREDENTIAL_REFRESHED_TOPIC } from "@mesh-six/core";

const log = (msg: string) => console.log(`[${AGENT_ID}] ${msg}`);

// ============================================================================
// SETUP
// ============================================================================

// Create actor runtime with ClaudeCLIActor factory
const runtime = new ActorRuntime(ACTOR_TYPE, createClaudeCLIActor);

// Create actor router
const router = new ActorRouter(runtime);

// Create Hono app
const app = createApp(runtime, router);

// ============================================================================
// DAPR PUB/SUB SUBSCRIPTION
// ============================================================================

app.get("/dapr/subscribe", (c) => {
  return c.json([
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: CREDENTIAL_REFRESHED_TOPIC,
      route: "/events/credential-refreshed",
    },
  ]);
});

app.post("/events/credential-refreshed", async (c) => {
  log("[llm-service] Credential refreshed event received");
  return c.json({ status: "SUCCESS" });
});

// ============================================================================
// START SERVER
// ============================================================================

Bun.serve({ port: APP_PORT, fetch: app.fetch });
log(`Listening on port ${APP_PORT}`);
log(`Actor type: ${ACTOR_TYPE}, max actors: ${MAX_ACTORS}`);

// Initial actor status refresh (actors are activated by the Dapr sidecar)
setTimeout(async () => {
  try {
    await router.refreshAllStatuses();
    const summary = router.getSummary();
    log(`Actor status: ${summary.idle} idle, ${summary.busy} busy, ${summary.unhealthy} unhealthy`);
  } catch {
    log("Could not refresh actor statuses (Dapr sidecar may not be ready)");
  }
}, 5_000);

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`);

  // Deactivate all actors (triggers credential sync)
  const activeActors = runtime.getActiveActors();
  for (const key of activeActors) {
    const [actorType, actorId] = key.split(":");
    try {
      await runtime.deactivate(actorType, actorId);
    } catch (err) {
      log(`Failed to deactivate ${key}: ${err}`);
    }
  }

  log("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
