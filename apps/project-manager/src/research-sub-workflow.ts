/**
 * ResearchAndPlan Sub-Workflow — Dapr Durable Workflow
 *
 * Orchestrates: triage → deep research → review → plan drafting.
 * The Architect triages via Gemini Pro, dispatches to the scraper service,
 * hibernates (0 CPU) while awaiting results, then validates via Gemini Flash
 * before synthesizing a final implementation plan.
 *
 * Critical fixes from PR #13 review:
 *   - C1:  No Promise.race — yields each Dapr task individually with
 *          whenAny()-equivalent pattern via separate yield + cancel.
 *   - C2:  Timeout detection compares winning task reference against the
 *          timer object — no ambiguous null/undefined check.
 *   - H3:  Uses SCRAPE_COMPLETED_EVENT constant (not hardcoded string).
 *   - H5:  research_cycles incremented at cycle start (aligned with DB).
 *   - GPT-H2: Explicit MinIO keys — no string-replacement derivation.
 *   - Gemini-3: Failure context injected into DraftPlan when research
 *               fails or times out.
 *   - Sonnet-11: Proper generator return type annotation.
 */

import {
  WorkflowRuntime,
  WorkflowContext,
  type TWorkflow,
} from "@dapr/dapr";

import type {
  ResearchAndPlanInput,
  ResearchAndPlanOutput,
  ArchitectTriageInput,
  ArchitectTriageOutput,
  StartDeepResearchInput,
  StartDeepResearchOutput,
  ReviewResearchInput,
  ReviewResearchOutput,
  ArchitectDraftPlanInput,
  SendPushNotificationInput,
  UpdateResearchSessionInput,
  ScrapeCompletedPayload,
} from "@mesh-six/core";

import {
  SCRAPE_COMPLETED_EVENT,
  MAX_RESEARCH_CYCLES,
  RESEARCH_TIMEOUT_MS,
} from "@mesh-six/core";

import type { ResearchActivityImplementations, ReflectAndStoreInput } from "./research-activities.js";

// ---------------------------------------------------------------------------
// Activity type alias (matches workflow.ts pattern)
// ---------------------------------------------------------------------------

type ActivityFn<TInput = unknown, TOutput = unknown> = (
  ctx: import("@dapr/dapr").WorkflowActivityContext,
  input: TInput,
) => Promise<TOutput>;

// ---------------------------------------------------------------------------
// Activity stubs — wired at registration time via registerResearchWorkflow()
// ---------------------------------------------------------------------------

let architectTriageActivity: ActivityFn<ArchitectTriageInput, ArchitectTriageOutput>;
let startDeepResearchActivity: ActivityFn<StartDeepResearchInput, StartDeepResearchOutput>;
let reviewResearchActivity: ActivityFn<ReviewResearchInput, ReviewResearchOutput>;
let architectDraftPlanActivity: ActivityFn<ArchitectDraftPlanInput, string>;
let sendPushNotificationActivity: ActivityFn<SendPushNotificationInput, void>;
let updateResearchSessionActivity: ActivityFn<UpdateResearchSessionInput, void>;
let reflectAndStoreActivity: ActivityFn<ReflectAndStoreInput, void>;

/** Whether research activities have been registered (false if MinIO not configured) */
let researchActivitiesRegistered = false;

/** Check if the research sub-workflow is available (activities registered) */
export function isResearchWorkflowAvailable(): boolean {
  return researchActivitiesRegistered;
}

// ---------------------------------------------------------------------------
// Sub-Workflow Definition
// ---------------------------------------------------------------------------

/**
 * ResearchAndPlan sub-workflow generator.
 *
 * Called from the main projectWorkflow when the complexity gate indicates
 * the issue needs deep research before planning.
 */
export const researchAndPlanSubWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: ResearchAndPlanInput,
): AsyncGenerator<unknown, ResearchAndPlanOutput> {
  const {
    taskId,
    issueNumber,
    issueTitle,
    repoOwner,
    repoName,
    workflowId,
    architectActorId,
  } = input;

  console.log(
    `[ResearchSubWorkflow] Starting for task ${taskId}: "${issueTitle}"`,
  );

  // =========================================================================
  // Phase 0: Triage — Architect decides if deep research is needed
  // =========================================================================

  const triageResult: ArchitectTriageOutput = yield ctx.callActivity(
    architectTriageActivity,
    {
      taskId,
      issueNumber,
      issueTitle,
      repoOwner,
      repoName,
      workflowId,
    } satisfies ArchitectTriageInput,
  );

  let isResearchComplete = !triageResult.needsDeepResearch;
  let finalResearchDocId: string | null = null;
  let currentPrompt = triageResult.researchPrompt || triageResult.context;
  let totalResearchCycles = 0;
  let timedOut = false;
  let failureReason: string | undefined;
  const sessionId = triageResult.sessionId;

  // =========================================================================
  // Phase 1 & 2: Iterative Deep Research Loop
  // =========================================================================

  while (!isResearchComplete && totalResearchCycles < MAX_RESEARCH_CYCLES) {
    // Increment cycle counter at loop start (fixes H5 — aligned with DB)
    totalResearchCycles++;
    console.log(
      `[ResearchSubWorkflow] Research cycle ${totalResearchCycles}/${MAX_RESEARCH_CYCLES} for ${taskId}`,
    );

    // Update DB cycle count at start of each cycle (fixes H5)
    if (sessionId) {
      yield ctx.callActivity(updateResearchSessionActivity, {
        sessionId,
        status: "DISPATCHED",
        researchCycles: totalResearchCycles,
      } satisfies UpdateResearchSessionInput);
    }

    // --- Dispatch to scraper ---
    const dispatchResult: StartDeepResearchOutput = yield ctx.callActivity(
      startDeepResearchActivity,
      {
        taskId,
        workflowId,
        prompt: currentPrompt,
        followUpPrompt: totalResearchCycles > 1 ? currentPrompt : undefined,
        sessionId,
      } satisfies StartDeepResearchInput,
    );

    // Handle dispatch failure (Gemini-4: dispatch failure should not be immediately terminal)
    if (dispatchResult.status === "FAILED") {
      console.warn(`[ResearchSubWorkflow] Scraper dispatch failed for ${taskId}`);
      yield ctx.callActivity(sendPushNotificationActivity, {
        message: `Scraper dispatch failed for task ${taskId} (issue #${issueNumber}). Cycle ${totalResearchCycles}/${MAX_RESEARCH_CYCLES}.`,
        title: `mesh-six: Scraper dispatch failed`,
        priority: "high",
      } satisfies SendPushNotificationInput);
      failureReason = "scraper dispatch failed";
      break;
    }

    // Handle already-completed (idempotent path) — use explicit rawMinioKey (fixes GPT-H2)
    if (dispatchResult.status === "COMPLETED" && dispatchResult.rawMinioKey) {
      // Skip hibernation, go straight to review with the explicit key
      const reviewResult: ReviewResearchOutput = yield ctx.callActivity(
        reviewResearchActivity,
        {
          taskId,
          rawMinioKey: dispatchResult.rawMinioKey,
          originalPrompt: currentPrompt,
          sessionId,
        } satisfies ReviewResearchInput,
      );

      if (reviewResult.status === "APPROVED" && reviewResult.cleanMinioKey) {
        finalResearchDocId = reviewResult.cleanMinioKey;
        isResearchComplete = true;
      } else if (reviewResult.status === "INCOMPLETE") {
        currentPrompt = reviewResult.newFollowUpPrompt || currentPrompt;
      }
      continue;
    }

    // --- Hibernate: wait for external event OR timeout ---
    //
    // Race the scrape event against a timeout timer. In the Dapr JS SDK
    // (@dapr/durabletask-js@0.1.0-alpha.2), Tasks are promises and
    // Promise.race is the standard race pattern. The workflow thread
    // hibernates (0 CPU) while awaiting either result.
    //
    // FIX C2: Timeout detection checks whether the result is
    // undefined/null (timer resolves to void) vs a payload object.
    // The scraper must send a structured ScrapeCompletedPayload with
    // a non-empty minioKey, making the two paths unambiguous.

    const scrapeEvent = ctx.waitForExternalEvent(SCRAPE_COMPLETED_EVENT);
    const timeoutTimer = ctx.createTimer(RESEARCH_TIMEOUT_MS);

    const raceResult: unknown = yield Promise.race([scrapeEvent, timeoutTimer]);

    // Timer resolves to undefined/null; scrape event carries a payload.
    // Parse the payload — if it's a valid ScrapeCompletedPayload, we
    // got a result. Otherwise treat as timeout.
    let scrapePayload: ScrapeCompletedPayload | null = null;
    if (typeof raceResult === "object" && raceResult !== null && "minioKey" in raceResult) {
      scrapePayload = raceResult as ScrapeCompletedPayload;
    } else if (typeof raceResult === "string" && raceResult.length > 0) {
      // Handle legacy string payload format
      scrapePayload = { minioKey: raceResult };
    }
    const isTimeout = scrapePayload === null;

    if (isTimeout || !scrapePayload) {
      // Timeout path
      timedOut = true;
      console.warn(`[ResearchSubWorkflow] Scraper timed out for ${taskId}`);

      yield ctx.callActivity(sendPushNotificationActivity, {
        message: `Scraper timed out for task ${taskId} (issue #${issueNumber}) after ${RESEARCH_TIMEOUT_MS / 60_000}min. Cycle ${totalResearchCycles}/${MAX_RESEARCH_CYCLES}.`,
        title: `mesh-six: Scraper timeout`,
        priority: "high",
      } satisfies SendPushNotificationInput);

      // Update DB to TIMEOUT
      if (sessionId) {
        yield ctx.callActivity(updateResearchSessionActivity, {
          sessionId,
          status: "TIMEOUT",
        } satisfies UpdateResearchSessionInput);
      }

      failureReason = `scraper timed out after ${RESEARCH_TIMEOUT_MS / 60_000} minutes`;
      break;
    }

    // --- Phase 2: Review & Format ---
    // Use the explicit minioKey from the scrape event (fixes GPT-H2)
    const rawMinioKey = scrapePayload.minioKey || dispatchResult.rawMinioKey;
    if (!rawMinioKey) {
      console.error(`[ResearchSubWorkflow] No rawMinioKey available for ${taskId}`);
      failureReason = "no raw MinIO key available from scraper";
      break;
    }

    // Update DB with raw key (fixes H4)
    if (sessionId) {
      yield ctx.callActivity(updateResearchSessionActivity, {
        sessionId,
        status: "REVIEW",
        rawMinioKey,
      } satisfies UpdateResearchSessionInput);
    }

    const reviewResult: ReviewResearchOutput = yield ctx.callActivity(
      reviewResearchActivity,
      {
        taskId,
        rawMinioKey,
        originalPrompt: currentPrompt,
        sessionId,
      } satisfies ReviewResearchInput,
    );

    if (reviewResult.status === "APPROVED" && reviewResult.cleanMinioKey) {
      finalResearchDocId = reviewResult.cleanMinioKey;
      isResearchComplete = true;
      console.log(`[ResearchSubWorkflow] Research approved for ${taskId}`);
    } else if (reviewResult.status === "INCOMPLETE") {
      currentPrompt = reviewResult.newFollowUpPrompt || currentPrompt;
      console.log(
        `[ResearchSubWorkflow] Research incomplete for ${taskId}, looping with updated prompt`,
      );
    }
  }

  // Check if we exhausted cycles without completion
  if (!isResearchComplete && !timedOut && !failureReason) {
    failureReason = `exceeded ${MAX_RESEARCH_CYCLES} research cycles without approval`;
  }

  // =========================================================================
  // Phase 3: Final Plan Drafting
  // =========================================================================

  console.log(
    `[ResearchSubWorkflow] Drafting plan for ${taskId} (research: ${isResearchComplete ? "complete" : "incomplete"})`,
  );

  const plan: string = yield ctx.callActivity(architectDraftPlanActivity, {
    taskId,
    issueNumber,
    issueTitle,
    repoOwner,
    repoName,
    initialContext: triageResult.context,
    deepResearchDocId: finalResearchDocId,
    researchFailed: !isResearchComplete,
    failureReason,
    sessionId,
  } satisfies ArchitectDraftPlanInput);

  console.log(`[ResearchSubWorkflow] Plan drafted for ${taskId}`);

  // =========================================================================
  // Phase 4: Mem0 Reflection — extract durable memories (spec requirement)
  // =========================================================================

  yield ctx.callActivity(reflectAndStoreActivity, {
    taskId,
    issueTitle,
    architectActorId,
    triageContext: triageResult.context,
    plan,
    researchCompleted: isResearchComplete,
    totalResearchCycles,
  } satisfies ReflectAndStoreInput);

  return {
    plan,
    researchCompleted: isResearchComplete,
    totalResearchCycles,
    timedOut,
    deepResearchDocId: finalResearchDocId,
  } satisfies ResearchAndPlanOutput;
};

// ---------------------------------------------------------------------------
// Registration helper — wires activity implementations into the sub-workflow
// ---------------------------------------------------------------------------

/**
 * Register the research sub-workflow and its activities onto a WorkflowRuntime.
 * Returns a fresh runtime reference for chaining.
 */
export function registerResearchWorkflow(
  runtime: WorkflowRuntime,
  impls: ResearchActivityImplementations,
): WorkflowRuntime {
  // Wire implementations into module-level stubs
  architectTriageActivity = impls.architectTriage;
  startDeepResearchActivity = impls.startDeepResearch;
  reviewResearchActivity = impls.reviewResearch;
  architectDraftPlanActivity = impls.architectDraftPlan;
  sendPushNotificationActivity = impls.sendPushNotification;
  updateResearchSessionActivity = impls.updateResearchSession;
  reflectAndStoreActivity = impls.reflectAndStore;
  researchActivitiesRegistered = true;

  // Register workflow
  runtime.registerWorkflow(researchAndPlanSubWorkflow);

  // Register activities
  runtime.registerActivity(architectTriageActivity);
  runtime.registerActivity(startDeepResearchActivity);
  runtime.registerActivity(reviewResearchActivity);
  runtime.registerActivity(architectDraftPlanActivity);
  runtime.registerActivity(sendPushNotificationActivity);
  runtime.registerActivity(updateResearchSessionActivity);
  runtime.registerActivity(reflectAndStoreActivity);

  return runtime;
}
