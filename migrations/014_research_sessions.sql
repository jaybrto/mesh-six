-- Research sessions table for tracking the state of ResearchAndPlan sub-workflows.
-- Each row represents one research workflow invocation.

CREATE TABLE IF NOT EXISTS research_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,
  issue_number    INTEGER NOT NULL,
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'TRIAGING'
                  CHECK (status IN ('TRIAGING', 'DISPATCHED', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'FAILED', 'TIMEOUT')),
  needs_deep_research BOOLEAN,
  raw_minio_key   TEXT,
  clean_minio_key TEXT,
  research_cycles INTEGER NOT NULL DEFAULT 0,
  triage_context  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- Index for looking up sessions by workflow ID (fixes H2 — workflow_id is now always written)
CREATE INDEX idx_research_sessions_workflow_id ON research_sessions (workflow_id);

-- Index for looking up sessions by task ID
CREATE INDEX idx_research_sessions_task_id ON research_sessions (task_id);

-- Index for looking up sessions by issue
CREATE INDEX idx_research_sessions_issue ON research_sessions (repo_owner, repo_name, issue_number);
