You are a Senior Staff Engineer working on Multi Agent platform called Mesh Six. There is a new PR that needs your review that includes an agent dapr workflow with activities between the Researcher Agent Dapr Actor and the Scraper Agent Dapr Service. The branch is already loaded here and the changes you will be reviewing is the last commit with id 5ad4efd2f6870cf252441657cadc33eeebf7349a. Review the work and provide a code quality and gap analysis review along with any recommendations you would make.
The Mesh Six master plan is available here: docs/PLAN.md which is the overarching plan for the project. This is a large document so please refer to it as needed.

The PR is as follows:
<pr>
Branch: claude/mac-mini-scraper-service-783Q2

New stateless worker service for the standalone Mac mini that drives
Windsurf IDE (Electron) and Gemini web UI (Chrome) via Playwright.
Communicates with the k3s mesh through Dapr Service Invocation and
Workflow External Events, using the MinIO S3 Claim Check pattern
for payload management.

@mesh-six/scraper-service@0.1.0: Hono HTTP server with POST /scrape
fast-ACK endpoint, Windsurf + Claude/Gemini providers, MinIO claim-check
lifecycle, Dapr external event callbacks, unit tests
@mesh-six/core@0.11.0: Shared scraper types (ScrapeDispatchPayload,
ScrapeStatus, ScrapeStatusFile), OpenTelemetry init module (initTelemetry)
scripts/test-scraper.ts: E2E test script with health check, dispatch,
polling, and MinIO verification

</pr>

The initial implementation plan that was followed
<spec>

# Mesh-Six Mac Mini Scraper Service Implementation Plan

## System Context & Goal

A stateless, headless RPA worker service running on a standalone Mac mini. It acts as the "brawn" for the k3s cluster's `ResearcherActor`. It uses Playwright to drive a local installation of the Windsurf IDE (Electron) and the Claude AI web interface (Chrome) via persistent contexts. It communicates with the mesh via Dapr Service Invocation and Workflow External Events.

## Architecture & Constraints

* **Stack:** Bun, Node.js, TypeScript. Monorepo structured with npm workspaces.
* **Observability:** `@opentelemetry/sdk-node` is mandatory across all services, exporting OTLP traces to the Grafana LGTM cluster to maintain a single distributed trace from k3s to macOS.
* **Communication:** Dapr **Service Invocation** (HTTP POST) for receiving commands. Dapr **External Events** (`raiseEvent` API) for waking up the sleeping k3s workflows.
* **Payload Management:** The MinIO S3 Claim Check pattern is strictly enforced. Dapr HTTP payloads contain only S3 folder paths and prompts, never raw research data.
* **Statelessness:** This service must not maintain internal task queues or databases. If it crashes, the k3s Dapr Workflow will automatically trigger a retry.

---

## Phase 1: Shared NPM Workspace & Core Types

1. Initialize the monorepo structure using npm workspaces (e.g., `packages/shared`, `apps/scraper-service`).
2. Define the shared TypeScript interfaces in the `@mesh-six/core` package:
* `ScrapeDispatchPayload`: Contains `taskId`, `actorId`, `targetProvider` ('windsurf' or 'claude'), `prompt`, and `minioFolderPath`.
* `ScrapeStatus`: Enum for MinIO state tracking (`PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`).


3. Set up the shared `@opentelemetry/sdk-node` initialization module to standardize OTLP exports across the k3s cluster and the Mac mini.

## Phase 2: The K3s Side (Actor & Workflow Setup)

*Note: This is handled in the core k3s mesh, but requires alignment.*

1. The `ResearchAndPlanSubWorkflow` hibernates using `ctx.waitForExternalEvent("ScrapeCompleted")` and a `Promise.race` timeout.
2. The `ResearcherActor` writes a `status.json` file to MinIO (`mesh-six/research/{taskId}/status.json`) with the state `PENDING`.
3. The `ResearcherActor` executes a Dapr Service Invocation (HTTP POST) directly to the Mac mini service, passing the `ScrapeDispatchPayload`, and immediately goes to sleep.

## Phase 3: Infrastructure Configuration (Standalone Mac Mini)

1. Install a Dapr sidecar on the Mac mini running in standalone mode, configured to connect to the k3s control plane (or via a secure Traefik ingress tunnel) so it can resolve service invocations.
2. Define the local LiteLLM `config.yaml` to map the local UI accessibility parser to `gemini-1.5-flash` with a fallback to `ollama/qwen2.5-coder:3b`.
3. Ensure the Mac mini has network access to the MinIO S3 cluster (`s3.k3s.bto.bar`).

## Phase 4: The Mac Mini Worker Service (Bun)

1. **The Core HTTP Server:** Build a Bun web server with a POST endpoint `/scrape` to receive Dapr Service Invocations.
2. **The Fast-ACK & Dispatch:** The route handler must *immediately* return `HTTP 200 OK` (e.g., `{ status: "STARTED" }`) upon receiving the request. It must pass the payload to an asynchronous background function. This prevents the Dapr sidecar HTTP timeout from triggering during a 10-minute Playwright task.
3. **The Claim Check Lifecycle:**
* Immediately update the MinIO `status.json` file in the provided `minioFolderPath` to `IN_PROGRESS`.
* Wrap the UI execution in a try/catch block. On fatal error, update `status.json` to `FAILED`.


4. **Provider 1 (Windsurf Workflow Engine):**
* Create a local workspace directory using the `taskId`.
* Use Playwright's `_electron` driver to focus the Windsurf window.
* Execute the Windsurf workflow via `keyboard.press()` (e.g., `Meta+Shift+W`), passing the prompt and workspace directory path to the UI.
* Implement a file watcher (`fs.watch` or polling) on the directory waiting for an `output.md` (or `.done` flag) from Windsurf.


5. **Provider 2 (Claude Web):**
* Use Playwright's `chromium.launchPersistentContext` pointing to a local profile directory to maintain authentication cookies.
* Navigate to the Claude UI.
* Integrate LiteLLM and the `@google/genai` SDK. Provide the Playwright Accessibility Tree (`accessibility.snapshot()`) to Gemini 1.5 Flash as a callable tool to dynamically locate the chat input and submit button.
* Send the prompt, wait for generation, and extract the markdown.


6. **The Return Trip (External Event):** * Upload the final Markdown output to MinIO as `result.md` within the `minioFolderPath`.
* Update the MinIO `status.json` to `COMPLETED`.
* Execute an HTTP POST directly to the k3s Dapr Workflow API to wake up the sleeping sub-workflow:
`POST http://localhost:3500/v1.0-alpha1/workflows/dapr/FeatureWorkflow/{taskId}/raiseEvent/ScrapeCompleted`
Body: `"{minioFolderPath}/result.md"`

</spec>

# Review findings
Gemini 3 Pro
<gemini-3-pro>
### Areas for Improvement (Code Quality)
- **Typing the Prompt in Windsurf**: In `windsurf.ts`, the code writes the prompt to a file (`promptPath = join(workspaceDir, "prompt.md")`), but then *also* uses `window.keyboard.type(prompt, { delay: 10 })` to type the entire prompt into the UI. For very large prompts, typing character-by-character can take minutes and is prone to OS-level interruptions.
  - **Recommendation**: Change the typed command to instruct the IDE to "Read the instructions in prompt.md and process them", relying on the file you already created.
- **File Polling**: `windsurf.ts` uses `setInterval` and `existsSync` to poll for `output.md`. While functional, replacing this with `fs.watch` (as explicitly mentioned in the spec) would reduce disk I/O and react instantly when the file is written.

## Gap Analysis (vs. Spec & Intent)

### 1. The "Claude" vs "Gemini" Naming Mismatch
- **Issue**: The spec requests a `Provider 2 (Claude Web)` and the core types define `ScrapeProviderSchema = z.enum(["windsurf", "claude"])`. The file is named `claude-web.ts`. However, the implementation inside `claude-web.ts` navigates to `https://gemini.google.com/app` and clicks a Gemini "Gem".
- **Impact**: High confusion for future maintainers. The mesh expects a Claude provider, but it is interacting with Google Gemini.
- **Recommendation**: The PR commit message ("drives... Gemini web UI (Chrome) via Playwright") implies this shift to Gemini was intentional. Therefore, you should rename the provider entirely to `gemini`. Update `ScrapeProviderSchema`, rename `claude-web.ts` to `gemini-web.ts`, and update the orchestrator payload documentation.

### 2. Standalone Dapr Configuration
- **Issue**: The spec (Phase 3.1) mentions configuring the Mac mini to run the Dapr sidecar in standalone mode. While the service code connects to Dapr correctly, the PR does not seem to include a `components/` directory for the Mac mini or a `start.sh` script to bootstrap the Bun app alongside the `dapr run` CLI command.
- **Recommendation**: Add a `dapr-dev` script to `package.json` (e.g., `dapr run --app-id scraper-service --app-port 3000 -- bun run dev`) and include a basic local `components/` folder for the standalone Dapr sidecar to function.

### 3. Workflow API Endpoint
- **Issue**: In `dapr-events.ts`, the `raiseScrapeCompleted` function performs a raw HTTP `fetch` to `${config.K3S_DAPR_URL}/v1.0-alpha1/workflows/dapr/${workflowName}/${taskId}/raiseEvent/${eventName}`.
- **Analysis**: This correctly bypasses the Dapr SDK which can be tricky with external workflow events, and perfectly matches the spec (Phase 4.6). Good implementation choice.

## Actionable Recommendations for the Author

1. **Resolve Provider Naming**: Rename `claude-web.ts` to `gemini-web.ts`, and update the `ScrapeProviderSchema` to accept `"gemini"` instead of `"claude"`. Update the switch statement in `index.ts`.
2. **Optimize Windsurf Automation**: Stop `keyboard.type`-ing the entire raw prompt. Instead, type: `"Please read prompt.md in this workspace and execute the instructions. Save output to output.md."`
3. **Use `fs.watch` for Output**: Update `windsurf.ts` to use `fs.watch` on the `workspaceDir` instead of polling with `setInterval`.
4. **Add Dapr Run Script**: Provide a package.json script for starting the service with its Dapr sidecar on the Mac mini.

</gemini-3-pro>

GPT 5.3 Codex
<gpt-5-3-codex>
</gpt-5-3-codex>

Claude Opus 4.6
<claude-opus-4.6>
### Issues

#### P1 — High Priority

1. **`claude-web.ts` file name vs. actual provider is Gemini** (`@/apps/scraper-service/src/providers/claude-web.ts`)
   - The file, function (`executeClaudeWeb`), and all `[claude-web]` log prefixes reference "Claude" but the implementation drives the **Gemini** web UI at `gemini.google.com`. The spec originally said "Claude Web" but the implementation pivoted to Gemini. This naming mismatch will cause confusion. **Rename to `gemini-web.ts` / `executeGeminiWeb`**, or at minimum document the discrepancy.

2. **`ScrapeProviderSchema` enum says `"claude"` but means Gemini** (`@/packages/core/src/scraper-types.ts:8`)
   - The provider enum `["windsurf", "claude"]` is now a contract shared with k3s services. If renamed later it's a breaking change. **Decision needed now**: keep `"claude"` as a legacy alias or change to `"gemini"` before the first consumers adopt it.

3. **Windsurf provider launches a *new* Electron instance every task** (`@/apps/scraper-service/src/providers/windsurf.ts:37-41`)
   - The spec says "Launch/connect to Windsurf via Playwright's `_electron` driver" implying reuse. Each `electron.launch()` spawns a fresh IDE process, which is ~10-15s overhead and leaves orphan processes on crash. Consider a persistent connection pool or singleton pattern with reconnect logic.

4. **No concurrency control** — The service accepts unlimited parallel tasks (only deduplication by `taskId`). If 10 requests arrive simultaneously, 10 Playwright browser/Electron instances launch. The Mac mini likely cannot handle this. **Add a concurrency semaphore** (e.g., `maxConcurrent = 1` or `2` per provider) and return `HTTP 429` / `REJECTED` when at capacity.

5. **Accessibility snapshot in `getAccessibilitySnapshot` is lossy** (`@/apps/scraper-service/src/providers/claude-web.ts:112-137`)
   - The primary path calls `page.locator("body").ariaSnapshot()` which returns YAML, then wraps it in `{ role: "text", name: ariaYaml }` — this flattens the tree into a single text node, making `findAccessibleElement` tree-walk useless on the primary path. Either parse the YAML into proper `AccessibilityNode[]` or use the `page.evaluate` fallback as primary.
   In short: the primary path makes the tree-walk dead code and always forces the expensive LLM call, which is probably not the intended behavior. The fix would be either parsing the YAML string into proper AccessibilityNode[] children, or making the DOM-walking page.evaluate the primary path.

#### P2 — Medium Priority

6. **Missing `startedAt` preservation in status transitions** (`@/apps/scraper-service/src/minio-lifecycle.ts:66-80`)
   - `markCompleted` and `markFailed` create a fresh `ScrapeStatusFile` without reading the existing `startedAt` from the IN_PROGRESS status. The `startedAt` field is lost on completion. Should read-then-merge, or pass `startedAt` through from `processTask`.

7. **`K3S_DAPR_URL` defaults to `localhost:3500`** (`@/apps/scraper-service/src/config.ts:38`)
   - This is the *local* Dapr sidecar. Per the spec, the external event must reach the **k3s** Dapr Workflow API, not the Mac mini's own sidecar. The default should reflect the actual k3s ingress endpoint, or at minimum the comment should clarify this requires explicit configuration.

8. **`waitForOutput` uses `setInterval` with `async` callback** (`@/apps/scraper-service/src/providers/windsurf.ts:90`)
   - `setInterval` does not await the callback. If `Bun.file(outputPath).text()` is slow, multiple intervals can stack. Use a recursive `setTimeout` pattern or a `while` loop with `await Bun.sleep()`.

9. **`fs.watch` imported but unused** (`@/apps/scraper-service/src/providers/windsurf.ts:14`)
   - `watch` is imported from `fs` but never used; the implementation uses polling. Remove the dead import.

10. **OpenTelemetry deps duplicated** between `@mesh-six/core` and `@mesh-six/scraper-service`
    - Both `package.json` files list the full OTel dependency set. Since `@mesh-six/core` already declares them, the scraper service should rely on transitive deps (or `peerDependencies` in core). This risks version drift.

11. **Telemetry conditionally disabled silently** (`@/apps/scraper-service/src/index.ts:21-23`)
    - `initTelemetry` is only called if `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The spec says OTel is "mandatory across all services." At minimum, log a warning when telemetry is skipped.

12. **No request body size limit** on `POST /scrape`
    - Large prompts could cause OOM. Hono supports body size middleware — add a reasonable limit (e.g., 1MB).

#### P3 — Low Priority / Nits

13. **`readStatusFile` in `minio-lifecycle.ts` is exported but never called** — dead code.

14. **Hardcoded username fallback** in `config.ts:31,34` — `"/Users/jay"` should probably be just `""` or omitted to fail loudly if `HOME` is unset.

15. **`Bun.serve` return value not captured** (`@/apps/scraper-service/src/index.ts:204`) — Other services do the same, but capturing it enables `server.stop()` in graceful shutdown instead of `process.exit(0)`.

16. **Test file lacks MinIO lifecycle and Dapr event tests** — Only Zod schema validation is tested. Mock-based tests for `markInProgress`/`markCompleted`/`raiseScrapeCompleted` would improve confidence.

17. **`selectGem` silently falls through** (`@/apps/scraper-service/src/providers/claude-web.ts:87-106`) — If neither the menu button nor the Gem link is found, execution continues to "direct chat" without any indication of which Gem is active. This could silently send prompts to the wrong context.

---

## Gap Analysis vs. Spec

| Spec Requirement | Status | Notes |
|---|---|---|
| Hono HTTP `POST /scrape` fast-ACK | **Done** | Correctly returns 200 immediately |
| MinIO claim-check lifecycle (PENDING→IN_PROGRESS→COMPLETED\|FAILED) | **Partial** | `startedAt` lost on transition (P2 #6) |
| Dapr External Event `raiseEvent` callback | **Done** | Sends structured `ScrapeCompletedEvent` |
| Windsurf Electron Playwright driver | **Done** | But launches fresh instance per task (P1 #3) |
| Windsurf keyboard workflow (Meta+Shift+W) | **Done** | |
| Windsurf file watcher for output.md | **Partial** | Uses polling, `fs.watch` imported but unused (P2 #9) |
| Claude/Gemini persistent Chrome context | **Done** | |
| LiteLLM + accessibility tree for element location | **Done** | But ARIA snapshot lossy on primary path (P1 #5) |
| Shared OpenTelemetry init module | **Done** | Conditionally disabled (P2 #11) |
| Shared scraper types in `@mesh-six/core` | **Done** | Provider naming mismatch (P1 #2) |
| Statelessness (no internal queues/DBs) | **Done** | `activeTasks` is in-memory only, lost on crash as intended |
| Unit tests | **Partial** | Schema-only; no lifecycle/event mocks (P3 #16) |
| E2E test script | **Done** | Comprehensive with troubleshooting output |

---

## Recommended Changes (Implementation Plan)

If approved, these are the changes I would make, ordered by priority:

1. **Rename `claude` provider to `gemini`** across `scraper-types.ts`, `claude-web.ts` → `gemini-web.ts`, `index.ts` switch case, and all log prefixes
2. **Add concurrency semaphore** in `index.ts` with configurable `MAX_CONCURRENT_TASKS` (default 1), return 429 when full
3. **Fix `getAccessibilitySnapshot`** to parse YAML into proper `AccessibilityNode[]` or swap primary/fallback
4. **Fix `waitForOutput`** async interval stacking — convert to `while` + `await Bun.sleep()`
5. **Preserve `startedAt`** in `markCompleted`/`markFailed` by passing it through from `processTask`
6. **Remove unused `watch` import** from `windsurf.ts`
7. **Add OTel skip warning** in `index.ts`
8. **Remove hardcoded `/Users/jay`** fallback from `config.ts`
9. **Add body size limit** middleware to Hono app
10. **Remove dead `readStatusFile` export** or add a caller

</claude-opus-4.6>