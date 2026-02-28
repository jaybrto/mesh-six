# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed - 2026-02-28: Scraper Service Bug Fixes

**@mesh-six/scraper-service@0.1.1**
- `src/dapr-events.ts`: Fix `ScrapeCompletedEvent` envelope to prevent `contractVersion`, `taskId`, and `completedAt` from being overwritten by caller-provided event spread
- `src/providers/windsurf.ts`: Fix `waitForOutput` polling order to check `.done` flag first (primary completion signal) before falling back to `output.md` reading, preventing truncated content from race conditions

**@mesh-six/core@0.12.1**
- No changes (version bump for consistency)

### Added - 2026-02-28: Research & Plan Sub-Workflow (PR #13 Review Fixes)

Implements the ResearchAndPlanSubWorkflow with all fixes from 4-model PR review (Claude Opus, Gemini 3.1 Pro, Claude Sonnet, GPT 5.3-Codex). Triage-escalate-review loop with Mem0 integration.

**@mesh-six/core@0.12.0**
- `src/research-types.ts`: Zod schemas for research sub-workflow — `ResearchAndPlanInput/Output`, `ArchitectTriageInput/Output`, `StartDeepResearchInput/Output`, `ReviewResearchInput/Output`, `ArchitectDraftPlanInput`, `TriageLLMResponseSchema`, `ReviewLLMResponseSchema`, `ScrapeCompletedPayloadSchema`, constants (`SCRAPE_COMPLETED_EVENT`, `MAX_RESEARCH_CYCLES`, `RESEARCH_TIMEOUT_MS`, `LLM_MODEL_PRO`, `LLM_MODEL_FLASH`, `MAX_RESEARCH_CONTEXT_CHARS`, `SCRAPER_SERVICE_APP_ID_RESEARCH`)
- `src/research-minio.ts`: MinIO Claim Check helpers — `ensureResearchBucket`, `writeResearchStatus`/`readResearchStatus`, `uploadRawResearch`/`downloadRawResearch`/`uploadCleanResearch`/`downloadCleanResearch`, canonical key builders (`statusDocKey`, `rawResearchKey`, `cleanResearchKey`)
- `src/prompts/architect-reflection.ts`: `ARCHITECT_REFLECTION_PROMPT` for Mem0 memory extraction, `buildArchitectReflectionSystem`
- `src/tools/web-research.ts`: `webResearchTools` schema, `buildResearchSystemPrompt` (scaffolded for future Gemini native tool calling)
- `src/research-types.test.ts`: 19 unit tests covering all schemas and constants
- `src/index.ts`: Exports all new research modules

**@mesh-six/project-manager@0.8.1**
- `src/research-sub-workflow.ts`: Dapr Durable Workflow with `whenAny()` from `@microsoft/durabletask-js` (replay-safe, not Promise.race — C1 fix), task reference timeout detection (C2 fix), `yield*` generator delegation from main workflow, `isResearchWorkflowAvailable()` guard, iterative review loop (max 3 cycles), Mem0 `reflectAndStore` phase
- `src/research-activities.ts`: Activities with dependency injection factory — `architectTriage` (Mem0 reads + Gemini Pro), `startDeepResearch` (claim check + scraper dispatch), `reviewResearch` (Gemini Flash + 500k char limit), `architectDraftPlan` (failure context injection), `reflectAndStore` (Mem0 via `transitionClose`), `sendPushNotification`, `updateResearchSession`
- `src/workflow.ts`: Research sub-workflow wired into non-simple planning path, guarded by `isResearchWorkflowAvailable()`
- `src/index.ts`: MinIO client + research activities registration with AgentMemory passthrough
- `package.json`: Added `pg` and `@types/pg` dependencies (M3 fix)

**Database**
- `migrations/014_research_sessions.sql`: `research_sessions` table with `workflow_id` (H2 fix), `raw_minio_key` (H4 fix), `research_cycles`, indexes on workflow_id/task_id/issue

**Scripts**
- `scripts/test-research-workflow.ts`: Multi-mode test script (`--mode=triage|dispatch|review|offline|workflow`) with both `--mode=X` and `--mode X` arg formats (L1 fix)

**Documentation**
- `docs/PLAN.md`: Updated to v1.6 with research sub-workflow section, core library additions, migration list, repo structure
- `CLAUDE.md`: Added research workflow conventions (whenAny, yield*, MinIO keys, Mem0 reflection, truncation limits)
- `README.md`: Full rewrite reflecting current project scope

### Added - 2026-02-27: Mac Mini Scraper Service

New stateless RPA worker service for the standalone Mac mini. Acts as the "brawn" for the k3s ResearcherActor — drives Windsurf IDE (Electron) and Gemini web UI (Chrome) via Playwright, communicates via Dapr Service Invocation, and uses the MinIO S3 Claim Check pattern for payload management.

**@mesh-six/scraper-service@0.1.0** (new package)
- `src/index.ts`: Hono HTTP server with `POST /scrape` fast-ACK endpoint, background task processing, graceful shutdown
- `src/config.ts`: Environment-driven configuration (Dapr, MinIO, Playwright paths, LiteLLM, OpenTelemetry)
- `src/minio-lifecycle.ts`: MinIO claim-check lifecycle management — `status.json` transitions (PENDING → IN_PROGRESS → COMPLETED | FAILED), `result.md` upload
- `src/dapr-events.ts`: Dapr external event raiser — `ScrapeCompleted` event on k3s Dapr Workflow via `raiseEvent` API
- `src/providers/windsurf.ts`: Windsurf IDE provider — Playwright Electron driver, workspace directory management, keyboard-driven workflow trigger (Meta+Shift+W), file watcher for output.md
- `src/providers/claude-web.ts`: Gemini web provider — Playwright persistent Chrome context, Gem selection via hamburger menu, LiteLLM-powered accessibility tree parsing for dynamic element location, generation wait with loading indicator detection
- `src/scraper.test.ts`: Unit tests for Zod schema validation (ScrapeDispatchPayload, ScrapeStatusFile, ScrapeAckResponse)

**@mesh-six/core@0.11.0**
- `src/scraper-types.ts`: New shared types — `ScrapeDispatchPayloadSchema`, `ScrapeStatusSchema`, `ScrapeStatusFileSchema`, `ScrapeAckResponseSchema`, `ScrapeProviderSchema`, and constants (`SCRAPER_SERVICE_APP_ID`, `SCRAPER_MINIO_BUCKET`, `SCRAPER_MINIO_PREFIX`)
- `src/telemetry.ts`: New shared OpenTelemetry initialization module — `initTelemetry()` with OTLP HTTP trace exporter, HTTP auto-instrumentation, graceful shutdown. Standardizes distributed tracing across k3s and macOS workers.
- `src/index.ts`: Exported new scraper types and telemetry module

**Scripts**
- `scripts/test-scraper.ts`: End-to-end test script — health check, scrape dispatch, task polling, MinIO result verification with detailed troubleshooting output

### Added - 2026-02-27: Remaining Production Readiness Fixes

Resolved 6 remaining items from production readiness audit: orchestrator state persistence, dashboard onboarding view, configurable ntfy notifications, OAuth hardening, webhook K8s env vars, and E2E CI wiring.

**@mesh-six/orchestrator@0.3.0**
- `src/db.ts`: New PostgreSQL persistence module for in-flight task state (CRUD via `orchestrator_tasks` table)
- `src/index.ts`: Persist tasks on dispatch, recover from DB on startup with elapsed-time timeout calculation, checkpoint all tasks on SIGTERM/SIGINT, shared pool with AgentScorer/EventLog

**@mesh-six/dashboard@0.3.0**
- `src/views/OnboardingView.tsx`: New onboarding status view — REST polling + MQTT real-time updates, table with expandable detail rows, OAuth device code display, phase progress tracker
- `src/App.tsx`: Added `/onboarding` route and nav link
- `src/components/StatusBadge.tsx`: Added `configuring` purple variant for auth phase
- `src/hooks/useMqtt.tsx`: Added `onboarding/#` MQTT topic subscription

**@mesh-six/project-manager@0.7.1**
- `src/index.ts`: Configurable ntfy topic via `NTFY_TOPIC` env var (default: `mesh-six-pm`)
- `src/index.ts`: Configurable public reply URL via `MESH_SIX_PUBLIC_URL` env var with Dapr-internal fallback

**@mesh-six/onboarding-service@0.2.1**
- `src/activities/initiate-claude-oauth.ts`: Stricter URL regex (Anthropic/Claude domains only), stricter code regex (XXXX-XXXX), configurable timeout (`CLAUDE_AUTH_TIMEOUT_MS`), 3-attempt retry with exponential backoff, truncated stdout/stderr in error messages
- `src/db.ts`: Added `listOnboardingRuns()` for dashboard consumption
- `src/index.ts`: Added `GET /onboard` list endpoint

**K8s Infrastructure**
- `k8s/base/webhook-receiver/deployment.yaml`: Added `DATABASE_URL`, `VAULT_ADDR`, `VAULT_TOKEN` env vars for multi-project support
- `k8s/base/project-manager/deployment.yaml`: Added `NTFY_TOPIC`, `MESH_SIX_PUBLIC_URL` env vars

**CI/CD**
- `.github/workflows/test.yaml`: Added `workflow_dispatch` trigger and `e2e-tests` job (manual-only, self-hosted runner, 180min timeout)

**Database**
- `migrations/013_orchestrator_tasks.sql`: New table for orchestrator task persistence with status and capability indexes

### Fixed - 2026-02-26: Production Readiness — 12 Blockers Resolved

Systematic audit and fix of all blockers preventing first project onboarding.

**@mesh-six/implementer@0.6.0**
- `actor.ts`: Rewrote `extractBundle()` to download tar.gz from auth-service and extract locally via `zlib.gunzipSync` + ustar tar parsing (was calling nonexistent `POST /bundles/:id/extract`)
- `actor.ts`: Added `authProjectId` param to `onActivate()` for per-repo credential routing (was fixed to `AUTH_PROJECT_ID` env var)
- `config.ts`: Removed `AUTH_PROJECT_ID` (replaced by per-task routing)
- `monitor.ts`: Updated credential re-provisioning to use per-session `authProjectId` from actor state

**@mesh-six/orchestrator@0.4.0**
- `index.ts`: Fixed `retryTask()` to preserve original task payload (was dispatching with `payload: {}`)

**@mesh-six/project-manager@0.7.0**
- `index.ts`: Aligned `ProjectState` enum with workflow states (INTAKE, PLANNING, IMPLEMENTATION, QA, REVIEW, ACCEPTED, FAILED). Updated `canTransition()`, `evaluateReviewGate()`, and SYSTEM_PROMPT.

**@mesh-six/webhook-receiver@0.2.0**
- `index.ts`: Per-repo webhook secret lookup from Vault at `secret/data/mesh-six/webhooks/{owner}-{repo}` with 5-min cache and env var fallback
- `index.ts`: Per-repo `GitHubProjectClient` instantiation from `repo_registry` metadata with cache and env var fallback
- `index.ts`: Fixed label filtering — extracts actual labels from webhook payload for `shouldProcessIssue()`
- Added `pg` dependency for `repo_registry` lookups

**@mesh-six/onboarding-service@0.2.0**
- `generate-kube-manifests.ts`: Rewrote to commit manifests via Octokit Contents API (was using `Bun.write()` to container filesystem)
- `update-kustomization.ts`: Rewrote to read/update via Octokit Contents API
- `trigger-sync.ts`: Simplified to no-op (prior activities now commit via GitHub API)
- `initiate-claude-oauth.ts`: Replaced nonexistent `--print-device-code` flag with stdout/stderr capture approach
- `verify-pod-health.ts`: Replaced `kubectl` shell command with in-cluster Kubernetes API via fetch
- Generated StatefulSet now includes `imagePullSecrets` and removes Dapr health probes from Envbuilder container

**K8s Infrastructure**
- `k8s/base/onboarding-service/rbac.yaml`: ServiceAccount + Role (pod reader) + RoleBinding
- `k8s/base/vault-external-secrets-main.yaml`: ExternalSecret for `mesh-six-secrets` (9 keys from Vault)
- `k8s/overlays/prod/kustomization.yaml`: Added image entries for auth-service, implementer, onboarding-service, context-service

**CI/CD**
- `.github/workflows/build-deploy.yaml`: Added onboarding-service, context-service to build matrix
- `.github/workflows/test.yaml`: Added auth-service, implementer, llm-service, context-service, onboarding-service to test matrix
- `.github/workflows/publish-devcontainer-feature.yaml`: New workflow to publish mesh-six-tools feature to Gitea OCI registry

### Added - 2026-02-26: Onboarding Service — Automated Project Onboarding

Dapr Workflow-based service for automating new project onboarding into mesh-six. Three-phase workflow: initialization (GitHub project board, webhooks, database registration, backend provisioning), dev environment provisioning (devcontainer scaffolding, Envbuilder StatefulSet generation, ArgoCD sync), and auth & settings (Claude OAuth device flow, LiteLLM team routing, app settings). Exposes HTTP API and MCP server for programmatic onboarding.

**@mesh-six/onboarding-service@0.1.0**
- `src/workflow.ts`: Dapr Workflow with 14 activity stubs across 3 phases, `waitForExternalEvent("oauth-code-received")` for OAuth pause/resume
- `src/index.ts`: Hono HTTP server — `POST /onboard`, `GET /onboard/:id`, `POST /onboard/:id/auth-callback`; `--mcp` flag for stdio MCP mode
- `src/mcp.ts`: MCP server with `onboard-project`, `get-onboarding-status`, `submit-oauth-code` tools
- `src/db.ts`: `insertRun`, `getRun`, `updateRunStatus` with dynamic SET clause builder
- `src/schemas.ts`: Zod schemas — `OnboardProjectRequestSchema`, `AuthCallbackSchema`, `ResourceLimitsSchema`, `LiteLLMConfigSchema`
- `src/config.ts`: environment variable configuration
- `src/activities/validate-repo.ts`: Octokit REST — verify repo exists, return metadata
- `src/activities/create-project-board.ts`: GitHub Projects v2 via GraphQL with custom fields (Session ID, Pod Name, Workflow ID, Priority)
- `src/activities/register-webhook-secret.ts`: HMAC secret generation and Vault storage
- `src/activities/register-in-database.ts`: `repo_registry` upsert with project field IDs in metadata JSONB
- `src/activities/provision-backend.ts`: PostgreSQL connectivity check, MinIO prefix marker creation
- `src/activities/scaffold-devcontainer.ts`: Push default `devcontainer.json` template to repo if missing
- `src/activities/generate-kube-manifests.ts`: Generate per-project StatefulSet (Envbuilder), Service, kustomization at `k8s/base/envs/{owner}-{repo}/`
- `src/activities/update-kustomization.ts`: Append generated env directory to `k8s/base/kustomization.yaml`
- `src/activities/trigger-sync.ts`: Git commit + push generated manifests
- `src/activities/verify-pod-health.ts`: Poll kubectl for pod readiness with timeout
- `src/activities/initiate-claude-oauth.ts`: Claude CLI device flow — parse URL and user code
- `src/activities/store-claude-credentials.ts`: Push credentials to auth-service via Dapr
- `src/activities/configure-litellm.ts`: Create LiteLLM team + virtual key with idempotency
- `src/activities/configure-app-settings.ts`: Push project settings to auth-service

**Database**
- `migrations/012_onboarding_runs.sql`: `onboarding_runs` table (status, phase tracking, OAuth device URL/code, completed activities), `execution_mode` column on `repo_registry`

**K8s**
- `k8s/base/onboarding-service/`: Deployment + Service + kustomization (Dapr-annotated, mesh-six-secrets)

### Added - 2026-02-26: Dev Container Feature — mesh-six-tools

Custom devcontainer feature for Envbuilder-based agent pods. Installs tmux, jq, GitHub CLI, and Claude Code CLI from npm. Requires Node.js feature (`ghcr.io/devcontainers/features/node`) as a prerequisite.

**devcontainer-features/mesh-six-tools@1.0.0**
- `devcontainer-features/mesh-six-tools/devcontainer-feature.json`: Feature manifest — `claudeVersion` option (npm semver, default `latest`), `installsAfter` node feature, `MESH_SIX_TOOLS_VERSION` container env
- `devcontainer-features/mesh-six-tools/install.sh`: Installs system deps (tmux, curl, jq, watch, ca-certificates, gnupg), GitHub CLI via apt (official keyring), Claude Code CLI via npm global install with version pinning support

**Templates**
- `templates/devcontainer/devcontainer.json`: Reference devcontainer config using `mcr.microsoft.com/devcontainers/base:ubuntu` with node@22 + mesh-six-tools features, `runner` as remote and container user

### Added - 2026-02-26: Session REST API (GWA Phase 21 API Layer)

REST API endpoints for mobile app and external dashboard consumption.

**@mesh-six/implementer@0.5.0**
- `session-db.ts`: `listSessions(filters?)` — paginated session list with optional status/repo filters
- `index.ts`: `GET /sessions` — list sessions with query params (`status`, `repoOwner`, `repoName`, `limit`, `offset`), returns `{ sessions, total }`
- `index.ts`: `GET /sessions/:id` — aggregated session detail (session + questions + latest checkpoint)
- `index.ts`: `POST /sessions/:id/answer` — REST wrapper around actor `injectAnswer` for answering blocked session questions

### Added - 2026-02-26: Live Terminal Streaming & Snapshots (GWA Phase 20 Migration)

MQTT-based live terminal output streaming, asciicast v2 session recordings with MinIO S3 upload, ANSI terminal snapshots at lifecycle events, and a dashboard terminal viewer with xterm.js.

**@mesh-six/core@0.10.0**
- `terminal-types.ts`: Zod schemas and types — `TerminalSnapshotSchema`, `RecordingMetadataSchema`, `TerminalStreamChunkSchema`, topic constants (`TERMINAL_STREAM_TOPIC_PREFIX`, `TERMINAL_SNAPSHOT_TOPIC_PREFIX`), `SNAPSHOT_EVENT_TYPES`
- `minio.ts`: shared MinIO S3 client module — `createMinioClient`, `uploadToMinio`, `downloadFromMinio`, `getPresignedUrl` (re-exported as `getMinioPresignedUrl`), `MinioConfig`

**@mesh-six/implementer@0.4.0**
- `terminal-relay.ts`: FIFO-based live terminal streaming via Dapr pubsub, asciicast v2 recording, 100ms/4KB batch chunking — `startPaneStream`, `stopPaneStream`, `takeSnapshot`, `isStreamActive`, `shutdownAllStreams`
- `actor.ts`: terminal stream lifecycle — `startPaneStream` in `startSession()`, `takeSnapshot` in `injectAnswer()`, `stopPaneStream` in `onDeactivate()`, `setDependencies()` for DaprClient/Pool injection
- `monitor.ts`: snapshot triggers at question detection (`session_blocked`) and completion (`session_completed`/`session_failed`), `pool` added to `MonitorContext`
- `session-db.ts`: `insertSnapshot`, `getSessionSnapshots`, `insertRecording`, `getSessionRecordings`, `getRecordingById`, `updateStreamingActive`
- `index.ts`: REST endpoints (`/sessions/:id/snapshots`, `/sessions/:id/recordings`, `/recordings/:id/url`), `shutdownAllStreams` in SIGTERM handler, Pool-based DB connection
- Migration `011_terminal_streaming.sql`: `terminal_snapshots` table, `terminal_recordings` table, `streaming_active` column on `implementation_sessions`

**@mesh-six/dashboard@0.2.0**
- `useTerminalStream.tsx`: MQTT subscription hook for `terminal/stream/{sessionId}` and `terminal/snapshot/{sessionId}`
- `TerminalViewer.tsx`: live xterm.js terminal viewer with MQTT chunk rendering and mid-stream join via REST snapshot fetch
- `RecordingPlayer.tsx`: asciicast v2 playback with xterm.js (play/stop, progress tracking)
- `SnapshotTimeline.tsx`: timeline of ANSI terminal snapshots with xterm.js preview at each lifecycle event
- `SessionTerminalView.tsx`: tabbed view (Live | Snapshots | Recordings) at `/sessions/:sessionId/terminal`
- `useMqtt.tsx`: added `terminal/stream/#` and `terminal/snapshot/#` topic subscriptions
- `App.tsx`: added Sessions nav item and terminal route

**K8s Infrastructure**
- `k8s/base/implementer/statefulset.yaml`: MinIO env vars (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`), `stream-tmp` emptyDir volume (500Mi) mounted at `/tmp/mesh-six-streams` and `/tmp/mesh-six-recordings`

### Added - 2026-02-26: GWA Bug Fixes — Session Recovery, GitHub Comments, PR Filtering, Operational Scripts

Parallel work across five areas: implementer session recovery with Claude `--resume`, GitHub issue comment integration for workflow status, PR/issue filtering in webhook-receiver, planning prompt templates, and a full suite of operational scripts and CronJobs.

**@mesh-six/core@0.9.0**
- `git.ts`: typed git operations library (`cloneRepo`, `createWorktree`, `removeWorktree`, `listWorktrees`, `getDiff`, `getStatus`, `createBranch`, `checkoutBranch`, `stash`, `stashPop`, `getCurrentBranch`, `getLatestCommit`, `GitError`)
- `pr-filter.ts`: PR and issue filter logic (`shouldProcessIssue`, `shouldProcessPR`, `loadFilterConfigFromEnv`, `FilterConfig`, `IssueInfo`, `PRInfo`)
- `comment-generator.ts`: LLM-powered GitHub comment generation (`generateComment`, `generateSessionSummary`, `formatStatusComment`, `CommentType`, `CommentOptions`, `SessionSummaryInput`)
- `github.ts`: new `GitHubProjectClient` methods — `createOrUpdateComment`, `findBotComment`, `updateProjectItemField`
- `git.test.ts`: comprehensive tests for all git operations (mock-based + real repo integration tests)
- `pr-filter.test.ts`: full coverage for `shouldProcessIssue`, `shouldProcessPR`, and `loadFilterConfigFromEnv`

**@mesh-six/implementer@0.3.0**
- `checkpoint.ts`: pre-action state snapshots into `session_checkpoints` table (`createCheckpoint`, `getLatestCheckpoint`, `restoreFromCheckpoint`)
- `recovery.ts`: pod startup recovery — marks interrupted sessions, finds resumable sessions with `claude_session_id`, builds resume context from latest checkpoint
- `github-integration.ts`: PR creation via `gh` CLI and structured comment posting (`createPR`, `postCompletionComment`, `postProgressUpdate`)
- `actor.ts`: `claudeSessionId` field on `ActorState`, `storeClaudeSessionId` method, `--resume` support in `startSession`, `createPreActionCheckpoint` method using `@mesh-six/core` git utilities
- `session-db.ts`: `updateClaudeSessionId`, `insertCheckpoint`, `getLatestCheckpoint`, `markSessionInterrupted` — session resume + checkpoint DB operations
- `podStartupRecovery` exported from `actor.ts` — calls `recoverInterruptedSessions` on pod start
- Migration `010_session_resume_fields.sql`: `claude_session_id`, `last_checkpoint_at`, `interrupted_at` columns + `session_checkpoints` table

**@mesh-six/project-manager@0.6.0**
- `comment-activities.ts`: workflow activities for GitHub issue comments (`postStatusComment`, `postProgressComment`, `syncPlanToIssue`, `updateProjectCustomFields`)
- `plan-templates.ts`: markdown template loading and instantiation (`loadTemplate`, `buildTemplate`, `instantiatePlan`, `formatPlanForIssue`, `parsePlanFromComment`)
- `workflow.ts`: `postStatusCommentActivity` calls at PLANNING, IN_PROGRESS, QA, REVIEW, and ACCEPTED transitions; `syncPlanToIssueActivity` on plan approval; `buildTemplate("prompt", ...)` for planning prompt construction; `formatPlanForIssue` on plan rejection comments; `updateProjectCustomFieldsActivity` for session field tracking
- Templates: `templates/plans/plan.md`, `templates/plans/prompt.md`, `templates/plans/checklist.md`, `templates/plans/decisions.md`

**@mesh-six/webhook-receiver@0.2.0**
- Issue/PR filtering via `shouldProcessIssue` and `loadFilterConfigFromEnv` from `@mesh-six/core`
- Filter applied to both webhook-triggered `new-todo` events and polling-discovered items
- Supports `FILTER_ALLOWED_AUTHORS`, `FILTER_REQUIRED_LABELS`, `FILTER_EXCLUDE_LABELS`, `FILTER_BRANCH_PATTERNS`, `FILTER_EXCLUDE_DRAFTS` env vars

**Operational Scripts**
- `scripts/cleanup.ts`: remove stale completed/failed sessions and purge old checkpoints/activity logs (with `--dry-run`, `--retention-days`, `--log-retention-days`)
- `scripts/credential-backup.ts`: export credentials to MinIO via `mc` CLI with pruning by retention days
- `scripts/onboard-repo.ts`: onboard a GitHub repo — creates Projects v2, custom fields, links repo, inserts into `repo_registry`
- `scripts/setup-project.ts`: standalone GitHub Projects v2 setup with standard mesh-six columns and fields
- `scripts/debug-db.ts`: database diagnostics — active workflows, sessions, pending questions, architect events, health counts
- `scripts/credential-history.ts`: credential expiry status report per project with expiring-soon warnings

**K8s CronJobs**
- `k8s/base/cleanup-cronjob/`: daily CronJob (`0 3 * * *`) running `scripts/cleanup.ts` with `--retention-days 7 --log-retention-days 30`
- `k8s/base/credential-backup-cronjob/`: every-6h CronJob (`0 */6 * * *`) running `scripts/credential-backup.ts`
- `k8s/base/kustomization.yaml`: added `cleanup-cronjob/` and `credential-backup-cronjob/` to resources

### Added - 2026-02-26: GWA Migration — Event-Driven Workflow with Architect Actor

**@mesh-six/core@0.8.0**
- `ArchitectActorStateSchema`, `ArchitectEventSchema`, `ARCHITECT_ACTOR_TYPE` and typed event payload schemas (`PlanningEventPayload`, `ImplEventPayload`, `QaEventPayload`, `HumanAnswerPayload`)
- `AnswerQuestionOutputSchema` for architect actor confidence-based responses
- Removed `SESSION_BLOCKED_TOPIC` (replaced by Dapr workflow `raiseEvent`)

**@mesh-six/architect-agent@0.2.0**
- `ArchitectActor` Dapr actor class with per-issue instances and PostgreSQL event log
- Actor methods: `initialize`, `consult`, `answerQuestion`, `receiveHumanAnswer`, `getHistory`
- Mem0 integration for cross-issue learning (generalized Q&A stored to global `architect` scope)
- `event-db` module (`appendEvent`, `loadEvents`, `loadEventsByType`)
- `actor-runtime.ts` (Dapr actor HTTP protocol) and `config.ts`
- Dapr actor HTTP routes wired into Hono service

**@mesh-six/project-manager@0.5.0**
- Event-driven PLANNING phase: `waitForExternalEvent("planning-event")` replaces polling
- Event-driven IMPLEMENTATION phase: `waitForExternalEvent("impl-event")` replaces polling
- Event-driven QA phase: `waitForExternalEvent("qa-event")` replaces polling
- Complexity gate: `simple` label skips Opus planning
- Architect actor question loop: questions routed through `ArchitectActor.answerQuestion`, confident answers injected back into Claude CLI, low-confidence escalated to human via ntfy
- Human answer flow: ntfy reply webhook -> `raiseEvent("human-answer")` -> `processHumanAnswer` -> Mem0 learning
- New activities: `complexityGate`, `startSession`, `consultArchitectActor`, `injectAnswer`, `notifyHumanQuestion`, `processHumanAnswer`, `initializeArchitectActor`
- Removed polling activities (`pollForPlan`, `pollForImplementation`, `pollForTestResults`) and `pollGithubForCompletion` helper

**@mesh-six/implementer@0.2.0**
- `workflowId` field on `ActorState` for workflow event correlation
- `injectAnswer` method on `ImplementerActor` for injecting answers via `tmux send-keys`
- `SessionMonitor` raises typed events on workflow instances via Dapr HTTP `raiseEvent` API
- `questionDetected` flag properly resets after answer injection

**Infrastructure**
- Migration `009_architect_events.sql`: `architect_events` table with actor_id, event_type, JSONB payload
- K8s: actor annotations on architect-agent deployment, `architect-agent` added to `statestore-actor-redis` scopes

### Added - 2026-02-25: PM Enhancements — Retry Budget, Parallel Workflows, PM Autonomy

Three enhancements to the project-manager: DB-backed retry budgets replace hardcoded cycle limits, in-memory Maps replaced with PostgreSQL lookups to support concurrent workflows, and a two-agent auto-resolve cascade for blocked questions.

#### Core Library
- **@mesh-six/core@0.7.1**: Add `TokenBucket` rate limiter for GitHub API calls
  - New `TokenBucket` class with configurable `maxTokens` and `refillRate`
  - Applied to all `GitHubProjectClient` API methods (50 burst, 80/min refill → ~4800/hr safely under 5000/hr limit)
  - New `TokenBucketConfig` type export

#### Project Manager
- **@mesh-six/project-manager@0.4.0**: Retry budget, auto-resolve, concurrent workflow support
  - **Retry budget**: `planCyclesUsed`/`qaCyclesUsed`/`retryBudget`/`failureHistory` columns in `pm_workflow_instances` — configurable per-issue via `retryBudget` workflow input, failure reasons tracked as JSONB array
  - **Auto-resolve**: Two-agent cascade for blocked questions — extract question via LLM, classify type (architectural/technical-research/credential-access/ambiguous), consult architect then researcher if needed, evaluate confidence, post answer or escalate via ntfy with best-guess
  - **In-memory Map removal**: Deleted `projectWorkflowMap` and `projects` Maps, replaced with `lookupByIssue()` and new `lookupByWorkflowId()` PostgreSQL helpers — prerequisite for concurrent workflows
  - **Poll jitter**: 0-5s random jitter on `pollGithubForCompletion` sleep intervals to prevent synchronized polling from concurrent workflows
  - New activity types: `LoadRetryBudgetInput/Output`, `IncrementRetryCycleInput`, `AttemptAutoResolveInput/Output`

#### Database Migrations
- `008_pm_retry_budget.sql`: Add `plan_cycles_used`, `qa_cycles_used`, `retry_budget`, `failure_history` columns to `pm_workflow_instances`

### Added - 2026-02-25: GWA Migration — Auth Service, Implementer Agent, Credential Management

Merge github-workflow-agents (GWA) credential management, dialog handling, and implementation agent into mesh-six. Auth-service replaces GWA orchestrator for credential lifecycle. LLM service drops GWA dependency. Implementer agent runs Claude CLI in tmux for autonomous code implementation.

#### Core Library
- **@mesh-six/core@0.7.0**: Add credential utilities, dialog handler, and auth/session types
  - New `credentials.ts` module: `isCredentialExpired`, `syncEphemeralConfig`, `buildCredentialsJson`, `buildConfigJson`, `buildSettingsJson`, `buildClaudeJson`
  - New `dialog-handler.ts` module: `matchKnownDialog`, `parseDialogResponse`, `looksNormal`, `KNOWN_DIALOGS`, `DIALOG_ANALYSIS_PROMPT`, `ClaudeDialogError`
  - New auth Zod schemas: `ProjectConfigSchema`, `CredentialPushRequestSchema`, `ProjectCredentialSchema`, `ProvisionRequestSchema`, `ProvisionResponseSchema`, `CredentialHealthSchema`
  - New session types: `ImplementationSessionSchema`, `SessionQuestionSchema`
  - New constants: `AUTH_SERVICE_APP_ID`, `CREDENTIAL_REFRESHED_TOPIC`, `CONFIG_UPDATED_TOPIC`, `SESSION_BLOCKED_TOPIC`
  - Add `claude.test.ts` covering all 15 GWA auth failure patterns

#### New Service: Auth Service
- **@mesh-six/auth-service@0.1.0**: Hono+Dapr microservice for credential lifecycle management
  - Project CRUD: `POST /projects`, `GET /projects/:id`, `PUT /projects/:id`
  - Credential management: `POST /projects/:id/credentials` (push), `GET /projects/:id/health`, `POST /projects/:id/refresh`
  - Bundle provisioning: `POST /projects/:id/provision`, `GET /projects/:id/provision/:bundleId` (tar.gz with .credentials.json, config.json, settings.json, .claude.json)
  - OAuth refresh timer: auto-refreshes expiring credentials every 30 minutes
  - Dapr pub/sub: publishes `credential-refreshed` and `config-updated` events

#### New Agent: Implementer
- **@mesh-six/implementer@0.1.0**: StatefulSet agent for autonomous Claude CLI code implementation
  - Dapr actor runtime: one actor per issue session, lifecycle management (provision → clone → worktree → tmux)
  - Tmux session management: create/send/capture/kill sessions via Bun.spawn
  - Session monitoring: periodic pane capture, auth failure detection, question detection, completion detection
  - Session DB: full CRUD for implementation_sessions, session_prompts, session_tool_calls, session_activity_log, session_questions
  - `docker/Dockerfile.implementer`: Bun + tmux + git + Claude CLI

#### LLM Service Migration
- Replace `gwa-client.ts` with `auth-client.ts` — provision credentials from auth-service via Dapr service invocation
- Add `credential-refreshed` event subscription for proactive credential sync
- Remove GWA env vars (GWA_ORCHESTRATOR_URL, GWA_API_KEY, GWA_PROJECT_ID), add AUTH_PROJECT_ID

#### Infrastructure
- K8s: auth-service Deployment + Service (Dapr sidecar, PG secrets, 128Mi/256Mi)
- K8s: implementer StatefulSet + headless Service (Dapr sidecar, PVCs: claude-session 10Gi + worktrees 30Gi)
- CI: add auth-service and implementer to build matrix, map implementer to custom Dockerfile
- Update llm-service deployment: replace GWA env vars with AUTH_PROJECT_ID

#### Database Migrations
- `006_auth_tables.sql`: auth_projects, auth_credentials (with partial indexes), auth_bundles
- `007_session_tables.sql`: implementation_sessions, session_prompts, session_tool_calls, session_activity_log, session_questions

#### Scripts
- `scripts/push-credentials.ts`: CLI to push local Claude credentials to auth-service

### Fixed - 2026-02-21: Add llm-service to CI/CD Build Pipeline

#### CI/CD
- Add `llm-service` to `BUILDABLE_AGENTS` in build-deploy workflow so CI builds its container image
- Add Dockerfile selection logic to use `docker/Dockerfile.llm-service` instead of the default `Dockerfile.agent`
- Add change detection for `docker/Dockerfile.llm-service` to trigger llm-service rebuilds
- Add `mesh-six-llm-service` image tag override to prod kustomization overlay

#### Docker
- Fix `Dockerfile.llm-service`: install Claude CLI as root, chmod `/root` and `/root/.bun` world-readable — resolves "Executable not found" at actor activation
- Bump llm-service memory limits from 512Mi to 2Gi (Claude CLI OOMKilled at 512Mi)

#### LLM Service
- **@mesh-six/llm-service@0.1.1**: Fix `validateCLI` to only reject on auth errors, not non-zero exit codes — CLI returns exit 1 with valid JSON init messages in `--output-format json` mode

### Fixed - 2026-02-20: Core LLM Module Type Fixes

#### Core Library
- **@mesh-six/core@0.6.1**: Fix typecheck failures in `llm.ts` and remove dead `ai.ts`
  - Change `chatCompletionWithSchema` generic from `z.ZodType<T>` to `S extends z.ZodTypeAny` so `z.infer<S>` preserves Zod optional field types — fixes type assignment errors in api-coder, ui-agent, and any consumer using schemas with optional fields
  - Fix `messages[i]` possibly-undefined strict mode errors in `chatCompletionWithSchema` (affected dashboard typecheck)
  - Fix `fenceMatch[1]` possibly-undefined in JSON fence extraction
  - Delete dead `ai.ts` and `ai.test.ts` that still imported removed `ai` (Vercel AI SDK) package

### Added - 2026-02-19: LLM Service (Dapr Actor-based Claude CLI Gateway)

#### New Service: LLM Service
- **@mesh-six/llm-service@0.1.0**: Centralized Claude CLI gateway with Dapr actor concurrency control
  - OpenAI-compatible `/v1/chat/completions` endpoint — agents swap `LITELLM_BASE_URL` to use CLI instead of API
  - Dapr actor runtime implemented directly in Hono (no DaprServer dependency)
    - `ClaudeCLIActor` type: one actor per credential set, turn-based concurrency (no 429s)
    - Dapr placement service handles actor scheduling across nodes
    - Timer-based credential sync back to MinIO (configurable interval)
  - MinIO credential management: download/extract tar.gz archives on actor activation, sync back on timer and deactivation
  - Per-actor config isolation: each actor gets its own `CLAUDE_CONFIG_DIR` with separate credentials, settings, skills, and MCP server configs
  - Capability-aware actor routing: route requests to actors with matching skills, LRU selection among idle actors
  - Session persistence: optional session save/restore via MinIO for multi-turn conversations
  - Model selection with allowlist: validate requested model against Dapr config, reject unsupported models
  - Hook event publisher (`hooks/event-publisher.ts`): Bun script receives CLI hook events via stdin, publishes to Dapr pub/sub (`llm.events` topic) for real-time MQTT streaming
  - OpenAI compatibility layer: maps chat completion requests to `claude -p --output-format json`, structured output via schema injection into prompts
  - `/v1/models` endpoint lists allowed models, `/status` shows actor health and service metrics
  - Custom Dockerfile (`docker/Dockerfile.llm-service`) with Claude CLI pre-installed
  - K8s manifests with Dapr actor config, dedicated actor state store (Redis, scoped to llm-service)

#### Core Library
- **@mesh-six/core@0.6.0**: LLM service types and constants
  - `ChatCompletionRequest/Response` Zod schemas (OpenAI-compatible)
  - `ActorInfo`, `ActorStatus`, `LLMServiceStatus` schemas for actor management
  - `CLIHookEvent` schema for hook event publishing
  - Constants: `DAPR_LLM_SERVICE_APP_ID`, `LLM_EVENTS_TOPIC`, `LLM_ACTOR_TYPE`, `LLM_CONFIG_KEYS`

#### Infrastructure
- K8s manifests for llm-service (Deployment + Service + Dapr Configuration)
- `statestore-actor-redis.yaml`: Dedicated Redis state store with `actorStateStore: "true"`, scoped to llm-service
- Added llm-service to `k8s/base/kustomization.yaml`

### Added - 2026-02-19: Context Service

#### New Service: Context Compression Proxy
- **@mesh-six/context-service@0.1.0**: Hybrid deterministic + LLM context compression proxy
  - Two-stage compression pipeline: deterministic rule engine (instant, no LLM cost) + Phi3.5 LLM fallback via LiteLLM
  - Output validation with hallucination detection and format compliance checks
  - Graceful degradation chain: deterministic → LLM → rule fallback → raw passthrough (never fails)
  - `POST /compress` endpoint for Dapr service invocation by other agents

#### Core Library
- **@mesh-six/core**: Added compression Zod schemas
  - `CompressionRequest` — payload schema for `/compress` requests
  - `CompressionResponse` — typed response including compressed output and stage metadata
  - `CompressionRule` — schema for individual deterministic compression rules

#### PM Workflow Enhancement
- **@mesh-six/project-manager**: Added `compressContextActivity` to Dapr Workflow
  - Compresses context before architect consultation in the INTAKE phase
  - Reduces token usage on architect LLM calls by pre-processing context through context-service

### Added - Milestone 4.5: GWA Integration (PM Agent ↔ GitHub Workflow Agents)

#### New Service: Webhook Receiver
- **@mesh-six/webhook-receiver@0.1.0**: GitHub Projects board event bridge
  - `POST /webhooks/github` — HMAC-SHA256 validation, `projects_v2_item` event parsing
  - Classifies column transitions into typed BoardEvents: `new-todo`, `card-blocked`, `card-unblocked`, `card-moved`
  - Publishes events to Dapr `agent-pubsub` topic `board-events`
  - Dedup by `X-GitHub-Delivery` header (1-hour TTL)
  - 3-minute polling safety net via GitHub Projects GraphQL API for missed Todo items
  - Self-move filtering via Dapr state store `pending-moves:{itemId}` keys
  - Health/readiness endpoints, Dapr subscription endpoints

#### PM Workflow Rewrite
- **@mesh-six/project-manager@0.3.0**: Board-driven Dapr Workflow with GitHub API polling
  - New workflow states: INTAKE → PLANNING → IMPLEMENTATION → QA → REVIEW → ACCEPTED/FAILED
  - 18 typed activities (vs 6 in M4): consultArchitect, enrichIssue, moveCard, recordPendingMove, pollForPlan, pollForImplementation, pollForTestResults, reviewPlan, evaluateTestResults, waitForDeployment, validateDeployment, addComment, createBugIssue, notifyBlocked, notifyTimeout, recordWorkflowMapping, reportSuccess, moveToFailed
  - `pollGithubForCompletion()` generic polling helper with deadline + blocked detection
  - Bounded retry loops: max 3 plan revision cycles, max 3 QA cycles
  - External event handling for `card-blocked`/`card-unblocked`/`qa-ready` via Dapr Workflow
  - ntfy.sh push notifications on blocked/timeout states
  - `POST /board-events` handler: starts workflows on `new-todo`, raises external events on blocked/unblocked
  - `pm_workflow_instances` PostgreSQL table for issue↔workflow mapping

#### Core Library
- **@mesh-six/core@0.5.0**: Board event types and GitHub Projects client
  - `BoardEvent` Zod discriminated union: `NewTodoEvent`, `CardBlockedEvent`, `CardUnblockedEvent`, `CardMovedEvent`
  - `GitHubProjectClient` class (`github.ts`): GitHub Projects v2 GraphQL + REST operations
    - `loadColumnMapping()`, `moveCard()`, `getItemColumn()`, `getProjectItemsByColumn()`
    - `getIssueComments()`, `getIssuePRs()`, `addIssueComment()`, `createIssue()`
  - Added `@octokit/graphql` and `@octokit/rest` dependencies

#### Database
- **migrations/004_pm_workflow_instances.sql**: Workflow instance tracking table
  - Tracks issue↔workflow mapping with `issue_number`, `workflow_id`, `current_phase`, `status`
  - Unique constraint on `(issue_number, repo_owner, repo_name)` for dedup
  - Indexes on `(status, current_phase)` and `(repo_owner, repo_name, issue_number)`

#### Infrastructure
- K8s manifests for webhook-receiver (Deployment + Service with Dapr sidecar)
- Added webhook-receiver to `k8s/base/kustomization.yaml`

### Fixed
- **migrations/003_mesh_six_events.sql**: Fixed unique index on partitioned table to include partition column `timestamp`

### Added - Event Log Module
- **@mesh-six/core@0.4.0**: Immutable event log and traced LLM wrappers
  - `EventLog` class (`events.ts`): append-only event store with `emit()`, `emitBatch()`, `query()`, `replay()` methods
  - `MeshEvent` and `EventQueryOpts` interfaces for structured event data
  - `tracedGenerateText()` wrapper (`ai.ts`): instruments Vercel AI SDK `generateText` with `llm.call` and `llm.response` events
  - `TraceContext` interface for passing event log context through agent calls
  - Graceful degradation: agents skip event logging when DATABASE_URL is not set
  - 15 new tests (events.test.ts + ai.test.ts), total suite now 85 tests
- **@mesh-six/event-logger@0.1.0**: Standalone pub/sub event tap service
  - Subscribes to `task-results` and `task-progress` Dapr pub/sub topics
  - Writes events to `mesh_six_events` partitioned table via EventLog
  - Health/readiness endpoints, no LLM or memory dependencies
  - K8s manifests in `k8s/base/event-logger/`
- **migrations/003_mesh_six_events.sql**: Partitioned event store table
  - Monthly partitions (2026-02 through 2026-04)
  - Indexes on trace_id, task_id, agent_id+event_type, aggregate_id, idempotency_key (unique)
- **All 11 LLM agents migrated** from direct `generateText` to `tracedGenerateText`
  - simple-agent, architect-agent, researcher-agent, qa-tester, api-coder, ui-agent, infra-manager
  - cost-tracker, homelab-monitor, argocd-deployer, kubectl-deployer
  - orchestrator: emits task.dispatched, task.timeout, task.retry events via EventLog
  - project-manager: Pool + EventLog initialization (no generateText calls to migrate)

### Changed - Claude MQTT Bridge: Local SQLite Storage
- **@mesh-six/claude-mqtt-bridge@0.2.0**: SQLite local event storage
  - All hook events now stored to `$CLAUDE_PROJECT_DIR/.claude/claude-events.db` via `bun:sqlite` (zero deps)
  - WAL mode for concurrent-safe writes from parallel async hooks
  - Indexed columns: `(session_id, timestamp)`, `(event, timestamp)`, `(tool_name)`
  - Full enriched event stored in `payload` JSON column for ad-hoc queries
  - MQTT publishing still attempted but failures are now silent (expected locally)
  - Removed racy JSONL fallback (read-then-write was not concurrent-safe)
  - New env vars: `SQLITE_DB_PATH` (default: `$CLAUDE_PROJECT_DIR/.claude/claude-events.db`), `SQLITE_DISABLED`
- **docs/CLAUDE_PROGRESS_UI.md**: Added local development section with SQLite query examples

### Added - Milestone 5: Infrastructure Agents
- **@mesh-six/homelab-monitor@0.1.0**: Cluster health monitoring agent
  - Capabilities: `cluster-monitoring` (1.0), `log-analysis` (0.9), `alert-triage` (0.85)
  - Tools: query_grafana, query_loki, query_prometheus, check_pod_health, get_alerts
  - Grafana/Loki/Prometheus integration for Jay's k3s homelab
  - Memory integration for alert patterns and resolution history
- **@mesh-six/infra-manager@0.1.0**: DNS & proxy management agent
  - Capabilities: `dns-management` (1.0), `proxy-management` (0.9), `firewall-management` (0.8)
  - Tools: cloudflare_dns_list/create/update, cloudflare_tunnel_list, caddy_get_config/update_route
  - Cloudflare + Caddy integration with safety guards (read-before-write)
  - Memory integration for DNS records and proxy configurations
- **@mesh-six/cost-tracker@0.1.0**: LLM spend & resource tracking agent
  - Capabilities: `cost-reporting` (1.0), `usage-analysis` (0.9), `spend-alerting` (0.85)
  - Tools: query_litellm_spend/models, query_cluster_resources, generate_cost_report
  - LiteLLM spend API and Prometheus resource usage integration
  - Memory integration for spending trends and anomaly patterns

### Added - CI/CD Pipeline
- **.github/workflows/build-deploy.yaml**: Matrix build pipeline for all agents
  - Change detection: rebuilds only affected agents (plus all if core/ changes)
  - Docker build with shared Dockerfile.agent, push to registry.bto.bar
  - Tags: `:latest` and `:{sha}` per agent
  - Manual trigger with optional agent targeting
- **.github/workflows/test.yaml**: PR validation pipeline
  - Core library typecheck + tests
  - Matrix typecheck for changed apps

### Added - K8s & Dapr Infrastructure Completion
- K8s manifests for homelab-monitor, infra-manager, cost-tracker, dashboard (15 total services)
- Dashboard served via nginx (no Dapr sidecar) as static Vite SPA
- **dapr/components/outbox-postgresql.yaml**: Atomic state + publish via outbox pattern
- **k8s/argocd-application.yaml**: ArgoCD Application CR with automated sync, prune, selfHeal
- **k8s/overlays/prod/**: Image entries for all 15 agents
- **k8s/base/secrets.yaml**: Added cloudflare-secret for infra-manager

### Added - Milestone 4 Completion: Context Integration, Tests, Dashboard, K8s

#### Context Management Integration
- **@mesh-six/project-manager@0.2.1**: Wired context.ts into PM workflow
  - `evaluateReviewGate()` now uses `buildAgentContext()` for bounded context with scoped Mem0 memories
  - `transitionClose()` runs reflection after LLM review gate responses, storing learnings (task/agent/project/global scope)
  - `consultArchitect()` captures learnings from architect consultations via `transitionClose()`
  - Graceful degradation: falls back to direct prompts when memory is unavailable

#### Core Library Test Suite
- **@mesh-six/core@0.3.0**: Comprehensive test suite (70 tests, 135 assertions)
  - `scoring.test.ts`: AgentScorer rolling success rates, recency boost, dependency health, preferred bonus, sorting
  - `registry.test.ts`: AgentRegistry CRUD, heartbeat, stale detection (degraded/offline), capability filtering
  - `context.test.ts`: buildAgentContext assembly/truncation/estimation, transitionClose reflection + scoped storage
  - `types.test.ts`: All 6 Zod schemas — validation, defaults, enum constraints, edge cases
  - All tests mock external dependencies (Pool, DaprClient, AgentMemory, LLM) — no infrastructure required

#### Web Dashboard
- **@mesh-six/dashboard@0.1.0**: React + Vite + Tailwind real-time monitoring UI
  - Agent Registry view: table with status badges, capability chips, relative heartbeat times
  - Task Feed view: real-time scrolling task events from MQTT
  - Project Lifecycle view: state machine visualization (8 states) with project history
  - MQTT WebSocket integration via `MqttProvider` hook (configurable via `VITE_MQTT_URL`)
  - Dark theme with mesh-six indigo branding
  - Shared components: StatusBadge, RelativeTime, ConnectionIndicator

#### K8s Manifest Audit
- **k8s/base/claude-mqtt-bridge/**: New K8s manifests for MQTT bridge
  - Deployment with Dapr sidecar, MQTT env vars, lightweight resources (64Mi/128Mi)
  - ClusterIP service (port 80 → 3000)
  - Added to base kustomization.yaml
  - Audit confirmed all 10 existing agents have correct dapr.io/app-id, port mapping, and image patterns

### Added - Context Window Management
- **@mesh-six/core@0.3.0**: Context builder and reflect-before-reset utilities
  - `buildAgentContext()` assembles bounded context per agent LLM call (system prompt + task payload + scoped Mem0 memories)
  - Token budget enforcement with configurable `maxMemoryTokens` (default: 1500), drops lowest-relevance memories when over budget
  - `transitionClose()` runs structured reflection at state boundaries via Vercel AI SDK `generateText` + `Output.object()`
  - `REFLECTION_PROMPT` constant for guided reflection (outcome, pattern, guidance, reusable)
  - Memory scoping: `task` (same task), `agent` (same agent type), `project` (all agents on project), `global` (cross-pollination)
  - `resolveMemoryUserId()` maps scopes to Mem0 userId strings
  - Added `ai` v6 as dependency for structured output generation

### Added - Claude MQTT Bridge for Real-time Progress Monitoring
- **@mesh-six/claude-mqtt-bridge@0.1.0**: Bun script for Claude Code hooks → MQTT
  - Receives Claude hook events via stdin (JSON)
  - Enriches with git branch, worktree path, model, job_id
  - Publishes to MQTT topics: `claude/progress/{session_id}/{event_type}`
  - Supports all major hook events: SessionStart, PreToolUse, PostToolUse, SubagentStart/Stop, SessionEnd
  - Graceful fallback to file logging if MQTT unavailable
  - Fast startup for use as hook command (~0.34 MB bundle)
- **docs/CLAUDE_PROGRESS_UI.md**: Comprehensive guide for building progress UIs
  - MQTT topic structure and event schemas
  - React + Zustand example implementation
  - CLI monitoring script
  - Integration with mesh-six Project Manager
- **.claude/settings.local.json**: Hook configuration for mesh-six project
  - All relevant hooks configured to call MQTT bridge
  - Async mode for non-blocking progress reporting

### Added - Milestone 4: Project Manager Enhancements

#### Database
- **migrations/002_repo_registry.sql**: Repository registry table for tracking service repos
  - Tracks service_name, platform (github/gitea), repo_url, default_branch
  - CI/CD configuration: cicd_type, trigger_method, board_id
  - JSONB metadata for custom settings
  - Indexes for platform, trigger_method, board_id queries

#### MQTT Integration
- **@mesh-six/project-manager@0.2.0**: Real-time progress monitoring via MQTT
  - Subscribe to Claude Code pod progress events (`agent/code/job/#`)
  - Event schema: `{ jobId, status, details, timestamp }`
  - Auto-matches progress to tracked projects via metadata.jobId
  - Adds GitHub comments on job completion/failure
  - Configurable via `MQTT_URL` and `MQTT_ENABLED` env vars
  - Graceful connection handling (continues if MQTT unavailable)

#### QA Gate Enhancement
- **@mesh-six/project-manager**: Playwright test result parsing
  - New `parsePlaywrightResults()` function for JSON reporter output
  - Auto-rejects QA gate if tests fail with specific failure details
  - `extractTestFailures()` extracts suite/spec/error info
  - Auto-creates bug issues on GitHub/Gitea with test failure details
  - Labels: `bug`, `test-failure`, `mesh-six`, `automated`

#### VALIDATE Gate Enhancement
- **@mesh-six/project-manager**: Endpoint smoke testing
  - New `runSmokeTests()` function with 5-second timeout per endpoint
  - Default tests: `/healthz`, `/readyz`
  - Custom endpoints via `context.endpoints`
  - Auto-rejects if critical health endpoints fail
  - `formatSmokeTestReport()` generates markdown report
  - Includes response times and failure details

### Changed - Dapr Workflow Migration
- **@mesh-six/project-manager@0.2.0**: Migrated to Dapr Workflow for durable state management
  - State machine now uses Dapr Workflow for persistence across pod restarts
  - Projects survive failures with automatic state recovery
  - Event-driven state transitions via external signals (`advance` event)
  - Workflow activities wrap existing business logic (createProject, evaluateGate, transitionState, etc.)
  - Backwards compatible: legacy in-memory map still maintained
  - New API responses include workflow instance ID and runtime status
  - Review gates (plan/qa/deployment) integrated into workflow
  - New file: `apps/project-manager/src/workflow.ts`
  - Complete documentation in `WORKFLOW_MIGRATION.md`

### Added - Deployer Agents
- **@mesh-six/argocd-deployer@0.1.0**: GitOps deployment agent via ArgoCD
  - Capabilities: `deploy-service` (0.9), `rollback-service` (0.9), `sync-gitops` (1.0)
  - ArgoCD API integration for application lifecycle management
  - Tools: get_status, sync, create_application, rollback, list_applications, delete_application
  - Deployment planning with LLM-powered risk assessment
  - Memory integration for deployment history
  - Health check against ArgoCD server connectivity
- **@mesh-six/kubectl-deployer@0.1.0**: Direct Kubernetes deployment & debugging agent
  - Capabilities: `deploy-service` (0.7), `rollback-service` (0.7), `debug-pods` (1.0), `inspect-cluster` (0.9)
  - Direct kubectl execution for emergency deployments and debugging
  - Tools: get_pods, get_deployments, describe, logs, events, apply, delete, rollout operations, scale, restart
  - LLM-powered debug analysis with structured findings
  - RBAC ServiceAccount with cluster-wide access for k8s operations
  - Memory integration for debugging patterns
- Kubernetes manifests for both deployer agents with Dapr sidecar annotations

### Added - Specialist Coding & QA Agents
- **@mesh-six/qa-tester@0.1.0**: QA & Test Automation agent
  - Capabilities: `test-planning`, `test-generation`, `test-analysis`, `qa-review`
  - Framework expertise: Playwright, Cypress, Vitest, Jest, Puppeteer
  - Structured output: TestPlan, TestCode, TestAnalysis schemas
  - Tools: analyze_test_output, search_test_patterns, get_framework_docs
  - Page Object Model patterns, fixtures, accessibility testing
- **@mesh-six/api-coder@0.1.0**: Backend API development agent
  - Capabilities: `api-design`, `backend-coding`, `code-review`, `bug-fix`
  - Languages: TypeScript (Bun/Node.js) and Go
  - Frameworks: Hono, Express, Fastify (TS); Gin, Fiber, Echo (Go)
  - Structured output: APIDesign, CodeGeneration, CodeReview schemas
  - Tools: search_patterns, analyze_openapi, get_framework_template
- **@mesh-six/ui-agent@0.1.0**: Frontend UI development agent
  - Capabilities: `ui-design`, `component-generation`, `screen-generation`, `ui-review`
  - Platforms: React (Next.js, Tailwind) and React Native (Expo, NativeWind)
  - Atomic design patterns, accessibility-first approach
  - Structured output: UIDesign, ComponentCode, UIReview schemas
  - Tools: search_patterns, get_component_template, analyze_accessibility
- Kubernetes manifests for all three agents

### Added - Milestone 3 & 4: Specialist Agents + Project Manager
- **@mesh-six/architect-agent@0.1.0**: Architectural consultation agent
  - Capabilities: `tech-consultation`, `architecture-review`
  - Structured output schema for recommendations (tech stack, deployment strategy, considerations)
  - Tools for querying cluster state, service health, past decisions, resource usage
  - Memory integration for storing and retrieving past architectural decisions
  - Service invocation endpoint (`/consult`) for synchronous consultation
  - Pub/sub task handling for async dispatch
  - System prompt encoding Jay's homelab knowledge and preferences
- **@mesh-six/researcher-agent@0.1.0**: Multi-provider research agent
  - Capabilities: `deep-research`, `market-analysis`, `technical-research`
  - Multi-provider LLM support: Claude (Anthropic), Gemini (Google), Ollama (local)
  - Auto provider selection based on task complexity
  - Research depth options: quick, standard, comprehensive
  - Tools: web search, documentation search, repository analysis, past research lookup
  - Structured output schema for research results with key findings, recommendations, sources
  - Memory integration for storing research findings
- **@mesh-six/project-manager@0.1.0**: Project lifecycle management agent
  - Capabilities: `project-management`, `task-orchestration`
  - State machine: CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED
  - GitHub integration via @octokit/rest (issue creation, comments, updates)
  - Gitea integration via REST API
  - Agent-to-agent consultation: invokes Architect and Researcher agents
  - LLM-powered review gates at state transitions
  - Memory integration for project history
  - Project CRUD endpoints and state advancement API
- Kubernetes manifests for all new agents

## [0.2.0] - 2026-02-11 (8327110)

### Added - Milestone 2: Memory Layer
- **@mesh-six/core@0.2.0**: Added `AgentMemory` class for persistent memory using mem0ai
  - pgvector for vector storage
  - Ollama integration for embeddings (mxbai-embed) and LLM (phi4-mini)
  - Methods: `store()`, `search()`, `getAll()`, `delete()`, `deleteAll()`, `history()`
  - Factory function `createAgentMemoryFromEnv()` for easy initialization
- **@mesh-six/simple-agent@0.2.0**: Memory integration
  - Searches memories before LLM calls
  - Injects relevant context into system prompt
  - Stores conversations after completion
  - `MEMORY_ENABLED` env var to toggle (default: true)

### Changed
- pgvector 0.7.0 already enabled on PostgreSQL HA cluster

## [0.1.0] - 2026-02-11 (8327110)

### Added - Milestone 1: Hello Agent
- **@mesh-six/core@0.1.0**: Shared library
  - Type definitions (AgentCapability, AgentRegistration, TaskRequest, TaskResult, AgentScoreCard)
  - `AgentRegistry` class for agent discovery via Dapr state store (Redis)
  - `AgentScorer` class for weighted routing with historical performance
- **@mesh-six/orchestrator@0.1.0**: Task routing service
  - HTTP API for task submission (`POST /tasks`)
  - Agent discovery and scoring
  - Pub/sub dispatch via Dapr/RabbitMQ
  - Retry logic with re-scoring (up to 3 attempts)
  - Timeout handling
- **@mesh-six/simple-agent@0.1.0**: General-purpose LLM agent
  - Self-registration with registry
  - Heartbeat every 30s
  - LLM integration via Vercel AI SDK → LiteLLM
  - Pub/sub task handling
  - Graceful shutdown
- **Infrastructure**
  - Dapr components for Redis state store and RabbitMQ pub/sub
  - Kubernetes manifests with Dapr annotations
  - Kustomize overlays for dev/prod
  - Dockerfile for all agents
  - Migration system (`bun run db:migrate`)
  - `agent_task_history` table for scoring

### Database
- Added `_migrations` table for tracking applied migrations
- Added `agent_task_history` table for agent performance scoring

[Unreleased]: https://github.com/jaybrto/mesh-six/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jaybrto/mesh-six/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jaybrto/mesh-six/releases/tag/v0.1.0
