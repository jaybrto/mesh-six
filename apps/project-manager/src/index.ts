import { Hono } from "hono";
import { DaprClient, HttpMethod, WorkflowRuntime, DaprWorkflowClient } from "@dapr/dapr";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import * as mqtt from "mqtt";
import { Pool } from "pg";
import {
  AgentRegistry,
  AgentMemory,
  createAgentMemoryFromEnv,
  buildAgentContext,
  transitionClose,
  EventLog,
  GitHubProjectClient,
  BoardEvent,
  DAPR_PUBSUB_NAME,
  DAPR_STATE_STORE,
  TASK_RESULTS_TOPIC,
  tracedGenerateText,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
  type ContextConfig,
  type TransitionCloseConfig,
  type BoardEventType,
} from "@mesh-six/core";
import {
  createWorkflowRuntime,
  createWorkflowClient,
  startProjectWorkflow,
  getProjectWorkflowStatus,
  raiseWorkflowEvent,
  pollGithubForCompletion,
  type ProjectWorkflowInput,
  type WorkflowActivityImplementations,
  type ConsultArchitectOutput,
  type ReviewPlanOutput,
  type EvaluateTestResultsOutput,
  type ValidateDeploymentOutput,
  type WaitForDeploymentOutput,
} from "./workflow.js";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "project-manager";
const AGENT_NAME = process.env.AGENT_NAME || "Project Manager Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// LLM Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";

// GitHub/Gitea Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITEA_URL = process.env.GITEA_URL || "";
const GITEA_TOKEN = process.env.GITEA_TOKEN || "";

// GitHub Projects Configuration
const GITHUB_PROJECT_ID = process.env.GITHUB_PROJECT_ID || "";
const GITHUB_STATUS_FIELD_ID = process.env.GITHUB_STATUS_FIELD_ID || "";

// Notification Configuration
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";

// MQTT Configuration
const MQTT_URL = process.env.MQTT_URL || "mqtt://rabbitmq.rabbitmq:1883";
const MQTT_ENABLED = process.env.MQTT_ENABLED !== "false";

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

// --- Event Log ---
let eventLog: EventLog | null = null;
const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
if (pgPool) {
  eventLog = new EventLog(pgPool);
  console.log(`[${AGENT_ID}] Event log initialized`);
}

// --- GitHub Projects Client ---
let ghProjectClient: GitHubProjectClient | null = null;
if (GITHUB_TOKEN && GITHUB_PROJECT_ID && GITHUB_STATUS_FIELD_ID) {
  ghProjectClient = new GitHubProjectClient({
    token: GITHUB_TOKEN,
    projectId: GITHUB_PROJECT_ID,
    statusFieldId: GITHUB_STATUS_FIELD_ID,
  });
  console.log(`[${AGENT_ID}] GitHub Projects client initialized`);
}

// --- MQTT Client ---
let mqttClient: mqtt.MqttClient | null = null;

// --- Workflow Runtime & Client ---
let workflowRuntime: WorkflowRuntime | null = null;
let workflowClient: DaprWorkflowClient | null = null;

// --- Workflow Instance Tracking ---
// Maps project UUID to workflow instance ID
const projectWorkflowMap = new Map<string, string>();

// --- pm_workflow_instances Query Helpers ---
interface WorkflowInstanceRow {
  id: string;
  workflow_id: string;
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  current_phase: string;
  status: string;
  project_item_id: string | null;
  created_at: string;
  updated_at: string;
}

async function lookupByIssue(
  repoOwner: string,
  repoName: string,
  issueNumber: number
): Promise<WorkflowInstanceRow | null> {
  if (!pgPool) return null;
  const { rows } = await pgPool.query<WorkflowInstanceRow>(
    `SELECT * FROM pm_workflow_instances WHERE repo_owner = $1 AND repo_name = $2 AND issue_number = $3 LIMIT 1`,
    [repoOwner, repoName, issueNumber]
  );
  return rows[0] ?? null;
}

async function updatePhase(workflowId: string, phase: string): Promise<void> {
  if (!pgPool) return;
  await pgPool.query(
    `UPDATE pm_workflow_instances SET current_phase = $1, updated_at = NOW() WHERE workflow_id = $2`,
    [phase, workflowId]
  );
}

async function updateStatus(workflowId: string, status: string): Promise<void> {
  if (!pgPool) return;
  await pgPool.query(
    `UPDATE pm_workflow_instances SET status = $1, updated_at = NOW() WHERE workflow_id = $2`,
    [status, workflowId]
  );
}

// --- Code Pod Progress Event Schema ---
interface CodePodProgress {
  jobId: string;
  status: 'started' | 'in_progress' | 'completed' | 'failed';
  details: string;
  timestamp: string;
}

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

// --- Smoke Test Schemas ---
export interface EndpointTest {
  url: string;
  method: 'GET' | 'POST';
  expectedStatus: number;
}

export interface SmokeTestResult {
  endpoint: string;
  method: string;
  statusCode: number;
  responseTimeMs: number;
  success: boolean;
  error?: string;
}

// --- Playwright Test Result Schema ---
export const PlaywrightTestSchema = z.object({
  status: z.enum(["passed", "failed", "skipped", "timedOut"]),
  errors: z.array(z.object({
    message: z.string(),
    stack: z.string().optional(),
  })).optional(),
});

export const PlaywrightSpecSchema = z.object({
  title: z.string(),
  ok: z.boolean(),
  tests: z.array(PlaywrightTestSchema),
});

export const PlaywrightSuiteSchema = z.object({
  title: z.string(),
  specs: z.array(PlaywrightSpecSchema),
});

export const PlaywrightResultSchema = z.object({
  config: z.object({
    projects: z.array(z.object({
      name: z.string(),
    })),
  }),
  suites: z.array(PlaywrightSuiteSchema),
  stats: z.object({
    expected: z.number(),
    unexpected: z.number(),
    flaky: z.number(),
    skipped: z.number(),
  }),
});

export type PlaywrightResult = z.infer<typeof PlaywrightResultSchema>;

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
const SYSTEM_PROMPT = `You are the Project Manager Agent for the mesh-six agent mesh. You orchestrate the full lifecycle of software projects from creation through deployment.

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
async function consultArchitect(question: string, projectId?: string): Promise<unknown> {
  console.log(`[${AGENT_ID}] Consulting architect: "${question.substring(0, 50)}..."`);

  try {
    const response = await daprClient.invoker.invoke(
      "architect-agent",
      "consult",
      HttpMethod.POST,
      { question, requireStructured: true }
    );

    // Store reflection from architect consultation
    if (memory) {
      const closeConfig: TransitionCloseConfig = {
        agentId: AGENT_ID,
        taskId: projectId || "general",
        projectId,
        transitionFrom: "PLANNING",
        transitionTo: "REVIEW",
        conversationHistory: [
          { role: "user", content: question },
          { role: "assistant", content: JSON.stringify(response) },
        ],
        taskState: { action: "consult-architect" },
      };

      try {
        // Cast needed: project-manager uses ai@4 (LanguageModelV1), core uses ai@6 (LanguageModel)
        await transitionClose(closeConfig, memory, llm(LLM_MODEL) as any);
      } catch (err) {
        console.warn(`[${AGENT_ID}] transitionClose failed for architect consultation:`, err);
      }
    }

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
  body: string,
  labels?: string[]
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
        labels: labels || ["mesh-six", "automated"],
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

// --- Playwright Test Result Parsing ---

/**
 * Parse Playwright test results from JSON file
 */
async function parsePlaywrightResults(resultsPath: string): Promise<PlaywrightResult | null> {
  try {
    const fileContent = await readFile(resultsPath, "utf-8");
    const jsonData = JSON.parse(fileContent);
    const result = PlaywrightResultSchema.parse(jsonData);
    return result;
  } catch (error) {
    console.warn(`[${AGENT_ID}] Failed to parse Playwright results from ${resultsPath}:`, error);
    return null;
  }
}

/**
 * Extract test failures from Playwright results
 */
function extractTestFailures(results: PlaywrightResult): string[] {
  const failures: string[] = [];

  for (const suite of results.suites) {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        if (test.status === "failed" || test.status === "timedOut") {
          const suiteTitle = suite.title || "Unknown Suite";
          const specTitle = spec.title || "Unknown Spec";
          const errorMessage = test.errors?.[0]?.message || "No error message available";

          failures.push(`${suiteTitle} > ${specTitle}: ${errorMessage}`);
        }
      }
    }
  }

  return failures;
}

/**
 * Create bug issue for test failures
 */
async function createBugIssueForTestFailure(
  project: Project,
  failures: string[],
  testStats: PlaywrightResult["stats"]
): Promise<void> {
  const title = `[Bug] Test failures in ${project.title}`;
  const body = `## Test Failures Detected

**Project:** ${project.title}
**State:** ${project.state}

### Test Statistics
- ✅ Passed: ${testStats.expected}
- ❌ Failed: ${testStats.unexpected}
- ⚠️ Flaky: ${testStats.flaky}
- ⏭️ Skipped: ${testStats.skipped}

### Failed Tests
${failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}

---

*Auto-generated by Project Manager Agent*
*Related to project: ${project.id}*`;

  let issueResult: { issueNumber: number; url: string } | null = null;

  if (project.platform === "github") {
    if (!github) {
      console.warn(`[${AGENT_ID}] GitHub client not configured, cannot create bug issue`);
      return;
    }

    try {
      const response = await github.issues.create({
        owner: project.repoOwner,
        repo: project.repoName,
        title,
        body,
        labels: ["bug", "test-failure", "mesh-six", "automated"],
      });
      issueResult = {
        issueNumber: response.data.number,
        url: response.data.html_url,
      };
    } catch (error) {
      console.error(`[${AGENT_ID}] Failed to create GitHub bug issue:`, error);
      return;
    }
  } else if (project.platform === "gitea") {
    issueResult = await createGiteaIssue(
      project.repoOwner,
      project.repoName,
      title,
      body,
      ["bug", "test-failure", "mesh-six", "automated"]
    );
  }

  if (issueResult) {
    console.log(`[${AGENT_ID}] Created bug issue #${issueResult.issueNumber}: ${issueResult.url}`);
  }
}

// --- Smoke Testing Functions ---

/**
 * Run smoke tests against a deployed service
 * @param baseUrl Base URL of the deployed service
 * @param endpoints Optional array of custom endpoint tests
 * @returns Array of smoke test results
 */
async function runSmokeTests(
  baseUrl: string,
  endpoints?: EndpointTest[]
): Promise<SmokeTestResult[]> {
  // Default endpoints: health and readiness checks
  const defaultEndpoints: EndpointTest[] = [
    { url: `${baseUrl}/healthz`, method: 'GET', expectedStatus: 200 },
    { url: `${baseUrl}/readyz`, method: 'GET', expectedStatus: 200 },
  ];

  const testsToRun = endpoints && endpoints.length > 0 ? endpoints : defaultEndpoints;
  const results: SmokeTestResult[] = [];

  console.log(`[${AGENT_ID}] Running smoke tests against ${baseUrl}`);

  for (const test of testsToRun) {
    const startTime = Date.now();
    let result: SmokeTestResult;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(test.url, {
        method: test.method,
        signal: controller.signal,
        headers: test.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      });

      clearTimeout(timeoutId);
      const responseTimeMs = Date.now() - startTime;

      result = {
        endpoint: test.url,
        method: test.method,
        statusCode: response.status,
        responseTimeMs,
        success: response.status === test.expectedStatus,
        error: response.status !== test.expectedStatus
          ? `Expected ${test.expectedStatus}, got ${response.status}`
          : undefined,
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      result = {
        endpoint: test.url,
        method: test.method,
        statusCode: 0,
        responseTimeMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    results.push(result);
    console.log(`[${AGENT_ID}] Smoke test: ${test.method} ${test.url} - ${result.success ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

/**
 * Format smoke test results into a markdown report
 * @param results Array of smoke test results
 * @returns Markdown formatted report
 */
function formatSmokeTestReport(results: SmokeTestResult[]): string {
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const total = results.length;

  let report = `## Smoke Test Results\n\n`;
  report += `**Summary:** ${passed}/${total} passed, ${failed}/${total} failed\n\n`;
  report += `| Endpoint | Method | Status | Response Time | Result |\n`;
  report += `|----------|--------|--------|---------------|--------|\n`;

  for (const result of results) {
    const statusEmoji = result.success ? '✅' : '❌';
    const endpoint = result.endpoint.length > 50
      ? '...' + result.endpoint.substring(result.endpoint.length - 47)
      : result.endpoint;

    report += `| ${endpoint} | ${result.method} | ${result.statusCode || 'N/A'} | ${result.responseTimeMs}ms | ${statusEmoji} |\n`;
  }

  if (failed > 0) {
    report += `\n### Failures\n\n`;
    for (const result of results.filter(r => !r.success)) {
      report += `- **${result.method} ${result.endpoint}**: ${result.error || 'Unknown error'}\n`;
    }
  }

  return report;
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
  // For QA gate, check Playwright test results first if provided
  if (gateType === "qa" && context.testResultsPath && typeof context.testResultsPath === "string") {
    const playwrightResults = await parsePlaywrightResults(context.testResultsPath);

    if (playwrightResults) {
      const failures = extractTestFailures(playwrightResults);

      // Auto-reject if tests failed
      if (playwrightResults.stats.unexpected > 0 || failures.length > 0) {
        // Create bug issue for failures
        await createBugIssueForTestFailure(project, failures, playwrightResults.stats);

        return {
          approved: false,
          concerns: [
            `${playwrightResults.stats.unexpected} test(s) failed`,
            ...failures.slice(0, 5), // Limit to first 5 failures in concerns
          ],
          suggestions: [
            "Fix failing tests before proceeding to deployment",
            "Review test failure details in the generated bug issue",
            failures.length > 5 ? `${failures.length - 5} more failure(s) not shown` : "",
          ].filter(Boolean),
          confidence: 1.0,
          reasoning: `Playwright tests detected ${playwrightResults.stats.unexpected} failure(s). Tests must pass before deployment. A bug issue has been created with failure details.`,
        };
      }

      // Include test stats in context for LLM evaluation
      context.playwrightStats = playwrightResults.stats;
      context.testsPassed = true;
    }
  }

  // For deployment gate, run smoke tests if serviceUrl is provided
  if (gateType === "deployment" && context.serviceUrl && typeof context.serviceUrl === "string") {
    const customEndpoints = context.endpoints as EndpointTest[] | undefined;
    const smokeTestResults = await runSmokeTests(context.serviceUrl, customEndpoints);

    // Check for critical endpoint failures (healthz, readyz)
    const criticalFailures = smokeTestResults.filter(
      r => !r.success && (r.endpoint.includes('/healthz') || r.endpoint.includes('/readyz'))
    );

    if (criticalFailures.length > 0) {
      const report = formatSmokeTestReport(smokeTestResults);

      return {
        approved: false,
        concerns: criticalFailures.map(f => `Critical endpoint failed: ${f.method} ${f.endpoint} - ${f.error}`),
        suggestions: [
          "Verify the service is running and accessible",
          "Check deployment logs for startup errors",
          "Ensure health check endpoints are implemented correctly",
        ],
        confidence: 1.0,
        reasoning: `Smoke tests failed for critical health endpoints. Service is not ready for validation.\n\n${report}`,
      };
    }

    // Include smoke test results in context for LLM evaluation
    context.smokeTestResults = smokeTestResults;
    context.smokeTestReport = formatSmokeTestReport(smokeTestResults);

    const allPassed = smokeTestResults.every(r => r.success);
    const avgResponseTime = smokeTestResults.reduce((sum, r) => sum + r.responseTimeMs, 0) / smokeTestResults.length;

    context.smokeTestSummary = {
      allPassed,
      totalTests: smokeTestResults.length,
      passed: smokeTestResults.filter(r => r.success).length,
      failed: smokeTestResults.filter(r => !r.success).length,
      avgResponseTime: Math.round(avgResponseTime),
    };
  }

  const gatePrompts: Record<string, string> = {
    plan: `Evaluate this implementation plan for project "${project.title}". Consider: requirements clarity, technical soundness, missing considerations, scope appropriateness.`,
    qa: `Evaluate the QA results for project "${project.title}". Consider: test pass rate, coverage adequacy, regressions, code quality.`,
    deployment: `Evaluate the deployment for project "${project.title}". Consider: service health, endpoint responsiveness, log errors, performance.`,
  };

  // Build context with memory-enriched prompt
  const stateMap: Record<string, { from: ProjectState; to: ProjectState }> = {
    plan: { from: "PLANNING", to: "REVIEW" },
    qa: { from: "QA", to: "DEPLOY" },
    deployment: { from: "DEPLOY", to: "VALIDATE" },
  };

  const taskRequest: TaskRequest = {
    id: project.id,
    capability: "review-gate",
    payload: { gateType, ...context },
    priority: 7,
    timeout: 120,
    requestedBy: AGENT_ID,
    createdAt: new Date().toISOString(),
  };

  let systemPrompt = SYSTEM_PROMPT;
  let prompt = `${gatePrompts[gateType]}\n\n${JSON.stringify(context, null, 2)}`;

  // Use memory-enriched context if memory is available
  if (memory) {
    const contextConfig: ContextConfig = {
      agentId: AGENT_ID,
      systemPrompt: SYSTEM_PROMPT,
      task: taskRequest,
      memoryQuery: `${gateType} review gate ${project.title}`,
      maxMemoryTokens: 1500,
      additionalContext: gatePrompts[gateType],
    };

    const agentContext = await buildAgentContext(contextConfig, memory);
    systemPrompt = agentContext.system;
    prompt = agentContext.prompt;
  }

  const { object } = await generateObject({
    model: llm(LLM_MODEL),
    schema: ReviewResultSchema,
    system: systemPrompt,
    prompt,
  });

  // Run reflection to store learnings from this review gate
  if (memory) {
    const { from, to } = stateMap[gateType];
    const closeConfig: TransitionCloseConfig = {
      agentId: AGENT_ID,
      taskId: project.id,
      projectId: project.id,
      transitionFrom: from,
      transitionTo: to,
      conversationHistory: [
        { role: "user", content: prompt },
        { role: "assistant", content: JSON.stringify(object) },
      ],
      taskState: { gateType, approved: object.approved, confidence: object.confidence },
    };

    try {
      // Cast needed: project-manager uses ai@4 (LanguageModelV1), core uses ai@6 (LanguageModel)
      await transitionClose(closeConfig, memory, llm(LLM_MODEL) as any);
    } catch (error) {
      console.warn(`[${AGENT_ID}] transitionClose failed for ${gateType} gate:`, error);
    }
  }

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
    mqttEnabled: MQTT_ENABLED && mqttClient?.connected === true,
    workflowEnabled: workflowRuntime !== null && workflowClient !== null,
    platforms: {
      github: !!GITHUB_TOKEN,
      gitea: !!GITEA_URL && !!GITEA_TOKEN,
    },
    activeProjects: projects.size,
    trackedWorkflows: projectWorkflowMap.size,
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
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: "board-events",
      route: "/board-events",
    },
  ];
  return c.json(subscriptions);
});

// --- Project Management Endpoints ---

// Create a new project (using Dapr Workflow)
app.post("/projects", async (c) => {
  try {
    if (!workflowClient) {
      return c.json({ success: false, error: "Workflow client not initialized" }, 500);
    }

    const body = await c.req.json();
    const { title, description, platform, repoOwner, repoName, context } = body;

    // Legacy project creation endpoint — now wraps the board-driven workflow
    const workflowInput: ProjectWorkflowInput = {
      issueNumber: body.issueNumber || 0,
      issueTitle: title || "Untitled Project",
      repoOwner: repoOwner || "",
      repoName: repoName || "",
      projectItemId: body.projectItemId || "",
      contentNodeId: body.contentNodeId || "",
    };

    const projectId = crypto.randomUUID();
    const workflowInstanceId = await startProjectWorkflow(
      workflowClient,
      workflowInput,
      projectId
    );

    // Track project-to-workflow mapping
    projectWorkflowMap.set(projectId, workflowInstanceId);

    // Store in memory
    if (memory) {
      try {
        await memory.store(
          [
            { role: "user", content: `Create project: ${title}` },
            { role: "assistant", content: `Created project ${projectId} on ${platform}/${repoOwner}/${repoName}` },
          ],
          "project-manager",
          { projectId, action: "create", workflowInstanceId }
        );
      } catch (error) {
        console.warn(`[${AGENT_ID}] Failed to store in memory:`, error);
      }
    }

    console.log(`[${AGENT_ID}] Started workflow for project: ${projectId} - ${title}`);

    // Get initial workflow status
    const status = await getProjectWorkflowStatus(workflowClient, workflowInstanceId);

    return c.json({
      success: true,
      projectId,
      workflowInstanceId,
      workflowStatus: status,
      message: "Project workflow started. Project is now in PLANNING state.",
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to create project:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Get project status (from workflow)
app.get("/projects/:id", async (c) => {
  try {
    if (!workflowClient) {
      return c.json({ error: "Workflow client not initialized" }, 500);
    }

    const projectId = c.req.param("id");
    const workflowInstanceId = projectWorkflowMap.get(projectId) || projectId;

    const status = await getProjectWorkflowStatus(workflowClient, workflowInstanceId);

    // Also check in-memory map for backwards compatibility
    const legacyProject = projects.get(projectId);

    return c.json({
      projectId,
      workflowInstanceId,
      workflowStatus: status,
      legacyProject: legacyProject || null,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to get project status:`, error);
    return c.json({ error: String(error) }, 500);
  }
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

// Advance project state (using workflow events)
app.post("/projects/:id/advance", async (c) => {
  try {
    if (!workflowClient) {
      return c.json({ error: "Workflow client not initialized" }, 500);
    }

    const projectId = c.req.param("id");
    const workflowInstanceId = projectWorkflowMap.get(projectId) || projectId;

    const body = await c.req.json();
    const { targetState, context, reason } = body;

    // Raise advance event to workflow
    await raiseWorkflowEvent(
      workflowClient,
      workflowInstanceId,
      "advance",
      { targetState, context: context || {}, reason }
    );

    console.log(`[${AGENT_ID}] Raised advance event for project ${projectId} → ${targetState}`);

    // Get updated status
    const status = await getProjectWorkflowStatus(workflowClient, workflowInstanceId);

    return c.json({
      success: true,
      projectId,
      workflowInstanceId,
      targetState,
      workflowStatus: status,
      message: `Advance signal sent to workflow. Target state: ${targetState}`,
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
      result = await consultArchitect(task.description || "General architecture guidance needed", task.projectId);
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
        result = await consultArchitect(projectTask.description || "", projectTask.projectId);
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

// --- Board Events Handler (from webhook-receiver) ---
app.post("/board-events", async (c) => {
  const message: DaprPubSubMessage<unknown> = await c.req.json();

  let event: BoardEventType;
  try {
    event = BoardEvent.parse(message.data);
  } catch (err) {
    console.error(`[${AGENT_ID}] Invalid board event:`, err);
    return c.json({ status: "SUCCESS" });
  }

  console.log(`[${AGENT_ID}] Board event: type=${event.type} issue=#${event.issueNumber} repo=${event.repoOwner}/${event.repoName}`);

  try {
    switch (event.type) {
      case "new-todo": {
        // Start a new Dapr Workflow for this issue
        if (!workflowClient) {
          console.warn(`[${AGENT_ID}] Workflow client not ready, cannot start workflow for issue #${event.issueNumber}`);
          break;
        }

        const workflowInput: ProjectWorkflowInput = {
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          projectItemId: event.projectItemId,
          contentNodeId: event.contentNodeId,
        };

        const workflowInstanceId = await startProjectWorkflow(workflowClient, workflowInput);

        // Insert into pm_workflow_instances
        if (pgPool) {
          await pgPool.query(
            `INSERT INTO pm_workflow_instances (workflow_id, issue_number, repo_owner, repo_name, current_phase, status, project_item_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [workflowInstanceId, event.issueNumber, event.repoOwner, event.repoName, "PLANNING", "active", event.projectItemId]
          );
        }

        console.log(`[${AGENT_ID}] Started workflow ${workflowInstanceId} for issue #${event.issueNumber}`);
        break;
      }

      case "card-blocked": {
        const instance = await lookupByIssue(event.repoOwner, event.repoName, event.issueNumber);
        if (!instance) {
          console.warn(`[${AGENT_ID}] No workflow instance found for issue #${event.issueNumber}`);
          break;
        }
        if (workflowClient) {
          await workflowClient.raiseEvent(instance.workflow_id, "card-blocked", {
            fromColumn: event.fromColumn,
            timestamp: event.timestamp,
          });
          await updateStatus(instance.workflow_id, "blocked");
          console.log(`[${AGENT_ID}] Raised card-blocked event on workflow ${instance.workflow_id}`);
        }
        break;
      }

      case "card-unblocked": {
        const instance = await lookupByIssue(event.repoOwner, event.repoName, event.issueNumber);
        if (!instance) {
          console.warn(`[${AGENT_ID}] No workflow instance found for issue #${event.issueNumber}`);
          break;
        }
        if (workflowClient) {
          await workflowClient.raiseEvent(instance.workflow_id, "card-unblocked", {
            toColumn: event.toColumn,
            timestamp: event.timestamp,
          });
          await updateStatus(instance.workflow_id, "active");
          console.log(`[${AGENT_ID}] Raised card-unblocked event on workflow ${instance.workflow_id}`);
        }
        break;
      }

      case "card-moved": {
        const instance = await lookupByIssue(event.repoOwner, event.repoName, event.issueNumber);
        if (instance) {
          console.log(`[${AGENT_ID}] Card moved: issue #${event.issueNumber} from "${event.fromColumn}" to "${event.toColumn}" (workflow ${instance.workflow_id})`);
          await updatePhase(instance.workflow_id, event.toColumn);
        } else {
          console.log(`[${AGENT_ID}] Card moved for untracked issue #${event.issueNumber}: "${event.fromColumn}" -> "${event.toColumn}"`);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[${AGENT_ID}] Error handling board event:`, err);
  }

  // Always ACK to Dapr
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

  // Load GitHub Projects column mapping
  if (ghProjectClient) {
    try {
      const columnMap = await ghProjectClient.loadColumnMapping();
      console.log(`[${AGENT_ID}] GitHub Projects column mapping loaded:`, Object.keys(columnMap));
    } catch (error) {
      console.warn(`[${AGENT_ID}] Failed to load GitHub Projects column mapping:`, error);
    }
  }

  // Initialize Workflow Runtime and Client
  try {
    console.log(`[${AGENT_ID}] Initializing Dapr Workflow runtime...`);

    // M4.5 activity implementations for the board-driven workflow
    const activityImplementations: WorkflowActivityImplementations = {
      consultArchitect: async (_ctx, input) => {
        const result = await consultArchitect(input.question);
        if (typeof result === "object" && result !== null && "error" in result) {
          return { guidance: "Architect agent unavailable. Proceeding with best effort.", fallback: true };
        }
        return { guidance: JSON.stringify(result), fallback: false };
      },

      enrichIssue: async (_ctx, input) => {
        const body = `### Architect Guidance\n\n${input.guidance}\n\n### Acceptance Criteria\n\n${input.acceptanceCriteria}\n\n---\n*Enriched by Project Manager Agent (mesh-six)*`;
        await addGitHubComment(input.repoOwner, input.repoName, input.issueNumber, body);
      },

      recordPendingMove: async (_ctx, input) => {
        await daprClient.state.save(DAPR_STATE_STORE, [
          { key: `pending-moves:${input.projectItemId}`, value: input.toColumn },
        ]);
      },

      moveCard: async (_ctx, input) => {
        if (!ghProjectClient) throw new Error("GitHub Projects client not configured");
        await ghProjectClient.moveCard(input.projectItemId, input.toColumn);
        // Clear pending move after successful move
        await daprClient.state.delete(DAPR_STATE_STORE, `pending-moves:${input.projectItemId}`);
      },

      recordWorkflowMapping: async (_ctx, input) => {
        if (!pgPool) return;
        await pgPool.query(
          `INSERT INTO pm_workflow_instances (workflow_id, issue_number, repo_owner, repo_name, project_item_id, current_phase, status)
           VALUES ($1, $2, $3, $4, $5, 'INTAKE', 'active')
           ON CONFLICT (issue_number, repo_owner, repo_name) DO UPDATE SET workflow_id = $1, updated_at = NOW()`,
          [input.workflowId, input.issueNumber, input.repoOwner, input.repoName, input.projectItemId]
        );
      },

      pollForPlan: async (_ctx, input) => {
        if (!ghProjectClient) return { planContent: "", timedOut: true, blocked: false };
        const { result, timedOut, blocked } = await pollGithubForCompletion(
          async () => {
            const comments = await ghProjectClient!.getIssueComments(input.repoOwner, input.repoName, input.issueNumber);
            // Look for a comment that looks like a plan (has headings, task lists)
            for (const comment of comments.reverse()) {
              if (comment.body.length > 200 && (comment.body.includes("##") || comment.body.includes("- ["))) {
                return comment.body;
              }
            }
            return null;
          },
          async () => {
            const col = await ghProjectClient!.getItemColumn(input.projectItemId);
            return col === "Blocked";
          },
          input.timeoutMinutes
        );
        return { planContent: result ?? "", timedOut, blocked };
      },

      reviewPlan: async (_ctx, input) => {
        const { text } = await tracedGenerateText({
          agentId: AGENT_ID,
          traceId: crypto.randomUUID(),
          model: llm(LLM_MODEL) as any,
          system: "You are a technical plan reviewer. Evaluate this plan for completeness, technical soundness, and scope. Respond with JSON: { approved: boolean, feedback: string, confidence: number }",
          prompt: `Review this implementation plan for issue #${input.issueNumber} in ${input.repoOwner}/${input.repoName}:\n\n${input.planContent}`,
          eventLog: eventLog ?? undefined,
        });
        try {
          return JSON.parse(text);
        } catch {
          return { approved: false, feedback: "Failed to parse review output", confidence: 0 };
        }
      },

      addComment: async (_ctx, input) => {
        await addGitHubComment(input.repoOwner, input.repoName, input.issueNumber, input.body);
      },

      pollForImplementation: async (_ctx, input) => {
        if (!ghProjectClient) return { prNumber: null, timedOut: true, blocked: false };
        const { result, timedOut, blocked } = await pollGithubForCompletion(
          async () => {
            const prs = await ghProjectClient!.getIssuePRs(input.repoOwner, input.repoName, input.issueNumber);
            if (prs.length > 0) return prs[0].number;
            return null;
          },
          async () => {
            const col = await ghProjectClient!.getItemColumn(input.projectItemId);
            return col === "Blocked";
          },
          input.timeoutMinutes
        );
        return { prNumber: result, timedOut, blocked };
      },

      pollForTestResults: async (_ctx, input) => {
        if (!ghProjectClient) return { testContent: "", timedOut: true, blocked: false };
        const { result, timedOut, blocked } = await pollGithubForCompletion(
          async () => {
            const comments = await ghProjectClient!.getIssueComments(input.repoOwner, input.repoName, input.issueNumber);
            for (const comment of comments.reverse()) {
              if (comment.body.includes("test") && (comment.body.includes("pass") || comment.body.includes("fail") || comment.body.includes("PASS") || comment.body.includes("FAIL"))) {
                return comment.body;
              }
            }
            return null;
          },
          async () => {
            const col = await ghProjectClient!.getItemColumn(input.projectItemId);
            return col === "Blocked";
          },
          input.timeoutMinutes
        );
        return { testContent: result ?? "", timedOut, blocked };
      },

      evaluateTestResults: async (_ctx, input) => {
        const { text } = await tracedGenerateText({
          agentId: AGENT_ID,
          traceId: crypto.randomUUID(),
          model: llm(LLM_MODEL) as any,
          system: "You evaluate test results. Respond with JSON: { passed: boolean, failures: string[] }",
          prompt: `Evaluate these test results for issue #${input.issueNumber}:\n\n${input.testContent}`,
          eventLog: eventLog ?? undefined,
        });
        try {
          return JSON.parse(text);
        } catch {
          return { passed: false, failures: ["Failed to parse test evaluation"] };
        }
      },

      waitForDeployment: async (_ctx, input) => {
        const deadline = Date.now() + input.timeoutMinutes * 60 * 1000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(input.healthUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) return { healthy: true, timedOut: false };
          } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 15_000));
        }
        return { healthy: false, timedOut: true };
      },

      validateDeployment: async (_ctx, input) => {
        const results = await runSmokeTests(input.healthUrl);
        const failures = results.filter((r) => !r.success).map((r) => `${r.method} ${r.endpoint}: ${r.error}`);
        return { passed: failures.length === 0, failures };
      },

      createBugIssue: async (_ctx, input) => {
        if (!ghProjectClient) return { issueNumber: 0, url: "" };
        const title = `[Bug] Test failures from issue #${input.parentIssueNumber}`;
        const body = `## Test Failures\n\n${input.failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nParent issue: #${input.parentIssueNumber}`;
        const { number, url } = await ghProjectClient.createIssue(input.repoOwner, input.repoName, title, body, ["bug", "test-failure", "mesh-six"]);
        return { issueNumber: number, url };
      },

      notifyBlocked: async (_ctx, input) => {
        if (!input.ntfyTopic) return;
        await fetch(`https://ntfy.sh/${input.ntfyTopic}`, {
          method: "POST",
          body: `Issue #${input.issueNumber} (${input.repoOwner}/${input.repoName}) is BLOCKED:\n${input.question}`,
          headers: { Title: `mesh-six: Issue #${input.issueNumber} Blocked`, Priority: "high" },
        }).catch((e) => console.warn(`[${AGENT_ID}] ntfy.sh notification failed:`, e));
      },

      notifyTimeout: async (_ctx, input) => {
        if (!input.ntfyTopic) return;
        await fetch(`https://ntfy.sh/${input.ntfyTopic}`, {
          method: "POST",
          body: `Issue #${input.issueNumber} (${input.repoOwner}/${input.repoName}) timed out in ${input.phase} phase`,
          headers: { Title: `mesh-six: Phase timeout`, Priority: "default" },
        }).catch((e) => console.warn(`[${AGENT_ID}] ntfy.sh notification failed:`, e));
      },

      reportSuccess: async (_ctx, input) => {
        if (eventLog) {
          await eventLog.emit({
            traceId: input.workflowId,
            agentId: AGENT_ID,
            eventType: "workflow.completed",
            payload: { issueNumber: input.issueNumber, repoOwner: input.repoOwner, repoName: input.repoName },
          });
        }
        await updateStatus(input.workflowId, "completed");
      },

      moveToFailed: async (_ctx, input) => {
        if (eventLog) {
          await eventLog.emit({
            traceId: input.workflowId,
            agentId: AGENT_ID,
            eventType: "workflow.failed",
            payload: { issueNumber: input.issueNumber, reason: input.reason },
          });
        }
        await updateStatus(input.workflowId, "failed");
      },
    };

    // Create and start workflow runtime
    workflowRuntime = createWorkflowRuntime(activityImplementations);
    // Wrap start() to catch both sync and async gRPC stream errors
    // (durabletask-js can fail asynchronously on gRPC stream after start() resolves)
    await workflowRuntime.start().catch((err: Error) => {
      throw err; // rethrow — caught by outer catch block
    });
    // Attach error handler to suppress async gRPC stream errors from crashing the process
    (workflowRuntime as any).on?.("error", (err: Error) => {
      console.warn(`[${AGENT_ID}] Workflow runtime stream error (continuing without workflow):`, err.message);
      workflowRuntime = null;
      workflowClient = null;
    });
    console.log(`[${AGENT_ID}] Workflow runtime started`);

    // Create workflow client
    workflowClient = createWorkflowClient();
    console.log(`[${AGENT_ID}] Workflow client initialized`);
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to initialize workflow runtime:`, error);
    // Continue without workflows - fall back to in-memory state
    workflowRuntime = null;
    workflowClient = null;
  }

  // Initialize MQTT client for Claude Code pod progress events
  if (MQTT_ENABLED) {
    try {
      console.log(`[${AGENT_ID}] Connecting to MQTT broker at ${MQTT_URL}`);
      mqttClient = mqtt.connect(MQTT_URL, {
        clientId: `${AGENT_ID}-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000,
      });

      mqttClient.on("connect", () => {
        console.log(`[${AGENT_ID}] MQTT connected, subscribing to agent/code/job/#`);
        mqttClient?.subscribe("agent/code/job/#", (err) => {
          if (err) {
            console.error(`[${AGENT_ID}] MQTT subscription failed:`, err);
          } else {
            console.log(`[${AGENT_ID}] MQTT subscribed to Claude Code pod progress events`);
          }
        });
      });

      mqttClient.on("message", (topic, message) => {
        try {
          const progress: CodePodProgress = JSON.parse(message.toString());
          console.log(`[${AGENT_ID}] Code pod progress: jobId=${progress.jobId} status=${progress.status}`);

          // Find project by jobId in metadata
          for (const project of projects.values()) {
            if (project.metadata?.jobId === progress.jobId) {
              console.log(`[${AGENT_ID}] Matched progress to project ${project.id} - ${project.title}`);

              // Update project metadata with latest progress
              if (!project.metadata) {
                project.metadata = {};
              }
              project.metadata.lastCodePodProgress = progress;
              project.updatedAt = new Date().toISOString();
              projects.set(project.id, project);

              // Add comment to issue if available
              if (project.issueNumber && progress.status === "completed") {
                const comment = `✅ **Claude Code Pod Completed**\n\nJob ID: ${progress.jobId}\n${progress.details}`;
                if (project.platform === "github") {
                  addGitHubComment(project.repoOwner, project.repoName, project.issueNumber, comment)
                    .catch(err => console.warn(`[${AGENT_ID}] Failed to add GitHub comment:`, err));
                }
              } else if (project.issueNumber && progress.status === "failed") {
                const comment = `❌ **Claude Code Pod Failed**\n\nJob ID: ${progress.jobId}\n${progress.details}`;
                if (project.platform === "github") {
                  addGitHubComment(project.repoOwner, project.repoName, project.issueNumber, comment)
                    .catch(err => console.warn(`[${AGENT_ID}] Failed to add GitHub comment:`, err));
                }
              }

              break;
            }
          }
        } catch (error) {
          console.error(`[${AGENT_ID}] Failed to process MQTT message:`, error);
        }
      });

      mqttClient.on("error", (error) => {
        console.error(`[${AGENT_ID}] MQTT error:`, error);
      });

      mqttClient.on("offline", () => {
        console.warn(`[${AGENT_ID}] MQTT client offline, will attempt reconnect`);
      });

      mqttClient.on("reconnect", () => {
        console.log(`[${AGENT_ID}] MQTT reconnecting...`);
      });
    } catch (error) {
      console.warn(`[${AGENT_ID}] MQTT initialization failed (continuing without MQTT):`, error);
      mqttClient = null;
    }
  } else {
    console.log(`[${AGENT_ID}] MQTT disabled via MQTT_ENABLED=false`);
  }

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

  // Stop workflow runtime
  if (workflowRuntime) {
    try {
      console.log(`[${AGENT_ID}] Stopping workflow runtime`);
      await workflowRuntime.stop();
      console.log(`[${AGENT_ID}] Workflow runtime stopped`);
    } catch (error) {
      console.error(`[${AGENT_ID}] Failed to stop workflow runtime:`, error);
    }
  }

  // Disconnect MQTT client
  if (mqttClient) {
    try {
      console.log(`[${AGENT_ID}] Disconnecting MQTT client`);
      await mqttClient.endAsync();
      console.log(`[${AGENT_ID}] MQTT client disconnected`);
    } catch (error) {
      console.error(`[${AGENT_ID}] Failed to disconnect MQTT:`, error);
    }
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

// Catch async gRPC stream errors from @dapr/durabletask-js WorkflowRuntime.
// These occur when the Dapr runtime version doesn't fully support the Workflow gRPC API
// used by the SDK. Rather than crashing, we degrade gracefully to non-workflow mode.
process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  if (msg.includes("UNIMPLEMENTED") || msg.includes("grpc") || msg.includes("durabletask")) {
    console.warn(`[${AGENT_ID}] Workflow gRPC error (Dapr runtime/SDK version mismatch) — continuing in non-workflow mode:`, msg.slice(0, 200));
    workflowRuntime = null;
    workflowClient = null;
  } else {
    // Re-throw non-workflow unhandled rejections
    console.error(`[${AGENT_ID}] Unhandled rejection:`, reason);
    process.exit(1);
  }
});

start().catch((error) => {
  console.error(`[${AGENT_ID}] Failed to start:`, error);
  process.exit(1);
});
