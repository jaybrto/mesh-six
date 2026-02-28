import { z } from "zod";

// ---------------------------------------------------------------------------
// Research Sub-Workflow Types & Constants
// ---------------------------------------------------------------------------

/** Status of a research session lifecycle */
export const ResearchSessionStatusSchema = z.enum([
  "TRIAGING",
  "DISPATCHED",
  "IN_PROGRESS",
  "REVIEW",
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
]);
export type ResearchSessionStatus = z.infer<typeof ResearchSessionStatusSchema>;

/** Review verdict from the Researcher review phase */
export const ReviewVerdictSchema = z.enum(["APPROVED", "INCOMPLETE"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

// ---------------------------------------------------------------------------
// Workflow I/O Schemas
// ---------------------------------------------------------------------------

/** Input to the ResearchAndPlan sub-workflow */
export const ResearchAndPlanInputSchema = z.object({
  taskId: z.string().min(1),
  issueNumber: z.number(),
  issueTitle: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  workflowId: z.string().min(1),
  architectActorId: z.string().min(1),
  projectItemId: z.string().optional(),
});
export type ResearchAndPlanInput = z.infer<typeof ResearchAndPlanInputSchema>;

/** Output of the ResearchAndPlan sub-workflow */
export const ResearchAndPlanOutputSchema = z.object({
  plan: z.string(),
  researchCompleted: z.boolean(),
  totalResearchCycles: z.number(),
  timedOut: z.boolean(),
  deepResearchDocId: z.string().nullable(),
});
export type ResearchAndPlanOutput = z.infer<typeof ResearchAndPlanOutputSchema>;

// ---------------------------------------------------------------------------
// Activity I/O Schemas
// ---------------------------------------------------------------------------

/** Triage activity input */
export const ArchitectTriageInputSchema = z.object({
  taskId: z.string().min(1),
  issueNumber: z.number(),
  issueTitle: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  workflowId: z.string().min(1),
});
export type ArchitectTriageInput = z.infer<typeof ArchitectTriageInputSchema>;

/** Triage activity output */
export const ArchitectTriageOutputSchema = z.object({
  needsDeepResearch: z.boolean(),
  context: z.string(),
  researchPrompt: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ArchitectTriageOutput = z.infer<typeof ArchitectTriageOutputSchema>;

/** Start deep research activity input */
export const StartDeepResearchInputSchema = z.object({
  taskId: z.string().min(1),
  workflowId: z.string().min(1),
  prompt: z.string().min(1),
  followUpPrompt: z.string().optional(),
  sessionId: z.string().optional(),
});
export type StartDeepResearchInput = z.infer<typeof StartDeepResearchInputSchema>;

/** Start deep research activity output */
export const StartDeepResearchOutputSchema = z.object({
  status: z.enum(["STARTED", "COMPLETED", "FAILED"]),
  statusDocKey: z.string(),
  rawMinioKey: z.string().optional(),
});
export type StartDeepResearchOutput = z.infer<typeof StartDeepResearchOutputSchema>;

/** Review research activity input */
export const ReviewResearchInputSchema = z.object({
  taskId: z.string().min(1),
  rawMinioKey: z.string().min(1),
  originalPrompt: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ReviewResearchInput = z.infer<typeof ReviewResearchInputSchema>;

/** Review research activity output */
export const ReviewResearchOutputSchema = z.object({
  status: ReviewVerdictSchema,
  cleanMinioKey: z.string().optional(),
  newFollowUpPrompt: z.string().optional(),
  formattedMarkdown: z.string().optional(),
});
export type ReviewResearchOutput = z.infer<typeof ReviewResearchOutputSchema>;

/** Architect draft plan activity input */
export const ArchitectDraftPlanInputSchema = z.object({
  taskId: z.string().min(1),
  issueNumber: z.number(),
  issueTitle: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  initialContext: z.string(),
  deepResearchDocId: z.string().nullable(),
  researchFailed: z.boolean().optional(),
  failureReason: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ArchitectDraftPlanInput = z.infer<typeof ArchitectDraftPlanInputSchema>;

/** Push notification activity input */
export const SendPushNotificationInputSchema = z.object({
  message: z.string().min(1),
  title: z.string().optional(),
  priority: z.enum(["min", "low", "default", "high", "max"]).optional(),
});
export type SendPushNotificationInput = z.infer<typeof SendPushNotificationInputSchema>;

/** Update research session status activity input */
export const UpdateResearchSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  status: ResearchSessionStatusSchema,
  rawMinioKey: z.string().optional(),
  cleanMinioKey: z.string().optional(),
  researchCycles: z.number().optional(),
  completedAt: z.boolean().optional(),
});
export type UpdateResearchSessionInput = z.infer<typeof UpdateResearchSessionInputSchema>;

// ---------------------------------------------------------------------------
// LLM Response Schemas
// ---------------------------------------------------------------------------

/** Triage LLM response schema */
export const TriageLLMResponseSchema = z.object({
  needsDeepResearch: z.boolean(),
  reasoning: z.string(),
  researchPrompt: z.string().optional(),
  estimatedComplexity: z.enum(["low", "medium", "high"]).optional(),
});
export type TriageLLMResponse = z.infer<typeof TriageLLMResponseSchema>;

/** Review LLM response schema */
export const ReviewLLMResponseSchema = z.object({
  status: ReviewVerdictSchema,
  formattedMarkdown: z.string().optional(),
  missingInformation: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ReviewLLMResponse = z.infer<typeof ReviewLLMResponseSchema>;

// ---------------------------------------------------------------------------
// Scrape event payload (from external scraper service)
// ---------------------------------------------------------------------------

/** Payload sent via raiseEvent when scrape completes */
export const ScrapeCompletedPayloadSchema = z.object({
  minioKey: z.string().min(1),
  taskId: z.string().optional(),
});
export type ScrapeCompletedPayload = z.infer<typeof ScrapeCompletedPayloadSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** External event name for scrape completion */
export const SCRAPE_COMPLETED_EVENT = "ScrapeCompleted";

/** Maximum number of research dispatch→review cycles */
export const MAX_RESEARCH_CYCLES = 3;

/** Timeout for waiting on scraper results (15 minutes) */
export const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000;

/** MinIO bucket for research artifacts */
export const RESEARCH_MINIO_BUCKET = "mesh-six-research";

/** LLM model for triage + plan drafting (Architect) */
export const LLM_MODEL_PRO = process.env.LLM_MODEL_PRO || "gemini/gemini-1.5-pro";

/** LLM model for review + validation (Researcher) */
export const LLM_MODEL_FLASH = process.env.LLM_MODEL_FLASH || "gemini/gemini-1.5-flash";

/** Scraper service Dapr app ID (env-configurable per Gemini review) */
export const SCRAPER_SERVICE_APP_ID_RESEARCH =
  process.env.SCRAPER_SERVICE_APP_ID || "scraper-service";

/** Max characters for LLM context (raised from 50k per Gemini review — Gemini supports 1M+ tokens) */
export const MAX_RESEARCH_CONTEXT_CHARS = 500_000;

/** Timeout sentinel value for discriminated timeout detection (fixes C2) */
export const TIMEOUT_SENTINEL = "__TIMEOUT__" as const;
