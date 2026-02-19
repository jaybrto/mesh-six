import { z } from "zod";

// ============================================================================
// CONSTANTS
// ============================================================================

export const DAPR_LLM_SERVICE_APP_ID = "llm-service";
export const LLM_EVENTS_TOPIC = "llm.events";
export const LLM_ACTOR_TYPE = "ClaudeCLIActor";

// ============================================================================
// OPENAI-COMPATIBLE REQUEST/RESPONSE SCHEMAS
// ============================================================================

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  /** Optional: resume an existing CLI session */
  session_id: z.string().optional(),
  /** Optional: persist the session for later resumption */
  persist_session: z.boolean().optional(),
  /** Optional: request a specific actor by capability */
  capability: z.string().optional(),
  /** Optional: JSON schema for structured output (injected into prompt) */
  response_format: z
    .object({
      type: z.literal("json_object"),
      schema: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string(),
      }),
      finish_reason: z.enum(["stop", "length", "error"]),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  /** Returned if persist_session was true */
  session_id: z.string().optional(),
});

export type ChatCompletionResponse = z.infer<
  typeof ChatCompletionResponseSchema
>;

// ============================================================================
// ACTOR TYPES
// ============================================================================

export const ActorStatusSchema = z.enum([
  "idle",
  "busy",
  "unhealthy",
  "initializing",
]);

export type ActorStatus = z.infer<typeof ActorStatusSchema>;

export const ActorInfoSchema = z.object({
  actorId: z.string(),
  credentialId: z.string(),
  status: ActorStatusSchema,
  capabilities: z.array(z.string()).default([]),
  lastUsed: z.string().optional(),
  requestCount: z.number().default(0),
  errorCount: z.number().default(0),
});

export type ActorInfo = z.infer<typeof ActorInfoSchema>;

// ============================================================================
// SERVICE STATUS
// ============================================================================

export const LLMServiceStatusSchema = z.object({
  status: z.enum(["healthy", "degraded", "unavailable"]),
  actors: z.array(ActorInfoSchema),
  allowedModels: z.array(z.string()),
  totalRequests: z.number(),
  totalErrors: z.number(),
  uptime: z.number(),
});

export type LLMServiceStatus = z.infer<typeof LLMServiceStatusSchema>;

// ============================================================================
// HOOK EVENTS (published to Dapr pub/sub by the hook script)
// ============================================================================

export const CLIHookEventSchema = z.object({
  actorId: z.string(),
  sessionId: z.string().optional(),
  timestamp: z.string(),
  hookEvent: z.string(),
  toolName: z.string().optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  toolResponse: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  durationMs: z.number().optional(),
});

export type CLIHookEvent = z.infer<typeof CLIHookEventSchema>;

// ============================================================================
// DAPR CONFIG KEYS (stored in Dapr Configuration store)
// ============================================================================

export const LLM_CONFIG_KEYS = {
  ALLOWED_MODELS: "llm-allowed-models",
  CREDENTIALS: "llm-credentials",
  ACTOR_SKILLS: "llm-actor-skills",
  ACTOR_MINIO_PATHS: "llm-actor-minio-paths",
  DEFAULT_MODEL: "llm-default-model",
} as const;
