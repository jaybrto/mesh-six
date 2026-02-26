# GWA Final Migration Audit & Implementation Plan

> Comprehensive audit of every GitHub Workflow Agents (GWA) feature against mesh-six,
> with implementation tasks for anything missing. Goal: decommission GWA permanently.

**Date:** 2026-02-26
**Status:** Draft
**Source:** GWA v4.12 PLAN.md + full source audit
**Target:** mesh-six (all milestones through M4.5)

---

## Table of Contents

1. [Context & Goal](#context--goal)
2. [Feature Gap Matrix](#feature-gap-matrix)
3. [Domain Breakdown](#domain-breakdown)
4. [Implementation Tasks](#implementation-tasks)
5. [Agent Teams Execution Plan](#agent-teams-execution-plan)

---

## Context & Goal

GWA (github-workflow-agents) is a 17K LOC TypeScript project that automates Claude Code sessions for GitHub PRs and issues. It runs on k3s with long-lived StatefulSet pods, SQLite tracking, tmux multiplexing, and an XState state machine.

Mesh-six was designed as its successor — a microservices-based multi-agent orchestration system using Dapr, PostgreSQL, and event-driven workflows. Major GWA components have been migrated:
- Credential management → `auth-service`
- REPL execution → `implementer` (Dapr Actor)
- Session orchestration → `project-manager` (Dapr Workflow)
- Architecture consultation → `architect-agent` (Dapr Actor)
- Webhook handling → `webhook-receiver`
- Dialog handling → `@mesh-six/core` dialog-handler.ts
- Auth detection → `@mesh-six/core` claude.ts

**Goal of this plan:** Audit every GWA feature and confirm it either:
1. Has been migrated to mesh-six (document where)
2. Is intentionally replaced by a different architecture (document why)
3. Is missing and needs to be implemented (create task)
4. Is not needed (document rationale)

After this plan executes, GWA can be archived.

---

## Feature Gap Matrix

### Legend

| Status | Meaning |
|--------|---------|
| MIGRATED | Feature exists in mesh-six, possibly different implementation |
| REPLACED | Intentionally superseded by different architecture |
| MISSING | Needs implementation in mesh-six |
| NOT_NEEDED | Feature not required for mesh-six operation |
| PARTIAL | Some aspects migrated, gaps remain |

### 1. Session Management

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Session types (feature/PR/review) | src/lib/types.ts | REPLACED | apps/implementer | mesh-six uses per-issue actors, not session types |
| Unified session lifecycle | schema.sql sessions table | MIGRATED | migrations/007_session_tables.sql | implementation_sessions table in PostgreSQL |
| Session status flow (pending→running→blocked→complete) | src/lib/state-machine.ts | MIGRATED | apps/project-manager/src/workflow.ts | Dapr Workflow states replace XState |
| Session creation from board move | src/transitions/start-planning.ts | MIGRATED | apps/webhook-receiver + project-manager | Webhook detects Todo→Planning, PM starts workflow |
| SQLite session tracking | src/lib/db.ts, schema.sql | REPLACED | PostgreSQL via migrations/007 | Intentional: centralized DB vs per-pod SQLite |
| Session resumption (claude --resume) | src/lib/recovery.ts | PARTIAL | apps/implementer/src/actor.ts | **GAP**: implementer doesn't store/use claude_session_id for resume |
| Crash recovery on restart | src/lib/recovery.ts | PARTIAL | apps/implementer/src/actor.ts | **GAP**: no startup recovery sweep for interrupted sessions |
| Session cleanup | src/cleanup.ts | MISSING | — | **GAP**: no CronJob or cleanup mechanism for stale sessions/worktrees |
| Concurrent sessions (multiple tmux windows) | src/lib/tmux.ts | MIGRATED | apps/implementer/src/tmux.ts | One actor per issue, separate tmux sessions |
| Stale session detection | src/lib/recovery.ts | MISSING | — | **GAP**: no periodic check for stuck/orphaned sessions |

### 2. Question/Answer Flow

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Explicit question tool (/ask-question) | src/ask-question.ts | REPLACED | apps/architect-agent | Architect actor handles questions via event-driven flow |
| Pattern-based question detection | src/lib/repl-session.ts | MIGRATED | apps/implementer/src/monitor.ts | SessionMonitor detects questions in pane output |
| Question posting to GitHub | src/ask-question.ts | MIGRATED | apps/project-manager/src/workflow.ts | PM posts question via GitHub API |
| Screenshot with question | src/lib/screenshot.ts | MISSING | — | **GAP**: no screenshot capture in question flow |
| Vision verification | src/lib/vision-verify.ts | MISSING | — | **GAP**: no Claude Vision analysis of terminal state |
| Question tracking in DB | schema.sql questions table | MIGRATED | migrations/007 session_questions table | PostgreSQL instead of SQLite |
| Session blocking on question | src/ask-question.ts | MIGRATED | apps/implementer/src/monitor.ts | Raises event to PM workflow |
| Answer delivery via GitHub comment | src/respond.ts | REPLACED | ntfy reply webhook | Human answers via ntfy, architect auto-answers |
| Answer injection to REPL | src/transitions/send-answer.ts | MIGRATED | apps/implementer/src/actor.ts | injectAnswer() method via tmux send-keys |
| Polling for answers | src/ask-question.ts | REPLACED | Dapr waitForExternalEvent | Event-driven, no polling |
| Auto-answer via architect | — (GWA manual only) | NEW | apps/architect-agent | mesh-six improvement: AI answers questions automatically |
| Human escalation via ntfy | — (GWA via GitHub only) | NEW | apps/project-manager | mesh-six improvement: push notifications |

### 3. Credential Management

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| OAuth token generation | PLAN.md Phase 1 | MIGRATED | scripts/push-credentials.ts | Push local creds to auth-service |
| Preload Claude config | src/lib/claude.ts | MIGRATED | packages/core/src/credentials.ts | buildCredentialsJson/buildConfigJson |
| Proactive token expiry check | src/lib/credentials-manager.ts | MIGRATED | packages/core/src/credentials.ts | isCredentialExpired() |
| Auth failure detection | src/lib/claude.ts | MIGRATED | packages/core/src/claude.ts | 15 failure patterns |
| Multi-pod credential backup | src/credentials-backup.ts | PARTIAL | apps/llm-service/src/minio-client.ts | **GAP**: no CronJob for periodic backup |
| Centralized provisioning | src/orchestrator/environment-provisioner.ts | MIGRATED | apps/auth-service | Full CRUD + provisioning |
| Bundle generation (tar.gz) | src/orchestrator/environment-provisioner.ts | MIGRATED | apps/auth-service/src/routes/provision.ts | tar.gz with credential files |
| On-demand re-provisioning | src/provision.ts | MIGRATED | apps/auth-service/src/routes/provision.ts | POST /projects/:id/provision |
| Credential health monitoring | — | MIGRATED | apps/auth-service/src/routes/credentials.ts | GET /projects/:id/health |
| OAuth refresh timer | src/orchestrator/environment-provisioner.ts | MIGRATED | apps/auth-service/src/refresh-timer.ts | 30-minute background refresh |
| Credential-refreshed events | src/lib/amqp.ts | MIGRATED | apps/auth-service pub/sub | Dapr pub/sub CREDENTIAL_REFRESHED_TOPIC |

### 4. GitHub Integration

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| GitHub Projects v2 workflow | src/lib/projects.ts | MIGRATED | packages/core/src/github.ts | GitHubProjectClient class |
| Column-based triggers | src/transitions/*.ts | MIGRATED | apps/webhook-receiver | HMAC webhook + event classification |
| Custom fields on project items | src/lib/projects.ts | PARTIAL | packages/core/src/github.ts | **GAP**: no updateCustomField() for pod name, session ID, kubectl cmd |
| Plan-issue sync | src/lib/plan-sync.ts | MISSING | — | **GAP**: no plan summary posted to issue description |
| PR creation (gh pr create) | src/lib/git.ts | PARTIAL | apps/implementer | **GAP**: implementer doesn't create PRs after completion |
| PR filtering (Claude-only PRs) | src/lib/pr-filter.ts | MISSING | — | **GAP**: no filter for which PRs/issues to handle |
| Status comment tracking | PLAN.md v4.9 | MISSING | — | **GAP**: no single updatable status comment per session |
| Comment generation (Haiku summary) | src/lib/comment-generator.ts | MISSING | — | **GAP**: no LLM-powered session summary comments |
| Progress comments on issue | PLAN.md v3.4 | MISSING | — | **GAP**: no progress updates during implementation |
| Issue enrichment (labels, assignees) | src/lib/github.ts | PARTIAL | apps/project-manager/src/workflow.ts | PM enriches but may not set all fields |

### 5. Infrastructure

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Long-lived StatefulSet | k8s/gwa-runner-statefulset.yaml | MIGRATED | k8s/base/implementer/ | StatefulSet with PVCs |
| Persistent storage (Longhorn) | k8s/longhorn-claude-storageclass.yaml | MIGRATED | k8s/base/implementer/ | PVCs for sessions + worktrees |
| tmux session management | src/lib/tmux.ts | MIGRATED | apps/implementer/src/tmux.ts | Basic tmux ops |
| Git worktree management | src/lib/git.ts | PARTIAL | apps/implementer/src/actor.ts | **GAP**: no dedicated git.ts library, worktree ops inline in actor |
| Container image | Dockerfile | MIGRATED | docker/Dockerfile.implementer | Custom image with tmux+git+Claude CLI |
| Pod initialization (entrypoint) | k8s/gwa-runner-configmap.yaml | PARTIAL | docker/Dockerfile.implementer | **GAP**: no entrypoint script for startup recovery, repo clone, DB init |
| Resource limits | k8s/gwa-runner-statefulset.yaml | MIGRATED | k8s/base/implementer/ | Memory/CPU limits set |
| Health probes | src/health-check.ts | MIGRATED | apps/implementer/src/index.ts | /healthz and /readyz |

### 6. Multi-Agent Swarm

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Architect agent | src/architect.ts | REPLACED | apps/architect-agent | Dapr Actor vs tmux window |
| Worker agents | src/worker.ts, src/lib/swarm.ts | REPLACED | — | mesh-six uses separate agent services, not tmux workers |
| Agent task assignment | src/lib/swarm.ts | REPLACED | apps/orchestrator | Task dispatch via scoring |
| Progress aggregation | src/lib/swarm.ts | REPLACED | apps/project-manager | PM workflow tracks progress |
| Parallel tmux execution | src/lib/swarm.ts | NOT_NEEDED | — | mesh-six agents run as separate pods, inherently parallel |

### 7. Planning Mode

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Planning session trigger | src/transitions/start-planning.ts | MIGRATED | apps/project-manager/src/workflow.ts | PLANNING phase in workflow |
| Opus for planning | PLAN.md v4.12 | MIGRATED | apps/project-manager complexity gate | Label-based model selection |
| Analysis-only prompt | PLAN.md v4.12 | PARTIAL | apps/project-manager | **GAP**: no explicit analysis-only prompt template |
| Plan templates | templates/plans/*.md | MISSING | — | **GAP**: no rigid plan/prompt/checklist/decisions templates |
| Plan completion CLI | src/planning-complete.ts | REPLACED | apps/project-manager workflow | PM auto-advances from PLANNING |
| Human approval gates | PLAN.md v3.0 | MIGRATED | apps/project-manager REVIEW phase | LLM review gate |
| Plan version tracking | PLAN.md v3.0 | NOT_NEEDED | — | Dapr Workflow provides execution history |

### 8. QA/Testing

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Playwright e2e trigger | src/transitions/run-playwright.ts | MIGRATED | apps/project-manager QA phase | PM dispatches to qa-tester agent |
| Test result parsing | src/transitions/resume-with-failures.ts | MIGRATED | apps/project-manager evaluateTestResults | Structured test result evaluation |
| Failure context injection | src/transitions/resume-with-failures.ts | MIGRATED | apps/implementer injectAnswer | Resume with failure details |
| Auto-move on pass | PLAN.md v3.0 | MIGRATED | apps/project-manager workflow | Auto-advances to REVIEW |

### 9. Deployment

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| ArgoCD deployment | argocd/applicationset.yaml | MIGRATED | k8s/argocd-application.yaml | Single Application vs ApplicationSet |
| Container build CI | .github/workflows/build-image.yml | MIGRATED | .github/workflows/build-deploy.yaml | Matrix Kaniko build |
| Kustomize overlays | — | MIGRATED | k8s/overlays/{dev,prod} | Standard kustomize |
| Cleanup CronJob | k8s/gwa-cleanup-cronjob.yaml | MISSING | — | **GAP**: no cleanup CronJob |
| Credential backup CronJob | k8s/gwa-credentials-backup-cronjob.yaml | MISSING | — | **GAP**: no credential backup CronJob |
| Onboarding script | scripts/onboard-repo.sh | MISSING | — | **GAP**: no automation for adding repos |
| Deploy script | scripts/deploy-all.sh | NOT_NEEDED | — | ArgoCD handles sync |
| Helm per-repo | helm/gwa-runner/ | REPLACED | — | mesh-six uses single deployment, not per-repo |

### 10. Monitoring & Observability

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| OpenTelemetry tracing | src/lib/telemetry.ts | REPLACED | Dapr sidecar auto-instrumentation | Dapr provides OTEL traces automatically |
| Custom session metrics | src/lib/metric-exporter.ts | MISSING | — | **GAP**: no session duration/tool/token metrics |
| Terminal streaming (WebSocket) | src/lib/terminal-relay.ts | MISSING | — | **GAP**: no live terminal relay |
| Asciicast recordings | PLAN.md v4.0 | MISSING | — | **GAP**: no terminal recordings to MinIO |
| Activity log | schema.sql activity_log | MIGRATED | migrations/007 session_activity_log | PostgreSQL |
| Tool call tracking | schema.sql tool_calls | MIGRATED | migrations/007 session_tool_calls | PostgreSQL |
| Push notifications (ntfy) | src/orchestrator/push-bridge.ts | MIGRATED | apps/project-manager ntfy integration | Human escalation via ntfy |

### 11. Dialog Handler

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Known dialog patterns | src/lib/dialog-handler.ts | MIGRATED | packages/core/src/dialog-handler.ts | Same patterns ported |
| LLM-based dialog analysis | src/lib/dialog-handler.ts | MIGRATED | packages/core/src/dialog-handler.ts | DIALOG_ANALYSIS_PROMPT |
| preloadClaudeConfig() | src/lib/claude.ts | MIGRATED | packages/core/src/credentials.ts | Writes creds before start |

### 12. Recovery

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Startup recovery sweep | src/lib/recovery.ts | MISSING | — | **GAP**: no scan for interrupted sessions on pod start |
| Resumable session tracking | src/lib/recovery.ts | PARTIAL | — | **GAP**: claude_session_id not stored for --resume |
| Resume command building | src/lib/recovery.ts | MISSING | — | **GAP**: no buildResumeCommand equivalent |
| Checkpoint creation | src/lib/checkpoint.ts | MISSING | — | **GAP**: no pre-action state snapshots |
| Conversation history storage | schema.sql conversation_history | MISSING | — | **GAP**: no conversation replay log |
| Response recording | schema.sql responses | NOT_NEEDED | — | Event log serves this purpose |

### 13. CLI Tools

| GWA Tool | Status | mesh-six Equivalent | Gap Notes |
|----------|--------|-------------------|-----------|
| gwa-orchestrate | REPLACED | PM workflow | Automatic orchestration |
| gwa-respond | REPLACED | ntfy reply webhook | Event-driven answer flow |
| gwa-cleanup | MISSING | — | **GAP**: needs cleanup utility |
| gwa-ask-question | REPLACED | Architect actor | AI-powered question handling |
| gwa-session-complete | PARTIAL | SessionMonitor | **GAP**: no summary comment posted |
| gwa-architect | REPLACED | Architect agent | Separate microservice |
| gwa-worker | REPLACED | Individual agents | Separate microservices |
| gwa-setup-project | MISSING | — | **GAP**: no GitHub Project setup tool |
| gwa-push-credentials | MIGRATED | scripts/push-credentials.ts | Pushes creds to auth-service |
| gwa-provision | MIGRATED | auth-service API | POST /projects/:id/provision |
| gwa-credentials-backup | MISSING | — | **GAP**: no credential backup script |
| gwa-health-check | MIGRATED | /healthz endpoints | Per-service health |
| gwa-debug-db | MISSING | — | **GAP**: no DB inspection utility |
| gwa-planning-complete | REPLACED | PM workflow auto-advance | Automatic |
| gwa-credential-history | MISSING | — | **GAP**: no credential history query tool |
| gwa-start-planning | REPLACED | PM workflow PLANNING phase | Automatic |
| gwa-inject-prompt | MIGRATED | implementer injectAnswer | Via Dapr actor method |
| gwa-deploy-and-cleanup | REPLACED | PM workflow DEPLOY phase | Automatic |

### 14. Security

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| HMAC webhook verification | src/webhook/handler.ts | MIGRATED | apps/webhook-receiver | timingSafeEqual |
| Delivery deduplication | src/webhook/handler.ts | MIGRATED | apps/webhook-receiver | In-memory Map with TTL |
| Vault + ESO | k8s/vault-external-secrets.yaml | MIGRATED | k8s/base/ | Vault syncs secrets |
| RBAC for CronJobs | k8s/gwa-cleanup-rbac.yaml | MISSING | — | **GAP**: no RBAC for cleanup (no cleanup exists yet) |

### 15. Dependency Management

| GWA Feature | GWA File(s) | Status | mesh-six Location | Gap Notes |
|-------------|-------------|--------|-------------------|-----------|
| Update checking | src/lib/updater.ts | NOT_NEEDED | — | CI handles version updates |
| Update queue | schema.sql update_queue | NOT_NEEDED | — | CI-based |
| Version tracking | schema.sql dependency_versions | NOT_NEEDED | — | package.json + lockfile |

---

## Domain Breakdown

Based on the gap matrix, here are the implementation domains with their missing features grouped:

### Domain A: Session Lifecycle & Recovery

**Missing Features:**
1. Session resumption — store `claude_session_id` in `implementation_sessions` for `claude --resume`
2. Startup recovery sweep — scan for interrupted sessions on implementer pod start
3. Stale session detection — periodic check for stuck/orphaned sessions
4. Checkpoint system — pre-action state snapshots (git status, tmux pane, pending actions)
5. Session cleanup — remove completed sessions, worktrees, tmux windows

**Files to Create/Modify:**
- `migrations/010_session_resume_fields.sql` — add claude_session_id, checkpoint columns
- `apps/implementer/src/recovery.ts` — startup recovery + stale detection
- `apps/implementer/src/checkpoint.ts` — checkpoint creation/restore
- `k8s/base/implementer-cleanup/` — CronJob manifest for periodic cleanup
- `apps/implementer/src/actor.ts` — store claude_session_id, call checkpoint before major ops

### Domain B: GitHub Comments & Status Tracking

**Missing Features:**
1. Comment generation — LLM-powered session summaries for issue comments
2. Status comment tracking — single updatable comment per session
3. Progress comments — periodic updates during implementation
4. Plan-issue sync — post plan summary to issue description
5. Custom field updates — pod name, session ID, kubectl attach command on project items
6. PR creation — implementer creates PR after completing implementation

**Files to Create/Modify:**
- `packages/core/src/comment-generator.ts` — Haiku-powered summary generation
- `packages/core/src/github.ts` — add updateCustomField(), updateComment() methods
- `apps/implementer/src/github-integration.ts` — PR creation, status comments, progress
- `apps/project-manager/src/workflow.ts` — add plan-sync activity, progress comment activity

### Domain C: Screenshot, Vision & Terminal

**Missing Features:**
1. Screenshot capture — tmux pane → ANSI → HTML → PNG pipeline
2. Vision verification — Claude Vision analysis of terminal screenshots
3. Terminal streaming — live WebSocket relay of tmux output
4. Terminal recordings — asciicast v2 to MinIO for playback
5. Screenshots attached to question comments

**Files to Create/Modify:**
- `packages/core/src/screenshot.ts` — capture pipeline (aha + wkhtmltoimage or alternatives)
- `packages/core/src/vision.ts` — Claude Vision API integration
- `apps/implementer/src/terminal-relay.ts` — WebSocket terminal streaming
- `apps/implementer/src/recording.ts` — asciicast recording to MinIO
- `apps/implementer/src/monitor.ts` — attach screenshot to question events

### Domain D: Operational Tooling

**Missing Features:**
1. Cleanup CronJob — periodic cleanup of stale sessions, worktrees
2. Credential backup CronJob — periodic backup to MinIO
3. Onboarding script — add new repos to mesh-six management
4. Debug DB utility — inspect PostgreSQL session/workflow state
5. Credential history query — view credential refresh events
6. Setup project tool — create GitHub Project with correct columns/fields
7. Session metrics exporter — track duration, tools used, tokens consumed

**Files to Create/Modify:**
- `scripts/cleanup.ts` — cleanup stale sessions, worktrees, tmux
- `scripts/credential-backup.ts` — backup credentials to MinIO
- `scripts/onboard-repo.ts` — add repo: create project, configure webhook, add to ArgoCD
- `scripts/debug-db.ts` — inspect PostgreSQL state
- `scripts/credential-history.ts` — query credential events
- `scripts/setup-project.ts` — create GitHub Project v2 with columns/fields
- `k8s/base/cleanup-cronjob/` — CronJob manifests
- `k8s/base/credential-backup-cronjob/` — CronJob manifests
- `packages/core/src/metrics.ts` — session metrics collection

### Domain E: Git Operations & Worktree Library

**Missing Features:**
1. Dedicated git operations library — clone, worktree create/delete, diff, stash, branch management
2. PR filter logic — determine which issues/PRs to process based on labels, authors, branch patterns

**Files to Create/Modify:**
- `packages/core/src/git.ts` — git operations library (clone, worktree, diff, stash, status)
- `packages/core/src/pr-filter.ts` — PR/issue filter rules (labels, authors, patterns)
- `apps/implementer/src/actor.ts` — use git.ts instead of inline git commands

### Domain F: Planning Templates & Prompts

**Missing Features:**
1. Plan templates — rigid markdown templates for planning phase output
2. Analysis-only prompt template — instruct Claude to explore and plan without creating files
3. Plan-sync back to issue — post plan summary as issue comment

**Files to Create/Modify:**
- `templates/plans/plan.md` — implementation plan template
- `templates/plans/prompt.md` — prompt templates for architect/workers
- `templates/plans/checklist.md` — progress tracking template
- `templates/plans/decisions.md` — Q&A and design decisions template
- `apps/project-manager/src/plan-templates.ts` — template loading and instantiation

---

## Implementation Tasks

### Task List (Prioritized)

| # | Task | Domain | Priority | Effort | Dependencies |
|---|------|--------|----------|--------|-------------|
| 1 | Add session resume fields (migration + implementer) | A | HIGH | Small | None |
| 2 | Implement startup recovery sweep in implementer | A | HIGH | Medium | Task 1 |
| 3 | Create cleanup CronJob + script | D | HIGH | Medium | None |
| 4 | Add comment generation to core library | B | HIGH | Medium | None |
| 5 | Add status comment tracking to PM workflow | B | HIGH | Medium | Task 4 |
| 6 | Create git operations library in core | E | MEDIUM | Medium | None |
| 7 | Add PR creation to implementer | B | HIGH | Medium | Task 6 |
| 8 | Create screenshot capture pipeline | C | MEDIUM | Large | None |
| 9 | Add custom field updates to GitHub client | B | MEDIUM | Small | None |
| 10 | Create onboarding script | D | MEDIUM | Medium | None |
| 11 | Create debug-db utility script | D | LOW | Small | None |
| 12 | Add checkpoint system to implementer | A | MEDIUM | Medium | Task 1 |
| 13 | Create credential backup CronJob | D | MEDIUM | Small | None |
| 14 | Create PR filter logic in core | E | MEDIUM | Small | None |
| 15 | Add progress comments to PM workflow | B | MEDIUM | Small | Task 4 |
| 16 | Create plan templates | F | LOW | Small | None |
| 17 | Add plan-sync activity to PM workflow | F | LOW | Medium | Task 16 |
| 18 | Add session metrics exporter | D | LOW | Medium | None |
| 19 | Create credential history query script | D | LOW | Small | None |
| 20 | Create setup-project tool | D | LOW | Medium | None |
| 21 | Add terminal streaming (WebSocket relay) | C | LOW | Large | None |
| 22 | Add asciicast recording to MinIO | C | LOW | Large | Task 21 |
| 23 | Add Vision verification | C | LOW | Medium | Task 8 |
| 24 | Add stale session detection | A | MEDIUM | Small | Task 2 |

---

## Agent Teams Execution Plan

### Team Structure

- **Lead**: Coordinates phases, creates foundation tasks, manages integration
- **Teammate A**: Session Lifecycle & Recovery (Domain A)
- **Teammate B**: GitHub Comments & Status (Domain B)
- **Teammate C**: Git Operations & PR Filter (Domain E)
- **Teammate D**: Operational Tooling (Domain D — scripts + CronJobs)
- **Teammate E**: Planning Templates & Prompts (Domain F)

> **Note:** Domain C (Screenshot/Vision/Terminal) is deferred to a follow-up session.
> Terminal streaming and recordings are large scope and low priority for decommissioning GWA.
> Screenshot capture (Task 8) is also deferred unless the team has capacity.

### Phase 1: Foundation (Sequential — Team Lead Only)

#### Task 1.1: Database Migration — Session Resume Fields

**File:** `migrations/010_session_resume_fields.sql`

Add columns to support session resumption and checkpoints:

```sql
-- Add claude_session_id for --resume support
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS claude_session_id TEXT;
-- Add checkpoint support columns
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS last_checkpoint_at TIMESTAMPTZ;
ALTER TABLE implementation_sessions ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ;

-- Checkpoint table for pre-action snapshots
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,  -- 'pre_commit', 'pre_pr', 'periodic', 'manual'
  summary       TEXT NOT NULL,
  git_status    TEXT,
  git_diff_stat TEXT,
  tmux_capture  TEXT,
  pending_actions JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_session_checkpoints_session ON session_checkpoints(session_id, created_at DESC);
```

**Verification:** `bun run db:migrate` succeeds.

#### Task 1.2: Core Library — Comment Generator

**File:** `packages/core/src/comment-generator.ts`

Port GWA's `src/lib/comment-generator.ts` pattern — LLM-powered session summaries:

```typescript
export interface CommentOptions {
  sessionId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  type: 'session-start' | 'progress' | 'question' | 'completion' | 'error';
  context: Record<string, unknown>;
}

export async function generateComment(opts: CommentOptions): Promise<string>;
export async function generateSessionSummary(toolCalls: any[], duration: number): Promise<string>;
```

Uses `chatCompletion` from `@mesh-six/core` llm module with a fast model (Haiku equivalent).

**Verification:** `bun run --filter @mesh-six/core typecheck`

#### Task 1.3: Core Library — Git Operations

**File:** `packages/core/src/git.ts`

Port GWA's `src/lib/git.ts` — typed wrappers for git operations:

```typescript
export async function cloneRepo(url: string, targetDir: string, opts?: { branch?: string; depth?: number }): Promise<void>;
export async function createWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void>;
export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void>;
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]>;
export async function getDiff(repoDir: string, opts?: { staged?: boolean }): Promise<string>;
export async function getStatus(repoDir: string): Promise<GitStatus>;
export async function createBranch(repoDir: string, branch: string, startPoint?: string): Promise<void>;
export async function stash(repoDir: string, message?: string): Promise<void>;
export async function stashPop(repoDir: string): Promise<void>;
```

All operations via `Bun.spawn(['git', ...])` with proper error handling.

**Verification:** `bun run --filter @mesh-six/core typecheck`

#### Task 1.4: Core Library — PR Filter

**File:** `packages/core/src/pr-filter.ts`

Port GWA's `src/lib/pr-filter.ts` — rules for which issues/PRs to process:

```typescript
export interface FilterConfig {
  allowedAuthors?: string[];
  requiredLabels?: string[];
  excludeLabels?: string[];
  branchPatterns?: string[];  // e.g., ['claude/*']
  excludeDrafts?: boolean;
}

export function shouldProcessIssue(issue: { labels: string[]; author: string }, config: FilterConfig): boolean;
export function shouldProcessPR(pr: { labels: string[]; author: string; draft: boolean; branch: string }, config: FilterConfig): boolean;
```

**Verification:** `bun run --filter @mesh-six/core typecheck`

#### Task 1.5: Core Library — Export Updates

**File:** `packages/core/src/index.ts`

Add exports for new modules: `comment-generator`, `git`, `pr-filter`.

**Verification:** `bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/core test`

#### Phase 1 Gate

All foundation files must typecheck:

```bash
bun run --filter @mesh-six/core typecheck
bun run --filter @mesh-six/core test
bun run db:migrate
```

---

### Phase 2: Parallel Implementation (5 Teammates)

#### Teammate A: Session Lifecycle & Recovery

**Exclusively Owns:**
- `apps/implementer/src/recovery.ts` (NEW)
- `apps/implementer/src/checkpoint.ts` (NEW)

**Modifies:**
- `apps/implementer/src/actor.ts` — store claude_session_id, call checkpoints, startup recovery
- `apps/implementer/src/session-db.ts` — add checkpoint DB operations, resume field updates
- `apps/implementer/src/monitor.ts` — capture claude_session_id from CLI output

**Reads (no writes):**
- `packages/core/src/types.ts`
- `packages/core/src/git.ts`
- `migrations/010_session_resume_fields.sql`

**Tasks:**
1. Create `recovery.ts` with:
   - `recoverInterruptedSessions()` — query for `status IN ('running','blocked')` sessions, mark interrupted
   - `buildResumeContext(sessionId)` — assemble context from checkpoints + recent activity
   - Call on implementer startup (add to `index.ts` init)
2. Create `checkpoint.ts` with:
   - `createCheckpoint(sessionId, type, opts)` — capture git status, tmux pane, pending actions
   - `getLatestCheckpoint(sessionId)` — fetch most recent
   - `restoreFromCheckpoint(sessionId)` — rebuild context for resume
3. Update `actor.ts`:
   - Store `claude_session_id` from CLI `--resume` output or session metadata
   - Call `createCheckpoint('pre_commit')` before significant operations
   - Call `recoverInterruptedSessions()` on pod startup
4. Update `session-db.ts`:
   - Add `updateClaudeSessionId(sessionId, claudeSessionId)`
   - Add `insertCheckpoint(...)` and `getLatestCheckpoint(sessionId)`
   - Add `markSessionInterrupted(sessionId)`
5. Update `monitor.ts`:
   - Parse Claude CLI output for session ID patterns
   - Pass to actor for storage

**Validation:**
```bash
bun run --filter @mesh-six/implementer typecheck
```

#### Teammate B: GitHub Comments & Status

**Exclusively Owns:**
- `apps/implementer/src/github-integration.ts` (NEW)
- `apps/project-manager/src/comment-activities.ts` (NEW)

**Modifies:**
- `packages/core/src/github.ts` — add updateCustomField(), createOrUpdateComment()
- `apps/project-manager/src/workflow.ts` — wire in comment/progress activities
- `apps/implementer/src/actor.ts` — call PR creation on completion

**Reads (no writes):**
- `packages/core/src/comment-generator.ts`
- `packages/core/src/types.ts`

**Tasks:**
1. Add to `packages/core/src/github.ts`:
   - `updateProjectItemField(projectId, itemId, fieldId, value)` — GraphQL mutation
   - `createOrUpdateComment(owner, repo, issueNumber, body, commentId?)` — idempotent comment
   - `findBotComment(owner, repo, issueNumber, marker)` — find comment by hidden marker
2. Create `github-integration.ts` in implementer:
   - `createPR(repoDir, baseBranch, headBranch, title, body)` — run `gh pr create`
   - `postCompletionComment(sessionId, issueNumber, summary)` — post summary on completion
   - Wire into actor's completion path
3. Create `comment-activities.ts` in project-manager:
   - `postStatusComment(issueNumber, status, details)` — create/update status comment
   - `postProgressComment(issueNumber, phase, progress)` — periodic progress updates
   - `syncPlanToIssue(issueNumber, planSummary)` — post plan to issue description
   - `updateProjectCustomFields(projectItemId, fields)` — sync metadata fields
4. Wire activities into `workflow.ts`:
   - Post status comment at each phase transition
   - Post progress comment during IMPLEMENTATION (via external event)
   - Sync plan summary during PLANNING
   - Update custom fields (session ID, pod name) on session start

**Validation:**
```bash
bun run --filter @mesh-six/core typecheck
bun run --filter @mesh-six/project-manager typecheck
bun run --filter @mesh-six/implementer typecheck
```

#### Teammate C: Git Operations & PR Filter Integration

**Exclusively Owns:**
- `packages/core/src/__tests__/git.test.ts` (NEW)
- `packages/core/src/__tests__/pr-filter.test.ts` (NEW)

**Modifies:**
- `apps/implementer/src/actor.ts` — use `@mesh-six/core` git.ts for worktree operations
- `apps/webhook-receiver/src/index.ts` — apply PR filter before publishing events

**Reads (no writes):**
- `packages/core/src/git.ts`
- `packages/core/src/pr-filter.ts`
- `packages/core/src/types.ts`

**Tasks:**
1. Write unit tests for `git.ts`:
   - Test worktree create/list/remove (use temp directories)
   - Test getDiff and getStatus parsing
   - Test error handling (non-existent repo, etc.)
2. Write unit tests for `pr-filter.ts`:
   - Test shouldProcessIssue with various label combinations
   - Test shouldProcessPR with draft, branch pattern, author rules
3. Refactor `implementer/src/actor.ts`:
   - Replace inline `Bun.spawn(['git', ...])` with `@mesh-six/core` git.ts functions
   - Use `createWorktree()` instead of manual git worktree add
   - Use `removeWorktree()` in cleanup
4. Wire PR filter into `webhook-receiver/src/index.ts`:
   - Load filter config from env vars
   - Apply `shouldProcessIssue()` before publishing `new-todo` events
   - Log filtered-out items for debugging

**Validation:**
```bash
bun run --filter @mesh-six/core test
bun run --filter @mesh-six/implementer typecheck
bun run --filter @mesh-six/webhook-receiver typecheck
```

#### Teammate D: Operational Tooling

**Exclusively Owns:**
- `scripts/cleanup.ts` (NEW)
- `scripts/credential-backup.ts` (NEW)
- `scripts/onboard-repo.ts` (NEW)
- `scripts/debug-db.ts` (NEW)
- `scripts/credential-history.ts` (NEW)
- `scripts/setup-project.ts` (NEW)
- `k8s/base/cleanup-cronjob/deployment.yaml` (NEW)
- `k8s/base/cleanup-cronjob/kustomization.yaml` (NEW)
- `k8s/base/credential-backup-cronjob/deployment.yaml` (NEW)
- `k8s/base/credential-backup-cronjob/kustomization.yaml` (NEW)

**Reads (no writes):**
- `packages/core/src/github.ts`
- `packages/core/src/git.ts`
- `packages/core/src/types.ts`
- `k8s/base/kustomization.yaml` (to understand manifest structure)
- `scripts/push-credentials.ts` (existing pattern)
- `scripts/migrate.ts` (existing pattern)

**Tasks:**
1. Create `scripts/cleanup.ts`:
   - Query `implementation_sessions` for completed/failed sessions older than 7 days
   - Remove stale worktrees via git.ts
   - Clean up tmux sessions for completed actors
   - Delete old session_checkpoints, session_activity_log rows (30-day retention)
   - Print summary of cleaned resources
2. Create `scripts/credential-backup.ts`:
   - Query auth-service for all project credentials
   - Upload to MinIO with timestamped prefix
   - Delete backups older than 30 days
   - Print summary
3. Create `scripts/onboard-repo.ts`:
   - Accept `owner/repo` argument
   - Create GitHub Project v2 with columns (Todo, Planning, In Progress, QA, Blocked, Review, Done)
   - Create custom fields (Session ID, Pod Name, etc.)
   - Configure GitHub webhook for projects_v2_item events
   - Add repo to `repo_registry` table
   - Print onboarding summary
4. Create `scripts/debug-db.ts`:
   - Query active workflows from `pm_workflow_instances`
   - Query active sessions from `implementation_sessions`
   - Query pending questions from `session_questions`
   - Query recent events from `architect_events`
   - Print formatted tables
5. Create `scripts/credential-history.ts`:
   - Query `auth_credentials` for refresh history
   - Show expiry timeline per project
   - Print formatted table
6. Create `scripts/setup-project.ts`:
   - Create GitHub Project v2 with mesh-six columns
   - Create custom fields matching GWA project template
   - Link to repository
7. Create K8s CronJob manifests:
   - `cleanup-cronjob`: daily, runs `bun run scripts/cleanup.ts`
   - `credential-backup-cronjob`: every 6 hours, runs `bun run scripts/credential-backup.ts`
   - Include RBAC ServiceAccount with necessary permissions
   - Use `docker/Dockerfile.agent` image with `AGENT_APP=scripts` build arg

**Validation:**
```bash
bun run --filter @mesh-six/core typecheck  # scripts use core imports
# CronJob manifests: kubectl apply --dry-run=client -f k8s/base/cleanup-cronjob/
```

#### Teammate E: Planning Templates & Prompts

**Exclusively Owns:**
- `templates/plans/plan.md` (NEW)
- `templates/plans/prompt.md` (NEW)
- `templates/plans/checklist.md` (NEW)
- `templates/plans/decisions.md` (NEW)
- `apps/project-manager/src/plan-templates.ts` (NEW)

**Modifies:**
- `apps/project-manager/src/workflow.ts` — add plan-template loading activity

**Reads (no writes):**
- GWA `templates/plans/` (reference patterns)
- `packages/core/src/types.ts`

**Tasks:**
1. Create plan templates adapted from GWA:
   - `plan.md` — implementation plan with sections: Overview, Architecture, Task Breakdown, Dependencies, Validation Criteria, Agent Orchestration
   - `prompt.md` — system prompt templates for planning phase (analysis-only mode)
   - `checklist.md` — progress tracking with checkboxes
   - `decisions.md` — Q&A log, design decisions, assumptions
2. Create `plan-templates.ts`:
   - `loadTemplate(templateName)` — load from `templates/plans/`
   - `instantiatePlan(template, vars)` — fill template with issue-specific data
   - `formatPlanForIssue(plan)` — markdown format for GitHub issue comment
   - `parsePlanFromComment(commentBody)` — extract structured plan from issue comment
3. Wire into PM workflow:
   - Use `instantiatePlan()` when creating planning context for architect
   - Use `formatPlanForIssue()` to post plan summary to issue
   - Use `parsePlanFromComment()` when reviewing plan at REVIEW gate

**Validation:**
```bash
bun run --filter @mesh-six/project-manager typecheck
```

---

### Phase 3: Integration + Verification (Subagent-Delegated)

After all teammates complete, the team lead spawns an **integration subagent** to:

1. Read all newly created/modified files from all teammates
2. Fix cross-cutting integration issues:
   - Ensure `packages/core/src/index.ts` exports all new modules
   - Ensure `apps/implementer/package.json` has no missing dependencies
   - Ensure `apps/project-manager/package.json` has no missing dependencies
   - Fix any import path mismatches between teammates
3. Run full verification:
   ```bash
   bun install
   bun run typecheck          # All packages
   bun run --filter @mesh-six/core test  # Core tests
   ```
4. Update `k8s/base/kustomization.yaml` to include new CronJob directories
5. Return summary of all changes and verification results

---

### Phase 4: Documentation & Cleanup

After integration passes, the lead:

1. Invokes `update-docs` skill to update CHANGELOG, README, CLAUDE.md
2. Bumps versions: `@mesh-six/core`, `@mesh-six/implementer`, `@mesh-six/project-manager`
3. Creates comprehensive commit

---

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead** | `migrations/010_*`, `packages/core/src/comment-generator.ts`, `packages/core/src/git.ts`, `packages/core/src/pr-filter.ts`, `packages/core/src/index.ts` | Everything |
| **A** | `apps/implementer/src/recovery.ts`, `apps/implementer/src/checkpoint.ts` | `packages/core/src/*`, `migrations/010_*` |
| **A** (modifies) | `apps/implementer/src/actor.ts`¹, `apps/implementer/src/session-db.ts`, `apps/implementer/src/monitor.ts`² | — |
| **B** | `apps/implementer/src/github-integration.ts`, `apps/project-manager/src/comment-activities.ts` | `packages/core/src/*` |
| **B** (modifies) | `packages/core/src/github.ts`, `apps/project-manager/src/workflow.ts`³, `apps/implementer/src/actor.ts`¹ | — |
| **C** | `packages/core/src/__tests__/git.test.ts`, `packages/core/src/__tests__/pr-filter.test.ts` | `packages/core/src/*` |
| **C** (modifies) | `apps/implementer/src/actor.ts`¹, `apps/webhook-receiver/src/index.ts` | — |
| **D** | `scripts/cleanup.ts`, `scripts/credential-backup.ts`, `scripts/onboard-repo.ts`, `scripts/debug-db.ts`, `scripts/credential-history.ts`, `scripts/setup-project.ts`, `k8s/base/cleanup-cronjob/*`, `k8s/base/credential-backup-cronjob/*` | `packages/core/src/*`, `scripts/push-credentials.ts` |
| **E** | `templates/plans/*`, `apps/project-manager/src/plan-templates.ts` | `packages/core/src/*` |
| **E** (modifies) | `apps/project-manager/src/workflow.ts`³ | — |

¹ `actor.ts` — Teammates A, B, C all modify this file. **Conflict resolution:** A handles recovery/checkpoint additions, B handles PR creation on completion, C handles git.ts refactor. Integration subagent merges.
² `monitor.ts` — Only Teammate A modifies.
³ `workflow.ts` — Teammates B and E both modify. **Conflict resolution:** B adds comment activities, E adds plan-template activity. Integration subagent merges.

**Known conflict files requiring integration merge:**
- `apps/implementer/src/actor.ts` (A + B + C)
- `apps/project-manager/src/workflow.ts` (B + E)

### Task Dependency DAG

```
Phase 1 (Lead):
  1.1 Migration 010 ──────────┐
  1.2 Core comment-generator ─┤
  1.3 Core git.ts ────────────┼── All must complete before Phase 2
  1.4 Core pr-filter.ts ──────┤
  1.5 Core index.ts exports ──┘

Phase 2 (Parallel):
  A: Session Recovery ────────┐
  B: GitHub Comments ─────────┤
  C: Git Ops + PR Filter ─────┼── All must complete before Phase 3
  D: Operational Tooling ─────┤
  E: Planning Templates ──────┘

Phase 3 (Lead → Integration Subagent):
  3.1 Integration fixes ──► 3.2 Typecheck ──► 3.3 Tests

Phase 4 (Lead):
  4.1 Update docs ──► 4.2 Version bumps ──► 4.3 Commit
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

1. Start Claude Code in the mesh-six project directory
2. Tell Claude: `@docs/plans/2026-02-26-gwa-final-migration.md following Claude Code Session Setup instructions`
   - Claude should invoke `superpowers:executing-plans` skill to load the batch-execution framework
3. Claude spawns an Explore subagent to confirm no blockers (read key files, verify branch)
4. Claude creates feature branch: `git checkout -b feat/gwa-final-migration`
5. Claude creates the full task list with dependencies using `TaskCreate` and `TaskUpdate(addBlockedBy)`:
   - Tasks 1-5: Phase 1 foundation tasks (migration, core modules, exports)
   - Task 6: Phase 1 verification gate (blocked by tasks 1-5)
   - Tasks 7-11: Phase 2 parallel tasks (one per teammate, each blocked by task 6)
   - Task 12: Phase 3 integration (blocked by tasks 7-11)
   - Task 13: Phase 4 docs + commit (blocked by task 12)
6. Claude delegates Phase 1 foundation tasks to synchronous subagents
7. Claude verifies foundation gate: `bun run --filter @mesh-six/core typecheck && bun run db:migrate`
8. Claude calls `TeamCreate` to establish `gwa-migration` team
9. Claude spawns teammates via `Task` tool:

```
Teammate A: subagent_type="bun-service", name="session-recovery", team_name="gwa-migration", run_in_background=true
Teammate B: subagent_type="bun-service", name="github-comments", team_name="gwa-migration", run_in_background=true
Teammate C: subagent_type="bun-test", name="git-ops-tests", team_name="gwa-migration", run_in_background=true
Teammate D: subagent_type="bun-service", name="ops-tooling", team_name="gwa-migration", run_in_background=true
Teammate E: subagent_type="workflow", name="plan-templates", team_name="gwa-migration", run_in_background=true
```

10. Claude monitors via `sleep 30` + `TaskList` polling loop
11. When all teammates complete, send `SendMessage(type="shutdown_request")` to each
12. Spawn integration subagent (fresh context) to merge conflict files, fix imports, run typecheck + tests
13. Lead reviews integration summary, runs verification independently
14. Lead invokes `update-docs` skill, bumps versions, commits

### Teammate Prompt Structure

**Teammate A: Session Recovery**
```
You are Teammate A (session-recovery) on team gwa-migration. Your job is to implement session lifecycle recovery, checkpoint system, and resume support for the implementer agent.

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to "session-recovery")
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY create: apps/implementer/src/recovery.ts, apps/implementer/src/checkpoint.ts
- You MODIFY: apps/implementer/src/actor.ts (add recovery/checkpoint calls, store claude_session_id), apps/implementer/src/session-db.ts (add checkpoint DB ops), apps/implementer/src/monitor.ts (parse session ID)
- You may READ (but NOT modify): packages/core/src/*, migrations/010_*

**Context:**
- Read apps/implementer/src/actor.ts first to understand the actor lifecycle
- Read apps/implementer/src/session-db.ts for existing DB patterns
- Read migrations/010_session_resume_fields.sql for the new schema
- The GWA equivalent is at /Users/jay.barreto/dev/util/bto/github-workflow-agents/src/lib/recovery.ts and checkpoint.ts — use as reference but adapt to mesh-six's PostgreSQL + Dapr actor architecture

**Validation:**
- Run `bun run --filter @mesh-six/implementer typecheck` before marking complete

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```

**Teammate B: GitHub Comments & Status**
```
You are Teammate B (github-comments) on team gwa-migration. Your job is to implement GitHub comment generation, status comment tracking, progress updates, and PR creation for the implementer and project-manager.

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to "github-comments")
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY create: apps/implementer/src/github-integration.ts, apps/project-manager/src/comment-activities.ts
- You MODIFY: packages/core/src/github.ts (add updateCustomField, createOrUpdateComment, findBotComment), apps/project-manager/src/workflow.ts (wire comment activities), apps/implementer/src/actor.ts (wire PR creation on completion)
- You may READ (but NOT modify): packages/core/src/comment-generator.ts, packages/core/src/types.ts

**Context:**
- Read packages/core/src/github.ts first (GitHubProjectClient class)
- Read packages/core/src/comment-generator.ts for the comment generation API
- Read apps/project-manager/src/workflow.ts for the workflow structure
- The GWA equivalent is at /Users/jay.barreto/dev/util/bto/github-workflow-agents/src/lib/comment-generator.ts and projects.ts

**Validation:**
- Run `bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/project-manager typecheck && bun run --filter @mesh-six/implementer typecheck`

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```

**Teammate C: Git Ops + PR Filter Tests**
```
You are Teammate C (git-ops-tests) on team gwa-migration. Your job is to write tests for the new git.ts and pr-filter.ts core modules, refactor the implementer to use them, and wire PR filtering into the webhook receiver.

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to "git-ops-tests")
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY create: packages/core/src/__tests__/git.test.ts, packages/core/src/__tests__/pr-filter.test.ts
- You MODIFY: apps/implementer/src/actor.ts (replace inline git commands with core git.ts), apps/webhook-receiver/src/index.ts (add PR filter before publishing)
- You may READ (but NOT modify): packages/core/src/git.ts, packages/core/src/pr-filter.ts, packages/core/src/types.ts

**Context:**
- Read packages/core/src/git.ts and pr-filter.ts first (the APIs you're testing)
- Read apps/implementer/src/actor.ts to find inline git commands to refactor
- Read apps/webhook-receiver/src/index.ts for the event publishing flow
- Look at existing tests in packages/core/src/__tests__/ for test patterns

**Validation:**
- Run `bun run --filter @mesh-six/core test` — all tests must pass
- Run `bun run --filter @mesh-six/implementer typecheck`
- Run `bun run --filter @mesh-six/webhook-receiver typecheck`

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```

**Teammate D: Operational Tooling**
```
You are Teammate D (ops-tooling) on team gwa-migration. Your job is to create operational scripts (cleanup, credential backup, onboarding, debug, setup) and their K8s CronJob manifests.

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to "ops-tooling")
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY create: scripts/cleanup.ts, scripts/credential-backup.ts, scripts/onboard-repo.ts, scripts/debug-db.ts, scripts/credential-history.ts, scripts/setup-project.ts, k8s/base/cleanup-cronjob/*, k8s/base/credential-backup-cronjob/*
- You may READ (but NOT modify): packages/core/src/*, scripts/push-credentials.ts, scripts/migrate.ts, k8s/base/kustomization.yaml

**Context:**
- Read scripts/push-credentials.ts for the existing script pattern (env loading, DB connection)
- Read scripts/migrate.ts for the migration runner pattern
- Read k8s/base/ directory structure for manifest patterns
- GWA equivalents: /Users/jay.barreto/dev/util/bto/github-workflow-agents/src/cleanup.ts, scripts/onboard-repo.sh, src/debug-db.ts

**Validation:**
- Each script should typecheck: `bun typecheck scripts/cleanup.ts` etc.
- CronJob manifests: validate YAML structure matches existing k8s/base/ patterns

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```

**Teammate E: Planning Templates & Prompts**
```
You are Teammate E (plan-templates) on team gwa-migration. Your job is to create planning templates and integrate them into the project-manager workflow.

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to "plan-templates")
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY create: templates/plans/plan.md, templates/plans/prompt.md, templates/plans/checklist.md, templates/plans/decisions.md, apps/project-manager/src/plan-templates.ts
- You MODIFY: apps/project-manager/src/workflow.ts (add plan template loading activity)
- You may READ (but NOT modify): packages/core/src/types.ts

**Context:**
- Read apps/project-manager/src/workflow.ts for the PLANNING phase structure
- GWA templates at: /Users/jay.barreto/dev/util/bto/github-workflow-agents/templates/plans/ — adapt patterns but don't copy verbatim
- Templates should be mesh-six-native (reference Dapr, PM workflow, architect actor)

**Validation:**
- Run `bun run --filter @mesh-six/project-manager typecheck`

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```

---

## Deferred Items (Follow-Up Sessions)

These items are low priority for GWA decommissioning and can be implemented later:

| Feature | Reason for Deferral | Priority |
|---------|--------------------|----|
| Screenshot capture pipeline | Large scope, not blocking GWA removal | LOW |
| Vision verification | Depends on screenshot pipeline | LOW |
| Terminal streaming (WebSocket) | Large scope, nice-to-have | LOW |
| Asciicast recordings to MinIO | Large scope, nice-to-have | LOW |
| Session metrics exporter | Dapr provides basic metrics | LOW |
| Conversation history for replay | Event log provides audit trail | LOW |
| Mobile app API | Not planned for mesh-six | NONE |
| Gitea integration | Not needed currently | NONE |

---

## Acceptance Criteria

After this plan executes successfully:

- [ ] Migration 010 applied (session_checkpoints table, resume fields)
- [ ] Core library has: comment-generator.ts, git.ts, pr-filter.ts with tests
- [ ] Implementer stores claude_session_id for session resumption
- [ ] Implementer has startup recovery sweep for interrupted sessions
- [ ] Implementer has checkpoint creation before major operations
- [ ] Implementer creates PR on implementation completion
- [ ] Project-manager posts status comments at each phase transition
- [ ] Project-manager posts progress comments during implementation
- [ ] Project-manager syncs plan summary to issue description
- [ ] GitHub Projects custom fields updated (pod name, session ID, kubectl cmd)
- [ ] PR filter prevents processing of non-Claude issues
- [ ] Git operations use typed library instead of inline commands
- [ ] Cleanup CronJob deployed (daily stale session cleanup)
- [ ] Credential backup CronJob deployed (every 6 hours)
- [ ] Onboarding script creates GitHub Project + webhook + registry entry
- [ ] Debug-db script inspects all key PostgreSQL tables
- [ ] Planning templates exist for plan, prompt, checklist, decisions
- [ ] All packages typecheck: `bun run typecheck`
- [ ] Core tests pass: `bun run --filter @mesh-six/core test`
- [ ] CHANGELOG.md updated with all new features
- [ ] GWA repository can be archived after deployment verification

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `actor.ts` merge conflicts (3 teammates modify) | HIGH | MEDIUM | Integration subagent handles merges; teammates document their changes clearly |
| `workflow.ts` merge conflicts (2 teammates modify) | MEDIUM | MEDIUM | B adds comment activities at end, E adds plan-template at specific phase |
| CronJob requires RBAC setup | MEDIUM | LOW | Include ServiceAccount + ClusterRole in manifests |
| Screenshot pipeline deferred too long | LOW | LOW | Core GWA features work without screenshots |
| Session resume needs Claude CLI changes | LOW | HIGH | Test claude --resume behavior first |
| Onboarding script needs GitHub App permissions | MEDIUM | MEDIUM | Document required OAuth scopes |
