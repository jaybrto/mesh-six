import { Hono } from "hono";
import {
  ChatCompletionRequestSchema,
  type LLMServiceStatus,
} from "@mesh-six/core";
import type { ActorRuntime } from "./actor-runtime.js";
import type { ActorRouter } from "./router.js";
import {
  AGENT_ID,
  ALLOWED_MODELS,
  DAPR_ACTOR_CONFIG,
  ACTOR_TYPE,
} from "./config.js";

const startTime = Date.now();

export function createApp(
  runtime: ActorRuntime,
  router: ActorRouter,
): Hono {
  const app = new Hono();

  let totalRequests = 0;
  let totalErrors = 0;

  // ===========================================================================
  // HEALTH ENDPOINTS
  // ===========================================================================

  app.get("/healthz", (c) => {
    const summary = router.getSummary();
    return c.json({
      status: summary.unhealthy < summary.total ? "ok" : "unhealthy",
      agent: AGENT_ID,
      actors: summary,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  app.get("/readyz", (c) => {
    const summary = router.getSummary();
    const ready = summary.idle > 0 || summary.busy > 0;
    return c.json({ ready }, ready ? 200 : 503);
  });

  // ===========================================================================
  // DAPR ACTOR PROTOCOL
  // ===========================================================================

  /** Return registered actor types to the Dapr sidecar */
  app.get("/dapr/config", (c) => {
    return c.json(DAPR_ACTOR_CONFIG);
  });

  /** Activate an actor (Dapr sidecar → app) */
  app.put("/actors/:actorType/:actorId", async (c) => {
    const { actorType, actorId } = c.req.param();
    try {
      await runtime.activate(actorType, actorId);
      // Refresh router's status cache
      await router.refreshActorStatus(actorId);
      return c.body(null, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${AGENT_ID}] Actor activation failed: ${msg}`);
      return c.json({ error: msg }, 500);
    }
  });

  /** Deactivate an actor (Dapr sidecar → app) */
  app.delete("/actors/:actorType/:actorId", async (c) => {
    const { actorType, actorId } = c.req.param();
    try {
      await runtime.deactivate(actorType, actorId);
      return c.body(null, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${AGENT_ID}] Actor deactivation failed: ${msg}`);
      return c.json({ error: msg }, 500);
    }
  });

  /** Invoke an actor method (Dapr sidecar → app) */
  app.put("/actors/:actorType/:actorId/method/:method", async (c) => {
    const { actorType, actorId, method } = c.req.param();
    try {
      const payload = await c.req.json().catch(() => null);
      const result = await runtime.invoke(actorType, actorId, method, payload);
      return c.json(result as object);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${AGENT_ID}] Actor invoke failed (${method}): ${msg}`);
      return c.json({ error: msg }, 500);
    }
  });

  /** Timer callback (Dapr sidecar → app) */
  app.put(
    "/actors/:actorType/:actorId/method/timer/:timerName",
    async (c) => {
      const { actorType, actorId, timerName } = c.req.param();
      try {
        await runtime.timer(actorType, actorId, timerName);
        return c.body(null, 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${AGENT_ID}] Timer ${timerName} failed: ${msg}`);
        return c.json({ error: msg }, 500);
      }
    },
  );

  /** Reminder callback (Dapr sidecar → app) */
  app.put(
    "/actors/:actorType/:actorId/method/remind/:reminderName",
    async (c) => {
      const { actorType, actorId, reminderName } = c.req.param();
      try {
        const payload = await c.req.json().catch(() => null);
        await runtime.reminder(actorType, actorId, reminderName, payload);
        return c.body(null, 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${AGENT_ID}] Reminder ${reminderName} failed: ${msg}`);
        return c.json({ error: msg }, 500);
      }
    },
  );

  // ===========================================================================
  // OPENAI-COMPATIBLE API
  // ===========================================================================

  /**
   * POST /v1/chat/completions
   *
   * OpenAI-compatible chat completion endpoint.
   * Routes to an available ClaudeCLIActor and returns the response.
   */
  app.post("/v1/chat/completions", async (c) => {
    totalRequests++;

    const body = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(body);

    if (!parsed.success) {
      totalErrors++;
      return c.json(
        {
          error: {
            message: `Invalid request: ${parsed.error.message}`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const result = await router.route(parsed.data);

    if (result.status !== 200) {
      totalErrors++;
    }

    return c.json(result.body, result.status as 200);
  });

  // ===========================================================================
  // SERVICE STATUS
  // ===========================================================================

  /** GET /status — detailed service status */
  app.get("/status", (c) => {
    const actors = router.getAllStatuses();
    const summary = router.getSummary();

    const status: LLMServiceStatus = {
      status:
        summary.unhealthy === summary.total
          ? "unavailable"
          : summary.unhealthy > 0
            ? "degraded"
            : "healthy",
      actors,
      allowedModels: ALLOWED_MODELS,
      totalRequests,
      totalErrors,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };

    return c.json(status);
  });

  /** GET /v1/models — list available models (OpenAI-compatible) */
  app.get("/v1/models", (c) => {
    return c.json({
      object: "list",
      data: ALLOWED_MODELS.map((id) => ({
        id,
        object: "model",
        created: Math.floor(startTime / 1000),
        owned_by: "anthropic",
      })),
    });
  });

  return app;
}
