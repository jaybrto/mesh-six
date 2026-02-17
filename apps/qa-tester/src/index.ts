import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { generateObject, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { Pool } from "pg";
import {
  AgentRegistry,
  AgentMemory,
  createAgentMemoryFromEnv,
  EventLog,
  tracedGenerateText,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
} from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "qa-tester";
const AGENT_NAME = process.env.AGENT_NAME || "QA Tester Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// LLM Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";

// --- LLM Provider ---
const llm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
});

// --- Dapr Client ---
const daprClient = new DaprClient({ daprHost: DAPR_HOST, daprPort: DAPR_HTTP_PORT });
const registry = new AgentRegistry(daprClient);

// --- Memory Layer ---
let memory: AgentMemory | null = null;

// --- Event Log ---
let eventLog: EventLog | null = null;
if (DATABASE_URL) {
  const pool = new Pool({ connectionString: DATABASE_URL });
  eventLog = new EventLog(pool);
  console.log(`[${AGENT_ID}] Event log initialized`);
}

// --- Structured Output Schemas ---
export const TestPlanSchema = z.object({
  summary: z.string().describe("Overview of the test plan"),
  scope: z.object({
    features: z.array(z.string()).describe("Features to be tested"),
    outOfScope: z.array(z.string()).describe("Features explicitly not tested"),
  }),
  testCases: z.array(z.object({
    id: z.string().describe("Test case ID (e.g., TC-001)"),
    name: z.string().describe("Test case name"),
    type: z.enum(["unit", "integration", "e2e", "visual", "performance", "accessibility"]),
    priority: z.enum(["critical", "high", "medium", "low"]),
    description: z.string(),
    preconditions: z.array(z.string()),
    steps: z.array(z.object({
      action: z.string(),
      expectedResult: z.string(),
    })),
    testData: z.record(z.string(), z.unknown()).optional(),
  })),
  automationStrategy: z.object({
    framework: z.enum(["playwright", "cypress", "puppeteer", "selenium", "vitest", "jest"]),
    reasoning: z.string(),
    patterns: z.array(z.string()).describe("Recommended patterns (POM, fixtures, etc.)"),
  }),
  coverage: z.object({
    estimated: z.string().describe("Estimated test coverage"),
    criticalPaths: z.array(z.string()),
  }),
  risks: z.array(z.object({
    risk: z.string(),
    mitigation: z.string(),
  })),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

export const TestCodeSchema = z.object({
  framework: z.string().describe("Testing framework used"),
  language: z.enum(["typescript", "javascript"]),
  files: z.array(z.object({
    path: z.string().describe("File path relative to test directory"),
    content: z.string().describe("File content"),
    description: z.string(),
  })),
  dependencies: z.array(z.object({
    name: z.string(),
    version: z.string(),
    dev: z.boolean(),
  })),
  setupInstructions: z.array(z.string()),
  runCommands: z.object({
    all: z.string().describe("Command to run all tests"),
    watch: z.string().optional(),
    ci: z.string().optional(),
  }),
});
export type TestCode = z.infer<typeof TestCodeSchema>;

export const TestAnalysisSchema = z.object({
  summary: z.string(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  duration: z.string(),
  failures: z.array(z.object({
    testName: z.string(),
    error: z.string(),
    suggestion: z.string(),
    severity: z.enum(["critical", "major", "minor"]),
  })),
  flaky: z.array(z.string()).describe("Tests that may be flaky"),
  recommendations: z.array(z.string()),
  coverageGaps: z.array(z.string()),
});
export type TestAnalysis = z.infer<typeof TestAnalysisSchema>;

// --- Request Schema ---
export const QARequestSchema = z.object({
  action: z.enum([
    "create-test-plan",
    "generate-tests",
    "analyze-results",
    "review-coverage",
    "suggest-improvements",
  ]),
  context: z.object({
    projectType: z.enum(["web", "api", "mobile", "cli"]).optional(),
    framework: z.string().optional(),
    requirements: z.string().optional(),
    codebase: z.string().optional(),
    testResults: z.string().optional(),
    existingTests: z.string().optional(),
  }),
  preferences: z.object({
    testFramework: z.enum(["playwright", "cypress", "vitest", "jest"]).optional(),
    language: z.enum(["typescript", "javascript"]).default("typescript"),
  }).optional(),
});
export type QARequest = z.infer<typeof QARequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "test-planning",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "2m-5m",
    },
    {
      name: "test-generation",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "3m-10m",
    },
    {
      name: "test-analysis",
      weight: 0.9,
      preferred: true,
      requirements: [],
      estimatedDuration: "1m-3m",
    },
    {
      name: "qa-review",
      weight: 0.85,
      preferred: false,
      requirements: [],
      estimatedDuration: "2m-5m",
    },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "test-automation",
    frameworks: ["playwright", "cypress", "vitest", "jest", "puppeteer"],
    expertise: ["e2e-testing", "api-testing", "visual-testing", "accessibility"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the QA Tester Agent for Jay's homelab agent mesh. You specialize in test automation, quality assurance, and testing best practices.

## Your Expertise
- **Playwright**: E2E testing, visual regression, API testing, mobile emulation
- **Cypress**: Component testing, E2E testing, network stubbing
- **Vitest/Jest**: Unit testing, integration testing, mocking
- **Testing Patterns**: Page Object Model, Fixtures, Test Data Management
- **Accessibility**: WCAG compliance, screen reader testing, a11y audits
- **Performance**: Load testing, Core Web Vitals, Lighthouse audits

## Testing Philosophy
1. **Test Pyramid**: Prioritize unit tests, fewer integration tests, minimal E2E
2. **Fast Feedback**: Tests should run quickly and provide clear feedback
3. **Reliability**: Avoid flaky tests; prefer deterministic assertions
4. **Maintainability**: Use patterns that make tests easy to update
5. **Coverage**: Focus on critical paths and edge cases

## Playwright Best Practices
- Use \`page.getByRole()\`, \`page.getByText()\`, \`page.getByTestId()\` for resilient selectors
- Use \`expect(locator).toBeVisible()\` instead of arbitrary waits
- Implement Page Object Model for complex UIs
- Use fixtures for test data and authentication state
- Enable tracing for debugging failed tests
- Use \`test.describe\` for grouping related tests

## When Generating Tests
- Include setup and teardown
- Add meaningful test descriptions
- Handle async operations properly
- Include error scenarios
- Add accessibility checks where relevant
- Consider mobile viewports

## Environment Context
- This is for Jay's homelab with k3s cluster
- Preference for TypeScript
- Tests run in CI/CD via GitHub Actions or Gitea Actions
- Reports should be actionable`;

// --- Tool Definitions ---
const tools = {
  analyze_test_output: tool({
    description: "Parse and analyze test runner output (Playwright, Jest, Vitest)",
    parameters: z.object({
      output: z.string().describe("Raw test output from the test runner"),
      format: z.enum(["playwright", "jest", "vitest", "cypress"]).default("playwright"),
    }),
    execute: async ({ output, format }) => {
      console.log(`[${AGENT_ID}] Analyzing ${format} test output`);

      // Parse common patterns from test output
      const failedMatch = output.match(/(\d+)\s*failed/i);
      const passedMatch = output.match(/(\d+)\s*passed/i);
      const skippedMatch = output.match(/(\d+)\s*skipped/i);
      const durationMatch = output.match(/(\d+\.?\d*)\s*(s|ms|m)/i);

      return {
        format,
        parsed: {
          failed: failedMatch ? parseInt(failedMatch[1]) : 0,
          passed: passedMatch ? parseInt(passedMatch[1]) : 0,
          skipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
          duration: durationMatch ? `${durationMatch[1]}${durationMatch[2]}` : "unknown",
        },
        rawOutput: output.substring(0, 2000), // Truncate for context
      };
    },
  }),

  search_test_patterns: tool({
    description: "Search memory for past test patterns and solutions",
    parameters: z.object({
      query: z.string().describe("Search query for test patterns"),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      console.log(`[${AGENT_ID}] Searching test patterns: "${query}"`);

      if (!memory) {
        return { results: [], note: "Memory layer not available" };
      }

      try {
        const results = await memory.search(query, "qa-tester", limit);
        return {
          results: results.map((r) => ({
            pattern: r.memory,
            score: r.score,
          })),
          count: results.length,
        };
      } catch (error) {
        return { error: `Failed to search: ${error}` };
      }
    },
  }),

  get_framework_docs: tool({
    description: "Get documentation hints for testing frameworks",
    parameters: z.object({
      framework: z.enum(["playwright", "cypress", "vitest", "jest"]),
      topic: z.string().describe("Specific topic to look up"),
    }),
    execute: async ({ framework, topic }) => {
      console.log(`[${AGENT_ID}] Looking up ${framework} docs for: ${topic}`);

      // Return framework-specific hints
      const hints: Record<string, Record<string, string>> = {
        playwright: {
          selectors: "Use getByRole, getByText, getByTestId for resilient selectors",
          assertions: "Use expect(locator).toBeVisible(), toHaveText(), toHaveCount()",
          fixtures: "Define fixtures in playwright.config.ts or conftest files",
          debugging: "Use page.pause(), trace viewer, and headed mode",
        },
        vitest: {
          mocking: "Use vi.mock(), vi.spyOn(), vi.fn() for mocking",
          coverage: "Enable coverage with vitest --coverage",
          fixtures: "Use beforeEach, afterEach, and factory functions",
        },
        jest: {
          mocking: "Use jest.mock(), jest.spyOn(), jest.fn()",
          snapshots: "Use toMatchSnapshot() for UI testing",
          async: "Use async/await or done callback for async tests",
        },
        cypress: {
          commands: "Create custom commands in cypress/support/commands.ts",
          fixtures: "Store test data in cypress/fixtures/",
          intercept: "Use cy.intercept() for network stubbing",
        },
      };

      return {
        framework,
        topic,
        hints: hints[framework] || {},
        note: "Use official documentation for detailed API reference",
      };
    },
  }),
};

// --- HTTP Server ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
  })
);

app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr subscription
app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    {
      pubsubname: DAPR_PUBSUB_NAME,
      topic: `tasks.${AGENT_ID}`,
      route: "/tasks",
    },
  ];
  return c.json(subscriptions);
});

// --- Main QA Endpoint ---
app.post("/qa", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = QARequestSchema.parse(body);

    console.log(`[${AGENT_ID}] QA request: ${request.action}`);

    const result = await handleQARequest(request);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] QA request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Invoke Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const request: QARequest = {
    action: body.payload?.action || "create-test-plan",
    context: body.payload?.context || {},
    preferences: body.payload?.preferences,
  };

  const result = await handleQARequest(request);

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { qa: result },
    durationMs: 0,
    completedAt: new Date().toISOString(),
  } satisfies TaskResult);
});

// --- Task Handler ---
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id}`);

  try {
    const request: QARequest = {
      action: (task.payload.action as QARequest["action"]) || "create-test-plan",
      context: (task.payload.context as QARequest["context"]) || {},
      preferences: task.payload.preferences as QARequest["preferences"],
    };

    const result = await handleQARequest(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { qa: result },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, taskResult);
    return c.json({ status: "SUCCESS" });
  } catch (error) {
    console.error(`[${AGENT_ID}] Task failed:`, error);

    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "qa_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Handler ---
async function handleQARequest(request: QARequest): Promise<TestPlan | TestCode | TestAnalysis | string> {
  let enhancedPrompt = SYSTEM_PROMPT;

  // Add memory context
  if (memory) {
    try {
      const pastPatterns = await memory.search(
        `${request.action} ${request.context.framework || ""} ${request.context.projectType || ""}`,
        "qa-tester",
        3
      );
      if (pastPatterns.length > 0) {
        enhancedPrompt += `\n\n## Past Patterns\n${pastPatterns.map((p) => `- ${p.memory}`).join("\n")}`;
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Build context prompt
  const contextParts: string[] = [];
  if (request.context.projectType) contextParts.push(`Project Type: ${request.context.projectType}`);
  if (request.context.framework) contextParts.push(`Framework: ${request.context.framework}`);
  if (request.context.requirements) contextParts.push(`Requirements:\n${request.context.requirements}`);
  if (request.context.codebase) contextParts.push(`Codebase:\n${request.context.codebase}`);
  if (request.context.testResults) contextParts.push(`Test Results:\n${request.context.testResults}`);
  if (request.context.existingTests) contextParts.push(`Existing Tests:\n${request.context.existingTests}`);

  const contextPrompt = contextParts.length > 0 ? `\n\n## Context\n${contextParts.join("\n\n")}` : "";

  let result: TestPlan | TestCode | TestAnalysis | string;
  const traceId = crypto.randomUUID();
  const traceCtx = eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null;

  switch (request.action) {
    case "create-test-plan": {
      const { text: analysis } = await tracedGenerateText(
        {
          model: llm(LLM_MODEL),
          system: enhancedPrompt,
          prompt: `Create a comprehensive test plan for this project.${contextPrompt}`,
          tools,
          maxSteps: 3,
        },
        traceCtx
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: TestPlanSchema,
        system: enhancedPrompt,
        prompt: `Based on this analysis, create a structured test plan:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "generate-tests": {
      const framework = request.preferences?.testFramework || "playwright";
      const { text: analysis } = await tracedGenerateText(
        {
          model: llm(LLM_MODEL),
          system: enhancedPrompt,
          prompt: `Generate ${framework} tests for this project.${contextPrompt}\n\nPreferred language: ${request.preferences?.language || "typescript"}`,
          tools,
          maxSteps: 3,
        },
        traceCtx
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: TestCodeSchema,
        system: enhancedPrompt,
        prompt: `Based on this analysis, generate structured test code:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "analyze-results": {
      const { text: analysis } = await tracedGenerateText(
        {
          model: llm(LLM_MODEL),
          system: enhancedPrompt,
          prompt: `Analyze these test results and provide insights.${contextPrompt}`,
          tools,
          maxSteps: 3,
        },
        traceCtx
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: TestAnalysisSchema,
        system: enhancedPrompt,
        prompt: `Create a structured analysis:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    default: {
      const { text } = await tracedGenerateText(
        {
          model: llm(LLM_MODEL),
          system: enhancedPrompt,
          prompt: `${request.action}: ${contextPrompt}`,
          tools,
          maxSteps: 3,
        },
        traceCtx
      );
      result = text;
    }
  }

  // Store in memory
  if (memory) {
    try {
      const summary = typeof result === "string" ? result : JSON.stringify(result).substring(0, 500);
      await memory.store(
        [
          { role: "user", content: `${request.action}: ${JSON.stringify(request.context)}` },
          { role: "assistant", content: summary },
        ],
        "qa-tester",
        { action: request.action }
      );
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory store failed:`, error);
    }
  }

  return result;
}

// --- Lifecycle ---
let heartbeatInterval: Timer | null = null;

async function start(): Promise<void> {
  if (MEMORY_ENABLED) {
    try {
      memory = createAgentMemoryFromEnv(AGENT_ID);
      console.log(`[${AGENT_ID}] Memory layer initialized`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory initialization failed:`, error);
    }
  }

  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  heartbeatInterval = setInterval(async () => {
    try {
      await registry.heartbeat(AGENT_ID);
    } catch (error) {
      console.error(`[${AGENT_ID}] Heartbeat failed:`, error);
    }
  }, 30_000);

  Bun.serve({ port: APP_PORT, fetch: app.fetch });
  console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
}

async function shutdown(): Promise<void> {
  console.log(`[${AGENT_ID}] Shutting down...`);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
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
