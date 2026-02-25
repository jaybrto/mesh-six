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
  status: "idle" | "running" | "blocked" | "completed" | "failed";
  actorId?: string;
  tmuxWindow?: number;
  credentialBundleId?: string;
  startedAt?: string;
  completedAt?: string;
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
  status: SessionRow["status"],
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
