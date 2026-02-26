# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun install                                      # Install all workspace dependencies
bun run build                                    # Build all packages and apps
bun run typecheck                                # Type check all packages
bun run test                                     # Run all tests
bun run dev                                      # Dev mode (all packages, watch)

# Single app
bun run --filter @mesh-six/orchestrator dev      # Dev mode with watch for one app
bun run --filter @mesh-six/core test             # Test only core library
bun run --filter @mesh-six/core typecheck        # Type check only core

# Single test file
bun test packages/core/src/scoring.test.ts       # Run one test file

# Database
bun run db:migrate                               # Apply pending SQL migrations (needs DATABASE_URL or PG_PRIMARY_URL)

# Container builds (Kaniko in k3s — no local Docker)
# CI triggers builds automatically. Manual build via Kaniko pod:
# See .github/workflows/build-deploy.yaml for the Kaniko pod template

# K8s
kubectl apply -k k8s/overlays/prod               # Deploy all services
kubectl apply -k k8s/overlays/dev                 # Deploy dev overlay
```

## Architecture

Mesh Six is a multi-agent orchestration system deployed to a k3s cluster. Agents are Bun+Hono HTTP microservices with Dapr sidecars for communication. They never talk directly to each other — all inter-agent communication goes through Dapr (RabbitMQ pub/sub for async tasks, service invocation for sync consultations).

### Core Flow

1. **Orchestrator** receives task via `POST /tasks` with a `capability` name
2. **AgentRegistry** (Dapr/Redis state store) discovers agents matching the capability
3. **AgentScorer** (PostgreSQL `agent_task_history`) ranks agents by weighted score (base weight × dependency health × rolling success rate × recency boost)
4. Orchestrator dispatches to highest-scoring agent via Dapr pub/sub topic `tasks.{agentId}`
5. Agent processes task, publishes `TaskResult` to `task-results` topic
6. Orchestrator records result in history; on failure, retries with re-scoring (up to 3 attempts)

### Agent Pattern

Every agent follows the same template (`apps/simple-agent/src/index.ts` is the reference):

- **Hono HTTP server** on port 3000 with `/healthz`, `/readyz`, `/dapr/subscribe`, `/tasks`, `/invoke` endpoints
- **Self-registration** with `AgentRegistry` on startup, 30s heartbeat, mark offline on SIGTERM
- **Pub/sub task handling**: `GET /dapr/subscribe` returns topic subscriptions, `POST /tasks` processes dispatched work
- **Direct invocation**: `POST /invoke` for synchronous agent-to-agent calls (used by PM → Architect/Researcher)
- **Always ACK to Dapr** (return 200/SUCCESS) even on internal failure; report failures via task result messages
- **Memory integration**: optional via `AgentMemory` from `@mesh-six/core` (Mem0 + pgvector + Ollama)

### Key Packages

- **`@mesh-six/core`** (`packages/core/`): Shared library — types (Zod schemas), `AgentRegistry`, `AgentScorer`, `AgentMemory`, `buildAgentContext()`, `transitionClose()`, credential utilities (`isCredentialExpired`, `buildCredentialsJson`, etc.), dialog handler (`matchKnownDialog`, `parseDialogResponse`), `GitHubProjectClient` + `TokenBucket` rate limiter, `tracedChatCompletion`/`chatCompletionWithSchema` LLM module, architect actor types (`ArchitectActorStateSchema`, `ArchitectEventSchema`, typed event payloads), git utilities (`createWorktree`, `removeWorktree`, `getStatus`, `getDiff`, `GitError`, etc.), PR/issue filter (`shouldProcessIssue`, `shouldProcessPR`, `loadFilterConfigFromEnv`), comment generation (`generateComment`, `formatStatusComment`), terminal streaming types (`TerminalSnapshotSchema`, `RecordingMetadataSchema`, `TerminalStreamChunkSchema`, `TERMINAL_STREAM_TOPIC_PREFIX`, `TERMINAL_SNAPSHOT_TOPIC_PREFIX`), MinIO S3 client (`createMinioClient`, `uploadToMinio`, `downloadFromMinio`, `getMinioPresignedUrl`, `MinioConfig`). All agents depend on this.
- **`@mesh-six/orchestrator`** (`apps/orchestrator/`): Central task router. No LLM dependency.
- **`@mesh-six/project-manager`** (`apps/project-manager/`): Dapr Workflow state machine (INTAKE → PLANNING → IMPLEMENTATION → QA → REVIEW → ACCEPTED). Event-driven — each phase uses `waitForExternalEvent()` to suspend until SessionMonitor raises typed events (question-detected, plan-complete, pr-created, test-results, session-failed). Complexity gate skips Opus planning for issues labeled "simple". Questions routed through architect actor; confident answers auto-injected via implementer, low-confidence escalated to human via ntfy with reply webhook (`/ntfy-reply`). DB-backed retry budgets (configurable per-issue, failure history JSONB). No in-memory state — all workflow lookups via PostgreSQL (`lookupByIssue`, `lookupByWorkflowId`). Posts GitHub issue comments at each phase transition via `postStatusCommentActivity`. Syncs approved plan to issue via `syncPlanToIssueActivity`. Planning prompts built from `templates/plans/prompt.md`.
- **`@mesh-six/auth-service`** (`apps/auth-service/`): Credential lifecycle management. Hono+Dapr microservice backed by PostgreSQL. Manages project configs, credential push/refresh, bundle provisioning (tar.gz with Claude CLI config files), and OAuth token refresh timer. Publishes `credential-refreshed` and `config-updated` events via Dapr pub/sub. No LLM dependency.
- **`@mesh-six/implementer`** (`apps/implementer/`): Autonomous code implementation agent. StatefulSet with Dapr actor runtime — one actor per issue session. Provisions credentials from auth-service, clones repos into worktrees, runs Claude CLI in tmux sessions, monitors for auth failures/questions/completion. SessionMonitor raises typed events on the PM workflow via Dapr HTTP API (`raiseEvent`) instead of pub/sub. Actors track `workflowId` and support `injectAnswer` for auto-injecting answers via `tmux send-keys`. Session state tracked in PostgreSQL (implementation_sessions, session_questions, session_checkpoints, terminal_snapshots, terminal_recordings). Supports `claude --resume` via `claude_session_id` captured from CLI output by `SessionMonitor`. Pod startup recovery marks interrupted sessions and enables resume. Pre-action checkpoints capture git state + tmux output before commits/PRs. **Terminal streaming** via `terminal-relay.ts`: FIFO-based live output streaming published to MQTT `terminal/stream/{sessionId}`, asciicast v2 recordings uploaded to MinIO S3, ANSI snapshots captured at lifecycle events (session_start, session_blocked, answer_injected, session_completed, session_failed). REST endpoints: `/sessions` (list with filters), `/sessions/:id` (detail with questions + checkpoint), `/sessions/:id/answer` (inject answer via REST), `/sessions/:id/snapshots`, `/sessions/:id/recordings`, `/recordings/:id/url`. Custom Dockerfile (`docker/Dockerfile.implementer`) with tmux + git + Claude CLI.
- **`@mesh-six/architect-agent`** (`apps/architect-agent/`): Dapr Actor (`ArchitectActor`) with per-issue instances. Maintains append-only event log in PostgreSQL (`architect_events`). Methods: `initialize`, `consult`, `answerQuestion` (builds context from event history + Mem0, returns `{ confident, answer }` or `{ confident: false, bestGuess }`), `receiveHumanAnswer` (generalizes Q&A via LLM, stores to Mem0), `getHistory`. Actor runtime with `/dapr/config` endpoint.
- **`@mesh-six/llm-service`** (`apps/llm-service/`): Claude CLI gateway with Dapr actor concurrency control. Provisions credentials from auth-service via Dapr service invocation (replaced GWA dependency). Subscribes to `credential-refreshed` events for proactive credential sync.
- **`@mesh-six/dashboard`** (`apps/dashboard/`): React 19 + Vite + Tailwind 4 SPA with MQTT WebSocket for real-time monitoring. Subscribes to `terminal/stream/#` and `terminal/snapshot/#` for live terminal viewing via xterm.js (`TerminalViewer`), asciicast recording playback (`RecordingPlayer`), and snapshot timeline browsing (`SnapshotTimeline`). Session terminal view at `/sessions/:sessionId/terminal`. This is the only non-Hono app — uses nginx in k8s, no Dapr sidecar.

### Context Window Management

Agents keep LLM context small (~3-5k tokens) by design. `buildAgentContext()` assembles system prompt + task JSON + scoped Mem0 memories with a configurable token ceiling. Stateful agents (project-manager) use `transitionClose()` to reflect and store learnings before context resets at each state boundary.

Memory scopes: `task` (same task), `agent` (same agent type), `global` (cross-agent pollination via `mesh-six-learning` userId).

### Infrastructure Dependencies

All infrastructure is pre-existing in the k3s cluster:
- **PostgreSQL HA** (`pgsql.k3s.bto.bar:5432`, database `mesh_six`) — task history, repo registry, pgvector memories, auth credentials, implementation sessions, architect event log (`architect_events`), session checkpoints (`session_checkpoints`), terminal snapshots (`terminal_snapshots`), terminal recordings (`terminal_recordings`)
- **Redis Cluster** — Dapr state store for agent registry
- **RabbitMQ HA** — Dapr pub/sub backbone, MQTT plugin for real-time events
- **Ollama + LiteLLM** — LLM gateway (OpenAI-compatible API called directly via `@mesh-six/core` llm module)
- **MinIO S3** — object storage for terminal recordings (asciicast v2 `.cast` files), credential archives. Shared client via `@mesh-six/core` `minio.ts` module (`createMinioClient`, `uploadToMinio`, `getMinioPresignedUrl`). Implementer uploads to bucket `mesh-six-recordings`, key pattern `recordings/{sessionId}/{timestamp}.cast`
- **Dapr** — sidecar injected via k8s annotations (`dapr.io/enabled: "true"`, `dapr.io/app-id`, `dapr.io/app-port: "3000"`)

### Database

Uses `pg` package (not `postgres`/porsager) for PgBouncer compatibility with CloudNativePG. Migrations in `migrations/` directory, tracked in `_migrations` table, run via `scripts/migrate.ts`.

### Dapr Components

Defined in `k8s/base/dapr-components/` (authoritative, managed by ArgoCD).
Copies also exist in `dapr/components/` for local `dapr run` usage — keep in sync manually.
- `agent-statestore` (Redis) — agent registry state
- `agent-pubsub` (RabbitMQ) — task dispatch and results
- `agent-statestore-outbox` (PostgreSQL) — atomic state + publish via outbox pattern

### K8s Manifests

Kustomize-based in `k8s/base/` with overlays in `k8s/overlays/{dev,prod}`. Each agent has its own subdirectory with Deployment + Service (or StatefulSet for stateful agents like implementer). Shared Dockerfile at `docker/Dockerfile.agent` parameterized by `AGENT_APP` build arg; implementer uses custom `docker/Dockerfile.implementer` (tmux + git + Claude CLI). Container registry: `registry.bto.bar/jaybrto/mesh-six-{agent-name}` (Gitea via external Caddy proxy for pull; CI pushes to internal `gitea-http.gitea-system.svc.cluster.local:3000`). Vault + External Secrets Operator syncs secrets from `secret/data/mesh-six`.

## Conventions

- **Bun monorepo** with `workspaces: ["packages/*", "apps/*"]` — all deps shared at root
- **TypeScript strict mode**, ESNext target, bundler module resolution
- **Zod schemas** for all shared types in `@mesh-six/core` — use `Schema.parse()` at system boundaries
- **LiteLLM direct** — LLM calls via `@mesh-six/core` llm module (`tracedChatCompletion`, `chatCompletionWithSchema`) hitting LiteLLM's OpenAI-compatible API directly via fetch
- **`bun install --frozen-lockfile`** in CI/Docker; `bunfig.toml` enforces exact versions
- Core library exports from `packages/core/src/index.ts` — import as `@mesh-six/core`
- Agent registry uses an index key (`agent:_index`) since Redis via Dapr doesn't support prefix scans
- Constants `DAPR_PUBSUB_NAME`, `DAPR_STATE_STORE`, `TASK_RESULTS_TOPIC`, `AUTH_SERVICE_APP_ID`, `CREDENTIAL_REFRESHED_TOPIC`, `CONFIG_UPDATED_TOPIC`, `ARCHITECT_ACTOR_TYPE` exported from core
- Credential provisioning uses auth-service via Dapr service invocation (not direct HTTP) — `http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/auth-service/method/...`
- Push credentials to auth-service via `scripts/push-credentials.ts` (reads local `~/.claude/.credentials.json`)
- Git operations in `@mesh-six/core` `git.ts` replace inline `Bun.spawn` git calls — use `createWorktree`, `removeWorktree`, `getStatus`, `getDiff`, `GitError` from `@mesh-six/core`
- PR/issue filtering via `shouldProcessIssue`/`shouldProcessPR`/`loadFilterConfigFromEnv` from `@mesh-six/core` — webhook-receiver applies this before publishing board events
- GitHub issue comments use hidden HTML markers (`<!-- mesh-six-status -->`, `<!-- mesh-six-plan -->`, `<!-- mesh-six-progress -->`) for idempotent create-or-update via `GitHubProjectClient.findBotComment` + `createOrUpdateComment`
- Planning templates in `templates/plans/` (plan.md, prompt.md, checklist.md, decisions.md) — loaded by `plan-templates.ts` `buildTemplate()` at runtime; `{{VARIABLE}}` placeholders replaced via `instantiatePlan()`
- Session resume: `SessionMonitor` captures `claude_session_id` from CLI output and persists it; `ImplementerActor.startSession` passes `--resume <id>` if present on restart
- Operational scripts in `scripts/` for DB diagnostics, credential history, cleanup, backup, and repo onboarding — run with `bun run scripts/<name>.ts`
- CronJobs: `cleanup-cronjob` (daily 3am) and `credential-backup-cronjob` (every 6h) in `k8s/base/` — added to `kustomization.yaml`
- Terminal streaming publishes to MQTT topics `terminal/stream/{sessionId}` (live chunks) and `terminal/snapshot/{sessionId}` (lifecycle snapshots) via Dapr pubsub. Dashboard subscribes via `useMqtt.tsx` wildcard topics. Snapshot calls are fire-and-forget (`.catch(() => {})`) — never block state transitions.
- Dashboard imports from `@mesh-six/core` must use `import type` only (not runtime values) to avoid pulling server-only deps (pg, mem0ai, ollama) into the browser bundle via Vite/Rollup

## Versioning & Changelog

- Bump `version` in the relevant `package.json` with each change (patch/minor/major per semver)
- Update `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format
- Include package name and version: `**@mesh-six/core@0.3.0**`
- Add commit hash AFTER final commit (don't amend — amending changes the hash)

## CI/CD

- `.github/workflows/build-deploy.yaml`: Matrix build via Kaniko on self-hosted runner, change detection (rebuilds only affected agents + all if core changes), pushes to internal Gitea registry (`gitea-http.gitea-system.svc.cluster.local:3000/jaybrto/mesh-six-{agent}`) with `:latest` and `:{sha}` tags
- `.github/workflows/test.yaml`: PR validation — core typecheck + tests, matrix typecheck for changed apps
- ArgoCD Application at `k8s/argocd-application.yaml` with automated sync, prune, selfHeal

## Plan Document

Full architecture, milestones, and acceptance criteria in `docs/PLAN.md`. Reference it when implementing new milestones or understanding design decisions.
