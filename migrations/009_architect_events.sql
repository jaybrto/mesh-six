CREATE TABLE architect_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_architect_events_actor ON architect_events(actor_id, created_at);
CREATE INDEX idx_architect_events_type ON architect_events(actor_id, event_type);
