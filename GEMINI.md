# Gemini CLI — Agent Mesh (mesh-six) Context

This document provides instructional context for interacting with the **Agent Mesh (mesh-six)** project.

## Project Overview

**Agent Mesh (mesh-six)** is a microservices-based multi-agent orchestration system designed for a Kubernetes (k3s) cluster. It uses a collection of independent agents that communicate via **Dapr** (Distributed Application Runtime) for state management, pub/sub messaging, and service-to-service invocation.

The system is a **monorepo** managed with **Bun**.

### Core Architecture

- **Orchestrator:** Central service for task routing, agent discovery, and scoring based on capability and historical performance.
- **Agents:** Specialist microservices (e.g., `simple-agent`, `architect-agent`, `project-manager`) implemented as Bun HTTP servers (using **Hono**) with Dapr sidecars.
- **Dapr Integration:** Agents communicate exclusively through Dapr components (RabbitMQ for pub/sub, Redis for state, PostgreSQL for history and memory).
- **Memory Layer:** Uses `mem0ai` with a PostgreSQL + **pgvector** backend for persistent, semantically searchable agent memory.
- **Context Management:** Implements a "reflect-before-reset" pattern to maintain small, efficient LLM context windows (~3-5k tokens) by offloading long-term context to the memory layer.

## Project Structure

```text
mesh-six/
├── apps/                        # Agent and service implementations
│   ├── orchestrator/            # Task routing and agent scoring
│   ├── project-manager/         # Dapr Workflow for project lifecycles
│   ├── simple-agent/            # General-purpose LLM agent
│   ├── architect-agent/         # Technical consultation specialist
│   ├── researcher-agent/        # Multi-provider research specialist
│   ├── argocd-deployer/         # GitOps deployment specialist
│   └── ...                      # Other specialist agents
├── packages/
│   └── core/                    # @mesh-six/core: Shared types, registry, scoring, memory logic
├── dapr/
│   └── components/              # Dapr infrastructure configuration (YAML)
├── k8s/                         # Kubernetes manifests using Kustomize
├── migrations/                  # PostgreSQL SQL migrations
├── scripts/                     # Utility scripts (e.g., database migration runner)
├── docker/                      # Shared Dockerfile for Bun agents
├── PLAN.md                      # Detailed architecture and milestone documentation
└── README.md                    # High-level project summary
```

## Key Technologies

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript
- **Communication:** [Dapr](https://dapr.io/) (Pub/Sub via RabbitMQ, State via Redis/Postgres)
- **AI/LLM:** Custom `@mesh-six/core` llm module (direct LiteLLM HTTP), [LiteLLM](https://docs.litellm.ai/) (Gateway), [Ollama](https://ollama.com/) (Local models)
- **Memory:** [Mem0](https://mem0.ai/) with pgvector
- **Web Framework:** [Hono](https://hono.dev/)
- **Infrastructure:** Kubernetes (k3s), ArgoCD, PostgreSQL HA, RabbitMQ HA, Redis Cluster

## Building and Running

### Common Commands

```bash
# Install dependencies
bun install

# Build all packages and apps
bun run build

# Run specific app in development (with watch mode)
bun run --filter @mesh-six/orchestrator dev
bun run --filter @mesh-six/simple-agent dev

# Run all apps in development
bun run dev

# Run type checking
bun run typecheck

# Execute database migrations
bun run db:migrate
```

### Database Migrations

Migrations are stored in `migrations/` and managed by `scripts/migrate.ts`.
Environment variables `DATABASE_URL` or `PG_PRIMARY_URL` must be set.

## Development Conventions

### Agent Implementation

- **Standard Frameworks:** Use **Hono** for HTTP endpoints and `@mesh-six/core` llm module (`tracedChatCompletion`, `chatCompletionWithSchema`) for LLM interactions.
- **Dapr Subscriptions:** Agents should expose a `GET /dapr/subscribe` endpoint and handle tasks via `POST /tasks`.
- **Registration:** Agents must self-register with the `AgentRegistry` from `@mesh-six/core` on startup and maintain a heartbeat.
- **Structured Output:** Use `zod` schemas for all task payloads and results.

### Memory and Context

- **Small Context Windows:** Avoid passing large conversation histories. Use `AgentMemory` to retrieve only semantically relevant context.
- **Reflection:** Stateful agents (like `project-manager`) should use the `transitionClose` utility from `@mesh-six/core` to reflect on and store key insights before resetting context for the next state.
- **Core Library:** Leverage `@mesh-six/core` for shared logic to ensure consistency across the mesh.

### Environment Variables

- `DAPR_HOST`, `DAPR_HTTP_PORT`: Connectivity to Dapr sidecar.
- `LITELLM_BASE_URL`, `LITELLM_API_KEY`: Connection to the LLM gateway.
- `DATABASE_URL`: PostgreSQL connection string for the `mesh_six` database.
- `OLLAMA_URL`: Local Ollama endpoint for embeddings and memory extraction.

## Deployment

The project uses **ArgoCD** for GitOps-based deployment to Kubernetes.
Docker images are built using `docker/Dockerfile.agent`, which uses a build argument `AGENT_APP` to specify the application to build.

```bash
docker build -f docker/Dockerfile.agent --build-arg AGENT_APP=orchestrator -t registry.bto.bar/mesh-six/orchestrator:latest .
```
