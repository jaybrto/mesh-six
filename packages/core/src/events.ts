import type { Pool } from "pg";

export interface MeshEvent {
  traceId: string;
  taskId?: string;
  agentId: string;
  eventType: string;
  eventVersion?: number;
  payload: Record<string, unknown>;
  aggregateId?: string;
  idempotencyKey?: string;
}

export interface EventQueryOpts {
  traceId?: string;
  taskId?: string;
  agentId?: string;
  eventType?: string;
  afterSeq?: number;
  beforeSeq?: number;
  since?: Date;
  until?: Date;
  limit?: number;
}

export class EventLog {
  constructor(private pool: Pool) {}

  async emit(event: MeshEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO mesh_six_events
         (trace_id, task_id, agent_id, event_type, event_version,
          payload, aggregate_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.traceId,
        event.taskId ?? null,
        event.agentId,
        event.eventType,
        event.eventVersion ?? 1,
        JSON.stringify(event.payload),
        event.aggregateId ?? null,
        event.idempotencyKey ?? null,
      ]
    );
  }

  async emitBatch(events: MeshEvent[]): Promise<void> {
    if (events.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];

    events.forEach((e, i) => {
      const o = i * 8;
      placeholders.push(
        `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`
      );
      values.push(
        e.traceId,
        e.taskId ?? null,
        e.agentId,
        e.eventType,
        e.eventVersion ?? 1,
        JSON.stringify(e.payload),
        e.aggregateId ?? null,
        e.idempotencyKey ?? null
      );
    });

    await this.pool.query(
      `INSERT INTO mesh_six_events
         (trace_id, task_id, agent_id, event_type, event_version,
          payload, aggregate_id, idempotency_key)
       VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  async query(opts: EventQueryOpts): Promise<(MeshEvent & { seq: number })[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts.traceId) { conditions.push(`trace_id = $${idx++}`); params.push(opts.traceId); }
    if (opts.taskId) { conditions.push(`task_id = $${idx++}`); params.push(opts.taskId); }
    if (opts.agentId) { conditions.push(`agent_id = $${idx++}`); params.push(opts.agentId); }
    if (opts.eventType) { conditions.push(`event_type = $${idx++}`); params.push(opts.eventType); }
    if (opts.afterSeq != null) { conditions.push(`seq > $${idx++}`); params.push(opts.afterSeq); }
    if (opts.beforeSeq != null) { conditions.push(`seq < $${idx++}`); params.push(opts.beforeSeq); }
    if (opts.since) { conditions.push(`timestamp >= $${idx++}`); params.push(opts.since); }
    if (opts.until) { conditions.push(`timestamp <= $${idx++}`); params.push(opts.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit ?? 100);

    const { rows } = await this.pool.query<{
      seq: number;
      trace_id: string;
      task_id: string | null;
      agent_id: string;
      event_type: string;
      event_version: number;
      payload: Record<string, unknown>;
      aggregate_id: string | null;
      idempotency_key: string | null;
    }>(
      `SELECT seq, trace_id, task_id, agent_id, event_type, event_version,
              payload, aggregate_id, idempotency_key
       FROM mesh_six_events
       ${where}
       ORDER BY seq ASC
       LIMIT $${idx}`,
      params
    );

    return rows.map((r) => ({
      seq: r.seq,
      traceId: r.trace_id,
      taskId: r.task_id ?? undefined,
      agentId: r.agent_id,
      eventType: r.event_type,
      eventVersion: r.event_version,
      payload: r.payload,
      aggregateId: r.aggregate_id ?? undefined,
      idempotencyKey: r.idempotency_key ?? undefined,
    }));
  }

  async replay(aggregateId: string, afterSeq?: number): Promise<(MeshEvent & { seq: number })[]> {
    const params: unknown[] = [aggregateId];
    let seqFilter = "";

    if (afterSeq != null) {
      seqFilter = "AND seq > $2";
      params.push(afterSeq);
    }

    const { rows } = await this.pool.query<{
      seq: number;
      trace_id: string;
      task_id: string | null;
      agent_id: string;
      event_type: string;
      event_version: number;
      payload: Record<string, unknown>;
      aggregate_id: string | null;
      idempotency_key: string | null;
    }>(
      `SELECT seq, trace_id, task_id, agent_id, event_type, event_version,
              payload, aggregate_id, idempotency_key
       FROM mesh_six_events
       WHERE aggregate_id = $1 ${seqFilter}
       ORDER BY seq ASC`,
      params
    );

    return rows.map((r) => ({
      seq: r.seq,
      traceId: r.trace_id,
      taskId: r.task_id ?? undefined,
      agentId: r.agent_id,
      eventType: r.event_type,
      eventVersion: r.event_version,
      payload: r.payload,
      aggregateId: r.aggregate_id ?? undefined,
      idempotencyKey: r.idempotency_key ?? undefined,
    }));
  }
}
