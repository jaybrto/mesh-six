import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.PG_PRIMARY_URL ||
  "postgres://localhost:5432/mesh_six";

export const pool = new Pool({ connectionString: DATABASE_URL });

/** Save a task when dispatched (upsert). */
export async function saveTask(task: {
  taskId: string;
  capability: string;
  dispatchedTo: string;
  dispatchedAt: Date;
  status: string;
  attempts: number;
  maxAttempts?: number;
  timeoutSeconds?: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO orchestrator_tasks
       (task_id, capability, dispatched_to, dispatched_at, status, attempts, max_attempts, timeout_seconds, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (task_id) DO UPDATE SET
       capability = EXCLUDED.capability,
       dispatched_to = EXCLUDED.dispatched_to,
       dispatched_at = EXCLUDED.dispatched_at,
       status = EXCLUDED.status,
       attempts = EXCLUDED.attempts,
       max_attempts = EXCLUDED.max_attempts,
       timeout_seconds = EXCLUDED.timeout_seconds,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      task.taskId,
      task.capability,
      task.dispatchedTo,
      task.dispatchedAt,
      task.status,
      task.attempts,
      task.maxAttempts ?? 3,
      task.timeoutSeconds ?? 120,
      JSON.stringify(task.payload),
    ]
  );
}

/** Load all active (non-terminal) tasks for startup recovery. */
export async function loadActiveTasks(): Promise<
  Array<{
    taskId: string;
    capability: string;
    dispatchedTo: string;
    dispatchedAt: Date;
    status: string;
    attempts: number;
    maxAttempts: number;
    timeoutSeconds: number;
    payload: Record<string, unknown>;
  }>
> {
  const { rows } = await pool.query(
    `SELECT task_id, capability, dispatched_to, dispatched_at, status, attempts,
            max_attempts, timeout_seconds, payload
     FROM orchestrator_tasks
     WHERE status NOT IN ('completed', 'failed')
     ORDER BY created_at ASC`
  );

  return rows.map((r: Record<string, unknown>) => ({
    taskId: r.task_id as string,
    capability: r.capability as string,
    dispatchedTo: r.dispatched_to as string,
    dispatchedAt: r.dispatched_at as Date,
    status: r.status as string,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    timeoutSeconds: r.timeout_seconds as number,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

/** Update a task's status and optionally its result. */
export async function updateTaskStatus(
  taskId: string,
  status: string,
  result?: Record<string, unknown>
): Promise<void> {
  if (result !== undefined) {
    await pool.query(
      `UPDATE orchestrator_tasks
       SET status = $2, result = $3, updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, status, JSON.stringify(result)]
    );
  } else {
    await pool.query(
      `UPDATE orchestrator_tasks
       SET status = $2, updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, status]
    );
  }
}

/** Delete a completed/terminal task from persistence. */
export async function deleteTask(taskId: string): Promise<void> {
  await pool.query(`DELETE FROM orchestrator_tasks WHERE task_id = $1`, [
    taskId,
  ]);
}

/** Bulk-upsert all active tasks (for graceful shutdown checkpoint). */
export async function checkpointAll(
  tasks: Map<string, { taskId: string; capability: string; dispatchedTo: string | null; dispatchedAt: string | null; status: string; attempts: number; payload: Record<string, unknown> }>
): Promise<void> {
  if (tasks.size === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [, task] of tasks) {
      await client.query(
        `INSERT INTO orchestrator_tasks
           (task_id, capability, dispatched_to, dispatched_at, status, attempts, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (task_id) DO UPDATE SET
           capability = EXCLUDED.capability,
           dispatched_to = EXCLUDED.dispatched_to,
           dispatched_at = EXCLUDED.dispatched_at,
           status = EXCLUDED.status,
           attempts = EXCLUDED.attempts,
           payload = EXCLUDED.payload,
           updated_at = NOW()`,
        [
          task.taskId,
          task.capability,
          task.dispatchedTo,
          task.dispatchedAt ? new Date(task.dispatchedAt) : new Date(),
          task.status,
          task.attempts,
          JSON.stringify(task.payload),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
