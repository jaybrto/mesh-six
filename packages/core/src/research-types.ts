import { z } from "zod";

// ---------------------------------------------------------------------------
// Research Sub-Workflow Types
// ---------------------------------------------------------------------------

/** Status tracking for research tasks stored in MinIO */
export const ResearchStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
]);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

/** MinIO status document for claim check pattern */
export const ResearchStatusDocSchema = z.object({
  taskId: z.string(),
  status: ResearchStatusSchema,
  prompt: z.string().optional(),
  minioKey: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});
export type ResearchStatusDoc = z.infer<typeof ResearchStatusDocSchema>;

/** Triage output from the Architect actor */
export const TriageOutputSchema = z.object({
  needsDeepResearch: z.boolean(),
  researchQuestions: z.array(z.string()).default([]),
  context: z.string(),
  suggestedSources: z.array(z.string()).default([]),
  complexity: z.enum(["low", "medium", "high"]).default("medium"),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/** Input to the ResearchAndPlan sub-workflow */
export const ResearchAndPlanInputSchema = z.object({
  taskId: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  issueTitle: z.string(),
  issueBody: z.string().default(""),
  workflowId: z.string(),
  architectActorId: z.string(),
  architectGuidance: z.string().default(""),
});
export type ResearchAndPlanInput = z.infer<typeof ResearchAndPlanInputSchema>;

/** Output from the ResearchAndPlan sub-workflow */
export const ResearchAndPlanOutputSchema = z.object({
  plan: z.string(),
  researchDocId: z.string().optional(),
  triageResult: TriageOutputSchema.optional(),
  totalResearchCycles: z.number().default(0),
  timedOut: z.boolean().default(false),
});
export type ResearchAndPlanOutput = z.infer<typeof ResearchAndPlanOutputSchema>;

/** Result from the research review activity */
export const ReviewResearchOutputSchema = z.object({
  status: z.enum(["APPROVED", "INCOMPLETE"]),
  formattedMarkdown: z.string().optional(),
  cleanMinioId: z.string().optional(),
  missingInformation: z.string().optional(),
});
export type ReviewResearchOutput = z.infer<typeof ReviewResearchOutputSchema>;

/** Input for starting deep research */
export const StartDeepResearchInputSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  researchQuestions: z.array(z.string()),
  suggestedSources: z.array(z.string()).default([]),
  followUpPrompt: z.string().optional(),
});
export type StartDeepResearchInput = z.infer<typeof StartDeepResearchInputSchema>;

/** Output from starting deep research */
export const StartDeepResearchOutputSchema = z.object({
  status: z.enum(["STARTED", "COMPLETED", "FAILED"]),
  statusDocKey: z.string(),
  error: z.string().optional(),
});
export type StartDeepResearchOutput = z.infer<typeof StartDeepResearchOutputSchema>;

/** Input for reviewing research results */
export const ReviewResearchInputSchema = z.object({
  taskId: z.string(),
  rawMinioId: z.string(),
  originalPrompt: z.string(),
  researchQuestions: z.array(z.string()),
});
export type ReviewResearchInput = z.infer<typeof ReviewResearchInputSchema>;

/** Input for drafting the final plan */
export const DraftPlanInputSchema = z.object({
  taskId: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  issueTitle: z.string(),
  issueBody: z.string().default(""),
  initialContext: z.string(),
  deepResearchDocId: z.string().optional(),
  architectGuidance: z.string().default(""),
});
export type DraftPlanInput = z.infer<typeof DraftPlanInputSchema>;

/** Input for the architect triage activity */
export const ArchitectTriageInputSchema = z.object({
  taskId: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  issueTitle: z.string(),
  issueBody: z.string().default(""),
  architectGuidance: z.string().default(""),
});
export type ArchitectTriageInput = z.infer<typeof ArchitectTriageInputSchema>;

/** Input for sending push notifications */
export const SendPushNotificationInputSchema = z.object({
  message: z.string(),
  title: z.string().optional(),
  priority: z.enum(["min", "low", "default", "high", "urgent"]).default("default"),
  tags: z.array(z.string()).default([]),
});
export type SendPushNotificationInput = z.infer<typeof SendPushNotificationInputSchema>;

// ---------------------------------------------------------------------------
// Research session database types
// ---------------------------------------------------------------------------

export const ResearchSessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workflowId: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  status: ResearchStatusSchema,
  triageResult: z.record(z.string(), z.unknown()).optional(),
  researchCycles: z.number().default(0),
  rawMinioKey: z.string().optional(),
  cleanMinioKey: z.string().optional(),
  finalPlan: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});
export type ResearchSession = z.infer<typeof ResearchSessionSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESEARCH_BUCKET = "mesh-six-research";
export const RESEARCH_STATUS_PREFIX = "research/status";
export const RESEARCH_RAW_PREFIX = "research/raw";
export const RESEARCH_CLEAN_PREFIX = "research/clean";
export const SCRAPER_SERVICE_APP_ID = "mac-mini-scraper";
export const SCRAPE_COMPLETED_EVENT = "ScrapeCompleted";
export const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_RESEARCH_CYCLES = 3;
