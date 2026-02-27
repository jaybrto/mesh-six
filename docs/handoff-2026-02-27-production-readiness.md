# Session Handoff — Production Readiness & Onboarding Service

**Date:** 2026-02-27
**Branch:** `feat/gwa-migration`
**Latest commit:** `b96d5c8` (pushed to origin)
**Total commits this session:** 48 on branch (167 files changed, +26,019 / -816 lines vs main)

---

## Session Summary

This session accomplished three major work items on the `feat/gwa-migration` branch:

### 1. Pod Startup Recovery Fix (1 commit)
- Wired the existing `podStartupRecovery()` function into `apps/implementer/src/index.ts` startup path — it existed in `actor.ts` but was never called

### 2. Onboarding Service — Full Implementation (14 tasks, 15 commits)
- Designed and built `apps/onboarding-service/` from scratch as a Dapr Workflow microservice
- Three-phase workflow: initialization (GitHub Projects v2 board, webhooks, DB registration, backend provisioning), dev environment (devcontainer scaffolding, Envbuilder StatefulSet generation, ArgoCD sync), auth & settings (Claude OAuth, LiteLLM team routing)
- HTTP API: `POST /onboard`, `GET /onboard/:id`, `POST /onboard/:id/auth-callback`
- MCP server: `onboard-project`, `get-onboarding-status`, `submit-oauth-code` tools (via `--mcp` flag)
- 14 activity implementations, Zod schemas, DB layer, K8s manifests
- `devcontainer-features/mesh-six-tools/` custom dev container feature
- `templates/devcontainer/devcontainer.json` default template
- Migration: `012_onboarding_runs.sql`

### 3. Production Readiness Fixes — 12 Blockers Resolved (8 commits)
Ran a comprehensive audit identifying 14 gaps. Fixed 12 via subagent-driven development:

| Fix | Package | Version |
|-----|---------|---------|
| Bundle extraction — download tar.gz and extract locally via zlib | implementer | 0.6.0 |
| Per-repo credential routing via `authProjectId` task payload | implementer | 0.6.0 |
| Orchestrator retry preserves original task payload | orchestrator | 0.2.0 |
| ProjectState enum aligned with workflow states | project-manager | 0.7.0 |
| Manifest generation via Octokit Contents API (not filesystem) | onboarding-service | 0.2.0 |
| OAuth CLI fix (stdout/stderr capture, not `--print-device-code`) | onboarding-service | 0.2.0 |
| Pod health via Kubernetes API (not kubectl shell) | onboarding-service | 0.2.0 |
| Multi-project webhook secrets from Vault | webhook-receiver | 0.3.0 |
| Multi-project GitHubProjectClient from repo_registry | webhook-receiver | 0.3.0 |
| CI build matrix — added onboarding-service, context-service | build-deploy.yaml | — |
| CI test matrix — added 5 missing apps | test.yaml | — |
| ExternalSecret for mesh-six-secrets | vault-external-secrets-main.yaml | — |
| Devcontainer feature publish workflow | publish-devcontainer-feature.yaml | — |
| RBAC for onboarding-service (pod reader) | rbac.yaml | — |
| Prod overlay image tags for 4 missing apps | prod/kustomization.yaml | — |

---

## Pending Items — Required Before First Project Onboard

### Code Changes Needed

1. **Dashboard onboarding view** — No UI for onboarding progress or OAuth device code. Users must use MCP tool or REST API. Makes OAuth flow awkward since `deviceUrl` and `userCode` are only in the DB.

2. **ntfy reply URL is Dapr-internal** — `notifyHumanQuestion` in `apps/project-manager/src/index.ts` sends reply URL as `http://localhost:3500/v1.0/invoke/project-manager/method/ntfy-reply`. Needs a public-facing ingress URL for ntfy.sh to reach.

3. **Orchestrator in-memory state recovery** — `activeTasks` Map in `apps/orchestrator/src/index.ts` is lost on pod restart. In-flight tasks vanish. Needs Dapr state or PostgreSQL persistence.

4. **OAuth device flow validation** — `initiate-claude-oauth.ts` parses CLI output with regex. Needs validation against actual `claude auth login` output or replacement with direct Anthropic OAuth API.

5. **Webhook receiver K8s env vars** — Multi-project support added `DATABASE_URL`, `VAULT_ADDR`, `VAULT_TOKEN` to the code but `k8s/base/webhook-receiver/` deployment manifest may not have these env vars yet.

### Infrastructure / Operational Steps

6. **Populate Vault secrets** — Write KV entries at `secret/data/mesh-six`: `pg-user`, `pg-password`, `github-token`, `vault-token`, `minio-access-key`, `minio-secret-key`, `litellm-admin-key`, `git-username`, `git-password`.

7. **Run migration 012** — `bun run db:migrate` to create `onboarding_runs` table and add `execution_mode` to `repo_registry`.

8. **Publish devcontainer feature** — Merge to main triggers `publish-devcontainer-feature.yaml`, or run via `workflow_dispatch`. Without this, Envbuilder pods can't pull mesh-six-tools.

9. **Deploy services** — ArgoCD syncs from main. New: `onboarding-service`. Updated: `implementer`, `orchestrator`, `project-manager`, `webhook-receiver`. New resources: ExternalSecret, RBAC.

10. **Create auth project + push credentials** — `scripts/push-credentials.ts` or use onboarding OAuth flow.

11. **Merge `feat/gwa-migration` to main** — All CI and ArgoCD triggers watch main.

### Nice-to-Have (Not Blocking)

12. **E2E tests in CI** — `tests/e2e/full-lifecycle.test.ts` exists but isn't wired into `test.yaml`.

---

## Branch State

```
Branch: feat/gwa-migration
Remote: pushed to origin (up to date)
HEAD: b96d5c8
Working tree: clean (3 untracked files pre-existing, 1 modified agent def not from this session)

Untracked:
  docs/PLAN_NOTES.md
  docs/plans/2026-02-26-devcontainer-envbuilder-design.md
  docs/plans/2026-02-26-devcontainer-envbuilder.md

Modified (not from this session):
  .claude/agents/bun-test.md
```

---

## Key Files Created/Modified This Session

### New Packages
- `apps/onboarding-service/` — entire package (27 files)
- `apps/auth-service/` — entire package (created in prior session, on this branch)
- `apps/implementer/` — entire package (created in prior session, on this branch)

### Production Readiness Fixes (this session's focus)
- `apps/implementer/src/actor.ts` — bundle extraction rewrite, authProjectId
- `apps/implementer/src/config.ts` — removed AUTH_PROJECT_ID
- `apps/implementer/src/monitor.ts` — per-session authProjectId
- `apps/implementer/src/index.ts` — authProjectId in task payload
- `apps/orchestrator/src/index.ts` — retry payload preservation
- `apps/project-manager/src/index.ts` — ProjectState enum alignment
- `apps/webhook-receiver/src/index.ts` — multi-project support
- `apps/onboarding-service/src/activities/generate-kube-manifests.ts` — Octokit API
- `apps/onboarding-service/src/activities/update-kustomization.ts` — Octokit API
- `apps/onboarding-service/src/activities/trigger-sync.ts` — simplified to no-op
- `apps/onboarding-service/src/activities/initiate-claude-oauth.ts` — CLI capture fix
- `apps/onboarding-service/src/activities/verify-pod-health.ts` — K8s API
- `k8s/base/onboarding-service/rbac.yaml` — new ServiceAccount + Role
- `k8s/base/vault-external-secrets-main.yaml` — new ExternalSecret
- `.github/workflows/publish-devcontainer-feature.yaml` — new workflow
- `.github/workflows/build-deploy.yaml` — updated matrix
- `.github/workflows/test.yaml` — updated matrix
- `k8s/overlays/prod/kustomization.yaml` — added image entries

### Plan Documents
- `docs/plans/2026-02-26-onboarding-service-design.md` — approved design
- `docs/plans/2026-02-26-onboarding-service.md` — 14-task implementation plan
- `docs/plans/2026-02-26-production-readiness-fixes.md` — 12-fix plan with Agent Teams structure

---

## Verification State

- **Typecheck:** All 23 packages pass (`bun run typecheck`)
- **Core tests:** 208 pass across 12 files
- **Onboarding tests:** 6 pass across 2 files (schemas + db types)
- **No integration test failures**

---

## Recommended Next Steps (Priority Order)

1. **Add webhook-receiver deployment env vars** — Quick fix, unblocks multi-project webhooks
2. **Validate OAuth flow** — Test `claude auth login` output parsing on a real machine with Claude CLI installed
3. **Populate Vault + run migrations** — Infrastructure prereqs for deployment
4. **Merge to main** — Triggers CI builds + ArgoCD sync
5. **Publish devcontainer feature** — via workflow_dispatch after merge
6. **Onboard first test project** — Use MCP tool or `POST /onboard` to validate the full flow
7. **Add dashboard onboarding view** — After initial validation confirms the backend works
8. **Fix ntfy reply URL** — Set up ingress or Cloudflare tunnel for PM webhook endpoint
