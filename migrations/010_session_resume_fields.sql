-- Migration 010: Session resume fields and checkpoint table
-- Supports claude --resume, startup recovery, and pre-action state snapshots

-- Add claude_session_id for --resume support
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS claude_session_id TEXT;

-- Add checkpoint tracking
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS last_checkpoint_at TIMESTAMPTZ;

-- Add interrupted tracking for recovery
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ;

-- Index for finding interrupted sessions during recovery
CREATE INDEX IF NOT EXISTS idx_impl_sessions_interrupted
  ON implementation_sessions(interrupted_at)
  WHERE interrupted_at IS NOT NULL;

-- Checkpoint table for pre-action state snapshots
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('pre_commit', 'pre_pr', 'pre_merge', 'periodic', 'manual')),
  summary         TEXT NOT NULL,
  git_status      TEXT,
  git_diff_stat   TEXT,
  tmux_capture    TEXT,
  pending_actions JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session
  ON session_checkpoints(session_id, created_at DESC);
