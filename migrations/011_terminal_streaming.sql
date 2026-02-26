CREATE TABLE IF NOT EXISTS terminal_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  ansi_content    TEXT NOT NULL,
  event_type      TEXT NOT NULL,  -- session_start, session_blocked, answer_injected, session_completed, session_failed, checkpoint
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_terminal_snapshots_session ON terminal_snapshots(session_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS terminal_recordings (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  s3_key          TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  size_bytes      INTEGER NOT NULL,
  format          TEXT NOT NULL DEFAULT 'asciicast-v2',
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_terminal_recordings_session ON terminal_recordings(session_id);

ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS streaming_active BOOLEAN DEFAULT false;
