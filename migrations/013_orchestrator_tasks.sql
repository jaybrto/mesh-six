-- Orchestrator task persistence for pod restart recovery
CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  task_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  dispatched_to TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  payload JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orchestrator_tasks_status ON orchestrator_tasks(status);
CREATE INDEX idx_orchestrator_tasks_capability ON orchestrator_tasks(capability);
