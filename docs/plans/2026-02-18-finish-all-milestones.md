# Finish All Milestones — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy every mesh-six service to k3s, validate each milestone works end-to-end, and run a full E2E lifecycle test with the gwa-test-app.

**Architecture:** All code is complete. The remaining work is: (1) code changes needed to make deployment viable (Dapr components in kustomize, dashboard build pipeline, ingress routes, E2E test scaffolding), (2) one-time manual cluster setup (secrets, ArgoCD, DB migrations), (3) external integration setup (GitHub webhook, test app), and (4) systematic smoke testing + E2E validation.

**Tech Stack:** Bun, TypeScript, Kustomize, ArgoCD, Dapr, k3s, GitHub Projects GraphQL API, Traefik IngressRoutes, Bun test runner

---

## Overview of All Remaining Work

### What's blocking deployment right now

| Blocker | Phase |
|---------|-------|
| Dapr components (`pubsub-rabbitmq.yaml`, `statestore-redis.yaml`, `outbox-postgresql.yaml`, `resiliency.yaml`) are in `dapr/components/` but NOT in the Kustomize tree → ArgoCD does not deploy them | Phase 1 |
| Dashboard has no Dockerfile (Dockerfile.agent uses `bun build` for Bun targets, not Vite), is not in `build-deploy.yaml`, and has no ingress | Phase 1 |
| `webhook-receiver` has no Traefik IngressRoute → GitHub can't send webhooks to it | Phase 1 |
| `GITHUB_PROJECT_ID` and `GITHUB_STATUS_FIELD_ID` are empty strings in `k8s/base/webhook-receiver/deployment.yaml` | Phase 4 |
| K8s secrets don't exist in cluster (postgres-secret, litellm-secret, redis-secret, rabbitmq-secret, github-secret, github-webhook-secret, gitea-registry-secret) | Phase 2 |
| ArgoCD Application not yet applied to cluster | Phase 2 |
| DB migrations 001–004 not yet run against production `mesh_six` database | Phase 2 |
| `bto-labs/gwa-test-app` repo doesn't exist | Phase 3 |
| E2E test (`tests/e2e/full-lifecycle.test.ts`) doesn't exist | Phase 1 |

### Deployment flow reminder

Push to `main` → GitHub Actions `build-deploy.yaml` → Kaniko builds & pushes images → `kubectl rollout restart` for each agent → ArgoCD auto-syncs `k8s/overlays/prod` to cluster.

Secrets come from: Vault (via External Secrets Operator, syncs `litellm-secret` + `claude-secret`) and manually created k8s secrets (postgres, redis, rabbitmq, github tokens, registry auth).

---

## Phase 1: Code Changes (Commit and Push to Trigger CI/CD)

These tasks produce git commits. The CI/CD pipeline handles the rest automatically.

---

### Task 1: Add Dapr components to the Kustomize tree

**Why:** ArgoCD only manages what's in `k8s/overlays/prod`. Dapr components in `dapr/components/` are not applied by ArgoCD. Moving them into the kustomize tree means ArgoCD manages them going forward.

**Files:**
- Create: `k8s/base/dapr-components/kustomization.yaml`
- Modify: `k8s/base/kustomization.yaml`

**Step 1: Create `k8s/base/dapr-components/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: mesh-six

resources:
  - ../../../../dapr/components/statestore-redis.yaml
  - ../../../../dapr/components/pubsub-rabbitmq.yaml
  - ../../../../dapr/components/outbox-postgresql.yaml
  - ../../../../dapr/components/resiliency.yaml
```

**Step 2: Add to `k8s/base/kustomization.yaml` resources list**

Add `- dapr-components/` after `- vault-external-secrets.yaml`.

**Step 3: Verify kustomize renders without errors**

```bash
kubectl kustomize k8s/overlays/prod --dry-run | head -50
```

Expected: No errors, Dapr component CRDs appear in output.

**Step 4: Commit**

```bash
git add k8s/base/dapr-components/ k8s/base/kustomization.yaml
git commit -m "chore: add Dapr components to kustomize tree for ArgoCD management"
```

---

### Task 2: Create Dockerfile.dashboard and add to CI pipeline

**Why:** The dashboard is a Vite SPA served by nginx. It cannot use `Dockerfile.agent` (which uses `bun build` for Bun server targets). It needs a Vite build + nginx serve with runtime env substitution for the MQTT URL.

The dashboard's VITE env vars are baked in at build time. Since browsers can't reach internal k8s DNS (`rabbitmq.rabbitmq:15675`), the dashboard must use the external MQTT WebSocket URL (`wss://rabbitmq-ws.bto.bar/ws`). We'll use nginx `envsubst` to substitute a `__MQTT_URL__` placeholder at container startup.

**Files:**
- Create: `docker/Dockerfile.dashboard`
- Create: `docker/nginx.dashboard.conf`
- Create: `docker/docker-entrypoint.dashboard.sh`
- Modify: `.github/workflows/build-deploy.yaml`
- Modify: `apps/dashboard/src/hooks/useMqtt.tsx` (replace `import.meta.env.VITE_MQTT_URL` with `window.__MQTT_URL__ || import.meta.env.VITE_MQTT_URL`)

**Step 1: Verify current dashboard MQTT hook usage**

```bash
grep -r "VITE_MQTT\|MQTT_URL\|mqtt" apps/dashboard/src/ --include="*.tsx" --include="*.ts" -l
```

**Step 2: Create `docker/nginx.dashboard.conf`**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing — all paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Health check
    location /healthz {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}
```

**Step 3: Create `docker/docker-entrypoint.dashboard.sh`**

```bash
#!/bin/sh
# Substitute MQTT_URL placeholder in built JS files at container startup
# This enables runtime configuration without rebuilding the image
MQTT_URL="${VITE_MQTT_URL:-wss://rabbitmq-ws.bto.bar/ws}"
find /usr/share/nginx/html -name "*.js" -exec sed -i "s|__MQTT_URL_PLACEHOLDER__|${MQTT_URL}|g" {} \;
exec nginx -g "daemon off;"
```

```bash
chmod +x docker/docker-entrypoint.dashboard.sh
```

**Step 4: Create `docker/Dockerfile.dashboard`**

```dockerfile
FROM oven/bun:latest AS builder
WORKDIR /app
COPY . .
ARG VITE_MQTT_URL=__MQTT_URL_PLACEHOLDER__
ENV VITE_MQTT_URL=${VITE_MQTT_URL}
RUN bun install --frozen-lockfile
RUN cd apps/dashboard && bun run build

FROM nginx:alpine
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY docker/nginx.dashboard.conf /etc/nginx/conf.d/default.conf
COPY docker/docker-entrypoint.dashboard.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
```

**Step 5: Update dashboard `src/hooks/useMqtt.tsx` to support runtime placeholder**

Find the MQTT URL reference (likely `import.meta.env.VITE_MQTT_URL` or `VITE_MQTT_BROKER_URL`) and add fallback:

```typescript
const mqttUrl = (window as any).__MQTT_URL_PLACEHOLDER__ !== '__MQTT_URL_PLACEHOLDER__'
  ? (window as any).__MQTT_URL_PLACEHOLDER__
  : (import.meta.env.VITE_MQTT_URL || 'wss://rabbitmq-ws.bto.bar/ws');
```

**Step 6: Add dashboard to `.github/workflows/build-deploy.yaml`**

In the build matrix, add `dashboard` as a special case. Find the build step and add:

```yaml
# In the matrix strategy (apps list), add: dashboard
# In the build step, detect dashboard and use Dockerfile.dashboard:
- name: Build and push
  run: |
    DOCKERFILE="docker/Dockerfile.agent"
    if [ "${{ matrix.app }}" = "dashboard" ]; then
      DOCKERFILE="docker/Dockerfile.dashboard"
    fi
    # ... rest of Kaniko command using $DOCKERFILE
```

**Step 7: Verify the dashboard package has a `build` script**

```bash
cat apps/dashboard/package.json | grep '"build"'
```

Expected: `"build": "vite build"` or similar.

**Step 8: Commit**

```bash
git add docker/Dockerfile.dashboard docker/nginx.dashboard.conf docker/docker-entrypoint.dashboard.sh apps/dashboard/src/ .github/workflows/build-deploy.yaml
git commit -m "feat: add dashboard Dockerfile with nginx + runtime MQTT URL substitution, add to CI pipeline"
```

---

### Task 3: Add Traefik IngressRoutes for dashboard and webhook-receiver

**Why:** Both services are ClusterIP-only right now. The dashboard needs to be reachable via browser. The webhook-receiver needs GitHub to POST webhooks to it (`mesh-six.bto.bar/webhooks/github` per the PLAN_45_GWA.md spec).

Traefik is the cluster ingress controller. Use `IngressRoute` CRDs (Traefik v2+).

**Files:**
- Create: `k8s/base/dashboard/ingress.yaml`
- Create: `k8s/base/webhook-receiver/ingress.yaml`
- Modify: `k8s/base/dashboard/kustomization.yaml`
- Modify: `k8s/base/webhook-receiver/kustomization.yaml`

**Step 1: Create `k8s/base/dashboard/ingress.yaml`**

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: dashboard
  namespace: mesh-six
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`mesh-six.bto.bar`)
      kind: Rule
      services:
        - name: dashboard
          port: 80
  tls:
    certResolver: letsencrypt
```

**Step 2: Create `k8s/base/webhook-receiver/ingress.yaml`**

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: webhook-receiver
  namespace: mesh-six
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`mesh-six.bto.bar`) && PathPrefix(`/webhooks`)
      kind: Rule
      services:
        - name: webhook-receiver
          port: 80
  tls:
    certResolver: letsencrypt
```

**Step 3: Add ingress.yaml to each agent's kustomization**

In `k8s/base/dashboard/kustomization.yaml`:
```yaml
resources:
  - deployment.yaml
  - service.yaml
  - ingress.yaml
```

In `k8s/base/webhook-receiver/kustomization.yaml`:
```yaml
resources:
  - deployment.yaml
  - service.yaml
  - ingress.yaml
```

**Step 4: Verify Traefik CRD availability**

```bash
kubectl get crd ingressroutes.traefik.io 2>/dev/null && echo "CRD exists" || echo "CRD missing - check Traefik version"
```

If the CRD name is different (e.g., `ingressroutes.traefik.containo.us` for older Traefik), update `apiVersion` accordingly.

**Step 5: Dry-run verify**

```bash
kubectl kustomize k8s/overlays/prod --dry-run | grep -A5 "IngressRoute"
```

**Step 6: Commit**

```bash
git add k8s/base/dashboard/ingress.yaml k8s/base/webhook-receiver/ingress.yaml k8s/base/dashboard/kustomization.yaml k8s/base/webhook-receiver/kustomization.yaml
git commit -m "feat: add Traefik IngressRoutes for dashboard (mesh-six.bto.bar) and webhook-receiver (/webhooks)"
```

---

### Task 4: Create E2E test scaffolding

**Why:** The E2E test validates the full M4.5 lifecycle (Todo → Done). It can be written now — it just won't run until deployment is complete. Creating the scaffold now means we don't have to write it under pressure later.

The test app is `bto-labs/gwa-test-app` — a bookmarks manager. The feature request is "Add tagging support."

**Files:**
- Create: `tests/e2e/full-lifecycle.test.ts`
- Create: `tests/e2e/helpers.ts`
- Create: `tests/e2e/fixtures/tagging-feature.md`

**Step 1: Create `tests/e2e/fixtures/tagging-feature.md`**

```markdown
## Feature Request: Add Tagging Support

Add the ability to tag bookmarks with multiple tags for better organization.

### Acceptance Criteria

1. Tags table with `id`, `name`, `created_at` columns
2. Many-to-many join table `bookmark_tags`
3. REST endpoints: `GET /tags`, `POST /tags`, `DELETE /tags/:id`
4. `POST /bookmarks` and `PUT /bookmarks/:id` accept optional `tag_ids[]`
5. `GET /bookmarks` supports optional `?tag=<name>` filter
6. Tag cloud component in the UI showing all tags with bookmark counts
7. Playwright tests covering: create tag, tag a bookmark, filter by tag, delete tag

### Technical Notes

- Use SQLite for the database (already in place)
- Add migration script in `migrations/` directory
- Follow the existing Hono route pattern in `src/routes/`
- Use Playwright for all new tests (config already in `playwright.config.ts`)
```

**Step 2: Create `tests/e2e/helpers.ts`**

```typescript
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import pg from "pg";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

export const TEST_REPO_OWNER = process.env.TEST_REPO_OWNER || "bto-labs";
export const TEST_REPO_NAME = process.env.TEST_REPO_NAME || "gwa-test-app";
export const TEST_PROJECT_ID = process.env.TEST_PROJECT_ID || "";
export const TEST_APP_URL = process.env.TEST_APP_URL || "https://test-app.bto.bar";
export const DATABASE_URL = process.env.DATABASE_URL || "";

// Poll until a condition is true or timeout
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null && result !== undefined) {
      console.log(`✓ ${description}`);
      return result;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timeout waiting for: ${description} (${timeoutMs}ms)`);
}

// Create a GitHub issue and add it to the project board
export async function createTestIssue(title: string, body: string): Promise<{ issueNumber: number; nodeId: string }> {
  const issue = await octokit.rest.issues.create({
    owner: TEST_REPO_OWNER,
    repo: TEST_REPO_NAME,
    title,
    body,
    labels: ["feature-request"],
  });
  return { issueNumber: issue.data.number, nodeId: issue.data.node_id };
}

// Add issue to GitHub Projects board in Todo column
export async function addIssueToProjectBoard(issueNodeId: string): Promise<string> {
  const result = await graphqlWithAuth<any>(`
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `, { projectId: TEST_PROJECT_ID, contentId: issueNodeId });
  return result.addProjectV2ItemById.item.id;
}

// Get current board column for a project item
export async function getItemColumn(projectItemId: string): Promise<string | null> {
  const result = await graphqlWithAuth<any>(`
    query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  `, { itemId: projectItemId });
  const statusField = result.node.fieldValues.nodes.find(
    (n: any) => n.field?.name === "Status"
  );
  return statusField?.name || null;
}

// Get latest issue comments
export async function getIssueComments(issueNumber: number): Promise<Array<{ body: string; createdAt: string }>> {
  const comments = await octokit.rest.issues.listComments({
    owner: TEST_REPO_OWNER,
    repo: TEST_REPO_NAME,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.data.map(c => ({ body: c.body || "", createdAt: c.created_at }));
}

// Check mesh_six_events for an event type from project-manager within a time range
export async function queryMeshEvent(
  eventType: string,
  agentId: string,
  sinceMs: number
): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM mesh_six_events
       WHERE event_type = $1 AND agent_id = $2 AND timestamp > NOW() - INTERVAL '${sinceMs} milliseconds'`,
      [eventType, agentId]
    );
    return parseInt(result.rows[0].count) > 0;
  } finally {
    await pool.end();
  }
}

// Close and clean up a test issue
export async function closeTestIssue(issueNumber: number): Promise<void> {
  await octokit.rest.issues.update({
    owner: TEST_REPO_OWNER,
    repo: TEST_REPO_NAME,
    issue_number: issueNumber,
    state: "closed",
    state_reason: "completed",
  });
}
```

**Step 3: Create `tests/e2e/full-lifecycle.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  waitFor,
  createTestIssue,
  addIssueToProjectBoard,
  getItemColumn,
  getIssueComments,
  queryMeshEvent,
  closeTestIssue,
  TEST_APP_URL,
} from "./helpers";
import { readFileSync } from "fs";

// Required env vars — test fails fast if missing
const requiredEnv = ["GITHUB_TOKEN", "TEST_PROJECT_ID", "DATABASE_URL", "TEST_APP_URL"];
for (const env of requiredEnv) {
  if (!process.env[env]) throw new Error(`Missing required env var: ${env}`);
}

const ISSUE_TITLE = `[E2E Test] Add tagging support — ${Date.now()}`;
const issueBody = readFileSync(`${import.meta.dir}/fixtures/tagging-feature.md`, "utf-8");

let issueNumber: number;
let projectItemId: string;
const testStart = Date.now();

describe("Full lifecycle E2E: Todo → Done", () => {
  beforeAll(async () => {
    // Reset test app to baseline
    console.log("Setting up test: creating issue...");
    const issue = await createTestIssue(ISSUE_TITLE, issueBody);
    issueNumber = issue.issueNumber;
    console.log(`Created issue #${issueNumber}`);

    projectItemId = await addIssueToProjectBoard(issue.nodeId);
    console.log(`Added to project board: ${projectItemId}`);
  });

  afterAll(async () => {
    if (issueNumber) await closeTestIssue(issueNumber);
  });

  it("INTAKE: PM detects new Todo item within 5 minutes", async () => {
    await waitFor(
      "PM detects new-todo event",
      () => queryMeshEvent("state.transition", "project-manager", 5 * 60 * 1000),
      5 * 60 * 1000
    );
  }, 6 * 60 * 1000);

  it("INTAKE: PM consulted architect (LLM call from project-manager)", async () => {
    await waitFor(
      "PM consulted architect",
      () => queryMeshEvent("llm.call", "project-manager", 10 * 60 * 1000),
      10 * 60 * 1000
    );
  }, 11 * 60 * 1000);

  it("INTAKE: Issue enriched with architect guidance comment", async () => {
    await waitFor(
      "Architect guidance comment posted",
      async () => {
        const comments = await getIssueComments(issueNumber);
        return comments.find(c => c.body.includes("Architect Guidance") || c.body.includes("Technical Recommendation")) || null;
      },
      5 * 60 * 1000
    );
  }, 6 * 60 * 1000);

  it("PLANNING: Card moved to Planning column", async () => {
    await waitFor(
      "Card in Planning column",
      async () => {
        const col = await getItemColumn(projectItemId);
        return col === "Planning" ? col : null;
      },
      3 * 60 * 1000
    );
  }, 4 * 60 * 1000);

  it("PLANNING: Claude Code posts a plan as issue comment (15 min timeout)", async () => {
    await waitFor(
      "Plan posted as issue comment",
      async () => {
        const comments = await getIssueComments(issueNumber);
        // Look for a comment with plan-like structure (multiple headings, task list)
        const planComment = comments.find(c =>
          c.body.includes("##") &&
          (c.body.includes("- [ ]") || c.body.includes("1.")) &&
          c.body.length > 500
        );
        return planComment || null;
      },
      20 * 60 * 1000
    );
  }, 21 * 60 * 1000);

  it("IMPLEMENTATION: Card moved to In Progress", async () => {
    await waitFor(
      "Card in In Progress column",
      async () => {
        const col = await getItemColumn(projectItemId);
        return col === "In Progress" ? col : null;
      },
      5 * 60 * 1000
    );
  }, 6 * 60 * 1000);

  it("IMPLEMENTATION: Claude Code creates a PR", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    await waitFor(
      "PR created for issue",
      async () => {
        const prs = await octokit.rest.pulls.list({
          owner: "bto-labs",
          repo: "gwa-test-app",
          state: "open",
        });
        const linked = prs.data.find(pr =>
          pr.body?.includes(`#${issueNumber}`) || pr.title.includes(`#${issueNumber}`)
        );
        return linked || null;
      },
      40 * 60 * 1000,
      15_000
    );
  }, 41 * 60 * 1000);

  it("QA: Card moved to QA column", async () => {
    await waitFor(
      "Card in QA column",
      async () => {
        const col = await getItemColumn(projectItemId);
        return col === "QA" ? col : null;
      },
      5 * 60 * 1000
    );
  }, 6 * 60 * 1000);

  it("QA: Test results posted as comment", async () => {
    await waitFor(
      "Test results comment posted",
      async () => {
        const comments = await getIssueComments(issueNumber);
        return comments.find(c =>
          c.body.includes("passed") || c.body.includes("failed") ||
          c.body.includes("test") && c.body.includes("✓")
        ) || null;
      },
      15 * 60 * 1000
    );
  }, 16 * 60 * 1000);

  it("REVIEW: Card moved to Review column", async () => {
    await waitFor(
      "Card in Review column",
      async () => {
        const col = await getItemColumn(projectItemId);
        return col === "Review" ? col : null;
      },
      5 * 60 * 1000
    );
  }, 6 * 60 * 1000);

  it("REVIEW: Deployed service health endpoint responds", async () => {
    await waitFor(
      "Health endpoint responding",
      async () => {
        try {
          const res = await fetch(`${TEST_APP_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
          return res.ok ? true : null;
        } catch { return null; }
      },
      10 * 60 * 1000,
      10_000
    );
  }, 11 * 60 * 1000);

  it("ACCEPTED: Card moved to Done column", async () => {
    await waitFor(
      "Card in Done column",
      async () => {
        const col = await getItemColumn(projectItemId);
        return col === "Done" ? col : null;
      },
      10 * 60 * 1000
    );
  }, 11 * 60 * 1000);
});
```

**Step 4: Verify the test file typechecks (won't run yet — cluster not set up)**

```bash
cd /Users/jay.barreto/dev/util/bto/mesh-six && bun run tsc --noEmit tests/e2e/full-lifecycle.test.ts 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add tests/
git commit -m "feat: add E2E test scaffolding for full lifecycle validation"
```

---

### Task 5: Push all Phase 1 code changes

**Step 1: Push to main**

```bash
git push origin main
```

**Step 2: Monitor CI/CD run**

In GitHub: Actions tab → `build-deploy.yaml` run → watch each Kaniko job.

Expected: All 17 agents + dashboard build and push successfully. Rollout restarts begin.

**Step 3: Watch for failures, check logs if any agent fails**

```bash
# From cluster access (via kubectl or k9s)
kubectl get pods -n mesh-six --watch
```

---

## Phase 2: Cluster Infrastructure Setup (One-Time Manual Commands)

These are `kubectl` commands run once. They are not automated by CI/CD.

**Prerequisites:** kubectl configured pointing at k3s cluster with sufficient RBAC.

---

### Task 6: Create K8s secrets in mesh-six namespace

**Reference:** Values come from `.env` file in repo root.

**Step 1: Create namespace (if ArgoCD hasn't yet)**

```bash
kubectl create namespace mesh-six --dry-run=client -o yaml | kubectl apply -f -
```

**Step 2: PostgreSQL secret**

```bash
kubectl create secret generic postgres-secret \
  --from-literal=url='postgresql://admin:admin123@pgsql.k3s.bto.bar:5432/mesh_six' \
  --from-literal=username='admin' \
  --from-literal=password='admin123' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 3: LiteLLM secret**

```bash
kubectl create secret generic litellm-secret \
  --from-literal=api-key='sk-8jNdC36tpNhpJUQ7qj1P2Q' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 4: Redis secret** (password for `redis-cluster.redis:6379`)

```bash
# Get Redis password from cluster:
REDIS_PASS=$(kubectl get secret -n redis-system redis-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo "")
kubectl create secret generic redis-secret \
  --from-literal=password="${REDIS_PASS}" \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 5: RabbitMQ secret**

```bash
kubectl create secret generic rabbitmq-secret \
  --from-literal=url='amqp://admin:password123@rabbitmq-amqp.k3s.bto.bar:5672/' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 6: Gitea registry pull secret**

```bash
kubectl create secret docker-registry gitea-registry-secret \
  --docker-server=registry.bto.bar \
  --docker-username=registry-user \
  --docker-password='<gitea-token>' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 7: GitHub secrets for webhook-receiver and project-manager**

```bash
# GitHub personal access token with: repo, project scopes
kubectl create secret generic github-secret \
  --from-literal=token='<github-pat-token>' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -

# Webhook secret — must match what you configure in GitHub webhook settings
kubectl create secret generic github-webhook-secret \
  --from-literal=secret='<choose-a-random-string>' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

Note the webhook secret value — you'll need it in Phase 4.

**Step 8: Optional infra secrets (for M5 agents)**

```bash
kubectl create secret generic cloudflare-secret \
  --from-literal=api-token='<cloudflare-api-token>' \
  -n mesh-six \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Step 9: Verify all secrets exist**

```bash
kubectl get secrets -n mesh-six
```

Expected: `postgres-secret`, `litellm-secret`, `redis-secret`, `rabbitmq-secret`, `gitea-registry-secret`, `github-secret`, `github-webhook-secret` all present.

---

### Task 7: Apply ArgoCD Application

**Step 1: Apply the ArgoCD Application manifest**

```bash
kubectl apply -f k8s/argocd-application.yaml
```

**Step 2: Wait for ArgoCD to sync**

```bash
kubectl get application mesh-six -n argocd --watch
```

Expected: `STATUS: Synced, HEALTH: Healthy` within 2–3 minutes.

**Step 3: Check for sync errors**

```bash
kubectl describe application mesh-six -n argocd | grep -A20 "Sync Status"
```

If there are errors (e.g., CRD not found for IngressRoute), fix in code and push again.

---

### Task 8: Apply Dapr components directly (temporary until ArgoCD syncs Task 1)

If ArgoCD hasn't synced Task 1 yet, apply manually:

```bash
kubectl apply -f dapr/components/ -n mesh-six
```

Verify components are registered with Dapr:

```bash
kubectl get components -n mesh-six
```

Expected: `agent-statestore`, `agent-pubsub`, `agent-statestore-outbox`, `agent-resiliency` all listed.

---

### Task 9: Run database migrations

**Step 1: Set DATABASE_URL to production**

```bash
export DATABASE_URL='postgresql://admin:admin123@pgsql.k3s.bto.bar:5432/mesh_six'
```

**Step 2: Run migrations**

```bash
cd /Users/jay.barreto/dev/util/bto/mesh-six
bun run db:migrate
```

Expected output:
```
Running migration: 001_agent_task_history.sql ✓
Running migration: 002_repo_registry.sql ✓
Running migration: 003_mesh_six_events.sql ✓
Running migration: 004_pm_workflow_instances.sql ✓
All migrations complete.
```

**Step 3: Verify tables exist**

```bash
psql $DATABASE_URL -c "\dt" | grep -E "agent_task_history|repo_registry|mesh_six_events|pm_workflow_instances"
```

---

## Phase 3: Create the Test App (`bto-labs/gwa-test-app`)

This is the test fixture for the E2E test. It can be done in parallel with Phase 2.

---

### Task 10: Create `bto-labs/gwa-test-app` GitHub repo

**Step 1: Create repo via GitHub CLI**

```bash
gh repo create bto-labs/gwa-test-app --public --description "Bookmarks manager — mesh-six E2E test fixture"
```

**Step 2: Initialize the bookmarks app locally and push**

Create a new directory (outside of mesh-six repo):

```bash
mkdir /tmp/gwa-test-app && cd /tmp/gwa-test-app && git init
```

**`package.json`:**
```json
{
  "name": "gwa-test-app",
  "version": "1.0.0",
  "scripts": {
    "dev": "bun run src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bunx playwright test",
    "build": "bun build src/index.ts --outdir dist --target bun"
  },
  "dependencies": {
    "hono": "^4.0.0",
    "better-sqlite3": "^9.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.40.0"
  }
}
```

**`src/index.ts`** (bookmarks CRUD with SQLite):
```typescript
import { Hono } from "hono";
import Database from "better-sqlite3";

const app = new Hono();
const db = new Database(process.env.DB_PATH || "bookmarks.db");

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.get("/healthz", (c) => c.json({ status: "ok", version: "1.0.0" }));
app.get("/readyz", (c) => c.json({ status: "ready" }));

app.get("/bookmarks", (c) => {
  const bookmarks = db.prepare("SELECT * FROM bookmarks ORDER BY created_at DESC").all();
  return c.json(bookmarks);
});

app.post("/bookmarks", async (c) => {
  const body = await c.req.json();
  const result = db.prepare(
    "INSERT INTO bookmarks (title, url, description) VALUES (?, ?, ?)"
  ).run(body.title, body.url, body.description || null);
  return c.json({ id: result.lastInsertRowid }, 201);
});

app.get("/bookmarks/:id", (c) => {
  const bookmark = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(c.req.param("id"));
  if (!bookmark) return c.json({ error: "Not found" }, 404);
  return c.json(bookmark);
});

app.put("/bookmarks/:id", async (c) => {
  const body = await c.req.json();
  db.prepare(
    "UPDATE bookmarks SET title = ?, url = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(body.title, body.url, body.description || null, c.req.param("id"));
  return c.json({ success: true });
});

app.delete("/bookmarks/:id", (c) => {
  db.prepare("DELETE FROM bookmarks WHERE id = ?").run(c.req.param("id"));
  return c.json({ success: true });
});

export default {
  port: Number(process.env.PORT || 3000),
  fetch: app.fetch,
};
```

**`CLAUDE.md`** (gives context to Claude Code running in this repo):
```markdown
# gwa-test-app

Bun + Hono bookmarks manager. SQLite via better-sqlite3.

## Commands
- `bun run dev` — start dev server on port 3000
- `bun test` — run Playwright tests

## Structure
- `src/index.ts` — Hono routes + SQLite setup
- `tests/` — Playwright tests
- `bookmarks.db` — SQLite database (gitignored)

## Health endpoints
- GET /healthz — liveness
- GET /readyz — readiness
```

**`playwright.config.ts`:**
```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: process.env.BASE_URL || "http://localhost:3000" },
});
```

**`tests/smoke.spec.ts`:**
```typescript
import { test, expect } from "@playwright/test";

test("health check responds", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
});

test("can create and list a bookmark", async ({ request }) => {
  const created = await request.post("/bookmarks", {
    data: { title: "Test", url: "https://example.com" }
  });
  expect(created.ok()).toBeTruthy();
  const list = await request.get("/bookmarks");
  const bookmarks = await list.json();
  expect(bookmarks.some((b: any) => b.url === "https://example.com")).toBeTruthy();
});

test("can delete a bookmark", async ({ request }) => {
  const created = await request.post("/bookmarks", {
    data: { title: "ToDelete", url: "https://delete-me.com" }
  });
  const { id } = await created.json();
  const deleted = await request.delete(`/bookmarks/${id}`);
  expect(deleted.ok()).toBeTruthy();
});
```

**Step 3: Push to GitHub**

```bash
cd /tmp/gwa-test-app
bun install
git add -A
git commit -m "init: bookmarks manager baseline"
git remote add origin https://github.com/bto-labs/gwa-test-app.git
git push -u origin main
git tag baseline
git push origin baseline
```

---

### Task 11: Set up GitHub Projects board for `bto-labs/gwa-test-app`

**Step 1: Create GitHub Projects v2 board via GitHub CLI**

```bash
gh project create --owner bto-labs --title "gwa-test-app Workflow" --format json
```

Note the project number from the output.

**Step 2: Add Status field with required columns via GitHub web UI or CLI**

Required columns (in order): `Todo`, `Planning`, `In Progress`, `QA`, `Review`, `Done`, `Blocked`

Via web UI: Open the project → Add field → Single select → Add each option.

**Step 3: Get Project ID and Status Field ID via GraphQL**

```bash
gh api graphql -f query='
{
  organization(login: "bto-labs") {
    projectV2(number: <PROJECT_NUMBER>) {
      id
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}' | jq '{projectId: .data.organization.projectV2.id, statusField: (.data.organization.projectV2.fields.nodes[] | select(.name == "Status"))}'
```

Note down: `projectId` (starts with `PVT_`) and `statusFieldId`.

---

### Task 12: Update webhook-receiver deployment with GitHub Project IDs

**Step 1: Update `k8s/base/webhook-receiver/deployment.yaml`**

Replace the empty `GITHUB_PROJECT_ID` and `GITHUB_STATUS_FIELD_ID` values:

```yaml
- name: GITHUB_PROJECT_ID
  value: "PVT_xxxxxxxxxxxx"   # from Task 11 Step 3
- name: GITHUB_STATUS_FIELD_ID
  value: "PVTSSF_xxxxxxxxxxxx"  # from Task 11 Step 3
```

**Step 2: Commit and push (triggers ArgoCD sync)**

```bash
git add k8s/base/webhook-receiver/deployment.yaml
git commit -m "config: set GitHub Project ID and Status Field ID for webhook-receiver"
git push origin main
```

**Step 3: Verify webhook-receiver pod restarts with new env vars**

```bash
kubectl rollout status deployment/webhook-receiver -n mesh-six
kubectl exec -n mesh-six deployment/webhook-receiver -- env | grep GITHUB_PROJECT
```

---

### Task 13: Configure GitHub webhook

**Step 1: Get webhook-receiver external URL**

After ArgoCD syncs the IngressRoute, the webhook-receiver is at: `https://mesh-six.bto.bar/webhooks/github`

**Step 2: Register webhook on `bto-labs/gwa-test-app`**

In GitHub repo settings → Webhooks → Add webhook:
- **Payload URL:** `https://mesh-six.bto.bar/webhooks/github`
- **Content type:** `application/json`
- **Secret:** (the value you used for `github-webhook-secret` in Task 6 Step 7)
- **Events:** Select "Let me select individual events" → check **Projects v2 item** only

**Step 3: Send a test ping and verify**

GitHub sends a ping event on webhook creation. Check webhook-receiver logs:

```bash
kubectl logs -n mesh-six deployment/webhook-receiver --tail=50
```

Expected: `Webhook ping received and validated`.

---

### Task 14: Register `gwa-test-app` in the `repo_registry` table

This tells the PM agent what repo to use and how to interact with it.

```bash
psql $DATABASE_URL -c "
INSERT INTO repo_registry (
  service_name, platform, repo_url, default_branch,
  cicd_type, trigger_method, board_id, metadata
) VALUES (
  'gwa-test-app',
  'github',
  'https://github.com/bto-labs/gwa-test-app',
  'main',
  'github-actions',
  'project-board',
  '<the project board ID from Task 11>',
  '{\"owner\": \"bto-labs\", \"repo\": \"gwa-test-app\", \"deployUrl\": \"https://test-app.bto.bar\"}'::jsonb
) ON CONFLICT (service_name) DO UPDATE
SET board_id = EXCLUDED.board_id, metadata = EXCLUDED.metadata;
"
```

---

## Phase 4: Verify Each Milestone (Smoke Tests)

All smoke tests assume pods are running. Verify first:

```bash
kubectl get pods -n mesh-six | grep -v "Running\|Completed" | grep -v NAME
```

If any pods are not `Running`, check logs:
```bash
kubectl logs -n mesh-six deployment/<agent-name> --tail=50
```

---

### Task 15: Smoke test Milestone 1 — Orchestrator + Simple Agent

**Step 1: Send a task to the orchestrator**

```bash
kubectl exec -n mesh-six deployment/orchestrator -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "general-query", "payload": {"query": "What is 2+2?"}, "priority": 5, "timeout": 30}' | jq .
```

Expected: `{"taskId": "...", "status": "dispatched"}` or similar.

**Step 2: Check simple-agent received and processed the task**

```bash
kubectl logs -n mesh-six deployment/simple-agent --tail=20
```

Expected: Log lines showing task receipt and LLM call.

**Step 3: Verify task result in `agent_task_history`**

```bash
psql $DATABASE_URL -c "SELECT agent_id, capability, success, duration_ms FROM agent_task_history ORDER BY created_at DESC LIMIT 5;"
```

Expected: Row with `agent_id = 'simple-agent'`, `success = true`.

**Step 4: Verify agent is registered in registry**

```bash
kubectl exec -n mesh-six deployment/orchestrator -- curl -s http://localhost:3000/agents | jq '.[].appId'
```

Expected: `"simple-agent"` appears in the list.

**M1 Status:** Pass if orchestrator dispatches, simple-agent responds, and history records the result. ✓

---

### Task 16: Smoke test Milestone 2 — Memory layer

**Step 1: Send two sequential queries to simple-agent, verify memory on second**

```bash
# First query — stores "user prefers concise answers" in memory
kubectl exec -n mesh-six deployment/orchestrator -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "general-query", "payload": {"query": "I prefer concise answers. What is the capital of France?", "userId": "test-smoke"}, "priority": 5, "timeout": 30}'

# Wait 5 seconds for Mem0 to process
sleep 5

# Second query — should retrieve memory context about concise preference
kubectl exec -n mesh-six deployment/orchestrator -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "general-query", "payload": {"query": "What is the capital of Germany?", "userId": "test-smoke"}, "priority": 5, "timeout": 30}'
```

**Step 2: Check simple-agent logs for memory retrieval on second query**

```bash
kubectl logs -n mesh-six deployment/simple-agent --tail=30 | grep -i "memor"
```

Expected: Log lines showing `Retrieved N memories` or `Relevant Context from Memory`.

**M2 Status:** Pass if memory retrieval is logged on the second query. ✓

---

### Task 17: Smoke test Milestone 3 — Specialist agents

**Step 1: Test architect consultation**

```bash
kubectl exec -n mesh-six deployment/architect-agent -- curl -s -X POST http://localhost:3000/consult \
  -H "Content-Type: application/json" \
  -d '{"question": "Should we use Redis or PostgreSQL for caching session state?", "requireStructured": true}' | jq '.summary'
```

Expected: Non-empty structured recommendation.

**Step 2: Test deployer routing — send a deploy task**

```bash
kubectl exec -n mesh-six deployment/orchestrator -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "deploy-service", "payload": {"service": "test-service"}, "priority": 5, "timeout": 30}' | jq .
```

**Step 3: Verify scoring selected ArgoCD deployer (higher weight 0.9 vs kubectl 0.7)**

```bash
kubectl exec -n mesh-six deployment/orchestrator -- curl -s "http://localhost:3000/agents/score/deploy-service" | jq '.[] | {agentId, finalScore}'
```

Expected: `argocd-deployer` score > `kubectl-deployer` score.

**M3 Status:** Pass if architect returns structured output and ArgoCD deployer has higher score. ✓

---

### Task 18: Smoke test Milestone 4 — Dashboard and MQTT

**Step 1: Open dashboard in browser**

Navigate to `https://mesh-six.bto.bar` — should load the mesh-six monitoring dashboard.

**Step 2: Verify agent registry view shows running agents**

The Agent Registry view should list: orchestrator, simple-agent, architect-agent, researcher-agent, etc.

**Step 3: Send a task and verify it appears in Task Feed**

Send any task to orchestrator (reuse Task 15 Step 1), then check the dashboard Task Feed view for real-time MQTT events.

**Step 4: Verify Claude MQTT Bridge is functional**

```bash
kubectl logs -n mesh-six deployment/claude-mqtt-bridge --tail=20
```

Expected: No crash loop, waiting for stdin events.

**M4 Status:** Pass if dashboard loads and shows agents in registry. ✓

---

### Task 19: Smoke test Milestone 5 — Infrastructure agents

**Step 1: Test homelab monitor**

```bash
kubectl exec -n mesh-six deployment/orchestrator -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "cluster-health", "payload": {"query": "What is the current state of the mesh-six namespace?"}, "priority": 5, "timeout": 60}' | jq .
```

**Step 2: Verify homelab monitor logged**

```bash
kubectl logs -n mesh-six deployment/homelab-monitor --tail=20
```

**Step 3: Test cost tracker on-demand query**

```bash
kubectl exec -n mesh-six deployment/cost-tracker -- curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"capability": "cost-reporting", "payload": {"period": "today"}, "priority": 5, "timeout": 30}' | jq .
```

**M5 Status:** Pass if homelab monitor responds with cluster state summary. ✓

---

### Task 20: Smoke test Event Log

**Step 1: Query mesh_six_events for recent entries from smoke tests**

```bash
psql $DATABASE_URL -c "
SELECT event_type, agent_id, timestamp
FROM mesh_six_events
WHERE timestamp > NOW() - INTERVAL '30 minutes'
ORDER BY seq DESC
LIMIT 20;
"
```

Expected: `llm.call`, `llm.response`, `state.transition` events from the smoke tests above.

**Event Log Status:** Pass if events appear in the table. ✓

---

## Phase 5: End-to-End Test

Run only after all milestone smoke tests pass.

---

### Task 21: Run the full lifecycle E2E test

**Step 1: Set required environment variables**

```bash
export GITHUB_TOKEN='<github-pat-with-repo-and-project-scopes>'
export TEST_PROJECT_ID='PVT_xxxxxxxxxxxx'   # from Task 11
export TEST_REPO_OWNER='bto-labs'
export TEST_REPO_NAME='gwa-test-app'
export TEST_APP_URL='https://test-app.bto.bar'
export DATABASE_URL='postgresql://admin:admin123@pgsql.k3s.bto.bar:5432/mesh_six'
```

**Step 2: Run the E2E test**

```bash
cd /Users/jay.barreto/dev/util/bto/mesh-six
bun test tests/e2e/full-lifecycle.test.ts --timeout 3600000
```

Total timeout: 1 hour (the test has internal per-assertion timeouts).

**Step 3: Monitor in parallel**

While the test runs, watch:
- Dashboard at `https://mesh-six.bto.bar` — task feed should show PM activity
- `kubectl logs -n mesh-six deployment/project-manager -f` — PM workflow transitions
- GitHub project board — card should move through columns

**Step 4: Review results**

```bash
# After test completes, query the full event trace
psql $DATABASE_URL -c "
SELECT event_type, agent_id, payload->>'model' as model, timestamp
FROM mesh_six_events
WHERE timestamp > NOW() - INTERVAL '2 hours'
ORDER BY seq ASC;
" | head -100
```

**E2E Status:** Pass when all assertions pass and card reaches Done column. ✓

---

## Dependency Graph

```
Task 1 (Dapr kustomize) ──┐
Task 2 (Dashboard build) ──┼──► Task 5 (Push) ──► CI/CD builds all images
Task 3 (IngressRoutes) ────┤
Task 4 (E2E scaffold) ─────┘

Task 6 (K8s secrets) ──────┐
Task 7 (ArgoCD apply) ─────┼──► All pods running ──► Tasks 15-20 (smoke tests)
Task 8 (Dapr components) ──┤
Task 9 (DB migrations) ────┘

Task 10 (test app) ────────┐
Task 11 (project board) ───┼──► Task 12 (deploy update) ──► Task 13 (GitHub webhook) ──► Task 14 (repo_registry) ──► Task 21 (E2E test)
                           └──► Task 14 (repo_registry)

Tasks 15-20 (smoke tests) ──► Task 21 (E2E test)
```

Tasks 1-4 (code changes) and Tasks 10-11 (test app) can all be done in **parallel** before any cluster access.

---

## Quick Reference: Key URLs and Commands

| Resource | URL / Command |
|----------|---------------|
| Dashboard | `https://mesh-six.bto.bar` |
| Webhook receiver | `https://mesh-six.bto.bar/webhooks/github` |
| Orchestrator API | `kubectl exec -n mesh-six deployment/orchestrator -- curl http://localhost:3000/tasks` |
| Orchestrator agent scores | `kubectl exec -n mesh-six deployment/orchestrator -- curl http://localhost:3000/agents/score/<capability>` |
| Check all pods | `kubectl get pods -n mesh-six` |
| ArgoCD app status | `kubectl get application mesh-six -n argocd` |
| Dapr components | `kubectl get components -n mesh-six` |
| Event log | `psql $DATABASE_URL -c "SELECT * FROM mesh_six_events ORDER BY seq DESC LIMIT 10"` |
| Task history | `psql $DATABASE_URL -c "SELECT * FROM agent_task_history ORDER BY created_at DESC LIMIT 10"` |
| PM workflow instances | `psql $DATABASE_URL -c "SELECT * FROM pm_workflow_instances"` |
| Run E2E test | `bun test tests/e2e/full-lifecycle.test.ts --timeout 3600000` |
| Run DB migrations | `bun run db:migrate` |
