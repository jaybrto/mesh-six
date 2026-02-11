import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { generateText, generateObject, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
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
const AGENT_ID = process.env.AGENT_ID || "argocd-deployer";
const AGENT_NAME = process.env.AGENT_NAME || "ArgoCD Deployer Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";

// LLM Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";

// ArgoCD Configuration
const ARGOCD_SERVER = process.env.ARGOCD_SERVER || "https://argocd.argocd:443";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN || "";
const ARGOCD_INSECURE = process.env.ARGOCD_INSECURE === "true";

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

// --- Structured Output Schemas ---
export const ApplicationStatusSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  project: z.string(),
  syncStatus: z.enum(["Synced", "OutOfSync", "Unknown"]),
  healthStatus: z.enum(["Healthy", "Progressing", "Degraded", "Suspended", "Missing", "Unknown"]),
  revision: z.string().optional(),
  repoUrl: z.string().optional(),
  path: z.string().optional(),
  resources: z.array(z.object({
    kind: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
    status: z.string(),
    health: z.string().optional(),
  })).optional(),
  conditions: z.array(z.object({
    type: z.string(),
    message: z.string(),
  })).optional(),
});
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const DeploymentResultSchema = z.object({
  success: z.boolean(),
  application: z.string(),
  action: z.enum(["create", "sync", "rollback", "delete"]),
  previousRevision: z.string().optional(),
  newRevision: z.string().optional(),
  syncStatus: z.string().optional(),
  healthStatus: z.string().optional(),
  message: z.string(),
  resources: z.array(z.object({
    kind: z.string(),
    name: z.string(),
    status: z.string(),
  })).optional(),
  duration: z.string().optional(),
});
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;

export const DeploymentPlanSchema = z.object({
  summary: z.string(),
  application: z.object({
    name: z.string(),
    namespace: z.string(),
    project: z.string(),
    source: z.object({
      repoUrl: z.string(),
      path: z.string(),
      targetRevision: z.string(),
    }),
    destination: z.object({
      server: z.string(),
      namespace: z.string(),
    }),
    syncPolicy: z.object({
      automated: z.boolean(),
      prune: z.boolean(),
      selfHeal: z.boolean(),
    }).optional(),
  }),
  preChecks: z.array(z.string()),
  risks: z.array(z.object({
    risk: z.string(),
    mitigation: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  })),
  rollbackPlan: z.string(),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

// --- Request Schema ---
export const DeployRequestSchema = z.object({
  action: z.enum([
    "create-application",
    "sync",
    "rollback",
    "get-status",
    "delete-application",
    "plan-deployment",
    "list-applications",
  ]),
  application: z.string().optional(),
  namespace: z.string().default("argocd"),
  project: z.string().default("default"),
  source: z.object({
    repoUrl: z.string(),
    path: z.string(),
    targetRevision: z.string().default("HEAD"),
  }).optional(),
  destination: z.object({
    server: z.string().default("https://kubernetes.default.svc"),
    namespace: z.string(),
  }).optional(),
  syncOptions: z.object({
    prune: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    force: z.boolean().default(false),
  }).optional(),
  revision: z.string().optional().describe("For rollback - target revision"),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "deploy-service",
      weight: 0.9, // Preferred GitOps path
      preferred: true,
      requirements: ["argocd-healthy"],
      estimatedDuration: "1m-5m",
    },
    {
      name: "rollback-service",
      weight: 0.9,
      preferred: true,
      requirements: ["argocd-healthy"],
      estimatedDuration: "30s-2m",
    },
    {
      name: "sync-gitops",
      weight: 1.0,
      preferred: true,
      requirements: ["argocd-healthy"],
      estimatedDuration: "30s-3m",
    },
  ],
  status: "online",
  healthChecks: {
    "argocd-healthy": `${ARGOCD_SERVER}/api/v1/applications`,
  },
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "gitops-deployment",
    platform: "argocd",
    server: ARGOCD_SERVER,
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the ArgoCD Deployer Agent for Jay's homelab agent mesh. You manage GitOps deployments using ArgoCD.

## Your Role
- Create and manage ArgoCD Applications
- Sync applications to deploy changes
- Rollback to previous versions when needed
- Monitor application health and sync status
- Plan deployments with risk assessment

## ArgoCD Concepts
- **Application**: A group of Kubernetes resources defined by a manifest
- **Project**: Logical grouping of applications with access policies
- **Sync**: Process of applying desired state from Git to cluster
- **Health**: Status of application resources (Healthy, Progressing, Degraded)
- **Sync Status**: Whether app state matches Git (Synced, OutOfSync)

## Deployment Best Practices
1. Always check application status before making changes
2. Use dry-run for risky operations
3. Prefer automated sync with self-heal for production apps
4. Keep rollback revision noted for quick recovery
5. Verify health status after sync completes
6. Use prune cautiously - it removes resources not in Git

## Environment
- ArgoCD server: ${ARGOCD_SERVER}
- Default project: default
- Cluster: https://kubernetes.default.svc (in-cluster)

## Safety Rules
- Never force sync without explicit approval
- Always verify target namespace exists
- Check for resource conflicts before creating apps
- Maintain deployment history in memory`;

// --- ArgoCD API Helper ---
async function argocdRequest(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<unknown> {
  if (!ARGOCD_TOKEN) {
    throw new Error("ArgoCD token not configured");
  }

  const url = `${ARGOCD_SERVER}/api/v1${endpoint}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${ARGOCD_TOKEN}`,
    "Content-Type": "application/json",
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  // Handle self-signed certs in development
  if (ARGOCD_INSECURE) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ArgoCD API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// --- Tool Definitions ---
const tools = {
  argocd_get_status: tool({
    description: "Get status of an ArgoCD application",
    parameters: z.object({
      application: z.string().describe("Application name"),
      namespace: z.string().default("argocd"),
    }),
    execute: async ({ application, namespace }) => {
      console.log(`[${AGENT_ID}] Getting status for ${application}`);

      try {
        const result = await argocdRequest(`/applications/${application}?appNamespace=${namespace}`);
        const app = result as Record<string, unknown>;
        const status = app.status as Record<string, unknown>;
        const spec = app.spec as Record<string, unknown>;

        return {
          name: app.metadata && (app.metadata as Record<string, unknown>).name,
          syncStatus: status?.sync && (status.sync as Record<string, unknown>).status,
          healthStatus: status?.health && (status.health as Record<string, unknown>).status,
          revision: status?.sync && (status.sync as Record<string, unknown>).revision,
          repoUrl: spec?.source && (spec.source as Record<string, unknown>).repoURL,
          path: spec?.source && (spec.source as Record<string, unknown>).path,
        };
      } catch (error) {
        return { error: String(error), application };
      }
    },
  }),

  argocd_sync: tool({
    description: "Sync an ArgoCD application to deploy changes",
    parameters: z.object({
      application: z.string(),
      namespace: z.string().default("argocd"),
      prune: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      revision: z.string().optional(),
    }),
    execute: async ({ application, namespace, prune, dryRun, revision }) => {
      console.log(`[${AGENT_ID}] Syncing ${application} (prune=${prune}, dryRun=${dryRun})`);

      try {
        const syncRequest: Record<string, unknown> = {
          prune,
          dryRun,
        };

        if (revision) {
          syncRequest.revision = revision;
        }

        const result = await argocdRequest(
          `/applications/${application}/sync?appNamespace=${namespace}`,
          "POST",
          syncRequest
        );

        return {
          success: true,
          application,
          action: "sync",
          result,
        };
      } catch (error) {
        return { success: false, error: String(error), application };
      }
    },
  }),

  argocd_create_application: tool({
    description: "Create a new ArgoCD application",
    parameters: z.object({
      name: z.string(),
      namespace: z.string().default("argocd"),
      project: z.string().default("default"),
      repoUrl: z.string(),
      path: z.string(),
      targetRevision: z.string().default("HEAD"),
      destServer: z.string().default("https://kubernetes.default.svc"),
      destNamespace: z.string(),
      autoSync: z.boolean().default(false),
      prune: z.boolean().default(false),
      selfHeal: z.boolean().default(false),
    }),
    execute: async ({ name, namespace, project, repoUrl, path, targetRevision, destServer, destNamespace, autoSync, prune, selfHeal }) => {
      console.log(`[${AGENT_ID}] Creating application ${name}`);

      const applicationSpec: Record<string, unknown> = {
        metadata: {
          name,
          namespace,
        },
        spec: {
          project,
          source: {
            repoURL: repoUrl,
            path,
            targetRevision,
          },
          destination: {
            server: destServer,
            namespace: destNamespace,
          },
        },
      };

      if (autoSync) {
        (applicationSpec.spec as Record<string, unknown>).syncPolicy = {
          automated: {
            prune,
            selfHeal,
          },
        };
      }

      try {
        const result = await argocdRequest("/applications", "POST", applicationSpec);
        return {
          success: true,
          application: name,
          action: "create",
          result,
        };
      } catch (error) {
        return { success: false, error: String(error), application: name };
      }
    },
  }),

  argocd_rollback: tool({
    description: "Rollback an ArgoCD application to a previous revision",
    parameters: z.object({
      application: z.string(),
      namespace: z.string().default("argocd"),
      revision: z.string().describe("Target revision ID to rollback to"),
    }),
    execute: async ({ application, namespace, revision }) => {
      console.log(`[${AGENT_ID}] Rolling back ${application} to ${revision}`);

      try {
        // First, get current status
        const currentStatus = await argocdRequest(`/applications/${application}?appNamespace=${namespace}`);
        const currentApp = currentStatus as Record<string, unknown>;
        const currentRevision = ((currentApp.status as Record<string, unknown>)?.sync as Record<string, unknown>)?.revision;

        // Perform sync to specific revision
        const result = await argocdRequest(
          `/applications/${application}/sync?appNamespace=${namespace}`,
          "POST",
          { revision }
        );

        return {
          success: true,
          application,
          action: "rollback",
          previousRevision: currentRevision,
          newRevision: revision,
          result,
        };
      } catch (error) {
        return { success: false, error: String(error), application };
      }
    },
  }),

  argocd_list_applications: tool({
    description: "List all ArgoCD applications",
    parameters: z.object({
      project: z.string().optional(),
      namespace: z.string().default("argocd"),
    }),
    execute: async ({ project, namespace }) => {
      console.log(`[${AGENT_ID}] Listing applications`);

      try {
        let endpoint = `/applications?appNamespace=${namespace}`;
        if (project) {
          endpoint += `&project=${project}`;
        }

        const result = await argocdRequest(endpoint);
        const items = (result as Record<string, unknown>).items as Array<Record<string, unknown>> || [];

        return {
          count: items.length,
          applications: items.map((app) => ({
            name: (app.metadata as Record<string, unknown>)?.name,
            project: (app.spec as Record<string, unknown>)?.project,
            syncStatus: ((app.status as Record<string, unknown>)?.sync as Record<string, unknown>)?.status,
            healthStatus: ((app.status as Record<string, unknown>)?.health as Record<string, unknown>)?.status,
          })),
        };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  argocd_delete_application: tool({
    description: "Delete an ArgoCD application",
    parameters: z.object({
      application: z.string(),
      namespace: z.string().default("argocd"),
      cascade: z.boolean().default(true).describe("Delete resources managed by the application"),
    }),
    execute: async ({ application, namespace, cascade }) => {
      console.log(`[${AGENT_ID}] Deleting application ${application} (cascade=${cascade})`);

      try {
        await argocdRequest(
          `/applications/${application}?appNamespace=${namespace}&cascade=${cascade}`,
          "DELETE"
        );

        return {
          success: true,
          application,
          action: "delete",
          cascade,
        };
      } catch (error) {
        return { success: false, error: String(error), application };
      }
    },
  }),

  search_deployment_history: tool({
    description: "Search memory for past deployment patterns and issues",
    parameters: z.object({
      query: z.string(),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      if (!memory) return { results: [], note: "Memory not available" };
      try {
        const results = await memory.search(query, "argocd-deployer", limit);
        return { results: results.map((r) => ({ pattern: r.memory, score: r.score })) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),
};

// --- HTTP Server ---
const app = new Hono();

app.get("/healthz", async (c) => {
  // Check ArgoCD connectivity
  let argocdHealthy = false;
  try {
    if (ARGOCD_TOKEN) {
      await argocdRequest("/applications?limit=1");
      argocdHealthy = true;
    }
  } catch {
    argocdHealthy = false;
  }

  return c.json({
    status: argocdHealthy ? "ok" : "degraded",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
    argocd: {
      server: ARGOCD_SERVER,
      connected: argocdHealthy,
    },
  });
});

app.get("/readyz", (c) => c.json({ status: "ok" }));

app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    { pubsubname: DAPR_PUBSUB_NAME, topic: `tasks.${AGENT_ID}`, route: "/tasks" },
  ];
  return c.json(subscriptions);
});

// --- Main Deploy Endpoint ---
app.post("/deploy", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = DeployRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] Deploy request: ${request.action} - ${request.application || "new"}`);

    const result = await handleDeployRequest(request);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Deploy request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Invoke Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const request: DeployRequest = {
    action: body.payload?.action || "get-status",
    application: body.payload?.application,
    namespace: body.payload?.namespace || "argocd",
    project: body.payload?.project || "default",
    source: body.payload?.source,
    destination: body.payload?.destination,
    syncOptions: body.payload?.syncOptions,
    revision: body.payload?.revision,
  };

  const result = await handleDeployRequest(request);

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { deployment: result },
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
    const request = DeployRequestSchema.parse(task.payload);
    const result = await handleDeployRequest(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { deployment: result },
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
      error: { type: "deploy_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Handler ---
async function handleDeployRequest(request: DeployRequest): Promise<DeploymentResult | DeploymentPlan | ApplicationStatus | unknown> {
  let enhancedPrompt = SYSTEM_PROMPT;

  // Add memory context
  if (memory) {
    try {
      const pastDeployments = await memory.search(
        `${request.action} ${request.application || ""} deployment`,
        "argocd-deployer",
        3
      );
      if (pastDeployments.length > 0) {
        enhancedPrompt += `\n\n## Past Deployments\n${pastDeployments.map((p) => `- ${p.memory}`).join("\n")}`;
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  let result: DeploymentResult | DeploymentPlan | ApplicationStatus | unknown;

  switch (request.action) {
    case "get-status": {
      if (!request.application) throw new Error("Application name required");
      const status = await tools.argocd_get_status.execute({
        application: request.application,
        namespace: request.namespace,
      }, { toolCallId: "direct", messages: [] });
      result = status;
      break;
    }

    case "sync": {
      if (!request.application) throw new Error("Application name required");
      const syncResult = await tools.argocd_sync.execute({
        application: request.application,
        namespace: request.namespace,
        prune: request.syncOptions?.prune ?? false,
        dryRun: request.syncOptions?.dryRun ?? false,
        revision: request.revision,
      }, { toolCallId: "direct", messages: [] });
      result = syncResult;
      break;
    }

    case "rollback": {
      if (!request.application) throw new Error("Application name required");
      if (!request.revision) throw new Error("Revision required for rollback");
      const rollbackResult = await tools.argocd_rollback.execute({
        application: request.application,
        namespace: request.namespace,
        revision: request.revision,
      }, { toolCallId: "direct", messages: [] });
      result = rollbackResult;
      break;
    }

    case "create-application": {
      if (!request.application) throw new Error("Application name required");
      if (!request.source) throw new Error("Source configuration required");
      if (!request.destination) throw new Error("Destination configuration required");

      const createResult = await tools.argocd_create_application.execute({
        name: request.application,
        namespace: request.namespace,
        project: request.project,
        repoUrl: request.source.repoUrl,
        path: request.source.path,
        targetRevision: request.source.targetRevision,
        destServer: request.destination.server,
        destNamespace: request.destination.namespace,
        autoSync: false,
        prune: false,
        selfHeal: false,
      }, { toolCallId: "direct", messages: [] });
      result = createResult;
      break;
    }

    case "delete-application": {
      if (!request.application) throw new Error("Application name required");
      const deleteResult = await tools.argocd_delete_application.execute({
        application: request.application,
        namespace: request.namespace,
        cascade: true,
      }, { toolCallId: "direct", messages: [] });
      result = deleteResult;
      break;
    }

    case "list-applications": {
      const listResult = await tools.argocd_list_applications.execute({
        project: request.project !== "default" ? request.project : undefined,
        namespace: request.namespace,
      }, { toolCallId: "direct", messages: [] });
      result = listResult;
      break;
    }

    case "plan-deployment": {
      if (!request.source || !request.destination) {
        throw new Error("Source and destination required for planning");
      }

      const { text: analysis } = await generateText({
        model: llm(LLM_MODEL),
        system: enhancedPrompt,
        prompt: `Plan a deployment for:
Application: ${request.application || "new-app"}
Source: ${request.source.repoUrl} / ${request.source.path} @ ${request.source.targetRevision}
Destination: ${request.destination.namespace}

Analyze risks and create a deployment plan.`,
        tools,
        maxSteps: 3,
      });

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: DeploymentPlanSchema,
        system: enhancedPrompt,
        prompt: `Create a structured deployment plan:\n\n${analysis}`,
      });
      result = object;
      break;
    }
  }

  // Store in memory
  if (memory && request.application) {
    try {
      const summary = `${request.action} on ${request.application}: ${JSON.stringify(result).substring(0, 300)}`;
      await memory.store(
        [
          { role: "user", content: `${request.action} ${request.application}` },
          { role: "assistant", content: summary },
        ],
        "argocd-deployer",
        { action: request.action, application: request.application }
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
  console.log(`[${AGENT_ID}] ArgoCD server: ${ARGOCD_SERVER}`);

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
