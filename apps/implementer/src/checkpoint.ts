/**
 * Checkpoint support for implementation sessions.
 * Captures pre-action state snapshots (git status, tmux output, pending actions)
 * into session_checkpoints for recovery after interruption.
 */
import pg from "pg";

export interface CheckpointOpts {
  summary: string;
  gitStatus?: string;
  gitDiffStat?: string;
  tmuxCapture?: string;
  pendingActions?: unknown[];
}

export interface CheckpointRow {
  id: number;
  sessionId: string;
  checkpointType: string;
  summary: string;
  gitStatus?: string | null;
  gitDiffStat?: string | null;
  tmuxCapture?: string | null;
  pendingActions: unknown[];
  createdAt: string;
}

/**
 * Insert a checkpoint snapshot into session_checkpoints.
 * type must be one of: pre_commit, pre_pr, pre_merge, periodic, manual
 */
export async function createCheckpoint(
  pool: pg.Pool,
  sessionId: string,
  type: "pre_commit" | "pre_pr" | "pre_merge" | "periodic" | "manual",
  opts: CheckpointOpts
): Promise<CheckpointRow> {
  const { rows } = await pool.query<CheckpointRow>(
    `INSERT INTO session_checkpoints
       (session_id, checkpoint_type, summary, git_status, git_diff_stat, tmux_capture, pending_actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING
       id,
       session_id      AS "sessionId",
       checkpoint_type AS "checkpointType",
       summary,
       git_status      AS "gitStatus",
       git_diff_stat   AS "gitDiffStat",
       tmux_capture    AS "tmuxCapture",
       pending_actions AS "pendingActions",
       created_at      AS "createdAt"`,
    [
      sessionId,
      type,
      opts.summary,
      opts.gitStatus ?? null,
      opts.gitDiffStat ?? null,
      opts.tmuxCapture ?? null,
      JSON.stringify(opts.pendingActions ?? []),
    ]
  );

  // Update last_checkpoint_at on the session row
  await pool.query(
    `UPDATE implementation_sessions SET last_checkpoint_at = now() WHERE id = $1`,
    [sessionId]
  );

  return rows[0];
}

/**
 * Retrieve the most recent checkpoint for a session.
 * Returns null if no checkpoint exists.
 */
export async function getLatestCheckpoint(
  pool: pg.Pool,
  sessionId: string
): Promise<CheckpointRow | null> {
  const { rows } = await pool.query<CheckpointRow>(
    `SELECT
       id,
       session_id      AS "sessionId",
       checkpoint_type AS "checkpointType",
       summary,
       git_status      AS "gitStatus",
       git_diff_stat   AS "gitDiffStat",
       tmux_capture    AS "tmuxCapture",
       pending_actions AS "pendingActions",
       created_at      AS "createdAt"
     FROM session_checkpoints
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] ?? null;
}

/**
 * Build a context string from the latest checkpoint that can be prepended
 * to a Claude resume prompt. Returns an empty string if no checkpoint found.
 */
export async function restoreFromCheckpoint(
  pool: pg.Pool,
  sessionId: string
): Promise<string> {
  const checkpoint = await getLatestCheckpoint(pool, sessionId);
  if (!checkpoint) return "";

  const parts: string[] = [
    `## Resuming from checkpoint (${checkpoint.checkpointType}) at ${checkpoint.createdAt}`,
    `**Summary:** ${checkpoint.summary}`,
  ];

  if (checkpoint.gitStatus) {
    parts.push(`**Git status at checkpoint:**\n\`\`\`\n${checkpoint.gitStatus}\n\`\`\``);
  }

  if (checkpoint.gitDiffStat) {
    parts.push(`**Git diff stat at checkpoint:**\n\`\`\`\n${checkpoint.gitDiffStat}\n\`\`\``);
  }

  if (checkpoint.tmuxCapture) {
    parts.push(`**Last terminal output:**\n\`\`\`\n${checkpoint.tmuxCapture}\n\`\`\``);
  }

  const pending = checkpoint.pendingActions as unknown[];
  if (pending.length > 0) {
    parts.push(`**Pending actions:** ${JSON.stringify(pending)}`);
  }

  return parts.join("\n\n");
}
