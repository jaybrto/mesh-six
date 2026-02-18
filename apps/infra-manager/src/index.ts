import { Hono } from "hono";
import { DaprClient } from "@dapr/dapr";
import { tool } from "ai";
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
const AGENT_ID = process.env.AGENT_ID || "infra-manager";
const AGENT_NAME = process.env.AGENT_NAME || "Infrastructure Manager";
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "sk-local";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4-20250514";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== "false";
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

// Infrastructure service endpoints
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "";
const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL || "http://caddy.caddy:2019";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

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

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    { name: "dns-management", weight: 1.0, preferred: true, requirements: [] },
    { name: "proxy-management", weight: 0.9, preferred: false, requirements: [] },
    { name: "firewall-management", weight: 0.8, preferred: false, requirements: [] },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "infrastructure-management",
    services: ["cloudflare", "caddy", "opnsense"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the Infrastructure Manager Agent for the mesh-six platform. You manage DNS records, reverse proxy routes, and network infrastructure.

## Infrastructure Stack
- DNS: Cloudflare (domain management, DNS records, tunnels)
- Reverse Proxy: Caddy (automatic HTTPS, route management)
- Firewall: OPNsense (network security, port management)
- Cluster: 6-node k3s at k3s.bto.bar

## Your Capabilities
- Manage Cloudflare DNS records (list, create, update)
- List and inspect Cloudflare tunnels
- Query and update Caddy reverse proxy configuration
- Provide recommendations for network topology

## Safety Guidelines
- NEVER delete DNS records without explicit confirmation
- NEVER modify firewall rules without review
- Always verify changes before applying
- Log all infrastructure changes for audit
- Prefer non-destructive operations (list/read before write)

Current agent ID: ${AGENT_ID}`;

// --- Helper: Cloudflare API ---
async function cloudflareRequest(
  endpoint: string,
  method: string = "GET",
  body?: unknown
): Promise<unknown> {
  const url = `${CLOUDFLARE_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudflare API ${response.status}: ${text}`);
  }

  return response.json();
}

// --- Tool Definitions ---
const tools = {
  cloudflare_dns_list: tool({
    description: "List DNS records for the configured Cloudflare zone. Returns all records or filtered by type/name.",
    parameters: z.object({
      type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "NS", "all"]).default("all").describe("DNS record type filter"),
      name: z.string().optional().describe("Filter by record name (partial match)"),
      page: z.number().default(1).describe("Page number for pagination"),
      perPage: z.number().default(50).describe("Records per page"),
    }),
    execute: async ({ type, name, page, perPage }) => {
      console.log(`[${AGENT_ID}] Listing DNS records: type=${type}, name=${name || "all"}`);

      if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
        return { error: "Cloudflare credentials not configured" };
      }

      try {
        let endpoint = `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?page=${page}&per_page=${perPage}`;
        if (type !== "all") endpoint += `&type=${type}`;
        if (name) endpoint += `&name=${encodeURIComponent(name)}`;

        return await cloudflareRequest(endpoint);
      } catch (error) {
        return { error: `DNS list failed: ${error}` };
      }
    },
  }),

  cloudflare_dns_create: tool({
    description: "Create a new DNS record in Cloudflare. Use with caution - verify the record doesn't already exist.",
    parameters: z.object({
      type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV"]).describe("DNS record type"),
      name: z.string().describe("DNS record name (e.g., 'app' or 'app.example.com')"),
      content: z.string().describe("DNS record content (IP for A/AAAA, hostname for CNAME, text for TXT)"),
      ttl: z.number().default(1).describe("TTL in seconds (1 = automatic)"),
      proxied: z.boolean().default(false).describe("Whether to proxy through Cloudflare"),
      comment: z.string().optional().describe("Comment for the record"),
    }),
    execute: async ({ type, name, content, ttl, proxied, comment }) => {
      console.log(`[${AGENT_ID}] Creating DNS record: ${type} ${name} -> ${content}`);

      if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
        return { error: "Cloudflare credentials not configured" };
      }

      try {
        const body: Record<string, unknown> = { type, name, content, ttl, proxied };
        if (comment) body.comment = comment;

        return await cloudflareRequest(
          `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`,
          "POST",
          body
        );
      } catch (error) {
        return { error: `DNS create failed: ${error}` };
      }
    },
  }),

  cloudflare_dns_update: tool({
    description: "Update an existing DNS record in Cloudflare. Requires the record ID.",
    parameters: z.object({
      recordId: z.string().describe("DNS record ID to update"),
      type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV"]).describe("DNS record type"),
      name: z.string().describe("DNS record name"),
      content: z.string().describe("New DNS record content"),
      ttl: z.number().default(1).describe("TTL in seconds (1 = automatic)"),
      proxied: z.boolean().default(false).describe("Whether to proxy through Cloudflare"),
      comment: z.string().optional().describe("Comment for the record"),
    }),
    execute: async ({ recordId, type, name, content, ttl, proxied, comment }) => {
      console.log(`[${AGENT_ID}] Updating DNS record ${recordId}: ${type} ${name} -> ${content}`);

      if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
        return { error: "Cloudflare credentials not configured" };
      }

      try {
        const body: Record<string, unknown> = { type, name, content, ttl, proxied };
        if (comment) body.comment = comment;

        return await cloudflareRequest(
          `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`,
          "PUT",
          body
        );
      } catch (error) {
        return { error: `DNS update failed: ${error}` };
      }
    },
  }),

  cloudflare_tunnel_list: tool({
    description: "List Cloudflare tunnels associated with the account. Shows tunnel status and configuration.",
    parameters: z.object({
      name: z.string().optional().describe("Filter tunnels by name"),
      isDeleted: z.boolean().default(false).describe("Include deleted tunnels"),
    }),
    execute: async ({ name, isDeleted }) => {
      console.log(`[${AGENT_ID}] Listing Cloudflare tunnels`);

      if (!CLOUDFLARE_API_TOKEN) {
        return { error: "Cloudflare credentials not configured" };
      }

      try {
        // Tunnels are at the account level, need account ID from zone
        const zoneInfo = await cloudflareRequest(`/zones/${CLOUDFLARE_ZONE_ID}`) as {
          result?: { account?: { id?: string } };
        };
        const accountId = zoneInfo.result?.account?.id;

        if (!accountId) {
          return { error: "Could not determine account ID from zone" };
        }

        let endpoint = `/accounts/${accountId}/cfd_tunnel?is_deleted=${isDeleted}`;
        if (name) endpoint += `&name=${encodeURIComponent(name)}`;

        return await cloudflareRequest(endpoint);
      } catch (error) {
        return { error: `Tunnel list failed: ${error}` };
      }
    },
  }),

  caddy_get_config: tool({
    description: "Get current Caddy reverse proxy configuration. Can retrieve the full config or a specific path.",
    parameters: z.object({
      path: z.string().default("/config/").describe("Caddy admin API config path (e.g., /config/, /config/apps/http/)"),
    }),
    execute: async ({ path }) => {
      console.log(`[${AGENT_ID}] Getting Caddy config: ${path}`);
      try {
        const url = `${CADDY_ADMIN_URL}${path}`;
        const response = await fetch(url);

        if (!response.ok) {
          return { error: `Caddy returned ${response.status}: ${response.statusText}` };
        }

        return await response.json();
      } catch (error) {
        return { error: `Caddy config query failed: ${error}` };
      }
    },
  }),

  caddy_update_route: tool({
    description: "Add or update a route in Caddy's HTTP configuration. This modifies the live reverse proxy configuration.",
    parameters: z.object({
      id: z.string().describe("Route identifier (used as @id in Caddy config)"),
      match: z.array(z.object({
        host: z.array(z.string()).optional().describe("Hostnames to match"),
        path: z.array(z.string()).optional().describe("Path prefixes to match"),
      })).describe("Route match conditions"),
      upstream: z.string().describe("Upstream address (e.g., 'localhost:8080' or 'service.namespace.svc:80')"),
    }),
    execute: async ({ id, match, upstream }) => {
      console.log(`[${AGENT_ID}] Updating Caddy route: ${id} -> ${upstream}`);
      try {
        const route = {
          "@id": id,
          match,
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: upstream }],
            },
          ],
        };

        const url = `${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(route),
        });

        if (!response.ok) {
          const text = await response.text();
          return { error: `Caddy update failed ${response.status}: ${text}` };
        }

        return { success: true, routeId: id, upstream };
      } catch (error) {
        return { error: `Caddy route update failed: ${error}` };
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
    services: {
      cloudflare: !!CLOUDFLARE_API_TOKEN,
      caddy: CADDY_ADMIN_URL,
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

// Task handler (pub/sub)
app.post("/tasks", async (c) => {
  const message: DaprPubSubMessage<TaskRequest> = await c.req.json();
  const task = message.data;

  console.log(`[${AGENT_ID}] Received task: ${task.id} - ${task.capability}`);

  try {
    const result = await handleTask(task);
    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, result);
    console.log(`[${AGENT_ID}] Task ${task.id} completed in ${result.durationMs}ms`);
    return c.json({ status: "SUCCESS" });
  } catch (error) {
    console.error(`[${AGENT_ID}] Task ${task.id} failed:`, error);

    const failResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: false,
      error: { type: "unhandled", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// Direct invocation endpoint
app.post("/invoke", async (c) => {
  const body = await c.req.json();
  const result = await handleTask(body);
  return c.json(result);
});

// --- Core Task Handler ---
async function handleTask(task: TaskRequest): Promise<TaskResult> {
  const startTime = Date.now();

  const query =
    typeof task.payload.query === "string"
      ? task.payload.query
      : JSON.stringify(task.payload);

  const userId =
    typeof task.payload.userId === "string"
      ? task.payload.userId
      : task.requestedBy;

  // Build system prompt with memories
  let systemPrompt = SYSTEM_PROMPT;

  if (memory) {
    try {
      const memories = await memory.search(query, userId, 5);
      if (memories.length > 0) {
        const memoryContext = memories.map((m) => `- ${m.memory}`).join("\n");
        systemPrompt += `\n\n## Relevant Infrastructure History\n${memoryContext}`;
        console.log(`[${AGENT_ID}] Found ${memories.length} relevant memories`);
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Generate response with tool use
  const traceId = crypto.randomUUID();
  const { text } = await tracedGenerateText(
    { model: llm(LLM_MODEL), system: systemPrompt, prompt: query, tools, maxSteps: 8 },
    eventLog ? { eventLog, traceId, agentId: AGENT_ID, taskId: task.id } : null
  );

  // Store in memory
  if (memory) {
    try {
      await memory.store(
        [
          { role: "user", content: query },
          { role: "assistant", content: text },
        ],
        userId,
        {
          taskId: task.id,
          capability: task.capability,
        }
      );
      console.log(`[${AGENT_ID}] Stored conversation in memory`);
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory store failed:`, error);
    }
  }

  return {
    taskId: task.id,
    agentId: AGENT_ID,
    success: true,
    result: { response: text },
    durationMs: Date.now() - startTime,
    completedAt: new Date().toISOString(),
  };
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
      memory = null;
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
  console.log(`[${AGENT_ID}] Cloudflare: ${CLOUDFLARE_API_TOKEN ? "configured" : "not configured"}, Caddy: ${CADDY_ADMIN_URL}`);
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
