-- Milestone 6: Context compression operation log
-- Logs compression operations for observability and future adaptive behavior

CREATE TABLE IF NOT EXISTS context_compression_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Routing
  sender          TEXT NOT NULL,
  receiver        TEXT NOT NULL,
  project_id      TEXT,

  -- Compression method and stats
  method          TEXT NOT NULL,  -- 'deterministic', 'llm', 'passthrough'
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  compression_ratio REAL NOT NULL,
  duration_ms     INTEGER NOT NULL,

  -- Validation
  validation_passed BOOLEAN,
  validation_errors JSONB DEFAULT '[]',

  -- LLM details (null for deterministic)
  llm_model       TEXT,
  llm_prompt_version TEXT,

  -- Full payloads (optional, for debugging — normally null)
  input_payload   JSONB,
  output_payload  JSONB
);

CREATE INDEX IF NOT EXISTS idx_compression_log_sender_receiver
  ON context_compression_log (sender, receiver, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_compression_log_method
  ON context_compression_log (method, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_compression_log_failed
  ON context_compression_log (validation_passed, timestamp DESC)
  WHERE validation_passed = false;
