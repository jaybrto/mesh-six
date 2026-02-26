# GWA Migration Design: Event-Driven Workflow + Architect Actor

**Goal:** Replace the polling-based, stateless workflow architecture with an event-driven, actor-based design that supports interactive question resolution during Claude CLI planning sessions.

**Motivation:** The current PM workflow polls GitHub APIs every 15 seconds across 4 phases, wasting resources while waiting. When the Claude CLI (with superpowers plugin) asks clarifying questions during planning, there's no mechanism to detect, route, answer, and inject responses back into the session. The architect agent is stateless and loses context between invocations for the same issue.

---

## Architecture Overview

```
                        GitHub Projects Board
                               |
                        webhook events
                               |
                               v
                     +------------------+
                     | Webhook Receiver  | (unchanged)
                     +--------+---------+
                              | board-events topic
                              v
+----------------------------------------------------------+
|                    PROJECT MANAGER                         |
|                                                           |
|  Dapr Workflow Instance (per issue)                       |
|  +-----------------------------------------------------+ |
|  |                                                     | |
|  |  INTAKE -> complexity gate -+-> simple -> IN_PROGRESS| |
|  |                             |                       | |
|  |                         complex                     | |
|  |                             |                       | |
|  |                       PLANNING                      | |
|  |                  waitForExternalEvent                | |
|  |                  ("planning-event")                  | |
|  |                        |                            | |
|  |            +-----------+-----------+                | |
|  |       question    plan-complete  timeout             | |
|  |            |           |           |                | |
|  |   callActivity     proceed     notify               | |
|  |   (consultArch.   to review                         | |
|  |     Actor)                                          | |
|  |            |                                        | |
|  |   +-------+--------+                               | |
|  |  confident    not confident                         | |
|  |   |              |                                  | |
|  |  inject      notifyHuman                            | |
|  |  Answer      waitForExternalEvent("human-answer")   | |
|  |   |              |                                  | |
|  |   |         processHumanAnswer -> injectAnswer      | |
|  |   +------+-------+                                 | |
|  |          |                                          | |
|  |     loop back to waitForExternalEvent               | |
|  |                                                     | |
|  |  IMPLEMENTATION / QA / REVIEW (same pattern)        | |
|  +-----------------------------------------------------+ |
|                                                           |
|  ntfy Webhook Handler                                     |
|  POST /ntfy/reply -> raiseEvent("human-answer")           |
+----------------------------------------------------------+
         |                              |
    Dapr actor                    Dapr actor
    invocation                    invocation
         |                              |
         v                              v
+-----------------+          +------------------+
| Architect Actor  |          | Implementer Actor |
| (per issue)      |          | (per issue)       |
|                  |          |                   |
| Event log (PG)   |          | SessionMonitor    |
| Web search tool  |          |   raises events   |
| Mem0 long-term   |          |   on workflow     |
|                  |          |   via Dapr HTTP    |
| Methods:         |          |                   |
|  consult()       |          | Methods:          |
|  answerQuestion() |         |  startSession()   |
|  receiveHuman()  |          |  injectAnswer()   |
+-----------------+          +------------------+
```

### Key Principles

- **Workflow is the orchestrator** -- all coordination through `callActivity` and `waitForExternalEvent`
- **Actors hold per-issue context** -- no context reconstruction needed
- **SessionMonitor raises events on workflow** -- via Dapr HTTP API, using workflowId from ActorState
- **PostgreSQL is the event log** -- durable, queryable, survives actor deactivation
- **Mem0 is cross-issue memory** -- architect stores generalized learnings for future issues
- **ntfy reply webhook** -- human answers flow back as external events

---

## Component 1: Architect Actor

### Conversion

The architect agent converts from a stateless Hono HTTP service to a Dapr actor with per-issue instances. Existing stateless `/consult` and `/tasks` endpoints remain for backward compatibility (general queries not tied to an issue). Issue-specific work goes through actor methods.

### Actor Identity

- **Actor type:** `ArchitectActor`
- **Actor ID scheme:** `{repoOwner}/{repoName}/{issueNumber}` (e.g., `jaybrto/mesh-six/42`)
- **Registered via:** `/dapr/config` response with `entities: ["ArchitectActor"]`

### Actor State (In-Memory)

```typescript
interface ArchitectActorState {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  projectItemId: string;
  issueTitle: string;
}
```

Set at activation, immutable for the actor's lifetime.

### Event Log (PostgreSQL)

```sql
CREATE TABLE architect_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,                    -- "jaybrto/mesh-six/42"
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_architect_events_actor ON architect_events(actor_id, created_at);
```

**Event types:**

| Event Type | When | Payload |
|------------|------|---------|
| `activated` | Actor initialized | `{ issueTitle, workflowId }` |
| `consulted` | INTAKE consultation | `{ question, recommendation: ArchitectureRecommendation }` |
| `question-received` | Question from planning/impl | `{ questionText, phase, source }` |
| `question-answered` | Architect answered confidently | `{ questionText, answer, confidence, usedWebSearch }` |
| `human-escalated` | Not confident, escalated | `{ questionText, bestGuess }` |
| `human-answered` | Human provided answer | `{ questionText, humanAnswer, generalizedLearning }` |
| `memory-stored` | Learning stored in Mem0 | `{ memoryScope, summary }` |
| `deactivated` | Issue completed/failed | `{ reason }` |

### Actor Methods

| Method | Called By | Purpose |
|--------|----------|---------|
| `onActivate(params)` | PM workflow (via Dapr) | Initialize state, load event log from PG |
| `consult(question, context)` | PM `consultArchitectActivity` | Initial INTAKE consultation |
| `answerQuestion(questionText, source)` | PM `consultArchitectActorActivity` | Answer planning/impl question using event log + Mem0 + web search |
| `receiveHumanAnswer(questionText, humanAnswer)` | PM `processHumanAnswerActivity` | Process human answer, store generalized learning in Mem0 |
| `getHistory()` | Dashboard / debugging | Return full event log |
| `onDeactivate()` | Dapr idle timeout | Append deactivated event |

### `answerQuestion` Flow

1. Load event log from PG -- scan for `consulted` event (prior recommendation) and previous Q&A
2. Check Mem0 with scoped userId `planning-qa:{issueNumber}` for similar past questions
3. Build enhanced prompt with: prior recommendation + event log context + Mem0 matches + question
4. LLM call with web search tool available (direct Brave Search or SearXNG)
5. Evaluate confidence of own answer
6. If confident: append `question-answered` event, return `{ confident: true, answer }`
7. If not confident: append `human-escalated` event, return `{ confident: false, bestGuess }`

### `receiveHumanAnswer` Flow

1. Append `human-answered` event to PG with raw human answer
2. LLM call to generalize the answer (e.g., "Use GitHub OAuth for this project" -> "User prefers GitHub OAuth for new services")
3. Store generalized version in Mem0 under `planning-qa:{issueNumber}` scope AND `architect` global scope
4. Append `memory-stored` event

### Web Search Tool

Direct integration via Brave Search API or SearXNG instance. Added as a tool alongside the existing (currently unwired) cluster query tools. All tools get properly wired to the LLM `tracedChatCompletion` calls.

### K8s Changes

- Update `k8s/base/architect-agent/deployment.yaml` with actor Dapr annotations
- Extend `actor-statestore` Redis component scope to include `architect-agent` (Dapr actor runtime needs it for lifecycle management)
- Add `SEARCH_API_URL` and `SEARCH_API_KEY` env vars

---

## Component 2: Event-Driven Workflow Conversion

### What Gets Removed

- `pollForPlanActivity` and implementation
- `pollForImplementationActivity` and implementation
- `pollForTestResultsActivity` and implementation
- `pollGithubForCompletion()` helper function
- `SESSION_BLOCKED_TOPIC` usage in SessionMonitor
- `checkBlocked` lambdas in poll activities

### Event Channel Design

One event name per phase with typed payloads. The workflow calls `waitForExternalEvent(channelName)` and dispatches on the `type` field.

| Channel | Event Types | Raised By |
|---------|-------------|-----------|
| `planning-event` | `question-detected`, `plan-complete`, `session-failed` | SessionMonitor (implementer) |
| `impl-event` | `pr-created`, `question-detected`, `session-failed` | Webhook receiver (PR), SessionMonitor (questions/failure) |
| `qa-event` | `test-results`, `question-detected`, `session-failed` | Webhook receiver / SessionMonitor |
| `deploy-event` | N/A -- stays as polling activity | Internal (health endpoint has no event source) |
| `human-answer` | (single type) | ntfy webhook handler |
| `card-blocked` | (existing, unchanged) | Webhook receiver via PM |
| `card-unblocked` | (existing, unchanged) | Webhook receiver via PM |

### SessionMonitor Changes

The SessionMonitor needs `workflowId` to raise events on the correct workflow instance.

1. Add `workflowId: string` to `ActorState` interface
2. PM passes `workflowId` when starting sessions (via ImplementerActor activation)
3. Replace `SESSION_BLOCKED_TOPIC` publish with Dapr HTTP raiseEvent:

```typescript
await fetch(
  `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/workflows/dapr/${actorState.workflowId}/raiseEvent/planning-event`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "question-detected", questionText, sessionId }),
  }
);
```

4. Reset `questionDetected = false` after answer injection (new `injectAnswer` actor method)

### PLANNING Phase

```
startPlanningSessionActivity
  |  (invokes ImplementerActor, passes workflowId)
  v
while (!planningComplete):
  |
  waitForExternalEvent("planning-event")  <-- workflow suspends (zero resources)
  |
  +-- type: "question-detected"
  |     callActivity(consultArchitectActorActivity)
  |     +-- confident -> callActivity(injectAnswerActivity) -> continue
  |     +-- not confident -> callActivity(notifyHumanQuestionActivity)
  |                          waitForExternalEvent("human-answer")
  |                          callActivity(processHumanAnswerActivity)
  |                          callActivity(injectAnswerActivity) -> continue
  |
  +-- type: "plan-complete"
  |     planContent = event.planContent
  |     planningComplete = true
  |
  +-- type: "session-failed"
        callActivity(moveToFailedActivity) -> return FAILED

reviewPlanActivity(planContent) -> approved? -> proceed
```

### IMPLEMENTATION Phase

```
while (!implComplete):
  waitForExternalEvent("impl-event")
  +-- type: "pr-created" -> implComplete = true
  +-- type: "question-detected" -> same question resolution flow
  +-- type: "session-failed" -> moveToFailed

Move card to QA
```

### QA Phase

```
while (!qaComplete):
  waitForExternalEvent("qa-event")
  +-- type: "test-results"
  |     evaluateTestResultsActivity
  |     +-- passed -> qaComplete = true
  |     +-- failed -> createBugIssueActivity -> continue
  +-- type: "question-detected" -> question resolution flow
  +-- type: "session-failed" -> moveToFailed

Move card to Review
```

### REVIEW/DEPLOY Phase (Exception)

Deployment health checking stays as a polling activity because there is no external system that can raise an event when a Kubernetes deployment becomes healthy. The activity internally polls `/healthz` with timeout logic.

```
deployResult = callActivity(waitForDeploymentActivity, { healthUrl, timeoutMinutes: 10 })
if (ready): callActivity(validateDeploymentActivity)
else: moveToFailed
```

---

## Component 3: Complexity Gate

### Label-Based Routing

The PM reads GitHub issue labels during INTAKE to decide whether to skip Opus planning.

```typescript
const gate = yield ctx.callActivity(complexityGateActivity, {
  issueNumber, repoOwner, repoName,
});

if (gate.simple) {
  // Skip PLANNING -- architect guidance is the plan
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "In Progress" });
} else {
  // Enter PLANNING phase with Claude Opus + superpowers
}
```

### Activity Implementation

```typescript
complexityGate: async (_ctx, input) => {
  if (!ghProjectClient) return { simple: false };
  const labels = await getIssueLabels(input.repoOwner, input.repoName, input.issueNumber);
  return { simple: labels.includes("simple") };
}
```

The `getIssueLabels` function uses `@octokit/rest` to fetch labels from the GitHub API.

### Usage

Add a `simple` label to straightforward issues (typo fixes, single-file changes, config updates) before the PM picks them up. Issues without the label (or with any other label) go through full Opus planning.

---

## Component 4: ntfy Webhook Handler

### Flow

1. Workflow calls `notifyHumanQuestionActivity` when architect isn't confident
2. Activity sends ntfy notification with question + best guess + workflowId in metadata
3. You reply to the notification
4. ntfy forwards your reply to the PM webhook
5. Webhook raises `human-answer` external event on the workflow
6. Workflow resumes, processes your answer through architect for learning

### Notification Activity

```typescript
notifyHumanQuestion: async (_ctx, input) => {
  const message = input.architectBestGuess
    ? `${input.questionText}\n\nArchitect best guess: ${input.architectBestGuess}`
    : input.questionText;

  await fetch(`https://ntfy.bto.bar/mesh-six-pm`, {
    method: "POST",
    headers: {
      "Title": `Issue #${input.issueNumber} needs your input`,
      "Tags": "question",
      "X-Workflow-Id": input.workflowId,
      "X-Issue-Number": String(input.issueNumber),
    },
    body: message,
  });
}
```

### Reply Webhook Endpoint

New endpoint in the PM service:

```typescript
app.post("/ntfy/reply", async (c) => {
  const body = await c.req.json();
  const workflowId = body.extras?.["X-Workflow-Id"];
  const answerText = body.message || body.text;

  if (workflowId && answerText && workflowClient) {
    await workflowClient.raiseEvent(workflowId, "human-answer", {
      answer: answerText,
      timestamp: new Date().toISOString(),
    });
  }
  return c.json({ ok: true });
});
```

### ntfy Configuration

Configure the ntfy topic `mesh-six-pm` with a webhook forwarding rule that POSTs replies to `https://pm.mesh-six.bto.bar/ntfy/reply` (or via Dapr service invocation internally).

---

## Component 5: Implementer Actor Changes

### New ActorState Field

```typescript
interface ActorState {
  // ... existing fields ...
  workflowId: string;        // NEW: set by startPlanningSession, used by SessionMonitor
}
```

### New Actor Method: `injectAnswer`

```typescript
async injectAnswer(params: {
  answerText: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!this.state) return { ok: false, error: "Actor not activated" };

  const { tmuxSessionName } = this.state;
  const escapedAnswer = params.answerText.replace(/'/g, "'\\''");
  await sendCommand(tmuxSessionName, escapedAnswer);

  // Reset question detection so SessionMonitor catches the next question
  // This is communicated to the SessionMonitor via a shared flag or
  // by the monitor checking session_questions for answered entries
  return { ok: true };
}
```

### SessionMonitor Question Detection Reset

After each answer injection, `questionDetected` must reset to `false` so subsequent questions are caught. Options:

1. The `injectAnswer` method sets a flag that the monitor reads
2. The monitor checks `session_questions` for the latest question's `answered_at` field

Option 1 is simpler -- add a shared `answerInjected` flag that the monitor checks:

```typescript
// In monitor poll loop:
if (this.questionDetected && this.answerInjected) {
  this.questionDetected = false;
  this.answerInjected = false;
}
```

---

## Database Migration

New migration file: `migrations/009_architect_events.sql`

```sql
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

---

## New Activity Types Summary

| Activity | Input | Output | Purpose |
|----------|-------|--------|---------|
| `complexityGateActivity` | `{ issueNumber, repoOwner, repoName }` | `{ simple: boolean }` | Check issue labels |
| `startPlanningSessionActivity` | `{ issueNumber, repoOwner, repoName, workflowId, architectGuidance }` | `{ sessionId }` | Invoke ImplementerActor |
| `consultArchitectActorActivity` | `{ actorId, questionText, source }` | `{ confident, answer?, bestGuess? }` | Invoke ArchitectActor.answerQuestion |
| `injectAnswerActivity` | `{ implementerActorId, answerText }` | `{ ok }` | Invoke ImplementerActor.injectAnswer |
| `notifyHumanQuestionActivity` | `{ issueNumber, repoOwner, repoName, workflowId, questionText, architectBestGuess? }` | void | Send ntfy notification |
| `processHumanAnswerActivity` | `{ actorId, questionText, humanAnswer }` | void | Invoke ArchitectActor.receiveHumanAnswer |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `migrations/009_architect_events.sql` | Architect event log table |
| `apps/architect-agent/src/actor.ts` | ArchitectActor class |
| `packages/core/src/architect-actor.ts` | Shared types (actor type constant, event types) |

### Modified Files

| File | Changes |
|------|---------|
| `apps/architect-agent/src/index.ts` | Add actor runtime routes, keep stateless endpoints |
| `apps/project-manager/src/workflow.ts` | Replace polling with waitForExternalEvent, add new activity types/stubs, add complexity gate |
| `apps/project-manager/src/index.ts` | Add new activity implementations, ntfy webhook handler, remove poll implementations |
| `apps/implementer/src/actor.ts` | Add workflowId to ActorState, add injectAnswer method |
| `apps/implementer/src/monitor.ts` | Replace SESSION_BLOCKED_TOPIC publish with raiseEvent, add questionDetected reset |
| `packages/core/src/types.ts` | Add new event schemas if needed |
| `packages/core/src/index.ts` | Export new architect actor types |
| `k8s/base/architect-agent/deployment.yaml` | Add actor Dapr annotations, search API env vars |
| `k8s/base/dapr-components/statestore-actor-redis.yaml` | Extend scope to include architect-agent |

---

## Migration Strategy

The conversion can be done incrementally:

1. **Phase 1: Foundation** -- Migration, architect actor class, core types, actor runtime in architect-agent
2. **Phase 2: Architect Actor** -- Convert architect to actor, wire to PM via new activities, keep old polling workflow working
3. **Phase 3: Event-Driven Workflow** -- Replace polling activities with waitForExternalEvent, update SessionMonitor to raise events
4. **Phase 4: Question Resolution Loop** -- Wire the full question -> architect -> inject answer loop
5. **Phase 5: Complexity Gate + ntfy** -- Add label-based routing and ntfy reply webhook
6. **Phase 6: Cleanup** -- Remove old polling code, SESSION_BLOCKED_TOPIC, unused activity stubs

Each phase can be validated independently. The old polling workflow works alongside the new event-driven flow until the switchover is complete.
