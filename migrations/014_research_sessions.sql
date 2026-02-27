-- Research sessions table for tracking triage-research-plan sub-workflow state
CREATE TABLE IF NOT EXISTS research_sessions (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    task_id         TEXT NOT NULL,
    workflow_id     TEXT NOT NULL DEFAULT '',
    issue_number    INTEGER NOT NULL,
    repo_owner      TEXT NOT NULL,
    repo_name       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'TIMEOUT')),
    triage_result   JSONB,
    research_cycles INTEGER NOT NULL DEFAULT 0,
    raw_minio_key   TEXT,
    clean_minio_key TEXT,
    final_plan      TEXT,
    error           TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on task_id for upsert operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sessions_task_id ON research_sessions (task_id);

-- Lookup by workflow
CREATE INDEX IF NOT EXISTS idx_research_sessions_workflow_id ON research_sessions (workflow_id);

-- Lookup by issue
CREATE INDEX IF NOT EXISTS idx_research_sessions_issue ON research_sessions (repo_owner, repo_name, issue_number);

-- Status filtering
CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions (status);
