# Dev Container + Envbuilder Integration Design

## Problem

GWA currently builds a single monolithic Docker image (`node:22-bookworm-slim` + tmux + git + gh + Claude CLI + 19 GWA binaries). Every onboarded project gets this exact same image regardless of its toolchain requirements. This creates two maintenance burdens:

1. **Per-project toolchains can't be customized.** A Go project needing `protoc`, or a .NET project needing the SDK, requires modifying the central Dockerfile and rebuilding. This doesn't scale as project count grows.
2. **Claude CLI and system tool upgrades require full image rebuilds.** Even a minor Claude CLI version bump rebuilds the entire image including all GWA binaries.

The goal is to split image concerns so that:
- **Consuming projects own their toolchain** via a standard `devcontainer.json` in their repo
- **GWA maintains a thin tools layer** that gets injected into whatever environment the project defines
- **Image builds happen automatically** without a Docker daemon (K3s security constraint)

## Architecture

### How Envbuilder Works

[Envbuilder](https://github.com/coder/envbuilder) is an open-source, daemonless container builder from Coder. It runs as the pod's main container image and:

1. Clones a Git repo specified by `ENVBUILDER_GIT_URL`
2. Reads `.devcontainer/devcontainer.json` from the repo
3. Builds the dev environment image **in-place** (no Docker daemon, no privileged containers)
4. Execs into `ENVBUILDER_INIT_SCRIPT` — replacing itself with the built environment

After the exec, the pod is running the project's dev environment with all specified features installed. Envbuilder supports layer caching via `ENVBUILDER_CACHE_REPO` to a container registry, making subsequent builds fast.

Key properties:
- Daemonless — no Docker socket needed, works in unprivileged K3s pods
- Caches layers to OCI registries (our Gitea registry at `registry.bto.bar`)
- Supports `devcontainer.json` features, lifecycle hooks, and Dockerfiles
- Falls back to `ENVBUILDER_FALLBACK_IMAGE` if no devcontainer.json found
- `ENVBUILDER_SKIP_REBUILD` skips rebuilding on container restart if the image is unchanged

### Image Split Strategy

**Before (monolithic):**
```
registry.bto.bar/jaybrto/github-workflow-agents:latest
├── node:22-bookworm-slim (base)
├── tmux, git, gh, sqlite3, curl, jq, etc. (system tools)
├── @anthropic-ai/claude-code (Claude CLI)
├── gwa-orchestrate, gwa-respond, ... (19 GWA binaries)
└── schema.sql
```

**After (split into two concerns):**

```
1. Custom Dev Container Feature: registry.bto.bar/jaybrto/devcontainer-features/gwa-tools
   ├── install.sh (installs tmux, gh, sqlite3, Claude CLI, downloads GWA binaries)
   └── devcontainer-feature.json (metadata, version, options)

2. Per-project devcontainer.json (lives in each consuming repo):
   {
     "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
     "features": {
       "registry.bto.bar/jaybrto/devcontainer-features/gwa-tools:1": {},
       "ghcr.io/devcontainers/features/go:1": { "version": "1.22" }
     }
   }
```

### Pod Architecture

```
StatefulSet Pod (per onboarded project)
│
├── initContainer: fix-permissions (busybox)
│   └── chown PVC dirs to runner UID
│
└── container: gwa-agent
    Image: ghcr.io/coder/envbuilder:latest
    Env:
      ENVBUILDER_GIT_URL       = https://github.com/{owner}/{repo}
      ENVBUILDER_INIT_SCRIPT   = /scripts/entrypoint.sh
      ENVBUILDER_CACHE_REPO    = registry.bto.bar/jaybrto/envbuilder-cache/{repo}
      ENVBUILDER_FALLBACK_IMAGE = mcr.microsoft.com/devcontainers/base:ubuntu
      ENVBUILDER_SKIP_REBUILD  = true
      ENVBUILDER_DOCKER_CONFIG_BASE64 = <registry auth>
      ENVBUILDER_GIT_USERNAME  = x-access-token
      ENVBUILDER_GIT_PASSWORD  = <github token>
    VolumeMounts:
      - claude-session PVC  → /home/runner/.claude
      - worktrees PVC       → /home/runner/worktrees
      - repo PVC            → /workspaces (envbuilder clones here)
      - init-script ConfigMap → /scripts/entrypoint.sh
```

After Envbuilder builds and execs, the pod is running the project's devcontainer image with:
- Project-specific tools (Go, .NET, etc.) from devcontainer features
- GWA tools (gwa-* binaries, Claude CLI, tmux, gh) from the `gwa-tools` feature
- Persistent volumes mounted at the same paths as today
- The same entrypoint ConfigMap script running GWA initialization

### Custom Dev Container Feature: `gwa-tools`

Published to `registry.bto.bar/jaybrto/devcontainer-features/gwa-tools` as an OCI artifact.

**`devcontainer-feature.json`:**
```json
{
  "id": "gwa-tools",
  "version": "1.0.0",
  "name": "GWA Tools",
  "description": "Installs GitHub Workflow Agents CLI tools, Claude Code, and required system dependencies",
  "options": {
    "claudeVersion": {
      "type": "string",
      "default": "latest",
      "description": "Claude Code CLI version to install"
    },
    "gwaVersion": {
      "type": "string",
      "default": "latest",
      "description": "GWA tools version (image tag) to download binaries from"
    }
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/common-utils",
    "ghcr.io/devcontainers/features/node"
  ]
}
```

**`install.sh`:**
```bash
#!/bin/bash
set -e

CLAUDE_VERSION="${CLAUDEVERSION:-latest}"
GWA_VERSION="${GWAVERSION:-latest}"
GWA_REGISTRY="registry.bto.bar/jaybrto"

# System dependencies
apt-get update && apt-get install -y --no-install-recommends \
    tmux sqlite3 curl jq watch ca-certificates gnupg aha wkhtmltopdf
rm -rf /var/lib/apt/lists/*

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) \
    signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
    https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y --no-install-recommends gh
rm -rf /var/lib/apt/lists/*

# Claude Code CLI (requires Node.js — installsAfter ensures node feature runs first)
if [ "$CLAUDE_VERSION" = "latest" ]; then
    npm install -g @anthropic-ai/claude-code
else
    npm install -g @anthropic-ai/claude-code@"$CLAUDE_VERSION"
fi
npm cache clean --force

# GWA binaries — download from registry OCI artifact or pre-built release
# The gwa-tools-binaries image contains just the compiled binaries at /usr/local/bin/
GWA_BINARIES_IMAGE="${GWA_REGISTRY}/gwa-tools-binaries:${GWA_VERSION}"

# Use crane or direct download to extract binaries from OCI image
# Fallback: download from MinIO release artifacts
BINARY_NAMES=(
    gwa-orchestrate gwa-respond gwa-cleanup gwa-health-check
    gwa-ask-question gwa-session-complete gwa-architect gwa-worker
    gwa-setup-project gwa-start-planning gwa-inject-prompt
    gwa-run-playwright gwa-resume-with-failures gwa-send-answer
    gwa-deploy-and-cleanup gwa-provision gwa-push-credentials
    gwa-credentials-backup gwa-planning-complete
)

RELEASE_URL="https://minio.bto.bar/gwa-releases/${GWA_VERSION}"
for bin in "${BINARY_NAMES[@]}"; do
    curl -fsSL "${RELEASE_URL}/${bin}" -o "/usr/local/bin/${bin}" && \
        chmod +x "/usr/local/bin/${bin}" || \
        echo "Warning: could not download ${bin}"
done

# Schema file
curl -fsSL "${RELEASE_URL}/schema.sql" -o "/opt/gwa/schema.sql" 2>/dev/null || true

echo "GWA tools v${GWA_VERSION} with Claude Code v${CLAUDE_VERSION} installed."
```

### GWA Binary Release Pipeline

The current Dockerfile's Stage 1 (builder) compiles 19 Bun binaries. This stage is extracted into a **separate CI job** that:

1. Runs `bun build --compile` for all 19 tools
2. Uploads the binaries to MinIO at `s3://gwa-releases/{version}/gwa-*`
3. Uploads `schema.sql` alongside the binaries
4. Optionally publishes a `gwa-tools-binaries:{version}` OCI image containing just the binaries

This decouples GWA code changes from image builds. The dev container feature's `install.sh` downloads binaries from the release bucket at build time.

### Per-Project Onboarding

When onboarding a new project, the onboarding script scaffolds a `.devcontainer/devcontainer.json` in the target repo:

**For a Go project:**
```json
{
  "name": "GWA Agent Environment",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/devcontainers/features/go:1": { "version": "1.22" },
    "registry.bto.bar/jaybrto/devcontainer-features/gwa-tools:1": {}
  },
  "remoteUser": "runner",
  "postCreateCommand": "go mod download"
}
```

**For a .NET project:**
```json
{
  "name": "GWA Agent Environment",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/devcontainers/features/dotnet:2": { "version": "8.0" },
    "registry.bto.bar/jaybrto/devcontainer-features/gwa-tools:1": {}
  },
  "remoteUser": "runner",
  "postCreateCommand": "dotnet restore"
}
```

The project team can then modify their `devcontainer.json` freely — adding linters, formatters, or tools — without touching GWA infrastructure.

### Helm Chart Changes

The Helm chart's StatefulSet template changes from:

```yaml
# Before
containers:
  - name: gwa-agent
    image: registry.bto.bar/jaybrto/github-workflow-agents:latest
```

To:

```yaml
# After
containers:
  - name: gwa-agent
    image: ghcr.io/coder/envbuilder:latest
    env:
      - name: ENVBUILDER_GIT_URL
        value: "https://github.com/{{ .Values.repo.owner }}/{{ .Values.repo.name }}"
      - name: ENVBUILDER_INIT_SCRIPT
        value: "/scripts/entrypoint.sh"
      - name: ENVBUILDER_CACHE_REPO
        value: "registry.bto.bar/jaybrto/envbuilder-cache/{{ .Values.repo.name }}"
      - name: ENVBUILDER_FALLBACK_IMAGE
        value: "mcr.microsoft.com/devcontainers/base:ubuntu"
      - name: ENVBUILDER_SKIP_REBUILD
        value: "true"
      - name: ENVBUILDER_DOCKER_CONFIG_BASE64
        valueFrom:
          secretKeyRef:
            name: gwa-secrets
            key: docker-config-base64
      - name: ENVBUILDER_GIT_USERNAME
        value: "x-access-token"
      - name: ENVBUILDER_GIT_PASSWORD
        valueFrom:
          secretKeyRef:
            name: gwa-secrets
            key: github-token
      # ... all existing GWA env vars unchanged ...
```

### Existing Entrypoint ConfigMap

The entrypoint.sh ConfigMap remains unchanged. After Envbuilder builds and execs into the dev environment, it runs `/scripts/entrypoint.sh` which performs the same initialization as today: git setup, SQLite init, orchestrator provisioning, Claude config sync, session recovery, tmux session creation.

The only difference is that the entrypoint now runs inside a project-specific container (with Go, .NET, etc.) instead of the monolithic GWA image.

## What Changes vs. What Stays

| Component | Change? | Details |
|-----------|---------|---------|
| Dockerfile | **Replaced** | No longer builds the runner image. Split into: (1) CI job for binary releases, (2) dev container feature |
| build-and-push.sh | **Replaced** | New CI job uploads binaries to MinIO instead of building/pushing Docker image |
| StatefulSet container image | **Changed** | `ghcr.io/coder/envbuilder:latest` instead of custom image |
| StatefulSet env vars | **Added** | Envbuilder-specific vars added; all existing vars unchanged |
| StatefulSet volumes | **Unchanged** | Same PVCs (claude-session, worktrees, repo) |
| Entrypoint ConfigMap | **Unchanged** | Same initialization logic |
| Orchestrator service | **Unchanged** | Same credential management, bundle generation |
| Transition handlers | **Unchanged** | Same state machine, same Claude subprocess management |
| Terminal relay | **Unchanged** | Same WebSocket streaming |
| Helm chart | **Modified** | Template uses envbuilder image, adds env vars, adds devcontainer.json scaffold values |
| Onboarding script | **Modified** | Now scaffolds devcontainer.json in target repo |
| ArgoCD ApplicationSet | **Unchanged** | Same structure, same per-repo entries |

## Migration Path

1. **Phase 1: Build the gwa-tools dev container feature** — Create the feature repo, `install.sh`, and publish to Gitea registry
2. **Phase 2: Create the binary release pipeline** — Extract Bun build stage into CI job that uploads to MinIO
3. **Phase 3: Modify Helm chart** — Switch container image to envbuilder, add env vars
4. **Phase 4: Scaffold devcontainer.json in test target** — Test with `jaybrto/gwa-test-target`
5. **Phase 5: Update onboarding script** — Generate devcontainer.json per-project
6. **Phase 6: Cut over** — Update ApplicationSet, deploy, verify existing sessions resume

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Envbuilder build fails (missing feature, network issue) | `ENVBUILDER_FALLBACK_IMAGE` boots a basic Ubuntu container; entrypoint logs the failure but pod stays alive for debugging |
| First build is slow (no cache) | Pre-warm cache by triggering a build once per project after onboarding; subsequent builds use registry cache |
| Envbuilder project abandoned | Envbuilder is actively maintained by Coder Inc. and has a stable API. Fallback: fork and maintain, or revert to monolithic image (the entrypoint ConfigMap is unchanged) |
| PVC mount conflicts with envbuilder's /workspaces | Configure `ENVBUILDER_WORKSPACE_BASE_DIR` to match existing `/home/runner/repo` path, or symlink |
| GWA binary download fails during feature install | Feature install.sh uses `|| true` fallback; entrypoint validates binary presence at startup |
| Registry auth for envbuilder cache | Use existing `gitea-registry-secret` credentials, base64-encode Docker config into `ENVBUILDER_DOCKER_CONFIG_BASE64` |

## References

- [Envbuilder GitHub Repository](https://github.com/coder/envbuilder)
- [Envbuilder Environment Variables](https://github.com/coder/envbuilder/blob/main/docs/env-variables.md)
- [Run Dev Containers on Kubernetes with Envbuilder](https://coder.com/blog/run-dev-containers-on-kubernetes-and-openshift-with-envbuilder)
- [Dev Container Feature Starter Template](https://github.com/devcontainers/feature-starter)
- [Dev Container Feature Authoring Guide](https://containers.dev/guide/author-a-feature)
- [Dev Container Features Spec](https://containers.dev/implementors/features/)
- [Envbuilder Starter Devcontainer](https://github.com/coder/envbuilder-starter-devcontainer)
