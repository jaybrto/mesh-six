# GWA → Mesh-Six Migration Design

**Date:** 2026-02-25
**Status:** Approved
**Scope:** Merge github-workflow-agents (GWA) functionality into mesh-six monorepo

## Background

GWA is being redesigned to align with mesh-six's architecture (Bun monorepo, Hono microservices, PostgreSQL, Dapr). The two systems share the same stack, infrastructure, agent patterns, and deployment target. Rather than maintaining two identical foundations, GWA's functionality merges into mesh-six.

### What GWA contributes

- **EnvironmentProvisioner** — OAuth credential lifecycle (push, refresh, bundle generation, health checks)
- **Dialog Handler** — Auto-dismiss Claude CLI interactive prompts for headless operation
- **Credential Manager** — Pod-side provisioning, backup, restoration utilities
- **Tmux session management** — Full CLI sessions for implementation work
- **Session recording** — Terminal snapshots, activity logs, prompt/tool tracking

### What mesh-six already has

- Agent registry + scoring (weighted routing with historical performance)
- Memory layer (Mem0 + pgvector)
- Context management (buildAgentContext, transitionClose)
- Dapr Workflow state machine (project-manager)
- 17 agents with shared Hono patterns
- GitHub Projects board integration (M4.5)
- Dashboard with MQTT real-time monitoring

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cutover strategy | Clean cutover (GWA offline) | No backward-compat shims needed |
| Swarm model | Single CLI session per issue | Claude Code built-in agent teams handle parallelism |
| Bundle storage | PostgreSQL bytea (no MinIO) | Bundles are ~5-10KB, eliminates infrastructure dependency |
| Headless CLI invocation | Through llm-service actors | Agents stay stateless, credential management centralized |
| Session data | Migrate to PostgreSQL | Full session replay capability |

## Architecture

### System Overview

```
GitHub Board event
    │
    ▼
webhook-receiver ──► Dapr pub/sub (board-events, pr-events)
    │
    ▼
project-manager (Dapr Workflow)
    │
    ├── PLANNING ──► orchestrator ──► architect-agent (via llm-service)
    ├── IMPLEMENTATION ──► orchestrator ──► implementer (StatefulSet, own CLI)
    ├── QA ──► orchestrator ──► qa-tester (via llm-service)
    ├── REVIEW ──► orchestrator ──► architect/api-coder (via llm-service)
    └── ACCEPTED ──► orchestrator ──► pr-agent (via llm-service)

All agents ──► auth-service (credential provisioning)
llm-service ──► auth-service (actor credential lifecycle)
implementer ──► auth-service (session credential lifecycle)
```

### Two Deployment Patterns

| Pattern | Agents | Deployment | CLI Access |
|---------|--------|------------|------------|
| Stateless | architect, researcher, api-coder, ui-agent, qa-tester, pr-agent | Deployment + Dapr sidecar | Via llm-service actors |
| Stateful | implementer | StatefulSet + PVC + Dapr sidecar | Own tmux + Claude CLI |

## Component Designs

### 1. Auth Service (`apps/auth-service/`)

Bun+Hono microservice with Dapr sidecar. Manages Claude CLI credentials and project configuration for all mesh-six agents.

**Replaces:** GWA's EnvironmentProvisioner + REST API + credential manager.

**Storage:** PostgreSQL only (no MinIO).

#### Database Schema

```sql
CREATE TABLE auth_projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    claude_account_uuid TEXT,
    claude_org_uuid TEXT,
    claude_email TEXT,
    settings_json TEXT,         -- Custom ~/.claude/settings.json
    claude_json TEXT,           -- Custom ~/.claude.json
    mcp_json TEXT,              -- Custom MCP servers config
    claude_md TEXT,             -- Custom CLAUDE.md
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth_credentials (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id),
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

CREATE TABLE auth_bundles (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id),
    credential_id TEXT NOT NULL REFERENCES auth_credentials(id),
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
```

#### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/projects` | Create project |
| GET | `/projects/:id` | Get project config |
| PUT | `/projects/:id` | Update settings/MCP/CLAUDE.md |
| GET | `/projects/:id/health` | Credential health (expiry, refresh status) |
| POST | `/projects/:id/credentials` | Push fresh OAuth token |
| POST | `/projects/:id/provision` | Request credential bundle |
| POST | `/projects/:id/refresh` | Force OAuth token refresh |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness |

#### Dapr Integration

- **Pub/sub publisher:** `credential-refreshed` event (on auto-refresh), `config-updated` event (on settings change)
- **Background timer:** Every 30 minutes, checks all projects for expiring credentials (< 60 min remaining), auto-refreshes via Claude OAuth endpoint

#### Bundle Generation

Generates tar.gz in-memory, stores as PostgreSQL bytea:

```
bundle contents:
├── .claude/.credentials.json       # OAuth tokens + metadata
├── .config/claude/config.json      # Ephemeral oauthToken
├── .claude.json                    # Account metadata
└── .claude/settings.json           # UI settings
```

### 2. Core Library Enhancements (`packages/core/`)

#### New: `dialog-handler.ts`

Ported from GWA. Auto-dismisses Claude CLI interactive prompts.

- Known-dialog fast path: regex patterns for permission, trust, theme dialogs
- Unknown-dialog slow path: Haiku API call to analyze terminal output
- Key whitelist: Down, Up, Enter, Tab, Space, Escape, y, n, 0-9
- Max 3 attempts with 1s wait between
- Used by: llm-service actor spawner, implementer tmux monitor

#### New: `credentials.ts`

Pod-side credential utilities:

- `isCredentialExpired(bufferMs?: number): boolean` — check expiry with buffer
- `extractBundle(bundleData: Buffer, targetDir: string): Promise<void>` — extract tar.gz to filesystem
- `buildBundle(project: ProjectConfig, credential: ProjectCredential): Promise<Buffer>` — generate tar.gz
- `syncEphemeralConfig(claudeDir: string, configDir: string): void` — sync ~/.config/claude from ~/.claude

#### Enhanced: `claude.ts`

- Merge GWA's 15 auth failure patterns into `detectAuthFailure()`
- Enhance `preloadClaudeConfig()` to accept project-specific settings

#### New Types (Zod schemas in `types.ts`)

```typescript
// Auth service types
ProjectConfigSchema
ProjectCredentialSchema
CredentialHealthSchema
ProvisionRequestSchema
ProvisionResponseSchema
CredentialPushRequestSchema

// Session tracking types
SessionStateSchema        // idle | running | blocked | completed | failed
SessionEventSchema        // lifecycle events
ImplementationSessionSchema
SessionPromptSchema
SessionToolCallSchema
SessionActivityLogSchema
SessionQuestionSchema

// Constants
AUTH_SERVICE_APP_ID = "auth-service"
CREDENTIAL_REFRESHED_TOPIC = "credential-refreshed"
CONFIG_UPDATED_TOPIC = "config-updated"
SESSION_BLOCKED_TOPIC = "session-blocked"
```

### 3. Implementer Agent (`apps/implementer/`)

StatefulSet-deployed Bun+Hono agent for full Claude CLI implementation sessions.

#### Deployment

- **StatefulSet** with PVC:
  - `claude-session` (10Gi, `longhorn-claude`) — ~/.claude directory
  - `worktrees` (30Gi, `longhorn-claude`) — git repo clones and worktrees
- **Dockerfile.implementer** — Bun + tmux + git + Claude CLI
- **Dapr sidecar:** `dapr.io/app-id: "implementer"`, `dapr.io/app-port: "3000"`

#### Dapr Actor Model

Each active issue is a Dapr actor (`ImplementerActor`):

- **onActivate:** Provision credentials from auth-service, clone/fetch repo, create worktree, set up tmux session
- **onDeactivate:** Cleanup tmux session, archive session state
- **Actor state:** issue number, repo, session status, tmux window ID, credential bundle ID, started_at
- **Idle timeout:** 30 minutes (configurable)

#### Capability Registration

```typescript
capabilities: [
    { name: "implementation", weight: 1.0, preferred: true },
    { name: "bug-fix-implementation", weight: 0.9 }
]
```

#### Session Lifecycle

1. PM dispatches task via pub/sub → implementer receives on `/tasks`
2. Creates/reactivates Dapr actor for the issue
3. Actor provisions credentials from auth-service
4. Clones/fetches repo, creates worktree for issue branch
5. Starts Claude CLI in tmux with implementation prompt
6. Monitors session: publishes progress to MQTT, writes to session tables
7. On question-blocked: publishes `session-blocked` event → PM handles
8. On completion: publishes task result → PM advances workflow

#### Session Monitoring

- Capture tmux pane output at intervals
- Detect auth failures via `detectAuthFailure()` from core
- Detect questions via pattern matching (same as GWA's question detection)
- Detect completion via Claude CLI exit or explicit completion markers
- Write prompts, tool calls, activity to PostgreSQL session tables
- Publish MQTT events for dashboard real-time view

### 4. LLM Service Updates (`apps/llm-service/`)

#### Remove

- `gwa-client.ts` — deleted
- GWA env vars: `GWA_ORCHESTRATOR_URL`, `GWA_API_KEY`, `GWA_PROJECT_ID`
- MinIO credential download for auth bundles

#### Add

- `auth-client.ts` — calls auth-service via Dapr service invocation:
  - `provisionFromAuthService(projectId, actorId, currentBundleId)`
  - `checkCredentialHealth(projectId)`
- Subscribe to `credential-refreshed` Dapr pub/sub topic
- Dialog handler integration from `@mesh-six/core`
- Env var: `AUTH_SERVICE_PROJECT_ID` (replaces `GWA_PROJECT_ID`)

#### Modify

- `claude-cli-actor.ts` — update `onActivate()` and `syncCredentials()` to use auth-client
- CLI spawner — integrate `handleDialogIfPresent` from core

### 5. Session Tracking Tables

PostgreSQL migration for implementation session data:

```sql
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
```

### 6. PR Agent (`apps/pr-agent/`)

Stateless Hono agent for PR creation and code review.

#### Capabilities

```typescript
capabilities: [
    { name: "create-pr", weight: 1.0, preferred: true },
    { name: "code-review", weight: 0.8 }
]
```

#### Endpoints

Standard mesh-six agent pattern: `/healthz`, `/readyz`, `/dapr/subscribe`, `/tasks`, `/invoke`

#### Behavior

- **create-pr:** Receives repo, branch, issue number, implementation summary. Invokes Claude CLI via llm-service to generate PR title, description, and diff review. Creates PR via GitHub API (`@octokit/rest`). Returns PR URL.
- **code-review:** Receives PR URL/number. Fetches diff via GitHub API. Invokes Claude CLI via llm-service for review. Posts review comments on PR.

### 7. PM Workflow Enhancements

#### Question-Blocking

- Subscribe to `session-blocked` Dapr pub/sub topic
- On blocked: move card to Blocked column, send ntfy.sh notification
- On `session-unblocked`: move card back to previous column

#### PR Creation Dispatch

- After QA passes → dispatch `create-pr` capability to orchestrator
- Orchestrator routes to pr-agent via scoring
- PR agent creates PR, returns URL
- PM moves card to Review/Done

#### PR-Triggered Reviews

- webhook-receiver publishes `pr-event` for new/updated PRs
- PM dispatches `code-review` capability
- Orchestrator routes to architect-agent or api-coder

### 8. Webhook Receiver Additions

- Handle `pull_request` events (opened, synchronize, review_requested)
- Publish typed `PREvent` to Dapr `pr-events` topic
- Existing `board-events` handling unchanged

## Migration Phases

### Phase 1 — Foundation (auth-service + core)

**Dependencies:** None
**Parallel tasks within phase:**

1. PostgreSQL migration: auth tables (auth_projects, auth_credentials, auth_bundles)
2. Core: port dialog-handler.ts from GWA
3. Core: port credentials.ts utilities
4. Core: enhance claude.ts with GWA patterns
5. Core: add auth/session Zod schemas to types.ts
6. Build apps/auth-service/ (Hono endpoints, OAuth refresh, Dapr pub/sub)
7. Port scripts/push-credentials.ts CLI tool
8. K8s manifests: k8s/base/auth-service/
9. Unit tests for core modules
10. Integration tests for auth-service

**Gate:** auth-service deployed, responds to provision requests, auto-refreshes credentials.

### Phase 2 — LLM Service Migration

**Dependencies:** Phase 1 complete
**Parallel tasks within phase:**

1. Create auth-client.ts (Dapr service invocation to auth-service)
2. Update claude-cli-actor.ts to use auth-client
3. Add credential-refreshed pub/sub subscription
4. Integrate dialog-handler into CLI spawner
5. Remove gwa-client.ts and GWA env vars
6. Update deployment.yaml
7. Integration tests: actor activation with auth-service

**Gate:** llm-service actors provision credentials from auth-service, no GWA dependency.

### Phase 3 — Implementer Agent + Session Tracking

**Dependencies:** Phase 1 complete (Phase 2 can run in parallel)
**Parallel tasks within phase:**

1. PostgreSQL migration: session tables
2. Build apps/implementer/ (Hono + Dapr actor runtime + tmux management)
3. Create docker/Dockerfile.implementer
4. K8s manifests: StatefulSet with PVCs
5. Session monitoring: MQTT progress events, session table writes
6. Integration tests: full session lifecycle

**Gate:** Implementer can receive task, provision credentials, run Claude CLI in tmux, report results.

### Phase 4 — Workflow Unification + PR Agent

**Dependencies:** Phases 1-3 complete
**Parallel tasks within phase:**

1. Build apps/pr-agent/ (create-pr + code-review capabilities)
2. PM workflow: question-blocking handler
3. PM workflow: PR creation dispatch
4. PM workflow: PR review dispatch
5. Webhook-receiver: PR event handling
6. Dashboard: session monitoring views
7. End-to-end test: full issue lifecycle

**Gate:** Issue flows through board → planning → implementation → QA → review → PR creation.

### Post-Migration

- Archive GWA repository
- Remove remaining GWA references
- Update CLAUDE.md, README.md, CHANGELOG.md
- Update docs/PLAN.md with new milestone

## File Ownership Matrix

| File/Directory | Phase | Owner Agent Type |
|----------------|-------|-----------------|
| `packages/core/src/dialog-handler.ts` | 1 | sonnet |
| `packages/core/src/credentials.ts` | 1 | sonnet |
| `packages/core/src/claude.ts` (enhancements) | 1 | sonnet |
| `packages/core/src/types.ts` (additions) | 1 | sonnet |
| `apps/auth-service/` | 1 | sonnet |
| `migrations/00N_auth_tables.sql` | 1 | sonnet |
| `k8s/base/auth-service/` | 1 | sonnet |
| `scripts/push-credentials.ts` | 1 | sonnet |
| `apps/llm-service/src/auth-client.ts` | 2 | sonnet |
| `apps/llm-service/src/claude-cli-actor.ts` (mods) | 2 | sonnet |
| `apps/llm-service/src/gwa-client.ts` (delete) | 2 | sonnet |
| `migrations/00N_session_tables.sql` | 3 | sonnet |
| `apps/implementer/` | 3 | sonnet |
| `docker/Dockerfile.implementer` | 3 | sonnet |
| `k8s/base/implementer/` | 3 | sonnet |
| `apps/pr-agent/` | 4 | sonnet |
| `apps/project-manager/` (enhancements) | 4 | sonnet |
| `apps/webhook-receiver/` (enhancements) | 4 | sonnet |
| `apps/dashboard/` (session views) | 4 | sonnet |
