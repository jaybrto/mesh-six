# Dev Container + Envbuilder Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic GWA runner Docker image with Envbuilder-powered dev containers so each onboarded project owns its toolchain via `devcontainer.json`, and GWA tools are distributed as a custom dev container feature.

**Architecture:** Envbuilder runs as the pod's main container image, clones the target repo, builds a dev environment from its `.devcontainer/devcontainer.json`, then execs into the GWA entrypoint. GWA binaries and Claude CLI are installed via a custom dev container feature published to the Gitea registry. Binary releases are uploaded to MinIO by CI, decoupling code changes from image builds.

**Tech Stack:** Envbuilder (ghcr.io/coder/envbuilder), Dev Container Features spec, Kaniko (existing CI), MinIO (existing), Helm, ArgoCD

---

## Task 1: Create GWA Binary Release CI Job

Extracts the Bun compile step from `Dockerfile` into a standalone CI job that uploads binaries to MinIO. This decouples GWA code changes from container image builds.

**Files:**
- Create: `.github/workflows/release-binaries.yml`
- Modify: `.github/workflows/build-image.yml` (remove runner job's binary dependency)

**Step 1: Create the release workflow**

Create `.github/workflows/release-binaries.yml`:

```yaml
---
name: Release GWA Binaries

"on":
  push:
    branches: [main]
    paths:
      - "src/**"
      - "package.json"
      - "bun.lock"
      - "schema.sql"
  workflow_dispatch:

env:
  MINIO_ENDPOINT: minio.bto.bar:9000
  MINIO_BUCKET: gwa-releases

jobs:
  build-and-upload:
    runs-on: self-hosted
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile || bun install

      - name: Compile binaries
        run: |
          mkdir -p dist
          bun build src/orchestrate.ts --compile --outfile dist/gwa-orchestrate
          bun build src/respond.ts --compile --outfile dist/gwa-respond
          bun build src/cleanup.ts --compile --outfile dist/gwa-cleanup
          bun build src/health-check.ts --compile --outfile dist/gwa-health-check
          bun build src/ask-question.ts --compile --outfile dist/gwa-ask-question
          bun build src/session-complete.ts --compile --outfile dist/gwa-session-complete
          bun build src/architect.ts --compile --outfile dist/gwa-architect
          bun build src/worker.ts --compile --outfile dist/gwa-worker
          bun build src/setup-project.ts --compile --outfile dist/gwa-setup-project
          bun build src/transitions/start-planning.ts --compile --outfile dist/gwa-start-planning
          bun build src/transitions/inject-prompt.ts --compile --outfile dist/gwa-inject-prompt
          bun build src/transitions/run-playwright.ts --compile --outfile dist/gwa-run-playwright
          bun build src/transitions/resume-with-failures.ts --compile --outfile dist/gwa-resume-with-failures
          bun build src/transitions/send-answer.ts --compile --outfile dist/gwa-send-answer
          bun build src/transitions/deploy-and-cleanup.ts --compile --outfile dist/gwa-deploy-and-cleanup
          bun build src/provision.ts --compile --outfile dist/gwa-provision
          bun build src/push-credentials.ts --compile --outfile dist/gwa-push-credentials
          bun build src/credentials-backup.ts --compile --outfile dist/gwa-credentials-backup
          bun build src/planning-complete.ts --compile --outfile dist/gwa-planning-complete
          chmod +x dist/gwa-*
          cp schema.sql dist/

      - name: Get version metadata
        id: meta
        run: |
          VERSION=$(jq -r '.version' package.json)
          SHA_SHORT=$(git rev-parse --short HEAD)
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
          echo "sha_short=${SHA_SHORT}" >> "$GITHUB_OUTPUT"

      - name: Upload to MinIO
        env:
          MINIO_ACCESS_KEY: ${{ secrets.MINIO_ACCESS_KEY }}
          MINIO_SECRET_KEY: ${{ secrets.MINIO_SECRET_KEY }}
        run: |
          # Install mc (MinIO client) if not present
          if ! command -v mc &> /dev/null; then
            curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
            chmod +x /usr/local/bin/mc
          fi

          mc alias set gwa "https://${MINIO_ENDPOINT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"

          VERSION="${{ steps.meta.outputs.version }}"
          SHA="${{ steps.meta.outputs.sha_short }}"

          # Upload versioned release
          for f in dist/*; do
            mc cp "$f" "gwa/${MINIO_BUCKET}/${VERSION}/$(basename $f)"
          done

          # Upload sha-tagged release
          for f in dist/*; do
            mc cp "$f" "gwa/${MINIO_BUCKET}/${SHA}/$(basename $f)"
          done

          # Update 'latest' symlink
          for f in dist/*; do
            mc cp "$f" "gwa/${MINIO_BUCKET}/latest/$(basename $f)"
          done

          echo "Uploaded ${VERSION} (${SHA}) to s3://${MINIO_BUCKET}/"
```

**Step 2: Verify the workflow runs**

Push to main or trigger `workflow_dispatch`. Verify:
- Binaries appear at `s3://gwa-releases/latest/gwa-orchestrate`, etc.
- `s3://gwa-releases/{version}/` and `s3://gwa-releases/{sha}/` directories exist

**Step 3: Commit**

```bash
git add .github/workflows/release-binaries.yml
git commit -m "infra(ci): add binary release pipeline to MinIO"
```

---

## Task 2: Create the gwa-tools Dev Container Feature

Create a custom dev container feature that installs system tools, Claude CLI, and GWA binaries from MinIO.

**Files:**
- Create: `devcontainer-features/src/gwa-tools/devcontainer-feature.json`
- Create: `devcontainer-features/src/gwa-tools/install.sh`
- Create: `devcontainer-features/.github/workflows/release.yml`
- Create: `devcontainer-features/README.md`

**Important:** This is a separate git repository. The feature must be published as its own OCI artifact. Create `jaybrto/devcontainer-features` on GitHub (or Gitea).

**Step 1: Create feature metadata**

Create `devcontainer-features/src/gwa-tools/devcontainer-feature.json`:

```json
{
  "id": "gwa-tools",
  "version": "1.0.0",
  "name": "GWA Tools",
  "description": "GitHub Workflow Agents CLI tools, Claude Code CLI, and system dependencies for GWA runner pods",
  "options": {
    "claudeVersion": {
      "type": "string",
      "default": "latest",
      "description": "Claude Code CLI version (npm semver)"
    },
    "gwaVersion": {
      "type": "string",
      "default": "latest",
      "description": "GWA tools version tag (matches MinIO release path)"
    },
    "minioEndpoint": {
      "type": "string",
      "default": "minio.bto.bar:9000",
      "description": "MinIO endpoint for downloading GWA binaries"
    },
    "minioBucket": {
      "type": "string",
      "default": "gwa-releases",
      "description": "MinIO bucket containing GWA release binaries"
    }
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/node"
  ],
  "containerEnv": {
    "GWA_TOOLS_VERSION": "${templateOption:gwaVersion}"
  }
}
```

**Step 2: Create the install script**

Create `devcontainer-features/src/gwa-tools/install.sh`:

```bash
#!/bin/bash
set -e

CLAUDE_VERSION="${CLAUDEVERSION:-latest}"
GWA_VERSION="${GWAVERSION:-latest}"
MINIO_ENDPOINT="${MINIOENDPOINT:-minio.bto.bar:9000}"
MINIO_BUCKET="${MINIOBUCKET:-gwa-releases}"
RELEASE_URL="https://${MINIO_ENDPOINT}/${MINIO_BUCKET}/${GWA_VERSION}"

echo "Installing GWA tools v${GWA_VERSION} with Claude Code v${CLAUDE_VERSION}..."

# System dependencies
apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    sqlite3 \
    curl \
    jq \
    watch \
    ca-certificates \
    gnupg \
    aha \
    wkhtmltopdf \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) \
    signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
    https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (Node.js must be available — installsAfter guarantees this)
if command -v npm &> /dev/null; then
    if [ "$CLAUDE_VERSION" = "latest" ]; then
        npm install -g @anthropic-ai/claude-code
    else
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}"
    fi
    npm cache clean --force
else
    echo "WARNING: npm not found. Claude Code CLI not installed."
    echo "Add ghcr.io/devcontainers/features/node to your devcontainer.json features."
fi

# GWA compiled binaries from MinIO
BINARY_NAMES=(
    gwa-orchestrate gwa-respond gwa-cleanup gwa-health-check
    gwa-ask-question gwa-session-complete gwa-architect gwa-worker
    gwa-setup-project gwa-start-planning gwa-inject-prompt
    gwa-run-playwright gwa-resume-with-failures gwa-send-answer
    gwa-deploy-and-cleanup gwa-provision gwa-push-credentials
    gwa-credentials-backup gwa-planning-complete
)

mkdir -p /opt/gwa
DOWNLOAD_FAILURES=0

for bin in "${BINARY_NAMES[@]}"; do
    if curl -fsSL "${RELEASE_URL}/${bin}" -o "/usr/local/bin/${bin}"; then
        chmod +x "/usr/local/bin/${bin}"
    else
        echo "WARNING: Failed to download ${bin}"
        DOWNLOAD_FAILURES=$((DOWNLOAD_FAILURES + 1))
    fi
done

# Schema file
curl -fsSL "${RELEASE_URL}/schema.sql" -o "/opt/gwa/schema.sql" 2>/dev/null || \
    echo "WARNING: Failed to download schema.sql"

if [ "$DOWNLOAD_FAILURES" -gt 0 ]; then
    echo "WARNING: ${DOWNLOAD_FAILURES} binaries failed to download."
    echo "Pod will start but some GWA commands may be unavailable."
fi

echo "GWA tools installation complete."
```

**Step 3: Create the publish workflow**

Create `devcontainer-features/.github/workflows/release.yml`:

```yaml
name: "Release Dev Container Features"
on:
  push:
    branches: [main]
    paths:
      - "src/**"
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Login to Gitea Registry
        uses: docker/login-action@v3
        with:
          registry: registry.bto.bar
          username: jaybrto
          password: ${{ secrets.GITEA_TOKEN }}

      - name: Publish features
        uses: devcontainers/action@v1
        with:
          publish-features: "true"
          base-path-to-features: "./src"
          oci-registry: "registry.bto.bar"
          namespace: "jaybrto/devcontainer-features"
```

**Step 4: Test locally (dry run)**

```bash
# From the devcontainer-features repo root
# Package the feature manually to verify structure
cd src/gwa-tools
tar czf /tmp/gwa-tools.tgz *
tar tzf /tmp/gwa-tools.tgz
# Should list: devcontainer-feature.json, install.sh
```

**Step 5: Commit**

```bash
git add .
git commit -m "feat: create gwa-tools dev container feature"
git push origin main
```

Verify the feature appears at `registry.bto.bar/jaybrto/devcontainer-features/gwa-tools:1`.

---

## Task 3: Create Template devcontainer.json for Onboarded Projects

Create the default `devcontainer.json` template that gets scaffolded into each onboarded project.

**Files:**
- Create: `templates/devcontainer/devcontainer.json`

**Step 1: Create the template file**

Create `templates/devcontainer/devcontainer.json`:

```json
{
  "name": "GWA Agent Environment",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {
      "version": "22"
    },
    "registry.bto.bar/jaybrto/devcontainer-features/gwa-tools:1": {}
  },
  "remoteUser": "runner",
  "containerUser": "runner",
  "containerEnv": {
    "SHELL": "/bin/bash"
  }
}
```

This is the minimal template. Projects add their own features (Go, .NET, etc.) after onboarding.

**Step 2: Commit**

```bash
git add templates/devcontainer/devcontainer.json
git commit -m "feat: add devcontainer.json template for onboarded projects"
```

---

## Task 4: Update Helm Chart for Envbuilder

Modify the Helm chart's StatefulSet to use Envbuilder as the container image instead of the monolithic GWA image.

**Files:**
- Modify: `helm/gwa-runner/values.yaml` (add envbuilder config section)
- Modify: `helm/gwa-runner/templates/statefulset.yaml` (switch image, add env vars)
- Modify: `helm/gwa-runner/Chart.yaml` (bump version)

**Step 1: Add envbuilder values to `helm/gwa-runner/values.yaml`**

Add a new `envbuilder` section after the existing `image` section (after line 16):

```yaml
# Envbuilder configuration (builds project dev container in-pod)
envbuilder:
  enabled: true
  image: ghcr.io/coder/envbuilder:latest
  # Registry for caching built layers (speeds up subsequent builds)
  cacheRegistry: registry.bto.bar/jaybrto/envbuilder-cache
  # Fallback image if no devcontainer.json found in repo
  fallbackImage: mcr.microsoft.com/devcontainers/base:ubuntu
  # Skip rebuild on container restart if image unchanged
  skipRebuild: true
  # Devcontainer directory within the repo
  devcontainerDir: .devcontainer
```

Modify the existing `image` section to clarify it's the legacy path:

```yaml
image:
  # Legacy: direct container image (used when envbuilder.enabled=false)
  registry: registry.bto.bar
  repository: jaybrto/github-workflow-agents
  tag: latest
  pullPolicy: Always
```

**Step 2: Update the StatefulSet template `helm/gwa-runner/templates/statefulset.yaml`**

Replace the container section (lines 44-167) with conditional envbuilder support:

```yaml
      containers:
        - name: gwa-agent
          {{- if .Values.envbuilder.enabled }}
          image: {{ .Values.envbuilder.image }}
          {{- else }}
          image: {{ include "gwa.image" . }}
          {{- end }}
          imagePullPolicy: Always
          command: ["/bin/bash", "/scripts/entrypoint.sh"]
          resources:
            {{- toYaml .Values.runner.resources | nindent 12 }}
          env:
            {{- if .Values.envbuilder.enabled }}
            # Envbuilder configuration
            - name: ENVBUILDER_GIT_URL
              value: {{ printf "https://github.com/%s" (include "gwa.fullRepo" .) | quote }}
            - name: ENVBUILDER_INIT_SCRIPT
              value: "/scripts/entrypoint.sh"
            - name: ENVBUILDER_CACHE_REPO
              value: {{ printf "%s/%s" .Values.envbuilder.cacheRegistry .Values.repo.name | quote }}
            - name: ENVBUILDER_FALLBACK_IMAGE
              value: {{ .Values.envbuilder.fallbackImage | quote }}
            - name: ENVBUILDER_SKIP_REBUILD
              value: {{ .Values.envbuilder.skipRebuild | quote }}
            - name: ENVBUILDER_DEVCONTAINER_DIR
              value: {{ .Values.envbuilder.devcontainerDir | quote }}
            - name: ENVBUILDER_WORKSPACE_BASE_DIR
              value: "/home/runner/repo"
            - name: ENVBUILDER_GIT_USERNAME
              value: "x-access-token"
            - name: ENVBUILDER_GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.secrets.name }}
                  key: {{ .Values.secrets.githubTokenKey }}
            - name: ENVBUILDER_DOCKER_CONFIG_BASE64
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.secrets.name }}
                  key: docker-config-base64
                  optional: true
            {{- end }}
            # Application config (unchanged)
            - name: REPO
              value: {{ include "gwa.fullRepo" . | quote }}
```

The rest of the env vars (POD_NAME, DB_PATH, SCHEMA_PATH, secrets, OTEL, etc.) remain unchanged.

**Important:** When envbuilder is enabled, `command` is ignored by envbuilder — it uses `ENVBUILDER_INIT_SCRIPT` instead. The `command` field is kept for the legacy path (`envbuilder.enabled=false`).

**Step 3: Add `docker-config-base64` to the secrets section in values.yaml**

After line 155 in values.yaml, add:

```yaml
  dockerConfigBase64Key: docker-config-base64
```

**Step 4: Bump chart version in `helm/gwa-runner/Chart.yaml`**

Change `version: 0.1.0` to `version: 0.2.0`.

**Step 5: Run Helm template validation**

```bash
helm template test helm/gwa-runner \
  --set repo.owner=jaybrto \
  --set repo.name=gwa-test-target \
  | grep -A 30 "ENVBUILDER"
```

Expected: The rendered YAML should include all `ENVBUILDER_*` env vars with correct values.

**Step 6: Commit**

```bash
git add helm/gwa-runner/
git commit -m "feat(helm): add envbuilder support for dev container-based runner pods"
```

---

## Task 5: Update Onboarding Script to Scaffold devcontainer.json

Modify `scripts/onboard-repo.sh` to push a `.devcontainer/devcontainer.json` to the target repo alongside the workflow file.

**Files:**
- Modify: `scripts/onboard-repo.sh` (add step to scaffold devcontainer.json)

**Step 1: Add devcontainer scaffolding step**

After the workflow file creation (after line 207 in `scripts/onboard-repo.sh`), add a new step:

```bash
echo ""

# Step 2.5: Scaffold devcontainer.json if not present
echo -e "${BLUE}Step 2.5: Scaffolding .devcontainer/devcontainer.json${NC}"

DEVCONTAINER_TEMPLATE="$ROOT_DIR/templates/devcontainer/devcontainer.json"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would create .devcontainer/devcontainer.json in ${REPO}"
else
  # Check if devcontainer.json already exists
  if gh api "repos/${REPO}/contents/.devcontainer/devcontainer.json" &> /dev/null; then
    echo -e "${YELLOW}devcontainer.json already exists, skipping${NC}"
  else
    DEVCONTAINER_CONTENT=$(cat "$DEVCONTAINER_TEMPLATE")
    TEMP_FILE=$(mktemp)
    echo "$DEVCONTAINER_CONTENT" > "$TEMP_FILE"

    gh api -X PUT "repos/${REPO}/contents/.devcontainer/devcontainer.json" \
      -f message="feat: add dev container configuration for GWA" \
      -f content="$(base64 -i "$TEMP_FILE")" > /dev/null

    rm "$TEMP_FILE"
    echo -e "${GREEN}devcontainer.json scaffolded in ${REPO}${NC}"
    echo ""
    echo -e "${YELLOW}Customize .devcontainer/devcontainer.json in ${REPO} to add project-specific tools:${NC}"
    echo '  "ghcr.io/devcontainers/features/go:1": { "version": "1.22" }'
    echo '  "ghcr.io/devcontainers/features/dotnet:2": { "version": "8.0" }'
  fi
fi
```

**Step 2: Update the "Next steps" summary** at the end of the script to mention devcontainer customization:

After line 236, add:

```bash
echo "5. Customize .devcontainer/devcontainer.json in ${REPO} for project-specific tools"
echo "   See: https://containers.dev/features for available features"
```

**Step 3: Commit**

```bash
git add scripts/onboard-repo.sh
git commit -m "feat(onboarding): scaffold devcontainer.json in target repos"
```

---

## Task 6: Create docker-config-base64 Secret for Envbuilder Registry Auth

Envbuilder needs Docker registry credentials to push/pull cached layers from `registry.bto.bar`. Create the secret and document it.

**Files:**
- Modify: `scripts/onboard-repo.sh` (add docker-config secret to the manual steps output)

**Step 1: Generate the docker-config-base64 value**

This is a one-time manual step per cluster. Document it in the onboarding script's "Next steps" section:

```bash
# Generate base64-encoded Docker config for envbuilder cache access
DOCKER_CONFIG_JSON=$(cat <<EOF
{
  "auths": {
    "registry.bto.bar": {
      "auth": "$(echo -n 'jaybrto:YOUR_GITEA_TOKEN' | base64)"
    }
  }
}
EOF
)
DOCKER_CONFIG_B64=$(echo -n "$DOCKER_CONFIG_JSON" | base64 -w0)

# Add to the gwa-secrets in each namespace
kubectl patch secret gwa-secrets \
  --namespace gwa-jaybrto-gwa-test-target \
  --type merge \
  -p "{\"data\":{\"docker-config-base64\":\"${DOCKER_CONFIG_B64}\"}}"
```

**Step 2: Update the onboarding script's secret creation instructions**

In `scripts/onboard-repo.sh`, update the kubectl create command in the summary (line 230-233) to include the new key:

```bash
echo "   kubectl create secret generic gwa-secrets \\"
echo "     --namespace ${GWA_NAMESPACE} \\"
echo "     --from-literal=claude-oauth-token=<your-claude-token> \\"
echo "     --from-literal=github-token=<your-github-token> \\"
echo "     --from-literal=docker-config-base64=<base64-encoded-docker-config>"
```

**Step 3: Commit**

```bash
git add scripts/onboard-repo.sh
git commit -m "docs(onboarding): add docker-config-base64 secret for envbuilder cache"
```

---

## Task 7: Update Entrypoint ConfigMap for Envbuilder Compatibility

The entrypoint ConfigMap at `k8s/gwa-runner-configmap.yaml` (and its Helm template equivalent) needs minor adjustments for envbuilder's execution model. Envbuilder clones the repo to `ENVBUILDER_WORKSPACE_BASE_DIR` before running the init script, so the entrypoint should skip cloning when running under envbuilder.

**Files:**
- Modify: `helm/gwa-runner/templates/configmap.yaml`

**Step 1: Read the Helm configmap template**

Read `helm/gwa-runner/templates/configmap.yaml` to find the entrypoint.

**Step 2: Add envbuilder detection to the entrypoint**

At the top of the entrypoint script (after the existing variable declarations), add:

```bash
    # Detect if running under envbuilder (repo already cloned by envbuilder)
    ENVBUILDER_MODE="${ENVBUILDER_GIT_URL:+true}"
    if [ "$ENVBUILDER_MODE" = "true" ]; then
      echo "[GWA] Running in envbuilder mode — repo pre-cloned to workspace"
    fi
```

Then wrap the repo cloning block in a conditional:

```bash
    # Clone repo once (main worktree) — skip if envbuilder already cloned
    if [ "$ENVBUILDER_MODE" != "true" ]; then
      if [ ! -d /home/runner/repo/.git ]; then
        echo "[GWA] Cloning repo..."
        rm -rf /home/runner/repo/* /home/runner/repo/.[!.]* 2>/dev/null || true
        git clone "https://github.com/${REPO}.git" /home/runner/repo
      else
        echo "[GWA] Repo already cloned, fetching latest..."
        git -C /home/runner/repo fetch --all --prune
      fi
    fi
```

**Step 3: Update the schema path fallback**

When running under envbuilder, `/opt/gwa/schema.sql` is installed by the gwa-tools feature. The existing fallback logic already handles this — no change needed.

**Step 4: Commit**

```bash
git add helm/gwa-runner/templates/configmap.yaml
git commit -m "feat(entrypoint): detect envbuilder mode, skip repo cloning when pre-cloned"
```

---

## Task 8: Test with gwa-test-target

End-to-end validation using the existing `jaybrto/gwa-test-target` repo.

**Files:**
- No new files — this is a deployment and validation task

**Step 1: Push a devcontainer.json to gwa-test-target**

```bash
# From your local machine
gh api -X PUT "repos/jaybrto/gwa-test-target/contents/.devcontainer/devcontainer.json" \
  -f message="feat: add dev container configuration for GWA" \
  -f content="$(base64 -i templates/devcontainer/devcontainer.json)"
```

**Step 2: Create the docker-config-base64 secret**

```bash
DOCKER_CONFIG_B64=$(echo -n '{"auths":{"registry.bto.bar":{"auth":"'$(echo -n 'jaybrto:TOKEN' | base64)'"}}}' | base64 -w0)

kubectl patch secret gwa-secrets \
  --namespace gwa-jaybrto-gwa-test-target \
  --type merge \
  -p "{\"data\":{\"docker-config-base64\":\"${DOCKER_CONFIG_B64}\"}}"
```

**Step 3: Deploy the updated Helm chart**

Push the Helm changes to main. ArgoCD will sync automatically. Or force sync:

```bash
argocd app sync gwa-jaybrto-gwa-test-target
```

**Step 4: Watch the pod startup**

```bash
kubectl logs -f gwa-jaybrto-gwa-test-target-0 -n gwa-jaybrto-gwa-test-target
```

Expected output sequence:
1. Envbuilder clones `jaybrto/gwa-test-target`
2. Envbuilder reads `.devcontainer/devcontainer.json`
3. Envbuilder installs Node 22 feature
4. Envbuilder installs gwa-tools feature (downloads binaries from MinIO)
5. Envbuilder caches layers to `registry.bto.bar/jaybrto/envbuilder-cache/gwa-test-target`
6. Envbuilder execs into `/scripts/entrypoint.sh`
7. Entrypoint runs in envbuilder mode (skips clone)
8. SQLite init, provisioning, tmux session — same as before

**Step 5: Verify GWA functionality**

```bash
# Exec into the pod
kubectl exec -it gwa-jaybrto-gwa-test-target-0 \
  -n gwa-jaybrto-gwa-test-target -- bash

# Verify tools are available
which gwa-orchestrate gwa-respond gwa-provision claude tmux gh git sqlite3

# Verify entrypoint completed
tmux has-session -t gwa-work && echo "tmux OK"
sqlite3 /home/runner/.claude/gwa.db "SELECT * FROM config"
```

**Step 6: Verify cached rebuild is fast**

```bash
# Delete and recreate the pod to trigger a cached rebuild
kubectl delete pod gwa-jaybrto-gwa-test-target-0 -n gwa-jaybrto-gwa-test-target

# Watch — should be much faster (layer cache hit)
kubectl logs -f gwa-jaybrto-gwa-test-target-0 -n gwa-jaybrto-gwa-test-target
```

**Step 7: Document results and commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from envbuilder integration testing"
```

---

## Task 9: Update build-image.yml to Remove Runner Image Build

Once envbuilder is validated, the `build-runner` job in `.github/workflows/build-image.yml` is no longer needed (the runner pod now uses `ghcr.io/coder/envbuilder` directly). The orchestrator and webhook builds remain unchanged.

**Files:**
- Modify: `.github/workflows/build-image.yml` (remove build-runner job, update deploy job)

**Step 1: Remove the `build-runner` job** (lines 92-192)

Remove the entire `build-runner` job block. Keep `build-orchestrator` and `build-webhook`.

**Step 2: Update the `changes` job**

Remove the `runner` output and the runner detection logic from the `changes` job.

**Step 3: Update the `deploy` job**

Remove the gwa-runner restart from the deploy job (lines 406-410). Runner pods now pick up devcontainer changes when restarted manually or by ArgoCD.

**Step 4: Update the `on.push.paths` trigger**

Remove `"Dockerfile"` from the paths list (line 8) since the runner Dockerfile no longer exists. Keep `"Dockerfile.*"` for orchestrator and webhook.

**Step 5: Commit**

```bash
git add .github/workflows/build-image.yml
git commit -m "refactor(ci): remove runner image build, now using envbuilder"
```

---

## Task 10: Update Documentation

Update CLAUDE.md, CHANGELOG.md, and README to reflect the new architecture.

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `CHANGELOG.md`

**Step 1: Update CLAUDE.md**

Add to the Deployment section:

```markdown
### Dev Container Architecture

Runner pods use Envbuilder to build project-specific dev containers at startup:
- Each onboarded project has a `.devcontainer/devcontainer.json` in its repo
- The `gwa-tools` dev container feature installs GWA binaries, Claude CLI, and system tools
- Layer cache stored at `registry.bto.bar/jaybrto/envbuilder-cache/{repo}`
- GWA binaries released to MinIO at `s3://gwa-releases/{version}/`

To add tools for a specific project, modify its `.devcontainer/devcontainer.json`.
Do NOT modify the runner Dockerfile — it no longer exists.
```

**Step 2: Update CHANGELOG.md**

Add entry for the new version.

**Step 3: Commit**

```bash
git add .claude/CLAUDE.md CHANGELOG.md
git commit -m "docs: add dev container architecture documentation"
```
