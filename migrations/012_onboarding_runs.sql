-- Onboarding workflow state tracking
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id                   TEXT PRIMARY KEY,
  repo_owner           TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  current_phase        TEXT,
  current_activity     TEXT,
  completed_activities TEXT[] DEFAULT '{}',
  error_message        TEXT,
  oauth_device_url     TEXT,
  oauth_user_code      TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_runs_repo
  ON onboarding_runs(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_onboarding_runs_status
  ON onboarding_runs(status);

COMMENT ON TABLE onboarding_runs IS 'Tracks onboarding workflow state for each project';

-- Add execution_mode to repo_registry for hybrid pod model
ALTER TABLE repo_registry ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'envbuilder';
COMMENT ON COLUMN repo_registry.execution_mode IS 'Pod provisioning mode: envbuilder (per-repo pod) or shared (shared implementer)';
