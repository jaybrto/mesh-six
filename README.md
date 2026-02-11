# Agent Mesh (mesh-six)

A microservices-based multi-agent orchestration system for k8s cluster.

## Structure

```
mesh-six/
├── packages/core/        # @mesh-six/core - shared types, registry, scoring
├── apps/
│   ├── orchestrator/     # Task routing + scoring service
│   └── simple-agent/     # General-purpose LLM agent
├── dapr/components/      # Dapr component configs (Redis, RabbitMQ)
├── k8s/                  # Kubernetes manifests (kustomize)
├── migrations/           # PostgreSQL migrations
└── docker/               # Dockerfiles
```

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Build all
bun run build

# Run orchestrator locally
bun run --filter @mesh-six/orchestrator dev

# Run simple-agent locally
bun run --filter @mesh-six/simple-agent dev
```

## Deployment

```bash
# Apply database migration
psql -h <host> -U <user> -d mesh_six -f migrations/001_agent_task_history.sql

# Build and push images
docker build -f docker/Dockerfile.agent --build-arg AGENT_APP=orchestrator -t registry.bto.bar/mesh-six/orchestrator:latest .
docker build -f docker/Dockerfile.agent --build-arg AGENT_APP=simple-agent -t registry.bto.bar/mesh-six/simple-agent:latest .

# Deploy to k8s
kubectl apply -k k8s/overlays/prod
```

## Architecture

See [PLAN.md](./PLAN.md) for full architecture documentation
