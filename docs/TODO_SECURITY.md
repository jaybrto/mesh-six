# Security Hardening TODO

Issues identified during security audit (2026-02-17). Address in a dedicated session.

---

## Critical

- [ ] **Add securityContext to all 17 K8s deployments** — `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, drop all capabilities. Files: all `k8s/base/*/deployment.yaml`
- [ ] **Fix argocd-deployer TLS** — remove global `NODE_TLS_REJECT_UNAUTHORIZED = "0"`, use per-request TLS config or proper cert trust. File: `apps/argocd-deployer/src/index.ts:269`
- [ ] **Scope kubectl-deployer RBAC** — replace ClusterRole with namespace-scoped Role, remove `pods/exec` and `delete` on secrets. File: `k8s/base/kubectl-deployer/deployment.yaml:99-129`

## High

- [ ] **Sanitize error responses** — return generic messages to clients, log full details server-side. Create shared error handler in core. Files: qa-tester, argocd-deployer, kubectl-deployer, project-manager `index.ts`
- [ ] **Restrict CORS** — replace `app.use('*', cors())` with allowed origins list. File: `apps/api-coder/src/index.ts:564`
- [ ] **Add NetworkPolicy resources** — restrict pod-to-pod traffic, limit egress to required services only. Create: `k8s/base/network-policies.yaml`
- [ ] **Override vulnerable transitive deps** — add `overrides` in root `package.json` for `axios >= 1.8.2`, `tar`, `undici`, `langsmith` (all via `mem0ai`). Run `bun audit` to verify
- [ ] **Implement sealed-secrets or external-secrets** — K8s secrets are currently empty placeholders. File: `k8s/base/secrets.yaml`

## Medium

- [ ] **Use `crypto.timingSafeEqual`** for HMAC comparison instead of `charCodeAt` loop. File: `apps/webhook-receiver/src/index.ts:65-71`
- [ ] **Pin Docker base images to SHA** — `oven/bun:1.2` and `oven/bun:1.2-slim` should use `@sha256:...`. File: `docker/Dockerfile.agent:3,28`
- [ ] **Pin GitHub Actions to SHA** — replace `@v4`/`@v2` with full commit SHA. Files: `.github/workflows/build-deploy.yaml`, `.github/workflows/test.yaml`
- [ ] **Add rate limiting** — middleware for public endpoints (`/webhooks/github`, `/tasks`, `/invoke`). All agents
- [ ] **Fix `ai` version mismatch** — core declares `"ai": "6"` but lockfile resolves `4.3.19`, apps use `^4.1.52`. Reconcile. File: `packages/core/package.json`
- [ ] **ArgoCD auto-sync safety** — consider disabling `prune: true` or adding `permitEmpty: false`. File: `k8s/argocd-application.yaml:16-20`

## Low

- [ ] **Add pool cleanup on SIGTERM** — call `pool.end()` in graceful shutdown. File: `apps/orchestrator/src/index.ts`
- [ ] **Harden .gitignore** — add `*.pem`, `*.key`, `*.p12`, `*.pfx`, `kubeconfig`, `.kube/`
- [ ] **Add PodDisruptionBudget** for critical services (orchestrator, project-manager, webhook-receiver)

## Identifiable Information in Public Repo

Decide per-item whether to sanitize or accept:

- [ ] **ntfy.sh topic `mesh-six-pm`** — anyone can send you fake notifications. Consider randomizing or making configurable via env var only (no hardcoded default). Files: `apps/project-manager/src/workflow.ts:722`, `docs/PLAN_45_GWA.md`
- [ ] **`*.bto.bar` hostnames throughout** — reveals personal domain and full infra topology. In: `CLAUDE.md`, `docs/PLAN.md`, `k8s/**/*.yaml`, `dapr/**/*.yaml`, `.github/workflows/*.yaml`, agent source files
- [ ] **Internal IPs `10.0.0.201`, `10.0.0.1`** — in `.env` comments pattern referenced in docs
- [ ] **"Jay" / "Jay's homelab"** — personal name in `docs/PLAN.md` and agent system prompts
- [ ] **GitHub username `jaybrto`** — in `CHANGELOG.md` links
- [ ] **`registry.bto.bar`** — private container registry URL in all deployment manifests and CI workflow
- [ ] **Full k8s namespace layout** — `mesh-six`, `redis-system`, `database-system`, `rabbitmq`, `ollama`, `litellm` exposed in manifests
- [ ] **Webhook endpoint `mesh-six.bto.bar/webhooks/github`** — documented in `docs/PLAN_45_GWA.md`
- [ ] **VITE_MQTT_PASS pattern** — dashboard bundles MQTT credentials into client-side JS (design issue, not a committed secret)
