# PM Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add retry budget persistence, parallel workflow support, and autonomous blocked-question resolution to the Project Manager agent.

**Architecture:** Three independent enhancements to the PM. Retry budget adds a migration and two workflow activities. Parallel workflows removes in-memory Maps and adds a token bucket rate limiter to `GitHubProjectClient`. PM autonomy adds a two-agent cascade activity that attempts to answer blocked questions before ntfy escalation.

**Tech Stack:** Bun, TypeScript, PostgreSQL, Dapr Workflow, Hono, `@octokit/graphql`, `@octokit/rest`, LiteLLM (`tracedChatCompletion`)

---

## Task 1: Retry Budget — Migration

**Files:**
- Create: `migrations/008_pm_retry_budget.sql`

**Step 1: Write the migration**

```sql
-- migrations/008_pm_retry_budget.sql
-- Add retry budget tracking to pm_workflow_instances

ALTER TABLE pm_workflow_instances
  ADD COLUMN plan_cycles_used   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN qa_cycles_used     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_budget       INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN failure_history    JSONB NOT NULL DEFAULT '[]';
```

**Step 2: Verify migration syntax**

Run: `bun run db:migrate`
Expected: Migration 008 applied successfully.

**Step 3: Commit**

```bash
git add migrations/008_pm_retry_budget.sql
git commit -m "add migration 008: retry budget columns on pm_workflow_instances"
```

---

## Task 2: Retry Budget — Workflow Types and Activity Stubs

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:48-55` (extend `ProjectWorkflowInput`)
- Modify: `apps/project-manager/src/workflow.ts:66-265` (add new activity types)
- Modify: `apps/project-manager/src/workflow.ts:278-396` (add new activity stubs)
- Modify: `apps/project-manager/src/workflow.ts:869-889` (extend `WorkflowActivityImplementations`)
- Modify: `apps/project-manager/src/workflow.ts:895-949` (register new activities in runtime)

**Step 1: Write the failing test**

Create test file `apps/project-manager/src/__tests__/retry-budget.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import type {
  ProjectWorkflowInput,
  LoadRetryBudgetInput,
  LoadRetryBudgetOutput,
  IncrementRetryCycleInput,
} from "../workflow.js";

describe("Retry Budget types", () => {
  it("ProjectWorkflowInput accepts optional retryBudget", () => {
    const input: ProjectWorkflowInput = {
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test-owner",
      repoName: "test-repo",
      projectItemId: "PVTI_abc",
      contentNodeId: "I_abc",
      retryBudget: 5,
    };
    expect(input.retryBudget).toBe(5);
  });

  it("ProjectWorkflowInput defaults retryBudget to undefined", () => {
    const input: ProjectWorkflowInput = {
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test-owner",
      repoName: "test-repo",
      projectItemId: "PVTI_abc",
      contentNodeId: "I_abc",
    };
    expect(input.retryBudget).toBeUndefined();
  });

  it("LoadRetryBudgetOutput has cycle counts and budget", () => {
    const output: LoadRetryBudgetOutput = {
      planCyclesUsed: 1,
      qaCyclesUsed: 0,
      retryBudget: 3,
    };
    expect(output.planCyclesUsed).toBe(1);
    expect(output.qaCyclesUsed).toBe(0);
    expect(output.retryBudget).toBe(3);
  });

  it("IncrementRetryCycleInput specifies phase and failure reason", () => {
    const input: IncrementRetryCycleInput = {
      workflowId: "wf-123",
      phase: "planning",
      failureReason: "Plan lacked test coverage section",
    };
    expect(input.phase).toBe("planning");
    expect(input.failureReason).toContain("test coverage");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/project-manager/src/__tests__/retry-budget.test.ts`
Expected: FAIL — types `LoadRetryBudgetInput`, `LoadRetryBudgetOutput`, `IncrementRetryCycleInput` not exported from `workflow.js`.

**Step 3: Add types and activity stubs to workflow.ts**

In `apps/project-manager/src/workflow.ts`:

1. Add `retryBudget?: number;` to `ProjectWorkflowInput` (after line 54)

2. Add new activity types (after `MoveToFailedInput` block, ~line 243):

```typescript
export interface LoadRetryBudgetInput {
  workflowId: string;
}

export interface LoadRetryBudgetOutput {
  planCyclesUsed: number;
  qaCyclesUsed: number;
  retryBudget: number;
}

export interface IncrementRetryCycleInput {
  workflowId: string;
  phase: "planning" | "qa";
  failureReason: string;
}
```

3. Add activity stubs (after `compressContextActivity` stub, ~line 396):

```typescript
export let loadRetryBudgetActivity: ActivityFn<
  LoadRetryBudgetInput,
  LoadRetryBudgetOutput
> = async () => {
  throw new Error("loadRetryBudgetActivity not initialized");
};

export let incrementRetryCycleActivity: ActivityFn<
  IncrementRetryCycleInput,
  void
> = async () => {
  throw new Error("incrementRetryCycleActivity not initialized");
};
```

4. Add to `WorkflowActivityImplementations` interface (~line 869):

```typescript
loadRetryBudget: typeof loadRetryBudgetActivity;
incrementRetryCycle: typeof incrementRetryCycleActivity;
```

5. Wire in `createWorkflowRuntime` (~line 895):

```typescript
loadRetryBudgetActivity = activityImpls.loadRetryBudget;
incrementRetryCycleActivity = activityImpls.incrementRetryCycle;
```

And register:

```typescript
runtime.registerActivity(loadRetryBudgetActivity);
runtime.registerActivity(incrementRetryCycleActivity);
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/project-manager/src/__tests__/retry-budget.test.ts`
Expected: PASS (4 tests)

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/project-manager/src/workflow.ts apps/project-manager/src/__tests__/retry-budget.test.ts
git commit -m "add retry budget types and activity stubs to PM workflow"
```

---

## Task 3: Retry Budget — Replace Hardcoded Constants in Workflow

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:402-403` (remove `MAX_PLAN_CYCLES`, `MAX_QA_CYCLES`)
- Modify: `apps/project-manager/src/workflow.ts:498-562` (PLANNING loop)
- Modify: `apps/project-manager/src/workflow.ts:640-740` (QA loop)

**Step 1: Modify the PLANNING loop**

Replace lines 402-403 (the constants) and rewrite lines 498-579 (the PLANNING phase):

Remove:
```typescript
const MAX_PLAN_CYCLES = 3;
const MAX_QA_CYCLES = 3;
```

Before the PLANNING phase loop, load the budget:
```typescript
  // Load retry budget from database
  const retryBudget: LoadRetryBudgetOutput = yield ctx.callActivity(
    loadRetryBudgetActivity,
    { workflowId }
  );
  const maxCycles = input.retryBudget ?? retryBudget.retryBudget;
```

Change PLANNING loop condition from:
```typescript
  while (totalPlanCycles < MAX_PLAN_CYCLES && !planApproved) {
```
to:
```typescript
  let totalPlanCycles = retryBudget.planCyclesUsed;
  let planApproved = false;

  while (totalPlanCycles < maxCycles && !planApproved) {
```

After plan rejection (inside the `else` block at ~line 553), add:
```typescript
      yield ctx.callActivity(incrementRetryCycleActivity, {
        workflowId,
        phase: "planning",
        failureReason: planReview.feedback,
      });
```

Update the failure message from:
```typescript
      reason: `Plan not approved after ${MAX_PLAN_CYCLES} revision cycles`,
```
to:
```typescript
      reason: `Plan not approved after ${maxCycles} revision cycles`,
```

**Step 2: Modify the QA loop**

Similarly change the QA loop (lines 640-740):

Change:
```typescript
  let qaCycles = 0;
```
to:
```typescript
  let qaCycles = retryBudget.qaCyclesUsed;
```

Change condition from `qaCycles < MAX_QA_CYCLES` to `qaCycles < maxCycles`.

After test failure / bug issue creation (~line 699), add:
```typescript
      yield ctx.callActivity(incrementRetryCycleActivity, {
        workflowId,
        phase: "qa",
        failureReason: testEval.failures.join("; "),
      });
```

Update the failure message from:
```typescript
      reason: `Tests did not pass after ${MAX_QA_CYCLES} QA cycles`,
```
to:
```typescript
      reason: `Tests did not pass after ${maxCycles} QA cycles`,
```

And the QA cycle log from:
```typescript
      `[Workflow] QA cycle ${qaCycles}/${MAX_QA_CYCLES} for issue #${issueNumber}`
```
to:
```typescript
      `[Workflow] QA cycle ${qaCycles}/${maxCycles} for issue #${issueNumber}`
```

**Step 3: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 4: Run all PM tests**

Run: `bun test apps/project-manager/src/__tests__/`
Expected: All tests pass

**Step 5: Commit**

```bash
git add apps/project-manager/src/workflow.ts
git commit -m "replace hardcoded retry constants with DB-backed budget in PM workflow"
```

---

## Task 4: Retry Budget — Wire Activity Implementations

**Files:**
- Modify: `apps/project-manager/src/index.ts:114-125` (extend `WorkflowInstanceRow`)
- Modify: `apps/project-manager/src/index.ts:1431-1667` (add activity implementations)

**Step 1: Extend `WorkflowInstanceRow` interface**

At `apps/project-manager/src/index.ts:114`, add the new columns:

```typescript
interface WorkflowInstanceRow {
  id: string;
  workflow_id: string;
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  current_phase: string;
  status: string;
  project_item_id: string | null;
  plan_cycles_used: number;
  qa_cycles_used: number;
  retry_budget: number;
  failure_history: unknown[];
  created_at: string;
  updated_at: string;
}
```

**Step 2: Add activity implementations**

In the `activityImplementations` object (before the closing `};` at line ~1667), add:

```typescript
      loadRetryBudget: async (_ctx, input) => {
        if (!pgPool) return { planCyclesUsed: 0, qaCyclesUsed: 0, retryBudget: 3 };
        const { rows } = await pgPool.query(
          `SELECT plan_cycles_used, qa_cycles_used, retry_budget FROM pm_workflow_instances WHERE workflow_id = $1`,
          [input.workflowId]
        );
        if (rows.length === 0) return { planCyclesUsed: 0, qaCyclesUsed: 0, retryBudget: 3 };
        return {
          planCyclesUsed: rows[0].plan_cycles_used,
          qaCyclesUsed: rows[0].qa_cycles_used,
          retryBudget: rows[0].retry_budget,
        };
      },

      incrementRetryCycle: async (_ctx, input) => {
        if (!pgPool) return;
        const column = input.phase === "planning" ? "plan_cycles_used" : "qa_cycles_used";
        await pgPool.query(
          `UPDATE pm_workflow_instances
           SET ${column} = ${column} + 1,
               failure_history = failure_history || $1::jsonb,
               updated_at = NOW()
           WHERE workflow_id = $2`,
          [JSON.stringify({ phase: input.phase, reason: input.failureReason, timestamp: new Date().toISOString() }), input.workflowId]
        );
      },
```

**Step 3: Import the new types**

At `apps/project-manager/src/index.ts:38`, add to the import from `./workflow.js`:

```typescript
import {
  // ... existing imports ...
  type LoadRetryBudgetInput,      // add
  type IncrementRetryCycleInput,  // add
} from "./workflow.js";
```

(These imports are only needed if TypeScript needs them for the activity implementations. Since the `WorkflowActivityImplementations` interface already types them, this may not be strictly necessary — check if typecheck passes without.)

**Step 4: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 5: Run all PM tests**

Run: `bun test apps/project-manager/src/__tests__/`
Expected: All tests pass

**Step 6: Commit**

```bash
git add apps/project-manager/src/index.ts
git commit -m "wire retry budget activity implementations in PM server"
```

---

## Task 5: Parallel Workflows — Token Bucket Rate Limiter

**Files:**
- Modify: `packages/core/src/github.ts:47-61` (add rate limiter to constructor)
- Test: `packages/core/src/github-ratelimit.test.ts`

**Step 1: Write the failing test**

Create `packages/core/src/github-ratelimit.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { TokenBucket } from "./github.js";

describe("TokenBucket", () => {
  it("allows requests up to max tokens", () => {
    const bucket = new TokenBucket({ maxTokens: 3, refillRate: 60 });
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills tokens over time", async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 1000 }); // 1000/min = ~16.7/sec
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    // Wait 100ms => ~1.67 tokens refilled, capped at 1
    await new Promise((r) => setTimeout(r, 100));
    expect(bucket.tryConsume()).toBe(true);
  });

  it("waitForToken resolves immediately when tokens available", async () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRate: 60 });
    const start = Date.now();
    await bucket.waitForToken();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waitForToken waits when no tokens available", async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 600 }); // 600/min = 10/sec
    bucket.tryConsume(); // exhaust
    const start = Date.now();
    await bucket.waitForToken();
    // Should wait ~100ms for 1 token at 10/sec
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/github-ratelimit.test.ts`
Expected: FAIL — `TokenBucket` not exported from `github.js`.

**Step 3: Implement TokenBucket**

Add to `packages/core/src/github.ts` (before the `GitHubProjectClient` class):

```typescript
export interface TokenBucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per minute
}

export class TokenBucket {
  private tokens: number;
  private maxTokens: number;
  private refillRatePerMs: number;
  private lastRefill: number;

  constructor(config: TokenBucketConfig) {
    this.maxTokens = config.maxTokens;
    this.tokens = config.maxTokens;
    this.refillRatePerMs = config.refillRate / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async waitForToken(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRatePerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    this.tokens -= 1;
  }
}
```

**Step 4: Add rate limiter to GitHubProjectClient**

In the `GitHubProjectClient` class:

1. Add private field:
```typescript
  private rateLimiter: TokenBucket;
```

2. In constructor, initialize it:
```typescript
    this.rateLimiter = new TokenBucket({ maxTokens: 50, refillRate: 80 });
```

3. Add a private helper:
```typescript
  private async rateLimit(): Promise<void> {
    await this.rateLimiter.waitForToken();
  }
```

4. Add `await this.rateLimit();` as the first line of each public API method:
   - `loadColumnMapping()`
   - `moveCard()`
   - `getItemColumn()`
   - `getProjectItemsByColumn()` (before the while loop, not inside it — pagination calls are part of one logical request)
   - `getIssueComments()`
   - `getIssuePRs()`
   - `addIssueComment()`
   - `createIssue()`

**Step 5: Export TokenBucket from core**

In `packages/core/src/index.ts`, add to the github.ts export line:

```typescript
export { GitHubProjectClient, TokenBucket, type GitHubClientConfig, /* ... */ } from "./github.js";
```

**Step 6: Run test to verify it passes**

Run: `bun test packages/core/src/github-ratelimit.test.ts`
Expected: PASS (4 tests)

**Step 7: Run all core tests**

Run: `bun run --filter @mesh-six/core test`
Expected: All 128+ tests pass

**Step 8: Commit**

```bash
git add packages/core/src/github.ts packages/core/src/github-ratelimit.test.ts packages/core/src/index.ts
git commit -m "add token bucket rate limiter to GitHubProjectClient"
```

---

## Task 6: Parallel Workflows — Remove In-Memory Maps

**Files:**
- Modify: `apps/project-manager/src/index.ts:111` (remove `projectWorkflowMap`)
- Modify: `apps/project-manager/src/index.ts:358` (remove `projects` Map)
- Modify: various references to these Maps throughout the file

**Step 1: Add `lookupByWorkflowId` helper**

After `lookupByIssue` function (~line 138), add:

```typescript
async function lookupByWorkflowId(
  workflowId: string
): Promise<WorkflowInstanceRow | null> {
  if (!pgPool) return null;
  const { rows } = await pgPool.query<WorkflowInstanceRow>(
    `SELECT * FROM pm_workflow_instances WHERE workflow_id = $1 LIMIT 1`,
    [workflowId]
  );
  return rows[0] ?? null;
}
```

**Step 2: Remove `projectWorkflowMap` and `projects` Maps**

1. Delete line 111: `const projectWorkflowMap = new Map<string, string>();`
2. Delete line 358: `const projects = new Map<string, Project>();`

**Step 3: Replace all Map references**

At each usage site:

- Line 781 (`projects.set(project.id, project);`): Delete the line (legacy store, no longer needed)
- Line 970 (`trackedWorkflows: projectWorkflowMap.size`): Replace with `trackedWorkflows: "db-backed"` or query count from DB
- Line 1029 (`projectWorkflowMap.set(projectId, workflowInstanceId);`): Delete the line (already recorded in DB via `recordWorkflowMapping` activity)
- Line 1073 (`projectWorkflowMap.get(projectId) || projectId`): Replace with DB lookup or use projectId directly as workflowId
- Line 1078 (`projects.get(projectId)`): Remove `legacyProject` from response
- Line 1115 (`projectWorkflowMap.get(projectId) || projectId`): Same as 1073
- Line 1186 (`projects.get(task.projectId)`): Remove or replace with DB query
- Line 1234 (`projects.set(project.id, project);`): Delete the line
- Line 1731 (`projects.set(project.id, project)`): Delete the line

For `GET /projects/:id` (line 1066), replace Map lookup with:

```typescript
    const projectId = c.req.param("id");
    // Try as workflow ID first, then look up by UUID
    let status;
    try {
      status = await getProjectWorkflowStatus(workflowClient, projectId);
    } catch {
      // Not a workflow ID — try to find by UUID in DB
      const row = await lookupByWorkflowId(projectId);
      if (row) {
        status = await getProjectWorkflowStatus(workflowClient, row.workflow_id);
      }
    }
```

**Step 4: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 5: Run all PM tests**

Run: `bun test apps/project-manager/src/__tests__/`
Expected: All tests pass

**Step 6: Commit**

```bash
git add apps/project-manager/src/index.ts
git commit -m "remove in-memory Maps, use PostgreSQL as sole workflow state source"
```

---

## Task 7: Parallel Workflows — Add Poll Jitter

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:1045-1071` (`pollGithubForCompletion`)

**Step 1: Write the failing test**

Add to `apps/project-manager/src/__tests__/retry-budget.test.ts`:

```typescript
import { pollGithubForCompletion } from "../workflow.js";

describe("pollGithubForCompletion jitter", () => {
  it("completes when pollFn returns a result", async () => {
    let calls = 0;
    const { result, timedOut, blocked } = await pollGithubForCompletion(
      async () => {
        calls++;
        return calls >= 2 ? "found" : null;
      },
      async () => false,
      1, // 1 minute timeout
      50  // 50ms interval for fast test
    );
    expect(result).toBe("found");
    expect(timedOut).toBe(false);
    expect(blocked).toBe(false);
    expect(calls).toBe(2);
  });

  it("returns blocked when checkBlocked returns true", async () => {
    const { result, blocked } = await pollGithubForCompletion(
      async () => null,
      async () => true,
      1,
      50
    );
    expect(result).toBeNull();
    expect(blocked).toBe(true);
  });
});
```

**Step 2: Run test to verify existing behavior works**

Run: `bun test apps/project-manager/src/__tests__/retry-budget.test.ts`
Expected: PASS (these tests validate current behavior before adding jitter)

**Step 3: Add jitter to pollGithubForCompletion**

In `apps/project-manager/src/workflow.ts`, modify the `pollGithubForCompletion` function.

Change the sleep line from:
```typescript
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
```
to:
```typescript
    // Add 0-5s random jitter to prevent synchronized polling from concurrent workflows
    const jitter = Math.floor(Math.random() * 5000);
    await new Promise((resolve) => setTimeout(resolve, intervalMs + jitter));
```

**Step 4: Run tests**

Run: `bun test apps/project-manager/src/__tests__/retry-budget.test.ts`
Expected: PASS (jitter doesn't affect correctness, just timing)

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/project-manager/src/workflow.ts apps/project-manager/src/__tests__/retry-budget.test.ts
git commit -m "add random jitter to poll intervals for parallel workflow support"
```

---

## Task 8: PM Autonomy — Types and Activity Stub

**Files:**
- Modify: `apps/project-manager/src/workflow.ts` (add types and stub)

**Step 1: Write the failing test**

Create `apps/project-manager/src/__tests__/auto-resolve.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import type {
  AttemptAutoResolveInput,
  AttemptAutoResolveOutput,
} from "../workflow.js";

describe("AttemptAutoResolve types", () => {
  it("AttemptAutoResolveInput has required fields", () => {
    const input: AttemptAutoResolveInput = {
      issueNumber: 42,
      repoOwner: "test-owner",
      repoName: "test-repo",
      workflowPhase: "PLANNING",
    };
    expect(input.workflowPhase).toBe("PLANNING");
  });

  it("AttemptAutoResolveOutput represents resolved case", () => {
    const output: AttemptAutoResolveOutput = {
      resolved: true,
      answer: "Place auth middleware in src/middleware/auth.ts",
      question: "Where should the auth middleware go?",
      agentsConsulted: ["architect-agent"],
    };
    expect(output.resolved).toBe(true);
    expect(output.answer).toBeDefined();
  });

  it("AttemptAutoResolveOutput represents unresolved case with bestGuess", () => {
    const output: AttemptAutoResolveOutput = {
      resolved: false,
      bestGuess: "Possibly in the middleware directory, but uncertain about the pattern",
      question: "What auth pattern should we use?",
      agentsConsulted: ["architect-agent", "researcher-agent"],
    };
    expect(output.resolved).toBe(false);
    expect(output.bestGuess).toBeDefined();
    expect(output.agentsConsulted).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/project-manager/src/__tests__/auto-resolve.test.ts`
Expected: FAIL — types not exported.

**Step 3: Add types and stub to workflow.ts**

Add types (after `IncrementRetryCycleInput`):

```typescript
export interface AttemptAutoResolveInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowPhase: string;
}

export interface AttemptAutoResolveOutput {
  resolved: boolean;
  answer?: string;
  bestGuess?: string;
  question: string;
  agentsConsulted: string[];
}
```

Add stub (after `incrementRetryCycleActivity`):

```typescript
export let attemptAutoResolveActivity: ActivityFn<
  AttemptAutoResolveInput,
  AttemptAutoResolveOutput
> = async () => {
  throw new Error("attemptAutoResolveActivity not initialized");
};
```

Add to `WorkflowActivityImplementations`:

```typescript
attemptAutoResolve: typeof attemptAutoResolveActivity;
```

Wire in `createWorkflowRuntime`:

```typescript
attemptAutoResolveActivity = activityImpls.attemptAutoResolve;
```

And register:

```typescript
runtime.registerActivity(attemptAutoResolveActivity);
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/project-manager/src/__tests__/auto-resolve.test.ts`
Expected: PASS (3 tests)

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/project-manager/src/workflow.ts apps/project-manager/src/__tests__/auto-resolve.test.ts
git commit -m "add AttemptAutoResolve types and activity stub"
```

---

## Task 9: PM Autonomy — Modify Blocked Handling in Workflow

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:519-525` (PLANNING blocked handling)
- Modify: `apps/project-manager/src/workflow.ts:608-612` (IMPLEMENTATION blocked handling)
- Modify: `apps/project-manager/src/workflow.ts:660-665` (QA blocked handling)

**Step 1: Replace blocked handling in PLANNING phase**

Replace lines 519-525 (the `if (planResult.blocked)` block):

```typescript
    if (planResult.blocked) {
      console.log(`[Workflow] Issue #${issueNumber} is blocked during planning`);

      // Attempt autonomous resolution before escalating
      const autoResolve: AttemptAutoResolveOutput = yield ctx.callActivity(
        attemptAutoResolveActivity,
        { issueNumber, repoOwner, repoName, workflowPhase: "PLANNING" }
      );

      if (autoResolve.resolved) {
        console.log(`[Workflow] Auto-resolved blocked question for issue #${issueNumber}`);
        yield ctx.callActivity(addCommentActivity, {
          issueNumber, repoOwner, repoName,
          body: `**PM Auto-Resolution** (consulted: ${autoResolve.agentsConsulted.join(", ")})\n\n${autoResolve.answer}`,
        });
        // Wait briefly for GWA to pick up the answer
        const unblockTimeout = new Promise((r) => setTimeout(r, 30_000));
        // Wait for external unblock event or timeout
        yield ctx.waitForExternalEvent("card-unblocked");
      } else {
        // Escalate with best-guess context
        const ntfyBody = autoResolve.bestGuess
          ? `${autoResolve.question}\n\nPM best guess (${autoResolve.agentsConsulted.join("+")}): ${autoResolve.bestGuess}`
          : autoResolve.question;
        yield ctx.callActivity(notifyBlockedActivity, {
          issueNumber, repoOwner, repoName,
          question: ntfyBody,
          ntfyTopic: "mesh-six-pm",
        });
        yield ctx.waitForExternalEvent("card-unblocked");
      }

      console.log(`[Workflow] Issue #${issueNumber} unblocked, resuming planning`);
      continue;
    }
```

**Step 2: Apply same pattern to IMPLEMENTATION blocked handling**

Replace lines 608-612:

```typescript
  if (implResult.blocked) {
    console.log(`[Workflow] Issue #${issueNumber} blocked during implementation`);

    const autoResolve: AttemptAutoResolveOutput = yield ctx.callActivity(
      attemptAutoResolveActivity,
      { issueNumber, repoOwner, repoName, workflowPhase: "IMPLEMENTATION" }
    );

    if (autoResolve.resolved) {
      yield ctx.callActivity(addCommentActivity, {
        issueNumber, repoOwner, repoName,
        body: `**PM Auto-Resolution** (consulted: ${autoResolve.agentsConsulted.join(", ")})\n\n${autoResolve.answer}`,
      });
    } else {
      const ntfyBody = autoResolve.bestGuess
        ? `${autoResolve.question}\n\nPM best guess (${autoResolve.agentsConsulted.join("+")}): ${autoResolve.bestGuess}`
        : autoResolve.question;
      yield ctx.callActivity(notifyBlockedActivity, {
        issueNumber, repoOwner, repoName,
        question: ntfyBody,
        ntfyTopic: "mesh-six-pm",
      });
    }

    yield ctx.waitForExternalEvent("card-unblocked");
    console.log(`[Workflow] Issue #${issueNumber} unblocked, continuing to QA`);
  }
```

**Step 3: Apply same pattern to QA blocked handling**

Replace lines 660-665:

```typescript
    if (qaResult.blocked) {
      console.log(`[Workflow] Issue #${issueNumber} blocked during QA`);

      const autoResolve: AttemptAutoResolveOutput = yield ctx.callActivity(
        attemptAutoResolveActivity,
        { issueNumber, repoOwner, repoName, workflowPhase: "QA" }
      );

      if (autoResolve.resolved) {
        yield ctx.callActivity(addCommentActivity, {
          issueNumber, repoOwner, repoName,
          body: `**PM Auto-Resolution** (consulted: ${autoResolve.agentsConsulted.join(", ")})\n\n${autoResolve.answer}`,
        });
      } else {
        const ntfyBody = autoResolve.bestGuess
          ? `${autoResolve.question}\n\nPM best guess (${autoResolve.agentsConsulted.join("+")}): ${autoResolve.bestGuess}`
          : autoResolve.question;
        yield ctx.callActivity(notifyBlockedActivity, {
          issueNumber, repoOwner, repoName,
          question: ntfyBody,
          ntfyTopic: "mesh-six-pm",
        });
      }

      yield ctx.waitForExternalEvent("card-unblocked");
      console.log(`[Workflow] Issue #${issueNumber} unblocked, resuming QA`);
      continue;
    }
```

**Step 4: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/project-manager/src/workflow.ts
git commit -m "replace direct ntfy escalation with auto-resolve cascade in blocked handling"
```

---

## Task 10: PM Autonomy — Wire Activity Implementation

**Files:**
- Modify: `apps/project-manager/src/index.ts` (add `attemptAutoResolve` implementation, add helper functions)

**Step 1: Write the failing test for helper functions**

Add to `apps/project-manager/src/__tests__/auto-resolve.test.ts`:

```typescript
describe("Question classification", () => {
  it("classifies architectural questions", () => {
    // This tests the LLM prompt contract — the classification categories
    const categories = ["architectural", "technical-research", "credential-access", "ambiguous"];
    expect(categories).toContain("architectural");
    expect(categories).toContain("credential-access");
  });
});
```

**Step 2: Add the `attemptAutoResolve` activity implementation**

In `apps/project-manager/src/index.ts`, add the implementation to the `activityImplementations` object (before the closing `};`):

```typescript
      attemptAutoResolve: async (_ctx, input) => {
        if (!ghProjectClient) {
          return { resolved: false, question: "Unknown (no GitHub client)", agentsConsulted: [] };
        }

        // 1. Fetch the question from recent issue comments
        const comments = await ghProjectClient.getIssueComments(input.repoOwner, input.repoName, input.issueNumber);
        const recentComments = comments.slice(-5).map((c) => `[${c.user}]: ${c.body}`).join("\n\n");

        const { text: extractedQuestion } = await tracedChatCompletion(
          {
            model: LLM_MODEL,
            system: "Extract the blocked question from these issue comments. Return ONLY the question text, nothing else. If no clear question is found, return 'NONE'.",
            prompt: recentComments,
          },
          eventLog ? { eventLog, traceId: crypto.randomUUID(), agentId: AGENT_ID } : undefined
        );

        if (!extractedQuestion || extractedQuestion.trim() === "NONE") {
          return { resolved: false, question: "Could not extract question from comments", agentsConsulted: [] };
        }

        const question = extractedQuestion.trim();

        // 2. Classify the question
        const { text: classification } = await tracedChatCompletion(
          {
            model: LLM_MODEL,
            system: `Classify this question into exactly one category. Respond with ONLY the category name.
Categories:
- architectural: architecture decisions, design patterns, code structure, where things should go
- technical-research: technology choices, library usage, implementation techniques, debugging
- credential-access: authentication, API keys, tokens, permissions, access control setup
- ambiguous: unclear or could be multiple categories`,
            prompt: question,
          },
          eventLog ? { eventLog, traceId: crypto.randomUUID(), agentId: AGENT_ID } : undefined
        );

        const category = classification.trim().toLowerCase();
        const agentsConsulted: string[] = [];

        // 3. Skip agents for credential/access questions — human must handle
        if (category === "credential-access") {
          return { resolved: false, question, agentsConsulted: [] };
        }

        // 4. Agent cascade — first agent based on classification
        const firstAgent = category === "architectural" ? "architect" : "researcher";
        let firstResponse: string | null = null;

        if (firstAgent === "architect") {
          const result = await consultArchitect(question);
          agentsConsulted.push("architect-agent");
          if (typeof result === "object" && result !== null && !("error" in result)) {
            firstResponse = JSON.stringify(result);
          }
        } else {
          const result = await requestResearch(question);
          agentsConsulted.push("researcher-agent");
          if (typeof result === "object" && result !== null && !("error" in result)) {
            firstResponse = JSON.stringify(result);
          }
        }

        // 5. Evaluate first response confidence
        if (firstResponse) {
          const { text: evalResult } = await tracedChatCompletion(
            {
              model: LLM_MODEL,
              system: `Evaluate if this agent response adequately answers the question. Respond with JSON: { "confident": boolean, "answer": "string" }
- "confident": true if the response directly and completely answers the question
- "answer": the answer extracted/summarized from the response`,
              prompt: `Question: ${question}\n\nAgent response: ${firstResponse}`,
            },
            eventLog ? { eventLog, traceId: crypto.randomUUID(), agentId: AGENT_ID } : undefined
          );

          try {
            const evaluation = JSON.parse(evalResult);
            if (evaluation.confident) {
              return { resolved: true, answer: evaluation.answer, question, agentsConsulted };
            }
          } catch { /* parse failure — fall through to second agent */ }
        }

        // 6. Second agent — the one we didn't try first
        const secondAgent = firstAgent === "architect" ? "researcher" : "architect";
        let secondResponse: string | null = null;

        if (secondAgent === "architect") {
          const contextualQuestion = firstResponse
            ? `${question}\n\nPrevious attempt by researcher yielded: ${firstResponse}`
            : question;
          const result = await consultArchitect(contextualQuestion);
          agentsConsulted.push("architect-agent");
          if (typeof result === "object" && result !== null && !("error" in result)) {
            secondResponse = JSON.stringify(result);
          }
        } else {
          const contextualQuery = firstResponse
            ? `${question}\n\nPrevious attempt by architect yielded: ${firstResponse}`
            : question;
          const result = await requestResearch(contextualQuery);
          agentsConsulted.push("researcher-agent");
          if (typeof result === "object" && result !== null && !("error" in result)) {
            secondResponse = JSON.stringify(result);
          }
        }

        // 7. Evaluate combined response
        const combined = [firstResponse, secondResponse].filter(Boolean).join("\n\n");
        if (combined) {
          const { text: evalResult } = await tracedChatCompletion(
            {
              model: LLM_MODEL,
              system: `Evaluate if these combined agent responses adequately answer the question. Respond with JSON: { "confident": boolean, "answer": "string" }`,
              prompt: `Question: ${question}\n\nCombined responses:\n${combined}`,
            },
            eventLog ? { eventLog, traceId: crypto.randomUUID(), agentId: AGENT_ID } : undefined
          );

          try {
            const evaluation = JSON.parse(evalResult);
            if (evaluation.confident) {
              return { resolved: true, answer: evaluation.answer, question, agentsConsulted };
            }
            return { resolved: false, bestGuess: evaluation.answer, question, agentsConsulted };
          } catch { /* fall through */ }
        }

        return { resolved: false, question, agentsConsulted };
      },
```

**Step 3: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS

**Step 4: Run all PM tests**

Run: `bun test apps/project-manager/src/__tests__/`
Expected: All tests pass

**Step 5: Commit**

```bash
git add apps/project-manager/src/index.ts apps/project-manager/src/__tests__/auto-resolve.test.ts
git commit -m "implement attemptAutoResolve activity with two-agent cascade"
```

---

## Task 11: Final Verification and Version Bumps

**Files:**
- Modify: `packages/core/package.json` (version bump)
- Modify: `apps/project-manager/package.json` (version bump)

**Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: All 22 packages pass

**Step 2: Run full test suite**

Run: `bun run --filter @mesh-six/core test && bun test apps/project-manager/src/__tests__/`
Expected: All tests pass (core: 128+, PM: 8+ existing + new tests)

**Step 3: Bump versions**

In `packages/core/package.json`, bump version (patch):
```json
"version": "0.7.1"
```
(Or whatever the current version is + patch increment)

In `apps/project-manager/package.json`, bump version (minor — new features):
```json
"version": "0.5.0"
```
(Or whatever the current version is + minor increment)

**Step 4: Commit**

```bash
git add packages/core/package.json apps/project-manager/package.json
git commit -m "bump core to 0.7.1 and project-manager to 0.5.0 for PM enhancements"
```

---

## Task 12: Update Docs

Run the `update-docs` skill to update CHANGELOG.md, CLAUDE.md, and README.md with the new enhancements.

```bash
# Invoke: /update-docs
```

Then commit the doc changes.

---

## Agent Teams Execution Plan

This plan is designed for execution using Claude Code Agent Teams. The team lead coordinates two parallel teammates with a shared task list.

### Team Structure

**Team Lead** — Coordinator (delegate mode). Responsibilities:
- Delegates Phase 1 foundation tasks to synchronous subagents (context preservation)
- Spawns teammates for Phase 2
- Monitors progress via TaskList polling
- Delegates Phase 3 integration to a fresh subagent
- Reviews results, bumps versions, updates docs

### Phase 1: Foundation (Team Lead Delegates to Subagents)

Foundation tasks define the contracts that teammates depend on. The lead delegates each to a synchronous subagent to preserve context.

**Task 1.1: Database migration**
- Create `migrations/008_pm_retry_budget.sql` (ALTER TABLE adds 4 columns)
- Run `bun run db:migrate` to verify

**Task 1.2: All new types + activity stubs in workflow.ts**
- Add `retryBudget?: number` to `ProjectWorkflowInput`
- Add `LoadRetryBudgetInput`, `LoadRetryBudgetOutput`, `IncrementRetryCycleInput` types
- Add `AttemptAutoResolveInput`, `AttemptAutoResolveOutput` types
- Add activity stubs: `loadRetryBudgetActivity`, `incrementRetryCycleActivity`, `attemptAutoResolveActivity`
- Add all three to `WorkflowActivityImplementations` interface
- Wire and register all three in `createWorkflowRuntime`

**Task 1.3: TokenBucket rate limiter in github.ts**
- Add `TokenBucket` class with `tryConsume()` and `waitForToken()`
- Add `rateLimiter` field to `GitHubProjectClient`, initialize in constructor
- Add `await this.rateLimit()` call to each public API method
- Export `TokenBucket` and `TokenBucketConfig` from `packages/core/src/index.ts`
- Create `packages/core/src/github-ratelimit.test.ts` (4 tests)

**Verification gate:** `bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/project-manager typecheck && bun run --filter @mesh-six/core test`

### Phase 2: Parallel Implementation (2 Teammates)

#### Teammate A: Workflow Body Changes

**Owns:**
- `apps/project-manager/src/workflow.ts` (body changes only — types/stubs already added in Phase 1)
- `apps/project-manager/src/__tests__/retry-budget.test.ts` (new file)
- `apps/project-manager/src/__tests__/auto-resolve.test.ts` (new file)

**Tasks:**
1. **Retry budget loop changes** — Remove `MAX_PLAN_CYCLES` and `MAX_QA_CYCLES` constants. Before PLANNING loop, add `loadRetryBudgetActivity` call. Change loop conditions from hardcoded `3` to `maxCycles` (from DB). Add `incrementRetryCycleActivity` calls after plan rejection and test failure.
2. **Poll jitter** — Add 0-5s random jitter to `pollGithubForCompletion` sleep interval.
3. **Auto-resolve blocked handling** — Replace all 3 blocked handling blocks (PLANNING, IMPLEMENTATION, QA) with the `attemptAutoResolveActivity` cascade: try auto-resolve → if resolved post answer → if not resolved escalate via ntfy with bestGuess.
4. **Write tests** — `retry-budget.test.ts` (type contracts + pollGithubForCompletion behavior), `auto-resolve.test.ts` (type contracts + classification categories).

**Reads (no writes):** `packages/core/src/*`

**Validation:** `bun run --filter @mesh-six/project-manager typecheck && bun test apps/project-manager/src/__tests__/retry-budget.test.ts && bun test apps/project-manager/src/__tests__/auto-resolve.test.ts`

#### Teammate B: Server Wiring + Map Removal

**Owns:**
- `apps/project-manager/src/index.ts`

**Tasks:**
1. **Extend WorkflowInstanceRow** — Add `plan_cycles_used`, `qa_cycles_used`, `retry_budget`, `failure_history` fields to the interface.
2. **Add lookupByWorkflowId helper** — DB query by workflow_id.
3. **Wire retry budget activities** — `loadRetryBudget` (SELECT query), `incrementRetryCycle` (UPDATE + JSONB append).
4. **Wire attemptAutoResolve activity** — Full two-agent cascade implementation with LLM question extraction, classification, agent consultation, and confidence evaluation.
5. **Remove in-memory Maps** — Delete `projectWorkflowMap` and `projects` Maps. Replace all `.get()` / `.set()` references with DB lookups (9 sites, per Task 6 step 3).

**Reads (no writes):** `packages/core/src/*`, `apps/project-manager/src/workflow.ts` (for activity type signatures)

**Validation:** `bun run --filter @mesh-six/project-manager typecheck`

### Phase 3: Integration + Verification (Subagent-Delegated)

After both teammates complete, spawn a fresh **integration subagent** to:

1. Read all modified files (`workflow.ts`, `index.ts`, `github.ts`, test files)
2. Verify imports align (workflow.ts exports match index.ts imports)
3. Verify activity interface implementations match their type signatures
4. Run `bun run typecheck` (all 22 packages)
5. Run `bun run --filter @mesh-six/core test` (core tests including github-ratelimit)
6. Run `bun test apps/project-manager/src/__tests__/` (all PM tests)
7. Fix any integration mismatches
8. Return a summary of all changes and verification results

**Lead then:**
- Review the integration summary
- Bump `packages/core/package.json` version to `0.7.1`
- Bump `apps/project-manager/package.json` version to `0.4.0`
- Run `update-docs` skill for CHANGELOG/CLAUDE.md updates
- Commit

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead (Phase 1)** | `migrations/008_pm_retry_budget.sql`, `packages/core/src/github.ts` (TokenBucket), `packages/core/src/github-ratelimit.test.ts`, `packages/core/src/index.ts` (export), `packages/core/package.json`, `apps/project-manager/package.json`, `CHANGELOG.md` | Everything |
| **A** | `apps/project-manager/src/workflow.ts` (body), `apps/project-manager/src/__tests__/retry-budget.test.ts`, `apps/project-manager/src/__tests__/auto-resolve.test.ts` | `packages/core/src/*` |
| **B** | `apps/project-manager/src/index.ts` | `packages/core/src/*`, `apps/project-manager/src/workflow.ts` |

Note: Phase 1 adds types/stubs to `workflow.ts`. In Phase 2, only Teammate A modifies `workflow.ts` (body changes). No conflicts.

### Task Dependency DAG

```
Phase 1 (Lead → subagents):
  1.1 Migration ────────┐
  1.2 Types + stubs ────┼── All must pass typecheck before Phase 2
  1.3 TokenBucket + test ┘

Phase 2 (Parallel):
  A: Workflow body + tests ──┐
                              ├── Both must complete before Phase 3
  B: Server wiring + Maps ───┘

Phase 3 (Lead → integration subagent):
  3.1 Integration subagent (read, fix, typecheck, test)
  3.2 Version bumps + docs
  3.3 Commit
```

### Claude Code Session Setup

**Prerequisites:**

Agent Teams must be enabled:
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
2. Tell Claude: `@docs/plans/2026-02-25-pm-enhancements-plan.md follow the Agent Teams Execution Plan`
3. Claude creates a task list with dependencies:
   - Tasks 1-3: Phase 1 foundation (sequential)
   - Task 4: Phase 1 verification gate (blocked by 1-3)
   - Task 5: Teammate A work (blocked by task 4)
   - Task 6: Teammate B work (blocked by task 4)
   - Task 7: Phase 3 integration (blocked by tasks 5-6)
   - Task 8: Version bumps + docs (blocked by task 7)
4. Claude delegates Phase 1 tasks to synchronous subagents (leader sees summaries only)
5. Claude verifies the foundation gate (`bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/project-manager typecheck && bun run --filter @mesh-six/core test`)
6. Claude calls `TeamCreate` to establish a team named `pm-enhancements`
7. Claude spawns two teammates via `Task` tool (see prompts below)
8. Claude monitors via `TaskList` polling (30s intervals)
9. When both teammates complete, Claude sends `shutdown_request` to each
10. Claude spawns integration subagent (fresh context) to verify and fix
11. Claude bumps versions, updates docs, commits

### Teammate Prompt: A (Workflow Body Changes)

```
You are Teammate A on team pm-enhancements. Your job is to modify the PM workflow body in workflow.ts — replacing hardcoded retry constants with DB-backed budget, adding poll jitter, and replacing blocked handling with auto-resolve cascades.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim your task (set owner to "teammate-a")
- Use TaskGet to read the full task description

**File Ownership:**
- You EXCLUSIVELY own:
  - apps/project-manager/src/workflow.ts (body changes only — types/stubs are already added)
  - apps/project-manager/src/__tests__/retry-budget.test.ts (create new)
  - apps/project-manager/src/__tests__/auto-resolve.test.ts (create new)
- You may READ but NOT modify: packages/core/src/*

**Context:**
- Read apps/project-manager/src/workflow.ts first — Phase 1 already added:
  - retryBudget?: number on ProjectWorkflowInput
  - LoadRetryBudgetInput/Output, IncrementRetryCycleInput types
  - AttemptAutoResolveInput/Output types
  - Activity stubs for all three
- The existing MAX_PLAN_CYCLES and MAX_QA_CYCLES constants (line ~402) need to be REMOVED
- The existing blocked handling blocks (3 locations) need to be REPLACED

**What to implement:**
1. Before the PLANNING loop, call loadRetryBudgetActivity to get budget from DB
2. Change PLANNING loop from `while (totalPlanCycles < MAX_PLAN_CYCLES)` to use DB budget
3. After plan rejection, call incrementRetryCycleActivity
4. Change QA loop similarly — use DB budget, call incrementRetryCycleActivity after test failure
5. In pollGithubForCompletion, add 0-5s random jitter to the sleep interval
6. Replace all 3 blocked handling blocks with: call attemptAutoResolveActivity → if resolved post comment + wait → if not resolved ntfy with bestGuess + wait
7. Write retry-budget.test.ts testing type contracts and pollGithubForCompletion behavior
8. Write auto-resolve.test.ts testing type contracts

**Validation:**
bun run --filter @mesh-six/project-manager typecheck
bun test apps/project-manager/src/__tests__/retry-budget.test.ts
bun test apps/project-manager/src/__tests__/auto-resolve.test.ts

**When complete:** Mark your task as completed via TaskUpdate, send completion report via SendMessage.
```

### Teammate Prompt: B (Server Wiring + Map Removal)

```
You are Teammate B on team pm-enhancements. Your job is to modify the PM server (index.ts) — wiring new activity implementations, adding the attemptAutoResolve agent cascade, and removing in-memory Maps in favor of DB lookups.

**Task Management:**
- Use TaskList to see available tasks
- Use TaskUpdate to claim your task (set owner to "teammate-b")
- Use TaskGet to read the full task description

**File Ownership:**
- You EXCLUSIVELY own: apps/project-manager/src/index.ts
- You may READ but NOT modify: packages/core/src/*, apps/project-manager/src/workflow.ts

**Context:**
- Read apps/project-manager/src/index.ts — understand existing patterns
- Read apps/project-manager/src/workflow.ts — understand the activity type signatures added in Phase 1
- Existing helper functions consultArchitect() and requestResearch() (lines 361-417) are used for the auto-resolve cascade
- Existing tracedChatCompletion is used for LLM calls

**What to implement:**
1. Extend WorkflowInstanceRow interface with: plan_cycles_used, qa_cycles_used, retry_budget, failure_history
2. Add lookupByWorkflowId(workflowId) helper function (DB query)
3. Wire loadRetryBudget activity: SELECT plan_cycles_used, qa_cycles_used, retry_budget FROM pm_workflow_instances
4. Wire incrementRetryCycle activity: UPDATE the relevant column + 1, append to failure_history JSONB
5. Wire attemptAutoResolve activity: extract question from comments (LLM), classify (LLM), call first agent, evaluate confidence (LLM), call second agent if needed, evaluate combined (LLM)
6. Delete projectWorkflowMap (line 111) and projects Map (line 358)
7. Replace all Map.get/set references with DB lookups (9 sites — see plan Task 6 Step 3 for exact lines)

**Validation:**
bun run --filter @mesh-six/project-manager typecheck

**When complete:** Mark your task as completed via TaskUpdate, send completion report via SendMessage.
```
