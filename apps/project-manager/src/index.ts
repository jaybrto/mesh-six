import { Hono } from "hono";
import { DaprClient, HttpMethod } from "@dapr/dapr";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  AgentRegistry,
  AgentMemory,
  createAgentMemoryFromEnv,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
} from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "project-manager";
const AGENT_NAME = process.env.AGENT_NAME || "Project Manager Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";

// LLM Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";

// GitHub/Gitea Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITEA_URL = process.env.GITEA_URL || "";
const GITEA_TOKEN = process.env.GITEA_TOKEN || "";

// --- LLM Provider ---
const llm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
});

// --- GitHub Client ---
const github = GITHUB_TOKEN
  ? new Octokit({ auth: GITHUB_TOKEN })
  : null;

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });
const registry = new AgentRegistry(daprClient);

// --- Memory Layer ---
let memory: AgentMemory | null = null;

// --- Project State Machine ---
export const ProjectState = z.enum([
  "CREATE",
  "PLANNING",
  "REVIEW",
  "IN_PROGRESS",
  "QA",
  "DEPLOY",
  "VALIDATE",
  "ACCEPTED",
  "FAILED",
]);
export type ProjectState = z.infer<typeof ProjectState>;

// --- Project Schema ---
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  state: ProjectState,
  platform: z.enum(["github", "gitea"]),
  repoOwner: z.string(),
  repoName: z.string(),
  issueNumber: z.number().optional(),
  prNumber: z.number().optional(),
  boardItemId: z.string().optional(),
  assignedAgent: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stateHistory: z.array(z.object({
    state: ProjectState,
    timestamp: z.string(),
    reason: z.string().optional(),
  })),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

// --- Review Result Schema ---
export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  concerns: z.array(z.string()),
  suggestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// --- Project Task Request Schema ---
export const ProjectTaskSchema = z.object({
  action: z.enum([
    "create-project",
    "advance-state",
    "review-plan",
    "review-qa",
    "review-deployment",
    "get-status",
    "consult-architect",
    "request-research",
  ]),
  projectId: z.string().uuid().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  platform: z.enum(["github", "gitea"]).optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "project-management",
      weight: 1.0,
      preferred: true,
      requirements: [],
      async: true,
      estimatedDuration: "varies",
    },
    {
      name: "task-orchestration",
      weight: 0.95,
      preferred: true,
      requirements: [],
      async: true,
    },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "project-lifecycle-management",
    platforms: ["github", "gitea"],
    stateCount: 8,
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Project Manager Agent for Jay's homelab agent mesh. You orchestrate the full lifecycle of software projects from creation through deployment.

## Your Role
- Create and manage project board items on GitHub/Gitea
- Drive projects through the state machine: CREATE → PLANNING → REVIEW → IN_PROGRESS → QA → DEPLOY → VALIDATE → ACCEPTED
- Consult the Architect agent for technical guidance
- Request research from the Researcher agent when needed
- Evaluate work quality at review gates
- Coordinate with Claude Code pods for implementation

## State Machine
1. **CREATE**: Initial project creation, board item created
2. **PLANNING**: Implementation plan being developed
3. **REVIEW**: Plan review - approve or send back to PLANNING
4. **IN_PROGRESS**: Active development by Claude Code pod
5. **QA**: Testing and quality checks
6. **DEPLOY**: Deployment in progress
7. **VALIDATE**: Post-deployment validation
8. **ACCEPTED**: Project completed successfully

## Review Gates
At each review transition, evaluate:
- Completeness of requirements
- Technical soundness
- Test coverage
- Deployment readiness

## Consultation Protocol
- Before creating tasks: Consult Architect for tech stack guidance
- For unknown domains: Request Research from Researcher agent
- Store all decisions in memory for future reference

## Communication Style
- Be organized and structured
- Provide clear status updates
- Flag blockers proactively
- Document all decisions`;

// --- In-Memory Project Store (would be Dapr state in production) ---
const projects = new Map<string, Project>();

// --- Helper Functions ---
async function consultArchitect(question: string): Promise<unknown> {
  console.log(`[${AGENT_ID}] Consulting architect: "${question.substring(0, 50)}..."`);

  try {
    const response = await daprClient.invoker.invoke(
      "architect-agent",
      "consult",
      HttpMethod.POST,
      { question, requireStructured: true }
    );
    return response;
  } catch (error) {
    console.warn(`[${AGENT_ID}] Architect consultation failed:`, error);
    return { error: "Architect agent unavailable", fallback: true };
  }
}

async function requestResearch(query: string, type: string = "technical-research"): Promise<unknown> {
  console.log(`[${AGENT_ID}] Requesting research: "${query.substring(0, 50)}..."`);

  try {
    const response = await daprClient.invoker.invoke(
      "researcher-agent",
      "research",
      HttpMethod.POST,
      { query, type, requireStructured: true }
    );
    return response;
  } catch (error) {
    console.warn(`[${AGENT_ID}] Research request failed:`, error);
    return { error: "Researcher agent unavailable", fallback: true };
  }
}

async function createGitHubIssue(
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<{ issueNumber: number; url: string } | null> {
  if (!github) {
    console.warn(`[${AGENT_ID}] GitHub client not configured`);
    return null;
  }

  try {
    const response = await github.issues.create({
      owner,
      repo,
      title,
      body,
      labels: ["mesh-six", "automated"],
    });

    return {
      issueNumber: response.data.number,
      url: response.data.html_url,
    };
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to create GitHub issue:`, error);
    return null;
  }
}

// TODO: Use this when implementing issue state transitions
async function _updateGitHubIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  update: { state?: "open" | "closed"; body?: string; labels?: string[] }
): Promise<boolean> {
  if (!github) return false;

  try {
    await github.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      ...update,
    });
    return true;
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to update GitHub issue:`, error);
    return false;
  }
}
void _updateGitHubIssue; // Suppress unused warning

async function addGitHubComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<boolean> {
  if (!github) return false;

  try {
    await github.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return true;
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to add GitHub comment:`, error);
    return false;
  }
}

async function createGiteaIssue(
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<{ issueNumber: number; url: string } | null> {
  if (!GITEA_URL || !GITEA_TOKEN) {
    console.warn(`[${AGENT_ID}] Gitea client not configured`);
    return null;
  }

  try {
    const response = await fetch(`${GITEA_URL}/api/v1/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `token ${GITEA_TOKEN}`,
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["mesh-six", "automated"],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gitea API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      issueNumber: data.number,
      url: data.html_url,
    };
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to create Gitea issue:`, error);
    return null;
  }
}

// --- State Transition Logic ---
function canTransition(from: ProjectState, to: ProjectState): boolean {
  const validTransitions: Record<ProjectState, ProjectState[]> = {
    CREATE: ["PLANNING"],
    PLANNING: ["REVIEW"],
    REVIEW: ["PLANNING", "IN_PROGRESS"], // Can go back to PLANNING or forward
    IN_PROGRESS: ["QA"],
    QA: ["PLANNING", "DEPLOY"], // Can go back if tests fail
    DEPLOY: ["VALIDATE"],
    VALIDATE: ["PLANNING", "ACCEPTED"], // Can go back if validation fails
    ACCEPTED: [], // Terminal state
    FAILED: [], // Terminal state
  };

  return validTransitions[from]?.includes(to) ?? false;
}

async function transitionState(
  project: Project,
  newState: ProjectState,
  reason?: string
): Promise<Project> {
  if (!canTransition(project.state, newState)) {
    throw new Error(`Invalid state transition: ${project.state} → ${newState}`);
  }

  const now = new Date().toISOString();
  project.state = newState;
  project.updatedAt = now;
  project.stateHistory.push({
    state: newState,
    timestamp: now,
    reason,
  });

  projects.set(project.id, project);

  // Add comment to issue
  if (project.issueNumber) {
    const comment = `🔄 **State Transition**: ${project.stateHistory[project.stateHistory.length - 2]?.state || "CREATE"} → ${newState}\n\n${reason || ""}`;

    if (project.platform === "github") {
      await addGitHubComment(project.repoOwner, project.repoName, project.issueNumber, comment);
    }
  }

  return project;
}

// --- Review Gate Evaluation ---
async function evaluateReviewGate(
  project: Project,
  gateType: "plan" | "qa" | "deployment",
  context: Record<string, unknown>
): Promise<ReviewResult> {
  const prompts: Record<string, string> = {
    plan: `Evaluate this implementation plan for project "${project.title}":

${JSON.stringify(context, null, 2)}

Consider:
- Are requirements clearly defined?
- Is the technical approach sound?
- Are there any missing considerations?
- Is the scope appropriate?`,
    qa: `Evaluate the QA results for project "${project.title}":

${JSON.stringify(context, null, 2)}

Consider:
- Did all tests pass?
- Is test coverage adequate?
- Are there any regressions?
- Is the code quality acceptable?`,
    deployment: `Evaluate the deployment for project "${project.title}":

${JSON.stringify(context, null, 2)}

Consider:
- Is the service healthy?
- Are all endpoints responding?
- Are there any errors in logs?
- Is performance acceptable?`,
  };

  const { object } = await generateObject({
    model: llm(LLM_MODEL),
    schema: ReviewResultSchema,
    system: SYSTEM_PROMPT,
    prompt: prompts[gateType],
  });

  return object;
}

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
    platforms: {
      github: !!GITHUB_TOKEN,
      gitea: !!GITEA_URL && !!GITEA_TOKEN,
    },
    activeProjects: projects.size,
  })
);

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription
app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: `tasks.${AGENT_ID}`,
      route: "/tasks",
    },
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: "project-events",
      route: "/project-events",
    },
  ];
  return c.json(subscriptions);
});

// --- Project Management Endpoints ---

// Create a new project
app.post("/projects", async (c) => {
  try {
    const body = await c.req.json();
    const { title, description, platform, repoOwner, repoName, context } = body;

    // Consult architect for initial guidance
    const architectGuidance = await consultArchitect(
      `New project request: "${title}". Description: ${description}. What technical approach do you recommend?`
    );

    // Create issue on platform
    const issueBody = `## Project: ${title}

${description}

---

### Architectural Guidance
\`\`\`json
${JSON.stringify(architectGuidance, null, 2)}
\`\`\`

---

*Managed by Project Manager Agent (mesh-six)*`;

    let issueResult: { issueNumber: number; url: string } | null = null;

    if (platform === "github") {
      issueResult = await createGitHubIssue(repoOwner, repoName, title, issueBody);
    } else if (platform === "gitea") {
      issueResult = await createGiteaIssue(repoOwner, repoName, title, issueBody);
    }

    // Create project record
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      title,
      description,
      state: "CREATE",
      platform,
      repoOwner,
      repoName,
      issueNumber: issueResult?.issueNumber,
      createdAt: now,
      updatedAt: now,
      stateHistory: [{ state: "CREATE", timestamp: now, reason: "Project created" }],
      metadata: {
        architectGuidance,
        issueUrl: issueResult?.url,
        ...context,
      },
    };

    projects.set(project.id, project);

    // Immediately transition to PLANNING
    await transitionState(project, "PLANNING", "Initial planning phase started");

    // Store in memory
    if (memory) {
      try {
        await memory.store(
          [
            { role: "user", content: `Create project: ${title}` },
            { role: "assistant", content: `Created project ${project.id} on ${platform}/${repoOwner}/${repoName}` },
          ],
          "project-manager",
          { projectId: project.id, action: "create" }
        );
      } catch (error) {
        console.warn(`[${AGENT_ID}] Failed to store in memory:`, error);
      }
    }

    console.log(`[${AGENT_ID}] Created project: ${project.id} - ${title}`);

    return c.json({
      success: true,
      project,
      issueUrl: issueResult?.url,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to create project:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Get project status
app.get("/projects/:id", (c) => {
  const projectId = c.req.param("id");
  const project = projects.get(projectId);

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ project });
});

// List all projects
app.get("/projects", (c) => {
  const projectList = Array.from(projects.values());
  return c.json({
    count: projectList.length,
    projects: projectList.map((p) => ({
      id: p.id,
      title: p.title,
      state: p.state,
      platform: p.platform,
      updatedAt: p.updatedAt,
    })),
  });
});

// Advance project state
app.post("/projects/:id/advance", async (c) => {
  try {
    const projectId = c.req.param("id");
    const project = projects.get(projectId);

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json();
    const { targetState, context, force } = body;

    // Validate transition
    if (!force && !canTransition(project.state, targetState)) {
      return c.json({
        error: `Invalid transition: ${project.state} → ${targetState}`,
        validTransitions: getValidTransitions(project.state),
      }, 400);
    }

    // Perform review gate if applicable
    if (["REVIEW", "DEPLOY", "ACCEPTED"].includes(targetState)) {
      const gateType = targetState === "REVIEW" ? "plan" :
                       targetState === "DEPLOY" ? "qa" : "deployment";

      const review = await evaluateReviewGate(project, gateType as "plan" | "qa" | "deployment", context || {});

      if (!review.approved && !force) {
        // Add feedback to issue
        if (project.issueNumber) {
          const feedbackComment = `⚠️ **Review Gate Failed**: ${gateType}

**Concerns:**
${review.concerns.map((c) => `- ${c}`).join("\n")}

**Suggestions:**
${review.suggestions.map((s) => `- ${s}`).join("\n")}

**Reasoning:** ${review.reasoning}

*Confidence: ${(review.confidence * 100).toFixed(0)}%*`;

          if (project.platform === "github") {
            await addGitHubComment(project.repoOwner, project.repoName, project.issueNumber, feedbackComment);
          }
        }

        return c.json({
          success: false,
          review,
          message: "Review gate not passed. Address concerns and retry.",
        });
      }
    }

    // Perform transition
    const reason = body.reason || `Advanced to ${targetState}`;
    await transitionState(project, targetState, reason);

    console.log(`[${AGENT_ID}] Project ${projectId} transitioned to ${targetState}`);

    return c.json({
      success: true,
      project,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to advance project:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Get valid transitions for a state
function getValidTransitions(state: ProjectState): ProjectState[] {
  const transitions: Record<ProjectState, ProjectState[]> = {
    CREATE: ["PLANNING"],
    PLANNING: ["REVIEW"],
    REVIEW: ["PLANNING", "IN_PROGRESS"],
    IN_PROGRESS: ["QA"],
    QA: ["PLANNING", "DEPLOY"],
    DEPLOY: ["VALIDATE"],
    VALIDATE: ["PLANNING", "ACCEPTED"],
    ACCEPTED: [],
    FAILED: [],
  };
  return transitions[state] || [];
}

// --- Generic Invocation Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();
  const task = ProjectTaskSchema.parse(body.payload || body);

  let result: unknown;

  switch (task.action) {
    case "create-project":
      // Forward to /projects endpoint logic
      result = { message: "Use POST /projects endpoint" };
      break;

    case "consult-architect":
      result = await consultArchitect(task.description || "General architecture guidance needed");
      break;

    case "request-research":
      result = await requestResearch(task.description || "Research request", "technical-research");
      break;

    case "get-status":
      if (task.projectId) {
        result = projects.get(task.projectId) || { error: "Project not found" };
      } else {
        result = Array.from(projects.values());
      }
      break;

    default:
      result = { error: `Unknown action: ${task.action}` };
  }

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { data: result },
    durationMs: 0,
    completedAt: new Date().toISOString(),
  } satisfies TaskResult);
});

// --- Task Handler (Pub/Sub) ---
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id} - ${task.capability}`);

  try {
    const projectTask = ProjectTaskSchema.parse(task.payload);

    let result: unknown;

    switch (projectTask.action) {
      case "create-project":
        // Create project
        const project: Project = {
          id: crypto.randomUUID(),
          title: projectTask.title || "Untitled Project",
          description: projectTask.description || "",
          state: "CREATE",
          platform: projectTask.platform || "github",
          repoOwner: projectTask.repoOwner || "",
          repoName: projectTask.repoName || "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          stateHistory: [],
          metadata: projectTask.context,
        };
        projects.set(project.id, project);
        result = project;
        break;

      case "consult-architect":
        result = await consultArchitect(projectTask.description || "");
        break;

      case "request-research":
        result = await requestResearch(projectTask.description || "");
        break;

      default:
        result = { processed: true, action: projectTask.action };
    }

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { data: result },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, taskResult);
    console.log(`[${AGENT_ID}] Task ${task.id} completed`);

    return c.json({ status: "SUCCESS" });
  } catch (error) {
    console.error(`[${AGENT_ID}] Task ${task.id} failed:`, error);

    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "project_manager_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// Project events handler
app.post("/project-events", async (c) => {
  const message: DaprPubSubMessage<unknown> = await c.req.json();
  console.log(`[${AGENT_ID}] Received project event:`, message.data);

  // Handle project events (e.g., CI/CD completion, test results)
  // This would trigger state transitions based on external events

  return c.json({ status: "SUCCESS" });
});

// --- Lifecycle ---
let heartbeatInterval: Timer | null = null;

async function start(): Promise<void> {
  // Initialize memory
  if (MEMORY_ENABLED) {
    try {
      memory = createAgentMemoryFromEnv(AGENT_ID);
      console.log(`[${AGENT_ID}] Memory layer initialized`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory initialization failed:`, error);
      memory = null;
    }
  }

  // Register with agent registry
  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  // Log platform status
  console.log(`[${AGENT_ID}] Platform status:`, {
    github: !!GITHUB_TOKEN,
    gitea: !!GITEA_URL && !!GITEA_TOKEN,
  });

  // Start heartbeat
  heartbeatInterval = setInterval(async () => {
    try {
      await registry.heartbeat(AGENT_ID);
    } catch (error) {
      console.error(`[${AGENT_ID}] Heartbeat failed:`, error);
    }
  }, 30_000);

  // Start HTTP server
  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
  console.log(`[${AGENT_ID}] Capabilities: ${REGISTRATION.capabilities.map((c) => c.name).join(", ")}`);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  try {
    await registry.markOffline(AGENT_ID);
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to mark offline:`, error);
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((error) => {
  console.error(`[${AGENT_ID}] Failed to start:`, error);
  process.exit(1);
});
