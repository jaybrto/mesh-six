/**
 * Mac Mini Scraper Service
 *
 * A stateless, headless RPA worker running on a standalone Mac mini.
 * Receives scrape commands via Dapr Service Invocation, drives the
 * Windsurf IDE or Gemini web UI via Playwright, and reports results
 * back through MinIO claim-check files and Dapr workflow external events.
 */

// Initialize OpenTelemetry BEFORE any other imports
import { initTelemetry } from "@mesh-six/core";

const telemetryConfig = {
  serviceName: "scraper-service",
  serviceVersion: "0.1.0",
  otlpEndpoint:
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
};

// Spec mandates OTel across all services. Always init, but warn if using default endpoint.
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.warn(
    "[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry will attempt default endpoint (http://localhost:4318). " +
    "Set OTEL_EXPORTER_OTLP_ENDPOINT explicitly or set OTEL_DISABLED=true to suppress this warning.",
  );
}
if (process.env.OTEL_DISABLED !== "true") {
  initTelemetry(telemetryConfig);
}

import { Hono } from "hono";
import {
  createMinioClient,
  ScrapeDispatchPayloadSchema,
  type ScrapeDispatchPayload,
} from "@mesh-six/core";
import { config } from "./config.js";
import {
  markInProgress,
  markCompleted,
  markFailed,
  markCallbackError,
  uploadResult,
} from "./minio-lifecycle.js";
import { raiseScrapeCompleted } from "./dapr-events.js";
import { executeWindsurf } from "./providers/windsurf.js";
import { executeGeminiWeb } from "./providers/gemini-web.js";

// --- MinIO S3 Client ---
const s3 = createMinioClient({
  endpoint: config.MINIO_ENDPOINT,
  region: config.MINIO_REGION,
  accessKeyId: config.MINIO_ACCESS_KEY,
  secretAccessKey: config.MINIO_SECRET_KEY,
  bucket: config.MINIO_BUCKET,
});

// Single-flight concurrency control: the Mac mini is a single interactive
// desktop target — parallel sessions interfere with UI state.
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS) || 1;
const activeTasks = new Set<string>();

// --- HTTP Server ---
const app = new Hono();

// Health check
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    service: config.SERVICE_ID,
    activeTasks: activeTasks.size,
    activeTaskIds: [...activeTasks],
  }),
);

// Readiness probe — validates required config and dependencies
app.get("/readyz", async (c) => {
  const checks: Record<string, string> = {};

  // Check required MinIO credentials
  if (!config.MINIO_ACCESS_KEY || !config.MINIO_SECRET_KEY) {
    checks.minio = "missing credentials";
  } else {
    checks.minio = "ok";
  }

  // Check K3S Dapr URL is explicitly configured
  if (!process.env.K3S_DAPR_URL) {
    checks.daprCallback = "using default (localhost:3500) — may not reach k3s";
  } else {
    checks.daprCallback = "ok";
  }

  const hasFailures = Object.values(checks).some(
    (v) => v !== "ok" && v.startsWith("missing"),
  );

  return c.json(
    { status: hasFailures ? "not_ready" : "ok", checks },
    hasFailures ? 503 : 200,
  );
});

/**
 * POST /scrape — Receive a scrape dispatch from the k3s ResearcherActor.
 *
 * Fast-ACK pattern: validates the payload, returns 200 immediately,
 * and processes the scrape asynchronously in the background.
 */
app.post("/scrape", async (c) => {
  // Enforce body size limit
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > config.MAX_BODY_SIZE) {
    return c.json(
      {
        status: "REJECTED",
        taskId: "unknown",
        message: `Request body too large (${contentLength} bytes, max ${config.MAX_BODY_SIZE})`,
      },
      413,
    );
  }

  const body = await c.req.json();
  const parsed = ScrapeDispatchPayloadSchema.safeParse(body);

  if (!parsed.success) {
    console.error("[scraper] Invalid payload:", parsed.error.issues);
    return c.json(
      {
        status: "REJECTED",
        taskId: body.taskId || "unknown",
        message: `Validation failed: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      },
      400,
    );
  }

  const payload = parsed.data;

  // Reject duplicate taskId
  if (activeTasks.has(payload.taskId)) {
    return c.json(
      {
        status: "REJECTED",
        taskId: payload.taskId,
        message: "Task already in progress",
      },
      409,
    );
  }

  // Enforce single-flight concurrency
  if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
    console.warn(
      `[scraper] At capacity (${activeTasks.size}/${MAX_CONCURRENT_TASKS}), rejecting task ${payload.taskId}`,
    );
    return c.json(
      {
        status: "REJECTED",
        taskId: payload.taskId,
        message: `At capacity (${activeTasks.size}/${MAX_CONCURRENT_TASKS} tasks running)`,
      },
      429,
    );
  }

  console.log(
    `[scraper] Received task ${payload.taskId} — provider: ${payload.targetProvider}`,
  );

  // Fast-ACK: return immediately, process in background
  activeTasks.add(payload.taskId);
  processTask(payload).catch((err) => {
    console.error(`[scraper] Unhandled error in task ${payload.taskId}:`, err);
  });

  return c.json({ status: "STARTED", taskId: payload.taskId });
});

/**
 * Background task processor.
 * Drives the appropriate provider, manages MinIO status lifecycle,
 * and raises the Dapr external event on completion.
 */
async function processTask(payload: ScrapeDispatchPayload): Promise<void> {
  const { taskId, targetProvider, prompt, minioFolderPath } = payload;
  const startTime = Date.now();
  let scrapeSucceeded = false;
  let resultPath = `${minioFolderPath}/result.md`;

  try {
    // 1. Mark IN_PROGRESS in MinIO
    await markInProgress(
      s3,
      config.MINIO_BUCKET,
      minioFolderPath,
      taskId,
      targetProvider,
    );

    // 2. Execute the scrape via the appropriate provider
    let markdown: string;

    switch (targetProvider) {
      case "windsurf":
        markdown = await executeWindsurf(taskId, prompt);
        break;
      case "gemini":
        markdown = await executeGeminiWeb(taskId, prompt);
        break;
      default:
        throw new Error(`Unknown provider: ${targetProvider}`);
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[scraper] Task ${taskId} completed in ${(durationMs / 1_000).toFixed(1)}s (${markdown.length} chars)`,
    );

    // 3. Upload result.md to MinIO
    resultPath = await uploadResult(
      s3,
      config.MINIO_BUCKET,
      minioFolderPath,
      markdown,
    );

    // 4. Mark COMPLETED in MinIO
    await markCompleted(
      s3,
      config.MINIO_BUCKET,
      minioFolderPath,
      taskId,
      targetProvider,
    );

    scrapeSucceeded = true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[scraper] Task ${taskId} failed:`, errorMsg);

    // Mark FAILED in MinIO (best-effort) — only if the scrape itself failed,
    // not if just the callback failed (see below).
    await markFailed(
      s3,
      config.MINIO_BUCKET,
      minioFolderPath,
      taskId,
      targetProvider,
      errorMsg,
    ).catch((e) => console.error("[scraper] Failed to update MinIO status:", e));
  }

  // 5. Raise the Dapr workflow event — separated from the try/catch above so
  //    a callback failure never overwrites a legitimate COMPLETED status.json.
  try {
    await raiseScrapeCompleted(taskId, {
      minioResultPath: resultPath,
      success: scrapeSucceeded,
      ...(!scrapeSucceeded ? { error: "Scrape execution failed" } : {}),
    });
  } catch (callbackErr) {
    const msg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
    console.error(`[scraper] Failed to raise completion event for ${taskId}: ${msg}`);

    if (scrapeSucceeded) {
      // Scrape worked but we couldn't notify the workflow. Append a callbackError
      // to status.json without changing the COMPLETED status.
      await markCallbackError(
        s3,
        config.MINIO_BUCKET,
        minioFolderPath,
        msg,
      ).catch((e) =>
        console.error("[scraper] Failed to record callback error:", e),
      );
    }
  } finally {
    activeTasks.delete(taskId);
  }
}

// --- Start ---
const server = Bun.serve({ port: config.APP_PORT, fetch: app.fetch });
console.log(`[scraper] Listening on port ${config.APP_PORT}`);
console.log(`[scraper] MinIO: ${config.MINIO_ENDPOINT}/${config.MINIO_BUCKET}`);
console.log(`[scraper] Dapr: ${config.K3S_DAPR_URL} (workflow: ${config.DAPR_WORKFLOW_NAME})`);
console.log(`[scraper] OTEL: ${config.OTEL_ENDPOINT}`);
console.log(`[scraper] Concurrency: max ${MAX_CONCURRENT_TASKS} task(s)`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log(`[scraper] Shutting down... (${activeTasks.size} tasks in flight)`);
  if (activeTasks.size > 0) {
    console.log(
      "[scraper] Warning: Abandoning in-flight tasks:",
      [...activeTasks],
    );
  }
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
