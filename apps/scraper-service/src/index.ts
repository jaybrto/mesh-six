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

// Only init telemetry if endpoint is reachable (standalone Mac mini may not have collector)
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
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
  uploadResult,
} from "./minio-lifecycle.js";
import { raiseScrapeCompleted } from "./dapr-events.js";
import { executeWindsurf } from "./providers/windsurf.js";
import { executeClaudeWeb } from "./providers/claude-web.js";

// --- MinIO S3 Client ---
const s3 = createMinioClient({
  endpoint: config.MINIO_ENDPOINT,
  region: config.MINIO_REGION,
  accessKeyId: config.MINIO_ACCESS_KEY,
  secretAccessKey: config.MINIO_SECRET_KEY,
  bucket: config.MINIO_BUCKET,
});

// Track in-flight tasks to prevent duplicate processing
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

// Readiness probe
app.get("/readyz", (c) => c.json({ status: "ok" }));

/**
 * POST /scrape — Receive a scrape dispatch from the k3s ResearcherActor.
 *
 * Fast-ACK pattern: validates the payload, returns 200 immediately,
 * and processes the scrape asynchronously in the background.
 */
app.post("/scrape", async (c) => {
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

  // Reject if already processing this task
  if (activeTasks.has(payload.taskId)) {
    return c.json({
      status: "REJECTED",
      taskId: payload.taskId,
      message: "Task already in progress",
    });
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
      case "claude":
        markdown = await executeClaudeWeb(taskId, prompt);
        break;
      default:
        throw new Error(`Unknown provider: ${targetProvider}`);
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[scraper] Task ${taskId} completed in ${(durationMs / 1_000).toFixed(1)}s (${markdown.length} chars)`,
    );

    // 3. Upload result.md to MinIO
    const resultPath = await uploadResult(
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

    // 5. Raise ScrapeCompleted event on k3s Dapr Workflow
    await raiseScrapeCompleted(taskId, {
      minioResultPath: resultPath,
      success: true,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[scraper] Task ${taskId} failed:`, errorMsg);

    // Mark FAILED in MinIO (best-effort)
    await markFailed(
      s3,
      config.MINIO_BUCKET,
      minioFolderPath,
      taskId,
      targetProvider,
      errorMsg,
    ).catch((e) => console.error("[scraper] Failed to update MinIO status:", e));

    // Still raise the event so the workflow can handle the failure
    await raiseScrapeCompleted(taskId, {
      minioResultPath: `${minioFolderPath}/result.md`,
      success: false,
      error: errorMsg,
    }).catch((e) =>
      console.error("[scraper] Failed to raise completion event:", e),
    );
  } finally {
    activeTasks.delete(taskId);
  }
}

// --- Start ---
Bun.serve({ port: config.APP_PORT, fetch: app.fetch });
console.log(`[scraper] Listening on port ${config.APP_PORT}`);
console.log(`[scraper] MinIO: ${config.MINIO_ENDPOINT}/${config.MINIO_BUCKET}`);
console.log(`[scraper] Dapr: ${config.K3S_DAPR_URL}`);
console.log(`[scraper] OTEL: ${config.OTEL_ENDPOINT}`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log(`[scraper] Shutting down... (${activeTasks.size} tasks in flight)`);
  if (activeTasks.size > 0) {
    console.log(
      "[scraper] Warning: Abandoning in-flight tasks:",
      [...activeTasks],
    );
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
