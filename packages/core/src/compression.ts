import { z } from "zod";

// --- Compression Request ---

/**
 * Sender context payload sent to the Context Service for compression.
 * The PM workflow assembles this from its accumulated Dapr workflow state
 * before delegating to a specialist agent.
 */
export const CompressionRequestSchema = z.object({
  /** Dapr app-id of the sending agent */
  sender: z.string(),
  /** Dapr app-id of the receiving agent */
  receiver: z.string(),
  /** Project identifier (repo or workflow ID) */
  projectId: z.string(),
  /** One-line task description for the receiver */
  taskSummary: z.string(),
  /** Priority 0-10 */
  priority: z.number().min(0).max(10).default(5),
  /** Full workflow state accumulated by the sender (the "large context") */
  workflowState: z.record(z.string(), z.unknown()),
  /** Sender's long-term memories relevant to this delegation */
  senderMemories: z.array(z.string()).default([]),
  /** Specific questions the sender wants the receiver to answer */
  senderQuestions: z.array(z.string()).default([]),
  /** Optional: conversation history snippet for additional context */
  conversationSnippet: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).default([]),
  /** Optional: hard constraints the receiver must respect */
  constraints: z.array(z.string()).default([]),
  /** Optional: known failures relevant to the task */
  knownFailures: z.array(z.string()).default([]),
});

export type CompressionRequest = z.infer<typeof CompressionRequestSchema>;

// --- Compression Response ---

export const CompressionResponseSchema = z.object({
  /** Whether compression succeeded */
  success: z.boolean(),
  /** The compressed context string for the receiver */
  compressedContext: z.string(),
  /** Which compression method was used */
  method: z.enum(["deterministic", "llm", "passthrough"]),
  /** Compression stats */
  stats: z.object({
    inputTokensEstimate: z.number(),
    outputTokensEstimate: z.number(),
    compressionRatio: z.number(),
    durationMs: z.number(),
  }),
  /** If LLM was used, whether validation passed */
  validationPassed: z.boolean().optional(),
  /** If compression failed, the error */
  error: z.string().optional(),
});

export type CompressionResponse = z.infer<typeof CompressionResponseSchema>;

// --- Compression Rule ---

/**
 * A deterministic compression rule that strips/transforms fields
 * based on the sender/receiver pair.
 */
export const CompressionRuleSchema = z.object({
  /** Unique rule ID */
  id: z.string(),
  /** Which sender(s) this rule applies to ("*" for all) */
  sender: z.string(),
  /** Which receiver(s) this rule applies to ("*" for all) */
  receiver: z.string(),
  /** Fields to strip from workflowState (dot-notation paths) */
  stripFields: z.array(z.string()).default([]),
  /** Fields to always preserve (overrides stripFields) */
  preserveFields: z.array(z.string()).default([]),
  /** Max number of sender memories to include */
  maxMemories: z.number().default(5),
  /** Max conversation snippet length */
  maxConversationMessages: z.number().default(4),
  /** Token ceiling below which deterministic output is considered sufficient */
  tokenCeiling: z.number().default(800),
});

export type CompressionRule = z.infer<typeof CompressionRuleSchema>;
