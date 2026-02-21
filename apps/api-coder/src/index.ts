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
const AGENT_ID = process.env.AGENT_ID || "api-coder";
const AGENT_NAME = process.env.AGENT_NAME || "API Coder Agent";
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
export const APIDesignSchema = z.object({
  summary: z.string().describe("Overview of the API design"),
  baseUrl: z.string().describe("Base URL pattern"),
  authentication: z.object({
    type: z.enum(["jwt", "api-key", "oauth2", "basic", "none"]),
    details: z.string(),
  }),
  endpoints: z.array(z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string(),
    description: z.string(),
    requestBody: z.object({
      contentType: z.string(),
      schema: z.record(z.string(), z.unknown()),
    }).optional(),
    queryParams: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      description: z.string(),
    })).optional(),
    responseSchema: z.record(z.string(), z.unknown()),
    statusCodes: z.array(z.object({
      code: z.number(),
      description: z.string(),
    })),
  })),
  dataLayer: z.object({
    databases: z.array(z.object({
      type: z.enum(["postgresql", "sqlite", "redis"]),
      purpose: z.string().describe("What this store is used for (primary data, cache, sessions, etc.)"),
      tables: z.array(z.object({
        name: z.string(),
        columns: z.array(z.string()),
        indexes: z.array(z.string()).default([]),
      })).optional(),
    })),
    caching: z.object({
      strategy: z.enum(["cache-aside", "write-through", "none"]),
      ttlSeconds: z.number().optional(),
      invalidation: z.string().optional(),
    }).optional(),
  }),
  middleware: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
  })),
  errorHandling: z.object({
    strategy: z.string(),
    errorFormat: z.record(z.string(), z.unknown()),
  }),
});
export type APIDesign = z.infer<typeof APIDesignSchema>;

export const CodeGenerationSchema = z.object({
  language: z.enum(["typescript", "go"]),
  framework: z.string().describe("Framework used (hono, express, gin, fiber, etc.)"),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    description: z.string(),
  })),
  migrations: z.array(z.object({
    path: z.string().describe("e.g. migrations/001_create_users.sql"),
    content: z.string(),
    description: z.string(),
  })).default([]),
  dependencies: z.array(z.object({
    name: z.string(),
    version: z.string(),
    dev: z.boolean().default(false),
  })),
  projectStructure: z.string().describe("ASCII tree of project structure"),
  setupCommands: z.array(z.string()),
  runCommand: z.string(),
  dockerSupport: z.object({
    dockerfile: z.string(),
    dockerCompose: z.string().describe("Include dependent services (postgres, redis) with health checks"),
  }).optional(),
  envVars: z.array(z.object({
    name: z.string(),
    description: z.string(),
    example: z.string(),
    required: z.boolean().default(true),
  })).default([]),
});
export type CodeGeneration = z.infer<typeof CodeGenerationSchema>;

export const CodeReviewSchema = z.object({
  summary: z.string(),
  score: z.number().min(0).max(100).describe("Overall code quality score"),
  issues: z.array(z.object({
    severity: z.enum(["critical", "major", "minor", "suggestion"]),
    category: z.enum(["security", "performance", "maintainability", "correctness", "style"]),
    location: z.string(),
    description: z.string(),
    suggestion: z.string(),
  })),
  strengths: z.array(z.string()),
  recommendations: z.array(z.object({
    priority: z.enum(["high", "medium", "low"]),
    recommendation: z.string(),
    rationale: z.string(),
  })),
  securityChecks: z.object({
    passed: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  dataLayerChecks: z.object({
    usesParameterizedQueries: z.boolean(),
    hasConnectionPooling: z.boolean(),
    hasMigrations: z.boolean(),
    hasGracefulShutdown: z.boolean(),
    issues: z.array(z.string()).default([]),
  }).optional(),
});
export type CodeReview = z.infer<typeof CodeReviewSchema>;

// --- Request Schema ---
export const APICoderRequestSchema = z.object({
  action: z.enum([
    "design-api",
    "generate-code",
    "review-code",
    "optimize-performance",
    "add-feature",
    "fix-bug",
  ]),
  context: z.object({
    language: z.enum(["typescript", "go", "auto"]).default("auto"),
    framework: z.string().optional(),
    requirements: z.string().optional(),
    existingCode: z.string().optional(),
    openApiSpec: z.string().optional(),
    bugDescription: z.string().optional(),
    featureDescription: z.string().optional(),
  }),
  preferences: z.object({
    runtime: z.enum(["bun", "node", "deno"]).default("bun"),
    goVersion: z.string().default("1.22"),
    includeTests: z.boolean().default(true),
    includeDocker: z.boolean().default(true),
    databases: z.array(z.enum(["postgresql", "sqlite", "redis"])).default(["postgresql"]),
    useDapr: z.boolean().default(false).describe("Generate Dapr pub/sub and state store integration"),
  }).optional(),
});
export type APICoderRequest = z.infer<typeof APICoderRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "api-design",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "2m-5m",
    },
    {
      name: "backend-coding",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "5m-15m",
    },
    {
      name: "code-review",
      weight: 0.9,
      preferred: false,
      requirements: [],
      estimatedDuration: "2m-5m",
    },
    {
      name: "bug-fix",
      weight: 0.9,
      preferred: true,
      requirements: [],
      estimatedDuration: "3m-10m",
    },
  ],
  status: "online",
  healthChecks: {},
  lastHeartbeat: new Date().toISOString(),
  metadata: {
    specialization: "backend-api-development",
    languages: ["typescript", "go"],
    runtimes: ["bun", "node", "go"],
    frameworks: ["hono", "express", "fastify", "gin", "fiber", "echo"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the API Coder Agent for the mesh-six agent mesh. You specialize in backend API development with Bun/Node.js (TypeScript) and Go.

## Stack Preferences

### TypeScript/Bun/Node.js
- **Runtime**: Bun (default), Node.js when deps require it
- **Framework**: Hono (default), Fastify or Express when needed
- **Validation**: Zod schemas at every system boundary
- **Auth**: JWT via jose, OAuth2, API key middleware

### Go
- **Framework**: Gin (default), Echo or Chi when needed
- **Validation**: go-playground/validator struct tags
- **Auth**: JWT via golang-jwt

## Database Patterns

### PostgreSQL (primary data store)

**TypeScript** — use \`pg\` package (not porsager \`postgres\`) for PgBouncer compatibility:
\`\`\`typescript
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Always use parameterized queries — never interpolate user input
const { rows } = await pool.query<User>(
  "SELECT id, name FROM users WHERE email = $1",
  [email]
);

// Transactions
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO orders (user_id, total) VALUES ($1, $2)", [userId, total]);
  await client.query("INSERT INTO order_items (order_id, product_id) VALUES ($1, $2)", [orderId, productId]);
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
\`\`\`

**Go** — use pgxpool for connection pooling:
\`\`\`go
import "github.com/jackc/pgx/v5/pgxpool"

pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
// Always use parameterized queries
row := pool.QueryRow(ctx, "SELECT id, name FROM users WHERE email = $1", email)
\`\`\`

### SQLite (embedded/local use cases)

**TypeScript (Bun)** — use bun:sqlite (zero deps, fastest):
\`\`\`typescript
import { Database } from "bun:sqlite";
const db = new Database("app.db", { create: true });
db.exec("PRAGMA journal_mode = WAL"); // always enable WAL for concurrency
db.exec("PRAGMA foreign_keys = ON");

const stmt = db.prepare("SELECT * FROM items WHERE category = ?");
const items = stmt.all(category);
\`\`\`

**Go** — use modernc.org/sqlite (pure Go, no CGO):
\`\`\`go
import "database/sql"
import _ "modernc.org/sqlite"
db, _ := sql.Open("sqlite", "file:app.db?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
\`\`\`

### Redis (caching, sessions, rate limiting)

**TypeScript** — use ioredis:
\`\`\`typescript
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL);

// Cache-aside pattern
async function getCached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const fresh = await fetcher();
  await redis.set(key, JSON.stringify(fresh), "EX", ttl);
  return fresh;
}

// Rate limiting with sliding window
async function checkRateLimit(ip: string, limit: number, windowSec: number): Promise<boolean> {
  const key = \`ratelimit:\${ip}\`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count <= limit;
}
\`\`\`

**Go** — use go-redis/v9:
\`\`\`go
import "github.com/redis/go-redis/v9"
rdb := redis.NewClient(&redis.Options{Addr: os.Getenv("REDIS_URL")})
\`\`\`

### Migrations

**TypeScript** — use Drizzle Kit or raw SQL files:
\`\`\`typescript
// migrations/001_create_users.sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_users_email ON users (email);
\`\`\`

**Go** — use golang-migrate:
\`\`\`bash
migrate -database "$DATABASE_URL" -path migrations up
\`\`\`

## Dapr Integration Patterns

When the service runs in the mesh-six cluster with Dapr sidecars:

### Pub/Sub (RabbitMQ via Dapr)
\`\`\`typescript
// Publishing events
const DAPR_URL = \`http://localhost:\${process.env.DAPR_HTTP_PORT || 3500}\`;
await fetch(\`\${DAPR_URL}/v1.0/publish/agent-pubsub/orders.created\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ orderId, userId, total }),
});

// Subscribing — declare in GET /dapr/subscribe
app.get("/dapr/subscribe", (c) => c.json([
  { pubsubname: "agent-pubsub", topic: "orders.created", route: "/events/order-created" },
]));
app.post("/events/order-created", async (c) => {
  const { data } = await c.req.json(); // Dapr wraps payload in .data
  // process event...
  return c.json({ status: "SUCCESS" }); // always ACK to Dapr
});
\`\`\`

### State Store (Redis via Dapr)
\`\`\`typescript
// Save state
await fetch(\`\${DAPR_URL}/v1.0/state/agent-statestore\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([{ key: "session-abc", value: sessionData }]),
});
// Get state
const res = await fetch(\`\${DAPR_URL}/v1.0/state/agent-statestore/session-abc\`);
const data = await res.json();
\`\`\`

### Service Invocation (sync agent-to-agent)
\`\`\`typescript
const res = await fetch(\`\${DAPR_URL}/v1.0/invoke/target-agent/method/endpoint\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
\`\`\`

Use Dapr when: the service is deployed to the cluster and needs to talk to other mesh-six services.
Use direct connections when: the service is standalone or needs lower latency than the sidecar adds.

## Error Handling

### TypeScript (Hono)
\`\`\`typescript
import { HTTPException } from "hono/http-exception";

// Throw typed errors — Hono catches them automatically
throw new HTTPException(404, { message: "User not found" });
throw new HTTPException(422, { message: "Invalid email format" });

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
\`\`\`

### Go (Gin)
\`\`\`go
// Define domain errors
var (
  ErrNotFound  = errors.New("not found")
  ErrForbidden = errors.New("forbidden")
)

// Map domain errors to HTTP in handlers
if errors.Is(err, ErrNotFound) {
  c.JSON(404, gin.H{"error": err.Error()})
  return
}
\`\`\`

## Code Quality Rules
1. **Parameterized queries only** — never string-interpolate SQL
2. **Validate at the edge** — Zod parse on request entry, struct tags in Go
3. **Connection pooling** — pg.Pool / pgxpool, never per-request connections
4. **Graceful shutdown** — drain connections on SIGTERM
5. **Structured logging** — JSON logs with request ID correlation
6. **Tests** — unit tests for business logic, integration tests for endpoints

## Project Structure (TypeScript/Bun)
\`\`\`
src/
├── index.ts          # Entry point, server setup
├── routes/           # Route handlers (thin — delegate to services)
├── services/         # Business logic
├── repositories/     # Data access (SQL queries, Redis ops)
├── middleware/       # Auth, rate limiting, error handling
├── schemas/          # Zod schemas for requests and DB rows
└── migrate.ts        # Migration runner
migrations/
├── 001_initial.sql
docker-compose.yaml   # PostgreSQL + Redis for local dev
\`\`\`

## Project Structure (Go)
\`\`\`
cmd/api/main.go       # Entry point
internal/
├── handler/          # HTTP handlers (thin — delegate to services)
├── service/          # Business logic
├── repo/             # Data access
├── middleware/       # Auth, rate limiting
├── model/            # Data models + validation tags
└── config/           # Env-based configuration
migrations/
├── 001_initial.up.sql
├── 001_initial.down.sql
docker-compose.yaml
\`\`\`

## Environment
- k3s cluster with Dapr sidecars
- PostgreSQL HA via CloudNativePG (use pg.Pool, not porsager)
- Redis Cluster for caching and state
- RabbitMQ for async messaging (via Dapr pub/sub)
- OpenTelemetry for observability
- Docker + Kubernetes deployment`;

// --- Tool Definitions ---
const tools = {
  search_patterns: tool({
    description: "Search memory for past API patterns and solutions",
    parameters: z.object({
      query: z.string(),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      if (!memory) return { results: [], note: "Memory not available" };
      try {
        const results = await memory.search(query, "api-coder", limit);
        return { results: results.map((r) => ({ pattern: r.memory, score: r.score })) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  analyze_openapi: tool({
    description: "Analyze OpenAPI specification for code generation",
    parameters: z.object({
      spec: z.string().describe("OpenAPI spec in JSON or YAML"),
    }),
    execute: async ({ spec }) => {
      console.log(`[${AGENT_ID}] Analyzing OpenAPI spec`);
      // Parse and extract key info
      try {
        const parsed = JSON.parse(spec);
        return {
          title: parsed.info?.title,
          version: parsed.info?.version,
          paths: Object.keys(parsed.paths || {}),
          schemas: Object.keys(parsed.components?.schemas || {}),
        };
      } catch {
        return { note: "Could not parse as JSON, treating as YAML or raw spec" };
      }
    },
  }),

  get_framework_template: tool({
    description: "Get starter template for a framework",
    parameters: z.object({
      framework: z.enum(["hono", "express", "fastify", "gin", "fiber", "echo"]),
      language: z.enum(["typescript", "go"]),
    }),
    execute: async ({ framework, language }) => {
      const templates: Record<string, string> = {
        "hono-typescript": `import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

const app = new Hono()

app.use('*', logger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

export default app`,
        "gin-go": `package main

import (
    "github.com/gin-gonic/gin"
)

func main() {
    r := gin.Default()

    r.GET("/health", func(c *gin.Context) {
        c.JSON(200, gin.H{"status": "ok"})
    })

    r.Run(":3000")
}`,
      };

      const key = `${framework}-${language}`;
      return {
        framework,
        language,
        template: templates[key] || `Template for ${framework} in ${language}`,
      };
    },
  }),
};

// --- HTTP Server ---
const app = new Hono();

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    agent: AGENT_ID,
    capabilities: REGISTRATION.capabilities.map((cap) => cap.name),
    memoryEnabled: MEMORY_ENABLED && memory !== null,
  })
);

app.get("/readyz", (c) => c.json({ status: "ok" }));

app.get("/dapr/subscribe", (c): Response => {
  const subscriptions: DaprSubscription[] = [
    { pubsubname: DAPR_PUBSUB_NAME, topic: `tasks.${AGENT_ID}`, route: "/tasks" },
  ];
  return c.json(subscriptions);
});

// --- Main Code Endpoint ---
app.post("/code", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = APICoderRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] Code request: ${request.action}`);

    const result = await handleCodeRequest(request);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] Code request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Invoke Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const request: APICoderRequest = {
    action: body.payload?.action || "generate-code",
    context: body.payload?.context || {},
    preferences: body.payload?.preferences,
  };

  const result = await handleCodeRequest(request);

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { code: result },
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
    const request: APICoderRequest = {
      action: (task.payload.action as APICoderRequest["action"]) || "generate-code",
      context: (task.payload.context as APICoderRequest["context"]) || {},
      preferences: task.payload.preferences as APICoderRequest["preferences"],
    };

    const result = await handleCodeRequest(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { code: result },
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
      error: { type: "code_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Handler ---
async function handleCodeRequest(request: APICoderRequest): Promise<APIDesign | CodeGeneration | CodeReview | string> {
  let enhancedPrompt = SYSTEM_PROMPT;

  // Add memory context
  if (memory) {
    try {
      const pastPatterns = await memory.search(
        `${request.action} ${request.context.language} ${request.context.framework || ""}`,
        "api-coder",
        3
      );
      if (pastPatterns.length > 0) {
        enhancedPrompt += `\n\n## Past Patterns\n${pastPatterns.map((p) => `- ${p.memory}`).join("\n")}`;
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Determine language
  const language = request.context.language === "auto"
    ? (request.context.framework && ["gin", "fiber", "echo", "chi"].includes(request.context.framework) ? "go" : "typescript")
    : request.context.language;

  // Build context
  const contextParts: string[] = [];
  contextParts.push(`Language: ${language}`);
  if (request.context.framework) contextParts.push(`Framework: ${request.context.framework}`);
  if (request.context.requirements) contextParts.push(`Requirements:\n${request.context.requirements}`);
  if (request.context.existingCode) contextParts.push(`Existing Code:\n${request.context.existingCode}`);
  if (request.context.openApiSpec) contextParts.push(`OpenAPI Spec:\n${request.context.openApiSpec}`);
  if (request.context.bugDescription) contextParts.push(`Bug Description:\n${request.context.bugDescription}`);
  if (request.context.featureDescription) contextParts.push(`Feature:\n${request.context.featureDescription}`);

  if (request.preferences) {
    contextParts.push(`Preferences: Runtime=${request.preferences.runtime}, Tests=${request.preferences.includeTests}, Docker=${request.preferences.includeDocker}`);
  }

  const contextPrompt = `\n\n## Context\n${contextParts.join("\n\n")}`;

  let result: APIDesign | CodeGeneration | CodeReview | string;
  const traceId = crypto.randomUUID();

  switch (request.action) {
    case "design-api": {
      const { text: analysis } = await tracedChatCompletion(
        { model: LLM_MODEL, system: enhancedPrompt, prompt: `Design a RESTful API based on these requirements.${contextPrompt}` },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await chatCompletionWithSchema({
        model: LLM_MODEL,
        schema: APIDesignSchema,
        system: enhancedPrompt,
        prompt: `Create a structured API design based on this analysis:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "generate-code": {
      const { text: analysis } = await tracedChatCompletion(
        { model: LLM_MODEL, system: enhancedPrompt, prompt: `Generate backend API code for these requirements.${contextPrompt}` },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await chatCompletionWithSchema({
        model: LLM_MODEL,
        schema: CodeGenerationSchema,
        system: enhancedPrompt,
        prompt: `Generate structured code output:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "review-code": {
      const { text: analysis } = await tracedChatCompletion(
        { model: LLM_MODEL, system: enhancedPrompt, prompt: `Review this code for quality, security, and best practices.${contextPrompt}` },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await chatCompletionWithSchema({
        model: LLM_MODEL,
        schema: CodeReviewSchema,
        system: enhancedPrompt,
        prompt: `Create a structured code review:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    default: {
      const { text } = await tracedChatCompletion(
        { model: LLM_MODEL, system: enhancedPrompt, prompt: `${request.action}:${contextPrompt}` },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
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
          { role: "user", content: `${request.action}: ${language} ${request.context.framework || ""}` },
          { role: "assistant", content: summary },
        ],
        "api-coder",
        { action: request.action, language }
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
