-- Repository Registry
-- Tracks service repositories, platforms, and CI/CD configurations

CREATE TABLE IF NOT EXISTS repo_registry (
  service_name    TEXT PRIMARY KEY,
  repo_url        TEXT NOT NULL,
  platform        TEXT NOT NULL,
  default_branch  TEXT DEFAULT 'main',
  cicd_type       TEXT NOT NULL,
  trigger_method  TEXT NOT NULL,
  board_id        TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Index for platform queries (common filtering)
CREATE INDEX IF NOT EXISTS idx_repo_registry_platform
  ON repo_registry (platform);

-- Index for service lookups
CREATE INDEX IF NOT EXISTS idx_repo_registry_service_name
  ON repo_registry (service_name);

-- Index for trigger method queries (filtering by CI/CD approach)
CREATE INDEX IF NOT EXISTS idx_repo_registry_trigger_method
  ON repo_registry (trigger_method);

-- Index for board_id lookups (finding services tied to project boards)
CREATE INDEX IF NOT EXISTS idx_repo_registry_board_id
  ON repo_registry (board_id)
  WHERE board_id IS NOT NULL;

-- Composite index for common query pattern: platform + trigger_method
CREATE INDEX IF NOT EXISTS idx_repo_registry_platform_trigger
  ON repo_registry (platform, trigger_method);

COMMENT ON TABLE repo_registry IS 'Central registry of service repositories with platform and CI/CD configuration metadata';
COMMENT ON COLUMN repo_registry.service_name IS 'Unique identifier for the service (Dapr app-id)';
COMMENT ON COLUMN repo_registry.repo_url IS 'Full URL to the repository (GitHub or Gitea)';
COMMENT ON COLUMN repo_registry.platform IS 'Repository platform: github or gitea';
COMMENT ON COLUMN repo_registry.default_branch IS 'Default branch for deployments (typically main or master)';
COMMENT ON COLUMN repo_registry.cicd_type IS 'CI/CD system: github-actions or gitea-actions';
COMMENT ON COLUMN repo_registry.trigger_method IS 'How deployments are triggered: project-board or direct-api';
COMMENT ON COLUMN repo_registry.board_id IS 'Associated project board ID (if trigger_method=project-board)';
COMMENT ON COLUMN repo_registry.metadata IS 'Additional configuration stored as JSON (webhooks, tokens, custom settings)';
COMMENT ON COLUMN repo_registry.created_at IS 'When the registry entry was created';
COMMENT ON COLUMN repo_registry.updated_at IS 'When the registry entry was last updated';
