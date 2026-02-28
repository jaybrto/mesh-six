# Mesh Six — Implementation Plan

> A microservices-based multi-agent orchestration system for Jay's homelab k3s cluster.
> Each milestone is self-contained and delivers immediately useful functionality.
> This document is designed to be handed to Claude Code sessions as a project brief.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Key Decisions](#key-decisions)
3. [Technology Stack](#technology-stack)
4. [Agent Roster](#agent-roster)
5. [Milestone 1 — Hello Agent](#milestone-1--hello-agent)
6. [Milestone 2 — Memory Layer](#milestone-2--memory-layer)
7. [Milestone 3 — Specialist Agents](#milestone-3--specialist-agents)
8. [Milestone 4 — Project Manager Agent](#milestone-4--project-manager-agent)
9. [Milestone 4.5 — GWA Integration](#milestone-45--gwa-integration-pm-agent--github-workflow-agents)
10. [Milestone 5 — Infrastructure Agents](#milestone-5--infrastructure-agents)
11. [Milestone 6 — Context Service](#milestone-6--context-service)
12. [Event Log — Standalone Module](#event-log--standalone-module)
13. [Cross-Cutting Concerns](#cross-cutting-concerns)
14. [Repository Structure](#repository-structure)
15. [Deployment Strategy](#deployment-strategy)

---

## Architecture Overview

Mesh Six is a collection of independent microservices deployed to a 6-node k3s cluster. Each agent is a Bun HTTP server with a Dapr sidecar that provides state management, pub/sub messaging, and service-to-service invocation. Agents communicate exclusively through Dapr — never directly to each other.

```
┌──────────────────────────────────────────────────────────────┐
│                        k3s Cluster                           │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Orchestrator│  │  Architect  │  │  Researcher  │         │
│  │ + Dapr      │  │  + Dapr     │  │  + Dapr      │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                  │
│         └────────────────┼────────────────┘                  │
│                          │                                   │
│                    ┌─────┴──────┐                            │
│                    │  RabbitMQ  │  (pub/sub + task routing)  │
│                    │  (HA)      │                            │
│                    └─────┬──────┘                            │
│                          │                                   │
│         ┌────────────────┼────────────────┐                  │
│         │                │                │                  │
│  ┌──────┴──────┐  ┌─────┴──────┐  ┌─────┴───────┐         │
│  │   ArgoCD    │  │  kubectl   │  │   Project   │         │
│  │  Deployer   │  │  Deployer  │  │  Manager    │         │
│  │  + Dapr     │  │  + Dapr    │  │  + Dapr     │         │
│  └─────────────┘  └────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                 Shared Infrastructure                │    │
│  │  ┌──────────┐  ┌──────────┐                        │    │
│  │  │PostgreSQL│  │  Redis   │                        │    │
│  │  │HA + pgvec│  │  Cluster │                        │    │
│  │  └──────────┘  └──────────┘                        │    │
│  │  ┌──────────┐  ┌──────────┐                        │    │
│  │  │  Ollama  │  │ LiteLLM  │  (LLM Gateway)        │    │
│  │  └──────────┘  └──────────┘                        │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Communication Patterns

- **Request-Response** (agent-to-agent consultation): Dapr service invocation (HTTP via sidecar). Used when one agent needs synchronous input from another (e.g., PM asks Architect for tech stack guidance).
- **Async Task Dispatch** (orchestrator-to-agent): Dapr pub/sub over RabbitMQ. Orchestrator publishes a task, the best-scored agent's subscription picks it up.
- **Progress Events** (agent-to-orchestrator): Dapr pub/sub over RabbitMQ. Agents publish status updates as they work. Optional MQTT over websockets for real-time dashboard.
- **State Persistence**: Dapr state store backed by Redis (short-term/session) and PostgreSQL (long-term/history).
- **Outbox Pattern**: Dapr outbox for atomic state+message operations (e.g., agent completes task AND publishes result atomically).

---

## Key Decisions

These decisions were made through extensive design discussion and should not be revisited without strong justification.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary Language | Bun/TypeScript | Fastest iteration speed, best AI SDK ecosystem, Jay's preference. Go for future performance-critical extractions. |
| LLM Module | Custom `@mesh-six/core` llm.ts | Direct LiteLLM HTTP calls via OpenAI-compatible API. `chatCompletion()`, `chatCompletionWithSchema()` (Zod schema → prompt injection), `tracedChatCompletion()` with event logging. Replaced Vercel AI SDK. |
| Agent Communication | Dapr (service invocation + pub/sub) | Language-agnostic, observability built-in, decouples agents from infrastructure. Already deployed in cluster. |
| Message Broker | RabbitMQ | Primary messaging infra, HA via operator, quorum queues, MQTT plugin for real-time. Replaces NATS for agent comms. |
| LLM Gateway | Existing Ollama + LiteLLM | Already running. OpenAI-compatible API consumed directly via fetch in `@mesh-six/core` llm module. |
| Memory Layer | Mem0 via `mem0ai` npm package | Direct TypeScript integration. pgvector for vectors, Ollama for embeddings/extraction. No separate container. |
| Short-term Memory | Redis (via Dapr state store) | Session context, agent working memory. Already running HA. |
| Long-term Memory | PostgreSQL + pgvector (via Mem0) | Persistent memory, vector similarity search. Already running HA (3-pod). |
| Agent Discovery | Custom registry in Dapr state store | Lightweight, ~50 lines. Agents self-register with capabilities, health checks, weights. |
| Agent Scoring | Weighted routing with historical performance | Base weights + dependency health checks + rolling success rate from task history. |
| Hosting Model | Standalone services + Dapr Actors | Most agents are standalone HTTP services. Architect and Implementer use Dapr Actors for per-issue state isolation. LLM Service uses actors for credential-scoped concurrency control. |
| Failure Handling | Option A — timeout + retry + re-score | Agent timeout → report failure → orchestrator re-scores → dispatch to next agent. No mid-task failover (Milestone 1). |
| Deployment | ArgoCD + GitOps | All agent manifests in Git. Kustomize for environment overlays. Standard homelab pattern. |
| Observability | OpenTelemetry → Grafana LGTM stack | Dapr emits traces/metrics automatically. Flows to existing Grafana/Loki/Mimir/Tempo. |

---

## Technology Stack

### Runtime & Libraries

| Component | Package | Purpose |
|-----------|---------|---------|
| Runtime | `bun` (latest) | JavaScript/TypeScript runtime |
| LLM Module | `@mesh-six/core` llm.ts | Direct LiteLLM HTTP calls (OpenAI-compatible). `chatCompletion()`, `chatCompletionWithSchema()`, `tracedChatCompletion()` |
| Dapr Client | `@dapr/dapr` | State, pub/sub, service invocation, bindings |
| HTTP Server | `Hono` | Lightweight HTTP framework for agent endpoints |
| Validation | `zod` | Schema validation for structured outputs and messages |
| Task History | `pg` | Direct PostgreSQL queries for agent scoring (PgBouncer compatible) |
| GitHub API | `@octokit/rest` + `@octokit/graphql` | GitHub Projects v2, issue management, PR operations |
| Memory | `mem0ai` | Vector memory storage with pgvector + Ollama embeddings |

### Infrastructure (Already Running)

| Service | Role in Mesh Six |
|---------|-------------------|
| RabbitMQ HA (operator) | Pub/sub backbone, task routing, MQTT events |
| PostgreSQL HA (3-pod) | Task history, agent scoring, Mem0 vectors, auth credentials, implementation sessions, architect events, workflow instances, session checkpoints |
| Redis Cluster | Dapr state store (agent registry, session state) |
| Ollama + LiteLLM | LLM inference gateway |
| ArgoCD | GitOps deployment of agent services |
| Traefik | Ingress for agent HTTP endpoints |
| Caddy | Reverse proxy for external access |
| Grafana LGTM | Observability (traces, logs, metrics) |
| Dapr | Sidecar runtime for all agents |

### New Infrastructure (Deployed)

| Service | Milestone | Purpose |
|---------|-----------|---------|
| pgvector extension | 2 | Vector similarity search in PostgreSQL (v0.7.0, already enabled) |

---

## Agent Roster

| Agent | Dapr App ID | Type | Communication | Milestone |
|-------|-------------|------|---------------|-----------|
| Orchestrator | `orchestrator` | Long-running service | Pub/sub (dispatch), service invocation (query) | 1 |
| Simple Agent | `simple-agent` | Request-response | Pub/sub (receive tasks) | 1 |
| ArgoCD Deployer | `argocd-deployer` | Request-response | Pub/sub (receive tasks) | 3 |
| Kubectl Deployer | `kubectl-deployer` | Request-response | Pub/sub (receive tasks) | 3 |
| Architect | `architect-agent` | Dapr Actor (per-issue) | Service invocation + actor methods | 3, 4.5 |
| Researcher | `researcher-agent` | Request-response | Service invocation (consulted by Architect/PM) | 3 |
| QA Tester | `qa-tester` | Request-response | Pub/sub (receive tasks) | 3 |
| API Coder | `api-coder` | Request-response | Pub/sub (receive tasks) | 3 |
| UI Agent | `ui-agent` | Request-response | Pub/sub (receive tasks) | 3 |
| Project Manager | `project-manager` | Dapr Workflow (long-running) | Pub/sub + service invocation + workflow + external events | 4, 4.5 |
| Claude MQTT Bridge | `claude-mqtt-bridge` | Infrastructure | MQTT publish (Claude hooks) | 4 |
| Dashboard | `dashboard` | Web UI | MQTT WebSocket (read-only) | 4 |
| Webhook Receiver | `webhook-receiver` | Infrastructure | HTTP webhook + Dapr pub/sub | 4.5 |
| Auth Service | `auth-service` | Infrastructure | Service invocation (credential provisioning) | 4.5 |
| Implementer | `implementer` | Dapr Actor StatefulSet | Actor methods + Dapr workflow events | 4.5 |
| LLM Service | `llm-service` | Dapr Actor | Service invocation (Claude CLI gateway) | 4.5 |
| Homelab Monitor | `homelab-monitor` | Request-response | Pub/sub (receive tasks) | 5 |
| Infra Manager | `infra-manager` | Request-response | Pub/sub (receive tasks) | 5 |
| Cost Tracker | `cost-tracker` | Request-response | Scheduled + on-demand | 5 |
| Context Service | `context-service` | Infrastructure | Service invocation (called by PM workflow) | 6 |
| Event Logger | `event-logger` | Infrastructure | Pub/sub subscriber (event tap) | Standalone |

---

## Milestone 1 — Hello Agent

**Goal**: Prove the entire pattern end-to-end. One agent, one orchestrator, Dapr sidecars, RabbitMQ pub/sub, Redis state, deployed to k3s via ArgoCD.

**Deliverables**: Working orchestrator + simple agent that answers questions using LiteLLM gateway. Agent self-registers in registry. Orchestrator discovers and dispatches to agent. Full observability in Grafana.

**Value**: A self-hosted AI assistant reachable via your Caddy/Cloudflare setup.

### 1.1 — Shared Library: `@mesh-six/core`

A shared package containing types, utilities, and the Dapr integration layer that every agent uses.

Includes: `types.ts` (shared interfaces), `registry.ts` (agent discovery via Dapr state),
`scoring.ts` (weighted routing + historical performance), `memory.ts` (Mem0 client wrapper),
and `context.ts` (context builder + reflect-before-reset pattern — see Cross-Cutting Concerns).

```typescript
// packages/core/src/types.ts

export interface AgentCapability {
  name: string;
  weight: number;           // 0.0-1.0, base confidence
  preferred: boolean;       // tiebreaker when scores are equal
  requirements: string[];   // dependency health check keys
  async?: boolean;          // long-running workflow?
  estimatedDuration?: string;
  platforms?: string[];     // e.g., ["github", "gitea"]
}

export interface AgentRegistration {
  name: string;
  appId: string;            // Dapr app-id
  capabilities: AgentCapability[];
  status: "online" | "degraded" | "offline";
  healthChecks: Record<string, string>;  // key → URL
  lastHeartbeat: string;    // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface TaskRequest {
  id: string;               // UUID
  capability: string;       // e.g., "deploy-service"
  payload: Record<string, unknown>;
  priority: number;         // 0 (low) - 10 (critical)
  timeout: number;          // seconds
  requestedBy: string;      // Dapr app-id of requester
  createdAt: string;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  result?: Record<string, unknown>;
  error?: {
    type: string;           // timeout, api_error, permission, etc.
    message: string;
  };
  durationMs: number;
  completedAt: string;
}

export interface AgentScoreCard {
  agentId: string;
  capability: string;
  baseWeight: number;
  dependencyHealth: number;  // 0 or 1
  rollingSuccessRate: number; // 0.0-1.0, last 20 tasks
  recencyBoost: number;     // more recent successes count more
  finalScore: number;       // computed composite
}
```

```typescript
// packages/core/src/registry.ts

import { DaprClient } from "@dapr/dapr";

const STATE_STORE = "agent-statestore"; // Dapr component name (Redis)
const REGISTRY_PREFIX = "agent:";

export class AgentRegistry {
  constructor(private dapr: DaprClient) {}

  async register(registration: AgentRegistration): Promise<void> {
    await this.dapr.state.save(STATE_STORE, [
      { key: `${REGISTRY_PREFIX}${registration.appId}`, value: registration }
    ]);
  }

  async heartbeat(appId: string): Promise<void> {
    const agent = await this.get(appId);
    if (agent) {
      agent.lastHeartbeat = new Date().toISOString();
      agent.status = "online";
      await this.register(agent);
    }
  }

  async get(appId: string): Promise<AgentRegistration | null> {
    const result = await this.dapr.state.get(STATE_STORE, `${REGISTRY_PREFIX}${appId}`);
    return result || null;
  }

  async findByCapability(capability: string): Promise<AgentRegistration[]> {
    // Note: Dapr state query API or scan all registered agents
    // For small agent counts (<50), listing all and filtering in-memory is fine
    const agents = await this.listAll();
    return agents.filter(a =>
      a.status !== "offline" &&
      a.capabilities.some(c => c.name === capability)
    );
  }

  async listAll(): Promise<AgentRegistration[]> {
    // Implementation depends on state store query support
    // Redis: use SCAN with prefix pattern via Dapr query API
    // Fallback: maintain an index key "agent:_index" listing all app-ids
  }

  async deregister(appId: string): Promise<void> {
    await this.dapr.state.delete(STATE_STORE, `${REGISTRY_PREFIX}${appId}`);
  }
}
```

```typescript
// packages/core/src/scoring.ts

import postgres from "postgres";

const ROLLING_WINDOW = 20; // last N tasks
const RECENCY_DECAY = 0.95; // exponential decay factor

export class AgentScorer {
  constructor(private sql: postgres.Sql) {}

  async scoreAgents(
    agents: AgentRegistration[],
    capability: string
  ): Promise<AgentScoreCard[]> {
    const scores: AgentScoreCard[] = [];

    for (const agent of agents) {
      const cap = agent.capabilities.find(c => c.name === capability);
      if (!cap) continue;

      // Check dependency health
      let dependencyHealth = 1;
      for (const req of cap.requirements) {
        const url = agent.healthChecks[req];
        if (url) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) dependencyHealth = 0;
          } catch {
            dependencyHealth = 0;
          }
        }
      }

      // Rolling success rate with recency weighting
      const history = await this.sql`
        SELECT success, created_at
        FROM agent_task_history
        WHERE agent_id = ${agent.appId}
          AND capability = ${capability}
        ORDER BY created_at DESC
        LIMIT ${ROLLING_WINDOW}
      `;

      let rollingSuccessRate = 1.0; // default if no history
      let recencyBoost = 1.0;

      if (history.length > 0) {
        let weightedSuccess = 0;
        let totalWeight = 0;
        history.forEach((row, i) => {
          const weight = Math.pow(RECENCY_DECAY, i); // newer = higher weight
          weightedSuccess += row.success ? weight : 0;
          totalWeight += weight;
        });
        rollingSuccessRate = weightedSuccess / totalWeight;

        // Boost if last 3 tasks were all successful (agent recovered)
        const recent3 = history.slice(0, 3);
        if (recent3.length >= 3 && recent3.every(r => r.success)) {
          recencyBoost = 1.1;
        }
      }

      const finalScore =
        cap.weight *
        dependencyHealth *
        rollingSuccessRate *
        recencyBoost *
        (cap.preferred ? 1.05 : 1.0); // slight preferred bonus

      scores.push({
        agentId: agent.appId,
        capability,
        baseWeight: cap.weight,
        dependencyHealth,
        rollingSuccessRate,
        recencyBoost,
        finalScore,
      });
    }

    return scores.sort((a, b) => b.finalScore - a.finalScore);
  }

  async recordTaskResult(result: TaskResult, capability: string): Promise<void> {
    await this.sql`
      INSERT INTO agent_task_history (id, agent_id, capability, success, duration_ms, error_type, created_at)
      VALUES (
        ${result.taskId},
        ${result.agentId},
        ${capability},
        ${result.success},
        ${result.durationMs},
        ${result.error?.type ?? null},
        ${result.completedAt}
      )
    `;
  }
}
```

### 1.2 — Agent Base Template

Every agent follows this pattern. This becomes the template that new agents copy.

```typescript
// packages/agent-template/src/index.ts

import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { z } from "zod";
import {
  AgentRegistry,
  tracedChatCompletion,
  EventLog,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
} from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "simple-agent";
const AGENT_NAME = process.env.AGENT_NAME || "Simple Agent";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";
const APP_PORT = process.env.APP_PORT || "3000";

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });
const registry = new AgentRegistry(daprClient);

// --- Agent Definition ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    { name: "general-query", weight: 0.8, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
};

const SYSTEM_PROMPT = `You are a helpful assistant running as part of Jay's homelab 
mesh-six agent mesh. You can answer general questions and help with basic tasks.
Be concise and direct.`;

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint for k8s probes
app.get("/healthz", (c) => c.json({ status: "ok", agent: AGENT_ID }));

// Dapr pub/sub subscription endpoint
// Dapr calls this to discover what topics this agent subscribes to
app.get("/dapr/subscribe", (c) => c.json([
  {
    pubsubname: "agent-pubsub", // Dapr component name (RabbitMQ)
    topic: `tasks.${AGENT_ID}`, // Agent-specific task topic
    route: "/tasks",
  },
]));

// Task handler — receives dispatched tasks from orchestrator
app.post("/tasks", async (c) => {
  const body = await c.req.json();
  const task = body.data; // Dapr wraps the payload

  console.log(`[${AGENT_ID}] Received task: ${task.id} — ${task.capability}`);

  try {
    const result = await handleTask(task);

    // Publish result back to orchestrator
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, result);

    return c.json({ status: "SUCCESS" });
  } catch (error) {
    const failResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "unhandled", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" }); // ACK to Dapr even on failure
  }
});

// Direct invocation endpoint — for synchronous agent-to-agent calls
app.post("/invoke", async (c) => {
  const body = await c.req.json();
  const result = await handleTask(body);
  return c.json(result);
});

// --- Core Task Handler ---
async function handleTask(task: any) {
  const startTime = Date.now();

  const { text } = await tracedChatCompletion(
    {
      model: LLM_MODEL,         // e.g. "anthropic/claude-sonnet-4-20250514" via LiteLLM
      system: SYSTEM_PROMPT,
      prompt: task.payload.query || JSON.stringify(task.payload),
    },
    eventLog ? { eventLog, traceId: crypto.randomUUID(), agentId: AGENT_ID } : null
  );

  return {
    taskId: task.id,
    agentId: AGENT_ID,
    success: true,
    result: { response: text },
    durationMs: Date.now() - startTime,
    completedAt: new Date().toISOString(),
  };
}

// --- Lifecycle ---
async function start() {
  // Register with agent registry
  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  // Start heartbeat interval
  setInterval(() => registry.heartbeat(AGENT_ID), 30_000);

  // Start HTTP server
  Bun.serve({ port: Number(APP_PORT), fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log(`[${AGENT_ID}] Shutting down...`);
  REGISTRATION.status = "offline";
  await registry.register(REGISTRATION);
  process.exit(0);
});

start();
```

### 1.3 — Orchestrator Service

```typescript
// apps/orchestrator/src/index.ts — Key orchestrator logic (simplified)

// The orchestrator:
// 1. Receives task requests (HTTP API or pub/sub)
// 2. Queries registry for agents matching the required capability
// 3. Scores agents using AgentScorer
// 4. Dispatches task to highest-scoring agent via pub/sub
// 5. Listens for task results and records history
// 6. Handles timeouts and retry with re-scoring

// Key endpoint: POST /tasks
// Body: { capability: "deploy-service", payload: { ... }, priority: 5 }
//
// Key subscription: topic "task-results"
// Receives TaskResult messages from agents, records in history
```

### 1.4 — Dapr Component Configs

```yaml
# dapr/components/statestore-redis.yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: agent-statestore
  namespace: mesh-six
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: "redis-cluster.redis:6379" # Adjust to your Redis cluster endpoint
    - name: redisPassword
      secretKeyRef:
        name: redis-secret
        key: password
```

```yaml
# dapr/components/pubsub-rabbitmq.yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: agent-pubsub
  namespace: mesh-six
spec:
  type: pubsub.rabbitmq
  version: v1
  metadata:
    - name: host
      value: "amqp://user:password@rabbitmq.rabbitmq:5672" # Adjust to your RabbitMQ
    - name: durable
      value: "true"
    - name: deletedWhenUnused
      value: "false"
    - name: autoAck
      value: "false"
    - name: deliveryMode
      value: "2" # persistent
    - name: requeueInFailure
      value: "true"
    - name: publisherConfirm
      value: "true"
```

```yaml
# dapr/components/outbox.yaml — For atomic state + publish operations
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: agent-statestore-outbox
  namespace: mesh-six
spec:
  type: state.postgresql
  version: v1
  metadata:
    - name: connectionString
      value: "host=postgresql-ha.postgres port=5432 user=agentmesh password=xxx dbname=agentmesh sslmode=require"
    - name: outboxPublishPubsub
      value: "agent-pubsub"
    - name: outboxPublishTopic
      value: "task-results"
```

### 1.5 — Kubernetes Manifests

```yaml
# k8s/base/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: mesh-six
  labels:
    app.kubernetes.io/part-of: mesh-six
```

```yaml
# k8s/base/simple-agent/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: simple-agent
  namespace: mesh-six
spec:
  replicas: 1
  selector:
    matchLabels:
      app: simple-agent
  template:
    metadata:
      labels:
        app: simple-agent
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "simple-agent"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
    spec:
      containers:
        - name: simple-agent
          image: registry.bto.bar/mesh-six/simple-agent:latest
          ports:
            - containerPort: 3000
          env:
            - name: AGENT_ID
              value: "simple-agent"
            - name: AGENT_NAME
              value: "Simple Agent"
            - name: LITELLM_BASE_URL
              value: "http://litellm.litellm:4000/v1"
            - name: LITELLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: litellm-secret
                  key: api-key
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
```

### 1.6 — Database Migration

```sql
-- migrations/001_agent_task_history.sql
-- Run against the agentmesh database in PostgreSQL HA cluster

CREATE TABLE IF NOT EXISTS agent_task_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  capability    TEXT NOT NULL,
  success       BOOLEAN NOT NULL,
  duration_ms   INTEGER,
  error_type    TEXT,
  context       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_task_history_agent_capability
  ON agent_task_history (agent_id, capability, created_at DESC);

CREATE INDEX idx_task_history_created
  ON agent_task_history (created_at DESC);
```

### 1.7 — Milestone 1 Acceptance Criteria

- [x] `simple-agent` code complete with Dapr pub/sub, registry self-registration, LLM integration
- [x] `orchestrator` code complete with task routing, agent discovery, scoring, retry logic
- [x] `@mesh-six/core` library with types, registry, and scoring
- [x] Task result recording in `agent_task_history` table (migration applied)
- [x] Dapr component configs for Redis state store and RabbitMQ pub/sub
- [x] Kubernetes manifests with Dapr annotations and kustomize overlays
- [x] Dockerfile for building agent images
- [x] Migration system (`bun run db:migrate`)
- [ ] Deploy to k3s and verify end-to-end flow
- [ ] Dapr traces visible in Grafana/Tempo
- [ ] Dapr metrics scraped by Prometheus/Mimir
- [x] ArgoCD Application resource manages the deployment

### 1.8 — Milestone 1 Implementation Notes

**Completed: 2026-02-11**

**Key Decisions:**
- Used `pg` package instead of `postgres` (porsager) for better PgBouncer compatibility with CloudNativePG
- Migration script loads `.env` automatically and supports both `DATABASE_URL` and `PG_PRIMARY_URL`
- Agent registry uses an index key (`agent:_index`) to list all agents since Redis via Dapr doesn't support prefix scans

**Database:**
- PostgreSQL connection via `pgsql.k3s.bto.bar:5432` (Traefik TCP ingress)
- Database: `mesh_six`
- `_migrations` table tracks applied migrations
- `agent_task_history` table for scoring

**Environment Variables:**
- `DATABASE_URL` - PostgreSQL connection string for mesh_six database
- `PG_PRIMARY_URL` - Fallback if DATABASE_URL not set
- `LITELLM_BASE_URL` - LiteLLM gateway endpoint
- `LITELLM_API_KEY` - LiteLLM API key

**Remaining Work:**
- Build and push Docker images to `registry.bto.bar`
- Create ArgoCD Application resources
- Deploy Dapr components to mesh-six namespace
- Populate secrets (redis, rabbitmq, postgres, litellm)
- End-to-end verification

---

## Milestone 2 — Memory Layer

**Goal**: Deploy Mem0 as infrastructure service. Wire memory into agents for persistent, cross-session context.

**Deliverables**: Mem0 running in k3s backed by PostgreSQL with pgvector. Simple agent enhanced with memory retrieval and storage. Agent remembers context across conversations.

**Value**: Stateful AI assistant that learns and remembers across sessions.

### 2.1 — Deploy pgvector Extension

```sql
-- Run on PostgreSQL HA cluster
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2.2 — Mem0 Integration via npm Package

Instead of deploying a separate Mem0 Python container, memory is integrated directly into agents via the `mem0ai` npm package (v2.2.2). This keeps everything in the Bun/TypeScript ecosystem.

Key configuration:
- Vector store: PostgreSQL with pgvector (existing HA cluster)
- LLM provider: Ollama (`phi4-mini` model) for memory extraction
- Embedder: Ollama (`mxbai-embed-large` model) for embeddings
- Collection naming: `mesh_six_{agentId}` per agent

### 2.3 — Memory Integration in Core Library

```typescript
// packages/core/src/memory.ts

import { Memory } from "mem0ai";

export class AgentMemory {
  private memory: Memory;
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.memory = new Memory({
      vector_store: {
        provider: "pgvector",
        config: {
          collection_name: `mesh_six_${agentId}`,
          host: process.env.PG_PRIMARY_HOST || "localhost",
          port: Number(process.env.PG_PRIMARY_PORT || 5432),
          user: process.env.PG_PRIMARY_USER || "postgres",
          password: process.env.PG_PRIMARY_PASSWORD || "",
          dbname: process.env.PG_PRIMARY_DB || "mesh_six",
        },
      },
      llm: {
        provider: "ollama",
        config: {
          model: process.env.OLLAMA_MODEL || "phi4-mini",
          ollama_base_url: process.env.OLLAMA_URL || "http://ollama:11434",
        },
      },
      embedder: {
        provider: "ollama",
        config: {
          model: process.env.OLLAMA_MODEL_EMBED || "mxbai-embed-large",
          ollama_base_url: process.env.OLLAMA_URL || "http://ollama:11434",
        },
      },
    });
  }

  async remember(query: string, userId?: string): Promise<string[]> {
    const results = await this.memory.search(query, {
      agent_id: this.agentId,
      user_id: userId || "default",
      limit: 5,
    });
    return results?.map((r: any) => r.memory) || [];
  }

  async store(messages: Array<{ role: string; content: string }>, userId?: string): Promise<void> {
    await this.memory.add(messages, {
      agent_id: this.agentId,
      user_id: userId || "default",
    });
  }
}
```

### 2.4 — Milestone 2 Acceptance Criteria

- [x] pgvector extension enabled on PostgreSQL HA cluster (v0.7.0 already installed)
- [x] Mem0 integrated via mem0ai npm package (no separate Python container needed)
- [x] AgentMemory class in core library with search/store methods
- [x] Simple agent stores conversation memories after interactions
- [x] Simple agent retrieves relevant memories at start of new conversations
- [ ] Memory persists across agent pod restarts (needs k8s deployment verification)
- [ ] Memory search returns semantically relevant results (needs runtime testing)

### 2.5 — Milestone 2 Implementation Notes

**Completed: 2026-02-11**

**Architecture Decision:**
Instead of deploying a separate Mem0 Python container, we used the `mem0ai` npm package (v2.2.2) directly in the TypeScript agents. This is simpler and keeps everything in the Bun/TypeScript ecosystem.

**Configuration:**
- Vector store: pgvector with existing PostgreSQL HA cluster
- Embeddings: Ollama (`mxbai-embed` model) via `OLLAMA_URL`
- LLM for memory extraction: Ollama (`phi4-mini` model)
- Collection naming: `mesh_six_{agentId}` per agent

**Environment Variables (added):**
- `MEMORY_ENABLED` - Set to "false" to disable memory (default: enabled)
- Uses existing Ollama env vars: `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_MODEL_EMBED`
- Uses existing PG env vars: `PG_PRIMARY_HOST`, `PG_PRIMARY_PORT`, `PG_PRIMARY_USER`, `PG_PRIMARY_PASSWORD`, `PG_PRIMARY_DB`

**Memory Flow:**
1. On task receipt, agent searches memories for relevant context
2. Relevant memories are injected into system prompt
3. After LLM response, conversation is stored in memory
4. Mem0 automatically extracts key information for future retrieval

**Bundle Size Note:**
The mem0ai package significantly increases bundle size (~11MB for simple-agent). Consider lazy loading or tree-shaking in future if size becomes an issue.

**Remaining Work:**
- Deploy to k8s and verify memory persistence
- Test semantic search quality with Ollama embeddings
- Monitor memory extraction quality with phi4-mini

---

## Milestone 3 — Specialist Agents

**Goal**: Build the deployer agents (ArgoCD + kubectl), the Architect agent, and the Researcher agent. Prove weighted routing with historical scoring.

**Deliverables**: Four new agents, each independently useful. Orchestrator intelligently routes based on capability, health, and performance history.

### 3.1 — ArgoCD Deployer Agent

**Capabilities**: `deploy-service`, `rollback-service`, `sync-gitops`
**Requirements**: `argocd-healthy` → health check against ArgoCD server
**Weight**: 0.9 for deploy (preferred GitOps path)
**Tools**:
- `argocd_create_application` — Create ArgoCD Application resource
- `argocd_sync` — Trigger sync on existing application
- `argocd_rollback` — Rollback to previous revision
- `argocd_get_status` — Check application health/sync status

### 3.2 — Kubectl Deployer Agent

**Capabilities**: `deploy-service`, `rollback-service`, `debug-pods`
**Requirements**: none (always available if k8s API is up)
**Weight**: 0.7 for deploy (fallback), 1.0 for debug-pods (specialist)
**Tools**:
- `kubectl_apply` — Apply kustomize manifests
- `kubectl_rollback` — Rollback deployment
- `kubectl_get_pods` — List/describe pods
- `kubectl_logs` — Retrieve pod logs
- `kubectl_exec` — Execute command in pod

### 3.3 — Architect Agent

**Capabilities**: `tech-consultation`, `architecture-review`
**Communication**: Synchronous via Dapr service invocation (consulted by PM and orchestrator). Also operates as a **Dapr Actor** (`ArchitectActor`) with per-issue instances for the GWA integration workflow.
**System Prompt**: Encodes Jay's homelab knowledge, tech preferences, and decision patterns
**Memory**: Long-term via Mem0 (past architectural decisions and outcomes). Actor instances maintain an append-only event log in PostgreSQL (`architect_events`).
**Tools**:
- `query_cluster_state` — Current k8s resource usage and running services
- `query_service_health` — Grafana/Prometheus metrics for services
- `query_past_decisions` — Search Mem0 for architectural history
- `query_resource_usage` — Cluster capacity and consumption

**Actor methods** (per-issue instances):
- `initialize` — Set up actor with issue context
- `consult` — Answer architectural questions with full event history context
- `answerQuestion` — Evaluate question confidence, return answer or best-guess for escalation
- `receiveHumanAnswer` — Generalize human Q&A via LLM, store to Mem0 for cross-issue learning
- `getHistory` — Retrieve event log for an issue

**Key behavior**: Returns structured output with tech stack recommendation, deployment strategy, and reasoning. Reasoning is stored in memory for future reference. In actor mode, builds context from accumulated event history + Mem0 memories to provide increasingly informed answers per issue.

### 3.4 — Researcher Agent

**Capabilities**: `deep-research`, `market-analysis`, `technical-research`
**Communication**: Synchronous via Dapr service invocation
**Multi-provider strategy**:
- Claude (via Anthropic SDK) for broad analysis and synthesis
- Gemini Pro (via Google API) for deep research with repo context
- Local Ollama models for quick, private research tasks
**Memory**: Stores research findings in Mem0 for future retrieval by any agent

### 3.5 — Agent Scoring in Action

Scenario validation — ArgoCD outage:
1. Both deployer agents register with `deploy-service` capability
2. ArgoCD deployer has weight 0.9, kubectl has 0.7
3. Orchestrator dispatches to ArgoCD (higher score)
4. ArgoCD starts failing → `agent_task_history` records failures
5. Rolling success rate drops, score falls below kubectl's
6. Orchestrator auto-routes to kubectl
7. ArgoCD health check starts failing → dependency score = 0
8. kubectl handles all deploys
9. ArgoCD recovers → health check passes, but success rate still low
10. Orchestrator sends low-risk task to ArgoCD → succeeds
11. Score gradually recovers → ArgoCD resumes as primary

### 3.6 — Milestone 3 Acceptance Criteria

- [x] ArgoCD deployer can create, sync, and rollback applications (code complete)
- [x] Kubectl deployer can apply manifests and manage pods (code complete)
- [ ] Orchestrator correctly routes deploy tasks based on weighted scoring (needs k8s deployment test)
- [ ] When ArgoCD health check fails, kubectl deployer receives all deploy tasks (needs k8s deployment test)
- [ ] When ArgoCD recovers, it gradually regains primary status (needs k8s deployment test)
- [x] Architect agent returns structured tech recommendations
- [x] Architect stores decisions in Mem0 and references past decisions
- [x] Researcher agent can perform research via multiple LLM providers
- [ ] Agent-to-agent consultation works via Dapr service invocation (needs k8s deployment test)
- [ ] Task history accurately reflects agent performance (needs k8s deployment test)

### 3.7 — Milestone 3 Implementation Notes

**Completed: 2026-02-11**

**Architect Agent:**
- Two-step structured output: tools gather context via `tracedChatCompletion`, then `chatCompletionWithSchema` creates recommendation
- System prompt encodes homelab knowledge and Jay's preferences
- Tools: query_cluster_state, query_service_health, query_past_decisions, query_resource_usage
- Memory integration for storing/retrieving architectural decisions

**Researcher Agent:**
- Multi-provider LLM: Claude (Anthropic), Gemini (Google), Ollama (local via LiteLLM)
- Auto provider selection based on task complexity (low→Ollama, medium→Gemini, high→Claude)
- Research depth levels: quick, standard, comprehensive (affects maxSteps)
- Tools: search_web, search_documentation, analyze_repository, search_past_research
- Stores all research findings in memory for future reference by any agent

**ArgoCD Deployer Agent:**
- Capabilities: deploy-service (0.9), rollback-service (0.9), sync-gitops (1.0)
- ArgoCD API integration for application lifecycle management
- Tools: get_status, sync, create_application, rollback, list_applications, delete_application
- Deployment planning with LLM-powered risk assessment
- Health check against ArgoCD server connectivity
- Memory integration for deployment history

**Kubectl Deployer Agent:**
- Capabilities: deploy-service (0.7), rollback-service (0.7), debug-pods (1.0), inspect-cluster (0.9)
- Direct kubectl execution for debugging and emergency deployments
- Tools: get_pods, get_deployments, describe, logs, events, apply, delete, rollout ops, scale, restart
- LLM-powered debug analysis with structured DebugResult output
- RBAC ServiceAccount with cluster-wide permissions
- Memory integration for debugging patterns

**Remaining Work:**
- Deploy all Milestone 3 agents to k8s and verify weighted routing
- Test agent-to-agent consultation via Dapr service invocation

---

## Milestone 4 — Project Manager Agent

**Goal**: Build the PM agent with full project board lifecycle. Integrates with GitHub and Gitea project boards to drive Claude Code workflows.

**Deliverables**: PM agent as a Dapr Workflow that manages the full task lifecycle from creation through deployment validation.

### 4.1 — State Machine (Dapr Workflow)

States: `CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED`

Failure paths:
- REVIEW → PLANNING (plan inadequate, add comment with feedback)
- QA → PLANNING (tests fail, create bug issue)
- VALIDATE → PLANNING (deployed service fails, create bug with observations)

**Context Management**: Each state transition is a fresh LLM call, not a continuation.
The PM uses `buildAgentContext()` to assemble system prompt + structured task state (from Dapr)
+ scoped Mem0 memories for the current transition. Before each transition completes, the PM
runs `transitionClose()` to reflect on insights worth preserving. This means:

- Context window stays at ~3-5k tokens per transition regardless of task complexity
- The PM learns from experience: a failed VALIDATE stores the failure pattern in Mem0
- Future PLANNING transitions retrieve those failure patterns and avoid repeating them
- Cross-agent learning: `global`-scoped reflections reach the Architect and other agents

See [Context Window Management](#context-window-management) in Cross-Cutting Concerns for
the full pattern, utilities, and memory scoping details.

### 4.2 — Project Board Integration

**GitHub API**: `@octokit/rest` for project board manipulation
**Gitea API**: Gitea REST API client for project board manipulation

Both platforms use identical column conventions:
- To-Do, Planning, In-Progress, QA, Done
- Metadata fields: pod name, Claude session ID, kubectl attach command

**Repo Registry** (PostgreSQL table):
```sql
CREATE TABLE repo_registry (
  service_name    TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,  -- 'github' or 'gitea'
  repo_url        TEXT NOT NULL,
  default_branch  TEXT DEFAULT 'main',
  cicd_type       TEXT NOT NULL,  -- 'github-actions' or 'gitea-actions'
  trigger_method  TEXT NOT NULL,  -- 'project-board' or 'direct-api'
  board_id        TEXT,
  metadata        JSONB DEFAULT '{}'
);
```

### 4.3 — Agent-to-Agent Consultation Flow

```
PM receives task "Build a notification service"
  │
  ├──▶ Dapr invoke: architect-agent/consult
  │    Architect queries memory, cluster state, returns tech guidance
  │
  ├──▶ (optional) Dapr invoke: researcher-agent/research
  │    If task requires external knowledge
  │
  ├── PM combines task requirements + architect guidance
  │   into structured project board item
  │
  ├── PM queries repo_registry for target repo + platform
  │
  └── PM creates board item and begins state machine
```

### 4.4 — Review Gates (LLM-Powered)

At PLANNING → REVIEW transition:
- Agent polls project board for Claude Code's implementation plan
- Uses `chatCompletionWithSchema` structured output to evaluate plan against requirements
- Returns verdict: `{ approved: boolean, concerns: string[], suggestions: string[] }`

At QA → DEPLOY transition:
- Agent checks Playwright test results
- Evaluates test coverage against acceptance criteria

At VALIDATE → ACCEPTED transition:
- Agent hits deployed service endpoints
- Runs smoke tests against live URLs
- Evaluates health and functionality

### 4.5 — Integration with GitHub Workflow Agents (GWA)

**Approach (evolved)**: GWA functionality has been fully migrated into mesh-six as native services. The PM agent drives the workflow via GitHub Projects board as the integration surface, while the Implementer agent runs Claude CLI sessions directly. See [Milestone 4.5](#milestone-45--gwa-integration-pm-agent--github-workflow-agents) for the full implementation.

Key services migrated from GWA:
- **Auth Service** (`auth-service`) — Credential lifecycle management (replaces GWA orchestrator for auth)
- **Implementer** (`implementer`) — Claude CLI in tmux sessions (replaces GWA repo pods)
- **LLM Service** (`llm-service`) — Claude CLI gateway with actor-based concurrency control

### 4.6 — MQTT Progress Events

Claude Code pods publish progress to RabbitMQ MQTT topics:
```
agent/code/job/{jobId} → { status, details, timestamp }
```
PM agent subscribes for real-time monitoring. Same events feed eventual dashboard.

### 4.7 — Milestone 4 Acceptance Criteria

- [x] PM agent creates well-structured project board items on GitHub
- [x] PM agent creates well-structured project board items on Gitea
- [x] PM consults Architect before creating tasks (Dapr service invocation)
- [x] State machine transitions correctly through all states
- [x] REVIEW gate catches inadequate plans and sends back to PLANNING
- [x] QA gate checks Playwright results and creates bugs on failure
- [x] VALIDATE gate tests deployed service and accepts/rejects
- [x] Workflow survives pod restarts (Dapr Workflow durability)
- [x] Progress events visible via MQTT subscription
- [ ] Full task lifecycle completes: task → plan → code → test → deploy → validate (needs k8s deployment)
- [x] PM uses `buildAgentContext()` for each state transition (context stays <5k tokens)
- [x] PM runs `transitionClose()` reflection before each state boundary reset
- [x] Reflections stored in Mem0 are retrieved by subsequent transitions
- [x] Global-scoped reflections accessible by Architect and other agents

### 4.8 — Milestone 4 Implementation Notes

**Completed: 2026-02-11**

**Project Manager Agent:**
- Full state machine: CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED
- Failure paths implemented: REVIEW/QA/VALIDATE can return to PLANNING
- GitHub integration via @octokit/rest: issue creation, comments, updates
- Gitea integration via REST API (similar endpoints)
- Agent consultation via Dapr service invocation to Architect and Researcher
- LLM-powered review gates with structured output (ReviewResultSchema)
- Memory integration for project history
- REST API: POST /projects, GET /projects/:id, POST /projects/:id/advance
- Subscribes to project-events topic for external triggers

**Dapr Workflow Migration (Completed):**
- New file: `apps/project-manager/src/workflow.ts` with full Dapr Workflow implementation
- Projects now survive pod restarts via Dapr's event sourcing
- Workflow activities: createProject, evaluateGate, transitionState, addComment, consultArchitect, requestResearch
- External events (`advance`) drive state transitions
- Documentation: `apps/project-manager/WORKFLOW_MIGRATION.md`

**Database Migration (Completed):**
- `migrations/002_repo_registry.sql`: Repository registry table
- Tracks service_name, platform, repo_url, cicd_type, trigger_method, board_id
- Indexes for platform, trigger_method, board_id queries

**QA Gate Enhancement (Completed):**
- `parsePlaywrightResults()`: Parses Playwright JSON reporter output
- `extractTestFailures()`: Extracts suite/spec/error details
- Auto-rejects if tests fail with specific failure details
- Auto-creates bug issues on GitHub/Gitea with test details

**VALIDATE Gate Enhancement (Completed):**
- `runSmokeTests()`: Tests endpoints with 5-second timeout
- Default endpoints: /healthz, /readyz
- Custom endpoints via context.endpoints
- `formatSmokeTestReport()`: Markdown report with response times
- Auto-rejects if critical health endpoints fail

**MQTT Integration (Completed):**
- PM subscribes to `agent/code/job/#` for Claude Code pod progress
- Matches jobId to projects via metadata
- Adds GitHub comments on job completion/failure
- Configurable via MQTT_URL, MQTT_ENABLED

**Claude MQTT Bridge (Bonus - Completed):**
- New package: `@mesh-six/claude-mqtt-bridge`
- Bun script receives Claude Code hook events via stdin
- Enriches with git branch, worktree, model, session_id
- Publishes to `claude/progress/{session_id}/{event_type}`
- Hook configuration: `.claude/settings.local.json`
- UI guide: `docs/CLAUDE_PROGRESS_UI.md`

**Context Integration (Completed):**
- `buildAgentContext()` wired into `evaluateReviewGate()` for bounded context with scoped Mem0 memories
- `consultArchitect()` uses `buildAgentContext()` for architect consultation context
- `transitionClose()` runs reflection after review gates and architect consultations
- Graceful degradation: falls back to direct prompts when memory is unavailable
- `@mesh-six/core@0.3.0` test suite: 70 tests, 135 assertions covering scoring, registry, context, and types

**Dashboard (Completed):**
- `@mesh-six/dashboard@0.1.0`: React + Vite + Tailwind real-time monitoring UI
- Agent Registry view: table with status badges, capability chips, relative heartbeat times
- Task Feed view: real-time scrolling task events from MQTT
- Project Lifecycle view: state machine visualization (8 states) with project history
- MQTT WebSocket integration via `MqttProvider` hook (configurable via `VITE_MQTT_URL`)

**K8s Manifest Audit (Completed):**
- `k8s/base/claude-mqtt-bridge/`: Deployment with Dapr sidecar, ClusterIP service
- Audit confirmed all agents have correct `dapr.io/app-id`, port mapping, and image patterns

**Remaining Work:**
- Deploy to k8s and run full task lifecycle end-to-end
- Test Claude MQTT Bridge in production environment

---

## Milestone 4.5 — GWA Integration (PM Agent ↔ GitHub Workflow Agents)

**Goal**: Fully migrate GitHub Workflow Agents (GWA) functionality into mesh-six as native services. The PM agent drives autonomous code implementation workflows via GitHub Projects board, with credential management, Claude CLI execution, architect consultation, and session recovery all handled natively.

**Status**: Code complete (all phases). Infrastructure deployment and E2E testing deferred to follow-up sessions.

**Key Design Principle**: GitHub Projects is the ONLY integration surface. If the Implementer were replaced with a human developer, PM would function identically — it only interacts via GitHub issue comments and project board column moves.

### New Service: Webhook Receiver (`apps/webhook-receiver/` v0.2.0)

Board event bridge that detects GitHub Projects column changes and publishes typed events:
- HMAC-SHA256 webhook validation for `projects_v2_item` events
- Classifies transitions: `new-todo`, `card-blocked`, `card-unblocked`, `card-moved`
- Publishes to Dapr `board-events` topic
- 3-minute polling safety net for missed Todo items
- Self-move filtering via Dapr state store pending-moves keys
- PR/issue filtering via `shouldProcessIssue` from `@mesh-six/core` (author, label, branch, draft filters)

### New Service: Auth Service (`apps/auth-service/` v0.1.0)

Credential lifecycle management microservice (replaces GWA orchestrator for auth):
- Project CRUD: `POST /projects`, `GET /projects/:id`, `PUT /projects/:id`
- Credential management: push, refresh, health check, invalidation
- Bundle provisioning: `POST /projects/:id/provision` → tar.gz with `.credentials.json`, `config.json`, `settings.json`, `.claude.json`
- OAuth refresh timer: auto-refreshes expiring credentials every 30 minutes
- Dapr pub/sub: publishes `credential-refreshed` and `config-updated` events
- PostgreSQL-backed: `auth_projects`, `auth_credentials`, `auth_bundles` tables

### New Agent: Implementer (`apps/implementer/` v0.3.0)

Autonomous code implementation agent (replaces GWA repo pods):
- **Dapr Actor runtime**: one `ImplementerActor` per issue session
- **Session lifecycle**: provision credentials → clone repo → create worktree → start Claude CLI in tmux → monitor → report
- **tmux session management**: create/send-keys/capture-pane/kill via `Bun.spawn`
- **SessionMonitor**: periodic tmux capture, detects auth failures, questions, completion, Claude session IDs
- **Event-driven**: SessionMonitor raises typed events on PM workflow via Dapr HTTP `raiseEvent` API (not pub/sub)
- **Answer injection**: `injectAnswer` method sends text to Claude CLI via `tmux send-keys`
- **Session resume**: captures `claude_session_id` from CLI output, passes `--resume <id>` on restart
- **Pre-action checkpoints**: snapshots git state + tmux output before commits/PRs
- **Pod startup recovery**: marks interrupted sessions, finds resumable sessions
- **GitHub integration**: PR creation via `gh` CLI, structured comment posting
- **StatefulSet** deployment with PVCs for worktrees and tmux sockets
- **Custom Dockerfile**: `Dockerfile.implementer` with tmux + git + Claude CLI

### New Service: LLM Service (`apps/llm-service/` v0.1.1)

Claude CLI gateway with actor-based concurrency control:
- OpenAI-compatible `/v1/chat/completions` endpoint
- Dapr actor runtime: `ClaudeCLIActor` type, one actor per credential set, turn-based concurrency
- MinIO credential management: download/extract tar.gz archives on actor activation
- Capability-aware routing: LRU selection among idle actors
- Provisions credentials from auth-service via Dapr service invocation (replaced GWA dependency)
- Subscribes to `credential-refreshed` events for proactive credential sync
- Custom Dockerfile: `Dockerfile.llm-service` with Claude CLI pre-installed

### PM Workflow Rewrite (`apps/project-manager/` v0.6.0)

Event-driven Dapr Workflow with full lifecycle management:
- **States**: INTAKE → PLANNING → IMPLEMENTATION → QA → REVIEW → ACCEPTED/FAILED
- **Event-driven phases**: each phase uses `waitForExternalEvent()` to suspend until SessionMonitor/subsystems raise typed events (`planning-event`, `impl-event`, `qa-event`, `human-answer`)
- **Complexity gate**: issues labeled `simple` skip Opus planning phase
- **Architect actor question loop**: questions routed through `ArchitectActor.answerQuestion()`, confident answers auto-injected into Claude CLI, low-confidence escalated to human via ntfy with reply webhook (`/ntfy-reply`)
- **Human answer flow**: ntfy reply → `raiseEvent("human-answer")` → `processHumanAnswer` → Mem0 learning
- **DB-backed retry budgets**: configurable per-issue via `retryBudget` workflow input, failure reasons tracked as JSONB
- **GitHub issue comments**: status updates at each phase transition with hidden HTML markers for idempotent updates
- **Plan templates**: `templates/plans/prompt.md` for planning prompt construction, `formatPlanForIssue` for plan sync
- **No in-memory state**: all lookups via PostgreSQL (`lookupByIssue`, `lookupByWorkflowId`)
- **Auto-resolve**: two-agent cascade (architect → researcher) for blocked questions before human escalation
- **Poll jitter**: 0-5s random jitter prevents synchronized polling from concurrent workflows

### Research Sub-Workflow (`apps/project-manager/` — ResearchAndPlan)

Dapr Durable Workflow sub-workflow for complex architectural planning requiring external research:
- **Phases**: Triage (Gemini Pro) → Dispatch (scraper service) → Review (Gemini Flash) → Plan Draft (Gemini Pro) → Reflect (Mem0)
- **Claim Check pattern** via MinIO for large research documents (`mesh-six-research` bucket)
- **Timer-based hibernation** with external event wake-up using `whenAny()` from `@microsoft/durabletask-js` (replay-safe, not `Promise.race`)
- **Iterative review loop** (max 3 cycles) with follow-up prompts for incomplete scrapes
- **ntfy push notifications** for scraper timeouts and dispatch failures
- **PostgreSQL `research_sessions` table** for lifecycle state tracking
- **Mem0 integration**: reads scoped memories during triage (per `architectActorId`), writes reflections via `transitionClose()` after plan drafting using `ARCHITECT_REFLECTION_PROMPT`
- **Generator delegation** (`yield*`) from main PM workflow — all sub-workflow activity yields flow through the main orchestration context, preserving Dapr replay determinism
- **Graceful degradation**: when research fails/times out, failure context is injected into the plan draft prompt so the Architect explicitly flags uncertain areas instead of hallucinating

Key files:
- `apps/project-manager/src/research-sub-workflow.ts` — Workflow generator with 4 phases
- `apps/project-manager/src/research-activities.ts` — Activity implementations with dependency injection factory
- `packages/core/src/research-types.ts` — Zod schemas, constants, types
- `packages/core/src/research-minio.ts` — MinIO helpers (upload/download/status/bucket auto-creation)
- `packages/core/src/prompts/architect-reflection.ts` — Architect-specific Mem0 reflection prompt
- `packages/core/src/tools/web-research.ts` — Web research tool schemas (scaffolded for future Gemini native tool calling)
- `packages/core/src/research-types.test.ts` — 19 test cases covering all schemas and constants
- `migrations/014_research_sessions.sql` — PostgreSQL table with indexes
- `scripts/test-research-workflow.ts` — Multi-mode test script (triage/dispatch/review/offline/workflow)

Environment variables:
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` — MinIO S3 connection
- `NTFY_SERVER` — Must be explicitly configured (no public fallback)
- `NTFY_RESEARCH_TOPIC` — ntfy topic for research notifications (default: `mesh-six-research`)
- `SCRAPER_SERVICE_APP_ID` — Dapr app-id of scraper service (default: `scraper-service`)
- `LLM_MODEL_PRO` — Gemini Pro model for triage/planning (default: `gemini/gemini-1.5-pro`)
- `LLM_MODEL_FLASH` — Gemini Flash model for review/validation (default: `gemini/gemini-1.5-flash`)

### Architect Agent Enhancement (`apps/architect-agent/` — ArchitectActor)

Per-issue Dapr Actor with append-only event log:
- `ArchitectActor` class with methods: `initialize`, `consult`, `answerQuestion`, `receiveHumanAnswer`, `getHistory`
- PostgreSQL event log (`architect_events` table) with `actor_id`, `event_type`, JSONB payload
- Mem0 integration: generalizes human Q&A and stores to global `architect` scope for cross-issue learning
- Confidence-based responses: `{ confident: true, answer }` or `{ confident: false, bestGuess }`
- Actor runtime wired into existing Hono service alongside traditional consultation endpoints

### Core Library Additions (`@mesh-six/core` v0.10.0)

- `GitHubProjectClient` — GitHub Projects v2 GraphQL + REST operations with `TokenBucket` rate limiter (50 burst, 80/min refill)
- `BoardEvent` Zod discriminated union for typed board events
- `credentials.ts` — `isCredentialExpired`, `syncEphemeralConfig`, `buildCredentialsJson`, `buildConfigJson`, `buildSettingsJson`
- `dialog-handler.ts` — Claude CLI dialog detection: `matchKnownDialog`, `parseDialogResponse`, `KNOWN_DIALOGS`
- `git.ts` — Typed git operations: `cloneRepo`, `createWorktree`, `removeWorktree`, `getStatus`, `getDiff`, `createBranch`, `GitError`
- `pr-filter.ts` — PR/issue filtering: `shouldProcessIssue`, `shouldProcessPR`, `loadFilterConfigFromEnv`
- `comment-generator.ts` — LLM-powered GitHub comment generation: `generateComment`, `formatStatusComment`
- `architect-actor.ts` — `ArchitectActorStateSchema`, `ArchitectEventSchema`, typed event payloads
- Auth/session types: `ProjectConfigSchema`, `CredentialPushRequestSchema`, `ImplementationSessionSchema`, `SessionQuestionSchema`
- `research-types.ts` — Research sub-workflow Zod schemas: `ResearchAndPlanInput/Output`, `ArchitectTriageInput/Output`, `StartDeepResearchInput/Output`, `ReviewResearchInput/Output`, `ArchitectDraftPlanInput`, `TriageLLMResponseSchema`, `ReviewLLMResponseSchema`, `ScrapeCompletedPayloadSchema`, constants (`SCRAPE_COMPLETED_EVENT`, `MAX_RESEARCH_CYCLES`, `RESEARCH_TIMEOUT_MS`, `LLM_MODEL_PRO`, `LLM_MODEL_FLASH`)
- `research-minio.ts` — Research-specific MinIO helpers: `ensureResearchBucket`, `writeResearchStatus`/`readResearchStatus`, `uploadRawResearch`/`downloadRawResearch`, `uploadCleanResearch`/`downloadCleanResearch`, canonical key builders (`statusDocKey`, `rawResearchKey`, `cleanResearchKey`)
- `prompts/architect-reflection.ts` — `ARCHITECT_REFLECTION_PROMPT` for Mem0 memory extraction after research & planning phases, `buildArchitectReflectionSystem` helper
- `tools/web-research.ts` — `webResearchTools` schema and `buildResearchSystemPrompt` (scaffolded for future Gemini native tool calling)

### Database Migrations

- `004_pm_workflow_instances.sql` — Issue↔workflow mapping with unique constraint on (issue, repo)
- `006_auth_tables.sql` — `auth_projects`, `auth_credentials`, `auth_bundles`
- `007_session_tables.sql` — `implementation_sessions`, `session_prompts`, `session_tool_calls`, `session_activity_log`, `session_questions`
- `008_pm_retry_budget.sql` — Retry budget columns on `pm_workflow_instances`
- `009_architect_events.sql` — `architect_events` append-only log
- `010_session_resume_fields.sql` — `claude_session_id`, `session_checkpoints` table
- `011_terminal_streaming.sql` — `terminal_snapshots`, `terminal_recordings` tables
- `012_onboarding_runs.sql` — `onboarding_runs` table for onboarding-service workflow state
- `013_orchestrator_tasks.sql` — `orchestrator_tasks` for pod restart recovery
- `014_research_sessions.sql` — `research_sessions` table with `task_id`, `workflow_id`, `status`, `raw_minio_key`, `clean_minio_key`, `research_cycles`; indexes on `workflow_id`, `task_id`, and `(repo_owner, repo_name, issue_number)`

### Operational Infrastructure

**Scripts** (`scripts/`):
- `push-credentials.ts` — Push local Claude credentials to auth-service
- `cleanup.ts` — Remove stale sessions, old checkpoints, expired bundles
- `credential-backup.ts` — Backup credentials to MinIO
- `credential-history.ts` — Credential expiry status report
- `debug-db.ts` — Database diagnostics (active workflows, sessions, pending questions)
- `onboard-repo.ts` — Register repo + create GitHub Projects v2 with standard columns/fields
- `setup-project.ts` — One-time auth project setup
- `test-research-workflow.ts` — Multi-mode research workflow tests (`--mode=triage|dispatch|review|offline|workflow`)

**K8s CronJobs**:
- `cleanup-cronjob` — Daily 3am: `scripts/cleanup.ts` with 7-day session retention, 30-day log retention
- `credential-backup-cronjob` — Every 6h: `scripts/credential-backup.ts`

### Milestone 4.5 Acceptance Criteria

- [x] Webhook receiver validates HMAC-SHA256 and classifies board events
- [x] PM workflow uses event-driven phases with `waitForExternalEvent()`
- [x] Auth-service manages credential lifecycle (push, refresh, provision)
- [x] Implementer runs Claude CLI in tmux with session monitoring
- [x] SessionMonitor raises typed events on PM workflow via Dapr `raiseEvent`
- [x] Architect actor provides per-issue consultation with confidence scoring
- [x] Human answer flow via ntfy reply webhook
- [x] DB-backed retry budgets replace hardcoded cycle limits
- [x] Session resume via `claude --resume <session_id>`
- [x] Pre-action checkpoints capture git state before commits
- [x] Pod startup recovery marks interrupted sessions
- [x] GitHub issue comments at each phase transition
- [x] Planning templates loaded from `templates/plans/`
- [x] PR/issue filtering on webhook-receiver
- [x] Operational scripts for cleanup, backup, diagnostics
- [x] K8s CronJobs for automated cleanup and backup
- [ ] Deploy all M4.5 services to k8s cluster
- [ ] Configure Cloudflare tunnel, GitHub webhook, secrets
- [ ] Run full lifecycle E2E test

Full architecture and acceptance criteria in `docs/PLAN_45_GWA.md`.

---

## Milestone 5 — Infrastructure Agents

**Goal**: Agents for cluster monitoring, infrastructure management, and cost tracking.

**Deliverables**: Homelab monitor, infrastructure manager, cost tracker. These are lower priority but follow the established patterns exactly.

### 5.1 — Homelab Monitor Agent

- Queries Grafana/Loki for logs and metrics
- Checks pod health across namespaces
- Analyzes alerts and anomalies
- Can be invoked by orchestrator: "Why did my PostgreSQL pod restart?"

### 5.2 — Infrastructure Manager Agent

- Manages Cloudflare DNS and Zero Trust configurations
- Can provision/modify OPNsense firewall rules
- Manages Caddy reverse proxy configurations
- Future: Azure resource provisioning

### 5.3 — Cost Tracker Agent

- Monitors LLM API spend (via LiteLLM usage tracking)
- Tracks cluster resource utilization
- Scheduled reports on infrastructure costs
- Alerts on unusual spending patterns

### 5.4 — Milestone 5 Acceptance Criteria

- [x] Homelab Monitor agent code complete with Grafana/Loki/Prometheus integration
- [x] Infrastructure Manager agent code complete with Cloudflare, OPNsense, Caddy tools
- [x] Cost Tracker agent code complete with LiteLLM and cluster resource tracking
- [x] All three agents follow established agent template patterns
- [x] Kubernetes manifests with Dapr sidecar annotations for all Milestone 5 agents
- [ ] Deploy to k3s and verify agent discovery and task routing
- [ ] Homelab Monitor resolves cluster health queries end-to-end
- [ ] Cost Tracker produces scheduled spend reports

### 5.5 — Milestone 5 Implementation Notes

**In progress — agents being created in parallel**

**Homelab Monitor Agent:**
- Capabilities: `cluster-health`, `log-analysis`, `alert-investigation`, `resource-monitoring`
- Grafana API integration for dashboards and metrics
- Loki log querying for cross-namespace log analysis
- Prometheus/Mimir metrics for resource monitoring and alerting
- Memory integration for incident patterns

**Infrastructure Manager Agent:**
- Capabilities: `dns-management`, `firewall-management`, `proxy-management`, `infra-provisioning`
- Cloudflare API for DNS and Zero Trust configurations
- OPNsense API for firewall rule management
- Caddy API for reverse proxy configuration
- Memory integration for infrastructure change history

**Cost Tracker Agent:**
- Capabilities: `cost-reporting`, `usage-analysis`, `budget-alerts`, `resource-optimization`
- LiteLLM usage tracking for LLM API spend
- Kubernetes metrics API for cluster resource utilization
- Scheduled reports and alert threshold monitoring
- Memory integration for spending patterns

---

## Milestone 6 — Context Service

**Goal**: Build a hybrid deterministic + LLM-powered context compression proxy that sits between agents as a Dapr Workflow activity. When the PM workflow delegates to a specialist agent, the Context Service strips accumulated workflow state down to only what the receiving agent needs.

**Deliverables**: Context Service microservice with two-stage compression pipeline (rule engine + Phi3.5 LLM fallback), output validation, PM workflow integration, core library compression types.

**Value**: Receiving agents get clean, focused context instead of the PM's full accumulated state. Saves tokens on every agent delegation, prevents context pollution, and keeps specialist agents working with only the information they need.

### 6.1 — Architecture

Two-stage compression pipeline:

1. **Deterministic Rule Engine** (Stage 1): Per-sender/per-receiver rules strip known-irrelevant fields from workflow state. Executes instantly, handles 60-80% of cases.
2. **LLM Compression** (Stage 2): When rules can't compress below a configurable token ceiling, Phi3.5 via LiteLLM produces a structured compression (~5-7s). Uses the v3.2 prompt format validated through prototyping: METADATA/DOMAIN_CONTEXT/CONSTRAINTS/KNOWN_FAILURES/OPEN_QUESTIONS.
3. **Output Validation**: Checks format compliance, detects hallucinations by diffing output vocabulary against input. Invalid LLM output falls back to deterministic output.

Graceful degradation chain: deterministic -> LLM -> rule fallback -> raw passthrough. The workflow never blocks, even if the Context Service or Ollama is down.

### 6.2 — Integration Pattern

The Context Service is called as a **Dapr Workflow activity**, not inline by the PM agent:

```
PM Workflow (INTAKE phase)
  │
  ├── yield ctx.callActivity(compressContextActivity, {...})
  │   └── Dapr service invocation → context-service/compress
  │       ├── Rule engine strips irrelevant fields (instant)
  │       ├── If under token ceiling → return
  │       └── Else → Phi3.5 compression → validate → return
  │
  └── yield ctx.callActivity(consultArchitectActivity, {
        question: compressedContext  // <-- compressed, not raw
      })
```

This keeps the PM responsive, provides an independent failure domain, and gives free retry/audit via Dapr Workflow state.

### 6.3 — Context Transfer Model

The Context Service handles **horizontal context transfer** (agent → agent). It does not replace `buildAgentContext()`, which handles **vertical assembly** (system prompt + task payload + Mem0 memories) on the receiving agent.

```
Sender (PM)                    Context Service              Receiver (Architect)
─────────────────────────────────────────────────────────────────────────────────
Full workflow state ──────→  Rule engine strips      ──→  Receives compressed
+ memories                   + LLM compresses              context via Dapr
+ questions                  + validates output             invocation
                                                           │
                                                           └→ buildAgentContext()
                                                              assembles system
                                                              prompt + compressed
                                                              context + local
                                                              Mem0 memories
```

### 6.4 — Benchmark Data (from prototyping)

| Metric | Value |
|--------|-------|
| Phi3.5 serial latency | ~5.7s (1000 prompt → 330 completion tokens) |
| Throughput | ~64 tok/s on RX 6800 XT |
| 2 concurrent requests | ~7.7s each, 8.1s wall |
| 3 concurrent requests | ~9.9s each, 10.7s wall |
| OLLAMA_NUM_PARALLEL | 4 (configured, 10.3GB of 16.4GB VRAM) |
| Best compression ratio | 27-34% (v3.2 prompt) |
| Temperature | 0.1 (higher caused hallucinations) |

### 6.5 — Phase 1 Scope

Phase 1 delivers the end-to-end pipeline:
- Core compression types in `@mesh-six/core`
- Context Service Hono microservice (`apps/context-service/`)
- Deterministic rule engine with per-sender/per-receiver rules
- LLM compression via Phi3.5 with v3.2 prompt
- Output validation (format + hallucination detection)
- `compressContextActivity` workflow activity in PM
- PM INTAKE phase wired to compress → consult pattern
- Kubernetes manifests and database migration
- Tests for all components

### 6.6 — Phase 2 Preview (Not in Phase 1 Scope)

- Compression logging to `context_compression_log` table
- Mem0 reflections about what compression strategies worked/failed
- Adaptive rule engine that self-tunes based on success patterns
- Prompt rotation when specific prompts produce garbled output
- Per-agent compression profiles learned over time

### 6.7 — Milestone 6 Acceptance Criteria

- [ ] `@mesh-six/core` exports `CompressionRequest`, `CompressionResponse`, `CompressionRule` schemas
- [ ] Context Service passes `/healthz` and `/readyz` checks
- [ ] Deterministic compression handles pm-to-architect and pm-to-researcher pairs
- [ ] LLM fallback activates when deterministic output exceeds token ceiling
- [ ] Output validation catches missing sections and hallucinated terms
- [ ] LLM validation failure falls back to deterministic output (no 500s)
- [ ] Context Service unreachable → PM workflow proceeds with fallback context
- [ ] `compressContextActivity` registered in PM workflow runtime
- [ ] PM INTAKE phase uses compress → consult pattern for architect delegation
- [ ] Kubernetes manifests with Dapr annotations deploy cleanly
- [ ] `migrations/004_context_compression_log.sql` applies without errors
- [ ] All unit tests pass (rule engine, validation, formatting)
- [ ] Integration tests pass (service endpoint, workflow activity)

Full implementation plan: `docs/plans/2026-02-19-context-service.md`

---

## Event Log — Standalone Module

> Not tied to a specific milestone. Deploy when needed — the design is ready to pick up
> in a single Claude Code session. Recommended before Milestone 4 (PM agent) since the
> PM's multi-step workflows benefit most from event traceability.

**Goal**: Immutable, append-only event log capturing all significant mesh-six activity.
Provides a searchable audit trail for debugging and a foundation for future state replay/recovery.

### Design Principles

- **Append-only**: Events are never modified or deleted. Storage is cheap on Longhorn.
- **Two ingestion paths**: Passive pub/sub tap (zero agent changes) + active agent-side emit (for internal decisions).
- **Replay-ready**: Schema includes `seq` (global ordering), `aggregate_id` (scoping), and `idempotency_key` (dedup). Replay reducers are not built yet — but the data shape supports them when needed.
- **Complements, doesn't replace**: `agent_task_history` stays as the hot-path scoring table. The event log is wide and forensic, not optimized for the scorer's tight query pattern.

### Database Schema

```sql
-- migrations/003_mesh_six_events.sql

CREATE TABLE mesh_six_events (
  seq             BIGSERIAL PRIMARY KEY,
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Correlation
  trace_id        TEXT NOT NULL,
  task_id         UUID,
  agent_id        TEXT NOT NULL,

  -- Event classification
  event_type      TEXT NOT NULL,
  event_version   INT NOT NULL DEFAULT 1,

  -- Payload
  payload         JSONB NOT NULL,

  -- Replay support
  aggregate_id    TEXT,
  idempotency_key TEXT
) PARTITION BY RANGE (timestamp);

-- Create initial partitions (extend as needed)
CREATE TABLE mesh_six_events_2026_02 PARTITION OF mesh_six_events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE mesh_six_events_2026_03 PARTITION OF mesh_six_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- Indexes
CREATE INDEX idx_events_trace ON mesh_six_events (trace_id);
CREATE INDEX idx_events_task ON mesh_six_events (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_events_agent_type ON mesh_six_events (agent_id, event_type, timestamp DESC);
CREATE INDEX idx_events_aggregate ON mesh_six_events (aggregate_id, seq ASC)
  WHERE aggregate_id IS NOT NULL;
CREATE UNIQUE INDEX idx_events_idempotency ON mesh_six_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Partitioned by month for query performance. No retention policy — partitions accumulate indefinitely.
A cron job or init script should create partitions 2-3 months ahead to avoid insert failures.

### Event Types

| Family | Event Type | Source | Payload (key fields) |
|--------|-----------|--------|---------------------|
| **Pub/sub** | `task.dispatched` | event-logger subscriber | `{ capability, targetAgent, priority, scores }` |
| | `task.result` | event-logger subscriber | `{ success, durationMs, errorType? }` |
| | `task.progress` | event-logger subscriber | `{ status, details }` |
| | `task.timeout` | orchestrator | `{ agentId, timeoutMs, retryCount }` |
| | `task.retry` | orchestrator | `{ previousAgent, nextAgent, reason }` |
| **Decisions** | `llm.call` | tracedGenerateText wrapper | `{ model, systemPromptLength, promptLength, toolCount }` |
| | `llm.response` | tracedGenerateText wrapper | `{ durationMs, responseLength, toolCallCount, finishReason }` |
| | `tool.invocation` | agent tool wrapper | `{ toolName, inputSummary }` |
| | `tool.result` | agent tool wrapper | `{ toolName, success, durationMs }` |
| | `reflection.stored` | transitionClose | `{ scope, memoryCount, transitionFrom, transitionTo }` |
| **State** | `state.transition` | PM agent | `{ from, to, taskId, trigger }` |
| | `state.write` | Dapr middleware | `{ storeKey, operation }` |
| | `agent.registered` | agent startup | `{ capabilities, healthChecks }` |
| | `agent.deregistered` | agent shutdown | `{ reason }` |

Full LLM prompts/responses are NOT logged by default (too large). Only metadata is captured.
Agents can opt in to full payload logging via `{ logFullPayload: true }` in the emit call.

### Core Library: `events.ts`

```typescript
// packages/core/src/events.ts

import type postgres from "postgres";

export interface MeshEvent {
  traceId: string;
  taskId?: string;
  agentId: string;
  eventType: string;
  eventVersion?: number;
  payload: Record<string, unknown>;
  aggregateId?: string;
  idempotencyKey?: string;
}

export interface EventQueryOpts {
  traceId?: string;
  taskId?: string;
  agentId?: string;
  eventType?: string;
  afterSeq?: number;
  beforeSeq?: number;
  since?: Date;
  until?: Date;
  limit?: number;
}

export class EventLog {
  constructor(private sql: postgres.Sql) {}

  async emit(event: MeshEvent): Promise<void> {
    await this.sql`
      INSERT INTO mesh_six_events
        (trace_id, task_id, agent_id, event_type, event_version,
         payload, aggregate_id, idempotency_key)
      VALUES (
        ${event.traceId}, ${event.taskId ?? null}, ${event.agentId},
        ${event.eventType}, ${event.eventVersion ?? 1},
        ${this.sql.json(event.payload)},
        ${event.aggregateId ?? null}, ${event.idempotencyKey ?? null}
      )
    `;
  }

  async emitBatch(events: MeshEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.sql`
      INSERT INTO mesh_six_events
        ${this.sql(events.map(e => ({
          trace_id: e.traceId,
          task_id: e.taskId ?? null,
          agent_id: e.agentId,
          event_type: e.eventType,
          event_version: e.eventVersion ?? 1,
          payload: this.sql.json(e.payload),
          aggregate_id: e.aggregateId ?? null,
          idempotency_key: e.idempotencyKey ?? null,
        })))}
    `;
  }

  async query(opts: EventQueryOpts): Promise<(MeshEvent & { seq: number })[]> {
    return this.sql`
      SELECT * FROM mesh_six_events
      WHERE true
        ${opts.traceId ? this.sql`AND trace_id = ${opts.traceId}` : this.sql``}
        ${opts.taskId ? this.sql`AND task_id = ${opts.taskId}` : this.sql``}
        ${opts.agentId ? this.sql`AND agent_id = ${opts.agentId}` : this.sql``}
        ${opts.eventType ? this.sql`AND event_type = ${opts.eventType}` : this.sql``}
        ${opts.afterSeq ? this.sql`AND seq > ${opts.afterSeq}` : this.sql``}
        ${opts.beforeSeq ? this.sql`AND seq < ${opts.beforeSeq}` : this.sql``}
        ${opts.since ? this.sql`AND timestamp >= ${opts.since}` : this.sql``}
        ${opts.until ? this.sql`AND timestamp <= ${opts.until}` : this.sql``}
      ORDER BY seq ASC
      LIMIT ${opts.limit ?? 100}
    `;
  }

  async replay(aggregateId: string, afterSeq?: number): Promise<(MeshEvent & { seq: number })[]> {
    return this.sql`
      SELECT * FROM mesh_six_events
      WHERE aggregate_id = ${aggregateId}
        ${afterSeq ? this.sql`AND seq > ${afterSeq}` : this.sql``}
      ORDER BY seq ASC
    `;
  }
}
```

### Traced LLM Wrapper: `llm.ts`

```typescript
// packages/core/src/llm.ts
// Direct LiteLLM HTTP calls with automatic event logging
// Replaced Vercel AI SDK — uses OpenAI-compatible chat/completions endpoint

import type { EventLog } from "./events";

interface TraceContext {
  eventLog: EventLog;
  traceId: string;
  agentId: string;
  taskId?: string;
  logFullPayload?: boolean;  // Default false — opt in for debugging
}

// Core chat completion — direct fetch to LiteLLM
export async function chatCompletion(opts: {
  model: string;
  system?: string;
  prompt: string;
  messages?: Array<{ role: string; content: string }>;
}): Promise<{ text: string }> {
  // Builds messages array from system + prompt, POSTs to LiteLLM /chat/completions
  // Returns { text } extracted from response.choices[0].message.content
}

// Structured output via Zod schema → prompt injection
export async function chatCompletionWithSchema<S extends z.ZodTypeAny>(opts: {
  model: string;
  schema: S;
  system?: string;
  prompt: string;
}): Promise<{ object: z.infer<S> }> {
  // Injects JSON schema description into prompt, parses response as JSON,
  // validates against Zod schema. Retries on parse failure.
}

// Traced version — wraps chatCompletion with EventLog emission
export async function tracedChatCompletion(
  opts: { model: string; system?: string; prompt: string },
  ctx: TraceContext | null  // null = skip tracing (graceful degradation)
): Promise<{ text: string }> {
  // Emits llm.call event before, llm.response event after
  // Falls back to plain chatCompletion if ctx is null
}
```

### Event Logger Service

A lightweight Bun service that subscribes to all Dapr pub/sub topics and writes
events to the log. Deployed as a standalone pod with a Dapr sidecar.

```typescript
// apps/event-logger/src/index.ts (sketch)
//
// Subscribes to:
//   - tasks.* (wildcard — all agent task topics)
//   - task-results
//   - task-progress
//
// For each message: extract trace_id, task_id, agent_id from the Dapr
// CloudEvent envelope, classify the event type, write to mesh_six_events.
//
// This service has NO LLM dependency — it's pure infrastructure.
// ~100 lines of code. Single responsibility.
```

### Integration Points

When agents adopt the event log:

1. Replace `chatCompletion()` calls with `tracedChatCompletion()` from `@mesh-six/core`
2. Add `EventLog` instance alongside existing `AgentRegistry` and `AgentScorer` in agent setup
3. Generate a `traceId` (UUID) at task receipt, thread it through all operations
4. The `event-logger` service handles pub/sub events with no agent code changes

### Replay (Future — Design Only)

State reconstruction follows this pattern when eventually built:

```
replay("task:{uuid}")
  → returns ordered events for that task
  → reducer function applies each event to build state:
      task.dispatched → { status: "dispatched", agent: "..." }
      llm.call → { ...state, llmCalls: [..., { model, timestamp }] }
      state.transition → { ...state, currentState: "REVIEW" }
      task.result → { ...state, status: "completed", result: {...} }
```

The reducer is task-type-specific. PM workflows have the most complex reducers
because they have the most state transitions. Simple agent tasks need only
dispatched → result.

### Event Log Acceptance Criteria

- [x] `mesh_six_events` table created with monthly partitions
- [x] Partition auto-creation script/cron (creates 3 months ahead)
- [x] `EventLog` class in `@mesh-six/core` with emit, emitBatch, query, replay
- [x] `tracedChatCompletion` wrapper in `@mesh-six/core` llm.ts
- [x] `event-logger` service deployed, subscribing to all pub/sub topics
- [x] Events queryable by trace_id, task_id, agent_id, event_type, time range
- [x] Existing agents migrated to `tracedChatCompletion` from `@mesh-six/core`
- [ ] Events visible in Grafana (Loki or direct PostgreSQL datasource)

---

## Cross-Cutting Concerns

### Security

- All agent-to-agent communication through Dapr sidecars (mTLS by default)
- Secrets managed via Kubernetes secrets (existing Vault integration path)
- Dapr access control policies to restrict which agents can invoke others
- GitHub/Gitea API tokens stored as k8s secrets, injected via env vars
- Mem0 accessible only within `mesh-six` namespace (NetworkPolicy)

### Observability

- **Traces**: Dapr auto-generates OpenTelemetry traces → Grafana Tempo
- **Logs**: Structured JSON logs from Bun → Loki (via existing log collection)
- **Metrics**: Dapr sidecar metrics → Prometheus/Mimir → Grafana dashboards
- **Dashboard**: `@mesh-six/dashboard` — React + Vite app with MQTT WebSocket for real-time agent activity

### Error Handling

- Agents always ACK messages to Dapr (return 200) even on internal failure
- Failures reported via task result messages to orchestrator
- Orchestrator handles retry logic and re-scoring
- Dead letter queues in RabbitMQ for unprocessable messages
- Dapr resiliency policies for timeouts and circuit breaking

### Context Window Management

Mesh Six agents maintain small, predictable context windows through three core patterns:
**stateless task dispatch** (most agents), **reflect-before-reset** (stateful agents like PM),
and **horizontal context compression** (Context Service, Milestone 6).

**Horizontal vs. Vertical Context:**
- **Horizontal transfer** (agent → agent): The Context Service compresses accumulated sender state
  before it crosses an agent boundary. This strips irrelevant workflow metadata and focuses the
  payload on what the receiving agent actually needs. See [Milestone 6](#milestone-6--context-service).
- **Vertical assembly** (within an agent): `buildAgentContext()` assembles system prompt + task
  payload + scoped Mem0 memories into the LLM call. This happens on the receiving agent after
  it receives the (already compressed) context from the sender.

A third pattern handles **horizontal context transfer** between agents: the **Context Service** (Milestone 6). When the PM delegates to a specialist agent, it calls the Context Service to produce a compressed, budget-bounded briefing before invoking the target agent. This separates two distinct concerns:

- `buildAgentContext()` — **vertical assembly**: combines system prompt + task JSON + Mem0 memories for a single agent's LLM call. Governs what one agent knows about its own task.
- **Context Service** — **horizontal transfer**: compresses a sender's state payload before handing it to a receiver agent. Governs what crosses the agent-to-agent boundary. Uses deterministic rules first and falls back to Phi3.5 (Ollama) only when needed.

#### Design Principle: Each Task is a Fresh AI Call

Most agents (deployers, Architect, Researcher) receive a task, process it, and return a result.
There is no persistent conversation — each LLM call is independent. Memory continuity comes
from Mem0 retrieval, not from accumulating messages in a context window.

#### Token Budget per Agent Call

| Component | Budget | Notes |
|-----------|--------|-------|
| System prompt | 500–1,000 | Agent role, capabilities, homelab context |
| Task/state payload | 200–500 | Structured JSON from Dapr state store |
| Mem0 retrievals | ~1,000 | 5 results × ~200 tokens, scoped by relevance |
| Tool call results | 1,000–3,000 | kubectl output, API responses, etc. |
| **Total per call** | **~3–5k** | ~5% of Claude's context window |

#### `buildAgentContext` Utility

Every agent uses `buildAgentContext()` from `@mesh-six/core` before making an LLM call.
This function assembles system prompt + task payload + scoped Mem0 retrieval + tool schemas,
with a configurable token ceiling. If retrieval results push past the budget, it truncates
the lowest-relevance memories.

```typescript
// packages/core/src/context.ts

export interface ContextConfig {
  agentId: string;
  systemPrompt: string;
  task: TaskRequest;
  memoryQuery?: string;         // Scoped query for Mem0 retrieval
  maxMemoryTokens?: number;     // Default: 1500
  maxToolResultTokens?: number; // Default: 3000
  additionalContext?: string;   // Structured state, previous reflections, etc.
}

export interface AgentContext {
  system: string;
  prompt: string;
  estimatedTokens: number;
}

export async function buildAgentContext(
  config: ContextConfig,
  memory: AgentMemory
): Promise<AgentContext> {
  const maxMemTokens = config.maxMemoryTokens ?? 1500;

  // Retrieve scoped memories
  let memories: string[] = [];
  if (config.memoryQuery) {
    memories = await memory.remember(config.memoryQuery);
    // Rough token estimation: 1 token ≈ 4 chars
    let totalChars = memories.join("\n").length;
    while (totalChars > maxMemTokens * 4 && memories.length > 1) {
      memories.pop(); // Drop lowest-relevance (last) result
      totalChars = memories.join("\n").length;
    }
  }

  const memoryBlock = memories.length > 0
    ? `\n\nRelevant context from past interactions:\n${memories.map(m => `- ${m}`).join("\n")}`
    : "";

  const stateBlock = config.additionalContext
    ? `\n\nCurrent state:\n${config.additionalContext}`
    : "";

  return {
    system: config.systemPrompt,
    prompt: `${JSON.stringify(config.task.payload)}${memoryBlock}${stateBlock}`,
    estimatedTokens: Math.ceil(
      (config.systemPrompt.length + memoryBlock.length + stateBlock.length) / 4
    ),
  };
}
```

#### Reflect-Before-Reset Pattern (Stateful Agents)

For agents with multi-step lifecycles (primarily the PM agent), context resets at each
state boundary. Before discarding context, the agent runs a **structured reflection** to
extract insights worth preserving in Mem0. The next state transition starts fresh but
retrieves relevant memories — including reflections from previous transitions.

This creates a learning loop: agents improve over time while keeping context windows small.

**Lifecycle of a state transition:**

1. Load system prompt + structured task state (from Dapr state store)
2. Retrieve scoped memories from Mem0 for *this* transition type
3. Execute the transition (tool calls, reasoning, decision)
4. **Structured reflection** → selective Mem0 storage
5. Update Dapr state with transition result
6. Context dies — next transition starts fresh

**Reflection prompt (structured, not open-ended):**

```typescript
// packages/core/src/context.ts

export const REFLECTION_PROMPT = `
Before this transition completes, reflect on what happened:

1. OUTCOME: What happened and why?
2. PATTERN: Is this similar to something that's happened before?
3. GUIDANCE: What should the next state know that isn't in the structured task data?
4. REUSABLE: Is there anything here that applies beyond this specific task?

Only store memories that have future value. Not everything is worth remembering.
Respond with JSON: { "memories": [{ "content": "...", "scope": "task" | "agent" | "global" }] }
If nothing is worth remembering, respond with: { "memories": [] }
`;
```

**`transitionClose` utility:**

```typescript
// packages/core/src/context.ts

export interface TransitionCloseConfig {
  agentId: string;
  taskId: string;
  transitionFrom: string;    // e.g., "VALIDATE"
  transitionTo: string;      // e.g., "ACCEPTED"
  conversationHistory: Array<{ role: string; content: string }>;
  taskState: Record<string, unknown>;
}

export async function transitionClose(
  config: TransitionCloseConfig,
  memory: AgentMemory,
  model: string // LLM model name for chatCompletionWithSchema
): Promise<void> {
  const { object } = await chatCompletionWithSchema({
    model,
    schema: z.object({
      memories: z.array(z.object({
        content: z.string(),
        scope: z.enum(["task", "agent", "global"]),
      })),
    }),
    system: `You are reflecting on a state transition in a project management workflow.
             Transition: ${config.transitionFrom} → ${config.transitionTo}
             Task ID: ${config.taskId}`,
    prompt: REFLECTION_PROMPT,
  });

  // Store each reflection with appropriate scoping
  for (const mem of object.memories) {
    const prefix = mem.scope === "global"
      ? "mesh-six-learning"
      : mem.scope === "agent"
        ? config.agentId
        : `task-${config.taskId}`;

    await memory.store([
      { role: "system", content: `[${config.transitionFrom}→${config.transitionTo}] ${mem.content}` },
    ], prefix);
  }
}
```

**Memory scoping:**

| Scope | Stored As | Retrieved By |
|-------|-----------|-------------|
| `task` | `task-{taskId}` | Same task's future transitions |
| `agent` | `{agentId}` | Same agent type across all tasks |
| `global` | `mesh-six-learning` | Any agent (cross-pollination) |

The `global` scope is how the PM's deployment learnings reach the Architect agent.
Example: PM reflects "Go services in this cluster use /healthz not /health" → stored globally
→ Architect retrieves it when recommending health check configuration for future Go services.

### Testing Strategy

- Unit tests: Agent logic, scoring algorithm, registry operations
- Integration tests: Dapr pub/sub round-trip, state store operations
- End-to-end: Orchestrator → agent → result flow in test namespace
- Each milestone has acceptance criteria that serve as the test plan

---

## Repository Structure

```
mesh-six/
├── packages/
│   └── core/                    # @mesh-six/core shared library (v0.9.0)
│       ├── src/
│       │   ├── types.ts         # Shared type definitions (Zod schemas) — agent, task, auth, session, board event types
│       │   ├── registry.ts      # Agent registry (Dapr state)
│       │   ├── scoring.ts       # Agent scoring logic
│       │   ├── llm.ts           # LLM module — chatCompletion, chatCompletionWithSchema, tracedChatCompletion (direct LiteLLM HTTP)
│       │   ├── context.ts       # Context builder + reflect-before-reset
│       │   ├── compression.ts   # Compression request/response types (M6)
│       │   ├── events.ts        # Immutable event log (append-only)
│       │   ├── memory.ts        # Mem0 client wrapper
│       │   ├── github.ts        # GitHubProjectClient — Projects v2 GraphQL + REST, token bucket rate limiter
│       │   ├── credentials.ts   # Credential utilities (expiry check, config builders)
│       │   ├── dialog-handler.ts # Claude CLI dialog detection and handling
│       │   ├── git.ts           # Typed git operations (clone, worktree, diff, status)
│       │   ├── pr-filter.ts     # PR/issue filtering (author, label, branch, draft)
│       │   ├── comment-generator.ts # LLM-powered GitHub comment generation
│       │   ├── architect-actor.ts # ArchitectActor types and event schemas
│       │   ├── research-types.ts  # Research sub-workflow Zod schemas + constants
│       │   ├── research-minio.ts  # Research MinIO helpers (claim check pattern)
│       │   ├── prompts/
│       │   │   └── architect-reflection.ts  # Mem0 reflection prompt for Architect
│       │   ├── tools/
│       │   │   └── web-research.ts  # Web research tool schemas (scaffolded)
│       │   └── index.ts         # Public exports
│       ├── __tests__/           # Test suite
│       ├── package.json
│       └── tsconfig.json
├── apps/
│   ├── orchestrator/            # Task routing + scoring service
│   ├── simple-agent/            # Milestone 1 proof of concept
│   ├── argocd-deployer/         # Milestone 3 - GitOps deployer
│   ├── kubectl-deployer/        # Milestone 3 - Direct k8s deployer
│   ├── architect-agent/         # Milestone 3/4.5 - Tech consultation + Dapr Actor
│   ├── researcher-agent/        # Milestone 3 - Multi-provider research
│   ├── qa-tester/               # Milestone 3 - QA & test automation
│   ├── api-coder/               # Milestone 3 - Backend API development
│   ├── ui-agent/                # Milestone 3 - Frontend UI development
│   ├── project-manager/         # Milestone 4/4.5 - Event-driven Dapr Workflow
│   ├── claude-mqtt-bridge/      # Milestone 4 - Claude Code hooks → MQTT + SQLite
│   ├── dashboard/               # Milestone 4 - React 19 + Vite + Tailwind 4 monitoring UI
│   ├── webhook-receiver/        # Milestone 4.5 - GitHub Projects webhook bridge
│   ├── auth-service/            # Milestone 4.5 - Credential lifecycle management
│   ├── implementer/             # Milestone 4.5 - Claude CLI in tmux (Dapr Actor StatefulSet)
│   ├── llm-service/             # Milestone 4.5 - Claude CLI gateway (Dapr Actor)
│   ├── homelab-monitor/         # Milestone 5 - Cluster health + log analysis
│   ├── infra-manager/           # Milestone 5 - DNS, firewall, proxy management
│   ├── cost-tracker/            # Milestone 5 - LLM spend + resource tracking
│   ├── context-service/         # Milestone 6 - Context compression proxy
│   └── event-logger/            # Standalone — pub/sub event tap
├── templates/
│   └── plans/                   # Planning phase templates (plan.md, prompt.md, checklist.md, decisions.md)
├── scripts/
│   ├── migrate.ts               # Database migration runner
│   ├── push-credentials.ts      # Push local Claude credentials to auth-service
│   ├── cleanup.ts               # Stale session/checkpoint cleanup (CronJob)
│   ├── credential-backup.ts     # Credential backup to MinIO (CronJob)
│   ├── credential-history.ts    # Credential audit trail report
│   ├── debug-db.ts              # Database diagnostics
│   ├── onboard-repo.ts          # Register repo in repo_registry + setup GitHub Project
│   ├── setup-project.ts         # One-time auth project setup
│   └── test-research-workflow.ts # Research sub-workflow test script
├── docs/
│   ├── PLAN.md                  # This document — architecture and milestones
│   ├── PLAN_45_GWA.md           # Detailed GWA integration plan
│   └── CLAUDE_PROGRESS_UI.md    # Guide for building Claude progress UIs
├── dapr/
│   └── components/              # Local dev copies (authoritative configs in k8s/base/dapr-components/)
│       ├── statestore-redis.yaml
│       ├── pubsub-rabbitmq.yaml
│       ├── outbox-postgresql.yaml
│       └── resiliency.yaml
├── k8s/
│   ├── base/                    # Base kustomize manifests (~25 service directories)
│   │   ├── namespace.yaml
│   │   ├── kustomization.yaml
│   │   ├── secrets.yaml
│   │   ├── vault-external-secrets.yaml
│   │   ├── dapr-components/     # Authoritative Dapr component configs
│   │   ├── simple-agent/
│   │   ├── orchestrator/
│   │   ├── auth-service/
│   │   ├── implementer/         # StatefulSet with PVCs
│   │   ├── llm-service/
│   │   ├── webhook-receiver/    # Includes Ingress for GitHub webhooks
│   │   ├── cleanup-cronjob/     # Daily 3am cleanup
│   │   ├── credential-backup-cronjob/  # Every 6h credential backup
│   │   └── ...per-agent/
│   └── overlays/
│       ├── dev/                 # Local development overrides
│       └── prod/                # Production cluster (all agents)
├── migrations/
│   ├── 001_agent_task_history.sql
│   ├── 002_repo_registry.sql
│   ├── 003_mesh_six_events.sql
│   ├── 004_pm_workflow_instances.sql
│   ├── 005_context_compression_log.sql
│   ├── 006_auth_tables.sql
│   ├── 007_session_tables.sql
│   ├── 008_pm_retry_budget.sql
│   ├── 009_architect_events.sql
│   ├── 010_session_resume_fields.sql
│   ├── 011_terminal_streaming.sql
│   ├── 012_onboarding_runs.sql
│   ├── 013_orchestrator_tasks.sql
│   └── 014_research_sessions.sql
├── docker/
│   ├── Dockerfile.agent         # Shared Dockerfile for Bun agents
│   ├── Dockerfile.implementer   # Custom: Bun + tmux + git + Claude CLI
│   ├── Dockerfile.llm-service   # Custom: Bun + Claude CLI
│   ├── Dockerfile.dashboard     # Vite SPA + nginx
│   └── Dockerfile.claude-agent  # Claude CLI agent image
├── .github/
│   └── workflows/
│       ├── build-deploy.yaml    # CI/CD: Kaniko matrix build on self-hosted runner
│       └── test.yaml            # PR validation: typecheck + core tests
├── bunfig.toml
├── package.json                 # Workspace root
└── README.md
```

---

## Deployment Strategy

### GitOps Flow

1. Code changes pushed to `mesh-six` repository
2. GitHub Actions triggers Kaniko builds on self-hosted k3s runner (matrix per agent, change detection)
3. Images pushed to internal Gitea registry (`gitea-http.gitea-system.svc.cluster.local:3000/jaybrto/mesh-six-{agent}`)
4. Tags: `:latest` and `:{sha}` per agent
5. ArgoCD Application (`k8s/argocd-application.yaml`) detects change, syncs to k3s cluster with automated prune + selfHeal
6. Dapr sidecar injector automatically attaches sidecars to new pods

### Bun Workspace

The repository uses Bun workspaces so all packages share dependencies and the core library is linked locally:

```json
// package.json (root)
{
  "workspaces": [
    "packages/*",
    "apps/*"
  ]
}
```

### Container Images

Primary Dockerfile for most Bun agents, parameterized by build arg. Specialized agents use custom Dockerfiles.

```dockerfile
# docker/Dockerfile.agent — shared by most agents
FROM oven/bun:latest AS builder
WORKDIR /app
COPY . .
ARG AGENT_APP=simple-agent
RUN bun install --frozen-lockfile
RUN bun build apps/${AGENT_APP}/src/index.ts --target=bun --outdir=dist

FROM oven/bun:latest
WORKDIR /app
COPY --from=builder /app/dist .
EXPOSE 3000
CMD ["bun", "run", "index.js"]
```

Additional Dockerfiles:
- `Dockerfile.implementer` — Bun + tmux + git + Claude CLI (for implementer StatefulSet)
- `Dockerfile.llm-service` — Bun + Claude CLI (for llm-service actor runtime)
- `Dockerfile.dashboard` — Vite build + nginx static server
- `Dockerfile.claude-agent` — Claude CLI agent base image

Container registry: `registry.bto.bar/jaybrto/mesh-six-{agent-name}` (Gitea via external Caddy proxy for pull; CI pushes to internal `gitea-http.gitea-system.svc.cluster.local:3000`). Vault + External Secrets Operator syncs secrets from `secret/data/mesh-six`.

---

## How to Use This Document

Each milestone section contains enough context for a standalone Claude Code session. When starting a milestone:

1. Share this document with Claude Code
2. Point to the specific milestone section
3. Reference the cross-cutting concerns and repository structure
4. Use the acceptance criteria as the definition of done

Milestones are designed to be completed in order. Each builds on the infrastructure and patterns established by the previous one. However, within Milestone 3, the four agents can be built in parallel or any order.

**Recommended session structure**:
- Milestone 1: One session for core library + orchestrator + simple agent + Dapr configs + k8s manifests
- Milestone 2: One session for Mem0 deployment + memory integration
- Milestone 3: One session per agent (4 sessions), or 2 sessions grouping deployers and brain agents
- Milestone 4: 2-3 sessions (state machine + GitHub integration + Gitea integration)
- Milestone 5: One session per agent
- Milestone 6: One session — context-service app + PM workflow integration + k8s manifests + unit tests

---

*Document created: February 10, 2026*
*Architecture designed through iterative discussion between Jay and Claude*
*Last updated: v1.6 — ResearchAndPlan sub-workflow (PR #13), claim check pattern via MinIO, whenAny-based hibernation, Mem0 reflection after planning, research-types/research-minio/architect-reflection/web-research core modules, 014_research_sessions migration*
