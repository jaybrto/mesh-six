import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { z } from "zod";
import { Pool } from "pg";
import {
  AgentRegistry,
  AgentMemory,
  createAgentMemoryFromEnv,
  EventLog,
  tracedChatCompletion,
  chatCompletionWithSchema,
  tool,
  DAPR_PUBSUB_NAME,
  TASK_RESULTS_TOPIC,
  type AgentRegistration,
  type TaskRequest,
  type TaskResult,
  type DaprPubSubMessage,
  type DaprSubscription,
} from "@mesh-six/core";

// --- Configuration ---
const AGENT_ID = process.env.AGENT_ID || "architect-agent";
const AGENT_NAME = process.env.AGENT_NAME || "Architect Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// Kubernetes/Grafana configuration
const GRAFANA_URL = process.env.GRAFANA_URL || "http://grafana.monitoring:3000";
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY || "";
// K8S_API_URL will be used when k8s client integration is implemented
// const K8S_API_URL = process.env.K8S_API_URL || "https://kubernetes.default.svc";

// --- LLM Provider ---

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
export const ArchitectureRecommendationSchema = z.object({
  summary: z.string().describe("Brief summary of the recommendation"),
  techStack: z.object({
    primary: z.string().describe("Primary technology choice"),
    supporting: z.array(z.string()).describe("Supporting technologies"),
    reasoning: z.string().describe("Why this stack was chosen"),
  }),
  deploymentStrategy: z.object({
    approach: z.enum(["argocd-gitops", "kubectl-direct", "helm", "kustomize"]),
    reasoning: z.string().describe("Why this deployment approach"),
    steps: z.array(z.string()).describe("High-level deployment steps"),
  }),
  architecture: z.object({
    pattern: z.string().describe("Architectural pattern (e.g., microservices, monolith, event-driven)"),
    components: z.array(z.object({
      name: z.string(),
      purpose: z.string(),
      technology: z.string(),
    })),
    communication: z.string().describe("How components communicate"),
  }),
  considerations: z.object({
    pros: z.array(z.string()),
    cons: z.array(z.string()),
    risks: z.array(z.string()),
    mitigations: z.array(z.string()),
  }),
  alternatives: z.array(z.object({
    name: z.string(),
    description: z.string(),
    whyNotChosen: z.string(),
  })),
  confidence: z.number().min(0).max(1).describe("Confidence level in recommendation (0-1)"),
  estimatedEffort: z.string().describe("Estimated implementation effort"),
  prerequisites: z.array(z.string()).describe("Prerequisites before implementation"),
});

export type ArchitectureRecommendation = z.infer<typeof ArchitectureRecommendationSchema>;

// --- Consultation Request Schema ---
export const ConsultRequestSchema = z.object({
  question: z.string().describe("The architectural question or task description"),
  context: z.record(z.string(), z.unknown()).optional().describe("Additional context"),
  userId: z.string().optional().describe("User ID for memory retrieval"),
  requireStructured: z.boolean().default(true).describe("Whether to return structured recommendation"),
});

export type ConsultRequest = z.infer<typeof ConsultRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "tech-consultation",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "30s-2m",
    },
    {
      name: "architecture-review",
      weight: 0.9,
      preferred: true,
      requirements: [],
      estimatedDuration: "1m-5m",
    },
  ],
  status: "online",
  healthChecks: {
    grafana: `${GRAFANA_URL}/api/health`,
  },
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "infrastructure-architecture",
    environment: "homelab-k3s",
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Architect Agent for the mesh-six agent mesh. Your role is to provide expert architectural guidance for software and infrastructure decisions.

## Your Environment
- 6-node k3s cluster running on mixed hardware
- ArgoCD for GitOps deployments
- Dapr for service mesh and communication
- RabbitMQ for messaging (pub/sub)
- PostgreSQL HA (3-pod CloudNativePG) with pgvector
- Redis Cluster for caching and state
- Grafana LGTM stack for observability (Loki, Grafana, Tempo, Mimir)
- LiteLLM as LLM gateway (Anthropic Claude, Ollama local models)
- Cloudflare Tunnel + Caddy for external access
- OPNsense firewall with HAProxy

## Preferences (from past decisions)
- **Language**: Bun/TypeScript for new services (fastest iteration). Go for performance-critical extractions.
- **Framework**: Hono for HTTP servers, Vercel AI SDK for LLM integration
- **Communication**: Dapr sidecars for all inter-service communication
- **Database**: PostgreSQL via CloudNativePG operator. Uses \`pg\` package (not porsager) for PgBouncer compatibility.
- **State**: Redis for ephemeral state, PostgreSQL for durable state
- **Observability**: OpenTelemetry to Grafana LGTM stack
- **Deployment**: ArgoCD GitOps with kustomize overlays
- **Security**: mTLS via Dapr, secrets in k8s secrets (Vault migration planned)
- **Resource efficiency**: Prefers lightweight solutions; avoids heavyweight Java/Spring stack

## Decision Framework
1. Always consider existing infrastructure and patterns
2. Prefer solutions that integrate with Dapr ecosystem
3. Evaluate operational complexity vs benefits
4. Consider resource constraints (homelab, not cloud-scale)
5. Document reasoning for future reference
6. Identify risks and mitigation strategies

When providing recommendations:
- Be specific to the homelab environment
- Reference past decisions when relevant
- Explain trade-offs clearly
- Provide actionable steps
- Estimate effort realistically

You have tools to query the current cluster state, service health, and past architectural decisions. Use them to inform your recommendations.`;

// --- Tool Definitions ---
const tools = {
  query_cluster_state: tool({
    description: "Query Kubernetes cluster for current state: namespaces, deployments, services, and resource usage",
    parameters: z.object({
      namespace: z.string().optional().describe("Specific namespace to query, or all if omitted"),
      resourceType: z.enum(["deployments", "services", "pods", "all"]).default("all"),
    }),
    execute: async ({ namespace, resourceType }) => {
      console.log(`[${AGENT_ID}] Querying cluster state: namespace=${namespace}, type=${resourceType}`);

      // In production, this would call k8s API
      // For now, we simulate with Dapr state or direct k8s client
      try {
        // TODO: Use namespace and resourceType to query actual k8s API
        // This would be replaced with actual k8s API calls
        // Using kubectl via exec or @kubernetes/client-node
        const clusterInfo = {
          timestamp: new Date().toISOString(),
          namespaces: ["mesh-six", "default", "monitoring", "argocd", "litellm", "redis", "rabbitmq"],
          summary: `Cluster state queried for ${namespace || "all namespaces"} (${resourceType})`,
          note: "Full k8s integration pending - showing cached/sample data",
        };

        return clusterInfo;
      } catch (error) {
        return { error: `Failed to query cluster: ${error}` };
      }
    },
  }),

  query_service_health: tool({
    description: "Query Grafana/Prometheus for service health metrics and recent alerts",
    parameters: z.object({
      service: z.string().describe("Service name to check health for"),
      timeRange: z.string().default("1h").describe("Time range for metrics (e.g., 1h, 6h, 24h)"),
    }),
    execute: async ({ service, timeRange }) => {
      console.log(`[${AGENT_ID}] Querying health for service: ${service}, range: ${timeRange}`);

      // In production, this would query Grafana/Prometheus API
      try {
        if (!GRAFANA_API_KEY) {
          return {
            service,
            status: "unknown",
            note: "Grafana API key not configured",
            timestamp: new Date().toISOString(),
          };
        }

        // Query Grafana API for service health
        const healthData = {
          service,
          status: "healthy",
          uptime: "99.9%",
          latencyP50: "12ms",
          latencyP99: "45ms",
          errorRate: "0.01%",
          recentAlerts: [],
          timestamp: new Date().toISOString(),
          note: "Full Grafana integration pending",
        };

        return healthData;
      } catch (error) {
        return { error: `Failed to query health: ${error}` };
      }
    },
  }),

  query_past_decisions: tool({
    description: "Search memory for past architectural decisions and their outcomes",
    parameters: z.object({
      query: z.string().describe("Search query for past decisions"),
      limit: z.number().default(5).describe("Maximum number of results"),
    }),
    execute: async ({ query, limit }) => {
      console.log(`[${AGENT_ID}] Searching past decisions: "${query}"`);

      if (!memory) {
        return {
          results: [],
          note: "Memory layer not available",
        };
      }

      try {
        const results = await memory.search(query, "architect", limit);
        return {
          results: results.map((r) => ({
            memory: r.memory,
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

  query_resource_usage: tool({
    description: "Get cluster resource usage: CPU, memory, storage across nodes",
    parameters: z.object({
      nodeFilter: z.string().optional().describe("Filter to specific node"),
    }),
    execute: async ({ nodeFilter }) => {
      console.log(`[${AGENT_ID}] Querying resource usage: node=${nodeFilter || "all"}`);

      // In production, query k8s metrics or Prometheus
      try {
        const usage = {
          timestamp: new Date().toISOString(),
          nodes: [
            { name: "k3s-master-1", cpu: "45%", memory: "62%", storage: "38%" },
            { name: "k3s-worker-1", cpu: "52%", memory: "71%", storage: "42%" },
            { name: "k3s-worker-2", cpu: "38%", memory: "55%", storage: "35%" },
          ],
          cluster: {
            totalCPU: "24 cores",
            usedCPU: "45%",
            totalMemory: "96GB",
            usedMemory: "62%",
            totalStorage: "2TB",
            usedStorage: "38%",
          },
          note: "Full metrics integration pending",
        };

        return nodeFilter
          ? { ...usage, nodes: usage.nodes.filter((n) => n.name.includes(nodeFilter)) }
          : usage;
      } catch (error) {
        return { error: `Failed to query resources: ${error}` };
      }
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
  })
);

// Readiness endpoint
app.get("/readyz", (c) => c.json({ status: "ok" }));

// Dapr pub/sub subscription endpoint
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

// --- Main Consultation Endpoint (Service Invocation) ---
app.post("/consult", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = ConsultRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] Consultation request: "${request.question.substring(0, 100)}..."`);

    const result = await handleConsultation(request);

    const durationMs = Date.now() - startTime;
    console.log(`[${AGENT_ID}] Consultation completed in ${durationMs}ms`);

    return c.json({
      success: true,
      result,
      durationMs,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Consultation failed:`, error);
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

  // Route based on capability
  if (body.capability === "tech-consultation" || body.capability === "architecture-review") {
    const request: ConsultRequest = {
      question: body.payload?.query || body.payload?.question || JSON.stringify(body.payload),
      context: body.payload?.context,
      userId: body.payload?.userId || body.requestedBy,
      requireStructured: body.payload?.requireStructured ?? true,
    };

    const recommendation = await handleConsultation(request);

    return c.json({
      taskId: body.id || crypto.randomUUID(),
      agentId: AGENT_ID,
      success: true,
      result: { recommendation },
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
    const request: ConsultRequest = {
      question: typeof task.payload.query === "string"
        ? task.payload.query
        : typeof task.payload.question === "string"
        ? task.payload.question
        : JSON.stringify(task.payload),
      context: task.payload.context as Record<string, unknown> | undefined,
      userId: typeof task.payload.userId === "string" ? task.payload.userId : task.requestedBy,
      requireStructured: task.payload.requireStructured !== false,
    };

    const result = await handleConsultation(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { recommendation: result },
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
      error: { type: "consultation_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" }); // ACK to Dapr even on failure
  }
});

// --- Core Consultation Handler ---
async function handleConsultation(
  request: ConsultRequest
): Promise<ArchitectureRecommendation | string> {
  const { question, context, userId, requireStructured } = request;
  const userIdResolved = userId || "architect";

  // Build system prompt with past decisions from memory
  let enhancedPrompt = SYSTEM_PROMPT;

  if (memory) {
    try {
      const pastDecisions = await memory.search(question, userIdResolved, 5);

      if (pastDecisions.length > 0) {
        const decisionsContext = pastDecisions
          .map((d) => `- ${d.memory}`)
          .join("\n");

        enhancedPrompt += `\n\n## Relevant Past Decisions\n${decisionsContext}`;
        console.log(`[${AGENT_ID}] Found ${pastDecisions.length} relevant past decisions`);
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Add context if provided
  if (context && Object.keys(context).length > 0) {
    enhancedPrompt += `\n\n## Additional Context\n${JSON.stringify(context, null, 2)}`;
  }

  let recommendation: ArchitectureRecommendation | string;
  const traceId = crypto.randomUUID();

  const traceCtx = eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null;

  if (requireStructured) {
    // Step 1: Use tools to gather context and analysis
    const { text: toolAnalysis } = await tracedChatCompletion(
      {
        model: LLM_MODEL,
        system: enhancedPrompt,
        prompt: `Analyze this architectural question and gather any relevant information using available tools. Then provide your analysis.

Question: ${question}`,
      },
      traceCtx
    );

    // Step 2: Generate structured recommendation using the analysis
    const { object } = await chatCompletionWithSchema({
      model: LLM_MODEL,
      schema: ArchitectureRecommendationSchema,
      system: enhancedPrompt,
      prompt: `Based on the following analysis, provide a structured architectural recommendation.

Analysis and Tool Results:
${toolAnalysis}

Original Question:
${question}`,
    });

    recommendation = object;
  } else {
    // Generate free-form text response with tool use
    const { text } = await tracedChatCompletion(
      {
        model: LLM_MODEL,
        system: enhancedPrompt,
        prompt: question,
      },
      traceCtx
    );

    recommendation = text;
  }

  // Store the decision in memory for future reference
  if (memory) {
    try {
      const summaryText = typeof recommendation === "string"
        ? recommendation
        : `Recommendation for "${question}": ${recommendation.summary}. ` +
          `Tech stack: ${recommendation.techStack.primary}. ` +
          `Deployment: ${recommendation.deploymentStrategy.approach}. ` +
          `Confidence: ${recommendation.confidence}`;

      await memory.store(
        [
          { role: "user", content: question },
          { role: "assistant", content: summaryText },
        ],
        userIdResolved,
        {
          type: "architectural-decision",
          structured: requireStructured,
          timestamp: new Date().toISOString(),
        }
      );
      console.log(`[${AGENT_ID}] Stored decision in memory`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Failed to store in memory:`, error);
    }
  }

  return recommendation;
}

// --- Lifecycle ---
let heartbeatInterval: Timer | null = null;

async function start(): Promise<void> {
  // Initialize memory if enabled
  if (MEMORY_ENABLED) {
    try {
      memory = createAgentMemoryFromEnv(AGENT_ID);
      console.log(`[${AGENT_ID}] Memory layer initialized`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory initialization failed, running without memory:`, error);
      memory = null;
    }
  }

  // Register with agent registry
  await registry.register(REGISTRATION);
  console.log(`[${AGENT_ID}] Registered in agent registry`);

  // Start heartbeat interval (every 30s)
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
