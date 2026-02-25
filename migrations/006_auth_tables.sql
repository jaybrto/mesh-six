-- Migration: 006_auth_tables
-- Auth service tables for credential lifecycle management

CREATE TABLE auth_projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    claude_account_uuid TEXT,
    claude_org_uuid TEXT,
    claude_email TEXT,
    settings_json TEXT,
    claude_json TEXT,
    mcp_json TEXT,
    claude_md TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth_credentials (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    account_uuid TEXT,
    email_address TEXT,
    organization_uuid TEXT,
    billing_type TEXT DEFAULT 'stripe_subscription',
    display_name TEXT DEFAULT 'mesh-six',
    scopes JSONB,
    subscription_type TEXT,
    rate_limit_tier TEXT,
    source TEXT NOT NULL CHECK (source IN ('push', 'refresh', 'import')),
    pushed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at TIMESTAMPTZ
);

CREATE INDEX idx_auth_credentials_project_active
    ON auth_credentials(project_id)
    WHERE invalidated_at IS NULL;

CREATE INDEX idx_auth_credentials_expiry
    ON auth_credentials(expires_at)
    WHERE invalidated_at IS NULL;

CREATE TABLE auth_bundles (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    bundle_data BYTEA NOT NULL,
    config_hash TEXT NOT NULL,
    credential_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ
);

CREATE INDEX idx_auth_bundles_project_active
    ON auth_bundles(project_id)
    WHERE expired_at IS NULL;
