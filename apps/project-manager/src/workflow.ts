/**
 * Project Manager Workflow Implementation using Dapr Workflow
 *
 * This module implements a durable state machine for project lifecycle management.
 * Projects survive pod restarts and state transitions are persisted automatically.
 */

import {
  WorkflowRuntime,
  WorkflowActivityContext,
  WorkflowContext,
  TWorkflow,
  DaprWorkflowClient,
} from "@dapr/dapr";
import { z } from "zod";
import type { Project, ProjectState, ReviewResult } from "./index.js";

// --- Configuration ---
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const WORKFLOW_COMPONENT = "dapr"; // Default workflow component name

// --- Workflow Input Schema ---
export const WorkflowInputSchema = z.object({
  title: z.string(),
  description: z.string(),
  platform: z.enum(["github", "gitea"]),
  repoOwner: z.string(),
  repoName: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// --- Workflow State Schema ---
export const WorkflowStateSchema = z.object({
  projectId: z.string().uuid(),
  currentState: z.enum([
    "CREATE",
    "PLANNING",
    "REVIEW",
    "IN_PROGRESS",
    "QA",
    "DEPLOY",
    "VALIDATE",
    "ACCEPTED",
    "FAILED",
  ]),
  project: z.any(), // Full Project object
  stateData: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// --- Activity Input Schemas ---
export const CreateProjectActivityInput = z.object({
  title: z.string(),
  description: z.string(),
  platform: z.enum(["github", "gitea"]),
  repoOwner: z.string(),
  repoName: z.string(),
  architectGuidance: z.unknown(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const EvaluateGateActivityInput = z.object({
  project: z.any(),
  gateType: z.enum(["plan", "qa", "deployment"]),
  context: z.record(z.string(), z.unknown()),
});

export const TransitionStateActivityInput = z.object({
  project: z.any(),
  newState: z.enum([
    "CREATE",
    "PLANNING",
    "REVIEW",
    "IN_PROGRESS",
    "QA",
    "DEPLOY",
    "VALIDATE",
    "ACCEPTED",
    "FAILED",
  ]),
  reason: z.string().optional(),
});

export const AddCommentActivityInput = z.object({
  platform: z.enum(["github", "gitea"]),
  repoOwner: z.string(),
  repoName: z.string(),
  issueNumber: z.number(),
  body: z.string(),
});

export const ConsultArchitectActivityInput = z.object({
  question: z.string(),
});

export const RequestResearchActivityInput = z.object({
  query: z.string(),
  type: z.string().default("technical-research"),
});

// --- Activity Function Types ---
export type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowActivityContext,
  input: TInput
) => Promise<TOutput>;

// --- External Event Names ---
export const ADVANCE_EVENT = "advance";
export const FAIL_EVENT = "fail";

// --- State Transition Map ---
const VALID_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  CREATE: ["PLANNING"],
  PLANNING: ["REVIEW"],
  REVIEW: ["PLANNING", "IN_PROGRESS"],
  IN_PROGRESS: ["QA"],
  QA: ["PLANNING", "DEPLOY"],
  DEPLOY: ["VALIDATE"],
  VALIDATE: ["PLANNING", "ACCEPTED"],
  ACCEPTED: [],
  FAILED: [],
};

/**
 * Main Project Workflow
 *
 * This workflow manages the entire project lifecycle from creation to acceptance.
 * It uses external events to advance through states, enabling manual control.
 */
export const projectWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: WorkflowInput
): any {
  console.log(`[Workflow] Starting project workflow: ${input.title}`);

  // Step 1: Consult Architect
  const architectGuidance = yield ctx.callActivity(
    consultArchitectActivity,
    { question: `New project request: "${input.title}". Description: ${input.description}. What technical approach do you recommend?` }
  );

  // Step 2: Create Project (CREATE state)
  const project: Project = yield ctx.callActivity(createProjectActivity, {
    title: input.title,
    description: input.description,
    platform: input.platform,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    architectGuidance,
    context: input.context,
  });

  let currentState: ProjectState = "CREATE";
  let currentProject = project;

  console.log(`[Workflow] Project created: ${project.id}`);

  // Step 3: Immediately transition to PLANNING
  currentProject = yield ctx.callActivity(transitionStateActivity, {
    project: currentProject,
    newState: "PLANNING",
    reason: "Initial planning phase started",
  });
  currentState = "PLANNING";

  // Main state machine loop
  // We wait for external signals to advance through states
  while (currentState !== "ACCEPTED" && currentState !== "FAILED") {
    console.log(`[Workflow] Project ${project.id} in state: ${currentState}`);

    // Wait for advance signal with project-specific context
    const advanceSignal: {
      targetState: ProjectState;
      context?: Record<string, unknown>;
      reason?: string;
    } = yield ctx.waitForExternalEvent(ADVANCE_EVENT);

    const { targetState, context: gateContext = {}, reason } = advanceSignal;

    console.log(`[Workflow] Advance signal received: ${currentState} → ${targetState}`);

    // Validate transition
    if (!VALID_TRANSITIONS[currentState]?.includes(targetState)) {
      console.warn(
        `[Workflow] Invalid transition: ${currentState} → ${targetState}. Ignoring.`
      );
      continue;
    }

    // Perform review gate evaluation if needed
    if (["REVIEW", "DEPLOY", "ACCEPTED"].includes(targetState)) {
      const gateType =
        targetState === "REVIEW" ? "plan" :
        targetState === "DEPLOY" ? "qa" : "deployment";

      const review: ReviewResult = yield ctx.callActivity(evaluateGateActivity, {
        project: currentProject,
        gateType,
        context: gateContext,
      });

      if (!review.approved) {
        // Gate failed - add feedback comment
        if (currentProject.issueNumber) {
          yield ctx.callActivity(addCommentActivity, {
            platform: currentProject.platform,
            repoOwner: currentProject.repoOwner,
            repoName: currentProject.repoName,
            issueNumber: currentProject.issueNumber,
            body: `⚠️ **Review Gate Failed**: ${gateType}

**Concerns:**
${review.concerns.map((c) => `- ${c}`).join("\n")}

**Suggestions:**
${review.suggestions.map((s) => `- ${s}`).join("\n")}

**Reasoning:** ${review.reasoning}

*Confidence: ${(review.confidence * 100).toFixed(0)}%*`,
          });
        }

        // Don't transition - stay in current state
        console.log(`[Workflow] Review gate failed for ${gateType}, staying in ${currentState}`);
        continue;
      }
    }

    // Perform state transition
    currentProject = yield ctx.callActivity(transitionStateActivity, {
      project: currentProject,
      newState: targetState,
      reason: reason || `Advanced to ${targetState}`,
    });
    currentState = targetState;

    console.log(`[Workflow] Transitioned to ${targetState}`);
  }

  console.log(`[Workflow] Project ${project.id} completed in state: ${currentState}`);

  return {
    projectId: project.id,
    finalState: currentState,
    project: currentProject,
  };
};

// --- Activity Placeholder Functions ---
// These will be replaced with actual implementations at runtime

export let createProjectActivity: ActivityFunction<
  z.infer<typeof CreateProjectActivityInput>,
  Project
> = async (ctx, input) => {
  throw new Error("createProject activity not initialized");
};

export let evaluateGateActivity: ActivityFunction<
  z.infer<typeof EvaluateGateActivityInput>,
  ReviewResult
> = async (ctx, input) => {
  throw new Error("evaluateGate activity not initialized");
};

export let transitionStateActivity: ActivityFunction<
  z.infer<typeof TransitionStateActivityInput>,
  Project
> = async (ctx, input) => {
  throw new Error("transitionState activity not initialized");
};

export let addCommentActivity: ActivityFunction<
  z.infer<typeof AddCommentActivityInput>,
  boolean
> = async (ctx, input) => {
  throw new Error("addComment activity not initialized");
};

export let consultArchitectActivity: ActivityFunction<
  z.infer<typeof ConsultArchitectActivityInput>,
  unknown
> = async (ctx, input) => {
  throw new Error("consultArchitect activity not initialized");
};

export let requestResearchActivity: ActivityFunction<
  z.infer<typeof RequestResearchActivityInput>,
  unknown
> = async (ctx, input) => {
  throw new Error("requestResearch activity not initialized");
};

// --- Workflow Runtime Builder ---
export interface WorkflowActivityImplementations {
  createProject: typeof createProjectActivity;
  evaluateGate: typeof evaluateGateActivity;
  transitionState: typeof transitionStateActivity;
  addComment: typeof addCommentActivity;
  consultArchitect: typeof consultArchitectActivity;
  requestResearch: typeof requestResearchActivity;
}

export function createWorkflowRuntime(
  activityImpls: WorkflowActivityImplementations
): WorkflowRuntime {
  // Assign implementations to module-level variables
  createProjectActivity = activityImpls.createProject;
  evaluateGateActivity = activityImpls.evaluateGate;
  transitionStateActivity = activityImpls.transitionState;
  addCommentActivity = activityImpls.addComment;
  consultArchitectActivity = activityImpls.consultArchitect;
  requestResearchActivity = activityImpls.requestResearch;

  const runtime = new WorkflowRuntime({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });

  // Register workflow
  runtime.registerWorkflow(projectWorkflow);

  // Register activities with their implementations
  runtime.registerActivity(createProjectActivity);
  runtime.registerActivity(evaluateGateActivity);
  runtime.registerActivity(transitionStateActivity);
  runtime.registerActivity(addCommentActivity);
  runtime.registerActivity(consultArchitectActivity);
  runtime.registerActivity(requestResearchActivity);

  return runtime;
}

// --- Workflow Client Helper ---
export function createWorkflowClient(): DaprWorkflowClient {
  return new DaprWorkflowClient({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });
}

// --- Helper Functions ---

/**
 * Start a new project workflow instance
 */
export async function startProjectWorkflow(
  client: DaprWorkflowClient,
  input: WorkflowInput,
  instanceId?: string
): Promise<string> {
  const workflowInstanceId = instanceId || crypto.randomUUID();

  await client.scheduleNewWorkflow(projectWorkflow, input, workflowInstanceId);

  console.log(`[Workflow Client] Started workflow instance: ${workflowInstanceId}`);
  return workflowInstanceId;
}

/**
 * Advance a project to the next state
 */
export async function advanceProject(
  client: DaprWorkflowClient,
  instanceId: string,
  targetState: ProjectState,
  context?: Record<string, unknown>,
  reason?: string
): Promise<void> {
  await client.raiseEvent(instanceId, ADVANCE_EVENT, {
    targetState,
    context,
    reason,
  });

  console.log(`[Workflow Client] Raised advance event for ${instanceId}: → ${targetState}`);
}

/**
 * Get workflow status
 * @param client Workflow client
 * @param instanceId Workflow instance ID
 * @param includeInputsOutputs Whether to include inputs and outputs
 */
export async function getProjectWorkflowStatus(
  client: DaprWorkflowClient,
  instanceId: string,
  includeInputsOutputs = false
): Promise<unknown> {
  const status = await client.getWorkflowState(instanceId, includeInputsOutputs);
  return status;
}

/**
 * Terminate a workflow (for cleanup/cancellation)
 */
export async function terminateProjectWorkflow(
  client: DaprWorkflowClient,
  instanceId: string,
  reason?: string
): Promise<void> {
  // terminateWorkflow requires (instanceId, output) - output is the termination reason/data
  await client.terminateWorkflow(instanceId, { reason: reason || "Terminated by user" });
  console.log(`[Workflow Client] Terminated workflow ${instanceId}: ${reason || "No reason provided"}`);
}

/**
 * Purge a completed workflow from state store
 */
export async function purgeProjectWorkflow(
  client: DaprWorkflowClient,
  instanceId: string
): Promise<boolean> {
  const result = await client.purgeWorkflow(instanceId);
  console.log(`[Workflow Client] Purged workflow ${instanceId}`);
  return result;
}
