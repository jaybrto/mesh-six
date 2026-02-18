# Milestone 4.5 — GWA Integration (PM Agent ↔ GitHub Workflow Agents)

## Context

Mesh-six's Project Manager agent (M4, already code complete) manages project lifecycle via a Dapr Workflow state machine. GWA (GitHub Workflow Agents) is a separate system that automates Claude Code sessions in k3s pods, driven by GitHub Project Board column changes. The two systems integrate through the GitHub Projects board as a shared contract — PM moves cards, GWA reacts to column changes via its own webhook.

**Problem:** The existing PM agent has no real integration with GWA. It has review gates and a state machine, but no mechanism to: (1) detect new Todo items on the board, (2) know when GWA phases complete, (3) make intelligent gate decisions based on actual Claude Code output, or (4) validate deployed services end-to-end.

**Outcome:** A working end-to-end pipeline where Jay creates a GitHub issue → PM enriches it with architect guidance → PM moves the card through columns → GWA's Claude Code does the work → PM reviews plans, evaluates tests, validates deployments → task reaches Done.

**Key design principle: GitHub Projects is the ONLY integration surface.** The PM has zero knowledge of GWA's internals — no AMQP subscriptions, no GWA types, no bridge services. If GWA were replaced with a human doing the work, the PM would function identically. The board and GitHub API (issues, comments, PRs) are the sole communication channels.

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PM state machine | **Keep Dapr Workflow** | Already implemented, durable by default (survives pod restarts), external events are a natural fit for waiting on board changes. Internal phases modeled as sequential activities within coarser workflow states. |
| Integration surface | **GitHub Projects + GitHub API only** | No gwa-bridge. No AMQP coupling to GWA. PM detects phase completion by polling GitHub issue comments, PR status, and board column via API. Zero coupling to GWA internals. |
| Blocked handling | **Exception to PM-owns-all-moves** | GWA moves cards to Blocked via its own webhook. PM detects via board column polling (or webhook). PM relays questions via ntfy.sh. |
| Plan structure | **New Milestone 4.5** | M4 stays as-is (PM foundation, code complete). M4.5 is the GWA-specific integration layer. |
| QA→Done flow | **Use Review column** | PM moves QA→Review after tests pass. GWA handles CI/CD deploy on Review→Done. PM validates deployment, then moves Review→Done. |
| Gitea support | **Deferred to M4.5+ or M5** | GitHub-only for M4.5. `repo_registry.platform` field supports future Gitea. |

---

## New Service: `apps/webhook-receiver/` (~200 lines)

A single new service that acts as the PM's eyes on the board.

**Endpoint:** `mesh-six.bto.bar/webhooks/github` (Cloudflare tunnel → `agent-mesh` namespace)

### Webhook Handling

- Validates `X-Hub-Signature-256` with timing-safe HMAC (separate secret from GWA's webhook)
- Deduplicates by `X-GitHub-Delivery` header (1-hour TTL in memory)
- Processes `projects_v2_item` events where Status field changed
- Publishes to Dapr `agent-pubsub` topic `board-events`

### Events Published

The webhook-receiver classifies column transitions and publishes typed events:

```typescript
// New Todo item detected (Status changed TO "Todo", or new item created in Todo)
{
  type: "new-todo",
  issueNumber: number,
  issueTitle: string,
  repoOwner: string,
  repoName: string,
  projectItemId: string,
  contentNodeId: string,
  detectedVia: "webhook" | "poll",
  timestamp: string
}

// Card moved to Blocked (GWA moved it — the exception)
{
  type: "card-blocked",
  issueNumber: number,
  repoOwner: string,
  repoName: string,
  projectItemId: string,
  fromColumn: string,       // which column it was in before Blocked
  timestamp: string
}

// Card moved FROM Blocked (GWA unblocked it)
{
  type: "card-unblocked",
  issueNumber: number,
  repoOwner: string,
  repoName: string,
  projectItemId: string,
  toColumn: string,          // which column it returned to
  timestamp: string
}

// Any other column change not initiated by PM (unexpected moves, manual intervention)
{
  type: "card-moved",
  issueNumber: number,
  repoOwner: string,
  repoName: string,
  projectItemId: string,
  fromColumn: string,
  toColumn: string,
  timestamp: string
}
```

### Polling Safety Net

- Every 3 minutes, queries GitHub Projects GraphQL API for items in Todo column
- Deduplicates against Dapr state store (`webhook-receiver:seen-items`)
- Publishes any missed `new-todo` items

### Self-Move Filtering

The webhook-receiver needs to distinguish PM-initiated card moves from external moves (GWA, manual). Two approaches:

**Option A (simple):** PM writes a "pending move" record to Dapr state store before making a card move. Webhook-receiver checks for pending moves and ignores them.

**Option B (simpler):** PM adds a custom field value (e.g., `mesh-six-pending: true`) on the project item before moving the card. Webhook-receiver ignores events where this field is set and clears it after.

**Recommended: Option A** — Dapr state store is local to mesh-six, doesn't pollute the board with custom fields.

### Files to Create

- `apps/webhook-receiver/src/index.ts`
- `apps/webhook-receiver/package.json`
- `apps/webhook-receiver/tsconfig.json`
- `k8s/base/webhook-receiver/deployment.yaml`
- `k8s/base/webhook-receiver/service.yaml`

---

## PM Workflow Rewrite

### Board States vs PM Internal Phases

The PM's Dapr Workflow has coarse "board-aligned" states. Within each state, the workflow executes a series of activities (which are the internal phases).

**Board-aligned workflow states** (what the Dapr Workflow tracks):

| Workflow State | Board Column | What PM Does |
|----------------|-------------|--------------|
| `INTAKE` | Todo | Detect new item, consult architect, enrich issue, move card to Planning |
| `PLANNING` | Planning | Poll GitHub issue for plan comments, review plan when Claude posts it |
| `IMPLEMENTATION` | In Progress | Poll GitHub for PR creation and implementation signals |
| `QA` | QA | Poll for test result comments, evaluate pass/fail |
| `REVIEW` | Review | Validate deployment (health endpoints, smoke tests) |
| `ACCEPTED` | Done | Terminal success state |
| `FAILED` | (no column) | Terminal failure state |

### How PM Detects Phase Completion (No GWA Events)

Without direct GWA event access, the PM uses GitHub API polling:

| Phase | How PM Knows It's Done | What to Poll |
|-------|----------------------|-------------|
| Planning | Claude Code posts a plan as an issue comment | Poll issue comments for plan-like content (structured headings, task lists). LLM classifies whether a comment is "the plan." |
| Implementation | Claude Code creates a PR or posts "implementation complete" comment | Poll for new PRs linked to the issue, or comments indicating completion |
| QA | Test results posted as PR comment or issue comment | Poll for comments containing Playwright test results (pass/fail summary) |
| Deployment | GWA's Review→Done triggers CI/CD | PM watches for the card to be in Done (via webhook) — but PM moves to Review first, then validates before moving to Done |

**Polling pattern for each monitoring activity:**
```
pollGithubForCompletion(issueNumber, pollFn, timeoutMinutes):
  deadline = now() + timeoutMinutes
  while now() < deadline:
    result = pollFn(issueNumber)  // GitHub API call
    if result.completed:
      return result
    sleep 15 seconds              // GitHub API rate-friendly interval
  return { timedOut: true }
```

15-second poll interval is rate-limit-friendly (240 calls/hour per issue, well within GitHub's 5000/hour limit).

### Workflow Generator (Pseudocode)

```
projectWorkflow(ctx, input: { issueNumber, issueTitle, repoOwner, repoName, projectItemId }):

  // === INTAKE phase (card is in Todo) ===
  guidance = yield ctx.callActivity(consultArchitectActivity, { ... })
  yield ctx.callActivity(enrichIssueActivity, { issueNumber, guidance, acceptanceCriteria })
  yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "Planning" })
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "Planning" })
  // GWA's webhook fires → GWA pod starts planning session

  yield ctx.callActivity(recordWorkflowMappingActivity, { issueNumber, workflowInstanceId })

  // === PLANNING phase (card is in Planning) ===
  planCycles = 0
  while planCycles < 3:
    // Wait for Claude to post a plan as an issue comment
    planResult = yield ctx.callActivity(pollForPlanActivity, {
      issueNumber, repoOwner, repoName,
      timeoutMinutes: 30
    })

    if planResult.timedOut:
      yield ctx.callActivity(notifyTimeoutActivity, { issueNumber, phase: "planning" })
      // continue waiting or fail

    // Review the plan
    planReview = yield ctx.callActivity(reviewPlanActivity, {
      issueNumber, repoOwner, repoName,
      planContent: planResult.planContent
    })

    if planReview.approved:
      break

    // Post feedback, Claude picks it up and revises
    yield ctx.callActivity(addCommentActivity, { issueNumber, feedback: planReview })
    planCycles++

  if !planReview.approved:
    yield ctx.callActivity(moveToFailedActivity, { ... })
    return

  // Plan approved → move to Implementation
  yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "In Progress" })
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "In Progress" })
  // GWA's webhook fires → GWA pod starts coding

  // === IMPLEMENTATION phase (card is in In Progress) ===
  implResult = yield ctx.callActivity(pollForImplementationActivity, {
    issueNumber, repoOwner, repoName,
    timeoutMinutes: 60
    // Polls for: PR creation, implementation-complete comments
  })

  if implResult.timedOut:
    yield ctx.callActivity(notifyTimeoutActivity, { issueNumber, phase: "implementation" })

  // Implementation complete → move to QA
  yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "QA" })
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "QA" })
  // GWA's webhook fires → GWA pod runs Playwright tests

  // === QA phase (card is in QA) ===
  qaResult = yield ctx.callActivity(pollForTestResultsActivity, {
    issueNumber, repoOwner, repoName,
    timeoutMinutes: 15
    // Polls for: test result comments (Playwright output)
  })

  testEval = yield ctx.callActivity(evaluateTestResultsActivity, {
    issueNumber, testResults: qaResult.testContent
  })

  if !testEval.passed:
    yield ctx.callActivity(createBugIssueActivity, { repoOwner, repoName, failures: testEval })
    yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "Planning" })
    yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "Planning" })
    // Restart planning loop (bounded, max 3 cycles total)

  // Tests pass → move to Review
  yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "Review" })
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "Review" })

  // === REVIEW phase (card is in Review) ===
  // Wait for deployment to be live (GWA triggers deploy on card arriving at Review)
  yield ctx.callActivity(waitForDeploymentActivity, {
    repoOwner, repoName,
    timeoutMinutes: 10
    // Polls health endpoint until it responds
  })

  validationResult = yield ctx.callActivity(validateDeploymentActivity, {
    repoOwner, repoName
    // Hit health endpoints, run smoke tests
  })

  if !validationResult.passed:
    yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "Planning" })
    yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "Planning" })
    // Restart...

  // Deployment validated → move to Done
  yield ctx.callActivity(recordPendingMoveActivity, { projectItemId, toColumn: "Done" })
  yield ctx.callActivity(moveCardActivity, { projectItemId, toColumn: "Done" })
  // GWA's webhook fires → GWA: DEPLOY_AND_CLEANUP

  // === ACCEPTED ===
  yield ctx.callActivity(reportSuccessActivity, { ... })

  return { projectId, finalState: "ACCEPTED" }
```

### Blocked State Handling

Since we don't have GWA events, blocked detection comes through the webhook-receiver:

```
GWA Claude Code hits a question it can't answer
  │
  ├── GWA's ask-question.ts moves card to Blocked column
  ├── GWA's webhook fires (this is GWA's own webhook, not ours)
  │
  ▼
mesh-six webhook-receiver gets projects_v2_item event
  ├── Detects Status changed to "Blocked"
  ├── Publishes { type: "card-blocked", fromColumn, issueNumber } to board-events
  │
  ▼
PM agent's /board-events handler
  ├── Looks up workflow instance by issue number
  ├── Raises external event "card-blocked" on the Dapr Workflow
  │
  ▼
PM workflow (currently in a pollFor*Activity which is sleeping)
  ├── The polling activity detects the card is now in Blocked column
  │   (via GitHub Projects API, or the workflow interrupts via external event)
  ├── Returns { blocked: true }
  │
  ▼
PM workflow handles blocked
  ├── Fetches the question from issue/PR comments (GWA posts it there)
  ├── Sends ntfy.sh notification via notifyBlockedActivity
  │   (Jay gets push notification with the question)
  ├── Waits for external event "card-unblocked" (from webhook-receiver
  │   when card moves from Blocked back to previous column)
  ├── Resumes the monitoring loop for the current phase
```

**Key insight:** The polling activities need to handle the "card moved to Blocked" case gracefully. They should check the current column on each poll iteration and return early if the card moved away (to Blocked or anywhere unexpected).

### Dapr Workflow Activities

| Activity | Purpose | Key Inputs |
|----------|---------|-----------|
| `consultArchitectActivity` | **Keep from M4** — Dapr invoke architect-agent | question |
| `enrichIssueActivity` | **New** — Add architect guidance + acceptance criteria as GitHub issue comment | issueNumber, guidance |
| `moveCardActivity` | **New** — Move GitHub Projects card to column via GraphQL `updateProjectV2ItemFieldValue` | projectItemId, toColumn |
| `recordPendingMoveActivity` | **New** — Write pending move to Dapr state store (for webhook self-move filtering) | projectItemId, toColumn |
| `pollForPlanActivity` | **New** — Poll GitHub issue comments for Claude's plan. LLM classifies plan-like content. | issueNumber, timeoutMinutes |
| `pollForImplementationActivity` | **New** — Poll for PR creation or implementation-complete signal | issueNumber, timeoutMinutes |
| `pollForTestResultsActivity` | **New** — Poll for Playwright test result comments | issueNumber, timeoutMinutes |
| `reviewPlanActivity` | **Rewrite** — Evaluate plan with LLM via `tracedGenerateText` | issueNumber, planContent |
| `evaluateTestResultsActivity` | **Rewrite** — Evaluate test results with LLM | issueNumber, testResults |
| `waitForDeploymentActivity` | **New** — Poll health endpoint until service is live | repoOwner, repoName, timeoutMinutes |
| `validateDeploymentActivity` | **Keep from M4** — Hit health/readiness endpoints, run smoke tests | repoOwner, repoName |
| `addCommentActivity` | **Keep from M4** — Post GitHub issue comment | issueNumber, body |
| `createBugIssueActivity` | **New** — Create a new GitHub issue for test failures | repoOwner, repoName, failures |
| `notifyBlockedActivity` | **New** — Send ntfy.sh push notification when blocked detected | issueNumber, question |
| `notifyTimeoutActivity` | **New** — Send ntfy.sh notification when a phase times out | issueNumber, phase |
| `recordWorkflowMappingActivity` | **New** — Record issue↔workflow mapping in PostgreSQL | issueNumber, instanceId |
| `reportSuccessActivity` | **New** — Publish success to mesh-six orchestrator, emit event | projectId |
| `moveToFailedActivity` | **New** — Transition to FAILED, emit event, notify | projectId, reason |

### PM Subscription Endpoints (Hono)

Add to `apps/project-manager/src/index.ts`:

```
GET  /dapr/subscribe  → adds new subscription:
  - pubsubname: "agent-pubsub", topic: "board-events", route: "/board-events"

POST /board-events    → Receives board events from webhook-receiver
                        For "new-todo": starts a new Dapr Workflow instance
                        For "card-blocked": raises external event on active workflow
                        For "card-unblocked": raises external event to resume workflow
                        Routes events to correct workflow via pm_workflow_instances table
```

---

## Database Migration

```sql
-- migrations/004_pm_workflow_instances.sql

CREATE TABLE pm_workflow_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number    INTEGER NOT NULL,
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,          -- Dapr Workflow instance ID
  project_item_id TEXT,                   -- GitHub Projects item node ID
  current_phase   TEXT NOT NULL DEFAULT 'INTAKE',
  status          TEXT NOT NULL DEFAULT 'active',  -- active, completed, failed
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(issue_number, repo_owner, repo_name)
);

CREATE INDEX idx_pm_workflow_status ON pm_workflow_instances (status, current_phase);
CREATE INDEX idx_pm_workflow_issue ON pm_workflow_instances (repo_owner, repo_name, issue_number);
```

---

## Core Types

Add to `packages/core/src/types.ts`:

```typescript
// Board event schemas (from webhook-receiver)
export const BoardEventBase = z.object({
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  projectItemId: z.string(),
  timestamp: z.string(),
});

export const NewTodoEvent = BoardEventBase.extend({
  type: z.literal("new-todo"),
  issueTitle: z.string(),
  contentNodeId: z.string(),
  detectedVia: z.enum(["webhook", "poll"]),
});

export const CardBlockedEvent = BoardEventBase.extend({
  type: z.literal("card-blocked"),
  fromColumn: z.string(),
});

export const CardUnblockedEvent = BoardEventBase.extend({
  type: z.literal("card-unblocked"),
  toColumn: z.string(),
});

export const CardMovedEvent = BoardEventBase.extend({
  type: z.literal("card-moved"),
  fromColumn: z.string(),
  toColumn: z.string(),
});

export const BoardEvent = z.discriminatedUnion("type", [
  NewTodoEvent,
  CardBlockedEvent,
  CardUnblockedEvent,
  CardMovedEvent,
]);
```

No GWA-specific types needed. The board event types are mesh-six's own abstraction.

---

## GitHub Projects GraphQL Operations

Both webhook-receiver and PM need these operations:

1. **Move card to column:** `updateProjectV2ItemFieldValue` mutation
   - Requires: project ID, item ID, status field ID, target option ID (column)
   - Column option IDs must be discovered once and cached (or configured via env)

2. **Query items by column** (for polling): `projectV2` query filtering by Status field value
   - Used by webhook-receiver's 3-minute poll

3. **Get current card column:** `projectV2Item` query to check current status field value
   - Used by PM's polling activities to detect unexpected column changes (e.g., Blocked)

4. **Fetch issue comments:** REST API `GET /repos/{owner}/{repo}/issues/{number}/comments`
   - Used by PM to find Claude's plan, test results, etc.

5. **Fetch PRs for issue:** REST API — search PRs mentioning the issue number
   - Used by PM to detect when Claude creates a PR

All services need `GITHUB_TOKEN` with `project` and `repo` scopes.

**Shared utility:** Create `packages/core/src/github.ts` or a separate utility module for GraphQL operations that both webhook-receiver and PM share. Contains:
- `moveCard(projectItemId, toColumn)`
- `getItemColumn(projectItemId)`
- `getProjectTodoItems(projectId)`
- Column name → option ID mapping (loaded once at startup via `projectV2` field query)

---

## E2E Test Design

### Test App: `bto-labs/gwa-test-app`

A purpose-built bookmarks manager serving as a permanent test fixture.

**Baseline state (committed to repo, tagged as `baseline`):**
- Bun + Hono HTTP server on port 3000
- SQLite database with single `bookmarks` table (id, title, url, description, created_at, updated_at)
- CRUD API: `GET /bookmarks`, `POST /bookmarks`, `GET /bookmarks/:id`, `PUT /bookmarks/:id`, `DELETE /bookmarks/:id`
- Vanilla HTML frontend served by Hono (list, create form, delete button)
- `/healthz` and `/readyz` endpoints
- Dockerfile (Bun multi-stage)
- K8s manifests (Deployment, Service, Ingress at `test-app.bto.bar`)
- Playwright config with 3 smoke tests (health check, create bookmark, delete bookmark)
- `CLAUDE.md` with project context for Claude Code
- GitHub Actions deploy workflow

**Test feature request (Tier 1):**
"Add tagging support. Tags table, many-to-many join table, tag CRUD endpoints, tag filter on bookmarks list, tag cloud component, Playwright tests for all new functionality."

This exercises all stages:
- Planning: 3-4 subtasks (DB schema, API, frontend, tests)
- Implementation: DB migration + API routes + frontend components
- QA: Real Playwright assertions on tag functionality
- Deployment: Migration + rebuild + deploy

### Test Runner: `tests/e2e/full-lifecycle.test.ts`

Bun test file that validates the complete pipeline.

**Setup:**
1. Force push `gwa-test-app` to `baseline` tag (reset to known state)
2. Create GitHub issue with the tagging feature request
3. Add issue to the GitHub Project Board as Todo

**Assertions (sequential, with generous timeouts):**

| Phase | Timeout | What to Assert |
|-------|---------|----------------|
| INTAKE | 2 min | PM detects Todo item (check `mesh_six_events` for intake event) |
| CONSULT | 2 min | PM consulted architect (check `mesh_six_events` for `llm.call` from `project-manager`) |
| ENRICH | 1 min | Issue has architect guidance comment (GitHub API) |
| PLANNING START | 1 min | Card moved to Planning column (GitHub Projects API) |
| PLAN POSTED | 15 min | Claude Code posts plan as issue comment (poll GitHub API) |
| PLAN REVIEW | 3 min | PM reviewed plan (check `mesh_six_events` for review gate LLM call) |
| IMPL START | 1 min | Card moved to In Progress column |
| PR CREATED | 30 min | Claude Code creates PR (poll GitHub API) |
| QA START | 1 min | Card moved to QA column |
| TEST RESULTS | 10 min | Test results posted as comment (poll GitHub API) |
| TEST EVALUATION | 2 min | PM evaluated test results |
| REVIEW START | 1 min | Card moved to Review column |
| DEPLOYMENT LIVE | 5 min | Health endpoint responds (poll `test-app.bto.bar/healthz`) |
| VALIDATION | 3 min | PM validated deployment (smoke tests pass) |
| DONE | 1 min | Card moved to Done column |

**Helper pattern:**
```typescript
async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 5000
): Promise<T>
```

**Teardown:**
- Force push `gwa-test-app` to `baseline` tag
- Delete the test GitHub issue
- Remove the project board item

### Test Infrastructure

- Test queries `mesh_six_events` PostgreSQL table directly (for PM event assertions)
- Test uses `@octokit/rest` + `@octokit/graphql` for GitHub API assertions and setup
- Test polls GitHub API and health endpoints directly (no GWA dependency)
- Test env vars: `GITHUB_TOKEN`, `DATABASE_URL`, `TEST_PROJECT_ID`, `TEST_REPO_OWNER`, `TEST_REPO_NAME`

**Files to create:**
- `tests/e2e/full-lifecycle.test.ts`
- `tests/e2e/helpers.ts` (waitFor, GitHub API helpers, DB query helpers)
- `tests/e2e/fixtures/tagging-feature.md` (issue body template)

---

## Implementation Sequence

Implementation uses Claude Code Agent Teams. See [Agent Teams Execution Plan](#agent-teams-execution-plan) for the full breakdown.

**Session 1 (Agent Teams):** Phases 1-3 — foundation, parallel implementation (3 teammates), integration. Produces all mesh-six code changes.

**Session 2 (Optional, Agent Teams or solo):** Phase 4 — test app scaffold + E2E test. Can use teammates for test app (Teammate D) and E2E test (Teammate E) in parallel.

**Session 3 (Solo):** K8s deployment, infrastructure setup (Cloudflare tunnel, webhook registration, secrets).

---

## Infrastructure Prerequisites

| Item | Details |
|------|---------|
| Cloudflare tunnel | Route `mesh-six.bto.bar` → `webhook-receiver.agent-mesh.svc.cluster.local:3000` |
| GitHub webhook | New webhook on org/repo for `projects_v2_item` events, pointing to `mesh-six.bto.bar/webhooks/github` |
| K8s secrets | `github-webhook-secret`, `github-token` in `agent-mesh` namespace |
| GitHub Project | Identify the project ID and status field ID for card manipulation |
| ntfy.sh topic | Configure topic for PM notifications (e.g., `mesh-six-pm`) |
| Test repo | Create `bto-labs/gwa-test-app` with baseline code |
| GWA pod config | Ensure GWA has a runner pod configured for `gwa-test-app` repo |

---

## Files Modified (Existing)

| File | Changes |
|------|---------|
| `packages/core/src/types.ts` | Add board event Zod schemas |
| `packages/core/src/index.ts` | Export new types |
| `packages/core/package.json` | Bump version, add `@octokit/graphql` if shared GitHub utils go in core |
| `apps/project-manager/src/index.ts` | Add `/board-events` Dapr subscription handler, workflow instance routing |
| `apps/project-manager/src/workflow.ts` | Complete rewrite — new board-driven workflow with GitHub API polling activities |
| `apps/project-manager/package.json` | Add `@octokit/graphql` + `@octokit/rest`, bump version |
| `k8s/base/kustomization.yaml` | Add webhook-receiver |
| `k8s/overlays/prod/kustomization.yaml` | Add webhook-receiver |
| `docs/PLAN.md` | Add Milestone 4.5 section |
| `CHANGELOG.md` | Document all changes |

## Files Created (New)

| File | Purpose |
|------|---------|
| `packages/core/src/github.ts` | Shared GitHub Projects GraphQL operations |
| `apps/webhook-receiver/src/index.ts` | Webhook + poll service |
| `apps/webhook-receiver/package.json` | Package manifest |
| `apps/webhook-receiver/tsconfig.json` | TypeScript config |
| `k8s/base/webhook-receiver/deployment.yaml` | K8s deployment |
| `k8s/base/webhook-receiver/service.yaml` | K8s service |
| `migrations/004_pm_workflow_instances.sql` | Workflow tracking table |
| `tests/e2e/full-lifecycle.test.ts` | E2E test runner |
| `tests/e2e/helpers.ts` | Test utilities |
| `tests/e2e/fixtures/tagging-feature.md` | Test issue template |

---

## Acceptance Criteria

- [ ] `webhook-receiver` detects new Todo items via webhook and 3-min poll
- [ ] `webhook-receiver` detects card-blocked and card-unblocked events
- [ ] `webhook-receiver` filters out PM-initiated card moves (self-move filtering)
- [ ] PM creates workflow instance when new Todo is detected
- [ ] PM consults architect-agent before enriching the issue
- [ ] PM enriches issue with architect guidance comment
- [ ] PM moves card Todo→Planning (triggers GWA planning session)
- [ ] PM polls GitHub API to detect when Claude posts a plan
- [ ] PM reviews Claude Code's plan via LLM evaluation (`tracedGenerateText`)
- [ ] PM posts feedback if plan is inadequate, keeps card in Planning
- [ ] PM moves card Planning→In Progress when plan approved (triggers GWA coding)
- [ ] PM polls GitHub API to detect PR creation / implementation completion
- [ ] PM moves card In Progress→QA (triggers GWA Playwright tests)
- [ ] PM polls GitHub API for test result comments
- [ ] PM evaluates test results via LLM
- [ ] PM moves card QA→Review on test pass
- [ ] PM waits for deployment to be live, validates via health endpoints + smoke tests
- [ ] PM moves card Review→Done on validation pass
- [ ] PM handles blocked state (detects via webhook, sends ntfy.sh, resumes on unblock)
- [ ] PM creates bug issues on test failure, moves card back to Planning
- [ ] All PM operations logged via `tracedGenerateText` and `EventLog.emit()` with trace_id
- [ ] `pm_workflow_instances` table tracks issue↔workflow mapping
- [ ] Workflow survives pod restarts (Dapr Workflow durability)
- [ ] E2E test validates complete lifecycle: Todo→Planning→In Progress→QA→Review→Done

---

## Verification

1. **Unit tests:** Activities can be tested in isolation with mocked GitHub API and EventLog
2. **Integration test:** Deploy webhook-receiver + PM to dev overlay, manually create a Todo item, verify card progresses through columns
3. **E2E test:** Run `bun test tests/e2e/full-lifecycle.test.ts` — full automated lifecycle with gwa-test-app
4. **Observability:** Query `mesh_six_events` for a complete trace_id to verify all events are logged
5. **Crash recovery:** Kill PM pod mid-workflow, verify it resumes from the correct state after restart

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| GitHub API rate limiting during polling | 15-second poll interval = 240 calls/hour/issue. GitHub allows 5000/hour. Even with 5 concurrent workflows, well within limits. |
| Dapr Workflow JS SDK lacks `whenAny` for timer+event racing | Implement timeout within polling activities (loop with deadline). Workflow calls activities sequentially. |
| GitHub Projects v2 GraphQL complexity | Shared utility module with pre-built mutations. Column option IDs cached at startup. |
| PM can't distinguish its own card moves from external moves | Self-move filtering via Dapr state store "pending moves" set. |
| Claude's plan/test comments have unpredictable format | LLM classification via `tracedGenerateText` — ask the LLM "does this comment contain a plan/test results?" rather than regex parsing. |
| PM workflow stuck in polling loop | Each phase has configurable timeout. Timeout → FAILED state + ntfy.sh notification. |
| Pod restart loses in-memory state | `pm_workflow_instances` PostgreSQL table + Dapr Workflow durability. On startup, PM loads active mappings. |
| Race condition: webhook + poll detect same Todo | Dedup by `(issueNumber, repoOwner, repoName)` unique constraint in `pm_workflow_instances`. Second insert fails gracefully. |

---

## Agent Teams Execution Plan

This plan is designed to be executed in a single Claude Code session using **Agent Teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). The team lead coordinates teammates that work in parallel on independent deliverables via the shared Tasks API.

### Team Structure

**Team Lead** — Coordinator and reviewer. Does NOT write code directly (delegate mode). Responsibilities:
- Creates the task list with dependencies
- Spawns teammates and assigns tasks
- Reviews teammate output for correctness and consistency
- Handles cross-cutting concerns (dependency wiring, import paths, version bumps)
- Runs verification steps (typecheck, tests, build) after each phase
- Commits code after review

### Phase 1: Foundation (Sequential — Team Lead Only)

Before spawning teammates, the team lead handles tasks that everything else depends on:

**Task 1.1: Database migration**
- Create `migrations/004_pm_workflow_instances.sql`
- Run `bun run db:migrate` to verify

**Task 1.2: Core types**
- Add `BoardEvent` Zod schemas to `packages/core/src/types.ts`
- Export from `packages/core/src/index.ts`
- Bump `packages/core/package.json` version

**Task 1.3: GitHub GraphQL utilities**
- Create `packages/core/src/github.ts` with shared operations:
  - `moveCard(projectItemId, toColumn)` — `updateProjectV2ItemFieldValue` mutation
  - `getItemColumn(projectItemId)` — query current status field
  - `getProjectTodoItems(projectId)` — list items in Todo column
  - `getIssueComments(owner, repo, issueNumber)` — REST API wrapper
  - `getIssuePRs(owner, repo, issueNumber)` — search linked PRs
  - Column name → option ID mapping (loaded at startup)
- Export from `packages/core/src/index.ts`

**Verification gate:** `bun run --filter @mesh-six/core typecheck` must pass before Phase 2.

### Phase 2: Parallel Implementation (3 Teammates)

Spawn 3 teammates. Each owns a disjoint set of files — no conflicts possible.

#### Teammate A: Webhook Receiver

**Owns:** `apps/webhook-receiver/**`

**Tasks:**
- Create `apps/webhook-receiver/package.json` (deps: `hono`, `@mesh-six/core`, `@octokit/graphql`, `@dapr/dapr`)
- Create `apps/webhook-receiver/tsconfig.json`
- Create `apps/webhook-receiver/src/index.ts`:
  - Hono HTTP server on port 3000
  - `POST /webhooks/github` — HMAC validation, `projects_v2_item` event parsing, column transition classification, publish to Dapr `board-events` topic
  - `GET /healthz`, `GET /readyz`
  - `GET /dapr/subscribe` — subscribe to nothing (this service only publishes)
  - Dedup by `X-GitHub-Delivery` header (Map with 1-hour TTL cleanup)
  - 3-minute poll interval using `setInterval` — queries GitHub Projects GraphQL for Todo items, dedup against Dapr state store
  - Self-move filtering: check Dapr state store `pending-moves:{projectItemId}` before publishing
- Uses `BoardEvent` schemas from `@mesh-six/core` for all published events
- Uses `getProjectTodoItems()` from `@mesh-six/core/github` for polling

**Validation:** Teammate writes unit tests for HMAC validation, event classification, and dedup logic.

#### Teammate B: PM Workflow Rewrite

**Owns:** `apps/project-manager/src/workflow.ts` (complete rewrite)

**Tasks:**
- Rewrite `apps/project-manager/src/workflow.ts` with the new board-driven workflow:
  - New workflow states: INTAKE → PLANNING → IMPLEMENTATION → QA → REVIEW → ACCEPTED / FAILED
  - New activities (all as typed stubs first, then implementations):
    - `enrichIssueActivity` — posts architect guidance as GitHub issue comment
    - `moveCardActivity` — uses `moveCard()` from core github utils
    - `recordPendingMoveActivity` — writes to Dapr state store
    - `pollForPlanActivity` — polls issue comments, LLM classifies plan content
    - `pollForImplementationActivity` — polls for PR creation
    - `pollForTestResultsActivity` — polls for test result comments
    - `reviewPlanActivity` — LLM evaluation via `tracedGenerateText`
    - `evaluateTestResultsActivity` — LLM evaluation of test results
    - `waitForDeploymentActivity` — polls health endpoint
    - `createBugIssueActivity` — creates bug issue on test failure
    - `notifyBlockedActivity` — sends ntfy.sh notification
    - `notifyTimeoutActivity` — sends ntfy.sh timeout alert
    - `recordWorkflowMappingActivity` — inserts into `pm_workflow_instances`
    - `reportSuccessActivity` — emits success event
    - `moveToFailedActivity` — emits failure event
  - Keep existing `consultArchitectActivity`, `validateDeploymentActivity`, `addCommentActivity` (adapt signatures)
  - Bounded retry loops (max 3 plan revision cycles, max 3 QA cycles)
  - Blocked state handling via external events
- All activities use `tracedGenerateText` and `EventLog.emit()` where applicable
- All polling activities check for unexpected column changes (Blocked) on each iteration

**Validation:** Teammate writes unit tests for activity stubs with mocked GitHub API.

#### Teammate C: PM Server Integration + K8s

**Owns:** `apps/project-manager/src/index.ts` (modifications only — Hono routes, subscriptions), `k8s/base/webhook-receiver/**`

**Tasks:**
- Modify `apps/project-manager/src/index.ts`:
  - Add Dapr subscription for `board-events` topic → `/board-events` route
  - Implement `/board-events` POST handler:
    - Parse `BoardEvent` with Zod
    - `new-todo`: start new Dapr Workflow instance, insert into `pm_workflow_instances`
    - `card-blocked`: lookup workflow by issue number, raise `card-blocked` external event
    - `card-unblocked`: raise `card-unblocked` external event
    - `card-moved`: log unexpected moves, raise events if relevant
  - Add `pm_workflow_instances` query helpers (lookup by issue number, update phase/status)
  - Wire new workflow activities to implementations
  - Update `apps/project-manager/package.json` with new deps (`@octokit/graphql`, `@octokit/rest`)
- Create K8s manifests:
  - `k8s/base/webhook-receiver/deployment.yaml` — Dapr sidecar, port 3000, env vars for GitHub token/webhook secret
  - `k8s/base/webhook-receiver/service.yaml` — ClusterIP on port 3000
- Update `k8s/base/kustomization.yaml` to include webhook-receiver

**Validation:** Teammate verifies PM server compiles with `bun run --filter @mesh-six/project-manager typecheck`.

### Phase 3: Integration + Testing (Sequential — Team Lead)

After all 3 teammates complete:

**Task 3.1: Integration wiring**
- Team lead reviews all teammate output
- Ensures imports, types, and function signatures align across the three workstreams
- Resolves any interface mismatches
- Bumps versions in `package.json` files
- Updates `CHANGELOG.md`

**Task 3.2: Typecheck + build**
- `bun run typecheck` (all packages)
- `bun run build` (all packages)
- Fix any issues

**Task 3.3: Unit tests**
- `bun run test` (all packages)
- Fix any issues

**Task 3.4: Update PLAN.md**
- Add Milestone 4.5 section to `docs/PLAN.md`

### Phase 4: E2E Test + Test App (Can Be Separate Session)

This phase can optionally be deferred to a follow-up session since it requires the test app repo to exist.

**Task 4.1: Test app scaffold** (`bto-labs/gwa-test-app` — separate repo)
**Task 4.2: E2E test** (`tests/e2e/full-lifecycle.test.ts`)
**Task 4.3: E2E test helpers** (`tests/e2e/helpers.ts`)

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead** | `migrations/004_*`, `packages/core/src/types.ts`, `packages/core/src/github.ts`, `packages/core/src/index.ts`, `packages/core/package.json`, `CHANGELOG.md`, `docs/PLAN.md` | Everything |
| **A** | `apps/webhook-receiver/**` | `packages/core/src/*` |
| **B** | `apps/project-manager/src/workflow.ts` | `packages/core/src/*`, `apps/project-manager/src/index.ts` (read-only to understand existing patterns) |
| **C** | `apps/project-manager/src/index.ts`, `apps/project-manager/package.json`, `k8s/base/webhook-receiver/**`, `k8s/base/kustomization.yaml` | `packages/core/src/*`, `apps/project-manager/src/workflow.ts` (read-only to understand activity signatures) |

### Task Dependency DAG

```
Phase 1 (Lead):
  1.1 Migration ──┐
  1.2 Core types ─┼── All must complete before Phase 2
  1.3 GitHub utils ┘

Phase 2 (Parallel):
  A: webhook-receiver ──┐
  B: PM workflow ────────┼── All must complete before Phase 3
  C: PM server + K8s ───┘

Phase 3 (Lead):
  3.1 Integration wiring ──► 3.2 Typecheck ──► 3.3 Tests ──► 3.4 PLAN.md

Phase 4 (Optional, separate):
  4.1 Test app ──► 4.2 E2E test ──► 4.3 E2E helpers
```

### Claude Code Session Setup

1. Complete Phase 1 foundation tasks (as team lead, no teammates yet)
2. Verify typecheck passes
3. Spawn 3 teammates for Phase 2 with the task assignments above
4. Use delegate mode (`Shift+Tab`) to focus on coordination
5. After all teammates finish, run Phase 3 integration
6. Commit the result

---

## Future Enhancements (Not in M4.5)

- **GWA event bridge** (`apps/gwa-bridge/`): Direct AMQP subscription to `gwa.events.*` for real-time observability. Useful for dashboard and faster phase detection, but not required for the core pipeline.
- **Gitea support**: Add Gitea API client alongside GitHub. Query `repo_registry` for platform.
- **Parallel workflows**: Multiple issues progressing simultaneously (already supported by Dapr Workflow instances, but needs testing with concurrent GWA pods).
- **PM autonomy**: PM attempts to answer blocked questions using architect/researcher agents before relaying to Jay.
- **Retry budget**: Per-issue retry budget tracked in `pm_workflow_instances` instead of hardcoded `max 3 cycles`.
