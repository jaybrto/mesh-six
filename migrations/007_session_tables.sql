-- Migration 007: Implementation session tracking tables
-- Creates tables for tracking Claude CLI implementation sessions,
-- prompts, tool calls, activity logs, and question-blocking events.

CREATE TABLE implementation_sessions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    issue_number INTEGER NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'blocked', 'completed', 'failed')),
    actor_id TEXT,
    tmux_window INTEGER,
    credential_bundle_id TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_impl_sessions_repo_status
    ON implementation_sessions(repo_owner, repo_name, status);

CREATE TABLE session_prompts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES implementation_sessions(id),
    prompt_text TEXT NOT NULL,
    prompt_type TEXT NOT NULL CHECK (prompt_type IN ('system', 'user', 'tool')),
    sequence_number INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_prompts_session
    ON session_prompts(session_id, created_at);

CREATE TABLE session_tool_calls (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES implementation_sessions(id),
    tool_name TEXT NOT NULL,
    input_json JSONB,
    output_json JSONB,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_tool_calls_session
    ON session_tool_calls(session_id, created_at);

CREATE TABLE session_activity_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES implementation_sessions(id),
    event_type TEXT NOT NULL,
    details_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_activity_session
    ON session_activity_log(session_id, created_at);

CREATE TABLE session_questions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES implementation_sessions(id),
    question_text TEXT NOT NULL,
    answer_text TEXT,
    asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

CREATE INDEX idx_session_questions_session
    ON session_questions(session_id);
