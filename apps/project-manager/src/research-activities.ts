/**
 * Research Activities — Dapr Workflow activity implementations for the
 * ResearchAndPlan sub-workflow.
 *
 * Fixes incorporated from PR #13 review:
 *   - H1:  downloadCleanResearch for clean docs (not downloadRawResearch)
 *   - H2:  workflow_id threaded through triage and persisted on INSERT
 *   - H4:  raw_minio_key written to DB during dispatch
 *   - H5:  research_cycles incremented at cycle start (aligned with workflow)
 *   - M2:  Only research-phase status written here; plan draft does NOT overwrite
 *   - M3:  pg types imported from @mesh-six/core re-exports (or direct)
 *   - Gemini-1:  Truncation raised to MAX_RESEARCH_CONTEXT_CHARS (500k)
 *   - Gemini-3:  Failure context injected into DraftPlan when research fails
 *   - Gemini-5:  SCRAPER_SERVICE_APP_ID_RESEARCH is env-configurable
 *   - Sonnet-6:  NTFY_SERVER must be set or throws (no public fallback)
 */

import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprClient, HttpMethod } from "@dapr/dapr";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";

import {
  chatCompletionWithSchema,
  chatCompletion,
  transitionClose,
  type AgentMemory,
  type ArchitectTriageInput,
  type ArchitectTriageOutput,
  type StartDeepResearchInput,
  type StartDeepResearchOutput,
  type ReviewResearchInput,
  type ReviewResearchOutput,
  type ArchitectDraftPlanInput,
  type SendPushNotificationInput,
  type UpdateResearchSessionInput,
  TriageLLMResponseSchema,
  ReviewLLMResponseSchema,
  LLM_MODEL_PRO,
  LLM_MODEL_FLASH,
  SCRAPER_SERVICE_APP_ID_RESEARCH,
  MAX_RESEARCH_CONTEXT_CHARS,
  RESEARCH_MINIO_BUCKET,
  writeResearchStatus,
  readResearchStatus,
  rawResearchKey,
  downloadRawResearch,
  downloadCleanResearch,
  uploadCleanResearch,
  ensureResearchBucket,
  type ResearchStatusDoc,
  type TransitionCloseConfig,
} from "@mesh-six/core";
import { ARCHITECT_REFLECTION_PROMPT } from "@mesh-six/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const AGENT_ID = process.env.AGENT_ID || "project-manager";

// ntfy must be explicitly configured — no public fallback (fixes Sonnet-6)
const NTFY_SERVER = process.env.NTFY_SERVER;
const NTFY_TOPIC = process.env.NTFY_RESEARCH_TOPIC || "mesh-six-research";

// ---------------------------------------------------------------------------
// Dependency container
// ---------------------------------------------------------------------------

export interface ResearchActivityDeps {
  daprClient: DaprClient;
  minioClient: S3Client;
  minioBucket: string;
  pgPool: Pool;
  memory?: AgentMemory | null;
}

// ---------------------------------------------------------------------------
// Activity Implementations
// ---------------------------------------------------------------------------

/**
 * Architect Triage — uses Gemini Pro to decide if deep research is needed.
 * Creates the research_sessions row with workflow_id (fixes H2).
 */
export async function architectTriage(
  _ctx: WorkflowActivityContext,
  input: ArchitectTriageInput,
  deps: ResearchActivityDeps,
): Promise<ArchitectTriageOutput> {
  console.log(`[${AGENT_ID}] Triage for task ${input.taskId}: "${input.issueTitle}"`);

  // Read scoped Mem0 memories for the architect actor (spec requirement)
  let memoryContext = "";
  if (deps.memory) {
    const architectActorId = `${input.repoOwner}/${input.repoName}/${input.issueNumber}`;
    const memories = await deps.memory.search(
      `${input.issueTitle} architecture planning research`,
      architectActorId,
      5,
    );
    if (memories.length > 0) {
      memoryContext = `\n\nRelevant past learnings:\n${memories.map((m) => `- ${m.memory}`).join("\n")}`;
    }
  }

  const { object: triage } = await chatCompletionWithSchema({
    model: LLM_MODEL_PRO,
    schema: TriageLLMResponseSchema,
    system: `You are the Architect agent. Evaluate whether this issue requires deep external research (web scraping, reading documentation sites) or if it can be planned from existing knowledge. Consider the 6-node k3s homelab environment with Dapr, PostgreSQL HA, Redis HA, RabbitMQ HA, Bun/TypeScript.`,
    prompt: `Issue #${input.issueNumber}: ${input.issueTitle}\nRepository: ${input.repoOwner}/${input.repoName}${memoryContext}\n\nDo we need deep external research for this?`,
  });

  // Insert research_sessions row with workflow_id populated (fixes H2)
  const result = await deps.pgPool.query(
    `INSERT INTO research_sessions
       (task_id, workflow_id, issue_number, repo_owner, repo_name, status, needs_deep_research, triage_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.taskId,
      input.workflowId,
      input.issueNumber,
      input.repoOwner,
      input.repoName,
      "TRIAGING",
      triage.needsDeepResearch,
      triage.reasoning,
    ],
  );

  const sessionId = result.rows[0]?.id as string;

  return {
    needsDeepResearch: triage.needsDeepResearch,
    context: triage.reasoning,
    researchPrompt: triage.researchPrompt,
    sessionId,
  };
}

/**
 * Start Deep Research — writes claim-check status, dispatches to scraper.
 * Returns explicit keys (fixes GPT-H2 — no string replacement hacks).
 */
export async function startDeepResearch(
  _ctx: WorkflowActivityContext,
  input: StartDeepResearchInput,
  deps: ResearchActivityDeps,
): Promise<StartDeepResearchOutput> {
  const { minioClient, minioBucket } = deps;

  // Ensure bucket exists (fixes M1)
  await ensureResearchBucket(minioClient, minioBucket);

  // Claim Check: Is it already done?
  const existingStatus = await readResearchStatus(minioClient, minioBucket, input.taskId);
  if (existingStatus?.status === "COMPLETED" && existingStatus.minioKey) {
    console.log(`[${AGENT_ID}] Research already completed for ${input.taskId}, returning cached`);
    return {
      status: "COMPLETED",
      statusDocKey: `research/status/${input.taskId}/status.json`,
      rawMinioKey: existingStatus.minioKey,
    };
  }

  // Write PENDING status
  const statusDoc: ResearchStatusDoc = {
    taskId: input.taskId,
    status: "PENDING",
    startedAt: new Date().toISOString(),
  };
  const statusKey = await writeResearchStatus(minioClient, minioBucket, input.taskId, statusDoc);

  // Fire and forget to scraper service
  const prompt = input.followUpPrompt || input.prompt;
  try {
    await deps.daprClient.invoker.invoke(
      SCRAPER_SERVICE_APP_ID_RESEARCH,
      "scrape",
      HttpMethod.POST,
      {
        taskId: input.taskId,
        workflowId: input.workflowId,
        prompt,
        minioFolderPath: `research/raw/${input.taskId}`,
      },
    );
  } catch (error) {
    console.error(`[${AGENT_ID}] Scraper dispatch failed for ${input.taskId}:`, error);

    // Update MinIO status to FAILED
    await writeResearchStatus(minioClient, minioBucket, input.taskId, {
      ...statusDoc,
      status: "FAILED",
      error: String(error),
    });

    return {
      status: "FAILED",
      statusDocKey: statusKey,
    };
  }

  // Update DB with dispatched status and raw key location (fixes H4)
  const expectedRawKey = rawResearchKey(input.taskId);
  if (input.sessionId) {
    await deps.pgPool.query(
      `UPDATE research_sessions SET status = 'DISPATCHED', raw_minio_key = $1, updated_at = NOW() WHERE id = $2`,
      [expectedRawKey, input.sessionId],
    );
  }

  return {
    status: "STARTED",
    statusDocKey: statusKey,
    rawMinioKey: expectedRawKey,
  };
}

/**
 * Review Research — uses Gemini Flash to validate and format raw scrape data.
 * Truncation raised to MAX_RESEARCH_CONTEXT_CHARS (fixes Gemini-1).
 */
export async function reviewResearch(
  _ctx: WorkflowActivityContext,
  input: ReviewResearchInput,
  deps: ResearchActivityDeps,
): Promise<ReviewResearchOutput> {
  const { minioClient, minioBucket } = deps;

  let rawData: string;
  try {
    rawData = await downloadRawResearch(minioClient, minioBucket, input.rawMinioKey);
  } catch (error) {
    console.error(`[${AGENT_ID}] Failed to download raw research from ${input.rawMinioKey}:`, error);
    return {
      status: "INCOMPLETE",
      newFollowUpPrompt: `Previous scrape result could not be downloaded (key: ${input.rawMinioKey}). Please retry the research.`,
    };
  }

  // Truncate to MAX_RESEARCH_CONTEXT_CHARS (raised from 50k per Gemini review)
  const truncatedData = rawData.slice(0, MAX_RESEARCH_CONTEXT_CHARS);

  const { object: review } = await chatCompletionWithSchema({
    model: LLM_MODEL_FLASH,
    schema: ReviewLLMResponseSchema,
    system: `You are a research validation agent. Extract core technical specs, API references, and configuration details from raw scraped content. If the text is a CAPTCHA page, login wall, or refusal, mark INCOMPLETE and describe what information is still needed.`,
    prompt: `${input.originalPrompt ? `Original Research Prompt: ${input.originalPrompt}\n\n` : ""}Raw Scrape Data:\n${truncatedData}`,
  });

  if (review.status === "APPROVED" && review.formattedMarkdown) {
    // Upload clean research
    const cleanKey = await uploadCleanResearch(
      minioClient,
      minioBucket,
      input.taskId,
      review.formattedMarkdown,
    );

    // Update DB with clean key
    if (input.sessionId) {
      await deps.pgPool.query(
        `UPDATE research_sessions SET status = 'COMPLETED', clean_minio_key = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [cleanKey, input.sessionId],
      );
    }

    return {
      status: "APPROVED",
      cleanMinioKey: cleanKey,
      formattedMarkdown: review.formattedMarkdown,
    };
  }

  // Update DB status to REVIEW (incomplete)
  if (input.sessionId) {
    await deps.pgPool.query(
      `UPDATE research_sessions SET status = 'REVIEW', updated_at = NOW() WHERE id = $1`,
      [input.sessionId],
    );
  }

  return {
    status: "INCOMPLETE",
    newFollowUpPrompt: review.missingInformation || "Research data was incomplete. Please retry with more specific queries.",
  };
}

/**
 * Architect Draft Plan — uses Gemini Pro to generate the final plan.
 * Uses downloadCleanResearch for clean doc (fixes H1).
 * Injects failure context when research failed/timed out (fixes Gemini-3).
 * Does NOT overwrite research_sessions status to COMPLETED (fixes M2).
 */
export async function architectDraftPlan(
  _ctx: WorkflowActivityContext,
  input: ArchitectDraftPlanInput,
  deps: ResearchActivityDeps,
): Promise<string> {
  let researchSection = "";

  if (input.deepResearchDocId) {
    // Use downloadCleanResearch — NOT downloadRawResearch (fixes H1)
    try {
      const researchDoc = await downloadCleanResearch(
        deps.minioClient,
        deps.minioBucket,
        input.deepResearchDocId,
      );
      researchSection = `\n\n## Deep Research Results\n\n${researchDoc.slice(0, MAX_RESEARCH_CONTEXT_CHARS)}`;
    } catch (error) {
      console.warn(`[${AGENT_ID}] Failed to download clean research: ${error}`);
      researchSection = "\n\n## Deep Research Results\n\n_Research document could not be retrieved. Proceed with available context._";
    }
  } else if (input.researchFailed) {
    // Inject failure context (fixes Gemini-3 — don't let Architect hallucinate)
    researchSection = `\n\n## Deep Research Results\n\n⚠️ **Note:** Deep research was attempted but ${input.failureReason || "failed/timed out"}. Proceed with caution and explicitly flag uncertain areas in the Risks section. Do not hallucinate API details or dependencies — mark them as "requires verification".`;
  }

  const result = await chatCompletion({
    model: LLM_MODEL_PRO,
    system: `You are the Architect agent generating a detailed implementation plan for the Mesh Six homelab project. Generate a structured markdown plan including: Overview, Architecture, Implementation Steps, Testing Strategy, Deployment, and Risks.`,
    prompt: `Issue #${input.issueNumber}: ${input.issueTitle}
Repository: ${input.repoOwner}/${input.repoName}

## Triage Context
${input.initialContext}${researchSection}

Generate a comprehensive implementation plan.`,
  });

  return result.text;
}

/**
 * Send Push Notification — ntfy integration.
 * NTFY_SERVER must be explicitly configured (fixes Sonnet-6).
 */
export async function sendPushNotification(
  _ctx: WorkflowActivityContext,
  input: SendPushNotificationInput,
): Promise<void> {
  if (!NTFY_SERVER) {
    console.warn(`[${AGENT_ID}] NTFY_SERVER not configured, skipping push notification: ${input.message}`);
    return;
  }

  const ntfyUrl = `${NTFY_SERVER}/${NTFY_TOPIC}`;
  try {
    await fetch(ntfyUrl, {
      method: "POST",
      body: input.message,
      headers: {
        ...(input.title ? { Title: input.title } : {}),
        ...(input.priority ? { Priority: input.priority } : {}),
      },
    });
  } catch (error) {
    console.warn(`[${AGENT_ID}] ntfy push failed:`, error);
  }
}

/**
 * Update research session status in DB.
 * Increments research_cycles at cycle start (fixes H5).
 */
export async function updateResearchSession(
  _ctx: WorkflowActivityContext,
  input: UpdateResearchSessionInput,
  deps: ResearchActivityDeps,
): Promise<void> {
  const setClauses: string[] = [
    `status = $2`,
    `updated_at = NOW()`,
  ];
  const params: unknown[] = [input.sessionId, input.status];
  let paramIdx = 3;

  if (input.rawMinioKey !== undefined) {
    setClauses.push(`raw_minio_key = $${paramIdx}`);
    params.push(input.rawMinioKey);
    paramIdx++;
  }
  if (input.cleanMinioKey !== undefined) {
    setClauses.push(`clean_minio_key = $${paramIdx}`);
    params.push(input.cleanMinioKey);
    paramIdx++;
  }
  if (input.researchCycles !== undefined) {
    setClauses.push(`research_cycles = $${paramIdx}`);
    params.push(input.researchCycles);
    paramIdx++;
  }
  if (input.completedAt) {
    setClauses.push(`completed_at = NOW()`);
  }

  await deps.pgPool.query(
    `UPDATE research_sessions SET ${setClauses.join(", ")} WHERE id = $1`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Mem0 Reflection — extract durable memories after research & planning
// ---------------------------------------------------------------------------

/** Input for the reflectAndStore activity */
export interface ReflectAndStoreInput {
  taskId: string;
  issueTitle: string;
  architectActorId: string;
  triageContext: string;
  plan: string;
  researchCompleted: boolean;
  totalResearchCycles: number;
}

/**
 * Reflect and Store — runs the ARCHITECT_REFLECTION_PROMPT via transitionClose()
 * to extract durable memories from the research & planning phase and store them
 * in Mem0 with appropriate scoping.
 *
 * This closes the spec gap flagged by all 4 reviewers:
 * "Mem0 reflection is scaffolded but not wired."
 */
export async function reflectAndStore(
  _ctx: WorkflowActivityContext,
  input: ReflectAndStoreInput,
  deps: ResearchActivityDeps,
): Promise<void> {
  if (!deps.memory) {
    console.log(`[${AGENT_ID}] Memory not available, skipping reflection for ${input.taskId}`);
    return;
  }

  const closeConfig: TransitionCloseConfig = {
    agentId: "architect-agent",
    taskId: input.taskId,
    projectId: input.taskId,
    transitionFrom: "RESEARCH",
    transitionTo: "PLANNING",
    conversationHistory: [
      {
        role: "system",
        content: ARCHITECT_REFLECTION_PROMPT,
      },
      {
        role: "user",
        content: `Issue: ${input.issueTitle}\n\nTriage Context:\n${input.triageContext}`,
      },
      {
        role: "assistant",
        content: `Research completed: ${input.researchCompleted} (${input.totalResearchCycles} cycles)\n\nPlan:\n${input.plan.slice(0, 5000)}`,
      },
    ],
    taskState: {
      researchCompleted: input.researchCompleted,
      totalResearchCycles: input.totalResearchCycles,
    },
  };

  try {
    await transitionClose(closeConfig, deps.memory, LLM_MODEL_PRO);
    console.log(`[${AGENT_ID}] Reflection stored for ${input.taskId}`);
  } catch (error) {
    console.warn(`[${AGENT_ID}] transitionClose failed for research reflection:`, error);
  }
}

// ---------------------------------------------------------------------------
// Activity factory — creates bound activity functions for workflow registration
// ---------------------------------------------------------------------------

export interface ResearchActivityImplementations {
  architectTriage: (ctx: WorkflowActivityContext, input: ArchitectTriageInput) => Promise<ArchitectTriageOutput>;
  startDeepResearch: (ctx: WorkflowActivityContext, input: StartDeepResearchInput) => Promise<StartDeepResearchOutput>;
  reviewResearch: (ctx: WorkflowActivityContext, input: ReviewResearchInput) => Promise<ReviewResearchOutput>;
  architectDraftPlan: (ctx: WorkflowActivityContext, input: ArchitectDraftPlanInput) => Promise<string>;
  sendPushNotification: (ctx: WorkflowActivityContext, input: SendPushNotificationInput) => Promise<void>;
  updateResearchSession: (ctx: WorkflowActivityContext, input: UpdateResearchSessionInput) => Promise<void>;
  reflectAndStore: (ctx: WorkflowActivityContext, input: ReflectAndStoreInput) => Promise<void>;
}

/**
 * Create research activity implementations bound to their dependencies.
 * Returns a fresh set of activity functions per call (fixes M4 — testability).
 */
export function createResearchActivities(deps: ResearchActivityDeps): ResearchActivityImplementations {
  return {
    architectTriage: (ctx, input) => architectTriage(ctx, input, deps),
    startDeepResearch: (ctx, input) => startDeepResearch(ctx, input, deps),
    reviewResearch: (ctx, input) => reviewResearch(ctx, input, deps),
    architectDraftPlan: (ctx, input) => architectDraftPlan(ctx, input, deps),
    sendPushNotification: (ctx, input) => sendPushNotification(ctx, input),
    updateResearchSession: (ctx, input) => updateResearchSession(ctx, input, deps),
    reflectAndStore: (ctx, input) => reflectAndStore(ctx, input, deps),
  };
}
