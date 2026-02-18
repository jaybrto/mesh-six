-- Event Log: partitioned append-only event store for mesh-six

CREATE TABLE mesh_six_events (
  seq             BIGSERIAL,
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Correlation
  trace_id        TEXT NOT NULL,
  task_id         UUID,
  agent_id        TEXT NOT NULL,

  -- Event classification
  event_type      TEXT NOT NULL,
  event_version   INT NOT NULL DEFAULT 1,

  -- Payload
  payload         JSONB NOT NULL,

  -- Replay support
  aggregate_id    TEXT,
  idempotency_key TEXT,

  PRIMARY KEY (seq, timestamp)
) PARTITION BY RANGE (timestamp);

-- Initial partitions (3 months ahead)
CREATE TABLE mesh_six_events_2026_02 PARTITION OF mesh_six_events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE mesh_six_events_2026_03 PARTITION OF mesh_six_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE mesh_six_events_2026_04 PARTITION OF mesh_six_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Indexes
CREATE INDEX idx_events_trace ON mesh_six_events (trace_id);
CREATE INDEX idx_events_task ON mesh_six_events (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_events_agent_type ON mesh_six_events (agent_id, event_type, timestamp DESC);
CREATE INDEX idx_events_aggregate ON mesh_six_events (aggregate_id, seq ASC)
  WHERE aggregate_id IS NOT NULL;
CREATE UNIQUE INDEX idx_events_idempotency ON mesh_six_events (idempotency_key, timestamp)
  WHERE idempotency_key IS NOT NULL;
