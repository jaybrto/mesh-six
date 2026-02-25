# PM Enhancements Design

Three internal improvements to the Project Manager agent: retry budget persistence, parallel workflow support, and autonomous blocked-question resolution.

## 1. Retry Budget

### Problem

Retry counters (`MAX_PLAN_CYCLES = 3`, `MAX_QA_CYCLES = 3`) are hardcoded constants in `workflow.ts`. They reset if the PM pod restarts mid-workflow, and can't be configured per-issue.

### Solution

Persist retry state in `pm_workflow_instances` and read it from the DB at each phase boundary.

**Migration** (`migrations/008_pm_retry_budget.sql`):

```sql
ALTER TABLE pm_workflow_instances
  ADD COLUMN plan_cycles_used   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN qa_cycles_used     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_budget       INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN failure_history    JSONB NOT NULL DEFAULT '[]';
```

**Workflow changes** (`apps/project-manager/src/workflow.ts`):

- Remove `MAX_PLAN_CYCLES` and `MAX_QA_CYCLES` constants
- Add `loadRetryBudgetActivity` — queries `pm_workflow_instances` for current counts and budget
- Add `incrementRetryCycleActivity` — increments the relevant counter, appends failure reason to `failure_history`
- Loop conditions change from `while planCycles < 3` to `while planCyclesUsed < retryBudget`

**Server changes** (`apps/project-manager/src/index.ts`):

- Wire new activities to DB query implementations
- Accept optional `retry_budget` in workflow start input (defaults to 3)

### Files Modified

| File | Change |
|------|--------|
| `migrations/008_pm_retry_budget.sql` | New migration |
| `apps/project-manager/src/workflow.ts` | Replace hardcoded constants with DB-backed budget |
| `apps/project-manager/src/index.ts` | Wire new activities, accept budget in workflow input |

---

## 2. Parallel Workflows

### Problem

The PM uses an in-memory `projectWorkflowMap` (Map) as the primary lookup for workflow instances. This is single-process only, loses state on restart, and doesn't support multiple PM replicas. Additionally, `GitHubProjectClient` has no rate limiting, so concurrent workflows could exhaust the GitHub API quota.

### Solution

Remove in-memory Map, use DB as sole source of truth, add token bucket rate limiting to the GitHub client.

**Remove in-memory state** (`apps/project-manager/src/index.ts`):

- Delete `projectWorkflowMap` and `projects` Maps
- Replace all `.get()` / `.set()` calls with `lookupByIssue()` (already exists, lines 127-138)
- Add `lookupByWorkflowId()` helper for reverse lookups
- No startup state rebuild needed

**Rate limiter** (`packages/core/src/github.ts`):

Token bucket added to `GitHubProjectClient`:

- `maxTokens: 50` (burst)
- `refillRate: 80/min` (~4800/hr, under GitHub's 5000/hr)
- Each API method calls `await waitForToken()` before making requests
- Internal to client, no changes to callers

**Polling jitter** (`apps/project-manager/src/workflow.ts`):

- Add 0-5 second random jitter to the 15-second poll interval in `pollGithubForCompletion()`
- Prevents synchronized polling waves from concurrent workflows

### Concurrency Model

- Target: 3-5 concurrent workflows
- Dapr Workflow natively supports concurrent instances
- `UNIQUE(issue_number, repo_owner, repo_name)` prevents duplicate workflows
- Default Postgres pool (10 connections) sufficient for this level

### Files Modified

| File | Change |
|------|--------|
| `packages/core/src/github.ts` | Add token bucket rate limiter |
| `apps/project-manager/src/index.ts` | Remove in-memory Maps, use DB lookups |
| `apps/project-manager/src/workflow.ts` | Add jitter to poll intervals |

---

## 3. PM Autonomy (Blocked Question Resolution)

### Problem

When a card moves to Blocked, the PM immediately sends an ntfy notification and waits. It doesn't attempt to answer the question using its available agents (architect, researcher), even when the question is answerable.

### Solution

Add an `attemptAutoResolveActivity` that tries to answer blocked questions via a two-agent cascade before escalating to the human.

**New activity: `attemptAutoResolveActivity`**

Input:
```typescript
{
  issueNumber: number,
  repoOwner: string,
  repoName: string,
  workflowPhase: string  // PLANNING, IMPLEMENTATION, QA
}
```

Logic:
1. Fetch latest issue comments, extract the blocked question via LLM
2. Classify question type:
   - `architectural` — architect first
   - `technical-research` — researcher first
   - `credential-access` — skip agents, escalate immediately
   - `ambiguous` — try both
3. Call first agent via existing Dapr service invocation (`consultArchitect()` / `requestResearch()`)
4. LLM evaluates response confidence
5. If not confident, call second agent with question + first agent's partial answer
6. LLM evaluates combined response

Output:
```typescript
{
  resolved: boolean,
  answer?: string,      // if resolved
  bestGuess?: string,   // if not resolved but agents provided something
  question: string,     // the extracted question
  agentsConsulted: string[]
}
```

**Workflow integration:**

Current blocked flow:
```
blocked detected -> notifyBlockedActivity -> wait for card-unblocked
```

New blocked flow:
```
blocked detected
  -> attemptAutoResolveActivity
  -> if resolved:
      -> addCommentActivity (post answer to issue)
      -> wait for GWA to unblock (30s timeout)
      -> if still blocked: notifyBlockedActivity + wait
  -> if not resolved:
      -> notifyBlockedActivity (include best-guess in notification body)
      -> wait for card-unblocked event
```

**Ntfy notification format (when escalating):**
```
Issue #42 (owner/repo) is BLOCKED:
Question: "Where should the auth middleware be placed?"
PM best guess (architect+researcher): "Based on the existing patterns..."
```

**New helpers** (`apps/project-manager/src/index.ts`):

- `extractBlockedQuestion(comments)` — LLM extracts the blocked question from recent comments
- `evaluateAgentResponse(question, response)` — LLM confidence check returning `{ confident: boolean, answer: string }`

### Files Modified

| File | Change |
|------|--------|
| `apps/project-manager/src/workflow.ts` | Add `attemptAutoResolveActivity`, modify blocked handling in all phases |
| `apps/project-manager/src/index.ts` | Wire activity, add helper functions |

---

## Cross-Cutting Concerns

**Observability:** All new LLM calls use `tracedChatCompletion` / `tracedGenerateText` and `EventLog.emit()` with trace_id for end-to-end tracing.

**Testing:** Each new activity gets unit tests with mocked GitHub API, mocked Dapr invocations, and mocked LLM responses.

**Version bumps:** `@mesh-six/core` and `@mesh-six/project-manager` patch versions bumped.

## File Change Summary

| File | Enhancement |
|------|------------|
| `migrations/008_pm_retry_budget.sql` | Retry budget (new) |
| `packages/core/src/github.ts` | Parallel workflows (rate limiter) |
| `apps/project-manager/src/workflow.ts` | All three |
| `apps/project-manager/src/index.ts` | All three |

## Acceptance Criteria

- [ ] Retry budget survives PM pod restart (DB-persisted, not in-memory)
- [ ] Retry budget configurable per-issue via workflow start input
- [ ] Failure history JSONB tracks each retry's failure reason
- [ ] In-memory Maps removed from PM server
- [ ] All workflow instance lookups go through PostgreSQL
- [ ] GitHub API calls rate-limited via token bucket (max ~4800/hr)
- [ ] Poll intervals include 0-5s random jitter
- [ ] 3 concurrent workflows can run without rate limit errors
- [ ] PM attempts auto-resolve before ntfy notification on blocked questions
- [ ] Architect consulted first for architectural questions, researcher for technical
- [ ] Second agent consulted if first agent's response is low-confidence
- [ ] Credential/access questions skip agent cascade, escalate immediately
- [ ] Ntfy notification includes PM's best-guess when escalating
- [ ] All new LLM calls use tracedChatCompletion with trace_id
- [ ] Unit tests for new activities with mocked dependencies
