#!/usr/bin/env bun
/**
 * Cleanup Script
 *
 * Removes completed/failed implementation sessions and purges old logs.
 * Optionally removes associated git worktrees and tmux sessions.
 *
 * Usage:
 *   bun run scripts/cleanup.ts [options]
 *
 * Options:
 *   --dry-run              Print what would be done without executing
 *   --retention-days N     Days to retain sessions (default: 7)
 *   --log-retention-days N Days to retain logs/checkpoints (default: 30)
 */

import { parseArgs } from "util";
import pg from "pg";
import { removeWorktree, GitError } from "@mesh-six/core";
import { existsSync } from "fs";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "retention-days": { type: "string", default: "7" },
    "log-retention-days": { type: "string", default: "30" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: bun run scripts/cleanup.ts [options]

Options:
  --dry-run              Print what would be done without executing
  --retention-days N     Days to retain completed/failed sessions (default: 7)
  --log-retention-days N Days to retain checkpoints and activity logs (default: 30)
  -h, --help             Show this help
`);
  process.exit(0);
}

const dryRun = values["dry-run"] ?? false;
const retentionDays = parseInt(values["retention-days"] ?? "7", 10);
const logRetentionDays = parseInt(values["log-retention-days"] ?? "30", 10);

if (isNaN(retentionDays) || retentionDays < 1) {
  console.error("Error: --retention-days must be a positive integer");
  process.exit(1);
}
if (isNaN(logRetentionDays) || logRetentionDays < 1) {
  console.error("Error: --log-retention-days must be a positive integer");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL or PG_PRIMARY_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

interface SessionRow {
  id: string;
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  status: string;
  worktree_path: string | null;
  tmux_session: string | null;
  updated_at: string;
}

async function cleanup() {
  const prefix = dryRun ? "[DRY RUN] " : "";

  console.log(`${prefix}Starting cleanup (session retention: ${retentionDays}d, log retention: ${logRetentionDays}d)`);

  // --- 1. Find stale sessions ---
  const { rows: staleSessions } = await pool.query<SessionRow>(`
    SELECT id, issue_number, repo_owner, repo_name, status,
           worktree_path, tmux_session, updated_at
    FROM implementation_sessions
    WHERE status IN ('completed', 'failed')
      AND updated_at < now() - interval '${retentionDays} days'
    ORDER BY updated_at ASC
  `);

  console.log(`\nFound ${staleSessions.length} stale session(s) to clean up:`);

  let sessionsRemoved = 0;

  for (const session of staleSessions) {
    console.log(`\n  Session ${session.id} (issue #${session.issue_number} ${session.repo_owner}/${session.repo_name})`);
    console.log(`    Status: ${session.status}, last updated: ${session.updated_at}`);

    // Remove worktree if path is set
    if (session.worktree_path) {
      if (existsSync(session.worktree_path)) {
        console.log(`    ${prefix}Removing worktree: ${session.worktree_path}`);
        if (!dryRun) {
          // Derive repo dir from worktree path (parent dir convention)
          const repoDir = session.worktree_path.replace(/\/worktrees\/[^/]+$/, "");
          try {
            await removeWorktree(repoDir, session.worktree_path);
          } catch (err) {
            if (err instanceof GitError) {
              console.warn(`    Warning: Failed to remove worktree: ${err.message}`);
            } else {
              console.warn(`    Warning: Failed to remove worktree:`, err);
            }
          }
        }
      } else {
        console.log(`    Worktree path not found on disk (already removed): ${session.worktree_path}`);
      }
    }

    // Kill tmux session if set
    if (session.tmux_session) {
      console.log(`    ${prefix}Killing tmux session: ${session.tmux_session}`);
      if (!dryRun) {
        const proc = Bun.spawn(["tmux", "kill-session", "-t", session.tmux_session], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        // Ignore exit code — session may already be gone
      }
    }

    // Delete the session record
    console.log(`    ${prefix}Deleting session record ${session.id}`);
    if (!dryRun) {
      await pool.query("DELETE FROM implementation_sessions WHERE id = $1", [session.id]);
    }

    sessionsRemoved++;
  }

  // --- 2. Clean up old session_checkpoints ---
  const { rows: checkpointCountRows } = await pool.query<{ count: string }>(`
    SELECT COUNT(*) AS count FROM session_checkpoints
    WHERE created_at < now() - interval '${logRetentionDays} days'
  `);
  const checkpointCount = parseInt(checkpointCountRows[0]?.count ?? "0", 10);

  console.log(`\n${prefix}Deleting ${checkpointCount} checkpoint(s) older than ${logRetentionDays} days`);
  if (!dryRun && checkpointCount > 0) {
    await pool.query(`
      DELETE FROM session_checkpoints
      WHERE created_at < now() - interval '${logRetentionDays} days'
    `);
  }

  // --- 3. Clean up old session_activity_log ---
  const { rows: logCountRows } = await pool.query<{ count: string }>(`
    SELECT COUNT(*) AS count FROM session_activity_log
    WHERE created_at < now() - interval '${logRetentionDays} days'
  `);
  const logCount = parseInt(logCountRows[0]?.count ?? "0", 10);

  console.log(`${prefix}Deleting ${logCount} activity log entry/entries older than ${logRetentionDays} days`);
  if (!dryRun && logCount > 0) {
    await pool.query(`
      DELETE FROM session_activity_log
      WHERE created_at < now() - interval '${logRetentionDays} days'
    `);
  }

  // --- Summary ---
  console.log(`\n--- Summary ${dryRun ? "(DRY RUN — no changes made)" : ""} ---`);
  console.log(`  Sessions cleaned:        ${sessionsRemoved}`);
  console.log(`  Checkpoints deleted:     ${checkpointCount}`);
  console.log(`  Activity log entries:    ${logCount}`);

  await pool.end();
}

cleanup().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
