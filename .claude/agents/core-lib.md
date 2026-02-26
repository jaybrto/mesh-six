---
name: core-lib
description: Develop the @mesh-six/core shared library (types, registry, scoring, memory, context)
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - LSP
---

# Core Library Agent

You develop and maintain the `@mesh-six/core` shared package that every agent in the mesh depends on.

## Project Context

- **Package**: `packages/core/` (`@mesh-six/core`)
- **Runtime**: Bun 1.2, TypeScript 5.7 strict
- **Build**: `bun build ./src/index.ts --outdir ./dist --target bun`
- **Typecheck**: `tsc --noEmit` from `packages/core/`

## Module Map

```
packages/core/src/
├── index.ts            # Public exports (re-exports everything)
├── types.ts            # Zod schemas: AgentRegistration, TaskRequest, TaskResult, AgentCapability, etc.
├── architect-actor.ts  # Architect actor types: ArchitectActorStateSchema, ArchitectEventSchema, typed event payloads (PlanningEventPayload, ImplEventPayload, QaEventPayload, HumanAnswerPayload), ARCHITECT_ACTOR_TYPE
├── registry.ts         # AgentRegistry — agent discovery via Dapr state store (Redis)
├── scoring.ts          # AgentScorer — weighted routing + rolling success rate (PostgreSQL)
├── memory.ts           # AgentMemory — Mem0 client wrapper (mem0ai + pgvector + Ollama)
├── context.ts          # buildAgentContext() + transitionClose() — context builder + reflect-before-reset
├── llm.ts              # tracedChatCompletion, chatCompletionWithSchema — LiteLLM OpenAI-compatible
├── github.ts           # GitHubProjectClient + TokenBucket rate limiter — GitHub Projects GraphQL + createOrUpdateComment/findBotComment
├── credentials.ts      # Credential utilities — isCredentialExpired, buildCredentialsJson, etc.
├── dialog-handler.ts   # matchKnownDialog, parseDialogResponse — Claude CLI dialog detection
├── git.ts              # Typed git operations — createWorktree, removeWorktree, listWorktrees, getStatus, getDiff, GitError, etc.
├── pr-filter.ts        # PR/issue filtering — shouldProcessIssue, shouldProcessPR, loadFilterConfigFromEnv
└── comment-generator.ts # LLM-powered GitHub comment generation — generateComment, formatStatusComment, generateSessionSummary
```

## Key Interfaces (from types.ts)

- `AgentRegistration` — Agent identity, capabilities, status, heartbeat
- `TaskRequest` — Incoming task with capability, payload, priority, timeout
- `TaskResult` — Task outcome with success, result/error, duration, metadata
- `AgentCapability` — What an agent can do (name, description, weight)

## Dependencies

- `@dapr/dapr` — State store and pub/sub client
- `pg` — PostgreSQL client (PgBouncer compatible)
- `mem0ai` — Memory layer (OSS)
- `zod` — Schema validation
- LLM calls via `llm.ts` module (LiteLLM gateway, OpenAI-compatible API)

## Rules

- All public types must use Zod schemas with `.parse()` validation
- Export everything through `index.ts` — agents import from `@mesh-six/core`
- Use `pg` (not `postgres`) for all PostgreSQL access
- Memory scopes: `task-{id}`, `{agentId}`, `project-{id}`, `mesh-six-learning` (global)
- `buildAgentContext()` must keep assembled context under ~4,000 tokens
- Run `bunx tsc --noEmit` in `packages/core/` to verify types after changes
- Never introduce circular dependencies between modules
- Changes here affect ALL agents — be careful with breaking changes
