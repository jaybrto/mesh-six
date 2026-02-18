-- Milestone 4.5: PM workflow instance tracking
-- Maps GitHub issues to Dapr Workflow instances for the PM agent

CREATE TABLE pm_workflow_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number    INTEGER NOT NULL,
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,
  project_item_id TEXT,
  current_phase   TEXT NOT NULL DEFAULT 'INTAKE',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(issue_number, repo_owner, repo_name)
);

CREATE INDEX idx_pm_workflow_status ON pm_workflow_instances (status, current_phase);
CREATE INDEX idx_pm_workflow_issue ON pm_workflow_instances (repo_owner, repo_name, issue_number);
