# Session Handoff — Remaining Production Readiness Fixes

**Date:** 2026-02-27
**Branch:** `feat/gwa-migration`
**Latest commit:** `c9b6ae3` (pushed to origin)
**Total commits on branch:** 49 (175 files changed, +27,433 / -820 lines vs main)

---

## Session Summary

This session resolved the 6 remaining production readiness items from `docs/handoff-2026-02-27-production-readiness.md` (items 1-5 + 12). Used subagent-driven development with two-stage review (spec compliance + code quality) per task.

### Changes Made (1 commit: `c9b6ae3`)

| # | Item | Package | Version | Impact |
|---|------|---------|---------|--------|
| 1 | Orchestrator state persistence | `@mesh-six/orchestrator` | 0.2.0 → 0.3.0 | New `db.ts` + 10 integration points in `index.ts` |
| 2 | Dashboard onboarding view | `@mesh-six/dashboard` | 0.2.0 → 0.3.0 | New `OnboardingView.tsx` + route/nav |
| 3 | Configurable ntfy notifications | `@mesh-six/project-manager` | 0.7.0 → 0.7.1 | 2 env vars, backward-compatible fallback |
| 4 | OAuth device flow hardening | `@mesh-six/onboarding-service` | 0.2.0 → 0.2.1 | Strict regex, retry, timeout, list endpoint |
| 5 | Webhook receiver K8s env vars | K8s manifest | — | DATABASE_URL, VAULT_ADDR, VAULT_TOKEN |
| 6 | E2E tests wired into CI | `.github/workflows` | — | workflow_dispatch trigger + job |

### Verification State

- **Typecheck:** All 23 packages pass (`bun run typecheck`)
- **Tests:** 310 pass across 7 suites, 0 regressions
  - Pre-existing: 2 architect-agent failures (need live DB), ~14 apps have no test files
- **No integration issues** — all cross-cutting env vars, imports, and route orderings verified

---

## Pending Items — Required Before First Project Onboard

### Infrastructure / Operational Steps (unchanged from prior handoff)

1. **Populate Vault secrets** — Write KV entries at `secret/data/mesh-six`: `pg-user`, `pg-password`, `github-token`, `vault-token`, `minio-access-key`, `minio-secret-key`, `litellm-admin-key`, `git-username`, `git-password`.

2. **Run migrations 012 + 013** — `bun run db:migrate` to create `onboarding_runs` and `orchestrator_tasks` tables.

3. **Publish devcontainer feature** — Merge to main triggers `publish-devcontainer-feature.yaml`, or run via `workflow_dispatch`. Without this, Envbuilder pods can't pull mesh-six-tools.

4. **Deploy services** — ArgoCD syncs from main. New: `onboarding-service`. Updated: `implementer`, `orchestrator`, `project-manager`, `webhook-receiver`, `dashboard`. New resources: ExternalSecret, RBAC.

5. **Create auth project + push credentials** — `scripts/push-credentials.ts` or use onboarding OAuth flow.

6. **Merge `feat/gwa-migration` to main** — All CI and ArgoCD triggers watch main.

### Code Items (Nice-to-Have, Not Blocking)

7. **Ingress for project-manager ntfy reply** — `MESH_SIX_PUBLIC_URL` is set to `https://mesh-six.bto.bar` in the K8s manifest, but the project-manager deployment doesn't have an IngressRoute for `/ntfy-reply`. Either add an IngressRoute or use a Cloudflare tunnel to make the endpoint externally reachable from ntfy.sh.

8. **Dashboard `VITE_ONBOARDING_URL` env var** — The onboarding view fetches from this env var. Needs to be set in the dashboard's nginx config or Vite build env to point at the onboarding-service Dapr endpoint (e.g., `http://localhost:3500/v1.0/invoke/onboarding-service/method` or a public URL).

9. **Orchestrator test coverage** — No test files exist for the orchestrator. The new `db.ts` and persistence integration should have tests.

10. **OAuth device flow validation** — The hardened regex targets `console.anthropic.com` and `claude.ai`. If Anthropic changes their OAuth URL structure, the regex needs updating. Consider direct Anthropic OAuth API integration as a future improvement.

11. **E2E tests in CI** — The `e2e-tests` job exists but requires secrets (`TEST_PROJECT_ID`, `TEST_DATABASE_URL`, `TEST_APP_URL`) to be configured in the GitHub repo settings.

---

## Branch State

```
Branch: feat/gwa-migration
Remote: pushed to origin (up to date)
HEAD: c9b6ae3
Working tree: 3 untracked plan docs (pre-existing), 1 modified agent def (pre-existing)

Untracked (not from this session):
  docs/PLAN_NOTES.md
  docs/plans/2026-02-26-devcontainer-envbuilder-design.md
  docs/plans/2026-02-26-devcontainer-envbuilder.md

Modified (not from this session):
  .claude/agents/bun-test.md
```

---

## Key Files Created/Modified This Session

### New Files
- `apps/orchestrator/src/db.ts` — PostgreSQL CRUD for task persistence
- `apps/dashboard/src/views/OnboardingView.tsx` — Onboarding status view (REST + MQTT)
- `migrations/013_orchestrator_tasks.sql` — Orchestrator tasks table
- `docs/plans/2026-02-27-remaining-production-fixes.md` — Plan document

### Modified Files
- `apps/orchestrator/src/index.ts` — DB persistence integration (10 points: dispatch, result, timeout, retry, recovery, shutdown)
- `apps/project-manager/src/index.ts` — Configurable NTFY_TOPIC + MESH_SIX_PUBLIC_URL
- `apps/onboarding-service/src/activities/initiate-claude-oauth.ts` — Hardened regex, retry, timeout
- `apps/onboarding-service/src/db.ts` — Added `listOnboardingRuns()`
- `apps/onboarding-service/src/index.ts` — Added `GET /onboard` list endpoint
- `apps/dashboard/src/App.tsx` — Route + nav link for onboarding
- `apps/dashboard/src/components/StatusBadge.tsx` — `configuring` purple variant
- `apps/dashboard/src/hooks/useMqtt.tsx` — `onboarding/#` topic
- `k8s/base/webhook-receiver/deployment.yaml` — 3 new env vars
- `k8s/base/project-manager/deployment.yaml` — 2 new env vars
- `.github/workflows/test.yaml` — workflow_dispatch + e2e-tests job
- `CHANGELOG.md` — Session entry
- `CLAUDE.md` — Updated orchestrator, dashboard, onboarding descriptions + conventions

---

## Recommended Next Steps (Priority Order)

1. **Populate Vault + run migrations** — Infrastructure prereqs for deployment
2. **Merge to main** — Triggers CI builds + ArgoCD sync
3. **Publish devcontainer feature** — Via workflow_dispatch after merge
4. **Configure dashboard VITE_ONBOARDING_URL** — Enable the onboarding view to connect
5. **Add PM IngressRoute for ntfy reply** — Make `/ntfy-reply` externally reachable
6. **Onboard first test project** — Use MCP tool or `POST /onboard` to validate the full flow
7. **Add orchestrator tests** — Cover the new persistence layer
8. **Configure E2E CI secrets** — Enable manual E2E test runs
