#!/usr/bin/env bun
/**
 * Database Diagnostic Tool
 *
 * Prints formatted summaries of active workflows, sessions, pending questions,
 * recent architect events, and system health counts.
 *
 * Usage:
 *   bun run scripts/debug-db.ts
 *
 * Environment:
 *   DATABASE_URL or PG_PRIMARY_URL
 */

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL or PG_PRIMARY_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

function hr(char = "-", width = 72) {
  return char.repeat(width);
}

function section(title: string) {
  console.log(`\n${hr("=")}`);
  console.log(`  ${title}`);
  console.log(hr("="));
}

function padEnd(str: string | null | undefined, len: number): string {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(d);
  }
}

async function run() {
  console.log(`mesh-six Database Diagnostics — ${new Date().toISOString()}`);

  // --- A. Active Workflows ---
  section("A. Active Workflows (not completed/failed)");
  try {
    const { rows } = await pool.query<{
      id: string;
      instance_id: string;
      issue_number: number | null;
      repo_owner: string | null;
      repo_name: string | null;
      status: string;
      current_phase: string | null;
      created_at: string;
    }>(`
      SELECT id, instance_id, issue_number, repo_owner, repo_name,
             status, current_phase, created_at
      FROM pm_workflow_instances
      WHERE status NOT IN ('completed', 'failed')
      ORDER BY created_at DESC
      LIMIT 20
    `);

    if (rows.length === 0) {
      console.log("  (no active workflows)");
    } else {
      const header =
        `  ${"ID".padEnd(10)} ${"INSTANCE".padEnd(24)} ${"ISSUE".padEnd(8)} ` +
        `${"REPO".padEnd(30)} ${"STATUS".padEnd(14)} ${"PHASE".padEnd(16)} CREATED`;
      console.log(header);
      console.log("  " + hr("-", 110));
      for (const r of rows) {
        const repo = r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : "—";
        console.log(
          `  ${padEnd(r.id, 10)} ${padEnd(r.instance_id, 24)} ` +
          `${padEnd(String(r.issue_number ?? "—"), 8)} ` +
          `${padEnd(repo, 30)} ${padEnd(r.status, 14)} ` +
          `${padEnd(r.current_phase ?? "—", 16)} ${formatDate(r.created_at)}`
        );
      }
    }
  } catch (err) {
    console.log(`  (table not available: ${err instanceof Error ? err.message : err})`);
  }

  // --- B. Active Sessions ---
  section("B. Active Implementation Sessions (running/blocked/pending)");
  try {
    const { rows } = await pool.query<{
      id: string;
      issue_number: number;
      repo_owner: string;
      repo_name: string;
      status: string;
      actor_id: string | null;
      created_at: string;
    }>(`
      SELECT id, issue_number, repo_owner, repo_name, status, actor_id, created_at
      FROM implementation_sessions
      WHERE status IN ('running', 'blocked', 'pending')
      ORDER BY created_at DESC
    `);

    if (rows.length === 0) {
      console.log("  (no active sessions)");
    } else {
      const header =
        `  ${"SESSION ID".padEnd(36)} ${"ISSUE".padEnd(8)} ${"REPO".padEnd(30)} ` +
        `${"STATUS".padEnd(12)} ${"ACTOR".padEnd(20)} CREATED`;
      console.log(header);
      console.log("  " + hr("-", 110));
      for (const r of rows) {
        const repo = `${r.repo_owner}/${r.repo_name}`;
        console.log(
          `  ${padEnd(r.id, 36)} ${padEnd(String(r.issue_number), 8)} ` +
          `${padEnd(repo, 30)} ${padEnd(r.status, 12)} ` +
          `${padEnd(r.actor_id ?? "—", 20)} ${formatDate(r.created_at)}`
        );
      }
    }
  } catch (err) {
    console.log(`  (table not available: ${err instanceof Error ? err.message : err})`);
  }

  // --- C. Pending Questions ---
  section("C. Pending Session Questions (unanswered)");
  try {
    const { rows } = await pool.query<{
      id: number;
      session_id: string;
      question_text: string;
      asked_at: string;
    }>(`
      SELECT id, session_id, question_text, asked_at
      FROM session_questions
      WHERE answered_at IS NULL
      ORDER BY asked_at DESC
    `);

    if (rows.length === 0) {
      console.log("  (no pending questions)");
    } else {
      const header =
        `  ${"ID".padEnd(6)} ${"SESSION ID".padEnd(36)} ${"ASKED AT".padEnd(20)} QUESTION`;
      console.log(header);
      console.log("  " + hr("-", 110));
      for (const r of rows) {
        const q = r.question_text.length > 60
          ? r.question_text.slice(0, 57) + "..."
          : r.question_text;
        console.log(
          `  ${padEnd(String(r.id), 6)} ${padEnd(r.session_id, 36)} ` +
          `${formatDate(r.asked_at).padEnd(20)} ${q}`
        );
      }
    }
  } catch (err) {
    console.log(`  (table not available: ${err instanceof Error ? err.message : err})`);
  }

  // --- D. Recent Architect Events ---
  section("D. Recent Architect Events (last 20)");
  try {
    const { rows } = await pool.query<{
      id: number;
      actor_id: string;
      event_type: string;
      payload: unknown;
      created_at: string;
    }>(`
      SELECT id, actor_id, event_type, payload, created_at
      FROM architect_events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    if (rows.length === 0) {
      console.log("  (no architect events)");
    } else {
      const header =
        `  ${"ID".padEnd(8)} ${"ACTOR ID".padEnd(30)} ${"EVENT TYPE".padEnd(24)} CREATED`;
      console.log(header);
      console.log("  " + hr("-", 80));
      for (const r of rows) {
        console.log(
          `  ${padEnd(String(r.id), 8)} ${padEnd(r.actor_id, 30)} ` +
          `${padEnd(r.event_type, 24)} ${formatDate(r.created_at)}`
        );
      }
    }
  } catch (err) {
    console.log(`  (table not available: ${err instanceof Error ? err.message : err})`);
  }

  // --- E. System Health Counts ---
  section("E. System Health");

  // Sessions by status
  try {
    const { rows: sessionCounts } = await pool.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*) AS count
      FROM implementation_sessions
      GROUP BY status
      ORDER BY status
    `);
    console.log("  Sessions by status:");
    for (const r of sessionCounts) {
      console.log(`    ${r.status.padEnd(14)} ${r.count}`);
    }
  } catch (err) {
    console.log(`  Sessions: (unavailable — ${err instanceof Error ? err.message : err})`);
  }

  // Workflows by status
  try {
    const { rows: wfCounts } = await pool.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*) AS count
      FROM pm_workflow_instances
      GROUP BY status
      ORDER BY status
    `);
    console.log("\n  Workflows by status:");
    for (const r of wfCounts) {
      console.log(`    ${r.status.padEnd(14)} ${r.count}`);
    }
  } catch (err) {
    console.log(`  Workflows: (unavailable — ${err instanceof Error ? err.message : err})`);
  }

  // Credential health
  try {
    const { rows: credRows } = await pool.query<{
      project_id: string;
      total: string;
      valid: string;
      expiring_soon: string;
    }>(`
      SELECT
        project_id,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE expires_at > now() AND invalidated_at IS NULL) AS valid,
        COUNT(*) FILTER (WHERE expires_at > now() AND expires_at < now() + interval '24 hours' AND invalidated_at IS NULL) AS expiring_soon
      FROM auth_credentials
      GROUP BY project_id
      ORDER BY project_id
    `);
    console.log("\n  Credentials by project:");
    const header = `    ${"PROJECT".padEnd(20)} ${"TOTAL".padEnd(8)} ${"VALID".padEnd(8)} EXPIRING <24H`;
    console.log(header);
    for (const r of credRows) {
      const expiringSoon = parseInt(r.expiring_soon, 10);
      const marker = expiringSoon > 0 ? " *** EXPIRING SOON ***" : "";
      console.log(
        `    ${padEnd(r.project_id, 20)} ${padEnd(r.total, 8)} ${padEnd(r.valid, 8)} ${r.expiring_soon}${marker}`
      );
    }
  } catch (err) {
    console.log(`  Credentials: (unavailable — ${err instanceof Error ? err.message : err})`);
  }

  console.log(`\n${hr("=")}\n`);
  await pool.end();
}

run().catch((err) => {
  console.error("Diagnostics failed:", err);
  process.exit(1);
});
