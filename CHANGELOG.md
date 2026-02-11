# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
