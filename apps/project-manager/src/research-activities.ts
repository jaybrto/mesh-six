/**
 * Research Activity Implementations
 *
 * Concrete implementations for the ResearchAndPlan sub-workflow activities.
 * These are wired into the WorkflowRuntime at startup via registerResearchWorkflow().
 */

import { DaprClient, HttpMethod } from "@dapr/dapr";
import type { WorkflowActivityContext } from "@dapr/dapr";
import type { Pool } from "pg";
import {
  chatCompletion,
  chatCompletionWithSchema,
  createMinioClient,
  writeResearchStatus,
  readResearchStatus,
  uploadCleanResearch,
  downloadRawResearch,
  getResearchBucket,
  TriageOutputSchema,
  ReviewResearchOutputSchema,
  SCRAPER_SERVICE_APP_ID,
  ARCHITECT_TRIAGE_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  ARCHITECT_DRAFT_PLAN_PROMPT,
  type ArchitectTriageInput,
  type TriageOutput,
  type StartDeepResearchInput,
  type StartDeepResearchOutput,
  type ReviewResearchInput,
  type ReviewResearchOutput,
  type DraftPlanInput,
  type SendPushNotificationInput,
  type MinioConfig,
} from "@mesh-six/core";

import type { ResearchActivityImplementations } from "./research-sub-workflow.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const LLM_MODEL_PRO = process.env.LLM_MODEL_PRO || "gemini-1.5-pro";
const LLM_MODEL_FLASH = process.env.LLM_MODEL_FLASH || "gemini-1.5-flash";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "mesh-six-pm";
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ResearchActivityDeps {
  daprClient: DaprClient;
  minioClient: ReturnType<typeof createMinioClient>;
  pgPool: Pool;
}

/**
 * Create all research activity implementations with injected dependencies.
 */
export function createResearchActivities(
  deps: ResearchActivityDeps,
): ResearchActivityImplementations {
  const { daprClient, minioClient, pgPool } = deps;
  const bucket = getResearchBucket();

  // =========================================================================
  // 1. Architect Triage Activity
  // =========================================================================

  const architectTriage = async (
    _ctx: WorkflowActivityContext,
    input: ArchitectTriageInput,
  ): Promise<TriageOutput> => {
    console.log(
      `[ArchitectTriage] Triaging task ${input.taskId} for issue #${input.issueNumber}`,
    );

    const issueContext = [
      `Issue #${input.issueNumber}: ${input.issueTitle}`,
      input.issueBody ? `\nBody:\n${input.issueBody}` : "",
      input.architectGuidance
        ? `\nExisting Architect Guidance:\n${input.architectGuidance}`
        : "",
    ].join("");

    const result = await chatCompletionWithSchema({
      model: LLM_MODEL_PRO,
      schema: TriageOutputSchema,
      system: ARCHITECT_TRIAGE_PROMPT,
      prompt: issueContext,
      temperature: 0.3,
    });

    // Record triage to database
    await pgPool.query(
      `INSERT INTO research_sessions (id, task_id, workflow_id, issue_number, repo_owner, repo_name, status, triage_result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (task_id) DO UPDATE SET triage_result = $8, status = $7`,
      [
        crypto.randomUUID(),
        input.taskId,
        "", // workflow_id filled later
        input.issueNumber,
        input.repoOwner,
        input.repoName,
        result.object.needsDeepResearch ? "PENDING" : "COMPLETED",
        JSON.stringify(result.object),
      ],
    );

    console.log(
      `[ArchitectTriage] Result: needsDeepResearch=${result.object.needsDeepResearch}, complexity=${result.object.complexity}`,
    );

    return result.object;
  };

  // =========================================================================
  // 2. Start Deep Research Activity (Claim Check + Dispatch)
  // =========================================================================

  const startDeepResearch = async (
    _ctx: WorkflowActivityContext,
    input: StartDeepResearchInput,
  ): Promise<StartDeepResearchOutput> => {
    console.log(
      `[StartDeepResearch] Dispatching research for task ${input.taskId}`,
    );

    // Claim Check: is it already done?
    const existingStatus = await readResearchStatus(minioClient, bucket, input.taskId);
    if (existingStatus?.status === "COMPLETED") {
      console.log(
        `[StartDeepResearch] Research already completed for task ${input.taskId}`,
      );
      return {
        status: "COMPLETED",
        statusDocKey: `research/status/${input.taskId}/status.json`,
      };
    }

    // Write PENDING status to MinIO
    const statusKey = await writeResearchStatus(
      minioClient,
      bucket,
      input.taskId,
      "PENDING",
      {
        prompt: input.prompt,
        startedAt: new Date().toISOString(),
      },
    );

    // Fire-and-forget to Mac Mini scraper service via Dapr
    try {
      await daprClient.invoker.invoke(
        SCRAPER_SERVICE_APP_ID,
        "startScrape",
        HttpMethod.POST,
        {
          taskId: input.taskId,
          prompt: input.prompt,
          researchQuestions: input.researchQuestions,
          suggestedSources: input.suggestedSources,
          followUpPrompt: input.followUpPrompt,
        },
      );

      // Update status to IN_PROGRESS
      await writeResearchStatus(minioClient, bucket, input.taskId, "IN_PROGRESS", {
        prompt: input.prompt,
        startedAt: new Date().toISOString(),
      });

      console.log(
        `[StartDeepResearch] Dispatched to ${SCRAPER_SERVICE_APP_ID} for task ${input.taskId}`,
      );

      return { status: "STARTED", statusDocKey: statusKey };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[StartDeepResearch] Failed to dispatch scraper for task ${input.taskId}: ${errorMsg}`,
      );

      await writeResearchStatus(minioClient, bucket, input.taskId, "FAILED", {
        prompt: input.prompt,
        error: errorMsg,
      });

      return {
        status: "FAILED",
        statusDocKey: statusKey,
        error: errorMsg,
      };
    }
  };

  // =========================================================================
  // 3. Review Research Activity
  // =========================================================================

  const reviewResearch = async (
    _ctx: WorkflowActivityContext,
    input: ReviewResearchInput,
  ): Promise<ReviewResearchOutput> => {
    console.log(
      `[ReviewResearch] Reviewing raw research for task ${input.taskId}`,
    );

    // Download raw scraped content from MinIO
    let rawData: string;
    try {
      rawData = await downloadRawResearch(minioClient, bucket, input.rawMinioId);
    } catch (error) {
      console.error(
        `[ReviewResearch] Failed to download raw research: ${error}`,
      );
      return {
        status: "INCOMPLETE",
        missingInformation: `Failed to retrieve research data from MinIO key: ${input.rawMinioId}`,
      };
    }

    // Use Gemini Flash to validate and format
    const reviewPrompt = [
      `Original Research Prompt: ${input.originalPrompt}`,
      "",
      `Research Questions:`,
      ...input.researchQuestions.map((q, i) => `${i + 1}. ${q}`),
      "",
      `Raw Scraped Content:`,
      rawData.slice(0, 50_000), // Cap at ~50k chars to stay within context
    ].join("\n");

    const result = await chatCompletionWithSchema({
      model: LLM_MODEL_FLASH,
      schema: ReviewResearchOutputSchema,
      system: RESEARCH_REVIEW_PROMPT,
      prompt: reviewPrompt,
      temperature: 0.2,
    });

    if (result.object.status === "APPROVED" && result.object.formattedMarkdown) {
      // Upload clean formatted research to MinIO
      const cleanKey = await uploadCleanResearch(
        minioClient,
        bucket,
        input.taskId,
        result.object.formattedMarkdown,
      );

      // Update status in MinIO
      await writeResearchStatus(minioClient, bucket, input.taskId, "COMPLETED", {
        minioKey: cleanKey,
        completedAt: new Date().toISOString(),
      });

      // Update database
      await pgPool.query(
        `UPDATE research_sessions SET status = 'COMPLETED', clean_minio_key = $1, completed_at = NOW()
         WHERE task_id = $2`,
        [cleanKey, input.taskId],
      );

      console.log(
        `[ReviewResearch] Approved. Clean doc at: ${cleanKey}`,
      );

      return {
        status: "APPROVED",
        formattedMarkdown: result.object.formattedMarkdown,
        cleanMinioId: cleanKey,
      };
    }

    // Update database with cycle increment
    await pgPool.query(
      `UPDATE research_sessions SET research_cycles = research_cycles + 1
       WHERE task_id = $1`,
      [input.taskId],
    );

    console.log(
      `[ReviewResearch] Incomplete. Missing: ${result.object.missingInformation}`,
    );

    return {
      status: "INCOMPLETE",
      missingInformation: result.object.missingInformation,
    };
  };

  // =========================================================================
  // 4. Architect Draft Plan Activity
  // =========================================================================

  const architectDraftPlan = async (
    _ctx: WorkflowActivityContext,
    input: DraftPlanInput,
  ): Promise<string> => {
    console.log(
      `[ArchitectDraftPlan] Drafting plan for task ${input.taskId}, issue #${input.issueNumber}`,
    );

    // Build context from triage + optional deep research
    const contextParts = [
      `Issue #${input.issueNumber}: ${input.issueTitle}`,
      input.issueBody ? `\nIssue Body:\n${input.issueBody}` : "",
      `\nArchitect Analysis:\n${input.initialContext}`,
      input.architectGuidance
        ? `\nArchitect Guidance:\n${input.architectGuidance}`
        : "",
    ];

    // If deep research was done, include it
    if (input.deepResearchDocId) {
      try {
        const researchDoc = await downloadRawResearch(
          minioClient,
          bucket,
          input.deepResearchDocId,
        );
        contextParts.push(`\nResearch Findings:\n${researchDoc.slice(0, 30_000)}`);
      } catch (error) {
        console.warn(
          `[ArchitectDraftPlan] Could not load research doc: ${error}`,
        );
      }
    }

    const result = await chatCompletion({
      model: LLM_MODEL_PRO,
      system: ARCHITECT_DRAFT_PLAN_PROMPT,
      prompt: contextParts.join(""),
      temperature: 0.4,
      maxTokens: 4096,
    });

    // Update database with final plan
    await pgPool.query(
      `UPDATE research_sessions SET final_plan = $1, status = 'COMPLETED', completed_at = NOW()
       WHERE task_id = $2`,
      [result.text, input.taskId],
    );

    console.log(
      `[ArchitectDraftPlan] Plan drafted (${result.text.length} chars)`,
    );

    return result.text;
  };

  // =========================================================================
  // 5. Send Push Notification Activity
  // =========================================================================

  const sendPushNotification = async (
    _ctx: WorkflowActivityContext,
    input: SendPushNotificationInput,
  ): Promise<void> => {
    console.log(
      `[SendPushNotification] Sending: ${input.message}`,
    );

    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain",
      };
      if (input.title) headers["Title"] = input.title;
      if (input.priority) headers["Priority"] = input.priority;
      if (input.tags.length > 0) headers["Tags"] = input.tags.join(",");

      await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
        method: "POST",
        headers,
        body: input.message,
      });
    } catch (error) {
      // Fire-and-forget — don't fail the workflow over a notification
      console.error(
        `[SendPushNotification] Failed: ${error}`,
      );
    }
  };

  return {
    architectTriage,
    startDeepResearch,
    reviewResearch,
    architectDraftPlan,
    sendPushNotification,
  };
}
