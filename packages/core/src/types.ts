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

// ---------------------------------------------------------------------------
// Auth service types (ported from GWA)
// ---------------------------------------------------------------------------

export const ProjectConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  claudeAccountUuid: z.string().optional(),
  claudeOrgUuid: z.string().optional(),
  claudeEmail: z.string().optional(),
  settingsJson: z.string().optional(),
  claudeJson: z.string().optional(),
  mcpJson: z.string().optional(),
  claudeMd: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CredentialPushRequestSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime(),
  accountUuid: z.string().optional(),
  emailAddress: z.string().optional(),
  organizationUuid: z.string().optional(),
  billingType: z.string().optional(),
  displayName: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});
export type CredentialPushRequest = z.infer<typeof CredentialPushRequestSchema>;

export const ProjectCredentialSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime(),
  accountUuid: z.string().optional(),
  emailAddress: z.string().optional(),
  organizationUuid: z.string().optional(),
  billingType: z.string(),
  displayName: z.string(),
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
  source: z.enum(["push", "refresh", "import"]),
  pushedBy: z.string().optional(),
  createdAt: z.string().datetime(),
  invalidatedAt: z.string().datetime().optional(),
});
export type ProjectCredential = z.infer<typeof ProjectCredentialSchema>;

export const ProvisionRequestSchema = z.object({
  podName: z.string(),
  currentBundleId: z.string().optional(),
});
export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const ProvisionResponseSchema = z.object({
  status: z.enum(["current", "provisioned", "no_credentials"]),
  bundleId: z.string().optional(),
  credentialExpiresAt: z.string().datetime().optional(),
  message: z.string().optional(),
});
export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;

export const CredentialHealthSchema = z.object({
  projectId: z.string(),
  hasValidCredential: z.boolean(),
  expiresAt: z.string().datetime().optional(),
  expiresInMs: z.number().optional(),
  hasRefreshToken: z.boolean(),
  lastRefreshAt: z.string().datetime().optional(),
  activeBundleId: z.string().optional(),
});
export type CredentialHealth = z.infer<typeof CredentialHealthSchema>;

// ---------------------------------------------------------------------------
// Implementation session types
// ---------------------------------------------------------------------------

export const ImplementationSessionSchema = z.object({
  id: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  status: z.enum(["idle", "running", "blocked", "completed", "failed"]),
  actorId: z.string().optional(),
  tmuxWindow: z.number().optional(),
  credentialBundleId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});
export type ImplementationSession = z.infer<typeof ImplementationSessionSchema>;

export const SessionQuestionSchema = z.object({
  id: z.number(),
  sessionId: z.string(),
  questionText: z.string(),
  answerText: z.string().optional(),
  askedAt: z.string().datetime(),
  answeredAt: z.string().datetime().optional(),
});
export type SessionQuestion = z.infer<typeof SessionQuestionSchema>;

// ---------------------------------------------------------------------------
// Auth service constants
// ---------------------------------------------------------------------------

export const AUTH_SERVICE_APP_ID = "auth-service";
export const CREDENTIAL_REFRESHED_TOPIC = "credential-refreshed";
export const CONFIG_UPDATED_TOPIC = "config-updated";
