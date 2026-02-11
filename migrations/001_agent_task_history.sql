-- Agent Task History
-- Records all task executions for scoring and analytics

CREATE TABLE IF NOT EXISTS agent_task_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  capability    TEXT NOT NULL,
  success       BOOLEAN NOT NULL,
  duration_ms   INTEGER,
  error_type    TEXT,
  context       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Index for scoring queries (agent + capability + recent first)
CREATE INDEX IF NOT EXISTS idx_task_history_agent_capability
  ON agent_task_history (agent_id, capability, created_at DESC);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_task_history_created
  ON agent_task_history (created_at DESC);

-- Index for error analysis
CREATE INDEX IF NOT EXISTS idx_task_history_errors
  ON agent_task_history (error_type)
  WHERE error_type IS NOT NULL;

COMMENT ON TABLE agent_task_history IS 'Records task execution history for agent scoring and analytics';
COMMENT ON COLUMN agent_task_history.agent_id IS 'Dapr app-id of the agent that handled the task';
COMMENT ON COLUMN agent_task_history.capability IS 'The capability that was invoked (e.g., general-query, deploy-service)';
COMMENT ON COLUMN agent_task_history.success IS 'Whether the task completed successfully';
COMMENT ON COLUMN agent_task_history.duration_ms IS 'Execution time in milliseconds';
COMMENT ON COLUMN agent_task_history.error_type IS 'Error classification (timeout, api_error, permission, etc.)';
COMMENT ON COLUMN agent_task_history.context IS 'Additional context for debugging/analytics';
