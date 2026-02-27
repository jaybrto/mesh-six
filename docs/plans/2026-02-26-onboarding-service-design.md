# Onboarding Service Design

> Automated project onboarding for mesh-six: GitHub project setup, dev environment provisioning,
> Claude OAuth, LiteLLM routing, and app settings — exposed as a Dapr Workflow with HTTP API and MCP server.

**Date:** 2026-02-26
**Status:** Approved
**Branch:** feat/gwa-migration

---

## Table of Contents

1. [Context & Goal](#context--goal)
2. [Architecture Overview](#architecture-overview)
3. [Onboarding Request & Data Model](#onboarding-request--data-model)
4. [Workflow Activities](#workflow-activities)
5. [Dev Container Feature: mesh-six-tools](#dev-container-feature-mesh-six-tools)
6. [Generated Kustomize Manifests](#generated-kustomize-manifests)
7. [Default devcontainer.json Template](#default-devcontainerjson-template)
8. [Service Structure & MCP Interface](#service-structure--mcp-interface)
9. [Deployment & K8s](#deployment--k8s)
10. [Migration & Database Changes](#migration--database-changes)

---

## Context & Goal

New projects are onboarded to mesh-six weekly. Today, onboarding is partially manual: `scripts/onboard-repo.ts`
creates a GitHub Project with custom fields and inserts into `repo_registry`, but it doesn't handle webhooks,
dev environment provisioning, Claude authentication, LiteLLM configuration, or app settings.

The goal is a fully automated onboarding workflow that takes a GitHub `owner/repo` and produces a
ready-to-use mesh-six environment — project board, Envbuilder pod, credentials, LLM routing — with
minimal human interaction (only the Claude OAuth device flow requires user input).

**Design decisions:**
- **New microservice** (`apps/onboarding-service`) rather than expanding existing scripts — the workflow
  is durable, retriable, and exposes both HTTP and MCP interfaces for programmatic invocation.
- **Dapr Workflow** for orchestration — each activity is idempotent and individually retriable.
  Failed workflows resume from the failed activity without repeating completed ones.
- **Per-repo Envbuilder pods as default** — every onboarded project gets its own StatefulSet with
  dedicated PVCs for worktrees and Claude session data. This avoids resource contention (multiple
  concurrent Claude CLI sessions + QA agents per project) and lets each project own its toolchain
  via `devcontainer.json`.
- **Octokit SDK** for GitHub operations — replaces raw GraphQL fetch calls in existing scripts.
- **`mesh-six-tools` dev container feature** replaces the monolithic `docker/Dockerfile.implementer`
  for Envbuilder-based pods.

---

## Architecture Overview

`apps/onboarding-service` is a Bun+Hono microservice with a Dapr sidecar. It exposes three interfaces:

1. **HTTP API** — `POST /onboard` starts the workflow, `GET /onboard/:id` returns status,
   `POST /onboard/:id/auth-callback` submits Claude OAuth tokens.
2. **MCP Server** — `onboard-project`, `get-onboarding-status`, and `submit-oauth-code` tools
   for Claude Code or agent-driven onboarding. Runs as stdio (when invoked with `--mcp` flag)
   or SSE at `/mcp` for remote MCP clients.
3. **Dapr Workflow** — the actual orchestration engine. Each onboarding run is a durable workflow
   instance with individually retriable activities.

The workflow has three phases:

```
Phase 1: Initialization
  validateRepo → createProjectBoard → registerWebhookSecret
  → registerInDatabase → provisionBackend

Phase 2: Dev Environment Provisioning
  scaffoldDevcontainer → generateKubeManifests
  → updateKustomization → triggerSync → verifyPodHealth

Phase 3: Authentication & Settings
  initiateClaudeOAuth → [waitForExternalEvent] → storeClaudeCredentials
  → configureLiteLLM → configureAppSettings
```

---

## Onboarding Request & Data Model

### Request Payload

```typescript
interface OnboardProjectRequest {
  repoOwner: string;           // GitHub org or user
  repoName: string;            // Repository name
  displayName?: string;        // Human-friendly project name (defaults to repoName)
  defaultBranch?: string;      // Defaults to "main"

  // Phase 2 options
  resourceLimits?: {
    memoryRequest?: string;    // e.g., "2Gi" (default)
    memoryLimit?: string;      // e.g., "8Gi" (default)
    cpuRequest?: string;       // e.g., "1" (default)
    cpuLimit?: string;         // e.g., "4" (default)
    storageWorktrees?: string; // e.g., "20Gi" (default)
    storageClaude?: string;    // e.g., "1Gi" (default)
  };

  // Phase 3 options (can be deferred if user isn't ready)
  skipAuth?: boolean;          // Skip Claude OAuth (do it later)
  skipLiteLLM?: boolean;       // Skip LiteLLM routing setup

  // LiteLLM routing preferences
  litellm?: {
    teamAlias?: string;        // LiteLLM team name (defaults to repoOwner/repoName)
    defaultModel?: string;     // e.g., "claude-sonnet-4-20250514"
    maxBudget?: number;        // Monthly budget cap in USD
  };

  // App settings
  settings?: {
    cloudflareDomain?: string;       // e.g., "mesh-six.bto.bar"
    terminalStreamingRate?: number;  // ms between MQTT publishes
  };
}
```

### Workflow State

Tracked in the `onboarding_runs` table:

```sql
CREATE TABLE onboarding_runs (
  id                   TEXT PRIMARY KEY,     -- workflow instance ID
  repo_owner           TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
                       -- pending | running | waiting_auth | completed | failed
  current_phase        TEXT,                 -- initialization | dev_env | auth_settings
  current_activity     TEXT,                 -- which activity is executing
  completed_activities TEXT[] DEFAULT '{}',
  error_message        TEXT,
  oauth_device_url     TEXT,                 -- URL for user to visit during Claude OAuth
  oauth_user_code      TEXT,                 -- code user enters after authenticating
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
```

The `waiting_auth` status is the key interaction point — the workflow pauses via
`waitForExternalEvent("oauth-code-received")` until the user completes the Claude OAuth
flow and submits tokens back via `POST /onboard/:id/auth-callback`.

---

## Workflow Activities

### Phase 1: Initialization

| Activity | Input | What it does | Idempotency |
|----------|-------|-------------|-------------|
| `validateRepo` | owner, repo | `octokit.repos.get()` — confirms repo exists, caller has admin access, fetches nodeId + default branch | Read-only, always safe |
| `createProjectBoard` | owner, repo, nodeId | GraphQL `createProjectV2` + `linkProjectV2ToRepository` + create custom fields (Session ID, Pod Name, Workflow ID, Priority) + load Status field column mapping | Checks if project already linked to repo; skips if exists |
| `registerWebhookSecret` | owner, repo | Generates HMAC secret, writes to Vault at `secret/data/mesh-six/webhooks/{owner}-{repo}`, patches webhook-receiver ESO to include new key | Checks Vault path first; skips if secret exists |
| `registerInDatabase` | owner, repo, projectId, fields | `INSERT INTO repo_registry` with board_id, field IDs in metadata JSONB, `execution_mode: 'envbuilder'` | Uses `ON CONFLICT (service_name) DO UPDATE` |
| `provisionBackend` | owner, repo | Ensures MinIO bucket `mesh-six-recordings` has prefix `{owner}/{repo}/`, verifies PG connectivity for the project | MinIO putObject with empty marker is idempotent |

### Phase 2: Dev Environment Provisioning

| Activity | Input | What it does | Idempotency |
|----------|-------|-------------|-------------|
| `scaffoldDevcontainer` | owner, repo | Check if repo has `.devcontainer/devcontainer.json`. If not, push default template via GitHub API (base Ubuntu + Node 22 + `mesh-six-tools` feature). If exists, validate it includes the `mesh-six-tools` feature. | Checks for existing file first; skips if present |
| `generateKubeManifests` | owner, repo, resourceLimits | Generate Kustomize manifests at `k8s/base/envs/{owner}-{repo}/` — StatefulSet (Envbuilder image), Service, PVCs, kustomization.yaml. Resource limits from request or repo_registry.metadata. | Overwrites existing manifests (generated content is deterministic) |
| `updateKustomization` | owner, repo | Add `envs/{owner}-{repo}` to `k8s/base/kustomization.yaml` resources list if not already present. | Checks resource list before adding |
| `triggerSync` | owner, repo | Commit + push generated manifests, then wait for ArgoCD to sync (poll ArgoCD API for app health). | ArgoCD sync is idempotent |
| `verifyPodHealth` | owner, repo | Wait for the Envbuilder pod `env-{owner}-{repo}-0` to reach Ready state. Verify health endpoint responds. Log first-build cache time. | Read-only health check |

### Phase 3: Authentication & Settings

| Activity | Input | What it does | Idempotency |
|----------|-------|-------------|-------------|
| `initiateClaudeOAuth` | projectId | Starts Claude CLI device auth flow, returns `{ deviceUrl, userCode, deviceCode }`. Workflow enters `waiting_auth` state, saves URL/code to `onboarding_runs`, calls `waitForExternalEvent("oauth-code-received")`. | Can restart the device flow if expired |
| `storeClaudeCredentials` | projectId, tokens | Calls auth-service `POST /projects/{id}/credentials` with the OAuth tokens received after user completes flow. | auth-service handles duplicate credential push |
| `configureLiteLLM` | teamAlias, defaultModel, maxBudget | Calls LiteLLM admin API: `POST /team/new` to create team, `POST /key/generate` for project virtual key, sets model routing. | Checks if team exists via `GET /team/list` first |
| `configureAppSettings` | projectId, settings | Calls auth-service `PUT /projects/{id}` with settingsJson containing Cloudflare domain, streaming rate, etc. | PUT is naturally idempotent |

---

## Dev Container Feature: mesh-six-tools

Published as an OCI artifact to `registry.bto.bar/jaybrto/devcontainer-features/mesh-six-tools`.
Replaces the monolithic `docker/Dockerfile.implementer` for Envbuilder-based pods.

### What it installs

- tmux, git, gh, curl, jq (system tools)
- Claude CLI (`@anthropic-ai/claude-code` via npm)
- mesh-six entrypoint script (credential provisioning from auth-service, tmux session setup,
  startup recovery sweep)

### What it does NOT include

- No project-specific toolchains — those come from the project's own `devcontainer.json`
  features (Go, .NET, Python, Rust, etc.)
- No database clients — mesh-six uses PostgreSQL via Dapr sidecar

### Feature manifest

```json
{
  "id": "mesh-six-tools",
  "version": "1.0.0",
  "name": "mesh-six Agent Tools",
  "description": "System tools, Claude CLI, and entrypoint for mesh-six agent pods",
  "options": {
    "claudeVersion": {
      "type": "string",
      "default": "latest",
      "description": "Claude Code CLI version (npm semver)"
    },
    "entrypointUrl": {
      "type": "string",
      "default": "https://raw.githubusercontent.com/jaybrto/mesh-six/main/scripts/implementer-entrypoint.sh",
      "description": "URL to the mesh-six implementer entrypoint script"
    }
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/node"
  ],
  "containerEnv": {
    "MESH_SIX_TOOLS_VERSION": "${templateOption:claudeVersion}"
  }
}
```

### Feature location

Stored in the mesh-six monorepo at `devcontainer-features/mesh-six-tools/`:

```
devcontainer-features/
└── mesh-six-tools/
    ├── devcontainer-feature.json
    └── install.sh
```

Published to the Gitea registry via CI workflow.

---

## Generated Kustomize Manifests

The `generateKubeManifests` activity produces files per project at
`k8s/base/envs/{owner}-{repo}/`:

### statefulset.yaml

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: env-{owner}-{repo}
  labels:
    app.kubernetes.io/name: env-{owner}-{repo}
    app.kubernetes.io/part-of: mesh-six
    mesh-six.bto.bar/project: "{owner}/{repo}"
spec:
  replicas: 1
  serviceName: env-{owner}-{repo}
  selector:
    matchLabels:
      app.kubernetes.io/name: env-{owner}-{repo}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: env-{owner}-{repo}
        app.kubernetes.io/part-of: mesh-six
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "env-{owner}-{repo}"
        dapr.io/app-port: "3000"
    spec:
      initContainers:
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 1000:1000 /data/worktrees /data/claude"]
          volumeMounts:
            - name: worktrees
              mountPath: /data/worktrees
            - name: claude-session
              mountPath: /data/claude
      containers:
        - name: implementer
          image: ghcr.io/coder/envbuilder:latest
          env:
            - name: ENVBUILDER_GIT_URL
              value: "https://github.com/{owner}/{repo}"
            - name: ENVBUILDER_INIT_SCRIPT
              value: "/home/runner/entrypoint.sh"
            - name: ENVBUILDER_CACHE_REPO
              value: "registry.bto.bar/jaybrto/envbuilder-cache/{repo}"
            - name: ENVBUILDER_FALLBACK_IMAGE
              value: "mcr.microsoft.com/devcontainers/base:ubuntu"
            - name: ENVBUILDER_SKIP_REBUILD
              value: "true"
            - name: ENVBUILDER_WORKSPACE_BASE_DIR
              value: "/home/runner/repo"
            - name: ENVBUILDER_GIT_USERNAME
              value: "x-access-token"
            - name: ENVBUILDER_GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: github-token
            - name: ENVBUILDER_DOCKER_CONFIG_BASE64
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: docker-config-base64
                  optional: true
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: database-url
            - name: DAPR_HTTP_PORT
              value: "3500"
          resources:
            requests:
              memory: "{memoryRequest}"
              cpu: "{cpuRequest}"
            limits:
              memory: "{memoryLimit}"
              cpu: "{cpuLimit}"
          volumeMounts:
            - name: worktrees
              mountPath: /home/runner/worktrees
            - name: claude-session
              mountPath: /home/runner/.claude
  volumeClaimTemplates:
    - metadata:
        name: worktrees
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: "{storageWorktrees}"
    - metadata:
        name: claude-session
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: "{storageClaude}"
```

Default resource values: memory 2Gi/8Gi, cpu 1/4, worktrees 20Gi, claude-session 1Gi.
All configurable per project via the `OnboardProjectRequest.resourceLimits` field,
persisted in `repo_registry.metadata`.

### service.yaml and kustomization.yaml

Follow the same pattern as `k8s/base/implementer/`.

---

## Default devcontainer.json Template

Stored at `templates/devcontainer/devcontainer.json` in the mesh-six repo.
Scaffolded into repos that don't have one.

```json
{
  "name": "mesh-six agent environment",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "registry.bto.bar/jaybrto/devcontainer-features/mesh-six-tools:1": {}
  },
  "remoteUser": "runner",
  "containerUser": "runner"
}
```

Projects customize this after onboarding by adding language-specific features.

---

## Service Structure & MCP Interface

### File layout

```
apps/onboarding-service/
├── package.json
└── src/
    ├── index.ts              # Hono server + Dapr endpoints + MCP server
    ├── config.ts             # Env vars (DAPR_HOST, DATABASE_URL, LITELLM_URL, etc.)
    ├── workflow.ts           # Dapr Workflow definition (phases + activity sequencing)
    ├── activities/
    │   ├── validate-repo.ts
    │   ├── create-project-board.ts
    │   ├── register-webhook-secret.ts
    │   ├── register-in-database.ts
    │   ├── provision-backend.ts
    │   ├── scaffold-devcontainer.ts
    │   ├── generate-kube-manifests.ts
    │   ├── update-kustomization.ts
    │   ├── trigger-sync.ts
    │   ├── verify-pod-health.ts
    │   ├── initiate-claude-oauth.ts
    │   ├── store-claude-credentials.ts
    │   ├── configure-litellm.ts
    │   └── configure-app-settings.ts
    └── mcp.ts                # MCP tool definitions

```

### HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `POST /onboard` | Start onboarding workflow | Accepts `OnboardProjectRequest`, returns `{ id, status }` |
| `GET /onboard/:id` | Get workflow status | Returns full `onboarding_runs` row with completed activities |
| `POST /onboard/:id/auth-callback` | Submit OAuth tokens | Accepts `{ accessToken, refreshToken, expiresAt }`, raises Dapr external event |
| `GET /healthz` | Health check | Standard |

### MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `onboard-project` | `repoOwner`, `repoName`, `displayName?`, `defaultBranch?`, `skipAuth?`, `skipLiteLLM?`, `litellm?`, `settings?`, `resourceLimits?` | Starts onboarding workflow, returns workflow ID + status |
| `get-onboarding-status` | `workflowId` | Returns current phase, completed activities, errors, and OAuth URL if waiting |
| `submit-oauth-code` | `workflowId`, `accessToken`, `refreshToken`, `expiresAt` | Submits Claude OAuth tokens to resume the waiting workflow |

The MCP server runs in the same process as the Hono server. It binds to stdio when invoked
with `--mcp` flag, or runs as an SSE endpoint at `/mcp` for remote MCP clients.

### Dependencies

- `@octokit/rest` + `@octokit/graphql` — GitHub API operations
- `@modelcontextprotocol/sdk` — MCP server
- `@dapr/dapr` — workflow client
- `pg` — onboarding_runs table
- `@mesh-six/core` — MinIO client, credential utilities, types

---

## Deployment & K8s

### Manifests

```
k8s/base/onboarding-service/
├── deployment.yaml
├── service.yaml
└── kustomization.yaml
```

Standard Dapr-annotated deployment:
- `dapr.io/app-id: "onboarding-service"`
- `dapr.io/app-port: "3000"`
- `dapr.io/enabled: "true"`
- Image: `registry.bto.bar/jaybrto/mesh-six-onboarding-service`
- Uses the shared `docker/Dockerfile.agent` with `AGENT_APP=onboarding-service`
- Single replica (onboarding is infrequent, no need to scale)
- Vault ESO syncs secrets: `GITHUB_TOKEN`, `LITELLM_ADMIN_KEY`, `VAULT_TOKEN`,
  `DATABASE_URL`, `MINIO_*`

### CI

The existing build-deploy matrix in `.github/workflows/build-deploy.yaml` picks up new apps
automatically based on directory detection. Adding `apps/onboarding-service/` is sufficient.

### Kustomize

Add `onboarding-service` to `k8s/base/kustomization.yaml` resources list.

---

## Migration & Database Changes

One new migration `migrations/012_onboarding_runs.sql`:

```sql
-- Onboarding workflow state tracking
CREATE TABLE onboarding_runs (
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

CREATE INDEX idx_onboarding_runs_repo ON onboarding_runs(repo_owner, repo_name);
CREATE INDEX idx_onboarding_runs_status ON onboarding_runs(status);

-- Add execution_mode to repo_registry for hybrid pod model
ALTER TABLE repo_registry ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'envbuilder';
```

---

## New Artifacts Summary

| Artifact | Type | Description |
|----------|------|-------------|
| `apps/onboarding-service/` | Microservice | Dapr Workflow + HTTP API + MCP server |
| `templates/devcontainer/devcontainer.json` | Template | Default devcontainer for onboarded repos |
| `devcontainer-features/mesh-six-tools/` | OCI Feature | Claude CLI, tmux, git, entrypoint |
| `scripts/implementer-entrypoint.sh` | Script | Consolidated startup for Envbuilder pods |
| `migrations/012_onboarding_runs.sql` | Migration | Onboarding state + repo_registry update |
| `k8s/base/onboarding-service/` | K8s manifests | Deployment for the onboarding service |
| `k8s/base/envs/` | K8s manifests | Generated per-project StatefulSets (created at runtime by workflow) |
