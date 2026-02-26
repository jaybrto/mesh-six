import type { Pool } from "pg";

export interface ArchitectEventRow {
  id: number;
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function appendEvent(
  pool: Pool,
  actorId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<ArchitectEventRow> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `INSERT INTO architect_events (actor_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING id, actor_id, event_type, payload, created_at::text AS created_at`,
    [actorId, eventType, JSON.stringify(payload)],
  );
  return rows[0];
}

export async function loadEvents(
  pool: Pool,
  actorId: string,
): Promise<ArchitectEventRow[]> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `SELECT id, actor_id, event_type, payload, created_at::text AS created_at
     FROM architect_events
     WHERE actor_id = $1
     ORDER BY created_at ASC, id ASC`,
    [actorId],
  );
  return rows;
}

export async function loadEventsByType(
  pool: Pool,
  actorId: string,
  eventType: string,
): Promise<ArchitectEventRow[]> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `SELECT id, actor_id, event_type, payload, created_at::text AS created_at
     FROM architect_events
     WHERE actor_id = $1 AND event_type = $2
     ORDER BY created_at ASC, id ASC`,
    [actorId, eventType],
  );
  return rows;
}
