import { z } from "zod";

// --- Agent Capability ---
export const AgentCapabilitySchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  preferred: z.boolean().default(false),
  requirements: z.array(z.string()).default([]),
  async: z.boolean().optional(),
  estimatedDuration: z.string().optional(),
  platforms: z.array(z.string()).optional(),
});

export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

// --- Agent Registration ---
export const AgentRegistrationSchema = z.object({
  name: z.string(),
  appId: z.string(),
  capabilities: z.array(AgentCapabilitySchema),
  status: z.enum(["online", "degraded", "offline"]),
  healthChecks: z.record(z.string(), z.string()).default({}),
  lastHeartbeat: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;

// --- Task Request ---
export const TaskRequestSchema = z.object({
  id: z.string().uuid(),
  capability: z.string(),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().min(0).max(10).default(5),
  timeout: z.number().positive().default(120),
  requestedBy: z.string(),
  createdAt: z.string(),
});

export type TaskRequest = z.infer<typeof TaskRequestSchema>;

// --- Task Result ---
export const TaskResultSchema = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
  success: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      type: z.string(),
      message: z.string(),
    })
    .optional(),
  durationMs: z.number(),
  completedAt: z.string(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

// --- Agent Score Card ---
export const AgentScoreCardSchema = z.object({
  agentId: z.string(),
  capability: z.string(),
  baseWeight: z.number(),
  dependencyHealth: z.number().min(0).max(1),
  rollingSuccessRate: z.number().min(0).max(1),
  recencyBoost: z.number(),
  finalScore: z.number(),
});

export type AgentScoreCard = z.infer<typeof AgentScoreCardSchema>;

// --- Task Status (for orchestrator tracking) ---
export const TaskStatusSchema = z.object({
  taskId: z.string().uuid(),
  capability: z.string(),
  dispatchedTo: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
  status: z.enum(["pending", "dispatched", "completed", "failed", "timeout"]),
  attempts: z.number().default(0),
  result: TaskResultSchema.optional(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// --- Dapr Pub/Sub Message Wrapper ---
export interface DaprPubSubMessage<T> {
  data: T;
  datacontenttype?: string;
  id?: string;
  pubsubname?: string;
  source?: string;
  specversion?: string;
  time?: string;
  topic?: string;
  traceid?: string;
  traceparent?: string;
  tracestate?: string;
  type?: string;
}

// --- Subscription Definition ---
export interface DaprSubscription {
  pubsubname: string;
  topic: string;
  route: string;
  metadata?: Record<string, string>;
}

// --- Board Events (M4.5: GitHub Projects webhook events) ---
export const BoardEventBase = z.object({
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  projectItemId: z.string(),
  timestamp: z.string(),
});

export const NewTodoEvent = BoardEventBase.extend({
  type: z.literal("new-todo"),
  issueTitle: z.string(),
  contentNodeId: z.string(),
  detectedVia: z.enum(["webhook", "poll"]),
});

export const CardBlockedEvent = BoardEventBase.extend({
  type: z.literal("card-blocked"),
  fromColumn: z.string(),
});

export const CardUnblockedEvent = BoardEventBase.extend({
  type: z.literal("card-unblocked"),
  toColumn: z.string(),
});

export const CardMovedEvent = BoardEventBase.extend({
  type: z.literal("card-moved"),
  fromColumn: z.string(),
  toColumn: z.string(),
});

export const BoardEvent = z.discriminatedUnion("type", [
  NewTodoEvent,
  CardBlockedEvent,
  CardUnblockedEvent,
  CardMovedEvent,
]);

export type BoardEventType = z.infer<typeof BoardEvent>;
