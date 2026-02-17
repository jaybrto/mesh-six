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
const AGENT_ID = process.env.AGENT_ID || "kubectl-deployer";
const AGENT_NAME = process.env.AGENT_NAME || "Kubectl Deployer Agent";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// LLM Configuration
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";

// Kubernetes Configuration
const KUBECONFIG = process.env.KUBECONFIG || "";
const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT || "";

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

// --- kubectl Helper ---
async function kubectl(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmdArgs = [...args];

  if (KUBECONFIG) {
    cmdArgs.unshift(`--kubeconfig=${KUBECONFIG}`);
  }
  if (KUBECTL_CONTEXT) {
    cmdArgs.unshift(`--context=${KUBECTL_CONTEXT}`);
  }

  console.log(`[${AGENT_ID}] kubectl ${cmdArgs.join(" ")}`);

  const proc = Bun.spawn(["kubectl", ...cmdArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

// --- Structured Output Schemas ---
export const PodStatusSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  status: z.enum(["Running", "Pending", "Succeeded", "Failed", "Unknown", "CrashLoopBackOff", "Error", "Terminating"]),
  ready: z.string().describe("e.g., 1/1, 2/2"),
  restarts: z.number(),
  age: z.string(),
  node: z.string().optional(),
  ip: z.string().optional(),
});
export type PodStatus = z.infer<typeof PodStatusSchema>;

export const DeploymentStatusSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  ready: z.string().describe("e.g., 3/3"),
  upToDate: z.number(),
  available: z.number(),
  age: z.string(),
  images: z.array(z.string()).optional(),
  strategy: z.string().optional(),
});
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export const RolloutStatusSchema = z.object({
  deployment: z.string(),
  namespace: z.string(),
  revision: z.number(),
  status: z.enum(["complete", "in-progress", "paused", "failed"]),
  replicas: z.object({
    desired: z.number(),
    current: z.number(),
    ready: z.number(),
    available: z.number(),
  }),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    message: z.string().optional(),
  })).optional(),
});
export type RolloutStatus = z.infer<typeof RolloutStatusSchema>;

export const DebugResultSchema = z.object({
  summary: z.string(),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "error", "critical"]),
    category: z.string(),
    message: z.string(),
    resource: z.string().optional(),
    recommendation: z.string().optional(),
  })),
  logs: z.object({
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    recent: z.array(z.string()),
  }).optional(),
  resourceStatus: z.object({
    pods: z.array(PodStatusSchema).optional(),
    events: z.array(z.object({
      type: z.string(),
      reason: z.string(),
      message: z.string(),
      age: z.string(),
    })).optional(),
  }).optional(),
});
export type DebugResult = z.infer<typeof DebugResultSchema>;

export const DeploymentResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(["apply", "delete", "rollout", "scale", "restart"]),
  resources: z.array(z.object({
    kind: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
    status: z.string(),
  })),
  message: z.string(),
  previousState: z.string().optional(),
  newState: z.string().optional(),
});
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;

// --- Request Schema ---
export const KubectlRequestSchema = z.object({
  action: z.enum([
    "apply",
    "delete",
    "get-pods",
    "get-deployments",
    "describe",
    "logs",
    "rollout-status",
    "rollout-history",
    "rollout-undo",
    "scale",
    "restart",
    "debug",
    "exec",
  ]),
  namespace: z.string().default("default"),
  resource: z.string().optional().describe("Resource type (deployment, pod, service, etc.)"),
  name: z.string().optional().describe("Resource name"),
  manifest: z.string().optional().describe("YAML/JSON manifest for apply"),
  selector: z.string().optional().describe("Label selector (-l key=value)"),
  container: z.string().optional().describe("Container name for logs/exec"),
  replicas: z.number().optional().describe("For scale action"),
  revision: z.number().optional().describe("For rollout undo"),
  tail: z.number().optional().default(100).describe("Number of log lines"),
  previous: z.boolean().optional().describe("Get previous container logs"),
  command: z.array(z.string()).optional().describe("Command for exec"),
});
export type KubectlRequest = z.infer<typeof KubectlRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "deploy-service",
      weight: 0.7, // Lower than ArgoCD - direct kubectl is fallback
      preferred: false,
      requirements: ["kubectl-access"],
      estimatedDuration: "30s-2m",
    },
    {
      name: "rollback-service",
      weight: 0.7,
      preferred: false,
      requirements: ["kubectl-access"],
      estimatedDuration: "30s-1m",
    },
    {
      name: "debug-pods",
      weight: 1.0, // Primary debugger
      preferred: true,
      requirements: ["kubectl-access"],
      estimatedDuration: "1m-5m",
    },
    {
      name: "inspect-cluster",
      weight: 0.9,
      preferred: true,
      requirements: ["kubectl-access"],
      estimatedDuration: "30s-2m",
    },
  ],
  status: "online",
  healthChecks: {
    "kubectl-access": "kubectl cluster-info",
  },
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "direct-kubernetes",
    platform: "kubectl",
    context: KUBECTL_CONTEXT || "in-cluster",
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Kubectl Deployer Agent for Jay's homelab agent mesh. You manage Kubernetes resources directly using kubectl.

## Your Role
- Deploy manifests directly to Kubernetes
- Debug pod issues with logs, describe, events
- Manage rollouts (status, history, undo)
- Scale deployments
- Inspect cluster state

## When to Use This Agent
- Emergency deployments when GitOps is unavailable
- Debugging pods and services
- Quick inspections and troubleshooting
- Ad-hoc operations that don't need GitOps tracking

## Best Practices
1. Always check resource status before making changes
2. Use labels and selectors for targeted operations
3. Check events when pods aren't starting
4. Review logs for crash loops
5. Use describe for detailed resource information
6. Prefer ArgoCD for production deployments

## Debugging Workflow
1. Get pod status to identify unhealthy pods
2. Check events in the namespace for scheduling/resource issues
3. Describe the pod for detailed state
4. Get logs (including --previous for crashed containers)
5. Exec into container if needed for live debugging

## Safety Rules
- Never delete without confirmation
- Always verify namespace before destructive operations
- Prefer scaling to 0 over delete for reversibility
- Document changes in memory for audit trail`;

// --- Tool Definitions ---
const tools = {
  kubectl_get_pods: tool({
    description: "Get pod status in a namespace",
    parameters: z.object({
      namespace: z.string().default("default"),
      selector: z.string().optional(),
      allNamespaces: z.boolean().default(false),
    }),
    execute: async ({ namespace, selector, allNamespaces }) => {
      const args = ["get", "pods", "-o", "wide"];
      if (allNamespaces) {
        args.push("-A");
      } else {
        args.push("-n", namespace);
      }
      if (selector) {
        args.push("-l", selector);
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { pods: stdout, namespace };
    },
  }),

  kubectl_get_deployments: tool({
    description: "Get deployment status",
    parameters: z.object({
      namespace: z.string().default("default"),
      name: z.string().optional(),
    }),
    execute: async ({ namespace, name }) => {
      const args = ["get", "deployments", "-n", namespace, "-o", "wide"];
      if (name) {
        args.splice(2, 0, name);
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { deployments: stdout, namespace };
    },
  }),

  kubectl_describe: tool({
    description: "Get detailed information about a resource",
    parameters: z.object({
      resource: z.string().describe("Resource type (pod, deployment, service, etc.)"),
      name: z.string(),
      namespace: z.string().default("default"),
    }),
    execute: async ({ resource, name, namespace }) => {
      const { stdout, stderr, exitCode } = await kubectl([
        "describe", resource, name, "-n", namespace,
      ]);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { description: stdout };
    },
  }),

  kubectl_logs: tool({
    description: "Get container logs",
    parameters: z.object({
      pod: z.string(),
      namespace: z.string().default("default"),
      container: z.string().optional(),
      tail: z.number().default(100),
      previous: z.boolean().default(false),
    }),
    execute: async ({ pod, namespace, container, tail, previous }) => {
      const args = ["logs", pod, "-n", namespace, `--tail=${tail}`];
      if (container) {
        args.push("-c", container);
      }
      if (previous) {
        args.push("--previous");
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { logs: stdout, pod, container };
    },
  }),

  kubectl_events: tool({
    description: "Get events in a namespace (sorted by time)",
    parameters: z.object({
      namespace: z.string().default("default"),
      fieldSelector: z.string().optional().describe("e.g., involvedObject.name=my-pod"),
    }),
    execute: async ({ namespace, fieldSelector }) => {
      const args = ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"];
      if (fieldSelector) {
        args.push("--field-selector", fieldSelector);
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { events: stdout, namespace };
    },
  }),

  kubectl_apply: tool({
    description: "Apply a manifest to the cluster",
    parameters: z.object({
      manifest: z.string().describe("YAML/JSON manifest"),
      namespace: z.string().optional(),
      dryRun: z.boolean().default(false),
    }),
    execute: async ({ manifest, namespace, dryRun }) => {
      const args = ["apply", "-f", "-"];
      if (namespace) {
        args.push("-n", namespace);
      }
      if (dryRun) {
        args.push("--dry-run=client");
      }

      const proc = Bun.spawn(["kubectl", ...args], {
        stdin: new TextEncoder().encode(manifest),
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { result: stdout, dryRun };
    },
  }),

  kubectl_delete: tool({
    description: "Delete a resource",
    parameters: z.object({
      resource: z.string(),
      name: z.string(),
      namespace: z.string().default("default"),
      force: z.boolean().default(false),
    }),
    execute: async ({ resource, name, namespace, force }) => {
      const args = ["delete", resource, name, "-n", namespace];
      if (force) {
        args.push("--force", "--grace-period=0");
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { result: stdout };
    },
  }),

  kubectl_rollout_status: tool({
    description: "Check rollout status of a deployment",
    parameters: z.object({
      deployment: z.string(),
      namespace: z.string().default("default"),
    }),
    execute: async ({ deployment, namespace }) => {
      const { stdout, stderr, exitCode } = await kubectl([
        "rollout", "status", `deployment/${deployment}`, "-n", namespace,
      ]);
      return { status: stdout || stderr, exitCode };
    },
  }),

  kubectl_rollout_history: tool({
    description: "Get rollout history of a deployment",
    parameters: z.object({
      deployment: z.string(),
      namespace: z.string().default("default"),
    }),
    execute: async ({ deployment, namespace }) => {
      const { stdout, stderr, exitCode } = await kubectl([
        "rollout", "history", `deployment/${deployment}`, "-n", namespace,
      ]);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { history: stdout };
    },
  }),

  kubectl_rollout_undo: tool({
    description: "Rollback a deployment to previous revision",
    parameters: z.object({
      deployment: z.string(),
      namespace: z.string().default("default"),
      revision: z.number().optional(),
    }),
    execute: async ({ deployment, namespace, revision }) => {
      const args = ["rollout", "undo", `deployment/${deployment}`, "-n", namespace];
      if (revision) {
        args.push(`--to-revision=${revision}`);
      }

      const { stdout, stderr, exitCode } = await kubectl(args);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { result: stdout };
    },
  }),

  kubectl_scale: tool({
    description: "Scale a deployment",
    parameters: z.object({
      deployment: z.string(),
      namespace: z.string().default("default"),
      replicas: z.number(),
    }),
    execute: async ({ deployment, namespace, replicas }) => {
      const { stdout, stderr, exitCode } = await kubectl([
        "scale", `deployment/${deployment}`, "-n", namespace, `--replicas=${replicas}`,
      ]);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { result: stdout, replicas };
    },
  }),

  kubectl_restart: tool({
    description: "Restart a deployment (rolling restart)",
    parameters: z.object({
      deployment: z.string(),
      namespace: z.string().default("default"),
    }),
    execute: async ({ deployment, namespace }) => {
      const { stdout, stderr, exitCode } = await kubectl([
        "rollout", "restart", `deployment/${deployment}`, "-n", namespace,
      ]);
      if (exitCode !== 0) {
        return { error: stderr, exitCode };
      }
      return { result: stdout };
    },
  }),

  search_debug_history: tool({
    description: "Search memory for past debugging patterns and fixes",
    parameters: z.object({
      query: z.string(),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      if (!memory) return { results: [], note: "Memory not available" };
      try {
        const results = await memory.search(query, "kubectl-deployer", limit);
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
  // Check kubectl connectivity
  let kubectlHealthy = false;
  try {
    const { exitCode } = await kubectl(["cluster-info"]);
    kubectlHealthy = exitCode === 0;
  } catch {
    kubectlHealthy = false;
  }

  return c.json({
    status: kubectlHealthy ? "ok" : "degraded",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
    kubectl: {
      context: KUBECTL_CONTEXT || "in-cluster",
      connected: kubectlHealthy,
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

// --- Main Kubectl Endpoint ---
app.post("/kubectl", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = KubectlRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] Kubectl request: ${request.action} - ${request.name || request.resource || "cluster"}`);

    const result = await handleKubectlRequest(request);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Kubectl request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Debug Endpoint ---
app.post("/debug", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const { namespace = "default", selector, name, resource = "deployment" } = body;

    console.log(`[${AGENT_ID}] Debug request: ${resource}/${name || selector} in ${namespace}`);

    const result = await handleDebugRequest(namespace, name, selector, resource);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Debug request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Invoke Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const request: KubectlRequest = {
    action: body.payload?.action || "get-pods",
    namespace: body.payload?.namespace || "default",
    resource: body.payload?.resource,
    name: body.payload?.name,
    manifest: body.payload?.manifest,
    selector: body.payload?.selector,
    container: body.payload?.container,
    replicas: body.payload?.replicas,
    revision: body.payload?.revision,
    tail: body.payload?.tail || 100,
    previous: body.payload?.previous,
    command: body.payload?.command,
  };

  const result = await handleKubectlRequest(request);

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { kubectl: result },
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
    let result: unknown;

    // Check if this is a debug task
    if (task.capability === "debug-pods" || (task.payload as Record<string, unknown>)?.debug) {
      const { namespace = "default", name, selector, resource = "deployment" } = task.payload as Record<string, unknown>;
      result = await handleDebugRequest(
        namespace as string,
        name as string | undefined,
        selector as string | undefined,
        resource as string
      );
    } else {
      const request = KubectlRequestSchema.parse(task.payload);
      result = await handleKubectlRequest(request);
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
    return c.json({ status: "SUCCESS" });
  } catch (error) {
    console.error(`[${AGENT_ID}] Task failed:`, error);

    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "kubectl_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Handler ---
async function handleKubectlRequest(request: KubectlRequest): Promise<unknown> {
  const toolOpts = { toolCallId: "direct", messages: [] };

  switch (request.action) {
    case "get-pods": {
      return tools.kubectl_get_pods.execute({
        namespace: request.namespace,
        selector: request.selector,
        allNamespaces: false,
      }, toolOpts);
    }

    case "get-deployments": {
      return tools.kubectl_get_deployments.execute({
        namespace: request.namespace,
        name: request.name,
      }, toolOpts);
    }

    case "describe": {
      if (!request.resource || !request.name) {
        throw new Error("Resource type and name required for describe");
      }
      return tools.kubectl_describe.execute({
        resource: request.resource,
        name: request.name,
        namespace: request.namespace,
      }, toolOpts);
    }

    case "logs": {
      if (!request.name) throw new Error("Pod name required for logs");
      return tools.kubectl_logs.execute({
        pod: request.name,
        namespace: request.namespace,
        container: request.container,
        tail: request.tail || 100,
        previous: request.previous || false,
      }, toolOpts);
    }

    case "apply": {
      if (!request.manifest) throw new Error("Manifest required for apply");
      return tools.kubectl_apply.execute({
        manifest: request.manifest,
        namespace: request.namespace,
        dryRun: false,
      }, toolOpts);
    }

    case "delete": {
      if (!request.resource || !request.name) {
        throw new Error("Resource type and name required for delete");
      }
      return tools.kubectl_delete.execute({
        resource: request.resource,
        name: request.name,
        namespace: request.namespace,
        force: false,
      }, toolOpts);
    }

    case "rollout-status": {
      if (!request.name) throw new Error("Deployment name required");
      return tools.kubectl_rollout_status.execute({
        deployment: request.name,
        namespace: request.namespace,
      }, toolOpts);
    }

    case "rollout-history": {
      if (!request.name) throw new Error("Deployment name required");
      return tools.kubectl_rollout_history.execute({
        deployment: request.name,
        namespace: request.namespace,
      }, toolOpts);
    }

    case "rollout-undo": {
      if (!request.name) throw new Error("Deployment name required");
      return tools.kubectl_rollout_undo.execute({
        deployment: request.name,
        namespace: request.namespace,
        revision: request.revision,
      }, toolOpts);
    }

    case "scale": {
      if (!request.name) throw new Error("Deployment name required");
      if (request.replicas === undefined) throw new Error("Replicas count required");
      return tools.kubectl_scale.execute({
        deployment: request.name,
        namespace: request.namespace,
        replicas: request.replicas,
      }, toolOpts);
    }

    case "restart": {
      if (!request.name) throw new Error("Deployment name required");
      return tools.kubectl_restart.execute({
        deployment: request.name,
        namespace: request.namespace,
      }, toolOpts);
    }

    case "debug": {
      return handleDebugRequest(request.namespace, request.name, request.selector, request.resource || "deployment");
    }

    case "exec": {
      if (!request.name) throw new Error("Pod name required");
      if (!request.command || request.command.length === 0) {
        throw new Error("Command required for exec");
      }
      const args = ["exec", request.name, "-n", request.namespace];
      if (request.container) {
        args.push("-c", request.container);
      }
      args.push("--", ...request.command);
      return kubectl(args);
    }

    default:
      throw new Error(`Unknown action: ${request.action}`);
  }
}

// --- Debug Handler ---
async function handleDebugRequest(
  namespace: string,
  name?: string,
  selector?: string,
  resource: string = "deployment"
): Promise<DebugResult> {
  let enhancedPrompt = SYSTEM_PROMPT;

  // Add memory context
  if (memory) {
    try {
      const pastDebugs = await memory.search(
        `debug ${resource} ${name || selector || namespace}`,
        "kubectl-deployer",
        3
      );
      if (pastDebugs.length > 0) {
        enhancedPrompt += `\n\n## Past Debugging Sessions\n${pastDebugs.map((p) => `- ${p.memory}`).join("\n")}`;
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Step 1: Gather information using tools
  const traceId = crypto.randomUUID();
  const { text: analysis } = await tracedGenerateText(
    {
      model: llm(LLM_MODEL),
      system: enhancedPrompt,
      prompt: `Debug the following Kubernetes issue:
Namespace: ${namespace}
Resource: ${resource}
Name: ${name || "not specified"}
Selector: ${selector || "not specified"}

Investigate by:
1. Getting pod status
2. Checking events
3. Getting logs if there are unhealthy pods
4. Describing resources that have issues

Provide a thorough analysis.`,
      tools,
      maxSteps: 8,
    },
    eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
  );

  // Step 2: Generate structured result
  const { object } = await generateObject({
    model: llm(LLM_MODEL),
    schema: DebugResultSchema,
    system: enhancedPrompt,
    prompt: `Create a structured debug report from this analysis:\n\n${analysis}`,
  });

  // Store in memory
  if (memory) {
    try {
      const summary = `Debug ${resource}/${name || selector} in ${namespace}: ${object.summary}`;
      await memory.store(
        [
          { role: "user", content: `debug ${resource} ${name || selector} in ${namespace}` },
          { role: "assistant", content: summary },
        ],
        "kubectl-deployer",
        { namespace, resource, name, findings: object.findings.length }
      );
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory store failed:`, error);
    }
  }

  return object;
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
  console.log(`[${AGENT_ID}] Kubectl context: ${KUBECTL_CONTEXT || "in-cluster"}`);

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
