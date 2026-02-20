# GWA Orchestrator Credential Integration Plan

**Date:** 2026-02-19
**Status:** Ready for implementation
**Approach:** Option A — Call GWA orchestrator directly from mesh-six llm-service

## Background

The mesh-six `llm-service` spawns Claude CLI actors (Dapr virtual actors) that each need valid OAuth credentials. Currently, credentials are manually placed in MinIO as tar.gz archives (`creds/0.tar.gz`, `creds/1.tar.gz`, etc.) and actors pick them up at activation. There's no automated credential refresh — when tokens expire, actors go unhealthy.

The **GitHub Workflow Agents (GWA)** project at `/Users/jay.barreto/dev/util/bto/github-workflow-agents` has already solved this problem with a full credential lifecycle engine. Rather than duplicating that logic, mesh-six should call GWA's orchestrator API to provision credential bundles.

## How GWA Credential Provisioning Works

### GWA Orchestrator (`environment-provisioner.ts`)

- **SQLite-backed** with 3 tables: `projects`, `project_credentials`, `environment_bundles`
- **Credential lifecycle:** push → store → bundle → distribute → auto-refresh → cleanup
- **OAuth refresh:** Calls `console.anthropic.com/v1/oauth/token` with `refresh_token`, proactive 30-min timer refreshes tokens expiring within 60 minutes
- **Bundle generation:** Creates immutable tar.gz with:
  - `.claude/.credentials.json` — Full OAuth with `claudeAiOauth` nested object (accessToken, refreshToken, expiresAt, accountUuid, emailAddress, etc.)
  - `.config/claude/config.json` — Ephemeral config with flat `oauthToken` field
  - `.claude/settings.json` — Optional, from project config
  - `.claude.json` — Optional TUI settings
- **Immutable bundles:** Each provision generates a new bundle uploaded to MinIO at `env-bundles/{projectId}/{uuid}.tar.gz`

### GWA REST API (`rest-api.ts`, port 3001)

All endpoints require `Authorization: Bearer {GWA_API_KEY}`.

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /projects/:id/provision` | POST | **Main endpoint.** Request a credential bundle. Returns `{status, bundleId, s3Key, s3Bucket, credentialExpiresAt}` |
| `POST /projects/:id/credentials` | POST | Push fresh credentials (accessToken, refreshToken, expiresAt, etc.) |
| `POST /projects/:id/refresh` | POST | Force OAuth refresh |
| `GET /projects/:id/health` | GET | Credential health status (hasValidCredential, expiresAt, hasRefreshToken) |
| `GET /projects/:id` | GET | Project config + credential health |
| `POST /projects` | POST | Create a project |

### Key Types (from `src/shared/types.ts`)

```typescript
interface ProvisionRequest {
  podName: string;
  currentBundleId?: string;  // Skip re-generation if bundle is still current
}

interface ProvisionResponse {
  status: 'current' | 'provisioned' | 'no_credentials';
  bundleId?: string;
  s3Key?: string;           // MinIO key to download the tar.gz
  s3Bucket?: string;
  credentialExpiresAt?: number;  // Unix timestamp ms
  message?: string;
}

interface CredentialHealth {
  projectId: string;
  hasValidCredential: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  hasRefreshToken: boolean;
  lastRefreshAt?: number;
  activeBundleId?: string;
}
```

### Provision Flow (from `provision.ts`)

```
1. POST /projects/{projectId}/provision  body: { podName }
2. If status === "current"     → skip, credentials still valid
3. If status === "no_credentials" → warn, no creds available
4. If status === "provisioned" → download s3Key from MinIO, extract to $HOME
```

## Current mesh-six Actor Lifecycle

### `ClaudeCLIActor.onActivate()` (`apps/llm-service/src/claude-cli-actor.ts:66-136`)

```
1. Create config directory at /tmp/llm-service/actors/{actorId}
2. Create .claude subdirectory
3. List credentials from MinIO (creds/ prefix)
4. Pick credential set by actor index (round-robin)
5. Download and extract tar.gz to config directory
6. Download actor-specific config (optional)
7. Validate credentials with lightweight CLI test (claude -p "Respond with exactly: OK")
8. If validation fails, try next credential set
9. If all fail, mark actor as unhealthy
10. Register Dapr timer for periodic credential sync (CREDENTIAL_SYNC_INTERVAL, default 5m)
11. Save actor state to Dapr state store
```

### `ClaudeCLIActor.syncCredentials()` timer callback

Currently just archives the local config dir back to MinIO (preserving any credential file changes the CLI may have made). This is where we'd add re-provisioning logic.

### `cli-spawner.ts` environment setup

The spawner sets `HOME` and `CLAUDE_CONFIG_DIR` to the actor's config directory, plus `CI=true` to skip interactive prompts. The GWA bundle extracts `.claude/.credentials.json` and `.config/claude/config.json` relative to `$HOME`, which maps directly to the actor config dir.

### Credential format difference

| Source | File | Format |
|---|---|---|
| GWA bundle | `.claude/.credentials.json` | `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }` |
| mesh-six `preloadClaudeConfig()` | `.claude/.credentials.json` | `{ oauthToken: "...", oauthAccount: { ... } }` |
| GWA bundle | `.config/claude/config.json` | `{ oauthToken: "..." }` |

**This difference is irrelevant** because:
1. The GWA bundle includes BOTH formats (`.credentials.json` with `claudeAiOauth` and `config.json` with flat `oauthToken`)
2. The Claude CLI reads from both locations
3. We'll extract the GWA bundle directly to the actor config dir, which the CLI reads via `HOME=configDir`

## Integration Architecture

```
┌─────────────────────┐     POST /projects/mesh-six/provision
│  mesh-six           │────────────────────────────────────────►┌─────────────────┐
│  llm-service        │                                         │  GWA             │
│  ClaudeCLIActor     │     { status: "provisioned",           │  Orchestrator    │
│                     │◄──  s3Key: "env-bundles/mesh-six/..." } │  :3001           │
│                     │                                         │                  │
│  downloadAndExtract │     GET s3Key from MinIO                │  Handles:        │
│  (existing MinIO    │────────────────────────────────────────►│  - OAuth refresh │
│   client)           │     tar.gz bundle                       │  - Bundle gen    │
│                     │◄────────────────────────────────────────│  - Expiry alerts │
└─────────────────────┘                                         └─────────────────┘
```

## Detailed Implementation Plan

### Phase 1: Add GWA Provisioner Client to llm-service

**New file: `apps/llm-service/src/gwa-client.ts`**

A thin HTTP client for the GWA orchestrator's provisioning API.

```typescript
// New config constants in config.ts
export const GWA_ORCHESTRATOR_URL = process.env.GWA_ORCHESTRATOR_URL || "";  // e.g., "http://gwa-orchestrator.gwa:3001"
export const GWA_API_KEY = process.env.GWA_API_KEY || "";
export const GWA_PROJECT_ID = process.env.GWA_PROJECT_ID || "mesh-six";
```

Functions to implement:
- `provisionFromGWA(podName: string, currentBundleId?: string): Promise<GWAProvisionResult>`
  - Calls `POST /projects/{GWA_PROJECT_ID}/provision`
  - Returns `{ status, bundleId, s3Key, s3Bucket, credentialExpiresAt }` or `null` on failure
  - 10s timeout, graceful failure (returns null, doesn't throw)
- `checkGWAHealth(): Promise<GWACredentialHealth | null>`
  - Calls `GET /projects/{GWA_PROJECT_ID}/health`
  - Returns credential health info or null on failure
- `isGWAConfigured(): boolean`
  - Returns `true` if `GWA_ORCHESTRATOR_URL` and `GWA_API_KEY` are both set

### Phase 2: Modify Actor Activation to Use GWA

**Modify: `apps/llm-service/src/claude-cli-actor.ts`**

Change `onActivate()` to attempt GWA provisioning first, falling back to the existing MinIO credential loading:

```
onActivate():
  1. Create config directories (unchanged)
  2. NEW: If GWA is configured (GWA_ORCHESTRATOR_URL + GWA_API_KEY set):
     a. Call provisionFromGWA(actorId)
     b. If status === "provisioned":
        - Download s3Key using existing downloadAndExtract() from minio-client
          NOTE: The GWA orchestrator and mesh-six may use different MinIO buckets.
          The provision response includes s3Bucket. The gwa-client should handle
          downloading from the GWA's bucket (which may be "gwa-recordings" vs
          mesh-six's "llm-service"). We may need to add a second S3 client
          pointing to the same MinIO endpoint but different bucket, OR pass the
          bucket override to downloadAndExtract.
        - Store bundleId for later re-provision checks
        - Store credentialExpiresAt for proactive refresh
        - Skip to step 5 (validation)
     c. If status === "current":
        - Credentials still valid, skip to step 5
     d. If status === "no_credentials" or null:
        - Fall through to existing MinIO credential loading
  3. EXISTING FALLBACK: List credentials from MinIO (creds/ prefix)
  4. EXISTING: Pick credential by index, download and extract
  5. Download actor-specific config (unchanged)
  6. Validate credentials with CLI test (unchanged)
  7. If validation fails, try next credential (unchanged)
  8. Register timers (modified, see Phase 3)
  9. Save state (unchanged)
```

### Phase 3: Add Credential Refresh Timer

**Modify the `syncCredentials` timer in `claude-cli-actor.ts`**

The current timer just syncs files back to MinIO. Enhance it to also check credential expiry and re-provision from GWA when needed.

New timer behavior:
```
syncCredentials():
  1. If GWA-provisioned (bundleId is set):
     a. Check if credentialExpiresAt is within 30 minutes
     b. If expiring soon:
        - Call provisionFromGWA(actorId, currentBundleId)
        - If new bundle received, download and extract
        - Update credentialExpiresAt and bundleId
     c. Always: archive current config dir back to MinIO as backup
  2. If NOT GWA-provisioned (legacy mode):
     a. Archive config dir to MinIO (existing behavior)
```

Add a new private field to `ClaudeCLIActor`:
```typescript
private gwaBundleId: string | null = null;
private credentialExpiresAt: number | null = null;
```

### Phase 4: Handle Auth Errors with GWA Re-provision

**Modify the `complete()` method in `claude-cli-actor.ts`**

When the CLI returns an auth error, attempt to re-provision from GWA before marking as unhealthy:

```
// In complete(), after detecting isAuthError:
if (result.isAuthError && isGWAConfigured()) {
  const provision = await provisionFromGWA(this.actorId);
  if (provision?.status === "provisioned" && provision.s3Key) {
    await downloadAndExtract(provision.s3Key, this.configDir, provision.s3Bucket);
    this.gwaBundleId = provision.bundleId;
    this.credentialExpiresAt = provision.credentialExpiresAt;
    // Retry the request once
    const retry = await spawnCLI({ ...originalOpts });
    if (!retry.isAuthError) {
      // Success after re-provision
      return buildCompletionResponse(retry.content, model);
    }
  }
  // Still failing — mark unhealthy
}
```

### Phase 5: K8s Configuration

**New env vars for llm-service deployment:**

```yaml
# k8s/base/llm-service/deployment.yaml
env:
  - name: GWA_ORCHESTRATOR_URL
    value: "http://gwa-orchestrator.gwa:3001"  # Or whatever namespace/service name GWA uses
  - name: GWA_API_KEY
    valueFrom:
      secretKeyRef:
        name: mesh-six-secrets
        key: gwa-api-key
  - name: GWA_PROJECT_ID
    value: "mesh-six"
```

**Vault secret:** Add `gwa-api-key` to `secret/data/mesh-six` in Vault, synced by External Secrets Operator.

**GWA project setup:** Create a `mesh-six` project in the GWA orchestrator:
```bash
curl -X POST http://gwa-orchestrator:3001/projects \
  -H "Authorization: Bearer $GWA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "mesh-six",
    "displayName": "Mesh Six LLM Service",
    "settingsJson": "{\"skipDangerousModePermissionPrompt\":true,\"theme\":\"dark\",\"hasCompletedOnboarding\":true}"
  }'
```

**MinIO bucket access:** The GWA orchestrator writes bundles to the `gwa-recordings` bucket (configurable). The mesh-six llm-service needs read access to this bucket. Options:
1. Use the same MinIO credentials (both already access the same MinIO cluster)
2. Configure GWA to use a shared bucket
3. Add a separate S3 client config for GWA bundles

Recommended: Option 1 — the mesh-six MINIO_ACCESS_KEY should already have access if both services use the same MinIO instance at `minio.minio:9000`. Just pass the `s3Bucket` from the provision response to `downloadAndExtract()`.

### Phase 6: Modify `downloadAndExtract` for Bucket Override

**Modify: `apps/llm-service/src/minio-client.ts`**

Add an optional `bucket` parameter to `downloadAndExtract()`:

```typescript
export async function downloadAndExtract(
  key: string,
  targetDir: string,
  bucket?: string,  // NEW: override default bucket
): Promise<void> {
  // ... existing code, use (bucket || MINIO_BUCKET) instead of MINIO_BUCKET
}
```

### Phase 7: Remove `preloadClaudeConfig()` Dependency

The current `preloadClaudeConfig()` in `packages/core/src/claude.ts` reads from env vars (`CLAUDE_CODE_OAUTH_TOKEN`, etc.) to write credential files. With GWA provisioning, this is no longer needed for llm-service actors since the GWA bundle provides all credential files.

However, `preloadClaudeConfig()` should remain available for other use cases (e.g., simple-agent or other agents that run the CLI directly without the actor model).

**No changes needed** — GWA-provisioned actors won't call `preloadClaudeConfig()` because the bundle extraction creates the credential files directly.

## File Change Summary

| File | Change Type | Description |
|---|---|---|
| `apps/llm-service/src/gwa-client.ts` | **NEW** | GWA orchestrator HTTP client |
| `apps/llm-service/src/config.ts` | **MODIFY** | Add GWA_ORCHESTRATOR_URL, GWA_API_KEY, GWA_PROJECT_ID |
| `apps/llm-service/src/claude-cli-actor.ts` | **MODIFY** | GWA provision in onActivate(), enhanced syncCredentials(), auth retry |
| `apps/llm-service/src/minio-client.ts` | **MODIFY** | Optional bucket param on downloadAndExtract() |
| `k8s/base/llm-service/deployment.yaml` | **MODIFY** | Add GWA env vars |

## Testing Strategy

1. **Unit tests for `gwa-client.ts`:** Mock fetch calls, verify provision request/response handling, timeout behavior, graceful null returns
2. **Unit tests for modified actor activation:** Mock gwa-client, verify GWA-first-then-fallback flow
3. **Integration test:** Run GWA orchestrator locally, provision a mesh-six project, verify bundle download works with mesh-six's MinIO client
4. **Manual k8s test:** Deploy to dev overlay, verify actors activate with GWA credentials, verify credential refresh works on timer

## Rollout Strategy

1. GWA provisioning is **opt-in** via env vars — if `GWA_ORCHESTRATOR_URL` is not set, the existing MinIO credential loading is unchanged
2. Deploy to dev overlay first with GWA env vars
3. Monitor actor activation logs for successful GWA provisions
4. Once validated, add to prod overlay

## Open Questions

1. **Shared MinIO bucket or separate?** Both GWA and mesh-six use the same MinIO cluster. GWA writes bundles to `gwa-recordings` bucket. mesh-six reads from `llm-service` bucket. The `downloadAndExtract()` bucket override solves this cleanly.
2. **GWA orchestrator service discovery:** What namespace does GWA run in? Need the k8s service name for `GWA_ORCHESTRATOR_URL`. If GWA runs outside k8s, need the external URL.
3. **Multiple credential sets:** Currently mesh-six distributes credentials round-robin across actors. With GWA, each provision returns the same bundle (single credential per project). If you need multiple OAuth sessions, create multiple GWA projects (`mesh-six-0`, `mesh-six-1`, `mesh-six-2`).
