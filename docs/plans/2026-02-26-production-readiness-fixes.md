# Production Readiness Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use plan-with-teams to execute this plan via Agent Teams with phased coordination.

**Goal:** Fix the 12 blockers preventing mesh-six from onboarding its first project and running agents autonomously.

**Architecture:** Fixes are grouped into foundation work (credential flow, orchestrator retry), parallel service fixes (onboarding activities, webhook multi-project, CI/infrastructure), and integration verification.

**Tech Stack:** TypeScript/Bun, Hono, Dapr, Octokit, Kustomize, GitHub Actions, Vault External Secrets

---

## Context

A production readiness audit identified 14 gaps across the mesh-six system. This plan addresses the 12 that are code/config changes. The remaining 2 (dashboard onboarding view, ntfy public URL) are deferred to a follow-up plan.

### Priority Classification

| Priority | Items | Impact |
|----------|-------|--------|
| P0 — Blocks first onboard | Implementer bundle extraction, onboarding manifest generation, OAuth CLI, devcontainer publish, mesh-six-secrets | Cannot onboard any project |
| P1 — Blocks multi-project | Webhook multi-project, implementer per-repo creds, Envbuilder manifest completeness, orchestrator retry | First project works but second breaks |
| P2 — Quality/operational | CI matrices, prod overlay tags, PM state enum | System works but has operational gaps |

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Bundle extraction | Implementer downloads tar.gz and extracts locally (no new auth-service endpoint) | Auth-service already serves the bundle via `GET /projects/:id/provision/:bundleId`. Adding an extraction endpoint violates separation of concerns — the consumer should own extraction. |
| Manifest generation | Use Octokit Contents API to commit files to mesh-six repo | Onboarding-service runs in a container with no local git checkout. `scaffold-devcontainer.ts` already uses this pattern for the target repo. |
| Per-repo credentials | Pass `authProjectId` in task payload from PM, look up from `repo_registry` | Eliminates fixed `AUTH_PROJECT_ID` env var. The onboarding workflow already creates the auth project during `register-in-database`. |
| Webhook multi-project | Look up per-repo secret from Vault, instantiate per-repo `GitHubProjectClient` | Vault already stores per-repo HMAC secrets (written by `register-webhook-secret` activity). Project field IDs stored in `repo_registry.metadata`. |
| OAuth device flow | Replace `--print-device-code` with Anthropic OAuth API direct call | Claude CLI has no `--print-device-code` flag. The Anthropic OAuth API device flow endpoint is the correct approach for programmatic use. |

---

## Files Modified (Existing)

| File | Change |
|------|--------|
| `apps/implementer/src/actor.ts` | Rewrite `extractBundle()` to download tar.gz and extract locally with `zlib.gunzipSync` + tar parsing; accept `authProjectId` from `onActivate` params instead of env var |
| `apps/implementer/src/config.ts` | Remove `AUTH_PROJECT_ID` env var (replaced by per-task routing) |
| `apps/orchestrator/src/index.ts` | Store original `payload` in `activeTasks` map; use it in `retryTask()` |
| `apps/webhook-receiver/src/index.ts` | Replace single `GITHUB_WEBHOOK_SECRET` with per-repo Vault lookup; replace singleton `GitHubProjectClient` with per-repo instantiation from `repo_registry` |
| `apps/onboarding-service/src/activities/generate-kube-manifests.ts` | Replace `Bun.write()` with Octokit Contents API to commit files to mesh-six repo |
| `apps/onboarding-service/src/activities/update-kustomization.ts` | Replace `Bun.file()`/`Bun.write()` with Octokit Contents API read + update |
| `apps/onboarding-service/src/activities/trigger-sync.ts` | Remove `Bun.spawnSync` git commands; replace with no-op or ArgoCD sync trigger (commits now happen via GitHub API) |
| `apps/onboarding-service/src/activities/initiate-claude-oauth.ts` | Replace `claude auth login --print-device-code` with Anthropic OAuth device flow API call |
| `apps/onboarding-service/src/activities/verify-pod-health.ts` | Use Kubernetes API client instead of `kubectl` shell command |
| `.github/workflows/build-deploy.yaml` | Add `onboarding-service` and `context-service` to `BUILDABLE_AGENTS` |
| `.github/workflows/test.yaml` | Add `onboarding-service`, `auth-service`, `implementer`, `llm-service`, `context-service` to `ALL_APPS` |
| `k8s/overlays/prod/kustomization.yaml` | Add image entries for `auth-service`, `implementer`, `onboarding-service`, `context-service` |
| `apps/project-manager/src/index.ts` | Fix `ProjectState` enum to match workflow states (INTAKE, PLANNING, IMPLEMENTATION, QA, REVIEW, ACCEPTED, FAILED) |

## Files Created (New)

| File | Purpose |
|------|---------|
| `k8s/base/vault-external-secrets-main.yaml` | ExternalSecret for `mesh-six-secrets` — syncs PG creds, GitHub token, Vault token, MinIO keys from Vault |
| `k8s/base/onboarding-service/rbac.yaml` | ServiceAccount + Role + RoleBinding for onboarding-service to read pods in mesh-six namespace |
| `.github/workflows/publish-devcontainer-feature.yaml` | CI workflow to publish `devcontainer-features/mesh-six-tools/` to Gitea OCI registry |
| `apps/onboarding-service/src/activities/generate-kube-manifests.ts` | (rewrite — same path, new implementation using Octokit) |

---

## Acceptance Criteria

- [ ] Implementer can provision and extract credentials from auth-service for any onboarded project (not just a fixed `AUTH_PROJECT_ID`)
- [ ] Onboarding workflow can generate K8s manifests and commit them to the mesh-six repo via GitHub API (no local filesystem writes)
- [ ] Onboarding OAuth activity uses a working Anthropic OAuth device flow (not `--print-device-code`)
- [ ] Webhook receiver validates signatures and routes events per-repo using Vault secrets and `repo_registry` metadata
- [ ] Orchestrator retries preserve the original task payload
- [ ] `mesh-six-secrets` is provisioned via ExternalSecret (not manual `kubectl create secret`)
- [ ] CI builds all deployed apps; CI typechecks all deployed apps
- [ ] Prod overlay pins image tags for all deployed apps
- [ ] `bun run typecheck` passes across all 23 packages
- [ ] Existing tests pass (`bun run --filter @mesh-six/core test`)
- [ ] DevContainer feature has a publish CI workflow

---

## Agent Teams Execution Plan

### Team Structure

- **Lead**: Coordinates phases, delegates foundation to subagents, spawns teammates, runs integration subagent
- **Teammate A** (`bun-service`): Onboarding service activity fixes — rewrite 4 activities to use proper APIs
- **Teammate B** (`bun-service`): Multi-project support — webhook receiver + implementer credential routing + orchestrator retry
- **Teammate C** (`general-purpose`): CI/CD + Infrastructure — GitHub Actions workflows, K8s manifests, ExternalSecrets, devcontainer publish

### Phase 1: Foundation (Sequential — Team Lead Delegates to Subagents)

All teammates depend on the implementer's bundle extraction being fixed (it establishes the pattern for how credentials flow). The orchestrator payload fix is also foundational since it affects retry behavior for all agents.

#### Task 1.1: Fix implementer `extractBundle()` to download and extract locally

**Files:**
- Modify: `apps/implementer/src/actor.ts` (lines 396-408)

**What to implement:**

Replace the broken `POST /bundles/:id/extract` call with:
1. `GET /projects/${authProjectId}/provision/${bundleId}` to download the raw tar.gz
2. Local extraction using `zlib.gunzipSync()` + simple ustar tar parser
3. Write extracted files to `CLAUDE_SESSION_DIR`

The tar format is standard ustar (512-byte headers, see `apps/auth-service/src/bundle.ts:51-92`). The bundle contains 4 files: `.claude/.credentials.json`, `.config/claude/config.json`, `.claude/settings.json`, `.claude.json`.

```typescript
private async extractBundle(bundleId: string, authProjectId: string): Promise<void> {
  const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${authProjectId}/provision/${bundleId}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bundle download failed: ${response.status} ${response.statusText}`);
  }
  const compressed = Buffer.from(await response.arrayBuffer());
  const tar = zlib.gunzipSync(compressed);
  // Parse ustar tar: 512-byte header blocks, extract name and size, write files
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end of archive
    const name = header.subarray(0, 100).toString("utf-8").replace(/\0/g, "");
    const size = parseInt(header.subarray(124, 136).toString("utf-8").trim(), 8);
    offset += 512;
    if (size > 0) {
      const data = tar.subarray(offset, offset + size);
      const targetPath = join(CLAUDE_SESSION_DIR, name);
      await mkdir(dirname(targetPath), { recursive: true });
      await Bun.write(targetPath, data);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}
```

Also update `provisionCredentials()` to pass `authProjectId` to `extractBundle()`.

**Verification:** `bun run --filter @mesh-six/implementer typecheck`

#### Task 1.2: Add `authProjectId` parameter to implementer actor

**Files:**
- Modify: `apps/implementer/src/actor.ts` (lines 97-147, `onActivate` method)
- Modify: `apps/implementer/src/config.ts` (remove `AUTH_PROJECT_ID`)

**What to implement:**

Add `authProjectId?: string` to the `onActivate` params. Default to `"mesh-six"` if not provided (backward compatible). Store it on `ActorState`. Use it in `provisionCredentials()` instead of the env var.

Remove `AUTH_PROJECT_ID` from `config.ts`.

**Verification:** `bun run --filter @mesh-six/implementer typecheck`

#### Task 1.3: Fix orchestrator retry to preserve payload

**Files:**
- Modify: `apps/orchestrator/src/index.ts` (lines 30-35 activeTasks type, line 309 payload)

**What to implement:**

Add `payload: Record<string, unknown>` to the `activeTasks` map value type. Store the original payload when first dispatching a task. Use it in `retryTask()` at line 309 instead of `{}`.

```typescript
// In POST /tasks handler, when storing in activeTasks:
activeTasks.set(taskId, {
  taskId,
  capability,
  payload: task.payload, // <-- store original payload
  dispatchedTo: bestAgent.agentId,
  ...
});

// In retryTask(), line 309:
payload: taskStatus.payload, // <-- use stored payload
```

**Verification:** `bun run --filter @mesh-six/orchestrator typecheck`

#### Task 1.4: Fix PM ProjectState enum

**Files:**
- Modify: `apps/project-manager/src/index.ts` (lines 193-203)

**What to implement:**

Replace the legacy `ProjectState` enum values with the workflow's actual states:

```typescript
// Before:
"CREATE", "PLANNING", "REVIEW", "IN_PROGRESS", "QA", "DEPLOY", "VALIDATE", "ACCEPTED", "FAILED"

// After:
"INTAKE", "PLANNING", "IMPLEMENTATION", "QA", "REVIEW", "ACCEPTED", "FAILED"
```

Update any `canTransition()` or state-checking logic that references the old values.

**Verification:** `bun run --filter @mesh-six/project-manager typecheck`

#### Phase 1 Verification Gate

Run: `bun run typecheck` (all packages)
Expected: All 23 packages pass

---

### Phase 2: Parallel Implementation (3 Teammates)

#### Teammate A: Onboarding Service Activity Fixes

**Owns (exclusive write access):**
- `apps/onboarding-service/src/activities/generate-kube-manifests.ts`
- `apps/onboarding-service/src/activities/update-kustomization.ts`
- `apps/onboarding-service/src/activities/trigger-sync.ts`
- `apps/onboarding-service/src/activities/initiate-claude-oauth.ts`
- `apps/onboarding-service/src/activities/verify-pod-health.ts`
- `k8s/base/onboarding-service/rbac.yaml` (new)

**Reads (no writes):**
- `apps/onboarding-service/src/activities/scaffold-devcontainer.ts` (reference pattern for Octokit file commits)
- `apps/onboarding-service/src/config.ts`
- `apps/onboarding-service/src/schemas.ts`

**Tasks:**

**A.1: Rewrite `generate-kube-manifests.ts` to use Octokit Contents API**

The current implementation uses `Bun.write()` to write files to the local filesystem. In a container, there's no git checkout. Rewrite to:

1. Keep the existing YAML builder functions (`buildStatefulSetYaml`, `buildServiceYaml`, `buildKustomizationYaml`)
2. Replace the `Bun.write()` calls with `octokit.repos.createOrUpdateFileContents()` to commit each file directly to the mesh-six repo
3. Add `MESH_SIX_REPO_OWNER` and `MESH_SIX_REPO_NAME` to config (default: `"jaybrto"` and `"mesh-six"`)
4. Commit all 3 files (statefulset.yaml, service.yaml, kustomization.yaml) to `k8s/base/envs/{owner}-{repo}/` in the mesh-six repo
5. Fix the generated StatefulSet to include:
   - `imagePullSecrets: [{name: "gitea-registry-secret"}]` for private registry auth
   - Remove Dapr health probes (Envbuilder is a build tool, not an HTTP server)
   - Or: replace Envbuilder image with the agent's pre-built image if no devcontainer customization needed

Follow the exact pattern from `scaffold-devcontainer.ts` (lines 70-77) for the Octokit call.

**A.2: Rewrite `update-kustomization.ts` to use Octokit Contents API**

Replace `Bun.file().text()` + `Bun.write()` with:
1. `octokit.repos.getContent()` to read `k8s/base/kustomization.yaml` from the mesh-six repo
2. Parse, insert the new `envs/{owner}-{repo}/` entry
3. `octokit.repos.createOrUpdateFileContents()` to commit the updated file (include the file's `sha` for update)

**A.3: Simplify `trigger-sync.ts`**

The git add/commit/push logic is no longer needed since A.1 and A.2 commit directly via GitHub API. Replace the implementation with:
1. A no-op that returns success (the commits were already made in prior activities)
2. Or optionally: trigger an ArgoCD sync via the ArgoCD API if `ARGOCD_URL` is configured

**A.4: Fix `initiate-claude-oauth.ts`**

Replace the broken `claude auth login --print-device-code` with a direct call to the Anthropic OAuth device authorization endpoint. The Anthropic OAuth API follows the standard RFC 8628 device authorization flow:

1. `POST https://auth.anthropic.com/oauth/device/code` with `client_id` and `scope`
2. Response contains `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`
3. Return `{ deviceUrl: verification_uri, userCode: user_code }`

Add `ANTHROPIC_CLIENT_ID` to config.ts if needed, or use the well-known Claude CLI client ID.

If the exact Anthropic OAuth endpoint is not documented/available, an alternative approach:
1. Use `claude auth login` without `--print-device-code`
2. Capture the interactive output via pty to extract the URL and code
3. Or use `claude auth status` to check if already authenticated

Research the Claude CLI source or Anthropic OAuth docs to determine the correct endpoint before implementing.

**A.5: Fix `verify-pod-health.ts` to use Kubernetes API**

Replace `Bun.spawnSync(["kubectl", ...])` with the Kubernetes API via `fetch()`:
1. Use the in-cluster service account token at `/var/run/secrets/kubernetes.io/serviceaccount/token`
2. Call `GET /api/v1/namespaces/mesh-six/pods/{podName}` on `https://kubernetes.default.svc`
3. Check `status.conditions` for `Ready=True`

**A.6: Create RBAC for onboarding-service**

Create `k8s/base/onboarding-service/rbac.yaml`:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: onboarding-service
  namespace: mesh-six
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: onboarding-service-pod-reader
  namespace: mesh-six
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: onboarding-service-pod-reader
  namespace: mesh-six
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: onboarding-service-pod-reader
subjects:
  - kind: ServiceAccount
    name: onboarding-service
    namespace: mesh-six
```

Add `rbac.yaml` to `k8s/base/onboarding-service/kustomization.yaml` resources. Add `serviceAccountName: onboarding-service` to the deployment spec.

**Validation:** `bun run --filter @mesh-six/onboarding-service typecheck`

---

#### Teammate B: Multi-Project Support

**Owns (exclusive write access):**
- `apps/webhook-receiver/src/index.ts`

**Reads (no writes):**
- `packages/core/src/index.ts` (types, `GitHubProjectClient`)
- `apps/onboarding-service/src/activities/register-webhook-secret.ts` (understand Vault path pattern)
- `apps/onboarding-service/src/activities/register-in-database.ts` (understand repo_registry metadata schema)
- `migrations/012_onboarding_runs.sql` (repo_registry schema)

**Tasks:**

**B.1: Replace single webhook secret with per-repo Vault lookup**

Currently `GITHUB_WEBHOOK_SECRET` is a single env var (line 20). Replace with:

1. Add `VAULT_ADDR` and `VAULT_TOKEN` to the env config
2. On webhook receipt, extract `repository.full_name` from the payload (format: `owner/repo`)
3. Look up the HMAC secret from Vault at `secret/data/mesh-six/webhooks/{owner}-{repo}` (this is the path `register-webhook-secret.ts` writes to)
4. Cache the secret in-memory with a TTL (e.g., 5 minutes) to avoid hitting Vault on every webhook
5. Fall back to `GITHUB_WEBHOOK_SECRET` env var if Vault lookup fails (backward compat for the transition period)
6. Use the resolved secret for HMAC verification

**B.2: Replace singleton `GitHubProjectClient` with per-repo instantiation**

Currently one `GitHubProjectClient` is initialized at module level with `GITHUB_PROJECT_ID` and `GITHUB_STATUS_FIELD_ID` (lines 31-36). Replace with:

1. On webhook receipt, look up the repo's project board info from `repo_registry` table (the `metadata` JSONB column contains `projectId`, `statusFieldId`, and other custom field IDs — written by `register-in-database.ts`)
2. Create a `GitHubProjectClient` per-repo, cached in a `Map<string, GitHubProjectClient>`
3. Use the repo-specific client for all project board operations
4. Fall back to the global `GITHUB_PROJECT_ID` if repo not found in registry (backward compat)

This requires adding a PostgreSQL connection to webhook-receiver (add `pg` dependency, `DATABASE_URL` config).

**B.3: Fix label filtering**

Lines 287-293 pass empty `{ labels: [], author: "" }` to `shouldProcessIssue()`. Fix to:
1. Extract actual labels from the webhook payload (`issue.labels[].name`)
2. Pass them to `shouldProcessIssue()`

**Validation:** `bun run --filter @mesh-six/webhook-receiver typecheck`

---

#### Teammate C: CI/CD + Infrastructure

**Owns (exclusive write access):**
- `.github/workflows/build-deploy.yaml`
- `.github/workflows/test.yaml`
- `.github/workflows/publish-devcontainer-feature.yaml` (new)
- `k8s/overlays/prod/kustomization.yaml`
- `k8s/base/vault-external-secrets-main.yaml` (new)
- `k8s/base/kustomization.yaml` (add new ExternalSecret resource only)

**Reads (no writes):**
- `k8s/base/vault-external-secrets.yaml` (existing ExternalSecrets pattern)
- `k8s/base/onboarding-service/deployment.yaml` (verify secret refs)
- `devcontainer-features/mesh-six-tools/` (understand what to publish)

**Tasks:**

**C.1: Update CI build matrix**

In `.github/workflows/build-deploy.yaml`, add to `BUILDABLE_AGENTS` array (around line 37-58):
- `context-service`

Note: `auth-service` is already in the list per the audit re-check. `onboarding-service` needs to be added. `implementer` is already handled with a special Dockerfile path.

Add `onboarding-service` to the array and verify the generic `Dockerfile.agent` works for it.

**C.2: Update CI test matrix**

In `.github/workflows/test.yaml`, add to `ALL_APPS` array (around line 48-66):
- `auth-service`
- `implementer`
- `llm-service`
- `context-service`
- `onboarding-service`

**C.3: Add prod overlay image tags**

In `k8s/overlays/prod/kustomization.yaml`, add image entries for:
```yaml
- name: registry.bto.bar/jaybrto/mesh-six-auth-service
  newTag: latest
- name: registry.bto.bar/jaybrto/mesh-six-implementer
  newTag: latest
- name: registry.bto.bar/jaybrto/mesh-six-onboarding-service
  newTag: latest
- name: registry.bto.bar/jaybrto/mesh-six-context-service
  newTag: latest
```

**C.4: Create ExternalSecret for `mesh-six-secrets`**

Create `k8s/base/vault-external-secrets-main.yaml` following the pattern in `k8s/base/vault-external-secrets.yaml`:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: mesh-six-main-secrets
  namespace: mesh-six
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: mesh-six-secrets
    creationPolicy: Owner
  data:
    - secretKey: PG_USER
      remoteRef:
        key: secret/data/mesh-six
        property: pg-user
    - secretKey: PG_PASSWORD
      remoteRef:
        key: secret/data/mesh-six
        property: pg-password
    - secretKey: GITHUB_TOKEN
      remoteRef:
        key: secret/data/mesh-six
        property: github-token
    - secretKey: VAULT_TOKEN
      remoteRef:
        key: secret/data/mesh-six
        property: vault-token
    - secretKey: MINIO_ACCESS_KEY
      remoteRef:
        key: secret/data/mesh-six
        property: minio-access-key
    - secretKey: MINIO_SECRET_KEY
      remoteRef:
        key: secret/data/mesh-six
        property: minio-secret-key
    - secretKey: LITELLM_ADMIN_KEY
      remoteRef:
        key: secret/data/mesh-six
        property: litellm-admin-key
    - secretKey: GIT_USERNAME
      remoteRef:
        key: secret/data/mesh-six
        property: git-username
    - secretKey: GIT_PASSWORD
      remoteRef:
        key: secret/data/mesh-six
        property: git-password
```

Add `- vault-external-secrets-main.yaml` to `k8s/base/kustomization.yaml` resources list.

**C.5: Create devcontainer feature publish workflow**

Create `.github/workflows/publish-devcontainer-feature.yaml`:

```yaml
name: Publish DevContainer Feature
on:
  push:
    branches: [main]
    paths:
      - 'devcontainer-features/mesh-six-tools/**'
  workflow_dispatch:

jobs:
  publish:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install devcontainer CLI
        run: npm install -g @devcontainers/cli
      - name: Login to Gitea registry
        run: echo "${{ secrets.GITEA_TOKEN }}" | docker login registry.bto.bar -u jaybrto --password-stdin
      - name: Publish feature
        run: |
          devcontainer features publish \
            devcontainer-features/mesh-six-tools \
            --registry registry.bto.bar \
            --namespace jaybrto/devcontainer-features
```

Note: The exact `devcontainer features publish` command may need adjustment based on the Gitea OCI registry's compatibility. Research the devcontainer CLI publish docs if needed.

**Validation:** YAML lint on all workflow files; `kubectl apply --dry-run=client` on new K8s manifests.

---

### Phase 3: Integration + Testing (Subagent-Delegated)

After all teammates complete, the team lead spawns a **fresh integration subagent** with these instructions:

1. Read all files modified by teammates (see File Ownership Matrix)
2. Read the shared foundation files from Phase 1 (`apps/implementer/src/actor.ts`, `apps/orchestrator/src/index.ts`, `apps/project-manager/src/index.ts`)
3. Fix any integration mismatches:
   - Import paths, type names, function signatures
   - Cross-service type consistency (e.g., webhook-receiver's new DB dependency types)
   - Config exports that were added/removed
4. Run `bun install` (in case new deps were added)
5. Run `bun run typecheck` — fix any errors across all 23 packages
6. Run `bun run --filter @mesh-six/core test`
7. Run `bun run --filter @mesh-six/onboarding-service test`
8. Return a summary of all changes made and verification results

After integration subagent completes:
- Lead reviews the summary
- Lead runs `bun run typecheck` independently to verify
- Lead updates CHANGELOG.md, CLAUDE.md, bumps package versions
- Lead commits all changes

---

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead (Phase 1)** | `apps/implementer/src/actor.ts`, `apps/implementer/src/config.ts`, `apps/orchestrator/src/index.ts`, `apps/project-manager/src/index.ts` | Everything |
| **A — Onboarding Fixes** | `apps/onboarding-service/src/activities/generate-kube-manifests.ts`, `apps/onboarding-service/src/activities/update-kustomization.ts`, `apps/onboarding-service/src/activities/trigger-sync.ts`, `apps/onboarding-service/src/activities/initiate-claude-oauth.ts`, `apps/onboarding-service/src/activities/verify-pod-health.ts`, `k8s/base/onboarding-service/rbac.yaml`, `k8s/base/onboarding-service/kustomization.yaml`, `k8s/base/onboarding-service/deployment.yaml` | `apps/onboarding-service/src/activities/scaffold-devcontainer.ts`, `apps/onboarding-service/src/config.ts`, `apps/onboarding-service/src/schemas.ts` |
| **B — Multi-Project** | `apps/webhook-receiver/src/index.ts` | `packages/core/src/index.ts`, `apps/onboarding-service/src/activities/register-webhook-secret.ts`, `migrations/012_onboarding_runs.sql` |
| **C — CI/Infrastructure** | `.github/workflows/build-deploy.yaml`, `.github/workflows/test.yaml`, `.github/workflows/publish-devcontainer-feature.yaml`, `k8s/overlays/prod/kustomization.yaml`, `k8s/base/vault-external-secrets-main.yaml`, `k8s/base/kustomization.yaml` | `k8s/base/vault-external-secrets.yaml`, `k8s/base/onboarding-service/deployment.yaml`, `devcontainer-features/mesh-six-tools/` |
| **Lead (Phase 3)** | `CHANGELOG.md`, `CLAUDE.md`, `apps/*/package.json` | All teammate outputs |

---

### Task Dependency DAG

```
Phase 1 (Lead — delegates to subagents):
  1.1 Fix extractBundle() ──────┐
  1.2 Add authProjectId param ──┤
  1.3 Fix orchestrator retry ───┼── All must complete before Phase 2
  1.4 Fix PM ProjectState enum ─┘

  1.5 Verification gate: bun run typecheck

Phase 2 (Parallel — 3 Teammates):
  A: Onboarding activity fixes ───┐
  B: Multi-project support ───────┼── All must complete before Phase 3
  C: CI/CD + Infrastructure ──────┘

Phase 3 (Lead — delegates integration to subagent):
  3.1 Integration subagent ──► 3.2 Lead verifies ──► 3.3 Docs + commit
```

---

### Claude Code Session Setup

**Prerequisites:**
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Execution steps:**

1. Start Claude Code in the mesh-six project directory
2. Tell Claude: `@docs/plans/2026-02-26-production-readiness-fixes.md following Claude Code Session Setup instructions`
3. Claude creates feature branch: `git checkout -b fix/production-readiness`
4. Claude creates the full task list with dependencies using `TaskCreate` and `TaskUpdate(addBlockedBy)`
5. Claude delegates Phase 1 tasks (1.1–1.4) to synchronous subagents — each reads the target file, applies the fix, returns a summary
6. Claude runs the verification gate: `bun run typecheck`
7. Claude calls `TeamCreate` to establish team `production-readiness`
8. Claude creates team-scoped tasks for Phase 2 work
9. Claude spawns 3 teammates in parallel via `Task` tool:
   - `name: "teammate-a"`, `subagent_type: "bun-service"` — onboarding activity fixes
   - `name: "teammate-b"`, `subagent_type: "bun-service"` — multi-project support
   - `name: "teammate-c"`, `subagent_type: "general-purpose"` — CI/infrastructure
10. Claude monitors progress via `TaskList` polling
11. When all teammates complete, Claude sends `shutdown_request` to each
12. Claude spawns integration subagent (fresh context) to fix mismatches, run typecheck + tests
13. Claude reviews integration summary, runs verification independently
14. Claude updates CHANGELOG.md, CLAUDE.md, bumps versions, commits

### Teammate Prompt Templates

**Teammate A prompt:**
```
You are Teammate A on team production-readiness. Your job is to fix 5 onboarding-service
activities that currently have broken implementations.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim your task (set owner to "teammate-a")
- Use TaskGet to read the full task description

**File Ownership:**
- You EXCLUSIVELY own:
  - apps/onboarding-service/src/activities/generate-kube-manifests.ts
  - apps/onboarding-service/src/activities/update-kustomization.ts
  - apps/onboarding-service/src/activities/trigger-sync.ts
  - apps/onboarding-service/src/activities/initiate-claude-oauth.ts
  - apps/onboarding-service/src/activities/verify-pod-health.ts
  - k8s/base/onboarding-service/rbac.yaml (create new)
  - k8s/base/onboarding-service/kustomization.yaml
  - k8s/base/onboarding-service/deployment.yaml
- You may READ: apps/onboarding-service/src/activities/scaffold-devcontainer.ts (Octokit pattern),
  apps/onboarding-service/src/config.ts, apps/onboarding-service/src/schemas.ts
- Do NOT touch any other files

**Context:**
- Read scaffold-devcontainer.ts first — it shows the Octokit Contents API pattern to follow
- The generate-kube-manifests.ts and update-kustomization.ts must commit to the MESH-SIX repo
  (not the target project repo) using Octokit
- Add MESH_SIX_REPO_OWNER and MESH_SIX_REPO_NAME to config.ts
- initiate-claude-oauth.ts: the --print-device-code flag does not exist in Claude CLI. Replace
  with direct Anthropic OAuth device flow API call or research the correct approach.
- verify-pod-health.ts: replace kubectl shell with Kubernetes API via fetch using in-cluster credentials

**Validation:**
- Run: bun run --filter @mesh-six/onboarding-service typecheck
- All existing tests must still pass

**When complete:**
- Mark your tasks as completed via TaskUpdate
- Send completion report via SendMessage to the team lead
```

**Teammate B prompt:**
```
You are Teammate B on team production-readiness. Your job is to make the webhook receiver
support multiple projects instead of being hardcoded to one.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim your task (set owner to "teammate-b")
- Use TaskGet to read the full task description

**File Ownership:**
- You EXCLUSIVELY own: apps/webhook-receiver/src/index.ts
- You may READ: packages/core/src/index.ts, apps/onboarding-service/src/activities/register-webhook-secret.ts,
  apps/onboarding-service/src/activities/register-in-database.ts, migrations/012_onboarding_runs.sql
- Do NOT touch any other files

**Context:**
- Currently webhook-receiver uses a single GITHUB_WEBHOOK_SECRET env var and single
  GitHubProjectClient. Multiple onboarded repos will have different secrets and project boards.
- Webhook secrets are stored in Vault at secret/data/mesh-six/webhooks/{owner}-{repo}
  (written by register-webhook-secret.ts during onboarding)
- Per-repo project board info (projectId, field IDs) is stored in repo_registry.metadata JSONB
  (written by register-in-database.ts during onboarding)
- Add pg dependency + DATABASE_URL config to look up repo_registry
- Add VAULT_ADDR + VAULT_TOKEN config for Vault lookups
- Cache secrets and project clients in-memory with 5-minute TTL
- Fall back to env vars if Vault/DB lookup fails (backward compatibility)
- Also fix labels: extract actual issue labels from webhook payload for shouldProcessIssue()

**Validation:**
- Run: bun run --filter @mesh-six/webhook-receiver typecheck

**When complete:**
- Mark your tasks as completed via TaskUpdate
- Send completion report via SendMessage to the team lead
```

**Teammate C prompt:**
```
You are Teammate C on team production-readiness. Your job is to fix CI/CD pipelines,
K8s manifests, and infrastructure gaps.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim your task (set owner to "teammate-c")
- Use TaskGet to read the full task description

**File Ownership:**
- You EXCLUSIVELY own:
  - .github/workflows/build-deploy.yaml
  - .github/workflows/test.yaml
  - .github/workflows/publish-devcontainer-feature.yaml (create new)
  - k8s/overlays/prod/kustomization.yaml
  - k8s/base/vault-external-secrets-main.yaml (create new)
  - k8s/base/kustomization.yaml (add ExternalSecret resource entry only)
- You may READ: k8s/base/vault-external-secrets.yaml (existing pattern),
  k8s/base/onboarding-service/deployment.yaml, devcontainer-features/mesh-six-tools/
- Do NOT touch any other files

**Context:**
- build-deploy.yaml: add onboarding-service and context-service to BUILDABLE_AGENTS
- test.yaml: add auth-service, implementer, llm-service, context-service, onboarding-service to ALL_APPS
- prod overlay: add image entries for auth-service, implementer, onboarding-service, context-service
- ExternalSecret: follow the exact pattern in vault-external-secrets.yaml but for mesh-six-secrets
  with keys: PG_USER, PG_PASSWORD, GITHUB_TOKEN, VAULT_TOKEN, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
  LITELLM_ADMIN_KEY, GIT_USERNAME, GIT_PASSWORD
- Publish workflow: use @devcontainers/cli to publish the mesh-six-tools feature as OCI artifact
  to registry.bto.bar

**Validation:**
- YAML syntax check on all modified/created files
- kubectl apply --dry-run=client on new K8s manifests (if kubectl available)

**When complete:**
- Mark your tasks as completed via TaskUpdate
- Send completion report via SendMessage to the team lead
```

---

## Deferred Items (Follow-up Plan)

These items were identified in the audit but are deferred:

| Item | Reason for Deferral |
|------|-------------------|
| Dashboard onboarding view | UI feature, not a blocker — users can use MCP tools or REST API |
| ntfy reply URL (Dapr-internal) | Requires ingress/tunnel setup, infrastructure decision needed |
| E2E test suite in CI | Test infrastructure project, not blocking first onboard |
| Orchestrator in-memory state recovery | Important for reliability but not blocking initial use |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Anthropic OAuth device flow endpoint not publicly documented | Fall back to spawning `claude auth login` with pty capture; or skip OAuth in first iteration and have users push credentials manually via `scripts/push-credentials.ts` |
| Vault KV v2 API differences | Test Vault lookup in dev before deploying; webhook-receiver falls back to env var |
| Gitea OCI registry doesn't support devcontainer feature format | Test `devcontainer features publish` against Gitea; fall back to hosting feature on GitHub Container Registry (ghcr.io) |
| Octokit Contents API rate limits during manifest generation | Each onboard creates ~4 files — well within GitHub's 5000 req/hr limit |
| webhook-receiver PG dependency adds failure mode | Connection pooling with retry; fall back to single-project mode on DB failure |
