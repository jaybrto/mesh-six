# Agent Mesh — Implementation Plan

> A microservices-based multi-agent orchestration system for k8s cluster.
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
9. [Milestone 5 — Infrastructure Agents](#milestone-5--infrastructure-agents)
10. [Cross-Cutting Concerns](#cross-cutting-concerns)
11. [Repository Structure](#repository-structure)
12. [Deployment Strategy](#deployment-strategy)

---

## Architecture Overview

Agent Mesh is a collection of independent microservices deployed to a 6-node k3s cluster. Each agent is a Bun HTTP server with a Dapr sidecar that provides state management, pub/sub messaging, and service-to-service invocation. Agents communicate exclusively through Dapr — never directly to each other.

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
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │    │
│  │  │PostgreSQL│  │  Redis   │  │  Mem0 (Python    │  │    │
│  │  │HA + pgvec│  │  Cluster │  │  container)      │  │    │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │    │
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
| Agent Framework | Vercel AI SDK | Best-in-class LLM interaction (tool calling, streaming, structured output). Multi-provider (Anthropic, OpenAI-compatible/LiteLLM, Ollama). |
| Agent Communication | Dapr (service invocation + pub/sub) | Language-agnostic, observability built-in, decouples agents from infrastructure. Already deployed in cluster. |
| Message Broker | RabbitMQ | Primary messaging infra, HA via operator, quorum queues, MQTT plugin for real-time. Replaces NATS for agent comms. |
| LLM Gateway | Existing Ollama + LiteLLM | Already running. OpenAI-compatible API for Vercel AI SDK. No changes needed. |
| Memory Layer | Mem0 (containerized Python service) | Proven architecture, pgvector support, REST API. Python is quarantined — never touched by developer. |
| Short-term Memory | Redis (via Dapr state store) | Session context, agent working memory. Already running HA. |
| Long-term Memory | PostgreSQL + pgvector (via Mem0) | Persistent memory, vector similarity search. Already running HA (3-pod). |
| Agent Discovery | Custom registry in Dapr state store | Lightweight, ~50 lines. Agents self-register with capabilities, health checks, weights. |
| Agent Scoring | Weighted routing with historical performance | Base weights + dependency health checks + rolling success rate from task history. |
| Hosting Model | Standalone services (not Dapr Actors) | Simpler to debug and reason about. Migration path to actors preserved. |
| Failure Handling | Option A — timeout + retry + re-score | Agent timeout → report failure → orchestrator re-scores → dispatch to next agent. No mid-task failover (Milestone 1). |
| Deployment | ArgoCD + GitOps | All agent manifests in Git. Kustomize for environment overlays. Standard homelab pattern. |
| Observability | OpenTelemetry → Grafana LGTM stack | Dapr emits traces/metrics automatically. Flows to existing Grafana/Loki/Mimir/Tempo. |

---

## Technology Stack

### Runtime & Libraries

| Component | Package | Purpose |
|-----------|---------|---------|
| Runtime | `bun` (latest) | JavaScript/TypeScript runtime |
| AI SDK | `ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` | LLM interaction, tool calling, structured output |
| Dapr Client | `@dapr/dapr` | State, pub/sub, service invocation, bindings |
| HTTP Server | `Hono` | Lightweight HTTP framework for agent endpoints |
| Validation | `zod` | Schema validation for structured outputs and messages |
| Task History | `postgres` (porsager) | Direct PostgreSQL queries for agent scoring |

### Infrastructure (Already Running)

| Service | Role in Agent Mesh |
|---------|-------------------|
| RabbitMQ HA (operator) | Pub/sub backbone, task routing, MQTT events |
| PostgreSQL HA (3-pod) | Task history, agent scoring data, Mem0 vector storage |
| Redis Cluster | Dapr state store (agent registry, session state) |
| Ollama + LiteLLM | LLM inference gateway |
| ArgoCD | GitOps deployment of agent services |
| Traefik | Ingress for agent HTTP endpoints |
| Caddy | Reverse proxy for external access |
| Grafana LGTM | Observability (traces, logs, metrics) |
| Dapr | Sidecar runtime for all agents |

### New Infrastructure (To Deploy)

| Service | Milestone | Purpose |
|---------|-----------|---------|
| Mem0 (Python container) | 2 | Memory extraction and retrieval service |
| pgvector extension | 2 | Vector similarity search in PostgreSQL |

---

## Agent Roster

| Agent | Dapr App ID | Type | Communication | Milestone |
|-------|-------------|------|---------------|-----------|
| Orchestrator | `orchestrator` | Long-running service | Pub/sub (dispatch), service invocation (query) | 1 |
| Simple Agent | `simple-agent` | Request-response | Pub/sub (receive tasks) | 1 |
| Memory Service | `mem0-service` | Infrastructure | HTTP REST API | 2 |
| ArgoCD Deployer | `argocd-deployer` | Request-response | Pub/sub (receive tasks) | 3 |
| Kubectl Deployer | `kubectl-deployer` | Request-response | Pub/sub (receive tasks) | 3 |
| Architect | `architect-agent` | Request-response | Service invocation (consulted by PM/orchestrator) | 3 |
| Researcher | `researcher-agent` | Request-response | Service invocation (consulted by Architect/PM) | 3 |
| Project Manager | `project-manager` | Dapr Workflow (long-running) | Pub/sub + service invocation + workflow | 4 |
| Homelab Monitor | `homelab-monitor` | Request-response | Pub/sub (receive tasks) | 5 |
| Infra Manager | `infra-manager` | Request-response | Pub/sub (receive tasks) | 5 |
| Cost Tracker | `cost-tracker` | Request-response | Scheduled + on-demand | 5 |

---

## Milestone 1 — Hello Agent

**Goal**: Prove the entire pattern end-to-end. One agent, one orchestrator, Dapr sidecars, RabbitMQ pub/sub, Redis state, deployed to k3s via ArgoCD.

**Deliverables**: Working orchestrator + simple agent that answers questions using LiteLLM gateway. Agent self-registers in registry. Orchestrator discovers and dispatches to agent. Full observability in Grafana.

**Value**: A self-hosted AI assistant reachable via your Caddy/Cloudflare setup.

### 1.1 — Shared Library: `@mesh-six/core`

A shared package containing types, utilities, and the Dapr integration layer that every agent uses.

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
import { DaprClient, DaprServer } from "@dapr/dapr";
import { generateText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { AgentRegistry, type AgentRegistration } from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "simple-agent";
const AGENT_NAME = process.env.AGENT_NAME || "Simple Agent";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const APP_PORT = process.env.APP_PORT || "3000";

// --- LLM Provider (LiteLLM exposes OpenAI-compatible API) ---
const llm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: process.env.LITELLM_API_KEY || "sk-local",
});

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
agent mesh. You can answer general questions and help with basic tasks.
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
    await daprClient.pubsub.publish("agent-pubsub", "task-results", result);

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
    await daprClient.pubsub.publish("agent-pubsub", "task-results", failResult);
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

  const { text } = await generateText({
    model: llm("anthropic/claude-sonnet-4-20250514"), // via LiteLLM
    system: SYSTEM_PROMPT,
    prompt: task.payload.query || JSON.stringify(task.payload),
    // tools: { ... } // Add agent-specific tools here
  });

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
- [ ] ArgoCD Application resource manages the deployment

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

### 2.2 — Deploy Mem0 as Container

```yaml
# k8s/base/mem0/deployment.yaml
# Mem0 open-source server with PostgreSQL + pgvector backend
# Configuration points to existing PostgreSQL HA cluster
# REST API exposed internally within the cluster
# No developer Python interaction required — pure infrastructure
```

Key Mem0 configuration:
- Vector store: PostgreSQL with pgvector (existing HA cluster)
- LLM provider: LiteLLM endpoint (for embedding generation)
- Embedder: OpenAI-compatible via LiteLLM

### 2.3 — Memory Integration in Core Library

```typescript
// packages/core/src/memory.ts

export class AgentMemory {
  constructor(
    private mem0Url: string,  // e.g., "http://mem0-service.mesh-six:8080"
    private agentId: string
  ) {}

  async remember(query: string, userId?: string): Promise<string[]> {
    // Search Mem0 for relevant memories
    const res = await fetch(`${this.mem0Url}/v1/memories/search/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        agent_id: this.agentId,
        user_id: userId || "default",
        limit: 5,
      }),
    });
    const data = await res.json();
    return data.results?.map((r: any) => r.memory) || [];
  }

  async store(messages: Array<{ role: string; content: string }>, userId?: string): Promise<void> {
    // Store conversation in Mem0 — it extracts memories automatically
    await fetch(`${this.mem0Url}/v1/memories/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        agent_id: this.agentId,
        user_id: userId || "default",
      }),
    });
  }
}
```

### 2.4 — Milestone 2 Acceptance Criteria

- [x] pgvector extension enabled on PostgreSQL HA cluster (v0.7.0 already installed)
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
**Communication**: Synchronous via Dapr service invocation (consulted by PM and orchestrator)
**System Prompt**: Encodes Jay's homelab knowledge, tech preferences, and decision patterns
**Memory**: Long-term via Mem0 (past architectural decisions and outcomes)
**Tools**:
- `query_cluster_state` — Current k8s resource usage and running services
- `query_service_health` — Grafana/Prometheus metrics for services
- `query_past_decisions` — Search Mem0 for architectural history
- `query_resource_usage` — Cluster capacity and consumption

**Key behavior**: Returns structured output with tech stack recommendation, deployment strategy, and reasoning. Reasoning is stored in memory for future reference.

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
- Two-step structured output: tools gather context, then generateObject creates recommendation
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
- Uses Vercel AI SDK structured output to evaluate plan against requirements
- Returns verdict: `{ approved: boolean, concerns: string[], suggestions: string[] }`

At QA → DEPLOY transition:
- Agent checks Playwright test results
- Evaluates test coverage against acceptance criteria

At VALIDATE → ACCEPTED transition:
- Agent hits deployed service endpoints
- Runs smoke tests against live URLs
- Evaluates health and functionality

### 4.5 — Integration with Existing `github-workflow-agents`

**Option 1 (chosen)**: Wrap existing system. PM agent manipulates project boards which trigger existing Claude Code workflows in k3s pods. Current system remains untouched.

Each repo pod has its own PVC storing:
- Git repository (with worktree support for concurrent tasks)
- SQLite database for activity tracking
- Crash recovery state for resuming interrupted work

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

**Remaining Work:**
- Deploy to k8s and run full task lifecycle end-to-end
- Test Claude MQTT Bridge in production environment

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
- **Dashboard** (future): RabbitMQ MQTT websocket feed for real-time agent activity

### Error Handling

- Agents always ACK messages to Dapr (return 200) even on internal failure
- Failures reported via task result messages to orchestrator
- Orchestrator handles retry logic and re-scoring
- Dead letter queues in RabbitMQ for unprocessable messages
- Dapr resiliency policies for timeouts and circuit breaking

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
│   └── core/                    # @mesh-six/core shared library
│       ├── src/
│       │   ├── types.ts         # Shared type definitions
│       │   ├── registry.ts      # Agent registry (Dapr state)
│       │   ├── scoring.ts       # Agent scoring logic
│       │   └── memory.ts        # Mem0 client wrapper
│       ├── package.json
│       └── tsconfig.json
├── apps/
│   ├── orchestrator/            # Task routing + scoring service
│   ├── simple-agent/            # Milestone 1 proof of concept
│   ├── argocd-deployer/         # Milestone 3 - GitOps deployer
│   ├── kubectl-deployer/        # Milestone 3 - Direct k8s deployer
│   ├── architect-agent/         # Milestone 3 - Tech consultation
│   ├── researcher-agent/        # Milestone 3 - Multi-provider research
│   ├── qa-tester/               # Milestone 3 - QA & test automation
│   ├── api-coder/               # Milestone 3 - Backend API development
│   ├── ui-agent/                # Milestone 3 - Frontend UI development
│   ├── project-manager/         # Milestone 4 - Project lifecycle + Dapr Workflow
│   ├── claude-mqtt-bridge/      # Milestone 4 - Claude Code hooks → MQTT
│   ├── homelab-monitor/         # Milestone 5
│   ├── infra-manager/           # Milestone 5
│   └── cost-tracker/            # Milestone 5
├── docs/
│   └── CLAUDE_PROGRESS_UI.md    # Guide for building Claude progress UIs
├── dapr/
│   └── components/
│       ├── statestore-redis.yaml
│       ├── pubsub-rabbitmq.yaml
│       ├── outbox-postgresql.yaml
│       └── resiliency.yaml
├── k8s/
│   ├── base/                    # Base kustomize manifests
│   │   ├── namespace.yaml
│   │   ├── simple-agent/
│   │   ├── orchestrator/
│   │   └── ...per-agent/
│   └── overlays/
│       ├── dev/                 # Local development overrides
│       └── prod/                # Production cluster
├── migrations/
│   ├── 001_agent_task_history.sql
│   └── 002_repo_registry.sql
├── docker/
│   ├── Dockerfile.agent         # Shared Dockerfile for Bun agents
│   └── Dockerfile.mem0          # Mem0 service container
├── .github/
│   └── workflows/
│       └── build-deploy.yaml    # CI/CD for agent images
├── bunfig.toml
├── package.json                 # Workspace root
└── README.md
```

---

## Deployment Strategy

### GitOps Flow

1. Code changes pushed to `mesh-six` repository
2. GitHub Actions builds container images, pushes to `registry.bto.bar`
3. Image tag updated in kustomize overlay
4. ArgoCD detects change, syncs to k3s cluster
5. Dapr sidecar injector automatically attaches sidecars to new pods

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

### Container Image

Single Dockerfile for all Bun agents, parameterized by build arg:

```dockerfile
# docker/Dockerfile.agent
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

---

*Document created: February 10, 2026*
*Architecture designed through iterative discussion between Jay and Claude*
*Last updated: Milestone plan v1.0*
