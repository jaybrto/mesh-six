# GWA Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace polling-based workflow with event-driven architecture: architect Dapr actor with per-issue context, `waitForExternalEvent` in all workflow phases, question resolution loop (architect auto-answer + human escalation via ntfy), label-based complexity gate.

**Architecture:** Architect becomes a Dapr actor with per-issue instances storing sequential events in PostgreSQL. All polling activities (`pollForPlan`, `pollForImplementation`, `pollForTestResults`) replaced with `waitForExternalEvent` channels. SessionMonitor raises typed events on workflow instances via Dapr HTTP API. Questions route through architect actor first, escalate to human via ntfy webhook if not confident. Simple issues (label `simple`) skip Opus planning.

**Tech Stack:** Bun + Hono + Dapr Workflows + Dapr Actors (HTTP protocol) + PostgreSQL (event log) + Mem0 (cross-issue memory) + ntfy (human notifications)

**Design doc:** `docs/plans/2026-02-26-gwa-migration-design.md`

---

## Phase 1: Foundation

### Task 1: Database Migration — architect_events table

**Files:**
- Create: `migrations/009_architect_events.sql`

**Step 1: Write the migration**

```sql
-- migrations/009_architect_events.sql
CREATE TABLE architect_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_architect_events_actor ON architect_events(actor_id, created_at);
CREATE INDEX idx_architect_events_type ON architect_events(actor_id, event_type);
```

**Step 2: Run migration**

Run: `DATABASE_URL="postgresql://..." bun run db:migrate`
Expected: Migration 009 applied successfully.

**Step 3: Commit**

```bash
git add migrations/009_architect_events.sql
git commit -m "add architect_events table migration"
```

---

### Task 2: Core Types — Architect Actor Constants and Schemas

**Files:**
- Create: `packages/core/src/architect-actor.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/architect-actor.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/architect-actor.test.ts
import { describe, it, expect } from "bun:test";
import {
  ARCHITECT_ACTOR_TYPE,
  ArchitectActorStateSchema,
  ArchitectEventSchema,
  PlanningEventPayloadSchema,
  ImplEventPayloadSchema,
  QaEventPayloadSchema,
  HumanAnswerPayloadSchema,
  AnswerQuestionOutputSchema,
} from "./architect-actor.js";

describe("architect-actor types", () => {
  it("exports ARCHITECT_ACTOR_TYPE constant", () => {
    expect(ARCHITECT_ACTOR_TYPE).toBe("ArchitectActor");
  });

  it("validates ArchitectActorState", () => {
    const state = {
      issueNumber: 42,
      repoOwner: "jaybrto",
      repoName: "mesh-six",
      workflowId: "wf-abc-123",
      projectItemId: "PVTI_abc",
      issueTitle: "Add auth",
    };
    expect(ArchitectActorStateSchema.parse(state)).toEqual(state);
  });

  it("validates architect events", () => {
    const event = {
      actorId: "jaybrto/mesh-six/42",
      eventType: "consulted",
      payload: { question: "How?", recommendation: {} },
    };
    expect(ArchitectEventSchema.parse(event)).toBeTruthy();
  });

  it("validates planning-event payloads", () => {
    const questionEvent = { type: "question-detected", questionText: "What auth?", sessionId: "s1" };
    expect(PlanningEventPayloadSchema.parse(questionEvent)).toBeTruthy();

    const completeEvent = { type: "plan-complete", planContent: "## Plan" };
    expect(PlanningEventPayloadSchema.parse(completeEvent)).toBeTruthy();

    const failEvent = { type: "session-failed", error: "crash" };
    expect(PlanningEventPayloadSchema.parse(failEvent)).toBeTruthy();
  });

  it("validates impl-event payloads", () => {
    const prEvent = { type: "pr-created", prNumber: 7 };
    expect(ImplEventPayloadSchema.parse(prEvent)).toBeTruthy();
  });

  it("validates qa-event payloads", () => {
    const testEvent = { type: "test-results", testContent: "PASS" };
    expect(QaEventPayloadSchema.parse(testEvent)).toBeTruthy();
  });

  it("validates human-answer payload", () => {
    const answer = { answer: "Use OAuth", timestamp: new Date().toISOString() };
    expect(HumanAnswerPayloadSchema.parse(answer)).toBeTruthy();
  });

  it("validates answerQuestion output", () => {
    const confident = { confident: true, answer: "Use JWT" };
    expect(AnswerQuestionOutputSchema.parse(confident)).toBeTruthy();

    const notConfident = { confident: false, bestGuess: "Maybe JWT?" };
    expect(AnswerQuestionOutputSchema.parse(notConfident)).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/architect-actor.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
// packages/core/src/architect-actor.ts
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARCHITECT_ACTOR_TYPE = "ArchitectActor";

// ---------------------------------------------------------------------------
// Actor State (set at activation, immutable)
// ---------------------------------------------------------------------------

export const ArchitectActorStateSchema = z.object({
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  workflowId: z.string(),
  projectItemId: z.string(),
  issueTitle: z.string(),
});
export type ArchitectActorState = z.infer<typeof ArchitectActorStateSchema>;

// ---------------------------------------------------------------------------
// Event Log Types
// ---------------------------------------------------------------------------

export const ArchitectEventSchema = z.object({
  actorId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ArchitectEvent = z.infer<typeof ArchitectEventSchema>;

export const ARCHITECT_EVENT_TYPES = [
  "activated",
  "consulted",
  "question-received",
  "question-answered",
  "human-escalated",
  "human-answered",
  "memory-stored",
  "deactivated",
] as const;
export type ArchitectEventType = (typeof ARCHITECT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Workflow Event Channel Payloads
// ---------------------------------------------------------------------------

export const PlanningEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("plan-complete"), planContent: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type PlanningEventPayload = z.infer<typeof PlanningEventPayloadSchema>;

export const ImplEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pr-created"), prNumber: z.number() }),
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type ImplEventPayload = z.infer<typeof ImplEventPayloadSchema>;

export const QaEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("test-results"), testContent: z.string() }),
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type QaEventPayload = z.infer<typeof QaEventPayloadSchema>;

export const HumanAnswerPayloadSchema = z.object({
  answer: z.string(),
  timestamp: z.string(),
});
export type HumanAnswerPayload = z.infer<typeof HumanAnswerPayloadSchema>;

// ---------------------------------------------------------------------------
// Actor Method I/O
// ---------------------------------------------------------------------------

export const AnswerQuestionOutputSchema = z.object({
  confident: z.boolean(),
  answer: z.string().optional(),
  bestGuess: z.string().optional(),
});
export type AnswerQuestionOutput = z.infer<typeof AnswerQuestionOutputSchema>;
```

**Step 4: Export from core index**

Add to `packages/core/src/index.ts` at the end of the file:

```typescript
// Architect Actor
export {
  ARCHITECT_ACTOR_TYPE,
  ArchitectActorStateSchema,
  ArchitectEventSchema,
  ARCHITECT_EVENT_TYPES,
  PlanningEventPayloadSchema,
  ImplEventPayloadSchema,
  QaEventPayloadSchema,
  HumanAnswerPayloadSchema,
  AnswerQuestionOutputSchema,
  type ArchitectActorState,
  type ArchitectEvent,
  type ArchitectEventType,
  type PlanningEventPayload,
  type ImplEventPayload,
  type QaEventPayload,
  type HumanAnswerPayload,
  type AnswerQuestionOutput,
} from "./architect-actor.js";
```

**Step 5: Run tests**

Run: `bun test packages/core/src/architect-actor.test.ts`
Expected: All tests PASS.

**Step 6: Run existing core tests**

Run: `bun run --filter @mesh-six/core test`
Expected: All existing tests still pass.

**Step 7: Commit**

```bash
git add packages/core/src/architect-actor.ts packages/core/src/architect-actor.test.ts packages/core/src/index.ts
git commit -m "add architect actor types, event schemas, and workflow event payloads"
```

---

### Task 3: Architect Event DB Module

**Files:**
- Create: `apps/architect-agent/src/event-db.ts`
- Test: `apps/architect-agent/src/event-db.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/architect-agent/src/event-db.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Pool } from "pg";
import { appendEvent, loadEvents, loadEventsByType } from "./event-db.js";

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

describe("architect event-db", () => {
  let pool: Pool;
  const testActorId = `test/repo/${Date.now()}`;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error("DATABASE_URL required for DB tests");
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM architect_events WHERE actor_id = $1", [testActorId]);
    await pool.end();
  });

  it("appends and loads events in order", async () => {
    await appendEvent(pool, testActorId, "activated", { issueTitle: "Test" });
    await appendEvent(pool, testActorId, "consulted", { question: "How?" });
    await appendEvent(pool, testActorId, "question-received", { questionText: "What auth?" });

    const events = await loadEvents(pool, testActorId);
    expect(events).toHaveLength(3);
    expect(events[0].event_type).toBe("activated");
    expect(events[1].event_type).toBe("consulted");
    expect(events[2].event_type).toBe("question-received");
    expect(events[0].payload).toEqual({ issueTitle: "Test" });
  });

  it("loads events filtered by type", async () => {
    const consulted = await loadEventsByType(pool, testActorId, "consulted");
    expect(consulted).toHaveLength(1);
    expect(consulted[0].payload).toEqual({ question: "How?" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/architect-agent/src/event-db.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
// apps/architect-agent/src/event-db.ts
import type { Pool } from "pg";

export interface ArchitectEventRow {
  id: number;
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function appendEvent(
  pool: Pool,
  actorId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<ArchitectEventRow> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `INSERT INTO architect_events (actor_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING id, actor_id, event_type, payload, created_at::text AS created_at`,
    [actorId, eventType, JSON.stringify(payload)],
  );
  return rows[0];
}

export async function loadEvents(
  pool: Pool,
  actorId: string,
): Promise<ArchitectEventRow[]> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `SELECT id, actor_id, event_type, payload, created_at::text AS created_at
     FROM architect_events
     WHERE actor_id = $1
     ORDER BY created_at ASC, id ASC`,
    [actorId],
  );
  return rows;
}

export async function loadEventsByType(
  pool: Pool,
  actorId: string,
  eventType: string,
): Promise<ArchitectEventRow[]> {
  const { rows } = await pool.query<ArchitectEventRow>(
    `SELECT id, actor_id, event_type, payload, created_at::text AS created_at
     FROM architect_events
     WHERE actor_id = $1 AND event_type = $2
     ORDER BY created_at ASC, id ASC`,
    [actorId, eventType],
  );
  return rows;
}
```

**Step 4: Run tests**

Run: `bun test apps/architect-agent/src/event-db.test.ts`
Expected: All PASS (requires DATABASE_URL pointing to a DB with migration 009 applied).

**Step 5: Commit**

```bash
git add apps/architect-agent/src/event-db.ts apps/architect-agent/src/event-db.test.ts
git commit -m "add architect event-db module with append/load functions"
```

---

## Phase 2: Architect Actor

### Task 4: ArchitectActor Class

**Files:**
- Create: `apps/architect-agent/src/actor.ts`
- Test: `apps/architect-agent/src/actor.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/architect-agent/src/actor.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ArchitectActor } from "./actor.js";

// Mock dependencies - these tests verify the actor's logic without real DB/LLM
describe("ArchitectActor", () => {
  it("constructs with actorType and actorId", () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");
    expect(actor).toBeDefined();
  });

  it("onInvoke routes to correct methods", async () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");

    // getHistory should return empty array before activation
    const history = await actor.onInvoke("getHistory", {});
    expect(history).toEqual({ events: [] });
  });

  it("rejects unknown methods", async () => {
    const actor = new ArchitectActor("ArchitectActor", "jaybrto/mesh-six/42");
    await expect(actor.onInvoke("unknownMethod", {})).rejects.toThrow("Unknown method");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/architect-agent/src/actor.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
// apps/architect-agent/src/actor.ts
/**
 * ArchitectActor — Dapr actor with per-issue instances.
 *
 * Maintains a sequential event log in PostgreSQL so it has full context
 * when answering questions during planning/implementation phases.
 * Uses Mem0 for cross-issue long-term memory.
 */
import { Pool } from "pg";
import {
  type ArchitectActorState,
  type ArchitectEventType,
  type AnswerQuestionOutput,
  ARCHITECT_ACTOR_TYPE,
} from "@mesh-six/core";
import {
  appendEvent,
  loadEvents,
  loadEventsByType,
  type ArchitectEventRow,
} from "./event-db.js";
import type { Actor } from "./actor-runtime.js";

const log = (actorId: string, msg: string) =>
  console.log(`[${ARCHITECT_ACTOR_TYPE}][${actorId}] ${msg}`);

// ---------------------------------------------------------------------------
// Dependencies injected at module level (set during service startup)
// ---------------------------------------------------------------------------

let pgPool: Pool | null = null;
let llmModel = "anthropic/claude-sonnet-4-20250514";
let searchApiUrl = "";
let searchApiKey = "";

// We need these function references from index.ts for LLM calls and memory.
// They're set via setActorDeps() during startup to avoid circular imports.
let handleConsultationFn: ((request: {
  question: string;
  context?: Record<string, unknown>;
  userId?: string;
  requireStructured: boolean;
}) => Promise<unknown>) | null = null;

let tracedChatCompletionFn: ((opts: {
  model: string;
  system: string;
  prompt: string;
}, trace?: unknown) => Promise<{ text: string }>) | null = null;

let memoryStoreFn: ((messages: Array<{ role: string; content: string }>, userId: string, metadata?: Record<string, unknown>) => Promise<void>) | null = null;

let memorySearchFn: ((query: string, userId: string, limit?: number) => Promise<Array<{ memory: string }>>) | null = null;

export function setActorDeps(deps: {
  pool: Pool | null;
  model: string;
  searchUrl: string;
  searchKey: string;
  handleConsultation: typeof handleConsultationFn;
  tracedChatCompletion: typeof tracedChatCompletionFn;
  memoryStore: typeof memoryStoreFn;
  memorySearch: typeof memorySearchFn;
}) {
  pgPool = deps.pool;
  llmModel = deps.model;
  searchApiUrl = deps.searchUrl;
  searchApiKey = deps.searchKey;
  handleConsultationFn = deps.handleConsultation;
  tracedChatCompletionFn = deps.tracedChatCompletion;
  memoryStoreFn = deps.memoryStore;
  memorySearchFn = deps.memorySearch;
}

// ---------------------------------------------------------------------------
// ArchitectActor
// ---------------------------------------------------------------------------

export class ArchitectActor implements Actor {
  private actorType: string;
  private actorId: string;
  private state: ArchitectActorState | null = null;
  private eventCache: ArchitectEventRow[] = [];

  constructor(actorType: string, actorId: string) {
    this.actorType = actorType;
    this.actorId = actorId;
  }

  async onActivate(): Promise<void> {
    log(this.actorId, "Activating (loading event log from PG)");
    if (pgPool) {
      this.eventCache = await loadEvents(pgPool, this.actorId);
    }
    log(this.actorId, `Loaded ${this.eventCache.length} events from PG`);
  }

  async onDeactivate(): Promise<void> {
    log(this.actorId, "Deactivating");
    if (pgPool) {
      await appendEvent(pgPool, this.actorId, "deactivated", { reason: "idle-timeout" });
    }
    this.state = null;
    this.eventCache = [];
  }

  async onInvoke(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(payload as ArchitectActorState);
      case "consult":
        return this.consult(payload as { question: string; context?: Record<string, unknown> });
      case "answerQuestion":
        return this.answerQuestion(payload as { questionText: string; source: string });
      case "receiveHumanAnswer":
        return this.receiveHumanAnswer(payload as { questionText: string; humanAnswer: string });
      case "getHistory":
        return this.getHistory();
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async onTimer(_timerName: string): Promise<void> {}
  async onReminder(_reminderName: string, _payload: unknown): Promise<void> {}

  // -------------------------------------------------------------------------
  // Actor Methods
  // -------------------------------------------------------------------------

  /**
   * Initialize actor with issue context. Called by PM after actor activation.
   */
  private async initialize(params: ArchitectActorState): Promise<{ ok: boolean }> {
    this.state = params;
    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "activated", {
        issueTitle: params.issueTitle,
        workflowId: params.workflowId,
      });
      this.eventCache.push(event);
    }
    log(this.actorId, `Initialized for issue #${params.issueNumber}: ${params.issueTitle}`);
    return { ok: true };
  }

  /**
   * Initial INTAKE consultation — same as the old stateless consult but stores the result.
   */
  private async consult(params: { question: string; context?: Record<string, unknown> }): Promise<unknown> {
    if (!handleConsultationFn) throw new Error("handleConsultation not set");

    const result = await handleConsultationFn({
      question: params.question,
      context: params.context,
      userId: `architect:${this.actorId}`,
      requireStructured: true,
    });

    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "consulted", {
        question: params.question,
        recommendation: result,
      });
      this.eventCache.push(event);
    }

    return result;
  }

  /**
   * Answer a question from planning/implementation using full event log context.
   */
  private async answerQuestion(params: {
    questionText: string;
    source: string;
  }): Promise<AnswerQuestionOutput> {
    if (!tracedChatCompletionFn) throw new Error("tracedChatCompletion not set");

    // Record question received
    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "question-received", {
        questionText: params.questionText,
        source: params.source,
      });
      this.eventCache.push(event);
    }

    // Build context from event log
    const contextParts: string[] = [];

    // Prior consultation recommendation
    const consulted = this.eventCache.filter((e) => e.event_type === "consulted");
    if (consulted.length > 0) {
      const latest = consulted[consulted.length - 1];
      contextParts.push(`## Prior Architecture Recommendation\n${JSON.stringify(latest.payload.recommendation, null, 2)}`);
    }

    // Previous Q&A
    const qaPairs = this.eventCache.filter(
      (e) => e.event_type === "question-answered" || e.event_type === "human-answered"
    );
    if (qaPairs.length > 0) {
      const qaContext = qaPairs
        .map((e) => `Q: ${e.payload.questionText}\nA: ${e.payload.answer || e.payload.humanAnswer}`)
        .join("\n\n");
      contextParts.push(`## Previous Q&A for This Issue\n${qaContext}`);
    }

    // Search Mem0 for cross-issue learnings
    if (memorySearchFn) {
      try {
        const memories = await memorySearchFn(params.questionText, `planning-qa:${this.state?.issueNumber}`, 5);
        if (memories.length > 0) {
          contextParts.push(`## Relevant Past Learnings\n${memories.map((m) => `- ${m.memory}`).join("\n")}`);
        }
      } catch (err) {
        log(this.actorId, `Mem0 search failed: ${err}`);
      }
    }

    // Build prompt
    const systemPrompt = `You are an architect answering questions about an ongoing implementation.
You have full context of this issue from your prior analysis and event log.
${contextParts.join("\n\n")}

If you are confident in your answer, respond with JSON: { "confident": true, "answer": "your answer" }
If you are NOT confident, respond with JSON: { "confident": false, "bestGuess": "your best guess" }

Do NOT make up answers. If you truly don't know, say so.`;

    const { text } = await tracedChatCompletionFn({
      model: llmModel,
      system: systemPrompt,
      prompt: params.questionText,
    });

    let output: AnswerQuestionOutput;
    try {
      output = JSON.parse(text);
    } catch {
      output = { confident: false, bestGuess: text };
    }

    // Record result
    if (pgPool) {
      const eventType: ArchitectEventType = output.confident ? "question-answered" : "human-escalated";
      const event = await appendEvent(pgPool, this.actorId, eventType, {
        questionText: params.questionText,
        ...(output.confident
          ? { answer: output.answer, confidence: true }
          : { bestGuess: output.bestGuess }),
      });
      this.eventCache.push(event);
    }

    return output;
  }

  /**
   * Process a human answer: store raw answer, generalize for Mem0, record events.
   */
  private async receiveHumanAnswer(params: {
    questionText: string;
    humanAnswer: string;
  }): Promise<{ ok: boolean }> {
    // Record raw human answer
    if (pgPool) {
      const event = await appendEvent(pgPool, this.actorId, "human-answered", {
        questionText: params.questionText,
        humanAnswer: params.humanAnswer,
      });
      this.eventCache.push(event);
    }

    // Generalize the answer for Mem0 storage
    if (tracedChatCompletionFn && memoryStoreFn) {
      try {
        const { text: generalized } = await tracedChatCompletionFn({
          model: llmModel,
          system: "Generalize this Q&A into a reusable learning that applies to future similar questions. Be concise. Return just the generalized learning, nothing else.",
          prompt: `Question: ${params.questionText}\nHuman Answer: ${params.humanAnswer}`,
        });

        // Store in Mem0 under issue-scoped AND global architect scope
        const issueUserId = `planning-qa:${this.state?.issueNumber}`;
        await memoryStoreFn(
          [
            { role: "user", content: params.questionText },
            { role: "assistant", content: params.humanAnswer },
          ],
          issueUserId,
          { type: "human-answer", generalized },
        );

        await memoryStoreFn(
          [
            { role: "user", content: params.questionText },
            { role: "assistant", content: generalized },
          ],
          "architect",
          { type: "generalized-learning", issueNumber: this.state?.issueNumber },
        );

        if (pgPool) {
          const event = await appendEvent(pgPool, this.actorId, "memory-stored", {
            issueScope: issueUserId,
            globalScope: "architect",
            summary: generalized.substring(0, 200),
          });
          this.eventCache.push(event);
        }

        log(this.actorId, `Stored generalized learning: ${generalized.substring(0, 100)}`);
      } catch (err) {
        log(this.actorId, `Failed to generalize/store human answer: ${err}`);
      }
    }

    return { ok: true };
  }

  /**
   * Return full event history for debugging / dashboard.
   */
  private getHistory(): { events: ArchitectEventRow[] } {
    return { events: this.eventCache };
  }
}
```

**Step 4: Create actor-runtime.ts (copied from llm-service pattern)**

Copy `apps/llm-service/src/actor-runtime.ts` to `apps/architect-agent/src/actor-runtime.ts` and update the import for config:

```typescript
// apps/architect-agent/src/actor-runtime.ts
// (Same Actor interface, ActorRuntime class, and helper functions as llm-service/actor-runtime.ts)
// Only change: import DAPR_HOST, DAPR_HTTP_PORT, AGENT_ID from local config instead of llm-service config.
```

Create a minimal config module if one doesn't exist:

```typescript
// apps/architect-agent/src/config.ts
export const AGENT_ID = process.env.AGENT_ID || "architect-agent";
export const DAPR_HOST = process.env.DAPR_HOST || "localhost";
export const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
```

Update `actor-runtime.ts` to import from `./config.js` instead of the llm-service config.

**Step 5: Run tests**

Run: `bun test apps/architect-agent/src/actor.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/architect-agent/src/actor.ts apps/architect-agent/src/actor.test.ts apps/architect-agent/src/actor-runtime.ts apps/architect-agent/src/config.ts
git commit -m "add ArchitectActor class with event-log-backed question answering"
```

---

### Task 5: Wire Actor Runtime into Architect Agent Service

**Files:**
- Modify: `apps/architect-agent/src/index.ts:322-631` (add actor routes, update /dapr/config, call setActorDeps)

**Step 1: Add actor runtime imports and initialization**

At the top of `apps/architect-agent/src/index.ts`, add after existing imports:

```typescript
import { ActorRuntime } from "./actor-runtime.js";
import { ArchitectActor, setActorDeps } from "./actor.js";
import { ARCHITECT_ACTOR_TYPE } from "@mesh-six/core";
```

**Step 2: Add Dapr actor config endpoint**

Replace the existing `/dapr/subscribe` and health endpoints section (around line 338) to also include actor config:

Add after the `/dapr/subscribe` handler:

```typescript
// Dapr actor config — declares actor types hosted by this service
app.get("/dapr/config", (c) =>
  c.json({
    entities: [ARCHITECT_ACTOR_TYPE],
    actorIdleTimeout: "60m",
    drainOngoingCallTimeout: "60s",
    drainRebalancedActors: true,
    reentrancy: { enabled: false },
  })
);
```

**Step 3: Add Dapr actor HTTP protocol routes**

Add before the lifecycle section (before line 573):

```typescript
// ---------------------------------------------------------------------------
// Dapr Actor HTTP Protocol Routes
// ---------------------------------------------------------------------------

let actorRuntime: ActorRuntime | null = null;

// Activate actor
app.put("/actors/:actorType/:actorId", async (c) => {
  const { actorType, actorId } = c.req.param();
  if (!actorRuntime) return c.json({ error: "Actor runtime not initialized" }, 500);
  await actorRuntime.activate(actorType, actorId);
  return c.json({ ok: true });
});

// Deactivate actor
app.delete("/actors/:actorType/:actorId", async (c) => {
  const { actorType, actorId } = c.req.param();
  if (!actorRuntime) return c.json({ error: "Actor runtime not initialized" }, 500);
  await actorRuntime.deactivate(actorType, actorId);
  return c.json({ ok: true });
});

// Invoke actor method
app.put("/actors/:actorType/:actorId/method/:methodName", async (c) => {
  const { actorType, actorId, methodName } = c.req.param();
  if (!actorRuntime) return c.json({ error: "Actor runtime not initialized" }, 500);
  let body: unknown;
  try { body = await c.req.json(); } catch { body = undefined; }
  const result = await actorRuntime.invoke(actorType, actorId, methodName, body);
  return c.json(result ?? { ok: true });
});

// Timer callback
app.put("/actors/:actorType/:actorId/method/timer/:timerName", async (c) => {
  const { actorType, actorId, timerName } = c.req.param();
  if (!actorRuntime) return c.json({ error: "Actor runtime not initialized" }, 500);
  await actorRuntime.timer(actorType, actorId, timerName);
  return c.json({ ok: true });
});

// Reminder callback
app.put("/actors/:actorType/:actorId/method/remind/:reminderName", async (c) => {
  const { actorType, actorId, reminderName } = c.req.param();
  if (!actorRuntime) return c.json({ error: "Actor runtime not initialized" }, 500);
  let body: unknown;
  try { body = await c.req.json(); } catch { body = undefined; }
  await actorRuntime.reminder(actorType, actorId, reminderName, body);
  return c.json({ ok: true });
});
```

**Step 4: Initialize actor runtime in start()**

In the `start()` function (around line 576), after memory initialization and before registry registration, add:

```typescript
  // Initialize actor runtime
  const archPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

  setActorDeps({
    pool: archPool,
    model: LLM_MODEL,
    searchUrl: process.env.SEARCH_API_URL || "",
    searchKey: process.env.SEARCH_API_KEY || "",
    handleConsultation: handleConsultation,
    tracedChatCompletion: (opts, trace) => tracedChatCompletion(opts, trace as any),
    memoryStore: memory ? (msgs, userId, meta) => memory!.store(msgs, userId, meta) : null,
    memorySearch: memory ? (query, userId, limit) => memory!.search(query, userId, limit) : null,
  });

  actorRuntime = new ActorRuntime(
    ARCHITECT_ACTOR_TYPE,
    (actorType, actorId) => new ArchitectActor(actorType, actorId),
  );
  console.log(`[${AGENT_ID}] Actor runtime initialized for ${ARCHITECT_ACTOR_TYPE}`);
```

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/architect-agent typecheck`
Expected: No type errors.

**Step 6: Commit**

```bash
git add apps/architect-agent/src/index.ts
git commit -m "wire actor runtime and Dapr actor HTTP routes into architect agent"
```

---

### Task 6: K8s Configuration for Architect Actor

**Files:**
- Modify: `k8s/base/architect-agent/deployment.yaml`
- Modify: `k8s/base/dapr-components/statestore-actor-redis.yaml`

**Step 1: Add actor annotations to deployment**

In `k8s/base/architect-agent/deployment.yaml`, add to the `annotations` block under `template.metadata` (after line with `dapr.io/metrics-port`):

```yaml
        dapr.io/actor-types: "ArchitectActor"
        dapr.io/actor-idle-timeout: "60m"
        dapr.io/actor-scan-interval: "30s"
```

Add environment variables for search API (after the Grafana section):

```yaml
            # Search API for architect web search tool
            - name: SEARCH_API_URL
              value: ""
            - name: SEARCH_API_KEY
              value: ""
```

**Step 2: Extend actor statestore scope**

In `k8s/base/dapr-components/statestore-actor-redis.yaml`, change:

```yaml
  scopes:
    - llm-service
```

to:

```yaml
  scopes:
    - llm-service
    - architect-agent
```

**Step 3: Commit**

```bash
git add k8s/base/architect-agent/deployment.yaml k8s/base/dapr-components/statestore-actor-redis.yaml
git commit -m "add actor annotations and statestore scope for architect agent"
```

---

## Phase 3: Event-Driven Workflow

### Task 7: New Workflow Activity Types and Stubs

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:37-449` (add new type definitions and stubs)

**Step 1: Add new activity input/output types**

Add after `AttemptAutoResolveOutput` (line 297) in `workflow.ts`:

```typescript
// ---------------------------------------------------------------------------
// New activity types for event-driven workflow + architect actor
// ---------------------------------------------------------------------------

export interface ComplexityGateInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
}

export interface ComplexityGateOutput {
  simple: boolean;
}

export interface StartSessionInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  implementationPrompt: string;
  branch: string;
}

export interface StartSessionOutput {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface ConsultArchitectActorInput {
  actorId: string;
  questionText: string;
  source: string;
}

export interface ConsultArchitectActorOutput {
  confident: boolean;
  answer?: string;
  bestGuess?: string;
}

export interface InjectAnswerInput {
  implementerActorId: string;
  answerText: string;
}

export interface InjectAnswerOutput {
  ok: boolean;
  error?: string;
}

export interface NotifyHumanQuestionInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  questionText: string;
  architectBestGuess?: string;
}

export interface ProcessHumanAnswerInput {
  architectActorId: string;
  questionText: string;
  humanAnswer: string;
}

export interface InitializeArchitectActorInput {
  actorId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  projectItemId: string;
  issueTitle: string;
}
```

**Step 2: Add activity stub variables**

Add after `attemptAutoResolveActivity` stub (line 449):

```typescript
export let complexityGateActivity: ActivityFn<
  ComplexityGateInput,
  ComplexityGateOutput
> = async () => {
  throw new Error("complexityGateActivity not initialized");
};

export let startSessionActivity: ActivityFn<
  StartSessionInput,
  StartSessionOutput
> = async () => {
  throw new Error("startSessionActivity not initialized");
};

export let consultArchitectActorActivity: ActivityFn<
  ConsultArchitectActorInput,
  ConsultArchitectActorOutput
> = async () => {
  throw new Error("consultArchitectActorActivity not initialized");
};

export let injectAnswerActivity: ActivityFn<
  InjectAnswerInput,
  InjectAnswerOutput
> = async () => {
  throw new Error("injectAnswerActivity not initialized");
};

export let notifyHumanQuestionActivity: ActivityFn<
  NotifyHumanQuestionInput,
  void
> = async () => {
  throw new Error("notifyHumanQuestionActivity not initialized");
};

export let processHumanAnswerActivity: ActivityFn<
  ProcessHumanAnswerInput,
  void
> = async () => {
  throw new Error("processHumanAnswerActivity not initialized");
};

export let initializeArchitectActorActivity: ActivityFn<
  InitializeArchitectActorInput,
  void
> = async () => {
  throw new Error("initializeArchitectActorActivity not initialized");
};
```

**Step 3: Add to WorkflowActivityImplementations interface**

Add to the interface (after line 1033):

```typescript
  complexityGate: typeof complexityGateActivity;
  startSession: typeof startSessionActivity;
  consultArchitectActor: typeof consultArchitectActorActivity;
  injectAnswer: typeof injectAnswerActivity;
  notifyHumanQuestion: typeof notifyHumanQuestionActivity;
  processHumanAnswer: typeof processHumanAnswerActivity;
  initializeArchitectActor: typeof initializeArchitectActorActivity;
```

**Step 4: Wire in createWorkflowRuntime**

Add after `attemptAutoResolveActivity` assignment in `createWorkflowRuntime()` (line 1065):

```typescript
  complexityGateActivity = activityImpls.complexityGate;
  startSessionActivity = activityImpls.startSession;
  consultArchitectActorActivity = activityImpls.consultArchitectActor;
  injectAnswerActivity = activityImpls.injectAnswer;
  notifyHumanQuestionActivity = activityImpls.notifyHumanQuestion;
  processHumanAnswerActivity = activityImpls.processHumanAnswer;
  initializeArchitectActorActivity = activityImpls.initializeArchitectActor;
```

Add registrations after `attemptAutoResolveActivity` registration (line 1097):

```typescript
  runtime.registerActivity(complexityGateActivity);
  runtime.registerActivity(startSessionActivity);
  runtime.registerActivity(consultArchitectActorActivity);
  runtime.registerActivity(injectAnswerActivity);
  runtime.registerActivity(notifyHumanQuestionActivity);
  runtime.registerActivity(processHumanAnswerActivity);
  runtime.registerActivity(initializeArchitectActorActivity);
```

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: Errors about missing implementations in `index.ts` (expected — we add those in Task 9).

**Step 6: Commit**

```bash
git add apps/project-manager/src/workflow.ts
git commit -m "add new activity types and stubs for event-driven workflow"
```

---

### Task 8: Replace Workflow PLANNING Phase with waitForExternalEvent

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:544-665` (PLANNING phase)

**Step 1: Rewrite the PLANNING phase**

Replace the entire PLANNING section (lines 544-665) with:

```typescript
  // =====================================================================
  // PLANNING phase (card is in Planning)
  // =====================================================================

  // Load retry budget from database (persists across pod restarts)
  const retryBudget: LoadRetryBudgetOutput = yield ctx.callActivity(
    loadRetryBudgetActivity,
    { workflowId }
  );
  const maxCycles = input.retryBudget ?? retryBudget.retryBudget;

  // Complexity gate — check if issue is tagged "simple"
  const gate: ComplexityGateOutput = yield ctx.callActivity(
    complexityGateActivity,
    { issueNumber, repoOwner, repoName }
  );

  if (gate.simple) {
    console.log(`[Workflow] Issue #${issueNumber} is simple, skipping Opus planning`);
    // Skip planning — architect guidance from INTAKE is the plan
    yield ctx.callActivity(recordPendingMoveActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
    yield ctx.callActivity(moveCardActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
  } else {
    // Initialize architect actor for this issue
    const architectActorId = `${repoOwner}/${repoName}/${issueNumber}`;
    yield ctx.callActivity(initializeArchitectActorActivity, {
      actorId: architectActorId,
      issueNumber,
      repoOwner,
      repoName,
      workflowId,
      projectItemId,
      issueTitle,
    });

    // Start planning session via ImplementerActor
    const planSession: StartSessionOutput = yield ctx.callActivity(
      startSessionActivity,
      {
        issueNumber,
        repoOwner,
        repoName,
        workflowId,
        implementationPrompt: `Plan the implementation for issue #${issueNumber}: ${issueTitle}\n\nArchitect guidance:\n${architectResult.guidance}`,
        branch: `issue-${issueNumber}`,
      }
    );

    if (!planSession.ok) {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Planning session failed to start: ${planSession.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    // Event-driven planning loop
    let totalPlanCycles = retryBudget.planCyclesUsed;
    let planApproved = false;

    while (totalPlanCycles < maxCycles && !planApproved) {
      totalPlanCycles++;
      console.log(
        `[Workflow] Planning cycle ${totalPlanCycles}/${maxCycles} for issue #${issueNumber}`
      );

      // Wait for external event from SessionMonitor
      const planEvent: PlanningEventPayload = yield ctx.waitForExternalEvent("planning-event");

      if (planEvent.type === "session-failed") {
        yield ctx.callActivity(moveToFailedActivity, {
          issueNumber, repoOwner, repoName, projectItemId, workflowId,
          reason: `Planning session failed: ${planEvent.error}`,
        });
        return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
      }

      if (planEvent.type === "question-detected") {
        // Route question through architect actor
        const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
          consultArchitectActorActivity,
          {
            actorId: architectActorId,
            questionText: planEvent.questionText,
            source: "planning",
          }
        );

        if (archAnswer.confident) {
          // Inject answer back into Claude CLI session
          yield ctx.callActivity(injectAnswerActivity, {
            implementerActorId: `${repoOwner}-${repoName}-${issueNumber}`,
            answerText: archAnswer.answer!,
          });
        } else {
          // Escalate to human via ntfy
          yield ctx.callActivity(notifyHumanQuestionActivity, {
            issueNumber, repoOwner, repoName, workflowId,
            questionText: planEvent.questionText,
            architectBestGuess: archAnswer.bestGuess,
          });

          // Wait for human answer via ntfy reply webhook
          const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");

          // Process human answer through architect for Mem0 learning
          yield ctx.callActivity(processHumanAnswerActivity, {
            architectActorId,
            questionText: planEvent.questionText,
            humanAnswer: humanAnswer.answer,
          });

          // Inject human answer into Claude CLI session
          yield ctx.callActivity(injectAnswerActivity, {
            implementerActorId: `${repoOwner}-${repoName}-${issueNumber}`,
            answerText: humanAnswer.answer,
          });
        }

        // Loop back to wait for next event
        continue;
      }

      if (planEvent.type === "plan-complete") {
        // Review the plan via LLM
        const planReview: ReviewPlanOutput = yield ctx.callActivity(
          reviewPlanActivity,
          {
            issueNumber,
            repoOwner,
            repoName,
            planContent: planEvent.planContent,
          }
        );

        if (planReview.approved) {
          planApproved = true;
          console.log(`[Workflow] Plan approved for issue #${issueNumber}`);
        } else {
          yield ctx.callActivity(addCommentActivity, {
            issueNumber, repoOwner, repoName,
            body: `**Plan Review — Revision Needed** (confidence: ${(planReview.confidence * 100).toFixed(0)}%)\n\n${planReview.feedback}`,
          });
          yield ctx.callActivity(incrementRetryCycleActivity, {
            workflowId,
            phase: "planning",
            failureReason: planReview.feedback,
          });
          console.log(`[Workflow] Plan rejected for issue #${issueNumber}, cycle ${totalPlanCycles}`);
        }
      }
    }

    if (!planApproved) {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Plan not approved after ${maxCycles} revision cycles`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    // Plan approved -> move to In Progress
    yield ctx.callActivity(recordPendingMoveActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
    yield ctx.callActivity(moveCardActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
  }

  console.log(`[Workflow] Issue #${issueNumber} moved to In Progress`);
```

**Step 2: Add required import**

Add to the imports at the top of `workflow.ts`:

```typescript
import type {
  PlanningEventPayload,
  ImplEventPayload,
  QaEventPayload,
  HumanAnswerPayload,
} from "@mesh-six/core";
```

**Step 3: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: Possible errors from missing implementations in index.ts — that's expected.

**Step 4: Commit**

```bash
git add apps/project-manager/src/workflow.ts
git commit -m "replace PLANNING polling with waitForExternalEvent and question loop"
```

---

### Task 9: Replace IMPLEMENTATION and QA Phases with waitForExternalEvent

**Files:**
- Modify: `apps/project-manager/src/workflow.ts:680-882` (IMPLEMENTATION + QA phases)

**Step 1: Rewrite IMPLEMENTATION phase**

Replace lines 680-743 (IMPLEMENTATION section) with:

```typescript
  // =====================================================================
  // IMPLEMENTATION phase (card is in In Progress)
  // =====================================================================

  const architectActorIdImpl = `${repoOwner}/${repoName}/${issueNumber}`;
  const implActorId = `${repoOwner}-${repoName}-${issueNumber}`;
  let implComplete = false;
  let prNumber: number | null = null;

  while (!implComplete) {
    const implEvent: ImplEventPayload = yield ctx.waitForExternalEvent("impl-event");

    if (implEvent.type === "session-failed") {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Implementation session failed: ${implEvent.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    if (implEvent.type === "question-detected") {
      const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
        consultArchitectActorActivity,
        { actorId: architectActorIdImpl, questionText: implEvent.questionText, source: "implementation" }
      );

      if (archAnswer.confident) {
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: archAnswer.answer!,
        });
      } else {
        yield ctx.callActivity(notifyHumanQuestionActivity, {
          issueNumber, repoOwner, repoName, workflowId,
          questionText: implEvent.questionText,
          architectBestGuess: archAnswer.bestGuess,
        });
        const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");
        yield ctx.callActivity(processHumanAnswerActivity, {
          architectActorId: architectActorIdImpl,
          questionText: implEvent.questionText,
          humanAnswer: humanAnswer.answer,
        });
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: humanAnswer.answer,
        });
      }
      continue;
    }

    if (implEvent.type === "pr-created") {
      prNumber = implEvent.prNumber;
      implComplete = true;
      console.log(`[Workflow] PR #${prNumber} created for issue #${issueNumber}`);
    }
  }

  // Move to QA
  yield ctx.callActivity(recordPendingMoveActivity, {
    projectItemId,
    toColumn: "QA",
  });
  yield ctx.callActivity(moveCardActivity, {
    projectItemId,
    toColumn: "QA",
  });

  console.log(`[Workflow] Issue #${issueNumber} moved to QA`);
```

**Step 2: Rewrite QA phase**

Replace lines 747-882 (QA section) with:

```typescript
  // =====================================================================
  // QA phase (card is in QA)
  // =====================================================================

  let qaCycles = retryBudget.qaCyclesUsed;
  let qaPassedFinal = false;

  while (qaCycles < maxCycles && !qaPassedFinal) {
    qaCycles++;
    console.log(
      `[Workflow] QA cycle ${qaCycles}/${maxCycles} for issue #${issueNumber}`
    );

    const qaEvent: QaEventPayload = yield ctx.waitForExternalEvent("qa-event");

    if (qaEvent.type === "session-failed") {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `QA session failed: ${qaEvent.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    if (qaEvent.type === "question-detected") {
      const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
        consultArchitectActorActivity,
        { actorId: architectActorIdImpl, questionText: qaEvent.questionText, source: "qa" }
      );

      if (archAnswer.confident) {
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: archAnswer.answer!,
        });
      } else {
        yield ctx.callActivity(notifyHumanQuestionActivity, {
          issueNumber, repoOwner, repoName, workflowId,
          questionText: qaEvent.questionText,
          architectBestGuess: archAnswer.bestGuess,
        });
        const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");
        yield ctx.callActivity(processHumanAnswerActivity, {
          architectActorId: architectActorIdImpl,
          questionText: qaEvent.questionText,
          humanAnswer: humanAnswer.answer,
        });
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: humanAnswer.answer,
        });
      }
      continue;
    }

    if (qaEvent.type === "test-results") {
      const testEval: EvaluateTestResultsOutput = yield ctx.callActivity(
        evaluateTestResultsActivity,
        { issueNumber, repoOwner, repoName, testContent: qaEvent.testContent }
      );

      if (testEval.passed) {
        qaPassedFinal = true;
        console.log(`[Workflow] Tests passed for issue #${issueNumber}`);
      } else {
        yield ctx.callActivity(createBugIssueActivity, {
          repoOwner, repoName,
          parentIssueNumber: issueNumber,
          failures: testEval.failures,
        });
        yield ctx.callActivity(incrementRetryCycleActivity, {
          workflowId,
          phase: "qa",
          failureReason: testEval.failures.join("; "),
        });
        console.log(
          `[Workflow] Tests failed for issue #${issueNumber}, cycle ${qaCycles}`
        );
      }
    }
  }

  if (!qaPassedFinal) {
    yield ctx.callActivity(moveToFailedActivity, {
      issueNumber, repoOwner, repoName, projectItemId, workflowId,
      reason: `Tests did not pass after ${maxCycles} QA cycles`,
    });
    return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
  }
```

**Step 3: Update the final return to use the scoped prNumber**

In the ACCEPTED section at the bottom of the workflow (around line 998-1004), update:

```typescript
  return {
    issueNumber,
    repoOwner,
    repoName,
    finalPhase: "ACCEPTED" as WorkflowPhase,
    prNumber: prNumber ?? undefined,
  } satisfies ProjectWorkflowResult;
```

**Step 4: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: Errors from missing activity implementations in index.ts (expected).

**Step 5: Commit**

```bash
git add apps/project-manager/src/workflow.ts
git commit -m "replace IMPLEMENTATION and QA polling with waitForExternalEvent"
```

---

### Task 10: PM Activity Implementations for New Activities

**Files:**
- Modify: `apps/project-manager/src/index.ts:1440-1837` (activity implementations object)

**Step 1: Add new activity implementations**

Add to the `activityImplementations` object (before the closing `};` on line 1837):

```typescript
      complexityGate: async (_ctx, input) => {
        if (!github) return { simple: false };
        try {
          const { data } = await github.issues.get({
            owner: input.repoOwner,
            repo: input.repoName,
            issue_number: input.issueNumber,
          });
          const labels = data.labels.map((l) =>
            typeof l === "string" ? l : l.name || ""
          );
          return { simple: labels.includes("simple") };
        } catch (err) {
          console.warn(`[${AGENT_ID}] Failed to check issue labels:`, err);
          return { simple: false };
        }
      },

      startSession: async (_ctx, input) => {
        // Invoke ImplementerActor via Dapr actor invocation
        const implementerActorId = `${input.repoOwner}-${input.repoName}-${input.issueNumber}`;
        const activateUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ImplementerActor/${implementerActorId}/method/onActivate`;
        const activateRes = await fetch(activateUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: crypto.randomUUID(),
            issueNumber: input.issueNumber,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            branch: input.branch,
            workflowId: input.workflowId,
          }),
        });
        if (!activateRes.ok) {
          const text = await activateRes.text();
          return { sessionId: "", ok: false, error: `Actor activation failed: ${text}` };
        }
        const activateResult = await activateRes.json() as { ok: boolean; error?: string };
        if (!activateResult.ok) {
          return { sessionId: "", ok: false, error: activateResult.error };
        }

        // Start the session
        const startUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ImplementerActor/${implementerActorId}/method/startSession`;
        const startRes = await fetch(startUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ implementationPrompt: input.implementationPrompt }),
        });
        if (!startRes.ok) {
          const text = await startRes.text();
          return { sessionId: "", ok: false, error: `Session start failed: ${text}` };
        }
        const startResult = await startRes.json() as { ok: boolean; error?: string };
        return { sessionId: implementerActorId, ok: startResult.ok, error: startResult.error };
      },

      consultArchitectActor: async (_ctx, input) => {
        const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ArchitectActor/${input.actorId}/method/answerQuestion`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionText: input.questionText, source: input.source }),
        });
        if (!res.ok) {
          console.warn(`[${AGENT_ID}] Architect actor invocation failed: ${res.status}`);
          return { confident: false, bestGuess: "Architect actor unavailable" };
        }
        return await res.json() as ConsultArchitectActorOutput;
      },

      injectAnswer: async (_ctx, input) => {
        const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ImplementerActor/${input.implementerActorId}/method/injectAnswer`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answerText: input.answerText }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: `Inject answer failed: ${text}` };
        }
        return await res.json() as InjectAnswerOutput;
      },

      notifyHumanQuestion: async (_ctx, input) => {
        const message = input.architectBestGuess
          ? `${input.questionText}\n\nArchitect best guess: ${input.architectBestGuess}`
          : input.questionText;

        await fetch("https://ntfy.bto.bar/mesh-six-pm", {
          method: "POST",
          headers: {
            "Title": `Issue #${input.issueNumber} needs your input`,
            "Tags": "question",
            "X-Workflow-Id": input.workflowId,
            "X-Issue-Number": String(input.issueNumber),
          },
          body: message,
        }).catch((e) => console.warn(`[${AGENT_ID}] ntfy notification failed:`, e));
      },

      processHumanAnswer: async (_ctx, input) => {
        const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ArchitectActor/${input.architectActorId}/method/receiveHumanAnswer`;
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionText: input.questionText, humanAnswer: input.humanAnswer }),
        }).catch((e) => console.warn(`[${AGENT_ID}] Process human answer failed:`, e));
      },

      initializeArchitectActor: async (_ctx, input) => {
        const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/actors/ArchitectActor/${input.actorId}/method/initialize`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issueNumber: input.issueNumber,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            workflowId: input.workflowId,
            projectItemId: input.projectItemId,
            issueTitle: input.issueTitle,
          }),
        });
        if (!res.ok) {
          console.warn(`[${AGENT_ID}] Architect actor initialization failed: ${res.status}`);
        }
      },
```

**Step 2: Add missing type imports**

At the top of `index.ts`, add to the workflow imports (line 38):

```typescript
import {
  createWorkflowRuntime,
  createWorkflowClient,
  startProjectWorkflow,
  getProjectWorkflowStatus,
  raiseWorkflowEvent,
  type ProjectWorkflowInput,
  type WorkflowActivityImplementations,
  type ConsultArchitectActorOutput,
  type InjectAnswerOutput,
} from "./workflow.js";
```

Remove `pollGithubForCompletion` from the import since it will be removed in the cleanup phase.

**Step 3: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS (or minor fixable errors).

**Step 4: Commit**

```bash
git add apps/project-manager/src/index.ts
git commit -m "add activity implementations for event-driven workflow and actor invocations"
```

---

## Phase 4: Implementer Changes

### Task 11: Add workflowId to ImplementerActor and injectAnswer Method

**Files:**
- Modify: `apps/implementer/src/actor.ts:45-56` (ActorState interface)
- Modify: `apps/implementer/src/actor.ts` (add injectAnswer method)
- Modify: `apps/implementer/src/index.ts:119-139` (add method to actor routes)

**Step 1: Add workflowId to ActorState**

In `apps/implementer/src/actor.ts`, add `workflowId` to the `ActorState` interface (after line 55):

```typescript
export interface ActorState {
  sessionId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  tmuxSessionName: string;
  worktreeDir: string;
  credentialBundleId?: string;
  status: ImplementationSession["status"];
  startedAt?: string;
  workflowId?: string;          // NEW: used by SessionMonitor to raise events
  answerInjected?: boolean;      // NEW: flag for monitor to reset questionDetected
}
```

**Step 2: Accept workflowId in onActivate params**

Update the `onActivate` method params type (around line 78):

```typescript
  async onActivate(params: {
    sessionId: string;
    issueNumber: number;
    repoOwner: string;
    repoName: string;
    branch: string;
    workflowId?: string;   // NEW
  }): Promise<{ ok: boolean; error?: string }> {
```

Set it in the state assignment (around line 107):

```typescript
    this.state = {
      sessionId: params.sessionId,
      issueNumber: params.issueNumber,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      tmuxSessionName,
      worktreeDir,
      credentialBundleId: bundleId,
      status: "idle",
      workflowId: params.workflowId,
    };
```

**Step 3: Add injectAnswer method**

Add after the `getStatus()` method (around line 170):

```typescript
  /**
   * Inject an answer text into the running Claude CLI session via tmux send-keys.
   * Called by PM workflow when architect or human provides an answer.
   */
  async injectAnswer(params: {
    answerText: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) return { ok: false, error: "Actor not activated" };

    const { tmuxSessionName, sessionId } = this.state;
    const escapedAnswer = params.answerText.replace(/'/g, "'\\''");

    try {
      await sendCommand(tmuxSessionName, escapedAnswer);
      this.state.answerInjected = true;

      await insertActivityLog({
        sessionId,
        eventType: "answer_injected",
        detailsJson: { answer: params.answerText.substring(0, 200) },
      });

      log(`Answer injected into session ${tmuxSessionName}`);
      return { ok: true };
    } catch (err) {
      log(`Failed to inject answer: ${err}`);
      return { ok: false, error: String(err) };
    }
  }
```

**Step 4: Wire injectAnswer into actor routes**

In `apps/implementer/src/index.ts`, add the `injectAnswer` case to the actor method switch (around line 129):

```typescript
      case "injectAnswer": {
        const p = body as Parameters<typeof actor.injectAnswer>[0];
        const result = await actor.injectAnswer(p);
        return c.json(result);
      }
```

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/implementer typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/implementer/src/actor.ts apps/implementer/src/index.ts
git commit -m "add workflowId to ImplementerActor and injectAnswer method"
```

---

### Task 12: Update SessionMonitor to Raise Events on Workflow

**Files:**
- Modify: `apps/implementer/src/monitor.ts` (replace pub/sub with raiseEvent, add detection reset)

**Step 1: Replace SESSION_BLOCKED_TOPIC import with HTTP fetch**

In `apps/implementer/src/monitor.ts`, remove `SESSION_BLOCKED_TOPIC` from the import (line 6):

```typescript
import {
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  AUTH_SERVICE_APP_ID,
  detectAuthFailure,
  type TaskResult,
} from "@mesh-six/core";
```

**Step 2: Replace question detection pub/sub with raiseEvent**

Replace the question detection block (around lines 120-148) with:

```typescript
    // --- Question detection ---
    if (!this.questionDetected) {
      // Check if a previous answer was injected — reset if so
      if (this.ctx.actorState.answerInjected) {
        this.ctx.actorState.answerInjected = false;
      }

      const questionMatch = QUESTION_PATTERN.exec(paneText);
      if (questionMatch) {
        const questionText = questionMatch[1].trim();
        log(`Question detected in session ${sessionId}: ${questionText}`);
        this.questionDetected = true;

        await updateSessionStatus(sessionId, "blocked");
        const question = await insertQuestion({ sessionId, questionText });

        await insertActivityLog({
          sessionId,
          eventType: "question_detected",
          detailsJson: { questionId: question.id, questionText },
        });

        // Raise event on workflow instance via Dapr HTTP API
        const { workflowId } = actorState;
        if (workflowId) {
          const eventChannel = this.getEventChannel();
          const eventUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${workflowId}/raiseEvent/${eventChannel}`;
          await fetch(eventUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "question-detected",
              questionText,
              sessionId,
            }),
          }).catch((err) => log(`Failed to raise event on workflow ${workflowId}: ${err}`));

          log(`Raised ${eventChannel} event on workflow ${workflowId}`);
        } else {
          log(`No workflowId — falling back to pub/sub for session ${sessionId}`);
          await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, "session-blocked", {
            sessionId, taskId, questionId: question.id, questionText,
            issueNumber: actorState.issueNumber,
            repoOwner: actorState.repoOwner,
            repoName: actorState.repoName,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
    } else if (this.ctx.actorState.answerInjected) {
      // Answer was injected, reset question detection for next question
      this.questionDetected = false;
      this.ctx.actorState.answerInjected = false;
      await updateSessionStatus(sessionId, "running");
      log(`Question detection reset after answer injection for session ${sessionId}`);
    }
```

**Step 3: Add event channel helper method**

Add to the `SessionMonitor` class:

```typescript
  /**
   * Determine the event channel name based on what kind of session this is.
   * The PM workflow listens on different channels per phase.
   */
  private getEventChannel(): string {
    // Default to planning-event. The channel can be overridden via context
    // if we add a "phase" field to MonitorContext in the future.
    return "planning-event";
  }
```

**Step 4: Update completion handler to raise events**

In the `handleCompletion` method, add workflow event raising before the pub/sub publish. After `await insertActivityLog(...)` and before the `TaskResult` construction:

```typescript
    // Raise completion/failure event on workflow
    const { workflowId } = this.ctx.actorState;
    if (workflowId) {
      const eventChannel = this.getEventChannel();
      const eventUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${workflowId}/raiseEvent/${eventChannel}`;
      await fetch(eventUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          success
            ? { type: "plan-complete", planContent: "" }
            : { type: "session-failed", error: errorMessage || "Session failed" }
        ),
      }).catch((err) => log(`Failed to raise completion event: ${err}`));
    }
```

**Step 5: Typecheck**

Run: `bun run --filter @mesh-six/implementer typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/implementer/src/monitor.ts
git commit -m "replace SESSION_BLOCKED_TOPIC publish with raiseEvent on workflow instance"
```

---

## Phase 5: ntfy Webhook

### Task 13: Add ntfy Reply Webhook Handler to PM

**Files:**
- Modify: `apps/project-manager/src/index.ts` (add POST /ntfy/reply route)

**Step 1: Add the webhook endpoint**

Add after the board events handler (search for a good insertion point in the Hono routes section, before the workflow runtime initialization). Add near the other `app.post` routes:

```typescript
// ---------------------------------------------------------------------------
// ntfy reply webhook — receives human answers forwarded from ntfy
// ---------------------------------------------------------------------------
app.post("/ntfy/reply", async (c) => {
  try {
    const body = await c.req.json();

    // ntfy forwards replies with the original message's extras (custom headers)
    const workflowId = body.extras?.["X-Workflow-Id"] || body.extras?.["x-workflow-id"];
    const answerText = body.message || body.text || "";

    if (!workflowId || !answerText) {
      console.warn(`[${AGENT_ID}] ntfy reply missing workflowId or answer`);
      return c.json({ ok: false, error: "Missing workflowId or answer" }, 400);
    }

    console.log(`[${AGENT_ID}] ntfy reply received for workflow ${workflowId}: "${answerText.substring(0, 100)}"`);

    if (workflowClient) {
      await workflowClient.raiseEvent(workflowId, "human-answer", {
        answer: answerText,
        timestamp: new Date().toISOString(),
      });
      console.log(`[${AGENT_ID}] Raised human-answer event on workflow ${workflowId}`);
    } else {
      console.warn(`[${AGENT_ID}] Workflow client not available — cannot raise event`);
      return c.json({ ok: false, error: "Workflow client unavailable" }, 503);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error(`[${AGENT_ID}] ntfy reply handler error:`, err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});
```

**Step 2: Typecheck**

Run: `bun run --filter @mesh-six/project-manager typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add apps/project-manager/src/index.ts
git commit -m "add ntfy reply webhook handler for human answer flow"
```

---

## Phase 6: Cleanup

### Task 14: Remove Old Polling Code and SESSION_BLOCKED_TOPIC

**Files:**
- Modify: `apps/project-manager/src/workflow.ts` (remove `pollGithubForCompletion`, old poll stubs)
- Modify: `apps/project-manager/src/index.ts` (remove old poll implementations, `pollGithubForCompletion` import)
- Modify: `packages/core/src/types.ts` (remove `SESSION_BLOCKED_TOPIC` export)
- Modify: `packages/core/src/index.ts` (remove `SESSION_BLOCKED_TOPIC` re-export)

**Step 1: Remove `pollGithubForCompletion` from workflow.ts**

Delete lines 1187-1223 (the `pollGithubForCompletion` function) from `workflow.ts`.

**Step 2: Remove old polling activity stubs from workflow.ts**

Remove these stub variables:
- `pollForPlanActivity` (lines 342-347)
- `pollForImplementationActivity` (lines 361-366)
- `pollForTestResultsActivity` (lines 368-373)

Remove their type definitions:
- `PollForPlanInput`, `PollForPlanOutput` (lines 104-116)
- `PollForImplementationInput`, `PollForImplementationOutput` (lines 138-150)
- `PollForTestResultsInput`, `PollForTestResultsOutput` (lines 152-164)

Remove from `WorkflowActivityImplementations`:
- `pollForPlan`
- `pollForImplementation`
- `pollForTestResults`

Remove from `createWorkflowRuntime`:
- Their stub assignments
- Their `runtime.registerActivity()` calls

Also remove `attemptAutoResolveActivity` and its type, as it's replaced by the architect actor flow.

**Step 3: Remove old polling implementations from index.ts**

Remove these activity implementations from the `activityImplementations` object:
- `pollForPlan` (lines 1477-1497)
- `pollForImplementation` (lines 1519-1534)
- `pollForTestResults` (lines 1536-1554)
- `attemptAutoResolve` (lines 1704-1836)

Remove the `pollGithubForCompletion` import from the workflow import line.

**Step 4: Remove SESSION_BLOCKED_TOPIC**

In `packages/core/src/types.ts`, remove:
```typescript
export const SESSION_BLOCKED_TOPIC = "session-blocked";
```

In `packages/core/src/index.ts`, remove `SESSION_BLOCKED_TOPIC` from the re-exports.

**Step 5: Run full typecheck**

Run: `bun run typecheck`
Expected: All packages pass. Fix any remaining references to removed items.

**Step 6: Run tests**

Run: `bun run test`
Expected: All tests pass. Fix any tests that reference removed items.

**Step 7: Commit**

```bash
git add -A
git commit -m "remove polling activities, pollGithubForCompletion, and SESSION_BLOCKED_TOPIC"
```

---

### Task 15: Final Integration Typecheck and Version Bump

**Files:**
- Modify: `packages/core/package.json` (bump version)
- Modify: `apps/project-manager/package.json` (bump version)
- Modify: `apps/architect-agent/package.json` (bump version)
- Modify: `apps/implementer/package.json` (bump version)
- Modify: `CHANGELOG.md`

**Step 1: Run full build and typecheck**

Run: `bun run build && bun run typecheck`
Expected: No errors.

**Step 2: Run full test suite**

Run: `bun run test`
Expected: All tests pass.

**Step 3: Bump versions**

- `packages/core/package.json`: bump minor version
- `apps/project-manager/package.json`: bump minor version
- `apps/architect-agent/package.json`: bump minor version
- `apps/implementer/package.json`: bump minor version

**Step 4: Update CHANGELOG.md**

Add an entry covering:
- Architect agent converted to Dapr Actor with per-issue instances and PG event log
- Workflow polling replaced with `waitForExternalEvent` across PLANNING, IMPLEMENTATION, QA
- Question resolution loop: architect auto-answer + human escalation via ntfy
- Label-based complexity gate (`simple` label skips Opus planning)
- SessionMonitor raises typed events on workflow instances via Dapr HTTP API
- Implementer `injectAnswer` method for feeding answers into Claude CLI sessions
- New core types: `PlanningEventPayload`, `ImplEventPayload`, `QaEventPayload`, `HumanAnswerPayload`
- Removed `pollGithubForCompletion`, `SESSION_BLOCKED_TOPIC`

**Step 5: Commit**

```bash
git add -A
git commit -m "bump versions and update CHANGELOG for GWA migration"
```

---

## Task Dependency Graph

```
Task 1 (migration) ──────────────────┐
Task 2 (core types) ─────────────────┤
                                      ├── Task 4 (ArchitectActor class)
Task 3 (event-db) ───────────────────┘         │
                                                │
                                     Task 5 (wire actor into service)
                                                │
                                     Task 6 (k8s config)
                                                │
Task 7 (new workflow types) ────────────────────┤
                                                │
Task 8 (PLANNING waitForExternalEvent) ─────────┤
                                                │
Task 9 (IMPL + QA waitForExternalEvent) ────────┤
                                                │
Task 10 (PM activity impls) ────────────────────┤
                                                │
Task 11 (implementer injectAnswer) ─────────────┤
                                                │
Task 12 (SessionMonitor raiseEvent) ────────────┤
                                                │
Task 13 (ntfy webhook) ────────────────────────┤
                                                │
Task 14 (cleanup) ─────────────────────────────┤
                                                │
Task 15 (version bump + changelog) ────────────┘
```

**Parallel-safe groups:**
- Tasks 1, 2, 3 can run in parallel (no dependencies)
- Task 4 depends on Tasks 1, 2, 3
- Tasks 7, 11, 12 can run in parallel (different files)
- Task 10 depends on Tasks 7, 8, 9
- Task 14 depends on all other tasks
- Task 15 is always last
