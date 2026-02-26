/**
 * Startup recovery for implementation sessions.
 * On pod restart, detect sessions that were interrupted mid-flight
 * and mark them as interrupted so they can be cleanly resumed.
 */
import pg from "pg";

export interface InterruptedSession {
  id: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  claudeSessionId: string | null;
  status: string;
  startedAt: string | null;
}

export interface ResumeContext {
  sessionId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  claudeSessionId: string | null;
  checkpointContext: string;
}

/**
 * Mark all sessions with status 'running' or 'blocked' as interrupted.
 * Called once on pod startup before any new sessions are created.
 * Returns the sessions that were marked interrupted.
 */
export async function recoverInterruptedSessions(pool: pg.Pool): Promise<InterruptedSession[]> {
  const { rows } = await pool.query<InterruptedSession>(
    `UPDATE implementation_sessions
     SET interrupted_at = now(),
         status         = 'interrupted'
     WHERE status IN ('running', 'blocked')
       AND interrupted_at IS NULL
     RETURNING
       id,
       issue_number      AS "issueNumber",
       repo_owner        AS "repoOwner",
       repo_name         AS "repoName",
       claude_session_id AS "claudeSessionId",
       status,
       started_at        AS "startedAt"`
  );
  return rows;
}

/**
 * Find sessions that have a claude_session_id and can use --resume.
 * These are interrupted sessions that have a recoverable Claude session handle.
 */
export async function findResumableSessions(pool: pg.Pool): Promise<InterruptedSession[]> {
  const { rows } = await pool.query<InterruptedSession>(
    `SELECT
       id,
       issue_number      AS "issueNumber",
       repo_owner        AS "repoOwner",
       repo_name         AS "repoName",
       claude_session_id AS "claudeSessionId",
       status,
       started_at        AS "startedAt"
     FROM implementation_sessions
     WHERE status = 'interrupted'
       AND claude_session_id IS NOT NULL
     ORDER BY interrupted_at DESC`
  );
  return rows;
}

/**
 * Assemble a ResumeContext for a session from its latest checkpoint and metadata.
 * The checkpointContext string can be prepended to a resume prompt so Claude
 * has the pre-interruption state available.
 */
export async function buildResumeContext(
  pool: pg.Pool,
  sessionId: string
): Promise<ResumeContext | null> {
  const { rows } = await pool.query<InterruptedSession>(
    `SELECT
       id,
       issue_number      AS "issueNumber",
       repo_owner        AS "repoOwner",
       repo_name         AS "repoName",
       claude_session_id AS "claudeSessionId",
       status,
       started_at        AS "startedAt"
     FROM implementation_sessions
     WHERE id = $1`,
    [sessionId]
  );

  const session = rows[0];
  if (!session) return null;

  // Import here to avoid circular dependency at module load time
  const { restoreFromCheckpoint } = await import("./checkpoint.js");
  const checkpointContext = await restoreFromCheckpoint(pool, sessionId);

  return {
    sessionId: session.id,
    issueNumber: session.issueNumber,
    repoOwner: session.repoOwner,
    repoName: session.repoName,
    claudeSessionId: session.claudeSessionId,
    checkpointContext,
  };
}
