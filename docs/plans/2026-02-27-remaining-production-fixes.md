# Remaining Production Readiness Fixes

**Date:** 2026-02-27
**Branch:** `feat/gwa-migration`
**Continues from:** `docs/handoff-2026-02-27-production-readiness.md`

---

## Context

The previous session resolved 12 of 14 production blockers. This plan addresses the 5 remaining **code changes** (items 1-5 from the handoff) plus wiring E2E tests into CI (item 12). Infrastructure/operational steps (items 6-11: Vault secrets, migration 012, devcontainer publish, ArgoCD deploy, auth project, merge to main) are excluded — they require cluster access and will be done manually.

## Scope

| # | Item | Severity | What's Wrong |
|---|------|----------|-------------|
| 1 | Dashboard onboarding view | Medium | No UI for onboarding progress or OAuth device code |
| 2 | ntfy reply URL is Dapr-internal | High | Reply URL `http://localhost:3500/...` unreachable from ntfy.sh |
| 3 | Orchestrator in-memory state recovery | High | `activeTasks` Map lost on pod restart |
| 4 | OAuth device flow validation | Medium | Fragile regex, no retry, permissive URL matching |
| 5 | Webhook receiver K8s env vars | Critical | Missing DATABASE_URL, VAULT_ADDR, VAULT_TOKEN in manifest |
| 12 | E2E tests in CI | Low | Test file exists but no CI workflow job |

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Orchestrator persistence | PostgreSQL `orchestrator_tasks` table | Consistent with rest of system; Dapr state store (Redis) doesn't support complex queries |
| ntfy reply URL | Configurable `MESH_SIX_PUBLIC_URL` env var | Single env var for public-facing base URL, reusable by any service needing external callbacks |
| Dashboard onboarding data | REST fetch from onboarding-service via Dapr | Consistent with existing dashboard patterns (REST + MQTT for real-time) |
| OAuth hardening approach | Stricter regex + configurable timeout + Zod validation | Minimal change; direct Anthropic OAuth API would be a larger rewrite for later |
| E2E CI trigger | `workflow_dispatch` only (not on every PR) | E2E tests take 2+ hours and need live infra; manual trigger is appropriate |

## Database Migration

### Migration 013: `orchestrator_tasks`

```sql
CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  task_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  dispatched_to TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  payload JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orchestrator_tasks_status ON orchestrator_tasks(status);
CREATE INDEX idx_orchestrator_tasks_capability ON orchestrator_tasks(capability);
```

## Files Modified (Existing)

| File | Change |
|------|--------|
| `apps/orchestrator/src/index.ts` | Add DB persistence for activeTasks, startup recovery, graceful shutdown |
| `apps/project-manager/src/index.ts` | Make ntfy topic and reply URL configurable via env vars |
| `apps/onboarding-service/src/activities/initiate-claude-oauth.ts` | Harden regex, add retry, validate output |
| `apps/dashboard/src/App.tsx` | Add `/onboarding` route and nav link |
| `k8s/base/webhook-receiver/deployment.yaml` | Add DATABASE_URL, VAULT_ADDR, VAULT_TOKEN env vars |
| `k8s/base/project-manager/deployment.yaml` | Add NTFY_TOPIC, MESH_SIX_PUBLIC_URL env vars |
| `.github/workflows/test.yaml` | Add E2E test job (workflow_dispatch only) |

## Files Created (New)

| File | Purpose |
|------|---------|
| `migrations/013_orchestrator_tasks.sql` | Orchestrator task persistence table |
| `apps/orchestrator/src/db.ts` | Database module for orchestrator task CRUD |
| `apps/dashboard/src/views/OnboardingView.tsx` | Onboarding status view with OAuth device code display |

## Acceptance Criteria

- [ ] Webhook receiver deployment has DATABASE_URL, VAULT_ADDR, VAULT_TOKEN from mesh-six-secrets
- [ ] Project manager ntfy notification uses configurable topic (`NTFY_TOPIC` env var, default `mesh-six-pm`)
- [ ] Project manager ntfy reply action URL uses `MESH_SIX_PUBLIC_URL` instead of Dapr-internal localhost
- [ ] Orchestrator persists active tasks to PostgreSQL on dispatch, updates on result, deletes on completion
- [ ] Orchestrator recovers in-flight tasks from DB on startup (re-creates timeout timers)
- [ ] Orchestrator checkpoints state to DB on SIGTERM before shutdown
- [ ] OAuth `initiateClaudeOAuth` uses stricter URL regex targeting Claude/Anthropic domains
- [ ] OAuth has retry logic (3 attempts, exponential backoff)
- [ ] OAuth has configurable timeout (env var `CLAUDE_AUTH_TIMEOUT_MS`, default 15000)
- [ ] Dashboard has `/onboarding` route with OnboardingView
- [ ] OnboardingView fetches and displays onboarding runs with status, phase, timestamps
- [ ] OnboardingView shows OAuth device URL and user code when available
- [ ] E2E test job exists in test.yaml, triggered only by workflow_dispatch
- [ ] All 23 packages pass typecheck (`bun run typecheck`)
- [ ] Existing tests continue to pass

---

## Agent Teams Execution Plan

### Team Structure

- **Lead**: Coordinates phases, creates migration, delegates to teammates, runs integration
- **Teammate A** (`config-fixes`): K8s manifests + CI workflow changes
- **Teammate B** (`orchestrator-persistence`): Orchestrator DB persistence
- **Teammate C** (`dashboard-onboarding`): Dashboard onboarding view
- **Teammate D** (`pm-oauth-fixes`): Project manager ntfy fix + OAuth hardening

### Phase 1: Foundation (Sequential — Team Lead Only)

**Task 1.1: Create migration 013_orchestrator_tasks.sql**
- Create `migrations/013_orchestrator_tasks.sql` with the schema above
- Verification: File exists and SQL is valid

**Task 1.2: Verify shared types**
- Confirm `@mesh-six/core` exports any types needed by teammates (OnboardingRun, TaskStatus, etc.)
- No new types expected — orchestrator uses its own internal types, dashboard uses REST responses

**Verification Gate:** Migration file created, no shared type blockers identified.

### Phase 2: Parallel Implementation (4 Teammates)

#### Teammate A: Config & Infrastructure Fixes (`config-fixes`)

**Exclusively Owns:**
- `k8s/base/webhook-receiver/deployment.yaml`
- `k8s/base/project-manager/deployment.yaml`
- `.github/workflows/test.yaml`

**Reads (no writes):**
- `k8s/base/vault-external-secrets-main.yaml` (for secret key names)
- `k8s/base/onboarding-service/deployment.yaml` (reference for env var patterns)
- `tests/e2e/full-lifecycle.test.ts` (understand test requirements)

**Tasks:**
1. Add to `k8s/base/webhook-receiver/deployment.yaml`:
   - `DATABASE_URL` from `mesh-six-secrets` (construct from PG_USER, PG_PASSWORD, or add a dedicated `DATABASE_URL` key — use individual PG_* vars like onboarding-service does for consistency)
   - Actually: add `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER` (from mesh-six-secrets), `PG_PASSWORD` (from mesh-six-secrets) matching the onboarding-service pattern
   - `VAULT_ADDR`: `http://vault.vault.svc.cluster.local:8200`
   - `VAULT_TOKEN` from `mesh-six-secrets`
2. Add to `k8s/base/project-manager/deployment.yaml`:
   - `NTFY_TOPIC` with default value `mesh-six-pm`
   - `MESH_SIX_PUBLIC_URL` with value `https://mesh-six.bto.bar`
3. Add E2E test job to `.github/workflows/test.yaml`:
   - Trigger: `workflow_dispatch` only
   - Runner: `self-hosted, k3s-runner`
   - Timeout: 180 minutes
   - Env: `GITHUB_TOKEN`, `TEST_PROJECT_ID`, `DATABASE_URL`, `TEST_APP_URL` from secrets
   - Steps: checkout, setup bun, install, run `bun test tests/e2e/full-lifecycle.test.ts`

**Validation:** `kubectl apply --dry-run=client -f k8s/base/webhook-receiver/deployment.yaml` (or just YAML syntax check)

#### Teammate B: Orchestrator State Persistence (`orchestrator-persistence`)

**Exclusively Owns:**
- `apps/orchestrator/src/db.ts` (new)
- `apps/orchestrator/src/index.ts`

**Reads (no writes):**
- `migrations/013_orchestrator_tasks.sql` (understand schema)
- `packages/core/src/types.ts` (TaskStatus type)
- `apps/project-manager/src/index.ts` (reference for DB patterns with pg)

**Tasks:**
1. Create `apps/orchestrator/src/db.ts`:
   - Initialize `pg.Pool` from `DATABASE_URL` env var (already in K8s manifest)
   - `saveTask(task)` — INSERT or UPDATE orchestrator_tasks
   - `loadActiveTasks()` — SELECT WHERE status IN ('pending', 'dispatched')
   - `updateTaskStatus(taskId, status, result?)` — UPDATE status + result
   - `deleteTask(taskId)` — DELETE completed tasks
   - `checkpointAll(tasks)` — bulk upsert for graceful shutdown
2. Modify `apps/orchestrator/src/index.ts`:
   - On task dispatch: call `saveTask()` after adding to activeTasks Map
   - On task result: call `updateTaskStatus()` then `deleteTask()` on success
   - On startup: call `loadActiveTasks()`, recreate Map entries and timeout timers
   - On SIGTERM: call `checkpointAll()` before process exit
   - Keep the in-memory Map as primary (fast lookups), DB as persistence layer

**Validation:** `bun run --filter @mesh-six/orchestrator typecheck`

#### Teammate C: Dashboard Onboarding View (`dashboard-onboarding`)

**Exclusively Owns:**
- `apps/dashboard/src/views/OnboardingView.tsx` (new)
- `apps/dashboard/src/App.tsx`

**Reads (no writes):**
- `apps/dashboard/src/views/ProjectLifecycle.tsx` (reference for view patterns)
- `apps/dashboard/src/views/AgentRegistry.tsx` (reference for table layout)
- `apps/dashboard/src/hooks/useMqtt.tsx` (MQTT subscription pattern)
- `apps/dashboard/src/components/StatusBadge.tsx` (reusable component)
- `apps/dashboard/src/components/RelativeTime.tsx` (reusable component)
- `apps/dashboard/src/index.css` (theme colors)
- `apps/onboarding-service/src/schemas.ts` (onboarding run schema/types)

**Tasks:**
1. Create `apps/dashboard/src/views/OnboardingView.tsx`:
   - Fetch onboarding runs from onboarding-service REST API (`VITE_ONBOARDING_URL` env var)
   - Display table: project name, status (phase), started_at, completed_at, error
   - Status badges for each phase: `initializing`, `dev-environment`, `auth-settings`, `completed`, `failed`
   - Expandable row detail showing: workflow phases with checkmarks, OAuth device code + URL (if in auth phase), error details
   - MQTT subscription to `onboarding/#` for real-time status updates
   - Use existing components: `StatusBadge`, `RelativeTime`, `ConnectionIndicator`
   - Follow dark theme with Tailwind classes matching existing views
2. Modify `apps/dashboard/src/App.tsx`:
   - Import `OnboardingView`
   - Add route: `<Route path="/onboarding" element={<OnboardingView />} />`
   - Add nav link: `{ to: "/onboarding", label: "Onboarding" }` in navItems

**Validation:** `bun run --filter @mesh-six/dashboard typecheck`

#### Teammate D: PM ntfy Fix + OAuth Hardening (`pm-oauth-fixes`)

**Exclusively Owns:**
- `apps/project-manager/src/index.ts` (ntfy-related code only)
- `apps/onboarding-service/src/activities/initiate-claude-oauth.ts`

**Reads (no writes):**
- `apps/onboarding-service/src/schemas.ts` (ClaudeOAuthResult schema)

**Tasks:**
1. Fix ntfy in `apps/project-manager/src/index.ts`:
   - Read `NTFY_TOPIC` env var (default: `mesh-six-pm`)
   - Read `MESH_SIX_PUBLIC_URL` env var (default: `http://localhost:3000`)
   - Replace hardcoded `ntfy.sh/mesh-six-pm` with `ntfy.sh/${ntfyTopic}`
   - Replace Dapr-internal reply URL: `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/project-manager/method/ntfy-reply` → `${publicUrl}/ntfy-reply`
   - Keep the `/ntfy-reply` POST handler as-is (it already works, just needs to be reachable)
2. Harden OAuth in `apps/onboarding-service/src/activities/initiate-claude-oauth.ts`:
   - Improve URL regex: match `https://(console\.anthropic\.com|claude\.ai)/` specifically
   - Improve code regex: match `[A-Z0-9]{4}-[A-Z0-9]{4}` pattern (standard device codes)
   - Add configurable timeout: `CLAUDE_AUTH_TIMEOUT_MS` env var (default 15000)
   - Add retry logic: 3 attempts with exponential backoff (1s, 2s, 4s)
   - Add Zod validation of parsed result before returning
   - Add structured error messages with stdout/stderr snippets on failure

**Validation:** `bun run --filter @mesh-six/project-manager typecheck && bun run --filter @mesh-six/onboarding-service typecheck`

### Phase 3: Integration + Testing (Subagent-Delegated)

The lead spawns a fresh integration subagent that:
1. Reads all modified/created files from Phase 2
2. Verifies no import mismatches or type errors
3. Runs `bun run typecheck` (all 23 packages)
4. Runs `bun run test` (core tests)
5. Checks webhook-receiver code uses PG_* env vars matching the new K8s manifest pattern (may need code update if it currently reads DATABASE_URL)
6. Returns summary of any fixes made and verification results

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead** | `migrations/013_orchestrator_tasks.sql` | Everything |
| **A** (`config-fixes`) | `k8s/base/webhook-receiver/deployment.yaml`, `k8s/base/project-manager/deployment.yaml`, `.github/workflows/test.yaml` | `k8s/base/vault-external-secrets-main.yaml`, `k8s/base/onboarding-service/deployment.yaml`, `tests/e2e/` |
| **B** (`orchestrator-persistence`) | `apps/orchestrator/src/index.ts`, `apps/orchestrator/src/db.ts` | `migrations/013_orchestrator_tasks.sql`, `packages/core/src/types.ts` |
| **C** (`dashboard-onboarding`) | `apps/dashboard/src/views/OnboardingView.tsx`, `apps/dashboard/src/App.tsx` | `apps/dashboard/src/views/*.tsx`, `apps/dashboard/src/hooks/`, `apps/dashboard/src/components/`, `apps/onboarding-service/src/schemas.ts` |
| **D** (`pm-oauth-fixes`) | `apps/project-manager/src/index.ts`, `apps/onboarding-service/src/activities/initiate-claude-oauth.ts` | `apps/onboarding-service/src/schemas.ts` |

### Task Dependency DAG

```
Phase 1 (Lead):
  1.1 Migration 013 ──┐
  1.2 Verify types ───┼── Both must complete before Phase 2
                      ┘

Phase 2 (Parallel):
  A: Config & K8s fixes ─────┐
  B: Orchestrator persistence ┼── All must complete before Phase 3
  C: Dashboard onboarding ───┤
  D: PM ntfy + OAuth ────────┘

Phase 3 (Lead → Integration Subagent):
  3.1 Integration fixes ──► 3.2 Typecheck ──► 3.3 Tests ──► 3.4 Version bumps + Docs
```

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

1. Start Claude Code in the project directory
2. Tell Claude: `@docs/plans/2026-02-27-remaining-production-fixes.md following Claude Code Session Setup instructions`
3. Claude invokes `superpowers:executing-plans` to load the batch-execution framework
4. Claude spawns an Explore subagent to confirm no blockers on `feat/gwa-migration` branch
5. Claude creates the full task list with dependencies:
   - Tasks 1-2: Phase 1 foundation (migration, type check)
   - Task 3: Phase 1 verification gate (blocked by 1-2)
   - Tasks 4-7: Phase 2 parallel work (each blocked by task 3)
   - Task 8: Phase 3 integration (blocked by 4-7)
6. Claude delegates Phase 1 tasks to synchronous subagents
7. Claude verifies Phase 1 gate passes
8. Claude calls `TeamCreate` with team name `prod-fixes`
9. Claude creates team-scoped tasks
10. Claude spawns 4 teammates with these subagent types:
    - A (`config-fixes`): `k8s` — K8s manifest + CI changes
    - B (`orchestrator-persistence`): `bun-service` — Bun+Hono service code
    - C (`dashboard-onboarding`): `react-dashboard` — React dashboard view
    - D (`pm-oauth-fixes`): `bun-service` — Bun+Hono service code
11. Claude monitors via `TaskList` polling
12. When all complete, sends shutdown requests
13. Spawns integration subagent (fresh context) for Phase 3
14. Reviews integration summary, runs verification independently
15. Updates changelog, docs, versions
16. Commits the result

### Teammate Prompt Structures

#### Teammate A: Config & Infrastructure Fixes
```
You are Teammate A (config-fixes) on team prod-fixes. Your job is to fix K8s deployment manifests and wire E2E tests into CI.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim tasks (set owner to "config-fixes")
- Use TaskGet to read full task descriptions

**File Ownership:**
- You EXCLUSIVELY own: k8s/base/webhook-receiver/deployment.yaml, k8s/base/project-manager/deployment.yaml, .github/workflows/test.yaml
- You may READ: k8s/base/vault-external-secrets-main.yaml, k8s/base/onboarding-service/deployment.yaml, tests/e2e/full-lifecycle.test.ts
- Do NOT touch any other files

**Tasks:**
1. Add env vars to webhook-receiver deployment: PG_HOST (pgsql.k3s.bto.bar), PG_PORT (5432), PG_DATABASE (mesh_six), PG_USER (from mesh-six-secrets), PG_PASSWORD (from mesh-six-secrets), VAULT_ADDR (http://vault.vault.svc.cluster.local:8200), VAULT_TOKEN (from mesh-six-secrets)
2. Add env vars to project-manager deployment: NTFY_TOPIC (default: mesh-six-pm), MESH_SIX_PUBLIC_URL (default: https://mesh-six.bto.bar)
3. Add e2e-tests job to test.yaml: workflow_dispatch trigger, self-hosted runner, 180min timeout, secrets for GITHUB_TOKEN/TEST_PROJECT_ID/DATABASE_URL/TEST_APP_URL

**Context:**
- Read k8s/base/onboarding-service/deployment.yaml for the pattern of referencing mesh-six-secrets
- Read k8s/base/vault-external-secrets-main.yaml to see available secret keys
- Read tests/e2e/full-lifecycle.test.ts lines 1-30 for required env vars

**Validation:** Ensure YAML is valid and well-formatted

**When complete:** Mark tasks as completed via TaskUpdate, send completion report via SendMessage
```

#### Teammate B: Orchestrator State Persistence
```
You are Teammate B (orchestrator-persistence) on team prod-fixes. Your job is to add PostgreSQL persistence for the orchestrator's in-memory activeTasks Map.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim tasks (set owner to "orchestrator-persistence")

**File Ownership:**
- You EXCLUSIVELY own: apps/orchestrator/src/index.ts, apps/orchestrator/src/db.ts (new)
- You may READ: migrations/013_orchestrator_tasks.sql, packages/core/src/types.ts, packages/core/src/index.ts
- Do NOT touch any other files

**Tasks:**
1. Create apps/orchestrator/src/db.ts:
   - Use `pg` package (import { Pool } from "pg") — NOT postgres/porsager
   - Pool from DATABASE_URL env var
   - Functions: saveTask(task), loadActiveTasks(), updateTaskStatus(taskId, status, result?), deleteTask(taskId), checkpointAll(tasks)
   - Schema: orchestrator_tasks table has columns: task_id, capability, dispatched_to, dispatched_at, status, attempts, max_attempts, timeout_seconds, payload (JSONB), result (JSONB), created_at, updated_at

2. Modify apps/orchestrator/src/index.ts:
   - Import db functions
   - On task dispatch (where activeTasks.set is called): also call saveTask()
   - On task result (where activeTasks status is updated): call updateTaskStatus(), then deleteTask() on success
   - On startup (before server.listen): call loadActiveTasks(), recreate Map entries with timeout timers
   - On SIGTERM (in existing signal handler): call checkpointAll() before exit
   - The in-memory Map remains the primary store for fast lookups. DB is the persistence layer.
   - Use fire-and-forget for non-critical DB writes (don't block the hot path): saveTask().catch(e => console.warn(...))

**Context:**
- Read apps/orchestrator/src/index.ts to understand current activeTasks Map usage
- Read migrations/013_orchestrator_tasks.sql to understand table schema
- The orchestrator already has DATABASE_URL in its K8s deployment

**Validation:** Run `bun run --filter @mesh-six/orchestrator typecheck`

**When complete:** Mark tasks as completed, send completion report
```

#### Teammate C: Dashboard Onboarding View
```
You are Teammate C (dashboard-onboarding) on team prod-fixes. Your job is to add an onboarding status view to the React dashboard.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim tasks (set owner to "dashboard-onboarding")

**File Ownership:**
- You EXCLUSIVELY own: apps/dashboard/src/views/OnboardingView.tsx (new), apps/dashboard/src/App.tsx
- You may READ: apps/dashboard/src/views/*.tsx, apps/dashboard/src/hooks/, apps/dashboard/src/components/, apps/dashboard/src/index.css, apps/onboarding-service/src/schemas.ts
- Do NOT touch any other files

**Tasks:**
1. Create apps/dashboard/src/views/OnboardingView.tsx:
   - Fetch onboarding runs from REST: GET {VITE_ONBOARDING_URL}/onboard (use useEffect + fetch, .catch(() => {}))
   - Display table with columns: Project, Status/Phase, Started, Completed/Error
   - Use StatusBadge for phase status (initializing, dev-environment, auth-settings, completed, failed)
   - Use RelativeTime for timestamps
   - Expandable row detail: show workflow phase progress, OAuth device URL + user code if in auth phase
   - MQTT subscription to onboarding/# for real-time updates (use useMqttSubscription hook)
   - Follow existing view patterns (dark theme, zinc tones, Tailwind classes)
   - Add ConnectionIndicator in header area

2. Modify apps/dashboard/src/App.tsx:
   - Import OnboardingView from ./views/OnboardingView
   - Add to navItems array: { to: "/onboarding", label: "Onboarding" }
   - Add Route: <Route path="/onboarding" element={<OnboardingView />} />

**Context:**
- Read apps/dashboard/src/views/AgentRegistry.tsx for table layout pattern
- Read apps/dashboard/src/views/ProjectLifecycle.tsx for state machine visualization pattern
- Read apps/dashboard/src/hooks/useMqtt.tsx for MQTT subscription pattern
- Read apps/dashboard/src/components/StatusBadge.tsx for badge component API
- Dashboard is React 19 + Vite + Tailwind 4 + React Router 7
- Import types with `import type` only from @mesh-six/core (no runtime imports)

**Validation:** Run `bun run --filter @mesh-six/dashboard typecheck`

**When complete:** Mark tasks as completed, send completion report
```

#### Teammate D: PM ntfy Fix + OAuth Hardening
```
You are Teammate D (pm-oauth-fixes) on team prod-fixes. Your job is to fix the project manager ntfy notification URL and harden the OAuth device flow parsing.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim tasks (set owner to "pm-oauth-fixes")

**File Ownership:**
- You EXCLUSIVELY own: apps/project-manager/src/index.ts, apps/onboarding-service/src/activities/initiate-claude-oauth.ts
- You may READ: apps/onboarding-service/src/schemas.ts
- Do NOT touch any other files

**Tasks:**
1. Fix ntfy in apps/project-manager/src/index.ts:
   - At the top of the file (near other env var reads), add:
     const NTFY_TOPIC = process.env.NTFY_TOPIC || "mesh-six-pm";
     const MESH_SIX_PUBLIC_URL = process.env.MESH_SIX_PUBLIC_URL || "";
   - In notifyHumanQuestion activity, replace hardcoded ntfy URL:
     Old: const ntfyUrl = `https://ntfy.sh/mesh-six-pm`;
     New: const ntfyUrl = `https://ntfy.sh/${NTFY_TOPIC}`;
   - Replace the Dapr-internal reply URL in the Actions header:
     Old: http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/project-manager/method/ntfy-reply
     New: ${MESH_SIX_PUBLIC_URL}/ntfy-reply
     (If MESH_SIX_PUBLIC_URL is empty, fall back to the old Dapr URL for backward compatibility)

2. Harden OAuth in apps/onboarding-service/src/activities/initiate-claude-oauth.ts:
   - Replace URL regex: /https:\/\/\S+/ → /https:\/\/(console\.anthropic\.com|claude\.ai)\S*/
   - Replace code regex: /code[:\s]+([A-Z0-9-]+)/i → /code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i
   - Add configurable timeout: const timeout = parseInt(process.env.CLAUDE_AUTH_TIMEOUT_MS || "15000")
   - Add retry logic: wrap the spawn+parse in a for loop (3 attempts), exponential backoff (1s, 2s, 4s)
   - After parsing, validate: URL must start with https://, code must match pattern
   - On final failure, include truncated stdout+stderr (first 500 chars each) in error message

**Context:**
- Read apps/project-manager/src/index.ts — find the notifyHumanQuestion activity (search for "ntfy")
- Read apps/onboarding-service/src/activities/initiate-claude-oauth.ts — the full file
- The /ntfy-reply POST handler in project-manager doesn't need changes (it works, just needs to be reachable)

**Validation:** Run both typechecks:
- bun run --filter @mesh-six/project-manager typecheck
- bun run --filter @mesh-six/onboarding-service typecheck

**When complete:** Mark tasks as completed, send completion report
```

### Lead Polling Pattern

During Phase 2:
1. Sleep 30 seconds
2. Call TaskList to check statuses
3. If any in_progress, repeat
4. When all completed, proceed to shutdown + Phase 3

### Context Preservation Strategy

1. **Delegate Phase 3 integration to a subagent** — biggest context savings
2. **Delegate Phase 1 migration to a subagent** — lead sees summary only
3. **Use Explore subagent for reconnaissance** — never have lead Read files directly
4. **Keep teammate prompts self-contained** — all context baked into spawn prompt
5. **Minimize lead file reads** — only read migration file (small) for verification

### Version Bumps (Phase 3)

| Package | Current | New | Reason |
|---------|---------|-----|--------|
| `@mesh-six/orchestrator` | 0.2.0 | 0.3.0 | DB persistence (new feature) |
| `@mesh-six/project-manager` | 0.7.0 | 0.7.1 | ntfy config fix (patch) |
| `@mesh-six/onboarding-service` | 0.2.0 | 0.2.1 | OAuth hardening (patch) |
| `@mesh-six/dashboard` | 0.2.0 | 0.3.0 | Onboarding view (new feature) |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Webhook receiver code reads DATABASE_URL not PG_* vars | High | Config won't work | Integration subagent checks code and either updates manifest to match code or updates code to match manifest |
| Dashboard onboarding REST endpoint not reachable in dev | Medium | Can't test UI | OnboardingView handles fetch errors gracefully, shows empty state |
| Orchestrator DB pool not initialized before first task | Low | Task lost | Initialize pool at module level, test connection on startup |
| OAuth regex too strict, misses valid URLs | Medium | Onboarding blocked | Include fallback to broader regex if strict match fails |
| ntfy reply URL change breaks existing workflows | Low | Questions not answered | Backward compatibility: fall back to Dapr URL if MESH_SIX_PUBLIC_URL empty |
