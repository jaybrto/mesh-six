# Event Log Module + Full Deploy — Design Document

**Date**: 2026-02-17
**Status**: Approved
**Scope**: Part 1 (Event Log build) + Part 2 (k8s deploy + verify)

## Decisions

### EventLog Class: pg Adaptation
The PLAN.md samples use `postgres` (porsager) tagged templates. Adapting to `pg.Pool` with `pool.query(sql, params)` and `$1, $2` parameterized queries to match the existing `AgentScorer` pattern in `scoring.ts`. `emitBatch` uses multi-row INSERT with dynamically generated VALUES.

### Agent Database Dependency
Each agent gets a lazy singleton `pg.Pool` initialized on startup for `EventLog`. Uses `DATABASE_URL`/`PG_PRIMARY_URL` env vars. Graceful degradation: if no database URL configured, skip event logging (mirrors the existing memory pattern).

### generateObject Handling
Only `generateText` calls are traced via `tracedGenerateText`. `generateObject` tracing deferred to a follow-up. `transitionClose` in `context.ts` also gets traced since it calls `generateText` internally.

## Architecture

```
                     Dapr pub/sub
Orchestrator ──────────────────────→ event-logger (subscriber)
                tasks.*, results         │
                                         │ pg.Pool
                                         ▼
                    ┌──────────────────────────────────┐
                    │  mesh_six_events (partitioned)    │
                    └──────────────────────────────────┘
                         ▲              ▲
                    pg.Pool          pg.Pool
                    Agent A          Agent B
                  tracedGen()      tracedGen()
```

Two ingestion paths:
1. **Passive**: event-logger subscribes to pub/sub (task lifecycle)
2. **Active**: agents emit `llm.call`/`llm.response` via `tracedGenerateText`

## Implementation Scope

### Part 1: Event Log Module
- 1A: Migration `003_mesh_six_events.sql` (partitioned table, indexes)
- 1B: `packages/core/src/events.ts` — EventLog class (pg adaptation)
- 1C: `packages/core/src/ai.ts` — tracedGenerateText wrapper
- 1D: Export from `packages/core/src/index.ts`
- 1E: Tests (`events.test.ts`, `ai.test.ts`)
- 1F: `apps/event-logger/` service (Bun + Hono, Dapr subscriber)
- 1G: K8s manifests for event-logger
- 1H: Migrate all 11 agents to `tracedGenerateText`

### Part 2: k8s Deploy + Verify
- 2A: Build/push all 16 Docker images
- 2B: Deploy Dapr components
- 2C: K8s secrets
- 2D: ArgoCD Application
- 2E: Deploy and verify acceptance criteria (M1-M5 + Event Log)

## Key Patterns to Follow
- `pg.Pool` injection (see `scoring.ts`)
- Agent template (see `simple-agent/src/index.ts`)
- `bun:test` for tests (see `scoring.test.ts`)
- K8s manifests (see `k8s/base/simple-agent/`)
- Docker build with `AGENT_APP` arg
