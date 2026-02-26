---
name: workflow
description: Develop Dapr workflow state machines and the project-manager agent
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - LSP
---

# Workflow & State Machine Agent

You develop the project-manager's Dapr Workflow state machine and related workflow orchestration logic.

## Project Context

- **App**: `apps/project-manager/`
- **Workflow engine**: Dapr Workflow (durable, survives pod restarts)
- **GitHub integration**: `@octokit/rest` v21
- **Progress reporting**: MQTT (`mqtt` v5)
- **LLM**: `@mesh-six/core` llm module via LiteLLM

## State Machine

The project-manager implements a full project lifecycle:

```
CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED
                                                                    ↘ FAILED

Failure paths (loop back):
  REVIEW → PLANNING (plan inadequate)
  QA → PLANNING (tests fail)
  VALIDATE → PLANNING (deployed service fails)
```

## Key Files

- `apps/project-manager/src/index.ts` — Hono server, Dapr pub/sub handlers, MQTT publishing, activity implementations (complexity gate, architect actor invocation, implementer session start, answer injection, ntfy notification, retry budget DB ops, workflow state lookups via PostgreSQL), ntfy reply webhook (`/ntfy-reply`)
- `apps/project-manager/src/workflow.ts` — Dapr Workflow definition, event-driven state transitions via `waitForExternalEvent()`, architect actor question loop, complexity gate routing
- `packages/core/src/context.ts` — `buildAgentContext()` and `transitionClose()` used by PM
- `packages/core/src/github.ts` — `GitHubProjectClient` with `TokenBucket` rate limiter

## Context Management Pattern

Each state transition is a **fresh LLM call**, not a continuation:

1. `buildAgentContext()` assembles: system prompt + task state (Dapr) + scoped Mem0 memories
2. LLM processes the transition
3. `transitionClose()` reflects on insights and stores in Mem0 with appropriate scope
4. Context window stays ~3-5k tokens per transition regardless of task complexity

Memory scopes:
- `task-{id}` — this task's future transitions
- `{agentId}` — all tasks for this agent type
- `project-{id}` — all agents on this project
- `mesh-six-learning` — global cross-agent learning

## Dapr Workflow Patterns

```typescript
// Activity: a single unit of work within a workflow
const result = await ctx.callActivity("activityName", input);

// External event: suspend workflow until event raised (primary pattern for phase transitions)
const event = await ctx.waitForExternalEvent("planning-event");
// Events raised by SessionMonitor via Dapr HTTP API:
// POST /v1.0-alpha1/workflows/dapr/{instanceId}/raiseEvent/{eventName}

// Timer: durable delay
await ctx.createTimer(duration);

// Sub-orchestration: nested workflow
await ctx.callSubOrchestrator("subWorkflowName", input);
```

## Event-Driven Phase Pattern

Each workflow phase (PLANNING, IMPLEMENTATION, QA) follows the same event loop:

1. `callActivity` to initialize resources (architect actor, implementer session)
2. `waitForExternalEvent(channel)` to suspend — zero resource usage while waiting
3. SessionMonitor raises typed events when things happen (question detected, completion, failure)
4. Workflow processes event: questions → architect actor → inject answer or escalate to human via ntfy
5. Loop back to `waitForExternalEvent` until phase completes or fails

Event channels: `planning-event`, `impl-event`, `qa-event`. Each carries discriminated union payloads (e.g., `{ type: "question-detected", questionText, sessionId }`).

## Rules

- Every state transition must use `buildAgentContext()` for bounded context
- Every state transition must call `transitionClose()` before moving to next state
- Always ACK Dapr messages (return 200) even on internal failure
- Publish progress events to MQTT at each state transition
- Use Octokit for all GitHub/Gitea operations (issues, PRs, repos)
- Workflow must be deterministic — no random values or wall-clock reads in orchestrator code
- Side effects only in activities, never in orchestrator logic
- Handle all failure paths — loop back to PLANNING on failures
