#!/usr/bin/env bun
/**
 * Test script for the Research & Plan sub-workflow.
 *
 * Usage:
 *   bun run scripts/test-research-workflow.ts [--mode triage|dispatch|review|full]
 *
 * Modes:
 *   triage   — Test triage activity only (LLM call)
 *   dispatch — Test dispatch + claim check (MinIO write)
 *   review   — Test review activity (MinIO read + LLM)
 *   full     — Start a full sub-workflow via Dapr Workflow API
 *
 * Environment:
 *   LITELLM_BASE_URL   — LiteLLM proxy (default: http://litellm.litellm:4000/v1)
 *   LITELLM_API_KEY    — LiteLLM API key (default: sk-local)
 *   DATABASE_URL       — PostgreSQL connection string
 *   MINIO_ENDPOINT     — MinIO endpoint (default: http://minio.minio:9000)
 *   MINIO_ACCESS_KEY   — MinIO access key
 *   MINIO_SECRET_KEY   — MinIO secret key
 *   DAPR_HOST          — Dapr sidecar host (default: localhost)
 *   DAPR_HTTP_PORT     — Dapr sidecar HTTP port (default: 3500)
 */

import { Pool } from "pg";
import {
  chatCompletionWithSchema,
  chatCompletion,
  createMinioClient,
  writeResearchStatus,
  readResearchStatus,
  uploadRawResearch,
  downloadRawResearch,
  uploadCleanResearch,
  downloadCleanResearch,
  TriageOutputSchema,
  ReviewResearchOutputSchema,
  ARCHITECT_TRIAGE_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  ARCHITECT_DRAFT_PLAN_PROMPT,
  RESEARCH_BUCKET,
} from "@mesh-six/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const mode = process.argv[2]?.replace("--mode=", "").replace("--mode", "").trim() || "triage";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.minio:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";
const LLM_MODEL_PRO = process.env.LLM_MODEL_PRO || "gemini-1.5-pro";
const LLM_MODEL_FLASH = process.env.LLM_MODEL_FLASH || "gemini-1.5-flash";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

const taskId = `test-${Date.now()}`;
const bucket = process.env.RESEARCH_BUCKET || RESEARCH_BUCKET;

console.log(`\n🔬 Research Workflow Test — mode: ${mode}, taskId: ${taskId}\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestMinioClient() {
  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.error("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required for MinIO operations");
    process.exit(1);
  }
  return createMinioClient({
    endpoint: MINIO_ENDPOINT,
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
    bucket,
  });
}

function createTestPool(): Pool | null {
  if (!DATABASE_URL) {
    console.warn("DATABASE_URL not set — skipping database operations");
    return null;
  }
  return new Pool({ connectionString: DATABASE_URL });
}

// ---------------------------------------------------------------------------
// Test: Triage
// ---------------------------------------------------------------------------

async function testTriage() {
  console.log("--- Testing Architect Triage ---\n");

  const issueContext = `
Issue #99: Add WebSocket support to the dashboard

We need real-time updates in the dashboard without polling.
The current MQTT over WebSocket approach works for terminal streaming,
but we need a more general-purpose solution for agent status updates.

Consider using the existing RabbitMQ MQTT plugin or evaluating
alternatives like Server-Sent Events.
  `.trim();

  console.log("Sending triage request to LLM...");

  const result = await chatCompletionWithSchema({
    model: LLM_MODEL_PRO,
    schema: TriageOutputSchema,
    system: ARCHITECT_TRIAGE_PROMPT,
    prompt: issueContext,
    temperature: 0.3,
  });

  console.log("\nTriage Result:");
  console.log(JSON.stringify(result.object, null, 2));
  console.log(`\nTokens used: ${result.usage?.totalTokens ?? "unknown"}`);

  return result.object;
}

// ---------------------------------------------------------------------------
// Test: Dispatch + Claim Check
// ---------------------------------------------------------------------------

async function testDispatch() {
  console.log("\n--- Testing Dispatch + Claim Check ---\n");

  const minioClient = createTestMinioClient();

  // 1. Write PENDING status
  console.log("Writing PENDING status...");
  const statusKey = await writeResearchStatus(minioClient, bucket, taskId, "PENDING", {
    prompt: "Research WebSocket alternatives for k8s dashboard",
    startedAt: new Date().toISOString(),
  });
  console.log(`  Status key: ${statusKey}`);

  // 2. Read it back (claim check)
  console.log("Reading status back...");
  const status = await readResearchStatus(minioClient, bucket, taskId);
  console.log(`  Status: ${status?.status}`);

  // 3. Simulate scraper uploading raw result
  const fakeRawContent = `
# WebSocket Support Research

## Server-Sent Events (SSE)
- Unidirectional server-to-client
- Built on HTTP/1.1, no WebSocket upgrade needed
- Works with existing reverse proxies (Traefik, Caddy)
- Auto-reconnect built into EventSource API
- Best for: Dashboard status updates, one-way data feeds

## WebSocket via RabbitMQ MQTT
- Already deployed (RabbitMQ MQTT plugin)
- Dashboard already uses this for terminal streaming
- Bidirectional communication
- Requires WebSocket upgrade in Traefik

## Recommendation
Use SSE for general agent status updates (simpler, more reliable).
Keep MQTT WebSocket for terminal streaming (already working).
  `.trim();

  console.log("Uploading raw research content...");
  const rawKey = await uploadRawResearch(minioClient, bucket, taskId, fakeRawContent);
  console.log(`  Raw key: ${rawKey}`);

  // 4. Update status to COMPLETED
  console.log("Updating status to COMPLETED...");
  await writeResearchStatus(minioClient, bucket, taskId, "COMPLETED", {
    minioKey: rawKey,
    completedAt: new Date().toISOString(),
  });

  // 5. Verify final status
  const finalStatus = await readResearchStatus(minioClient, bucket, taskId);
  console.log(`  Final status: ${finalStatus?.status}`);
  console.log(`  MinIO key: ${finalStatus?.minioKey}`);

  return rawKey;
}

// ---------------------------------------------------------------------------
// Test: Review
// ---------------------------------------------------------------------------

async function testReview(rawMinioKey?: string) {
  console.log("\n--- Testing Review Research ---\n");

  const minioClient = createTestMinioClient();

  // If no key provided, use the dispatch test's output
  const key = rawMinioKey || `research/raw/${taskId}/raw-scraper-result.md`;

  console.log(`Reading raw content from: ${key}`);
  let rawData: string;
  try {
    rawData = await downloadRawResearch(minioClient, bucket, key);
  } catch {
    console.log("No raw data found — using inline test data");
    rawData = `
# Test Research Data

## Finding 1
Dapr Workflows support timer-based timeouts via createTimer().

## Finding 2
External events can be raised via HTTP API: POST /v1.0-alpha1/workflows/dapr/{workflowType}/{instanceId}/raiseEvent/{eventName}
    `.trim();
  }

  console.log(`Raw data length: ${rawData.length} chars`);
  console.log("Sending to LLM for review...");

  const reviewPrompt = [
    `Original Research Prompt: Research WebSocket alternatives for k8s dashboard`,
    "",
    "Research Questions:",
    "1. What are the alternatives to WebSocket for real-time updates?",
    "2. How do SSE compare to WebSocket in a k8s environment?",
    "",
    "Raw Scraped Content:",
    rawData,
  ].join("\n");

  const result = await chatCompletionWithSchema({
    model: LLM_MODEL_FLASH,
    schema: ReviewResearchOutputSchema,
    system: RESEARCH_REVIEW_PROMPT,
    prompt: reviewPrompt,
    temperature: 0.2,
  });

  console.log("\nReview Result:");
  console.log(`  Status: ${result.object.status}`);
  if (result.object.status === "APPROVED") {
    console.log(`  Formatted length: ${result.object.formattedMarkdown?.length ?? 0} chars`);

    // Upload clean version
    if (result.object.formattedMarkdown) {
      const cleanKey = await uploadCleanResearch(
        minioClient,
        bucket,
        taskId,
        result.object.formattedMarkdown,
      );
      console.log(`  Clean doc key: ${cleanKey}`);
    }
  } else {
    console.log(`  Missing info: ${result.object.missingInformation}`);
  }

  console.log(`\nTokens used: ${result.usage?.totalTokens ?? "unknown"}`);

  return result.object;
}

// ---------------------------------------------------------------------------
// Test: Full Workflow via Dapr API
// ---------------------------------------------------------------------------

async function testFull() {
  console.log("\n--- Testing Full Sub-Workflow ---\n");
  console.log("NOTE: This requires the project-manager to be running with Dapr sidecar.\n");

  const workflowInput = {
    taskId,
    issueNumber: 99,
    repoOwner: "jaybrto",
    repoName: "mesh-six",
    issueTitle: "Test: Add WebSocket support",
    issueBody: "Test issue for research workflow validation",
    workflowId: `wf-test-${Date.now()}`,
    architectActorId: "jaybrto/mesh-six/99",
    architectGuidance: "Consider SSE vs WebSocket for dashboard updates",
  };

  console.log("Starting sub-workflow via Dapr...");
  console.log(`Input: ${JSON.stringify(workflowInput, null, 2)}\n`);

  try {
    const response = await fetch(
      `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/researchAndPlanSubWorkflow/${taskId}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowInput),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(`Failed to start workflow: ${response.status} ${body}`);
      return;
    }

    const result = await response.json();
    console.log("Workflow started:", result);

    // Poll for status
    console.log("\nPolling workflow status (press Ctrl+C to stop)...\n");
    for (let i = 0; i < 60; i++) {
      const statusResponse = await fetch(
        `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${taskId}`,
      );
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        console.log(`  [${new Date().toISOString()}] Status: ${JSON.stringify(status)}`);
        if (status.runtimeStatus === "COMPLETED" || status.runtimeStatus === "FAILED") {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

// ---------------------------------------------------------------------------
// Test: Database migration check
// ---------------------------------------------------------------------------

async function testDatabase() {
  console.log("\n--- Testing Database ---\n");
  const pool = createTestPool();
  if (!pool) return;

  try {
    // Check if table exists
    const { rows } = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'research_sessions'
      ) as exists
    `);
    console.log(`  research_sessions table exists: ${rows[0]?.exists}`);

    if (rows[0]?.exists) {
      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*) as count FROM research_sessions",
      );
      console.log(`  Current row count: ${countRows[0]?.count}`);
    }
  } catch (error) {
    console.error("Database check failed:", error);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    switch (mode) {
      case "triage":
        await testTriage();
        break;

      case "dispatch":
        await testDispatch();
        break;

      case "review": {
        const rawKey = process.argv[3]; // Optional raw MinIO key
        await testReview(rawKey);
        break;
      }

      case "full":
        await testTriage();
        const rawKey = await testDispatch();
        await testReview(rawKey);
        await testDatabase();
        console.log("\n--- Offline tests passed! ---");
        console.log("To test the full Dapr workflow, run: bun run scripts/test-research-workflow.ts --mode=workflow");
        break;

      case "workflow":
        await testFull();
        break;

      case "db":
        await testDatabase();
        break;

      default:
        console.error(`Unknown mode: ${mode}`);
        console.log("Usage: bun run scripts/test-research-workflow.ts [--mode triage|dispatch|review|full|workflow|db]");
        process.exit(1);
    }
  } catch (error) {
    console.error("\nTest failed:", error);
    process.exit(1);
  }

  console.log("\nDone.");
}

main();
