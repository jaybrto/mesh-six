# Agent Mesh (mesh-six)

A microservices-based multi-agent orchestration system deployed to a 6-node k3s homelab cluster. Agents are Bun+Hono HTTP microservices with Dapr sidecars for communication (RabbitMQ pub/sub, Redis state, service invocation).

## Structure

```
mesh-six/
├── packages/core/           # @mesh-six/core — shared types, registry, scoring, LLM, memory, MinIO, research types
├── apps/
│   ├── orchestrator/        # Task routing + weighted scoring service
│   ├── project-manager/     # Dapr Workflow — board-driven lifecycle + research sub-workflow
│   ├── architect-agent/     # Dapr Actor — per-issue tech consultation + Mem0
│   ├── researcher-agent/    # Multi-provider research (Claude, Gemini, Ollama)
│   ├── implementer/         # Claude CLI in tmux — Dapr Actor StatefulSet
│   ├── auth-service/        # Credential lifecycle management
│   ├── llm-service/         # Claude CLI gateway — Dapr Actor
│   ├── webhook-receiver/    # GitHub Projects webhook → Dapr pub/sub
│   ├── onboarding-service/  # Automated project onboarding (HTTP + MCP)
│   ├── scraper-service/     # Mac Mini web scraper for deep research
│   ├── argocd-deployer/     # GitOps deployer via ArgoCD API
│   ├── kubectl-deployer/    # Direct k8s deployer + debug
│   ├── dashboard/           # React 19 + Vite + Tailwind 4 monitoring UI
│   └── ...                  # simple-agent, qa-tester, api-coder, ui-agent, etc.
├── dapr/components/         # Dapr component configs (Redis, RabbitMQ, PostgreSQL outbox)
├── k8s/                     # Kubernetes manifests (kustomize — base + dev/prod overlays)
├── migrations/              # PostgreSQL migrations (001–014)
├── scripts/                 # Operational scripts (migrate, cleanup, onboard, test)
├── templates/               # Planning phase templates
└── docker/                  # Dockerfiles (agent, implementer, llm-service, dashboard)
```

## Development

```bash
bun install                                      # Install all workspace dependencies
bun run typecheck                                # Type check all packages
bun run test                                     # Run all tests
bun run dev                                      # Dev mode (all packages, watch)
bun run --filter @mesh-six/project-manager dev   # Dev mode for one app
bun run --filter @mesh-six/core test             # Test only core library
bun run db:migrate                               # Apply pending SQL migrations
```

## Deployment

```bash
# Deploy to k8s (ArgoCD syncs automatically after image push)
kubectl apply -k k8s/overlays/prod

# CI/CD: Kaniko matrix builds on self-hosted runner → Gitea registry
# See .github/workflows/build-deploy.yaml
```

## Architecture

Full architecture, milestones, and acceptance criteria in [docs/PLAN.md](./docs/PLAN.md).

Key patterns:
- **Weighted agent scoring** — base weight × dependency health × rolling success rate × recency boost
- **Event-driven Dapr Workflows** — `waitForExternalEvent()` for zero-CPU hibernation
- **Claim Check pattern** — MinIO for large research documents
- **Reflect-before-reset** — Mem0 memory extraction at state boundaries via `transitionClose()`
- **Context compression** — horizontal agent→agent transfer via Context Service

See [CLAUDE.md](./CLAUDE.md) for detailed coding conventions and package documentation.
