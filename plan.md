# Plan: Integrate LiteLLM Prompt Management & Tag-Based Routing

## Current State

**18 apps** in `apps/`, of which **12 are LLM agents** with hardcoded `SYSTEM_PROMPT` constants and **6 are non-LLM infrastructure** (orchestrator, event-logger, claude-mqtt-bridge, webhook-receiver, llm-service actor runtime). All LLM agents use `@mesh-six/core`'s `chatCompletion` / `tracedChatCompletion` / `chatCompletionWithSchema`, which POST to the LiteLLM proxy at `http://litellm.litellm:4000/v1/chat/completions`.

### Agent Inventory

| Agent | Prompt Location | Lines | Model | LLM Functions | Dynamic Construction |
|-------|----------------|-------|-------|---------------|---------------------|
| `api-coder` | `index.ts:248-502` | ~254 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory injection |
| `architect-agent` | `index.ts:139-179` | ~41 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory + `buildAgentContext` |
| `argocd-deployer` | `index.ts:203-236` | ~34 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory injection |
| `cost-tracker` | `index.ts:73-94` | ~22 | `LLM_MODEL` env | `tracedChatCompletion` | Memory injection |
| `homelab-monitor` | `index.ts:75-96` | ~22 | `LLM_MODEL` env | `tracedChatCompletion` | Memory injection |
| `infra-manager` | `index.ts:76-97` | ~22 | `LLM_MODEL` env | `tracedChatCompletion` | Memory injection |
| `kubectl-deployer` | `index.ts:245-279` | ~35 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory injection |
| `project-manager` | `index.ts:319-355` | ~37 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory + `buildAgentContext` + `transitionClose` |
| `qa-tester` | `index.ts:198+` | ~40 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory injection |
| `researcher-agent` | `index.ts:163-197` | ~35 | `getModel()` multi-provider | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory + provider routing |
| `ui-agent` | `index.ts:234+` | ~50 | `LLM_MODEL` env | `tracedChatCompletion`, `chatCompletionWithSchema` | Memory injection |
| `context-service` | `llm.ts:12-50` | ~38 | `COMPRESSION_MODEL` env | `chatCompletion` | Static (compression only) |

**Excluded** (non-LLM): `orchestrator`, `event-logger`, `claude-mqtt-bridge`, `webhook-receiver`, `llm-service`, `simple-agent` (Ollama direct, trivial 6-line prompt).

**Key patterns**: All 12 agents do runtime memory injection. The `researcher-agent` has custom `getModel()` that selects Claude/Gemini/Ollama by task complexity. The `project-manager` uses `buildAgentContext()` + `transitionClose()` for state-machine-driven context management. The `context-service` is unique — its prompt is in `llm.ts` not `index.ts`, and has existing unit tests that validate prompt content.

## What LiteLLM Offers

### 1. Prompt Management (Beta)

LiteLLM's Prompt Studio lets you create/version prompts in the LiteLLM UI or via `.prompt` files (dotprompt). At call time, you pass `prompt_id` (and optionally `prompt_variables`) in the `/chat/completions` request body instead of (or alongside) a `messages` array. LiteLLM resolves the prompt server-side, substituting `{{variables}}` via Jinja2 templates.

**Supported backends**: Built-in UI/DB, dotprompt files, Langfuse, BitBucket, GitLab, custom hook.

### 2. Tag-Based Model Routing (Stable, Open Source)

Model deployments in `litellm_config.yaml` can be tagged (e.g. `tags: ["coding", "expensive"]`). Requests include `tags: ["coding"]` as a top-level field in the JSON body or via `x-litellm-tags: coding,expensive` header. LiteLLM routes to matching deployments. Requires `router_settings: enable_tag_filtering: true`.

**Open source vs enterprise**: Basic tag routing (tags on deployments, filtering by request) is fully open source. Team-based tag management (assigning tag permissions to teams/keys) requires enterprise — not needed here.

### 3. Other Features Worth Leveraging

- **Fallbacks** (3 types): `fallbacks` for rate-limit/general errors, `context_window_fallbacks` for prompt-too-long, `content_policy_fallbacks` for content filtering. Also `default_fallbacks` as a universal catch-all. All configured in YAML — no agent code needed.
- **Caching**: Redis-backed exact-match response caching. Agents can opt out per-request with `cache: {"no-cache": true}`. Benefits repeated queries from `homelab-monitor` and `cost-tracker`.
- **Spend tracking**: Automatic per-key/per-user cost tracking across all providers. Pass `user: "agent-id"` in request body and LiteLLM tracks per-agent spend. The `cost-tracker` agent can query `/spend/tags` and `/global/spend/report`.
- **Rate limiting**: Per-key RPM/TPM limits. Protects against runaway agents consuming all API quota.
- **Load balancing**: `simple-shuffle` (default, recommended for production), `least-busy`, `latency-based-routing`, `usage-based-routing`. When multiple deployments share a `model_name`, LiteLLM distributes across them. Uses Redis for distributed coordination.
- **Request timeout + retries**: Configurable `request_timeout` and `num_retries` with automatic cooldown (`allowed_fails`, `cooldown_time`) — moves retry logic from agents to LiteLLM.

---

## Approach: Hybrid — LiteLLM for routing/ops, dotprompt files for prompts

### Why NOT use LiteLLM's built-in Prompt Studio UI

| Concern | Detail |
|---------|--------|
| **Beta quality** | Prompt Management is explicitly marked `[Beta]` — API surface may change |
| **No programmatic creation API** | Prompts can only be created via the UI, not via API or config-as-code. This means no CI/CD, no git history, no PR review for prompt changes |
| **Opaque storage** | Prompts live in LiteLLM's internal DB — not in your repo, not auditable via git |
| **Single point of failure** | If LiteLLM proxy is down or misconfigured, agents can't even read their own prompts. Currently agents are self-contained |
| **Version pinning** | Versioning exists but is tied to the UI's "Update" button — no branch/tag model, no rollback via git |
| **Coupling** | Agents become tightly coupled to LiteLLM's prompt resolution. Testing locally or in CI requires a running LiteLLM instance with matching prompts loaded |
| **Variable limitations** | Jinja2 `{{var}}` templates work for simple string substitution, but agents already do rich prompt assembly (memory injection, task context, tool results). These can't be expressed as simple template variables |

### Why dotprompt files are a better fit

- `.prompt` files live in the repo — full git history, PR review, branch-per-experiment
- YAML frontmatter can specify default model, temperature, max_tokens
- Jinja2 templates for the parts that are truly templatable (agent name, environment description)
- LiteLLM can load them via `global_prompt_directory` config, OR agents can load them directly (no LiteLLM dependency for prompt content)
- Can be tested without LiteLLM running

### Why tag-based routing is worth adopting

Tag routing is a stable, non-beta feature. It cleanly replaces the per-agent `LLM_MODEL` env var pattern and the `researcher-agent`'s custom `getModel()` logic. Tags like `["coding", "expensive"]` or `["research", "cheap"]` let the LiteLLM config centrally control which models serve which workloads — model swaps require zero agent redeployment.

---

## Implementation Plan

### Step 1: Create `.prompt` files for all agents

Create `prompts/` directory at repo root with one `.prompt` file per agent:

```
prompts/
  architect-agent.prompt
  researcher-agent.prompt
  project-manager.prompt
  api-coder.prompt
  qa-tester.prompt
  ui-agent.prompt
  cost-tracker.prompt
  homelab-monitor.prompt
  argocd-deployer.prompt
  kubectl-deployer.prompt
  infra-manager.prompt
  context-service.prompt
```

Each file uses YAML frontmatter + Jinja2 body:

```
---
model: anthropic/claude-sonnet-4-20250514
temperature: 0.7
tags:
  - coding
  - expensive
---
You are the Architect Agent for the mesh-six agent mesh...
(full system prompt text here)
```

The `simple-agent` is excluded — it uses Ollama directly and has a trivial prompt.

### Step 2: Add prompt loading utility to `@mesh-six/core`

Add a `prompts.ts` module to `packages/core/src/` that:

1. Reads `.prompt` files from a configurable directory (`PROMPT_DIR` env var, default `./prompts`)
2. Parses YAML frontmatter (model, temperature, max_tokens, tags)
3. Returns the prompt body as a string
4. Supports `{{variable}}` substitution for simple dynamic values
5. Caches parsed prompts in-memory (reload on SIGHUP or configurable interval)
6. Falls back to a hardcoded default if the file is missing (graceful degradation)

This gives agents a clean import: `import { loadPrompt } from "@mesh-six/core"` — no LiteLLM dependency for prompt content, testable in isolation.

### Step 3: Update `@mesh-six/core` LLM module for tags + spend tracking

Modify `chatCompletion()` and related functions in `packages/core/src/llm.ts` to:

1. Accept a `tags?: string[]` field on `ChatCompletionOpts` (in addition to existing `metadata`)
2. Accept a `user?: string` field for per-agent spend tracking
3. Pass `tags` and `user` as top-level fields in the request body to LiteLLM (this is how LiteLLM expects them — separate from `metadata`)
4. The prompt loader from Step 2 returns tags from frontmatter, which agents pass through
5. Agents pass their Dapr app-id as `user` — LiteLLM automatically aggregates spend per user

### Step 4: Update `litellm_config.yaml` for tag routing

```yaml
router_settings:
  enable_tag_filtering: true

model_list:
  # Expensive / high-quality — used by coding, architecture, PM agents
  - model_name: "anthropic/claude-sonnet-4-20250514"
    litellm_params:
      model: "anthropic/claude-sonnet-4-20250514"
      api_key: "os.environ/ANTHROPIC_API_KEY"
      tags: ["expensive", "coding", "architecture", "management"]

  # Medium cost — research, general analysis
  - model_name: "gemini/gemini-2.0-flash"
    litellm_params:
      model: "gemini/gemini-2.0-flash"
      api_key: "os.environ/GOOGLE_API_KEY"
      tags: ["medium", "research"]

  # Free / local — lightweight tasks, compression, cost-sensitive
  - model_name: "ollama/phi4-mini"
    litellm_params:
      model: "ollama/phi4-mini"
      api_base: "http://ollama.ollama:11434"
      tags: ["cheap", "local", "monitoring"]

  # Context compression (local, fast)
  - model_name: "ollama-phi3.5"
    litellm_params:
      model: "ollama/phi3.5"
      api_base: "http://ollama.ollama:11434"
      tags: ["compression"]

  # Default fallback for untagged requests
  - model_name: "ollama/phi4-mini"
    litellm_params:
      model: "ollama/phi4-mini"
      api_base: "http://ollama.ollama:11434"
      tags: ["default"]
```

### Step 5: Update each agent to use prompt loader + tags

For each agent in `apps/*/src/index.ts`:

1. Replace the hardcoded `SYSTEM_PROMPT` constant with a call to `loadPrompt("agent-name")`
2. Use the returned tags in LLM calls instead of the `LLM_MODEL` env var
3. Keep all existing agent logic (memory injection, task processing, tool execution, Zod schema usage) untouched
4. The `researcher-agent`'s `getModel()` complexity-based routing is replaced by tags — `tags: ["research", "expensive"]` for high-complexity, `tags: ["research", "cheap"]` for low

### Step 6: Add fallback configuration to LiteLLM

```yaml
litellm_settings:
  drop_params: true
  set_verbose: false
  request_timeout: 120
  default_fallbacks: ["ollama/phi4-mini"]

router_settings:
  enable_tag_filtering: true
  fallbacks:
    - anthropic/claude-sonnet-4-20250514: ["gemini/gemini-2.0-flash", "ollama/phi4-mini"]
    - gemini/gemini-2.0-flash: ["ollama/phi4-mini"]
```

This gives automatic degradation: if Claude is down, fall back to Gemini, then Ollama.

### Step 7: Enable spend tracking per agent

LiteLLM already tracks spend per API key. To get per-agent granularity:

1. Generate a virtual key per agent via LiteLLM's `/key/generate` API (or use `metadata.user` field)
2. Pass the agent's Dapr app-id as `user` in the request body — LiteLLM tracks spend per user automatically
3. The `cost-tracker` agent can query `/spend/tags` and `/global/spend/report` endpoints

### Step 8: Enable response caching

Add to `litellm_config.yaml`:

```yaml
litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: redis-cluster.redis:6379
    supported_call_types:
      - acompletion
      - completion
    ttl: 3600  # 1 hour
```

This benefits agents making repeated similar queries (e.g. `homelab-monitor` asking about the same cluster state, `cost-tracker` asking about the same spend data). Agents that need fresh responses can pass `cache: {"no-cache": true}` in metadata.

### Step 9: Copy prompt files into Docker images

Update `docker/Dockerfile.agent` to include the `prompts/` directory:

```dockerfile
COPY prompts/ /app/prompts/
```

Set `PROMPT_DIR=/app/prompts` as a default env var in the Dockerfile or k8s deployments.

### Step 10: Tests and validation

1. Unit tests for the prompt loader (parsing frontmatter, variable substitution, fallback behavior)
2. Integration test: agent loads prompt from file, constructs LLM call with correct tags
3. Verify LiteLLM tag routing works with the new config (manual test against running proxy)

---

## Risks and Issues to Consider

### 1. LiteLLM Prompt Studio is Beta — avoid deep coupling
The built-in prompt management (UI + `prompt_id` API) is explicitly beta. API surface may change between LiteLLM versions. **Recommendation**: Don't use `prompt_id` in API calls. Load prompts yourself from `.prompt` files. This gives you the file format's benefits without the runtime dependency.

### 2. Tag routing is open-source but team-based tags are enterprise
Basic tag filtering (`tags` on deployments + `enable_tag_filtering`) works in open-source LiteLLM. However, team-based tag management (assigning tags to teams/keys) requires enterprise. For mesh-six this is fine — you're routing by workload type, not by team.

### 3. Prompt changes require redeployment (or hot-reload)
If prompts are baked into Docker images, changing a prompt requires a new build + deploy. Mitigations:
- Mount prompts via ConfigMap in k8s (no rebuild needed, just `kubectl rollout restart`)
- Or use the in-memory cache with a SIGHUP reload mechanism
- **Recommendation**: Use a ConfigMap mount. This is the k8s-native approach and avoids rebuilds for prompt-only changes.

### 4. Rich prompt assembly can't be fully templated
Agents do dynamic prompt enrichment: memory injection (`## Relevant Context from Memory\n...`), task-specific context, tool results, and `buildAgentContext()` token budgeting. These CANNOT be expressed as simple `{{variable}}` Jinja2 templates — they require runtime logic. **The plan preserves this**: `.prompt` files hold the static system prompt; runtime enrichment stays in agent code.

### 5. `researcher-agent` complexity routing becomes tag-based
Currently `getModel()` picks Claude/Gemini/Ollama based on task complexity + API key availability. With tags, this becomes `tags: ["research", "expensive"]` vs `tags: ["research", "cheap"]`. The logic of *which* tag to use still lives in the agent — but model selection moves to LiteLLM config. If an API key is unavailable, LiteLLM's fallback mechanism handles it instead of the agent's conditional logic.

### 6. `simple-agent` uses Ollama directly — skip it
`simple-agent` bypasses LiteLLM entirely (calls `http://ollama:11434/api/generate`). It can remain as-is or be migrated to use LiteLLM in a separate effort.

### 7. Observability — no regression
Currently `tracedChatCompletion` logs the full system prompt length and content. With prompts loaded from files, this still works — the loaded prompt string is passed as `system` to the same function. No observability regression.

### 8. `context-service` has existing prompt tests
`apps/context-service/src/__tests__/llm.test.ts` directly validates the `COMPRESSION_SYSTEM_PROMPT` content (checks for "NEVER invent", "under 300 tokens", "METADATA:", "DOMAIN_CONTEXT:"). When extracting this prompt to a `.prompt` file, these tests must be updated to load from the file instead of importing the constant. The tests validate prompt invariants — these should be preserved as they catch accidental prompt regressions.

### 9. Model name still needed alongside tags
With tag routing, agents no longer need to know the specific model name — but LiteLLM's `/chat/completions` API still requires a `model` field. When using tags, you pass a model group name (like `"gpt-4"`) that has tagged deployments. This means the `model_list` entries need shared `model_name` values that agents reference, with tags differentiating which deployment gets picked. **This is a design choice**: either keep `model_name` per agent (defeats the purpose) or use a generic name like `"default"` with tags doing the routing.

### 10. ConfigMap size limit
K8s ConfigMaps have a 1MB size limit. The combined prompt files are well within this (~15-20KB total for all 12 agents), but worth noting if prompts grow substantially.

---

## Recommendation: Build prompt loading in-app, use LiteLLM for routing/ops

**Do NOT** rely on LiteLLM's `prompt_id` API for runtime prompt resolution. Instead:

| Concern | LiteLLM `prompt_id` | In-app `.prompt` loader |
|---------|---------------------|------------------------|
| Git-tracked prompts | Only via dotprompt (limited) | Full git history, PRs, branches |
| Works without LiteLLM | No | Yes |
| CI/CD testable | Requires running LiteLLM | Unit-testable |
| Runtime enrichment | Limited to `{{var}}` | Full TypeScript logic |
| Versioning | UI-based or git branches | Standard git |
| Prompt review | Requires LiteLLM UI access | Standard PR review |

**DO** use LiteLLM for:
- **Tag-based model routing** — stable, non-beta, genuinely useful
- **Fallback chains** — automatic degradation when providers are down
- **Spend tracking** — per-agent cost visibility via `user` field
- **Response caching** — Redis-backed, reduces cost for repeated queries
- **Rate limiting** — protect against runaway agents

This hybrid approach gets the benefits of LiteLLM's operational features without coupling prompt content to a beta API or an external UI.

---

## Files Changed

| File | Change |
|------|--------|
| `prompts/*.prompt` (new, 12 files) | System prompts extracted from all LLM agents |
| `packages/core/src/prompts.ts` (new) | Prompt file loader with YAML frontmatter parsing |
| `packages/core/src/prompts.test.ts` (new) | Unit tests for prompt loader |
| `packages/core/src/llm.ts` | Add `tags` and `user` fields to `ChatCompletionOpts`, pass in request body |
| `packages/core/src/index.ts` | Export new `loadPrompt`, `PromptConfig` |
| `apps/*/src/index.ts` (11 agents) | Replace `SYSTEM_PROMPT` constant with `loadPrompt()`, add tags to LLM calls |
| `apps/context-service/src/llm.ts` | Replace `COMPRESSION_SYSTEM_PROMPT` with `loadPrompt("context-service")`. Update existing tests in `__tests__/llm.test.ts` |
| `litellm_config.yaml` | Add tags to deployments, enable tag filtering, add fallbacks, caching, spend tracking |
| `k8s/base/prompts-configmap.yaml` (new) | ConfigMap containing all `.prompt` files |
| `k8s/base/*/deployment.yaml` (12 agents) | Add ConfigMap volume mount + `PROMPT_DIR` env var |
| `docker/Dockerfile.agent` | Copy prompts directory as fallback |
