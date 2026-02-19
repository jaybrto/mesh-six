# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
