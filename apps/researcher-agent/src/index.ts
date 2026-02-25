import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { generateObject, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
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
const AGENT_ID = process.env.AGENT_ID || "researcher-agent";
const AGENT_NAME = process.env.AGENT_NAME || "Researcher Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// LLM Provider Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

// Default models per provider
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || "phi4-mini";
const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// --- LLM Providers ---
// LiteLLM for Ollama and other OpenAI-compatible endpoints
const litellm = createOpenAI({
  baseURL: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
});

// Direct Anthropic provider (when API key is available)
const anthropic = ANTHROPIC_API_KEY
  ? createAnthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

// Google Gemini provider (when API key is available)
const google = GOOGLE_API_KEY
  ? createGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY })
  : null;

// --- Provider Selection ---
type ProviderType = "ollama" | "claude" | "gemini" | "auto";

function getModel(provider: ProviderType, taskComplexity: "low" | "medium" | "high" = "medium") {
  switch (provider) {
    case "claude":
      if (anthropic) {
        return anthropic(DEFAULT_CLAUDE_MODEL);
      }
      // Fall back to LiteLLM with Anthropic routing
      return litellm(`anthropic/${DEFAULT_CLAUDE_MODEL}`);

    case "gemini":
      if (google) {
        return google(DEFAULT_GEMINI_MODEL);
      }
      // Fall back to LiteLLM with Google routing
      return litellm(`google/${DEFAULT_GEMINI_MODEL}`);

    case "ollama":
      return litellm(`ollama/${DEFAULT_OLLAMA_MODEL}`);

    case "auto":
    default:
      // Auto-select based on task complexity
      if (taskComplexity === "high" && anthropic) {
        return anthropic(DEFAULT_CLAUDE_MODEL);
      } else if (taskComplexity === "medium" && google) {
        return google(DEFAULT_GEMINI_MODEL);
      }
      // Default to Ollama for quick/private tasks
      return litellm(`ollama/${DEFAULT_OLLAMA_MODEL}`);
  }
}

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
export const ResearchResultSchema = z.object({
  summary: z.string().describe("Executive summary of the research findings"),
  keyFindings: z.array(z.object({
    finding: z.string().describe("Key finding or insight"),
    confidence: z.enum(["high", "medium", "low"]).describe("Confidence level"),
    sources: z.array(z.string()).describe("Sources supporting this finding"),
  })),
  analysis: z.object({
    context: z.string().describe("Background context for the research"),
    methodology: z.string().describe("How the research was conducted"),
    limitations: z.array(z.string()).describe("Limitations of the research"),
  }),
  recommendations: z.array(z.object({
    recommendation: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    rationale: z.string(),
  })),
  relatedTopics: z.array(z.string()).describe("Related topics for further research"),
  sources: z.array(z.object({
    title: z.string(),
    url: z.string().optional(),
    type: z.enum(["documentation", "article", "repository", "forum", "other"]),
    relevance: z.string(),
  })),
  metadata: z.object({
    researchType: z.string(),
    provider: z.string().describe("LLM provider used"),
    duration: z.string().optional(),
  }),
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;

// --- Research Request Schema ---
export const ResearchRequestSchema = z.object({
  query: z.string().describe("The research question or topic"),
  type: z.enum(["deep-research", "market-analysis", "technical-research"]).default("technical-research"),
  context: z.record(z.string(), z.unknown()).optional(),
  userId: z.string().optional(),
  provider: z.enum(["ollama", "claude", "gemini", "auto"]).default("auto"),
  requireStructured: z.boolean().default(true),
  depth: z.enum(["quick", "standard", "comprehensive"]).default("standard"),
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "deep-research",
      weight: 0.9,
      preferred: true,
      requirements: [],
      estimatedDuration: "2m-10m",
    },
    {
      name: "market-analysis",
      weight: 0.85,
      preferred: false,
      requirements: [],
      estimatedDuration: "3m-15m",
    },
    {
      name: "technical-research",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "1m-5m",
    },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "research-analysis",
    providers: ["ollama", "claude", "gemini"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Researcher Agent for the mesh-six agent mesh. Your role is to conduct thorough research and provide well-sourced, actionable insights.

## Your Capabilities
- Deep research on technical topics, software, and infrastructure
- Market analysis for tools, services, and technologies
- Technical research for implementation guidance
- Multi-source synthesis and analysis

## Research Methodology
1. Understand the research question and context
2. Search past research and memory for relevant prior findings
3. Use available tools to gather current information
4. Synthesize findings from multiple sources
5. Identify key insights and recommendations
6. Note limitations and confidence levels
7. Store findings in memory for future reference

## Quality Standards
- Always cite sources and note confidence levels
- Distinguish between facts, opinions, and speculation
- Identify gaps in available information
- Provide actionable recommendations when possible
- Consider the homelab/self-hosted context

## Environment Context
- This runs on a 6-node k3s cluster
- Preference for self-hosted, open-source solutions
- Cost-consciousness is important
- Integration with existing infrastructure (Dapr, ArgoCD, PostgreSQL, Redis)

When providing research:
- Be thorough but concise
- Prioritize actionable insights
- Note when information may be outdated
- Suggest follow-up research if needed`;

// --- Tool Definitions ---
const tools = {
  search_web: tool({
    description: "Search the web for current information on a topic",
    parameters: z.object({
      query: z.string().describe("Search query"),
      focus: z.enum(["general", "news", "technical", "academic"]).default("technical"),
    }),
    execute: async ({ query, focus }) => {
      console.log(`[${AGENT_ID}] Web search: "${query}" (focus: ${focus})`);

      // In production, this would call a search API (SearXNG, Brave, etc.)
      // For now, return simulated results
      return {
        query,
        focus,
        results: [
          {
            title: `Search results for: ${query}`,
            snippet: "Simulated search result - integrate with SearXNG or Brave Search API",
            url: "https://example.com",
          },
        ],
        note: "Web search integration pending - showing placeholder",
        timestamp: new Date().toISOString(),
      };
    },
  }),

  search_documentation: tool({
    description: "Search official documentation for a technology or library",
    parameters: z.object({
      technology: z.string().describe("Technology or library name"),
      topic: z.string().describe("Specific topic to search for"),
    }),
    execute: async ({ technology, topic }) => {
      console.log(`[${AGENT_ID}] Doc search: ${technology} - ${topic}`);

      // In production, this could scrape docs or use a docs API
      return {
        technology,
        topic,
        results: [],
        note: "Documentation search integration pending",
        timestamp: new Date().toISOString(),
      };
    },
  }),

  analyze_repository: tool({
    description: "Analyze a GitHub/Gitea repository for insights",
    parameters: z.object({
      repoUrl: z.string().describe("Repository URL"),
      aspects: z.array(z.enum(["readme", "structure", "activity", "issues", "releases"])).default(["readme", "activity"]),
    }),
    execute: async ({ repoUrl, aspects }) => {
      console.log(`[${AGENT_ID}] Analyzing repo: ${repoUrl}, aspects: ${aspects.join(", ")}`);

      // In production, this would use GitHub/Gitea API
      return {
        repoUrl,
        aspects,
        analysis: {
          note: "Repository analysis integration pending - use GitHub/Gitea API",
        },
        timestamp: new Date().toISOString(),
      };
    },
  }),

  search_past_research: tool({
    description: "Search memory for past research findings on related topics",
    parameters: z.object({
      query: z.string().describe("Search query for past research"),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      console.log(`[${AGENT_ID}] Searching past research: "${query}"`);

      if (!memory) {
        return { results: [], note: "Memory layer not available" };
      }

      try {
        const results = await memory.search(query, "researcher", limit);
        return {
          results: results.map((r) => ({
            finding: r.memory,
            score: r.score,
            createdAt: r.createdAt,
          })),
          count: results.length,
        };
      } catch (error) {
        return { error: `Failed to search memory: ${error}` };
      }
    },
  }),

  compare_technologies: tool({
    description: "Compare multiple technologies or solutions",
    parameters: z.object({
      technologies: z.array(z.string()).describe("List of technologies to compare"),
      criteria: z.array(z.string()).describe("Comparison criteria"),
    }),
    execute: async ({ technologies, criteria }) => {
      console.log(`[${AGENT_ID}] Comparing: ${technologies.join(" vs ")} on ${criteria.join(", ")}`);

      // This tool triggers the LLM to do the comparison
      return {
        technologies,
        criteria,
        note: "Comparison will be synthesized by the LLM based on available knowledge",
        timestamp: new Date().toISOString(),
      };
    },
  }),
};

// --- HTTP Server (Hono) ---
const app = new Hono();

// Health endpoint
app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
    providers: {
      anthropic: !!ANTHROPIC_API_KEY,
      google: !!GOOGLE_API_KEY,
      litellm: true,
    },
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
  ];
  return c.json(subscriptions);
});

// --- Main Research Endpoint (Service Invocation) ---
app.post("/research", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = ResearchRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] Research request: "${request.query.substring(0, 100)}..." (${request.type})`);

    const result = await handleResearch(request);

    const durationMs = Date.now() - startTime;
    console.log(`[${AGENT_ID}] Research completed in ${durationMs}ms`);

    return c.json({
      success: true,
      result,
      durationMs,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Research failed:`, error);
    return c.json(
      {
        success: false,
        error: String(error),
        agentId: AGENT_ID,
      },
      500
    );
  }
});

// --- Generic Invocation Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const validCapabilities = ["deep-research", "market-analysis", "technical-research"];
  if (validCapabilities.includes(body.capability)) {
    const request: ResearchRequest = {
      query: body.payload?.query || body.payload?.question || JSON.stringify(body.payload),
      type: body.capability as ResearchRequest["type"],
      context: body.payload?.context,
      userId: body.payload?.userId || body.requestedBy,
      provider: body.payload?.provider || "auto",
      requireStructured: body.payload?.requireStructured ?? true,
      depth: body.payload?.depth || "standard",
    };

    const result = await handleResearch(request);

    return c.json({
      taskId: body.id || crypto.randomUUID(),
      agentId: AGENT_ID,
      success: true,
      result: { research: result },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    } satisfies TaskResult);
  }

  return c.json({ error: "Unknown capability" }, 400);
});

// --- Task Handler (Pub/Sub) ---
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id} - ${task.capability}`);

  try {
    const request: ResearchRequest = {
      query: typeof task.payload.query === "string"
        ? task.payload.query
        : JSON.stringify(task.payload),
      type: task.capability as ResearchRequest["type"],
      context: task.payload.context as Record<string, unknown> | undefined,
      userId: typeof task.payload.userId === "string" ? task.payload.userId : task.requestedBy,
      provider: (task.payload.provider as ProviderType) || "auto",
      requireStructured: task.payload.requireStructured !== false,
      depth: (task.payload.depth as ResearchRequest["depth"]) || "standard",
    };

    const result = await handleResearch(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { research: result },
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
      error: { type: "research_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Research Handler ---
async function handleResearch(request: ResearchRequest): Promise<ResearchResult | string> {
  const { query, type, context, userId, provider, requireStructured, depth } = request;
  const userIdResolved = userId || "researcher";
  const startTime = Date.now();

  // Determine task complexity for auto provider selection
  const complexity: "low" | "medium" | "high" =
    depth === "comprehensive" ? "high" :
    depth === "quick" ? "low" : "medium";

  const model = getModel(provider, complexity);
  const providerName = provider === "auto" ? `auto->${complexity}` : provider;

  // Build enhanced prompt with past research
  let enhancedPrompt = SYSTEM_PROMPT;

  if (memory) {
    try {
      const pastResearch = await memory.search(query, userIdResolved, 5);

      if (pastResearch.length > 0) {
        const researchContext = pastResearch
          .map((r) => `- ${r.memory}`)
          .join("\n");

        enhancedPrompt += `\n\n## Relevant Past Research\n${researchContext}`;
        console.log(`[${AGENT_ID}] Found ${pastResearch.length} relevant past research items`);
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Add context if provided
  if (context && Object.keys(context).length > 0) {
    enhancedPrompt += `\n\n## Additional Context\n${JSON.stringify(context, null, 2)}`;
  }

  // Add research type guidance
  enhancedPrompt += `\n\n## Research Type: ${type}`;
  switch (type) {
    case "deep-research":
      enhancedPrompt += "\nConduct thorough, comprehensive research with multiple sources.";
      break;
    case "market-analysis":
      enhancedPrompt += "\nFocus on market landscape, competitors, pricing, and trends.";
      break;
    case "technical-research":
      enhancedPrompt += "\nFocus on implementation details, code examples, and technical specifications.";
      break;
  }

  let result: ResearchResult | string;
  const traceId = crypto.randomUUID();

  const traceCtx = eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null;

  if (requireStructured) {
    // Step 1: Gather information with tools
    const { text: researchAnalysis } = await tracedGenerateText(
      {
        model,
        system: enhancedPrompt,
        prompt: `Research this topic thoroughly using available tools. Depth: ${depth}

Topic: ${query}`,
        tools,
        maxSteps: depth === "comprehensive" ? 8 : depth === "quick" ? 3 : 5,
      },
      traceCtx
    );

    // Step 2: Generate structured output
    const { object } = await generateObject({
      model,
      schema: ResearchResultSchema,
      system: enhancedPrompt,
      prompt: `Based on the following research analysis, provide a structured research result.

Research Analysis:
${researchAnalysis}

Original Query:
${query}

Research Type: ${type}`,
    });

    // Add metadata
    object.metadata = {
      researchType: type,
      provider: providerName,
      duration: `${Date.now() - startTime}ms`,
    };

    result = object;
  } else {
    // Generate free-form research with tools
    const { text } = await tracedGenerateText(
      {
        model,
        system: enhancedPrompt,
        prompt: `Research this topic: ${query}`,
        tools,
        maxSteps: depth === "comprehensive" ? 8 : depth === "quick" ? 3 : 5,
      },
      traceCtx
    );

    result = text;
  }

  // Store research in memory
  if (memory) {
    try {
      const summaryText = typeof result === "string"
        ? result
        : `Research on "${query}": ${result.summary}. Key findings: ${result.keyFindings.map(f => f.finding).join("; ")}`;

      await memory.store(
        [
          { role: "user", content: query },
          { role: "assistant", content: summaryText },
        ],
        userIdResolved,
        {
          type: "research",
          researchType: type,
          provider: providerName,
          timestamp: new Date().toISOString(),
        }
      );
      console.log(`[${AGENT_ID}] Stored research in memory`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Failed to store in memory:`, error);
    }
  }

  return result;
}

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

  // Log provider status
  console.log(`[${AGENT_ID}] Provider status:`, {
    anthropic: !!ANTHROPIC_API_KEY,
    google: !!GOOGLE_API_KEY,
    litellm: true,
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
