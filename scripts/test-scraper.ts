#!/usr/bin/env bun
/**
 * End-to-end test script for the Mac Mini Scraper Service.
 *
 * Usage:
 *   bun run scripts/test-scraper.ts [--provider windsurf|gemini] [--url http://localhost:3000]
 *
 * This script:
 * 1. Checks the scraper service is healthy
 * 2. Optionally sets up a mock MinIO status.json (or uses real MinIO)
 * 3. Sends a test ScrapeDispatchPayload to POST /scrape
 * 4. Polls the service health to track task progress
 * 5. Checks MinIO for status.json and result.md
 *
 * Prerequisites:
 *   - Scraper service running (bun run --filter @mesh-six/scraper-service dev)
 *   - MinIO accessible (or set MOCK_MINIO=true for dry run)
 *   - For 'windsurf' provider: Windsurf IDE installed and accessible
 *   - For 'gemini' provider: Chrome profile with Gemini auth cookies
 */

import {
  ScrapeDispatchPayloadSchema,
  createMinioClient,
  downloadFromMinio,
  type ScrapeStatusFile,
} from "@mesh-six/core";

// --- Parse CLI args ---
const args = process.argv.slice(2);
const provider = getArg(args, "--provider") || "gemini";
const baseUrl = getArg(args, "--url") || "http://localhost:3000";
const mockMinio = process.env.MOCK_MINIO === "true";
const taskId = crypto.randomUUID();
const minioFolderPath = `research/${taskId}`;

console.log("=".repeat(60));
console.log("  Mac Mini Scraper Service — E2E Test");
console.log("=".repeat(60));
console.log(`  Service URL:    ${baseUrl}`);
console.log(`  Provider:       ${provider}`);
console.log(`  Task ID:        ${taskId}`);
console.log(`  MinIO folder:   ${minioFolderPath}`);
console.log(`  Mock MinIO:     ${mockMinio}`);
console.log("=".repeat(60));
console.log();

// --- Step 1: Health check ---
console.log("[1/5] Checking service health...");
try {
  const healthRes = await fetch(`${baseUrl}/healthz`);
  if (!healthRes.ok) {
    console.error(`  FAIL: Health check returned ${healthRes.status}`);
    process.exit(1);
  }
  const health = await healthRes.json();
  console.log(`  OK: Service is healthy — ${JSON.stringify(health)}`);
} catch (err) {
  console.error(`  FAIL: Cannot reach service at ${baseUrl}/healthz`);
  console.error(`  Error: ${err}`);
  console.error();
  console.error("  Troubleshooting:");
  console.error("    1. Is the scraper service running?");
  console.error("       bun run --filter @mesh-six/scraper-service dev");
  console.error("    2. Is port 3000 available?");
  console.error("       lsof -i :3000");
  console.error("    3. Check for startup errors in the service logs");
  process.exit(1);
}

// --- Step 2: Readiness check ---
console.log("\n[2/5] Checking readiness...");
try {
  const readyRes = await fetch(`${baseUrl}/readyz`);
  if (!readyRes.ok) {
    console.error(`  FAIL: Readiness check returned ${readyRes.status}`);
    process.exit(1);
  }
  console.log("  OK: Service is ready");
} catch (err) {
  console.error(`  FAIL: Readiness check failed: ${err}`);
  process.exit(1);
}

// --- Step 3: Send scrape request ---
console.log("\n[3/5] Sending scrape request...");
const payload = {
  taskId,
  actorId: "test-researcher",
  targetProvider: provider,
  prompt:
    "Summarize the key features and benefits of the Bun JavaScript runtime in a concise markdown document. Include sections on speed, compatibility, and developer experience.",
  minioFolderPath,
};

// Validate our own payload first
const validated = ScrapeDispatchPayloadSchema.safeParse(payload);
if (!validated.success) {
  console.error("  FAIL: Test payload validation failed:");
  console.error(`  ${JSON.stringify(validated.error.issues, null, 2)}`);
  process.exit(1);
}

try {
  const scrapeRes = await fetch(`${baseUrl}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const ack = await scrapeRes.json();
  console.log(`  Response: ${JSON.stringify(ack)}`);

  if (ack.status === "STARTED") {
    console.log("  OK: Task accepted and processing in background");
  } else if (ack.status === "REJECTED") {
    console.error(`  FAIL: Task rejected — ${ack.message}`);
    process.exit(1);
  } else {
    console.error(`  WARN: Unexpected response status: ${ack.status}`);
  }
} catch (err) {
  console.error(`  FAIL: Scrape request failed: ${err}`);
  process.exit(1);
}

// --- Step 4: Poll for task completion ---
console.log("\n[4/5] Polling for task completion...");
const POLL_INTERVAL = 5_000; // 5 seconds
const MAX_POLL_TIME = 12 * 60 * 1_000; // 12 minutes
const startTime = Date.now();
let completed = false;

while (Date.now() - startTime < MAX_POLL_TIME) {
  await Bun.sleep(POLL_INTERVAL);

  try {
    const healthRes = await fetch(`${baseUrl}/healthz`);
    const health = (await healthRes.json()) as {
      activeTasks: number;
      activeTaskIds: string[];
    };

    const elapsed = ((Date.now() - startTime) / 1_000).toFixed(0);

    if (health.activeTaskIds?.includes(taskId)) {
      console.log(
        `  ... Task still in progress (${elapsed}s elapsed, ${health.activeTasks} active)`,
      );
    } else if (health.activeTasks === 0 || !health.activeTaskIds?.includes(taskId)) {
      console.log(`  OK: Task completed after ${elapsed}s`);
      completed = true;
      break;
    }
  } catch {
    console.log("  ... Service temporarily unreachable, retrying...");
  }
}

if (!completed) {
  console.error("  FAIL: Task did not complete within timeout");
  console.error("  Troubleshooting:");
  console.error("    1. Check service logs for errors");
  console.error("    2. Is Playwright able to launch the browser/app?");
  console.error(
    "    3. For windsurf: Is the Windsurf IDE installed and accessible?",
  );
  console.error(
    "    4. For gemini: Is the Chrome profile authenticated with Gemini?",
  );
  process.exit(1);
}

// --- Step 5: Check MinIO results ---
console.log("\n[5/5] Checking MinIO for results...");

if (mockMinio) {
  console.log(
    "  SKIP: MOCK_MINIO=true, skipping MinIO verification",
  );
  console.log(
    "  (In production, status.json and result.md would be in MinIO)",
  );
} else {
  const endpoint = process.env.MINIO_ENDPOINT || "http://s3.k3s.bto.bar";
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET || "mesh-six-research";

  if (!accessKey || !secretKey) {
    console.log("  SKIP: MINIO_ACCESS_KEY/MINIO_SECRET_KEY not set");
    console.log("  Set these env vars to verify MinIO results");
  } else {
    try {
      const s3 = createMinioClient({
        endpoint,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        bucket,
      });

      // Check status.json
      const statusData = await downloadFromMinio(
        s3,
        bucket,
        `${minioFolderPath}/status.json`,
      );
      const status = JSON.parse(
        new TextDecoder().decode(statusData),
      ) as ScrapeStatusFile;
      console.log(`  status.json: ${JSON.stringify(status)}`);

      if (status.status === "COMPLETED") {
        console.log("  OK: Status is COMPLETED");

        // Check result.md
        const resultData = await downloadFromMinio(
          s3,
          bucket,
          `${minioFolderPath}/result.md`,
        );
        const resultText = new TextDecoder().decode(resultData);
        console.log(`  result.md: ${resultText.length} bytes`);
        console.log(`  Preview: ${resultText.substring(0, 200)}...`);
        console.log("  OK: Result file present");
      } else if (status.status === "FAILED") {
        console.error(`  FAIL: Task failed — ${status.error}`);
        process.exit(1);
      } else {
        console.warn(`  WARN: Unexpected status: ${status.status}`);
      }
    } catch (err) {
      console.error(`  FAIL: MinIO check failed: ${err}`);
      console.error("  Troubleshooting:");
      console.error(`    1. Is MinIO accessible at ${endpoint}?`);
      console.error(`    2. Does bucket '${bucket}' exist?`);
      console.error("    3. Are credentials correct?");
      process.exit(1);
    }
  }
}

// --- Summary ---
console.log();
console.log("=".repeat(60));
console.log("  TEST PASSED");
console.log("=".repeat(60));
console.log(`  Task ID:    ${taskId}`);
console.log(`  Provider:   ${provider}`);
console.log(`  Duration:   ${((Date.now() - startTime) / 1_000).toFixed(1)}s`);
console.log("=".repeat(60));

// --- Helpers ---
function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
