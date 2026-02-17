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
const AGENT_ID = process.env.AGENT_ID || "ui-agent";
const AGENT_NAME = process.env.AGENT_NAME || "UI Agent";
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
export const UIDesignSchema = z.object({
  summary: z.string().describe("Overview of the UI design"),
  platform: z.enum(["web", "mobile", "both"]),
  designSystem: z.object({
    colors: z.object({
      primary: z.string(),
      secondary: z.string(),
      background: z.string(),
      text: z.string(),
      accent: z.string(),
    }),
    typography: z.object({
      fontFamily: z.string(),
      headings: z.string(),
      body: z.string(),
    }),
    spacing: z.object({
      unit: z.number(),
      scale: z.array(z.number()),
    }),
  }),
  components: z.array(z.object({
    name: z.string(),
    type: z.enum(["atom", "molecule", "organism", "template", "page"]),
    description: z.string(),
    props: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      description: z.string(),
    })),
    variants: z.array(z.string()).optional(),
  })),
  screens: z.array(z.object({
    name: z.string(),
    route: z.string(),
    description: z.string(),
    components: z.array(z.string()),
    layout: z.string().describe("Description of the layout"),
  })),
  navigation: z.object({
    type: z.enum(["tabs", "drawer", "stack", "bottom-tabs", "header"]),
    items: z.array(z.object({
      label: z.string(),
      route: z.string(),
      icon: z.string().optional(),
    })),
  }),
  accessibility: z.array(z.string()).describe("Accessibility considerations"),
});
export type UIDesign = z.infer<typeof UIDesignSchema>;

export const ComponentCodeSchema = z.object({
  platform: z.enum(["react", "react-native"]),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    description: z.string(),
  })),
  dependencies: z.array(z.object({
    name: z.string(),
    version: z.string(),
    dev: z.boolean().default(false),
  })),
  storybook: z.object({
    stories: z.string().optional(),
    docs: z.string().optional(),
  }).optional(),
  tests: z.string().optional().describe("Component test file"),
});
export type ComponentCode = z.infer<typeof ComponentCodeSchema>;

export const UIReviewSchema = z.object({
  summary: z.string(),
  score: z.number().min(0).max(100),
  categories: z.object({
    accessibility: z.object({
      score: z.number(),
      issues: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
    performance: z.object({
      score: z.number(),
      issues: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
    usability: z.object({
      score: z.number(),
      issues: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
    codeQuality: z.object({
      score: z.number(),
      issues: z.array(z.string()),
      recommendations: z.array(z.string()),
    }),
  }),
  bestPractices: z.array(z.object({
    practice: z.string(),
    status: z.enum(["passed", "failed", "warning"]),
    details: z.string(),
  })),
});
export type UIReview = z.infer<typeof UIReviewSchema>;

// --- Request Schema ---
export const UIRequestSchema = z.object({
  action: z.enum([
    "design-ui",
    "generate-component",
    "generate-screen",
    "review-ui",
    "convert-design",
    "add-animation",
    "improve-accessibility",
  ]),
  context: z.object({
    platform: z.enum(["react", "react-native", "auto"]).default("auto"),
    requirements: z.string().optional(),
    existingCode: z.string().optional(),
    designSpec: z.string().optional(),
    figmaUrl: z.string().optional(),
    componentName: z.string().optional(),
    screenName: z.string().optional(),
  }),
  preferences: z.object({
    styling: z.enum(["tailwind", "styled-components", "css-modules", "nativewind"]).default("tailwind"),
    stateManagement: z.enum(["zustand", "redux", "context", "jotai"]).default("zustand"),
    includeTests: z.boolean().default(true),
    includeStorybook: z.boolean().default(false),
  }).optional(),
});
export type UIRequest = z.infer<typeof UIRequestSchema>;

// --- Agent Registration ---
const REGISTRATION: AgentRegistration = {
  name: AGENT_NAME,
  appId: AGENT_ID,
  capabilities: [
    {
      name: "ui-design",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "3m-8m",
    },
    {
      name: "component-generation",
      weight: 0.95,
      preferred: true,
      requirements: [],
      estimatedDuration: "2m-5m",
    },
    {
      name: "screen-generation",
      weight: 0.9,
      preferred: true,
      requirements: [],
      estimatedDuration: "5m-15m",
    },
    {
      name: "ui-review",
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
    specialization: "frontend-ui-development",
    platforms: ["react", "react-native"],
    styling: ["tailwind", "styled-components", "nativewind"],
    patterns: ["atomic-design", "compound-components", "render-props", "hooks"],
  },
};

// --- System Prompt ---
const SYSTEM_PROMPT = `You are the UI Agent for Jay's homelab agent mesh. You specialize in creating beautiful, accessible, and performant user interfaces with React and React Native.

## Your Expertise

### React (Web)
- **Framework**: Next.js 14+ with App Router
- **Styling**: Tailwind CSS (preferred), CSS Modules, styled-components
- **Components**: Radix UI primitives, shadcn/ui patterns
- **State**: Zustand (simple), TanStack Query (server state)
- **Forms**: React Hook Form + Zod validation
- **Animation**: Framer Motion

### React Native
- **Framework**: Expo (SDK 50+) with Expo Router
- **Styling**: NativeWind (Tailwind for RN), StyleSheet
- **Components**: Custom primitives, react-native-reanimated
- **Navigation**: Expo Router (file-based)
- **State**: Zustand, TanStack Query

## Design Principles
1. **Accessibility First**: WCAG 2.1 AA compliance, proper ARIA, keyboard navigation
2. **Mobile First**: Responsive design starting from mobile
3. **Performance**: Code splitting, lazy loading, optimized images
4. **Consistency**: Design tokens, component variants, theming
5. **Maintainability**: Atomic design, clear component API, TypeScript

## Component Patterns

### Atomic Design
- **Atoms**: Button, Input, Text, Icon
- **Molecules**: FormField, SearchBar, Card
- **Organisms**: Header, Sidebar, Form
- **Templates**: DashboardLayout, AuthLayout
- **Pages**: Home, Settings, Profile

### Component Structure (React)
\`\`\`tsx
// components/Button/Button.tsx
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { type VariantProps, cva } from 'class-variance-authority'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input hover:bg-accent',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
)
\`\`\`

## Accessibility Checklist
- [ ] Semantic HTML elements
- [ ] ARIA labels for interactive elements
- [ ] Keyboard navigation support
- [ ] Focus indicators visible
- [ ] Color contrast ratios (4.5:1 text, 3:1 UI)
- [ ] Screen reader tested
- [ ] Reduced motion support

## Performance Checklist
- [ ] Components lazy loaded where appropriate
- [ ] Images optimized (next/image, expo-image)
- [ ] Bundle size monitored
- [ ] Memoization for expensive renders
- [ ] Virtual lists for long lists`;

// --- Tool Definitions ---
const tools = {
  search_patterns: tool({
    description: "Search memory for past UI patterns and solutions",
    parameters: z.object({
      query: z.string(),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      if (!memory) return { results: [], note: "Memory not available" };
      try {
        const results = await memory.search(query, "ui-agent", limit);
        return { results: results.map((r) => ({ pattern: r.memory, score: r.score })) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  get_component_template: tool({
    description: "Get starter template for a component type",
    parameters: z.object({
      componentType: z.enum(["button", "input", "card", "modal", "form", "list", "nav"]),
      platform: z.enum(["react", "react-native"]),
      styling: z.enum(["tailwind", "styled-components", "nativewind"]),
    }),
    execute: async ({ componentType, platform, styling }) => {
      console.log(`[${AGENT_ID}] Getting template: ${componentType} for ${platform} with ${styling}`);

      const templates: Record<string, string> = {
        "button-react-tailwind": `import { cn } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline'
}

export function Button({ className, variant = 'primary', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'px-4 py-2 rounded-lg font-medium transition-colors',
        variant === 'primary' && 'bg-blue-600 text-white hover:bg-blue-700',
        variant === 'secondary' && 'bg-gray-200 text-gray-900 hover:bg-gray-300',
        variant === 'outline' && 'border-2 border-gray-300 hover:border-gray-400',
        className
      )}
      {...props}
    />
  )
}`,
        "button-react-native-nativewind": `import { Pressable, Text } from 'react-native'

interface ButtonProps {
  title: string
  variant?: 'primary' | 'secondary'
  onPress?: () => void
}

export function Button({ title, variant = 'primary', onPress }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      className={\`px-4 py-3 rounded-lg \${
        variant === 'primary' ? 'bg-blue-600' : 'bg-gray-200'
      }\`}
    >
      <Text className={\`text-center font-medium \${
        variant === 'primary' ? 'text-white' : 'text-gray-900'
      }\`}>
        {title}
      </Text>
    </Pressable>
  )
}`,
      };

      const key = `${componentType}-${platform}-${styling}`;
      return {
        componentType,
        platform,
        styling,
        template: templates[key] || `Template for ${componentType} on ${platform}`,
      };
    },
  }),

  analyze_accessibility: tool({
    description: "Analyze component code for accessibility issues",
    parameters: z.object({
      code: z.string().describe("Component code to analyze"),
    }),
    execute: async ({ code }) => {
      console.log(`[${AGENT_ID}] Analyzing accessibility`);

      const issues: string[] = [];
      const recommendations: string[] = [];

      // Simple heuristic checks
      if (!code.includes("aria-") && !code.includes("role=")) {
        issues.push("No ARIA attributes found");
        recommendations.push("Add aria-label or aria-labelledby to interactive elements");
      }

      if (code.includes("onClick") && !code.includes("onKeyDown") && !code.includes("<button")) {
        issues.push("Click handler without keyboard support");
        recommendations.push("Use button element or add onKeyDown handler");
      }

      if (code.includes("<img") && !code.includes("alt=")) {
        issues.push("Image without alt text");
        recommendations.push("Add descriptive alt text to all images");
      }

      return {
        issues,
        recommendations,
        note: "Basic heuristic analysis - run axe-core for comprehensive audit",
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

// --- Main UI Endpoint ---
app.post("/ui", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const request = UIRequestSchema.parse(body);

    console.log(`[${AGENT_ID}] UI request: ${request.action}`);

    const result = await handleUIRequest(request);

    return c.json({
      success: true,
      result,
      durationMs: Date.now() - startTime,
      agentId: AGENT_ID,
    });
  } catch (error) {
    console.error(`[${AGENT_ID}] UI request failed:`, error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// --- Invoke Endpoint ---
app.post("/invoke", async (c) => {
  const body = await c.req.json();

  const request: UIRequest = {
    action: body.payload?.action || "generate-component",
    context: body.payload?.context || {},
    preferences: body.payload?.preferences,
  };

  const result = await handleUIRequest(request);

  return c.json({
    taskId: body.id || crypto.randomUUID(),
    agentId: AGENT_ID,
    success: true,
    result: { ui: result },
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
    const request: UIRequest = {
      action: (task.payload.action as UIRequest["action"]) || "generate-component",
      context: (task.payload.context as UIRequest["context"]) || {},
      preferences: task.payload.preferences as UIRequest["preferences"],
    };

    const result = await handleUIRequest(request);

    const taskResult: TaskResult = {
      taskId: task.id,
      agentId: AGENT_ID,
      success: true,
      result: { ui: result },
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
      error: { type: "ui_error", message: String(error) },
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    await daprClient.pubsub.publish(DAPR_PUBSUB_NAME, TASK_RESULTS_TOPIC, failResult);
    return c.json({ status: "SUCCESS" });
  }
});

// --- Core Handler ---
async function handleUIRequest(request: UIRequest): Promise<UIDesign | ComponentCode | UIReview | string> {
  let enhancedPrompt = SYSTEM_PROMPT;

  // Add memory context
  if (memory) {
    try {
      const pastPatterns = await memory.search(
        `${request.action} ${request.context.platform} ${request.context.componentName || request.context.screenName || ""}`,
        "ui-agent",
        3
      );
      if (pastPatterns.length > 0) {
        enhancedPrompt += `\n\n## Past Patterns\n${pastPatterns.map((p) => `- ${p.memory}`).join("\n")}`;
      }
    } catch (error) {
      console.warn(`[${AGENT_ID}] Memory search failed:`, error);
    }
  }

  // Determine platform
  const platform = request.context.platform === "auto" ? "react" : request.context.platform;

  // Build context
  const contextParts: string[] = [];
  contextParts.push(`Platform: ${platform}`);
  if (request.context.requirements) contextParts.push(`Requirements:\n${request.context.requirements}`);
  if (request.context.existingCode) contextParts.push(`Existing Code:\n${request.context.existingCode}`);
  if (request.context.designSpec) contextParts.push(`Design Spec:\n${request.context.designSpec}`);
  if (request.context.componentName) contextParts.push(`Component Name: ${request.context.componentName}`);
  if (request.context.screenName) contextParts.push(`Screen Name: ${request.context.screenName}`);

  if (request.preferences) {
    contextParts.push(`Preferences: Styling=${request.preferences.styling}, State=${request.preferences.stateManagement}, Tests=${request.preferences.includeTests}`);
  }

  const contextPrompt = `\n\n## Context\n${contextParts.join("\n\n")}`;

  let result: UIDesign | ComponentCode | UIReview | string;
  const traceId = crypto.randomUUID();

  switch (request.action) {
    case "design-ui": {
      const { text: analysis } = await tracedGenerateText(
        { model: llm(LLM_MODEL), system: enhancedPrompt, prompt: `Design a UI system for this project.${contextPrompt}`, tools, maxSteps: 3 },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: UIDesignSchema,
        system: enhancedPrompt,
        prompt: `Create a structured UI design based on this analysis:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "generate-component":
    case "generate-screen": {
      const { text: analysis } = await tracedGenerateText(
        { model: llm(LLM_MODEL), system: enhancedPrompt, prompt: `Generate ${request.action === "generate-component" ? "a component" : "a screen"} for ${platform}.${contextPrompt}`, tools, maxSteps: 3 },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: ComponentCodeSchema,
        system: enhancedPrompt,
        prompt: `Generate structured component code:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    case "review-ui": {
      const { text: analysis } = await tracedGenerateText(
        { model: llm(LLM_MODEL), system: enhancedPrompt, prompt: `Review this UI code for accessibility, performance, and best practices.${contextPrompt}`, tools, maxSteps: 3 },
        eventLog ? { eventLog, traceId, agentId: AGENT_ID } : null
      );

      const { object } = await generateObject({
        model: llm(LLM_MODEL),
        schema: UIReviewSchema,
        system: enhancedPrompt,
        prompt: `Create a structured UI review:\n\n${analysis}`,
      });
      result = object;
      break;
    }

    default: {
      const { text } = await tracedGenerateText(
        { model: llm(LLM_MODEL), system: enhancedPrompt, prompt: `${request.action}:${contextPrompt}`, tools, maxSteps: 3 },
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
          { role: "user", content: `${request.action}: ${platform} ${request.context.componentName || ""}` },
          { role: "assistant", content: summary },
        ],
        "ui-agent",
        { action: request.action, platform }
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
