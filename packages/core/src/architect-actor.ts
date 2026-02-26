import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARCHITECT_ACTOR_TYPE = "ArchitectActor";

// ---------------------------------------------------------------------------
// Actor State (set at activation, immutable)
// ---------------------------------------------------------------------------

export const ArchitectActorStateSchema = z.object({
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  workflowId: z.string(),
  projectItemId: z.string(),
  issueTitle: z.string(),
});
export type ArchitectActorState = z.infer<typeof ArchitectActorStateSchema>;

// ---------------------------------------------------------------------------
// Event Log Types
// ---------------------------------------------------------------------------

export const ArchitectEventSchema = z.object({
  actorId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ArchitectEvent = z.infer<typeof ArchitectEventSchema>;

export const ARCHITECT_EVENT_TYPES = [
  "activated",
  "consulted",
  "question-received",
  "question-answered",
  "human-escalated",
  "human-answered",
  "memory-stored",
  "deactivated",
] as const;
export type ArchitectEventType = (typeof ARCHITECT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Workflow Event Channel Payloads
// ---------------------------------------------------------------------------

export const PlanningEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("plan-complete"), planContent: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type PlanningEventPayload = z.infer<typeof PlanningEventPayloadSchema>;

export const ImplEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pr-created"), prNumber: z.number() }),
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type ImplEventPayload = z.infer<typeof ImplEventPayloadSchema>;

export const QaEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("test-results"), testContent: z.string() }),
  z.object({ type: z.literal("question-detected"), questionText: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session-failed"), error: z.string() }),
]);
export type QaEventPayload = z.infer<typeof QaEventPayloadSchema>;

export const HumanAnswerPayloadSchema = z.object({
  answer: z.string(),
  timestamp: z.string(),
});
export type HumanAnswerPayload = z.infer<typeof HumanAnswerPayloadSchema>;

// ---------------------------------------------------------------------------
// Actor Method I/O
// ---------------------------------------------------------------------------

export const AnswerQuestionOutputSchema = z.object({
  confident: z.boolean(),
  answer: z.string().optional(),
  bestGuess: z.string().optional(),
});
export type AnswerQuestionOutput = z.infer<typeof AnswerQuestionOutputSchema>;
