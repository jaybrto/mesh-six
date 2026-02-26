/**
 * PostgreSQL CRUD operations for implementation session tables.
 */
import pg from "pg";
import { DATABASE_URL } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// implementation_sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  status: "idle" | "running" | "blocked" | "completed" | "failed" | "interrupted";
  actorId?: string;
  tmuxWindow?: number;
  credentialBundleId?: string;
  claudeSessionId?: string | null;
  startedAt?: string;
  completedAt?: string;
  interruptedAt?: string | null;
  createdAt: string;
}

export async function insertSession(params: {
  id: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  actorId?: string;
}): Promise<SessionRow> {
  const db = getPool();
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO implementation_sessions
       (id, issue_number, repo_owner, repo_name, actor_id, status)
     VALUES ($1, $2, $3, $4, $5, 'idle')
     RETURNING
       id,
       issue_number AS "issueNumber",
       repo_owner   AS "repoOwner",
       repo_name    AS "repoName",
       status,
       actor_id     AS "actorId",
       tmux_window  AS "tmuxWindow",
       credential_bundle_id AS "credentialBundleId",
       started_at   AS "startedAt",
       completed_at AS "completedAt",
       created_at   AS "createdAt"`,
    [params.id, params.issueNumber, params.repoOwner, params.repoName, params.actorId ?? null]
  );
  return rows[0];
}

export async function updateSessionStatus(
  sessionId: string,
  status: Exclude<SessionRow["status"], "interrupted">,
  extra?: {
    tmuxWindow?: number;
    credentialBundleId?: string;
    startedAt?: string;
    completedAt?: string;
  }
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE implementation_sessions
     SET status               = $2,
         tmux_window          = COALESCE($3, tmux_window),
         credential_bundle_id = COALESCE($4, credential_bundle_id),
         started_at           = COALESCE($5::timestamptz, started_at),
         completed_at         = COALESCE($6::timestamptz, completed_at)
     WHERE id = $1`,
    [
      sessionId,
      status,
      extra?.tmuxWindow ?? null,
      extra?.credentialBundleId ?? null,
      extra?.startedAt ?? null,
      extra?.completedAt ?? null,
    ]
  );
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const db = getPool();
  const { rows } = await db.query<SessionRow>(
    `SELECT
       id,
       issue_number AS "issueNumber",
       repo_owner   AS "repoOwner",
       repo_name    AS "repoName",
       status,
       actor_id     AS "actorId",
       tmux_window  AS "tmuxWindow",
       credential_bundle_id AS "credentialBundleId",
       started_at   AS "startedAt",
       completed_at AS "completedAt",
       created_at   AS "createdAt"
     FROM implementation_sessions
     WHERE id = $1`,
    [sessionId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// session_prompts
// ---------------------------------------------------------------------------

export async function insertPrompt(params: {
  sessionId: string;
  promptText: string;
  promptType: "system" | "user" | "tool";
  sequenceNumber: number;
}): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO session_prompts (session_id, prompt_text, prompt_type, sequence_number)
     VALUES ($1, $2, $3, $4)`,
    [params.sessionId, params.promptText, params.promptType, params.sequenceNumber]
  );
}

// ---------------------------------------------------------------------------
// session_tool_calls
// ---------------------------------------------------------------------------

export async function insertToolCall(params: {
  sessionId: string;
  toolName: string;
  inputJson?: unknown;
  outputJson?: unknown;
  durationMs?: number;
}): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO session_tool_calls (session_id, tool_name, input_json, output_json, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.sessionId,
      params.toolName,
      params.inputJson != null ? JSON.stringify(params.inputJson) : null,
      params.outputJson != null ? JSON.stringify(params.outputJson) : null,
      params.durationMs ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// session_activity_log
// ---------------------------------------------------------------------------

export async function insertActivityLog(params: {
  sessionId: string;
  eventType: string;
  detailsJson?: unknown;
}): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO session_activity_log (session_id, event_type, details_json)
     VALUES ($1, $2, $3)`,
    [
      params.sessionId,
      params.eventType,
      params.detailsJson != null ? JSON.stringify(params.detailsJson) : null,
    ]
  );
}

// ---------------------------------------------------------------------------
// session_questions
// ---------------------------------------------------------------------------

export interface QuestionRow {
  id: number;
  sessionId: string;
  questionText: string;
  answerText?: string;
  askedAt: string;
  answeredAt?: string;
}

export async function insertQuestion(params: {
  sessionId: string;
  questionText: string;
}): Promise<QuestionRow> {
  const db = getPool();
  const { rows } = await db.query<QuestionRow>(
    `INSERT INTO session_questions (session_id, question_text)
     VALUES ($1, $2)
     RETURNING
       id,
       session_id   AS "sessionId",
       question_text AS "questionText",
       answer_text  AS "answerText",
       asked_at     AS "askedAt",
       answered_at  AS "answeredAt"`,
    [params.sessionId, params.questionText]
  );
  return rows[0];
}

export async function getSessionQuestions(sessionId: string): Promise<QuestionRow[]> {
  const db = getPool();
  const { rows } = await db.query<QuestionRow>(
    `SELECT
       id,
       session_id   AS "sessionId",
       question_text AS "questionText",
       answer_text  AS "answerText",
       asked_at     AS "askedAt",
       answered_at  AS "answeredAt"
     FROM session_questions
     WHERE session_id = $1
     ORDER BY asked_at ASC`,
    [sessionId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// session resume / checkpoint support (migration 010)
// ---------------------------------------------------------------------------

/**
 * Store the claude_session_id captured from CLI output for later --resume use.
 */
export async function updateClaudeSessionId(
  sessionId: string,
  claudeSessionId: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE implementation_sessions SET claude_session_id = $2 WHERE id = $1`,
    [sessionId, claudeSessionId]
  );
}

export interface CheckpointInsertParams {
  sessionId: string;
  checkpointType: "pre_commit" | "pre_pr" | "pre_merge" | "periodic" | "manual";
  summary: string;
  gitStatus?: string | null;
  gitDiffStat?: string | null;
  tmuxCapture?: string | null;
  pendingActions?: unknown[];
}

export interface CheckpointRow {
  id: number;
  sessionId: string;
  checkpointType: string;
  summary: string;
  gitStatus: string | null;
  gitDiffStat: string | null;
  tmuxCapture: string | null;
  pendingActions: unknown[];
  createdAt: string;
}

/**
 * Insert a pre-action checkpoint snapshot.
 */
export async function insertCheckpoint(params: CheckpointInsertParams): Promise<CheckpointRow> {
  const db = getPool();
  const { rows } = await db.query<CheckpointRow>(
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
      params.sessionId,
      params.checkpointType,
      params.summary,
      params.gitStatus ?? null,
      params.gitDiffStat ?? null,
      params.tmuxCapture ?? null,
      JSON.stringify(params.pendingActions ?? []),
    ]
  );
  await db.query(
    `UPDATE implementation_sessions SET last_checkpoint_at = now() WHERE id = $1`,
    [params.sessionId]
  );
  return rows[0];
}

/**
 * Retrieve the most recent checkpoint for a session.
 */
export async function getLatestCheckpoint(sessionId: string): Promise<CheckpointRow | null> {
  const db = getPool();
  const { rows } = await db.query<CheckpointRow>(
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
 * Mark a session as interrupted during startup recovery.
 */
export async function markSessionInterrupted(sessionId: string): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE implementation_sessions
     SET interrupted_at = now(),
         status         = 'interrupted'
     WHERE id = $1`,
    [sessionId]
  );
}

// ---------------------------------------------------------------------------
// terminal_snapshots (migration 011)
// ---------------------------------------------------------------------------

export async function insertSnapshot(params: {
  sessionId: string;
  ansiContent: string;
  eventType: string;
}): Promise<{ id: number }> {
  const db = getPool();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO terminal_snapshots (session_id, ansi_content, event_type)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [params.sessionId, params.ansiContent, params.eventType]
  );
  return rows[0];
}

export async function getSessionSnapshots(sessionId: string): Promise<Array<{
  id: number;
  sessionId: string;
  ansiContent: string;
  eventType: string;
  capturedAt: string;
}>> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, session_id AS "sessionId", ansi_content AS "ansiContent",
            event_type AS "eventType", captured_at AS "capturedAt"
     FROM terminal_snapshots
     WHERE session_id = $1
     ORDER BY captured_at DESC`,
    [sessionId]
  );
  return rows as Array<{ id: number; sessionId: string; ansiContent: string; eventType: string; capturedAt: string }>;
}

// ---------------------------------------------------------------------------
// terminal_recordings (migration 011)
// ---------------------------------------------------------------------------

export async function insertRecording(params: {
  sessionId: string;
  s3Key: string;
  durationMs: number;
  sizeBytes: number;
  format?: string;
}): Promise<{ id: number }> {
  const db = getPool();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO terminal_recordings (session_id, s3_key, duration_ms, size_bytes, format)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.sessionId, params.s3Key, params.durationMs, params.sizeBytes, params.format || "asciicast-v2"]
  );
  return rows[0];
}

export async function getSessionRecordings(sessionId: string): Promise<Array<{
  id: number;
  sessionId: string;
  s3Key: string;
  durationMs: number;
  sizeBytes: number;
  format: string;
  uploadedAt: string;
}>> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, session_id AS "sessionId", s3_key AS "s3Key",
            duration_ms AS "durationMs", size_bytes AS "sizeBytes",
            format, uploaded_at AS "uploadedAt"
     FROM terminal_recordings
     WHERE session_id = $1
     ORDER BY uploaded_at DESC`,
    [sessionId]
  );
  return rows as Array<{ id: number; sessionId: string; s3Key: string; durationMs: number; sizeBytes: number; format: string; uploadedAt: string }>;
}

export async function getRecordingById(recordingId: number): Promise<{
  id: number;
  sessionId: string;
  s3Key: string;
  durationMs: number;
  sizeBytes: number;
  format: string;
  uploadedAt: string;
} | null> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, session_id AS "sessionId", s3_key AS "s3Key",
            duration_ms AS "durationMs", size_bytes AS "sizeBytes",
            format, uploaded_at AS "uploadedAt"
     FROM terminal_recordings WHERE id = $1`,
    [recordingId]
  );
  return (rows[0] as { id: number; sessionId: string; s3Key: string; durationMs: number; sizeBytes: number; format: string; uploadedAt: string } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// streaming_active flag (migration 011)
// ---------------------------------------------------------------------------

export async function updateStreamingActive(
  sessionId: string,
  active: boolean
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE implementation_sessions SET streaming_active = $2 WHERE id = $1`,
    [sessionId, active]
  );
}
