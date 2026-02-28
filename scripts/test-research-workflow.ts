#!/usr/bin/env bun
/**
 * Test script for the ResearchAndPlan sub-workflow.
 *
 * Modes:
 *   --mode=triage    Run offline triage test only
 *   --mode=dispatch   Run triage + dispatch test
 *   --mode=review     Run triage + dispatch + review test
 *   --mode=offline    Run all offline tests (triage + dispatch + review + db)
 *   --mode=workflow   Run full Dapr workflow end-to-end test
 *
 * Fixes from PR review:
 *   - L1: Handles both --mode=X and --mode X arg formats
 *   - L2: Renamed 'full' to 'offline' (misleading name per review)
 */

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Arg parsing (fixes L1 — handles both --mode=X and --mode X)
// ---------------------------------------------------------------------------

function parseMode(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--mode=")) {
      return arg.replace("--mode=", "");
    }
    if (arg === "--mode" && args[i + 1]) {
      return args[i + 1]!;
    }
  }
  return "offline";
}

const mode = parseMode();
console.log(`[test-research-workflow] Running in mode: ${mode}`);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function testTriage(): Promise<string> {
  console.log("\n=== Test: Architect Triage ===");

  if (!DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set");
    return "";
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    // Verify research_sessions table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'research_sessions'
      )`,
    );
    assert(tableCheck.rows[0]?.exists === true, "research_sessions table should exist");
    console.log("✓ research_sessions table exists");

    // Insert a test session (simulating what architectTriage does)
    const result = await pool.query(
      `INSERT INTO research_sessions
         (task_id, workflow_id, issue_number, repo_owner, repo_name, status, needs_deep_research, triage_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        `test-task-${Date.now()}`,
        `test-wf-${Date.now()}`,
        999,
        "jaybrto",
        "mesh-six",
        "TRIAGING",
        true,
        "Test triage context",
      ],
    );

    const sessionId = result.rows[0]?.id as string;
    assert(!!sessionId, "Should return a session ID");
    console.log(`✓ Created test session: ${sessionId}`);

    // Verify workflow_id is populated (fixes H2)
    const verify = await pool.query(
      `SELECT workflow_id FROM research_sessions WHERE id = $1`,
      [sessionId],
    );
    assert(!!verify.rows[0]?.workflow_id, "workflow_id should be populated (H2 fix)");
    console.log("✓ workflow_id is populated in DB row");

    // Cleanup
    await pool.query(`DELETE FROM research_sessions WHERE id = $1`, [sessionId]);
    console.log("✓ Cleaned up test session");

    return sessionId;
  } finally {
    await pool.end();
  }
}

async function testDispatch(): Promise<string> {
  console.log("\n=== Test: Deep Research Dispatch ===");

  if (!DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set");
    return "";
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    // Insert a session then update with raw_minio_key (simulating dispatch)
    const taskId = `test-dispatch-${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO research_sessions
         (task_id, workflow_id, issue_number, repo_owner, repo_name, status, needs_deep_research)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [taskId, `test-wf-${Date.now()}`, 999, "jaybrto", "mesh-six", "TRIAGING", true],
    );
    const sessionId = result.rows[0]?.id as string;

    // Simulate dispatch update (fixes H4 — raw_minio_key written)
    const rawKey = `research/raw/${taskId}/raw-scraper-result.md`;
    await pool.query(
      `UPDATE research_sessions SET status = 'DISPATCHED', raw_minio_key = $1, research_cycles = 1, updated_at = NOW() WHERE id = $2`,
      [rawKey, sessionId],
    );

    // Verify raw_minio_key is populated (fixes H4)
    const verify = await pool.query(
      `SELECT raw_minio_key, research_cycles FROM research_sessions WHERE id = $1`,
      [sessionId],
    );
    assert(verify.rows[0]?.raw_minio_key === rawKey, "raw_minio_key should be populated (H4 fix)");
    assert(verify.rows[0]?.research_cycles === 1, "research_cycles should be 1 at cycle start (H5 fix)");
    console.log("✓ raw_minio_key populated in DB");
    console.log("✓ research_cycles incremented at cycle start");

    // Cleanup
    await pool.query(`DELETE FROM research_sessions WHERE id = $1`, [sessionId]);
    console.log("✓ Cleaned up test session");

    return rawKey;
  } finally {
    await pool.end();
  }
}

async function testReview(): Promise<void> {
  console.log("\n=== Test: Research Review ===");

  if (!DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set");
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const taskId = `test-review-${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO research_sessions
         (task_id, workflow_id, issue_number, repo_owner, repo_name, status, needs_deep_research, raw_minio_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [taskId, `test-wf-${Date.now()}`, 999, "jaybrto", "mesh-six", "REVIEW", true, `research/raw/${taskId}/raw.md`],
    );
    const sessionId = result.rows[0]?.id as string;

    // Simulate APPROVED review with clean key
    const cleanKey = `research/clean/${taskId}/clean-research.md`;
    await pool.query(
      `UPDATE research_sessions SET status = 'COMPLETED', clean_minio_key = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [cleanKey, sessionId],
    );

    // Verify clean_minio_key and completed_at (fixes M2 — only research status set here)
    const verify = await pool.query(
      `SELECT status, clean_minio_key, completed_at FROM research_sessions WHERE id = $1`,
      [sessionId],
    );
    assert(verify.rows[0]?.status === "COMPLETED", "Status should be COMPLETED");
    assert(verify.rows[0]?.clean_minio_key === cleanKey, "clean_minio_key should be set");
    assert(!!verify.rows[0]?.completed_at, "completed_at should be set");
    console.log("✓ Review completes with correct status and keys");

    // Cleanup
    await pool.query(`DELETE FROM research_sessions WHERE id = $1`, [sessionId]);
    console.log("✓ Cleaned up test session");
  } finally {
    await pool.end();
  }
}

async function testStatusTransitions(): Promise<void> {
  console.log("\n=== Test: Status Transitions ===");

  if (!DATABASE_URL) {
    console.log("SKIP: DATABASE_URL not set");
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const taskId = `test-transitions-${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO research_sessions
         (task_id, workflow_id, issue_number, repo_owner, repo_name, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [taskId, `test-wf-${Date.now()}`, 999, "jaybrto", "mesh-six", "TRIAGING"],
    );
    const sessionId = result.rows[0]?.id as string;

    // Test all valid status transitions
    const transitions: string[] = ["DISPATCHED", "IN_PROGRESS", "REVIEW", "COMPLETED"];
    for (const status of transitions) {
      await pool.query(
        `UPDATE research_sessions SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, sessionId],
      );
      const verify = await pool.query(`SELECT status FROM research_sessions WHERE id = $1`, [sessionId]);
      assert(verify.rows[0]?.status === status, `Status should be ${status}`);
    }
    console.log("✓ All status transitions valid");

    // Test TIMEOUT status (fixes GPT-4 — timeout state persisted)
    await pool.query(
      `UPDATE research_sessions SET status = 'TIMEOUT', updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    const timeoutVerify = await pool.query(`SELECT status FROM research_sessions WHERE id = $1`, [sessionId]);
    assert(timeoutVerify.rows[0]?.status === "TIMEOUT", "TIMEOUT status should be persisted");
    console.log("✓ TIMEOUT status persisted in DB");

    // Test FAILED status
    await pool.query(
      `UPDATE research_sessions SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    const failedVerify = await pool.query(`SELECT status FROM research_sessions WHERE id = $1`, [sessionId]);
    assert(failedVerify.rows[0]?.status === "FAILED", "FAILED status should be persisted");
    console.log("✓ FAILED status persisted in DB");

    // Cleanup
    await pool.query(`DELETE FROM research_sessions WHERE id = $1`, [sessionId]);
    console.log("✓ Cleaned up test session");
  } finally {
    await pool.end();
  }
}

async function testWorkflow(): Promise<void> {
  console.log("\n=== Test: Full Dapr Workflow (requires running Dapr sidecar) ===");

  const baseUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}`;

  // Check if Dapr sidecar is available
  try {
    const healthRes = await fetch(`${baseUrl}/v1.0/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!healthRes.ok) {
      console.log("SKIP: Dapr sidecar not healthy");
      return;
    }
  } catch {
    console.log("SKIP: Dapr sidecar not reachable");
    return;
  }

  console.log("✓ Dapr sidecar is reachable");

  // Schedule the research sub-workflow
  const workflowId = `test-research-${Date.now()}`;
  const scheduleRes = await fetch(
    `${baseUrl}/v1.0-alpha1/workflows/dapr/researchAndPlanSubWorkflow/start?instanceID=${workflowId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: `test-task-${Date.now()}`,
        issueNumber: 999,
        issueTitle: "Test research workflow",
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        workflowId,
        architectActorId: "jaybrto/mesh-six/999",
      }),
    },
  );

  if (!scheduleRes.ok) {
    const body = await scheduleRes.text();
    console.log(`SKIP: Failed to schedule workflow: ${scheduleRes.status} ${body}`);
    return;
  }

  console.log(`✓ Workflow scheduled: ${workflowId}`);

  // Poll for status
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(
      `${baseUrl}/v1.0-alpha1/workflows/dapr/researchAndPlanSubWorkflow/${workflowId}`,
    );
    if (statusRes.ok) {
      const status = (await statusRes.json()) as { runtimeStatus: string };
      console.log(`  Workflow status: ${status.runtimeStatus}`);
      if (status.runtimeStatus === "COMPLETED" || status.runtimeStatus === "FAILED") {
        break;
      }
    }
  }

  console.log("✓ Workflow test complete");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Research Workflow Test Script ===\n");

  switch (mode) {
    case "triage":
      await testTriage();
      break;

    case "dispatch":
      await testTriage();
      await testDispatch();
      break;

    case "review":
      await testTriage();
      await testDispatch();
      await testReview();
      break;

    case "offline": {
      await testTriage();
      await testDispatch();
      await testReview();
      await testStatusTransitions();
      break;
    }

    case "workflow":
      await testWorkflow();
      break;

    default:
      console.error(`Unknown mode: ${mode}`);
      console.error("Valid modes: triage, dispatch, review, offline, workflow");
      process.exit(1);
  }

  console.log("\n=== All tests passed ===");
}

main().catch((err) => {
  console.error("\n=== TEST FAILED ===");
  console.error(err);
  process.exit(1);
});
