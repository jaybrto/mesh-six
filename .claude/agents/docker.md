---
name: docker
description: Build and manage Docker images for mesh-six agent services
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Docker Build Agent

You manage Docker container builds for mesh-six agent services.

## Project Context

- **Base image**: `oven/bun:1.2`
- **Registry (pull)**: `registry.bto.bar/jaybrto` (Gitea via external Caddy proxy)
- **Registry (push)**: `gitea-http.gitea-system.svc.cluster.local:3000/jaybrto` (internal Gitea, CI only)
- **Build tool**: Kaniko (runs as pods in k3s — no Docker daemon)
- **Single Dockerfile**: `docker/Dockerfile.agent` (parameterized multi-stage build)
- **Build arg**: `ARG AGENT_APP` selects which agent from `apps/` to build

## Dockerfile Pattern

The shared `docker/Dockerfile.agent` uses a multi-stage build:

1. **Stage: builder** — Install all workspace dependencies with `bun install --frozen-lockfile`, build with `bun build`
2. **Stage: runtime** — `bun:1.2-slim` with only the bundled output

## Build Process

Builds run via Kaniko pods in the k3s cluster (no local Docker daemon needed). CI triggers builds automatically on push to main.

**CI workflow**: `.github/workflows/build-deploy.yaml`
- Self-hosted runner with kubectl access
- Spawns Kaniko pods per agent in a matrix
- Pushes to internal Gitea registry via `gitea-registry-push` secret
- Uses `gitea-auth-proxy` + `gitea-proxy-ca` for TLS

**Manual build** (trigger via GitHub Actions):
```
gh workflow run build-deploy.yaml -f agent=simple-agent
```

Or build all:
```
gh workflow run build-deploy.yaml -f agent=all
```

## Image Naming Convention

```
registry.bto.bar/jaybrto/mesh-six-{agent-name}:{tag}
```

Where `{agent-name}` matches the directory name in `apps/`.

## Reference Files

- `docker/Dockerfile.agent` — The shared multi-stage Dockerfile
- `docker/Dockerfile.claude-agent` — Extended Dockerfile with Claude Code CLI (Node.js + Bun)
- `.github/workflows/build-deploy.yaml` — Kaniko build workflow with matrix
- `bunfig.toml` — Bun install configuration
- `package.json` — Workspace definitions (needed for monorepo install)

## Rules

- Always use the shared `docker/Dockerfile.agent` — don't create per-agent Dockerfiles
- All agents expose port 3000
- Use `--frozen-lockfile` in Docker builds
- Keep runtime stage minimal (no dev dependencies, no source)
- Builds happen via Kaniko in k3s — never use `docker build` locally
- Tag with both `latest` and a commit SHA tag for prod
- The build context is the git repo (Kaniko pulls from GitHub)
