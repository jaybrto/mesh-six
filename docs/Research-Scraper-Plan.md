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

