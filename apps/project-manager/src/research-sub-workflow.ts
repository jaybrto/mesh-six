/**
 * ResearchAndPlan Sub-Workflow
 *
 * Implements the triage-escalate-review loop for complex architectural planning.
 * Pattern: Architect triages → Researcher dispatches deep research → Review loop → Draft plan.
 *
 * Uses the Claim Check pattern via MinIO for large research documents, and
 * Dapr external events for async scraper coordination.
 *
 * Flow:
 *   1. Architect triages the task (needs deep research?)
 *   2. If yes: dispatch scraper → hibernate (0 CPU) → wake on event/timeout
 *   3. Researcher reviews raw scrape → approve or loop
 *   4. Architect drafts final plan from triage context + clean research
 */

import {
  WorkflowActivityContext,
  WorkflowContext,
  type TWorkflow,
  WorkflowRuntime,
} from "@dapr/dapr";

import type {
  ArchitectTriageInput,
  TriageOutput,
  StartDeepResearchInput,
  StartDeepResearchOutput,
  ReviewResearchInput,
  ReviewResearchOutput,
  DraftPlanInput,
  SendPushNotificationInput,
  ResearchAndPlanInput,
  ResearchAndPlanOutput,
} from "@mesh-six/core";

import {
  RESEARCH_TIMEOUT_MS,
  MAX_RESEARCH_CYCLES,
} from "@mesh-six/core";

// ---------------------------------------------------------------------------
// Activity stubs — wired at runtime via registerResearchActivities()
// ---------------------------------------------------------------------------

type ActivityFn<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowActivityContext,
  input: TInput,
) => Promise<TOutput>;

export let architectTriageActivity: ActivityFn<ArchitectTriageInput, TriageOutput> =
  async () => { throw new Error("architectTriageActivity not initialized"); };

export let startDeepResearchActivity: ActivityFn<StartDeepResearchInput, StartDeepResearchOutput> =
  async () => { throw new Error("startDeepResearchActivity not initialized"); };

export let reviewResearchActivity: ActivityFn<ReviewResearchInput, ReviewResearchOutput> =
  async () => { throw new Error("reviewResearchActivity not initialized"); };

export let architectDraftPlanActivity: ActivityFn<DraftPlanInput, string> =
  async () => { throw new Error("architectDraftPlanActivity not initialized"); };

export let sendPushNotificationActivity: ActivityFn<SendPushNotificationInput, void> =
  async () => { throw new Error("sendPushNotificationActivity not initialized"); };

// ---------------------------------------------------------------------------
// Sub-Workflow Definition
// ---------------------------------------------------------------------------

/**
 * ResearchAndPlanSubWorkflow — called from the main projectWorkflow via
 * ctx.callActivity or registered as a child workflow.
 *
 * This is a Dapr Durable Workflow (generator function) that orchestrates
 * the triage → research → review → plan pipeline.
 */
export const researchAndPlanSubWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: ResearchAndPlanInput,
): any {
  const {
    taskId,
    issueNumber,
    repoOwner,
    repoName,
    issueTitle,
    issueBody,
    workflowId,
    architectActorId,
    architectGuidance,
  } = input;

  console.log(
    `[ResearchSubWorkflow] Starting for task ${taskId}, issue #${issueNumber}`,
  );

  // =========================================================================
  // Phase 1: Triage — Architect determines if deep research is needed
  // =========================================================================

  const triageResult: TriageOutput = yield ctx.callActivity(
    architectTriageActivity,
    {
      taskId,
      issueNumber,
      repoOwner,
      repoName,
      issueTitle,
      issueBody,
      architectGuidance,
    } satisfies ArchitectTriageInput,
  );

  let isResearchComplete = !triageResult.needsDeepResearch;
  let finalResearchDocId: string | null = null;
  let totalResearchCycles = 0;
  let currentFollowUpPrompt: string | undefined;
  let timedOut = false;

  console.log(
    `[ResearchSubWorkflow] Triage complete for task ${taskId}: needsDeepResearch=${triageResult.needsDeepResearch}, complexity=${triageResult.complexity}`,
  );

  // =========================================================================
  // Phase 2: Iterative Deep Research Loop
  // =========================================================================

  while (!isResearchComplete && totalResearchCycles < MAX_RESEARCH_CYCLES) {
    totalResearchCycles++;
    console.log(
      `[ResearchSubWorkflow] Research cycle ${totalResearchCycles}/${MAX_RESEARCH_CYCLES} for task ${taskId}`,
    );

    // --- Dispatch research and hibernate ---
    const researchPrompt = currentFollowUpPrompt
      ? `Follow-up research: ${currentFollowUpPrompt}\n\nOriginal context: ${triageResult.context}`
      : `Research the following for issue #${issueNumber} (${issueTitle}):\n\n${triageResult.context}`;

    const dispatchResult: StartDeepResearchOutput = yield ctx.callActivity(
      startDeepResearchActivity,
      {
        taskId,
        prompt: researchPrompt,
        researchQuestions: triageResult.researchQuestions,
        suggestedSources: triageResult.suggestedSources,
        followUpPrompt: currentFollowUpPrompt,
      } satisfies StartDeepResearchInput,
    );

    let scrapeResultKey: string | null = null;

    if (dispatchResult.status === "COMPLETED") {
      // Claim check: research already done (idempotent)
      console.log(
        `[ResearchSubWorkflow] Research already completed for task ${taskId}`,
      );
    } else if (dispatchResult.status === "FAILED") {
      console.error(
        `[ResearchSubWorkflow] Research dispatch failed: ${dispatchResult.error}`,
      );
      break; // Fall through to plan with triage context only
    } else {
      // STARTED — hibernate and wait for scraper callback or timeout
      // Workflow thread shuts down here (0 CPU)
      const scrapeEvent = ctx.waitForExternalEvent("ScrapeCompleted");
      const timeoutTimer = ctx.createTimer(RESEARCH_TIMEOUT_MS);

      const raceResult: unknown = yield Promise.race([scrapeEvent, timeoutTimer]);

      // Check if we got a timeout (timer resolves to undefined)
      if (raceResult === undefined || raceResult === null) {
        console.warn(
          `[ResearchSubWorkflow] Scraper timed out after ${RESEARCH_TIMEOUT_MS / 1000}s for task ${taskId}`,
        );
        yield ctx.callActivity(sendPushNotificationActivity, {
          message: `Scraper timed out on task ${taskId} (issue #${issueNumber}: ${issueTitle})`,
          title: "Research Timeout",
          priority: "high" as const,
          tags: ["warning", "research"],
        } satisfies SendPushNotificationInput);
        timedOut = true;
        break; // Fall through to plan with triage context only
      }

      // raceResult is the MinIO key from the ScrapeCompleted event
      scrapeResultKey = typeof raceResult === "string" ? raceResult : null;
      console.log(
        `[ResearchSubWorkflow] Scrape completed for task ${taskId}, raw key: ${scrapeResultKey}`,
      );
    }

    // --- Review & Format ---
    const rawMinioId =
      dispatchResult.status === "COMPLETED"
        ? dispatchResult.statusDocKey.replace("status.json", "raw-scraper-result.md")
        : (scrapeResultKey ?? `research/raw/${taskId}/raw-scraper-result.md`);

    const reviewResult: ReviewResearchOutput = yield ctx.callActivity(
      reviewResearchActivity,
      {
        taskId,
        rawMinioId,
        originalPrompt: researchPrompt,
        researchQuestions: triageResult.researchQuestions,
      } satisfies ReviewResearchInput,
    );

    if (reviewResult.status === "APPROVED") {
      finalResearchDocId = reviewResult.cleanMinioId ?? null;
      isResearchComplete = true;
      console.log(
        `[ResearchSubWorkflow] Research approved for task ${taskId}, clean doc: ${finalResearchDocId}`,
      );
    } else {
      // INCOMPLETE — loop back with updated questions
      currentFollowUpPrompt = reviewResult.missingInformation;
      console.log(
        `[ResearchSubWorkflow] Research incomplete for task ${taskId}, missing: ${reviewResult.missingInformation}`,
      );
    }
  }

  if (!isResearchComplete && totalResearchCycles >= MAX_RESEARCH_CYCLES) {
    console.warn(
      `[ResearchSubWorkflow] Max research cycles (${MAX_RESEARCH_CYCLES}) reached for task ${taskId}`,
    );
  }

  // =========================================================================
  // Phase 3: Draft Final Plan
  // =========================================================================

  console.log(
    `[ResearchSubWorkflow] Drafting final plan for task ${taskId}`,
  );

  const finalPlan: string = yield ctx.callActivity(
    architectDraftPlanActivity,
    {
      taskId,
      issueNumber,
      repoOwner,
      repoName,
      issueTitle,
      issueBody,
      initialContext: triageResult.context,
      deepResearchDocId: finalResearchDocId ?? undefined,
      architectGuidance,
    } satisfies DraftPlanInput,
  );

  console.log(
    `[ResearchSubWorkflow] Plan drafted for task ${taskId} (${finalPlan.length} chars)`,
  );

  return {
    plan: finalPlan,
    researchDocId: finalResearchDocId ?? undefined,
    triageResult,
    totalResearchCycles,
    timedOut,
  } satisfies ResearchAndPlanOutput;
};

// ---------------------------------------------------------------------------
// Activity implementations interface
// ---------------------------------------------------------------------------

export interface ResearchActivityImplementations {
  architectTriage: typeof architectTriageActivity;
  startDeepResearch: typeof startDeepResearchActivity;
  reviewResearch: typeof reviewResearchActivity;
  architectDraftPlan: typeof architectDraftPlanActivity;
  sendPushNotification: typeof sendPushNotificationActivity;
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Wire activity implementations and register the sub-workflow + activities
 * with the provided WorkflowRuntime.
 */
export function registerResearchWorkflow(
  runtime: WorkflowRuntime,
  impls: ResearchActivityImplementations,
): void {
  // Wire implementations to module-level stubs
  architectTriageActivity = impls.architectTriage;
  startDeepResearchActivity = impls.startDeepResearch;
  reviewResearchActivity = impls.reviewResearch;
  architectDraftPlanActivity = impls.architectDraftPlan;
  sendPushNotificationActivity = impls.sendPushNotification;

  // Register the sub-workflow
  runtime.registerWorkflow(researchAndPlanSubWorkflow);

  // Register all research activities
  runtime.registerActivity(architectTriageActivity);
  runtime.registerActivity(startDeepResearchActivity);
  runtime.registerActivity(reviewResearchActivity);
  runtime.registerActivity(architectDraftPlanActivity);
  runtime.registerActivity(sendPushNotificationActivity);
}
