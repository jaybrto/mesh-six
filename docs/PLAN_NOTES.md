# Brain Dump Notes for Mesh-Six post GWA migration.
These are notes I been taking with some ideas and required features we should be including in mesh-six. I'm sure most of these are done but just wanted to make sure we did cover all of this. I've also added a **[Target Section: ...]** tag to each block so you know exactly where these new requirements fit into the master plan doc at  `docs/PLAN.md`

### 1. Bootstrapping & Mobile App (GWA Merge)

**[Target Section: Append to `Milestone 4.5 — GWA Integration`]**

```markdown
### 4.8 — Bootstrapping CLI & Mobile App Management

To support the GWA migration to native PostgreSQL/Redis, we will build a dedicated CLI for initial bootstrapping, alongside an API to support a future Android management app. 

* **Initialization Flow (CLI/App)**:
    * Ensure project board and webhooks are created.
    * Link the Git repo to the project board, bootstrap workflow files, and set up webhooks.
    * Provision backend dependencies (PostgreSQL tables, MinIO directories, Redis cache).
* **Authentication & Settings Flow**:
    * Execute an auth flow returning a URL for web auth; the user inputs the code back into the session.
    * Configure LiteLLM defaults (admin credentials, API keys for Gemini/Anthropic, default prompts, and routing tags).
    * Configure global app settings (e.g., Cloudflare domain endpoints, terminal streaming rates).
* **Management API Endpoints**:
    * `/projects`: Update project settings via the mobile app.
    * `/sessions`: List active sessions, view MinIO directories, fetch last session screenshot thumbnails, rename/archive sessions (zipping files and recording CLI versions for easy resume), and trigger local VSCode attachment.
    * `/claude` & `/litellm`: Manage provider subscriptions, default bundle settings, and API keys.
    * `/jules`: Monitor Google Jules sessions and trigger new repo reviews.

```

### 2. Contextly MCP & MinIO Indexing

**[Target Section: Append to `Milestone 6 — Context Service`]**

```markdown
### 6.8 — Contextly MCP & Codebase Vectoring

Every task involving code changes must trigger a context indexing job post-commit.
* **MinIO Integration**: The Context Service will use a custom tool to index the MinIO bucket directory containing the project. 
* **Vector Storage**: The codebase vector table and collection ID will be stored in the workflow state, making it accessible to all agents.
* **Architect Access**: The Architect agent does not need to run inside the implementation coder pod. It will answer codebase questions remotely via the Contextly MCP server. This MCP will also be used to review markdown documentation stored exclusively in MinIO.

```

### 3. The Planning & Question Loop

**[Target Section: Insert into `Milestone 4 — Project Manager Agent` under `Review Gates`]**

```markdown
### 4.4.1 — Enhanced Planning & Question Loop
The planning phase follows a strict coordination hierarchy:
1.  **Drafting**: The PM coordinates the Architect. The Architect leverages the Researcher (plus its own Mem0 memories and web search) to draft an initial plan.
2.  **Superpowers Refinement**: The PM passes the initial plan to Claude (Opus model) via a "Superpowers" session to finalize the implementation plan, outputting to `docs/plans/feature.md`, saved to the branch commit and workflow state.
3.  **The Question Loop**: If Claude Superpowers has questions during planning:
    * The question is published to the Dapr answers queue.
    * The Architect attempts to answer using research, memory, and web search.
    * **Confidence Gate**: If the Architect is confident, it answers directly and unblocks the session. If not, it pushes a notification to Jay. 
    * **Human Fallback**: Jay answers the question. The Architect processes this answer, saves it as a long-term memory in Mem0, and unblocks the session. Future similar questions will be handled autonomously.

```

### 4. Implementation, Jules, & PR-Driven Flow

**[Target Section: Insert into `Milestone 3 — Specialist Agents` and reference in `Milestone 4`]**

```markdown
### 3.8 — Implementation & PR-Driven Workflow

The implementation phase is strictly PR-driven and utilizes Google Jules for code review and testing.
* **Backend First**: The `api-coder` completes backend tasks first, leaving the dev server running so the `ui-agent` can work and test iteratively.
* **Google Jules Integration**: Once code is drafted, the PM invokes Google Jules. Jules performs a code review, starts the dev server, creates Playwright e2e tests, and fixes issues. 
* **PR as a Completion Signal**: Jules creates a Pull Request to merge the work back onto the task/feature branch. The creation of this PR serves as the official work-completion signal for the PM/Architect.
* **Architect Review**: The Architect reviews the PR. It can approve the merge, recommend the task go back to planning, or pass it to QA. 
* **QA & Final Review**: E2e tests run, and the environment is left active for Jay to review via a local VSCode session or by checking the QA output. Once Jay approves, the task moves to Done and deploys to production.

```

### 5. Model Roster & Hardware Mapping

**[Target Section: Update the existing `Technology Stack` and `Agent Roster` tables]**

```markdown
### Updated Model Assignments (via LiteLLM routing)
* **PM & Researcher**: Gemini 1.5 Flash (optimized for speed/coordination)
* **Architect**: Gemini 1.5 Pro (optimized for deep reasoning/context window)
* **API, UI, & QA**: Claude 3.5/3.7 Sonnet (optimized for coding/benchmarks)
* **Planner (Superpowers)**: Claude 3 Opus

### Hardware Execution Nodes
* **Coder Pods**: Run standard Dapr actors with Git worktrees per task.
* **Mac Mini Node**: The Researcher and QA agents will utilize a screen scraper service running on the Mac Mini. This allows the Researcher to interact with Claude Web, Gemini, and Windsurf via UI, and allows the QA agent to perform Chrome MCP testing.

```

### 6. Local Actor Testing

**[Target Section: Append to `Testing Strategy` under `Cross-Cutting Concerns`]**

```markdown
### Local Actor Testing (Postman)
Before full k3s deployment, agents will be spun up locally in debug mode. Testing will be conducted by directly invoking the Actor API via Postman. Initial focus will be on the planning flow, ensuring Gemini's plan output correctly persists in the Dapr state store before being dispatched to the broader workflow.

```
