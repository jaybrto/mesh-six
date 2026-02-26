# GWA Bug Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three bugs carried over from GWA (destructive credential extraction, status schema weakness, lexical S3 sort) and address lower-priority items (try/finally resource cleanup, module-load-time env vars).

**Architecture:** Changes span three independent services (llm-service, project-manager, implementer) with no shared dependencies between fixes. Each service's changes are self-contained — no Phase 1 foundation needed.

**Tech Stack:** Bun, TypeScript, PostgreSQL, AWS SDK v3 (S3), Hono

---

## Context

Three bugs were identified via codebase audit against known GWA issues. All three exist in this codebase:

1. **Bug 1 — Destructive credential extraction** (`apps/llm-service/`): `downloadAndExtract` writes tar contents directly into the live credential directory. If MinIO is unreachable mid-stream or tar fails, the directory is left in a corrupt partial state. The `tryNextCredential` rotation loop makes this worse — each failed iteration further corrupts the same directory.

2. **Bug 2 — Status schema weakness** (`apps/project-manager/`): `pm_workflow_instances.status` has no database CHECK constraint and the TypeScript interface types it as bare `string`. A typo like `"complete"` instead of `"completed"` would be silently accepted by both the database and the compiler.

3. **Bug 3 — Lexical S3 key order** (`apps/llm-service/`): `listCredentials` and `listActorConfigs` call `.map(obj => obj.Key!)` which discards `LastModified`. The returned array is in lexical key order (per S3 spec for ListObjectsV2), not temporal order. Callers that intend to select "newest" credentials get alphabetical ordering instead.

**Lower-priority items also addressed:**
- Missing try/finally guards on tmux session and worktree creation in implementer
- Missing failure path cleanup (no `onDeactivate` call, no session status update) in implementer's `handleTask`
- Module-load-time env var capture in llm-service and implementer config modules (hurts testability)

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Credential staging | Temp dir + backup + atomic swap with rollback | Ensures live credentials are never corrupted — extracts to staging dir, backs up existing dir, swaps atomically, restores on failure |
| S3 list return type | `S3Object { key, lastModified }[]` sorted desc | Preserves temporal metadata for callers; sort by lastModified descending so index-based selection picks newest |
| PM status safety | DB CHECK constraint + TypeScript union | Defense in depth — catches mismatches at both the database and compiler level |
| Env var pattern | Lazy `getEnv(key)` function per config module | Reads `process.env` at call time (not import time), centralizes defaults, type-safe keys, testable |
| Resource cleanup | try/finally + failure path `onDeactivate` | Prevents orphaned tmux sessions, worktrees, and stale DB rows on unexpected exceptions |

---

## Files Modified

| File | Changes |
|------|---------|
| `apps/llm-service/src/config.ts` | Replace top-level `export const` env reads with lazy `getEnv()` function |
| `apps/llm-service/src/minio-client.ts` | Staging extraction in `downloadAndExtract`, `S3Object` return type for list functions, sort by `lastModified` desc |
| `apps/llm-service/src/claude-cli-actor.ts` | Update callers for `S3Object` type, `onActivate` cleanup on validation failure, safe `tryNextCredential` |
| `apps/llm-service/src/auth-client.ts` | Move env reads inside functions or use `getEnv()` |
| `apps/llm-service/src/router.ts` | Update config imports to use `getEnv()` |
| `apps/llm-service/src/index.ts` | Update config imports to use `getEnv()` |
| `apps/llm-service/src/app.ts` | Update config imports to use `getEnv()` |
| `apps/llm-service/src/actor-runtime.ts` | Update config imports to use `getEnv()` |
| `apps/llm-service/src/cli-spawner.ts` | Update config imports to use `getEnv()` |
| `apps/project-manager/src/index.ts` | Narrow `WorkflowInstanceRow.status` from `string` to union type |
| `apps/implementer/src/config.ts` | Replace top-level `export const` env reads with lazy `getEnv()` function |
| `apps/implementer/src/actor.ts` | try/finally in `startSession`, update config imports |
| `apps/implementer/src/index.ts` | Failure path cleanup (`onDeactivate` calls, session status updates), update config imports |
| `apps/implementer/src/monitor.ts` | Update config imports to use `getEnv()` |
| `apps/implementer/src/session-db.ts` | Update config imports to use `getEnv()` |

## Files Created

| File | Purpose |
|------|---------|
| `migrations/009_pm_status_constraint.sql` | Add CHECK constraint to `pm_workflow_instances.status` |
| `apps/llm-service/src/__tests__/minio-client.test.ts` | Tests for staging extraction, rollback, and S3Object sort order |

---

## Detailed Implementation

### Bug 1 Fix: Safe Credential Extraction

**File:** `apps/llm-service/src/minio-client.ts` — `downloadAndExtract` function (currently lines 61-100)

Replace the current direct extraction with a staging + atomic swap pattern:

```typescript
export async function downloadAndExtract(
  key: string,
  targetDir: string,
  bucket?: string,
): Promise<void> {
  const client = getClient();
  const staging = `${targetDir}.staging-${Date.now()}`;
  const backup = `${targetDir}.backup-${Date.now()}`;

  mkdirSync(staging, { recursive: true });

  try {
    // 1. Download and extract into staging directory
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket || getEnv("MINIO_BUCKET"), Key: key }),
    );
    if (!response.Body) throw new Error(`Empty response body for key: ${key}`);

    const bodyBytes = await response.Body.transformToByteArray();
    const proc = Bun.spawn(["tar", "xzf", "-", "-C", staging], {
      stdin: new Blob([bodyBytes]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar extraction failed (exit ${exitCode}): ${stderr}`);
    }

    // 2. Atomic swap: backup existing → rename staging → cleanup backup
    if (existsSync(targetDir)) {
      renameSync(targetDir, backup);
    }
    try {
      renameSync(staging, targetDir);
      // Success — remove backup
      if (existsSync(backup)) rmSync(backup, { recursive: true });
    } catch (swapErr) {
      // Swap failed — restore from backup
      if (existsSync(backup)) renameSync(backup, targetDir);
      throw swapErr;
    }

    log(`Extracted ${key} → ${targetDir}`);
  } catch (err) {
    // Clean up staging on any failure
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw err;
  }
}
```

**Also in `claude-cli-actor.ts`:** In `onActivate` (around line 130-138), when `validateCLI` fails after config directory creation, call `cleanupDir(this.configDir)` before setting `this.status = "unhealthy"`.

### Bug 3 Fix: Temporal S3 Sort

**File:** `apps/llm-service/src/minio-client.ts`

```typescript
export interface S3Object {
  key: string;
  lastModified: Date;
}

export async function listCredentials(prefix = "creds/"): Promise<S3Object[]> {
  const client = getClient();
  const response = await client.send(
    new ListObjectsV2Command({ Bucket: getEnv("MINIO_BUCKET"), Prefix: prefix }),
  );
  return (response.Contents || [])
    .filter((obj) => obj.Key?.endsWith(".tar.gz"))
    .map((obj) => ({ key: obj.Key!, lastModified: obj.LastModified || new Date(0) }))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}
```

Same pattern for `listActorConfigs`. Then update all callers in `claude-cli-actor.ts` to access `.key` property instead of using strings directly.

### Bug 2 Fix: Status Schema Safety

**Migration** `009_pm_status_constraint.sql`:
```sql
ALTER TABLE pm_workflow_instances
  ADD CONSTRAINT pm_workflow_instances_status_check
  CHECK (status IN ('active', 'blocked', 'completed', 'failed'));
```

**TypeScript** in `apps/project-manager/src/index.ts`: change `WorkflowInstanceRow`:
```typescript
// Before:
status: string;

// After:
status: "active" | "blocked" | "completed" | "failed";
```

### Implementer Cleanup

**`actor.ts` — `startSession` try/finally:**
```typescript
async startSession(params: StartSessionParams): Promise<StartResult> {
  const tmuxSessionName = `impl-${params.sessionId}`;
  await createSession(tmuxSessionName);
  try {
    await sendCommand(tmuxSessionName, `cd ${worktreeDir}`);
    // ... remaining setup
    this.state.status = "running";
    await updateSessionStatus(params.sessionId, "running");
    return { ok: true };
  } catch (err) {
    // Clean up the tmux session we just created
    try { await killSession(tmuxSessionName); } catch { /* best effort */ }
    throw err;
  }
}
```

**`index.ts` — `handleTask` failure paths:**
```typescript
if (!activateResult.ok) {
  await updateSessionStatus(sessionId, "failed", activateResult.error);
  await actor.onDeactivate();
  // ... publish failure result
  return;
}

if (!startResult.ok) {
  await updateSessionStatus(sessionId, "failed", startResult.error);
  await actor.onDeactivate();
  // ... publish failure result
  return;
}
```

### Env Var Refactor Pattern

Both `apps/llm-service/src/config.ts` and `apps/implementer/src/config.ts` follow the same refactor:

```typescript
// Before (captured at import time):
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.minio:9000";

// After (read at call time):
const DEFAULTS = {
  MINIO_ENDPOINT: "http://minio.minio:9000",
  MINIO_REGION: "us-east-1",
  // ... all env-backed constants
} as const;

type ConfigKey = keyof typeof DEFAULTS;

export function getEnv<K extends ConfigKey>(key: K): string {
  return process.env[key] || DEFAULTS[key];
}

// Non-env constants stay as-is:
export const AGENT_ID = "llm-service";
```

Callers change from `import { MINIO_ENDPOINT } from "../config.js"` to `import { getEnv } from "../config.js"` and use `getEnv("MINIO_ENDPOINT")`.

For `auth-client.ts` in llm-service: move the three env reads (`AUTH_PROJECT_ID`, `DAPR_HOST`, `DAPR_HTTP_PORT`) into `config.ts`'s DEFAULTS and use `getEnv()`, or read `process.env` directly inside functions. Consolidating into config.ts is preferred for consistency.

**Note:** `hooks/event-publisher.ts` reads env at module level but runs as a fresh subprocess per invocation — this is correct by design and should NOT be changed.

---

## Acceptance Criteria

- [ ] `downloadAndExtract` stages to temp dir, validates, swaps atomically, and rolls back on failure
- [ ] Live credential directory is never left in a corrupt state on extraction failure
- [ ] `listCredentials` and `listActorConfigs` return `S3Object[]` sorted by `lastModified` descending
- [ ] `tryNextCredential` and `onActivate` use `.key` from `S3Object` correctly
- [ ] `onActivate` cleans up config directory when `validateCLI` fails
- [ ] `pm_workflow_instances.status` has a CHECK constraint for `('active', 'blocked', 'completed', 'failed')`
- [ ] `WorkflowInstanceRow.status` is typed as `"active" | "blocked" | "completed" | "failed"`
- [ ] `startSession` in implementer wraps post-creation code in try/catch with tmux cleanup
- [ ] `handleTask` in implementer calls `onDeactivate` and updates session status on failure paths
- [ ] LLM service config uses lazy `getEnv()` — all files updated
- [ ] Implementer config uses lazy `getEnv()` — all files updated
- [ ] All 22 packages typecheck
- [ ] All existing tests pass
- [ ] New minio-client tests pass (staging rollback, S3Object sort order)

---

## Agent Teams Execution Plan

### Team Structure

- **Lead**: Verifies baseline, spawns teammates, runs integration subagent, bumps versions + docs
- **Teammate A (llm-service-fixes)**: Bug 1 + Bug 3 + onActivate cleanup + env var refactor (10 files)
- **Teammate B (pm-status-fix)**: Bug 2 migration + type narrowing (2 files)
- **Teammate C (implementer-cleanup)**: try/finally + failure path cleanup + env var refactor (5 files)

### Phase 1: Baseline Verification (Sequential — Team Lead Only)

**Task 1.1: Verify clean baseline**
- Run `bun run typecheck` — confirm all 22 packages pass
- Run `bun run --filter @mesh-six/core test && bun run --filter @mesh-six/project-manager test`
- Verification gate: all pass with zero failures

No shared foundation code is needed — the three work streams modify independent services with no cross-dependencies.

### Phase 2: Parallel Implementation (3 Teammates)

#### Teammate A: LLM Service Fixes

**Subagent type:** `bun-service`

**Exclusively owns:**
- `apps/llm-service/src/config.ts`
- `apps/llm-service/src/minio-client.ts`
- `apps/llm-service/src/claude-cli-actor.ts`
- `apps/llm-service/src/auth-client.ts`
- `apps/llm-service/src/router.ts`
- `apps/llm-service/src/index.ts`
- `apps/llm-service/src/app.ts`
- `apps/llm-service/src/actor-runtime.ts`
- `apps/llm-service/src/cli-spawner.ts`
- `apps/llm-service/src/__tests__/minio-client.test.ts` (NEW)

**Reads (no writes):**
- `packages/core/src/*`

**Tasks (in order):**

1. **Env var refactor — `config.ts`**: Replace all `export const X = process.env.X || default` with a centralized `getEnv()` function. Keep non-env constants (`AGENT_ID`, `DAPR_ACTOR_CONFIG`, etc.) as-is. The `getEnv` function must be type-safe with a `DEFAULTS` record. For numeric values like `APP_PORT` and `MAX_ACTORS`, add a `getEnvNum(key, fallback)` variant. Move `AUTH_PROJECT_ID`, `DAPR_HOST`, `DAPR_HTTP_PORT` from `auth-client.ts` into config's DEFAULTS.

2. **Update all config callers**: Change every file that imports individual constants from config to use `getEnv()`. Files to update: `minio-client.ts`, `claude-cli-actor.ts`, `auth-client.ts`, `router.ts`, `index.ts`, `app.ts`, `actor-runtime.ts`, `cli-spawner.ts`. Do NOT modify `hooks/event-publisher.ts` — it runs as a fresh subprocess where module-level capture is correct.

3. **Bug 1 — Safe extraction in `minio-client.ts`**: Rewrite `downloadAndExtract` to use the staging + backup + atomic swap pattern described in the Detailed Implementation section above. Import `renameSync`, `rmSync` from `node:fs`.

4. **Bug 3 — S3Object return type in `minio-client.ts`**: Add `S3Object` interface. Change `listCredentials` and `listActorConfigs` to return `S3Object[]` sorted by `lastModified` descending. Filter `.tar.gz` before mapping.

5. **Bug 3 callers — `claude-cli-actor.ts`**: Update `onActivate` to use `credentialKeys[index].key` instead of `credentialKeys[index]`. Update `tryNextCredential` loop similarly. Update `this.credentialKey` assignments to use `.key`.

6. **Cleanup — `claude-cli-actor.ts` onActivate**: When `validateCLI` fails after credential loading (the unhealthy path), call `cleanupDir(this.configDir)` before setting `this.status = "unhealthy"` and returning. This prevents an orphaned config directory from persisting indefinitely.

7. **Tests — `__tests__/minio-client.test.ts`** (NEW file): Write tests using `bun:test`. Mock the S3 client using `mock()`. Test cases:
   - `downloadAndExtract` populates targetDir on success
   - `downloadAndExtract` preserves existing targetDir on tar failure (staging rollback)
   - `downloadAndExtract` preserves existing targetDir on S3 download failure
   - `listCredentials` returns S3Object[] with key and lastModified
   - `listCredentials` sorts by lastModified descending (provide shuffled dates, verify order)
   - `listActorConfigs` follows the same contract

**Validation:** `bun run --filter @mesh-six/llm-service typecheck && bun test apps/llm-service/src/__tests__/`

---

#### Teammate B: PM Status Fix

**Subagent type:** `bun-service`

**Exclusively owns:**
- `migrations/009_pm_status_constraint.sql` (NEW)
- `apps/project-manager/src/index.ts`

**Reads (no writes):**
- `migrations/004_pm_workflow_instances.sql` (understand existing schema)
- `migrations/008_pm_retry_budget.sql` (understand latest schema additions)
- `apps/project-manager/src/workflow.ts` (understand status values used in workflow)
- `apps/project-manager/src/__tests__/` (understand existing test patterns)

**Tasks:**

1. **Migration — `009_pm_status_constraint.sql`**: Create the migration file:
   ```sql
   -- Add CHECK constraint to pm_workflow_instances.status
   -- Valid values: active, blocked, completed, failed
   ALTER TABLE pm_workflow_instances
     ADD CONSTRAINT pm_workflow_instances_status_check
     CHECK (status IN ('active', 'blocked', 'completed', 'failed'));
   ```

2. **Type narrowing — `index.ts`**: Find the `WorkflowInstanceRow` interface (around line 117). Change `status: string` to `status: "active" | "blocked" | "completed" | "failed"`. Define a type alias `type WorkflowStatus = "active" | "blocked" | "completed" | "failed"` above the interface and use it in both the interface and the `updateStatus` helper function's parameter type. Verify the compiler accepts all existing `updateStatus()` call sites — they should already pass valid literal strings.

**Validation:** `bun run --filter @mesh-six/project-manager typecheck && bun run --filter @mesh-six/project-manager test`

---

#### Teammate C: Implementer Cleanup

**Subagent type:** `bun-service`

**Exclusively owns:**
- `apps/implementer/src/config.ts`
- `apps/implementer/src/actor.ts`
- `apps/implementer/src/index.ts`
- `apps/implementer/src/monitor.ts`
- `apps/implementer/src/session-db.ts`

**Reads (no writes):**
- `apps/implementer/src/tmux.ts` (understand `createSession`, `killSession`, `sessionExists` API)
- `packages/core/src/types.ts` (session schemas)

**Tasks:**

1. **Env var refactor — `config.ts`**: Same pattern as llm-service. Replace `export const X = process.env.X || default` with a `getEnv()` function using typed DEFAULTS. For numeric values (`APP_PORT`, `DAPR_HTTP_PORT`), add `getEnvNum()`. Keep static constants (`AGENT_ID = "implementer"`, `AGENT_NAME = "Implementer"`) as plain exports.

2. **Update config callers**: Update imports in `actor.ts`, `index.ts`, `monitor.ts`, `session-db.ts` to use `getEnv()` / `getEnvNum()`.

3. **try/finally in `startSession` (`actor.ts`)**: Find the `startSession` method. After `createSession(tmuxSessionName)` succeeds, wrap all subsequent operations (sendCommand, handleStartupDialogs, updateSessionStatus, etc.) in a try block. In the catch block, call `killSession(tmuxSessionName)` (best-effort, wrapped in its own try/catch), then re-throw. This ensures the tmux session is cleaned up if any subsequent step fails.

4. **Failure path cleanup in `handleTask` (`index.ts`)**: Find the two failure paths:
   - When `activateResult.ok === false` (around lines 201-212): Before publishing the failure task result, add `await updateSessionStatus(sessionId, "failed", activateResult.error)` and `try { await actor.onDeactivate(); } catch {}`.
   - When `startResult.ok === false` (around lines 216-227): Same — add `await updateSessionStatus(sessionId, "failed", startResult.error)` and `try { await actor.onDeactivate(); } catch {}`.
   - Import `updateSessionStatus` from `./session-db.js` if not already imported.

**Validation:** `bun run --filter @mesh-six/implementer typecheck`

---

### Phase 3: Integration + Testing (Sequential — Integration Subagent)

Spawn a fresh integration subagent (via `Task` tool, `run_in_background: false`) with this prompt:

> Read all files modified by the three teammates:
> - `apps/llm-service/src/config.ts`, `minio-client.ts`, `claude-cli-actor.ts`, `auth-client.ts`, `router.ts`, `index.ts`, `app.ts`, `actor-runtime.ts`, `cli-spawner.ts`, `__tests__/minio-client.test.ts`
> - `migrations/009_pm_status_constraint.sql`, `apps/project-manager/src/index.ts`
> - `apps/implementer/src/config.ts`, `actor.ts`, `index.ts`, `monitor.ts`, `session-db.ts`
>
> Verify consistency across all changes. Fix any integration issues (broken imports, type mismatches). Then run:
> 1. `bun run typecheck` (all 22 packages)
> 2. `bun run --filter @mesh-six/core test`
> 3. `bun run --filter @mesh-six/project-manager test`
> 4. `bun test apps/llm-service/src/__tests__/`
>
> Return a summary of all fixes made and verification results.

**Lead then:**
- Reviews integration summary
- Bumps versions: llm-service (patch), project-manager (patch), implementer (patch)
- Updates CHANGELOG.md
- Commits all changes

---

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead** | `CHANGELOG.md`, `*/package.json` (version bumps only) | Everything |
| **A (llm-service)** | `apps/llm-service/src/config.ts`, `minio-client.ts`, `claude-cli-actor.ts`, `auth-client.ts`, `router.ts`, `index.ts`, `app.ts`, `actor-runtime.ts`, `cli-spawner.ts`, `__tests__/minio-client.test.ts` | `packages/core/src/*` |
| **B (pm-status)** | `migrations/009_pm_status_constraint.sql`, `apps/project-manager/src/index.ts` | `migrations/004_pm_workflow_instances.sql`, `apps/project-manager/src/workflow.ts` |
| **C (implementer)** | `apps/implementer/src/config.ts`, `actor.ts`, `index.ts`, `monitor.ts`, `session-db.ts` | `apps/implementer/src/tmux.ts`, `packages/core/src/types.ts` |

### Task Dependency DAG

```
Phase 1 (Lead):
  1.1 Verify baseline ──── Must complete before Phase 2

Phase 2 (Parallel):
  A: LLM Service Fixes ────┐
  B: PM Status Fix ─────────┼── All must complete before Phase 3
  C: Implementer Cleanup ───┘

Phase 3 (Lead → Integration Subagent):
  3.1 Integration fixes ──► 3.2 Typecheck ──► 3.3 Tests ──► 3.4 Version bumps + docs
```

### Claude Code Session Setup

**Prerequisites:**
Enable Agent Teams in your settings:
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Execution steps:**

1. Start Claude Code in the project directory
2. Tell Claude: `@docs/plans/2026-02-25-gwa-bug-fixes.md following Claude Code Session Setup instructions`
3. Claude spawns an Explore subagent to confirm codebase matches expected state
4. Claude creates a feature branch: `git checkout -b fix/gwa-bugs`
5. Claude creates the full task list with dependencies:
   - Task 1: Phase 1 baseline verification
   - Task 2: Phase 2A — LLM Service Fixes (blocked by Task 1)
   - Task 3: Phase 2B — PM Status Fix (blocked by Task 1)
   - Task 4: Phase 2C — Implementer Cleanup (blocked by Task 1)
   - Task 5: Phase 3 — Integration (blocked by Tasks 2, 3, 4)
6. Claude runs baseline verification directly (small context cost)
7. Claude calls `TeamCreate` to establish a team named `gwa-bug-fixes`
8. Claude creates team-scoped tasks via `TaskCreate`
9. Claude spawns three teammates via `Task` tool:
   - `name: "llm-service-fixes"`, `subagent_type: "bun-service"`, `run_in_background: true`
   - `name: "pm-status-fix"`, `subagent_type: "bun-service"`, `run_in_background: true`
   - `name: "implementer-cleanup"`, `subagent_type: "bun-service"`, `run_in_background: true`
10. Claude monitors via `sleep 30` + `TaskList` polling
11. When all teammates complete, Claude sends `shutdown_request` to each
12. Claude spawns integration subagent (fresh context) per Phase 3 instructions
13. Claude reviews integration summary, runs verification independently
14. Claude bumps versions, updates CHANGELOG, commits

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `renameSync` fails on cross-filesystem move | Staging swap leaves both staging and backup dirs | Both staging and target are under the same `/tmp` tree — same filesystem guaranteed. The backup-restore catch block handles the unlikely rename failure. |
| CHECK constraint fails on existing data with unexpected status | Migration fails, blocks deployment | Audit confirmed only `active`, `blocked`, `completed`, `failed` are written. Run `SELECT DISTINCT status FROM pm_workflow_instances` in integration to verify before applying. |
| `getEnv()` refactor breaks callers that destructure config imports | TypeScript compilation failures | Teammate A/C run typecheck after every file change. Integration subagent runs full typecheck. |
| Implementer `onDeactivate` throws during failure cleanup | Double-throw masks original error | Wrap `onDeactivate()` calls in try/catch in the failure paths — best-effort cleanup. |
| S3Object type change breaks other code that calls `listCredentials` | Compilation errors in unexpected files | `listCredentials` and `listActorConfigs` are only called within `claude-cli-actor.ts` (confirmed by audit). No external consumers. |
