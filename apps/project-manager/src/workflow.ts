/**
 * Project Manager Workflow — Board-Driven State Machine (Milestone 4.5)
 *
 * Implements the PM lifecycle as a Dapr Workflow driven by GitHub Projects board
 * column transitions. The PM has zero knowledge of GWA internals — the board
 * and GitHub API (issues, comments, PRs) are the sole communication channels.
 *
 * Board-aligned states:
 *   INTAKE -> PLANNING -> IMPLEMENTATION -> QA -> REVIEW -> ACCEPTED
 *                                                         \-> FAILED
 *
 * Failure loops (bounded, max 3 cycles):
 *   PLANNING plan rejected -> stays in PLANNING
 *   QA tests fail -> back to PLANNING
 *   REVIEW validation fails -> back to PLANNING
 */

import {
  WorkflowRuntime,
  WorkflowActivityContext,
  WorkflowContext,
  type TWorkflow,
  DaprWorkflowClient,
} from "@dapr/dapr";

import type {
  PlanningEventPayload,
  ImplEventPayload,
  QaEventPayload,
  HumanAnswerPayload,
} from "@mesh-six/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

// ---------------------------------------------------------------------------
// Local Types (no imports from ./index.js to avoid circular deps)
// ---------------------------------------------------------------------------

/** Board-aligned workflow states */
export type WorkflowPhase =
  | "INTAKE"
  | "PLANNING"
  | "IMPLEMENTATION"
  | "QA"
  | "REVIEW"
  | "ACCEPTED"
  | "FAILED";

/** Input to start a new project workflow */
export interface ProjectWorkflowInput {
  issueNumber: number;
  issueTitle: string;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  contentNodeId: string;
  retryBudget?: number;
}

/** Result returned when the workflow completes */
export interface ProjectWorkflowResult {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  finalPhase: WorkflowPhase;
  prNumber?: number;
}

// --- Activity input/output types ---

export interface ConsultArchitectInput {
  question: string;
}

export interface ConsultArchitectOutput {
  guidance: string;
  fallback: boolean;
}

export interface EnrichIssueInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  guidance: string;
  acceptanceCriteria: string;
}

export interface RecordPendingMoveInput {
  projectItemId: string;
  toColumn: string;
}

export interface MoveCardInput {
  projectItemId: string;
  toColumn: string;
}

export interface RecordWorkflowMappingInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  projectItemId: string;
}

export interface PollForPlanInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  timeoutMinutes: number;
}

export interface PollForPlanOutput {
  planContent: string;
  timedOut: boolean;
  blocked: boolean;
}

export interface ReviewPlanInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  planContent: string;
}

export interface ReviewPlanOutput {
  approved: boolean;
  feedback: string;
  confidence: number;
}

export interface AddCommentInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  body: string;
}

export interface PollForImplementationInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  timeoutMinutes: number;
}

export interface PollForImplementationOutput {
  prNumber: number | null;
  timedOut: boolean;
  blocked: boolean;
}

export interface PollForTestResultsInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  timeoutMinutes: number;
}

export interface PollForTestResultsOutput {
  testContent: string;
  timedOut: boolean;
  blocked: boolean;
}

export interface EvaluateTestResultsInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  testContent: string;
}

export interface EvaluateTestResultsOutput {
  passed: boolean;
  failures: string[];
}

export interface WaitForDeploymentInput {
  repoOwner: string;
  repoName: string;
  healthUrl: string;
  timeoutMinutes: number;
}

export interface WaitForDeploymentOutput {
  healthy: boolean;
  timedOut: boolean;
}

export interface ValidateDeploymentInput {
  repoOwner: string;
  repoName: string;
  healthUrl: string;
}

export interface ValidateDeploymentOutput {
  passed: boolean;
  failures: string[];
}

export interface CreateBugIssueInput {
  repoOwner: string;
  repoName: string;
  parentIssueNumber: number;
  failures: string[];
}

export interface CreateBugIssueOutput {
  issueNumber: number;
  url: string;
}

export interface NotifyBlockedInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  question: string;
  ntfyTopic: string;
}

export interface NotifyTimeoutInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  phase: string;
  ntfyTopic: string;
}

export interface ReportSuccessInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  workflowId: string;
}

export interface MoveToFailedInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  projectItemId: string;
  workflowId: string;
  reason: string;
}

export interface CompressContextInput {
  sender: string;
  receiver: string;
  projectId: string;
  taskSummary: string;
  priority: number;
  workflowState: Record<string, unknown>;
  senderMemories: string[];
  senderQuestions: string[];
  constraints?: string[];
  knownFailures?: string[];
  conversationSnippet?: Array<{ role: string; content: string }>;
}

export interface CompressContextOutput {
  compressedContext: string;
  method: string;
  compressionRatio: number;
  durationMs: number;
  fallback: boolean;
}

export interface LoadRetryBudgetInput {
  workflowId: string;
}

export interface LoadRetryBudgetOutput {
  planCyclesUsed: number;
  qaCyclesUsed: number;
  retryBudget: number;
}

export interface IncrementRetryCycleInput {
  workflowId: string;
  phase: "planning" | "qa";
  failureReason: string;
}

export interface AttemptAutoResolveInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowPhase: string;
}

export interface AttemptAutoResolveOutput {
  resolved: boolean;
  answer?: string;
  bestGuess?: string;
  question: string;
  agentsConsulted: string[];
}

// ---------------------------------------------------------------------------
// New activity types for event-driven workflow + architect actor
// ---------------------------------------------------------------------------

export interface ComplexityGateInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
}

export interface ComplexityGateOutput {
  simple: boolean;
}

export interface StartSessionInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  implementationPrompt: string;
  branch: string;
}

export interface StartSessionOutput {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface ConsultArchitectActorInput {
  actorId: string;
  questionText: string;
  source: string;
}

export interface ConsultArchitectActorOutput {
  confident: boolean;
  answer?: string;
  bestGuess?: string;
}

export interface InjectAnswerInput {
  implementerActorId: string;
  answerText: string;
}

export interface InjectAnswerOutput {
  ok: boolean;
  error?: string;
}

export interface NotifyHumanQuestionInput {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  questionText: string;
  architectBestGuess?: string;
}

export interface ProcessHumanAnswerInput {
  architectActorId: string;
  questionText: string;
  humanAnswer: string;
}

export interface InitializeArchitectActorInput {
  actorId: string;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  workflowId: string;
  projectItemId: string;
  issueTitle: string;
}

// ---------------------------------------------------------------------------
// Activity type alias
// ---------------------------------------------------------------------------

type ActivityFn<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowActivityContext,
  input: TInput
) => Promise<TOutput>;

// ---------------------------------------------------------------------------
// Activity stub variables (replaced at runtime via createWorkflowRuntime)
// ---------------------------------------------------------------------------

export let consultArchitectActivity: ActivityFn<
  ConsultArchitectInput,
  ConsultArchitectOutput
> = async () => {
  throw new Error("consultArchitectActivity not initialized");
};

export let enrichIssueActivity: ActivityFn<EnrichIssueInput, void> =
  async () => {
    throw new Error("enrichIssueActivity not initialized");
  };

export let recordPendingMoveActivity: ActivityFn<
  RecordPendingMoveInput,
  void
> = async () => {
  throw new Error("recordPendingMoveActivity not initialized");
};

export let moveCardActivity: ActivityFn<MoveCardInput, void> = async () => {
  throw new Error("moveCardActivity not initialized");
};

export let recordWorkflowMappingActivity: ActivityFn<
  RecordWorkflowMappingInput,
  void
> = async () => {
  throw new Error("recordWorkflowMappingActivity not initialized");
};

export let pollForPlanActivity: ActivityFn<
  PollForPlanInput,
  PollForPlanOutput
> = async () => {
  throw new Error("pollForPlanActivity not initialized");
};

export let reviewPlanActivity: ActivityFn<
  ReviewPlanInput,
  ReviewPlanOutput
> = async () => {
  throw new Error("reviewPlanActivity not initialized");
};

export let addCommentActivity: ActivityFn<AddCommentInput, void> =
  async () => {
    throw new Error("addCommentActivity not initialized");
  };

export let pollForImplementationActivity: ActivityFn<
  PollForImplementationInput,
  PollForImplementationOutput
> = async () => {
  throw new Error("pollForImplementationActivity not initialized");
};

export let pollForTestResultsActivity: ActivityFn<
  PollForTestResultsInput,
  PollForTestResultsOutput
> = async () => {
  throw new Error("pollForTestResultsActivity not initialized");
};

export let evaluateTestResultsActivity: ActivityFn<
  EvaluateTestResultsInput,
  EvaluateTestResultsOutput
> = async () => {
  throw new Error("evaluateTestResultsActivity not initialized");
};

export let waitForDeploymentActivity: ActivityFn<
  WaitForDeploymentInput,
  WaitForDeploymentOutput
> = async () => {
  throw new Error("waitForDeploymentActivity not initialized");
};

export let validateDeploymentActivity: ActivityFn<
  ValidateDeploymentInput,
  ValidateDeploymentOutput
> = async () => {
  throw new Error("validateDeploymentActivity not initialized");
};

export let createBugIssueActivity: ActivityFn<
  CreateBugIssueInput,
  CreateBugIssueOutput
> = async () => {
  throw new Error("createBugIssueActivity not initialized");
};

export let notifyBlockedActivity: ActivityFn<NotifyBlockedInput, void> =
  async () => {
    throw new Error("notifyBlockedActivity not initialized");
  };

export let notifyTimeoutActivity: ActivityFn<NotifyTimeoutInput, void> =
  async () => {
    throw new Error("notifyTimeoutActivity not initialized");
  };

export let reportSuccessActivity: ActivityFn<ReportSuccessInput, void> =
  async () => {
    throw new Error("reportSuccessActivity not initialized");
  };

export let moveToFailedActivity: ActivityFn<MoveToFailedInput, void> =
  async () => {
    throw new Error("moveToFailedActivity not initialized");
  };

export let compressContextActivity: ActivityFn<
  CompressContextInput,
  CompressContextOutput
> = async () => {
  throw new Error("compressContextActivity not initialized");
};

export let loadRetryBudgetActivity: ActivityFn<
  LoadRetryBudgetInput,
  LoadRetryBudgetOutput
> = async () => {
  throw new Error("loadRetryBudgetActivity not initialized");
};

export let incrementRetryCycleActivity: ActivityFn<
  IncrementRetryCycleInput,
  void
> = async () => {
  throw new Error("incrementRetryCycleActivity not initialized");
};

export let attemptAutoResolveActivity: ActivityFn<
  AttemptAutoResolveInput,
  AttemptAutoResolveOutput
> = async () => {
  throw new Error("attemptAutoResolveActivity not initialized");
};

export let complexityGateActivity: ActivityFn<
  ComplexityGateInput,
  ComplexityGateOutput
> = async () => {
  throw new Error("complexityGateActivity not initialized");
};

export let startSessionActivity: ActivityFn<
  StartSessionInput,
  StartSessionOutput
> = async () => {
  throw new Error("startSessionActivity not initialized");
};

export let consultArchitectActorActivity: ActivityFn<
  ConsultArchitectActorInput,
  ConsultArchitectActorOutput
> = async () => {
  throw new Error("consultArchitectActorActivity not initialized");
};

export let injectAnswerActivity: ActivityFn<
  InjectAnswerInput,
  InjectAnswerOutput
> = async () => {
  throw new Error("injectAnswerActivity not initialized");
};

export let notifyHumanQuestionActivity: ActivityFn<
  NotifyHumanQuestionInput,
  void
> = async () => {
  throw new Error("notifyHumanQuestionActivity not initialized");
};

export let processHumanAnswerActivity: ActivityFn<
  ProcessHumanAnswerInput,
  void
> = async () => {
  throw new Error("processHumanAnswerActivity not initialized");
};

export let initializeArchitectActorActivity: ActivityFn<
  InitializeArchitectActorInput,
  void
> = async () => {
  throw new Error("initializeArchitectActorActivity not initialized");
};

// ---------------------------------------------------------------------------
// Main Workflow
// ---------------------------------------------------------------------------

export const projectWorkflow: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: ProjectWorkflowInput
): any {
  const {
    issueNumber,
    issueTitle,
    repoOwner,
    repoName,
    projectItemId,
  } = input;
  const workflowId = ctx.getWorkflowInstanceId();

  console.log(
    `[Workflow] Starting board-driven workflow for issue #${issueNumber}: ${issueTitle}`
  );

  // =====================================================================
  // INTAKE phase (card is in Todo)
  // =====================================================================

  // 1a. Compress context for architect
  const architectContext: CompressContextOutput = yield ctx.callActivity(
    compressContextActivity,
    {
      sender: "project-manager",
      receiver: "architect-agent",
      projectId: `${repoOwner}/${repoName}`,
      taskSummary: `Decide technical approach for issue #${issueNumber}: ${issueTitle}`,
      priority: 5,
      workflowState: {
        phase: "INTAKE",
        issueNumber,
        issueTitle,
        repoOwner,
        repoName,
        projectItemId,
      },
      senderMemories: [],
      senderQuestions: [
        "What technical approach do you recommend?",
        "What are the acceptance criteria?",
        "Any integration concerns with existing services?",
      ],
      constraints: [],
      knownFailures: [],
    }
  );

  // 1b. Consult architect with compressed context
  const architectResult: ConsultArchitectOutput = yield ctx.callActivity(
    consultArchitectActivity,
    {
      question: architectContext.compressedContext,
    }
  );

  // 2. Enrich the issue with architect guidance
  yield ctx.callActivity(enrichIssueActivity, {
    issueNumber,
    repoOwner,
    repoName,
    guidance: architectResult.guidance,
    acceptanceCriteria: architectResult.fallback
      ? "Acceptance criteria pending architect review."
      : "See architect guidance above.",
  });

  // 3. Record pending move + move card Todo -> Planning
  yield ctx.callActivity(recordPendingMoveActivity, {
    projectItemId,
    toColumn: "Planning",
  });
  yield ctx.callActivity(moveCardActivity, {
    projectItemId,
    toColumn: "Planning",
  });

  // 4. Record workflow mapping in PostgreSQL
  yield ctx.callActivity(recordWorkflowMappingActivity, {
    issueNumber,
    repoOwner,
    repoName,
    workflowId,
    projectItemId,
  });

  console.log(`[Workflow] Issue #${issueNumber} moved to Planning`);

  // =====================================================================
  // PLANNING phase (card is in Planning)
  // =====================================================================

  // Load retry budget from database (persists across pod restarts)
  const retryBudget: LoadRetryBudgetOutput = yield ctx.callActivity(
    loadRetryBudgetActivity,
    { workflowId }
  );
  const maxCycles = input.retryBudget ?? retryBudget.retryBudget;

  // Complexity gate — check if issue is tagged "simple"
  const gate: ComplexityGateOutput = yield ctx.callActivity(
    complexityGateActivity,
    { issueNumber, repoOwner, repoName }
  );

  if (gate.simple) {
    console.log(`[Workflow] Issue #${issueNumber} is simple, skipping Opus planning`);
    // Skip planning — architect guidance from INTAKE is the plan
    yield ctx.callActivity(recordPendingMoveActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
    yield ctx.callActivity(moveCardActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
  } else {
    // Initialize architect actor for this issue
    const architectActorId = `${repoOwner}/${repoName}/${issueNumber}`;
    yield ctx.callActivity(initializeArchitectActorActivity, {
      actorId: architectActorId,
      issueNumber,
      repoOwner,
      repoName,
      workflowId,
      projectItemId,
      issueTitle,
    });

    // Start planning session via ImplementerActor
    const planSession: StartSessionOutput = yield ctx.callActivity(
      startSessionActivity,
      {
        issueNumber,
        repoOwner,
        repoName,
        workflowId,
        implementationPrompt: `Plan the implementation for issue #${issueNumber}: ${issueTitle}\n\nArchitect guidance:\n${architectResult.guidance}`,
        branch: `issue-${issueNumber}`,
      }
    );

    if (!planSession.ok) {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Planning session failed to start: ${planSession.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    // Event-driven planning loop
    let totalPlanCycles = retryBudget.planCyclesUsed;
    let planApproved = false;

    while (totalPlanCycles < maxCycles && !planApproved) {
      totalPlanCycles++;
      console.log(
        `[Workflow] Planning cycle ${totalPlanCycles}/${maxCycles} for issue #${issueNumber}`
      );

      // Wait for external event from SessionMonitor
      const planEvent: PlanningEventPayload = yield ctx.waitForExternalEvent("planning-event");

      if (planEvent.type === "session-failed") {
        yield ctx.callActivity(moveToFailedActivity, {
          issueNumber, repoOwner, repoName, projectItemId, workflowId,
          reason: `Planning session failed: ${planEvent.error}`,
        });
        return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
      }

      if (planEvent.type === "question-detected") {
        // Route question through architect actor
        const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
          consultArchitectActorActivity,
          {
            actorId: architectActorId,
            questionText: planEvent.questionText,
            source: "planning",
          }
        );

        if (archAnswer.confident) {
          // Inject answer back into Claude CLI session
          yield ctx.callActivity(injectAnswerActivity, {
            implementerActorId: `${repoOwner}-${repoName}-${issueNumber}`,
            answerText: archAnswer.answer!,
          });
        } else {
          // Escalate to human via ntfy
          yield ctx.callActivity(notifyHumanQuestionActivity, {
            issueNumber, repoOwner, repoName, workflowId,
            questionText: planEvent.questionText,
            architectBestGuess: archAnswer.bestGuess,
          });

          // Wait for human answer via ntfy reply webhook
          const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");

          // Process human answer through architect for Mem0 learning
          yield ctx.callActivity(processHumanAnswerActivity, {
            architectActorId,
            questionText: planEvent.questionText,
            humanAnswer: humanAnswer.answer,
          });

          // Inject human answer into Claude CLI session
          yield ctx.callActivity(injectAnswerActivity, {
            implementerActorId: `${repoOwner}-${repoName}-${issueNumber}`,
            answerText: humanAnswer.answer,
          });
        }

        // Loop back to wait for next event
        continue;
      }

      if (planEvent.type === "plan-complete") {
        // Review the plan via LLM
        const planReview: ReviewPlanOutput = yield ctx.callActivity(
          reviewPlanActivity,
          {
            issueNumber,
            repoOwner,
            repoName,
            planContent: planEvent.planContent,
          }
        );

        if (planReview.approved) {
          planApproved = true;
          console.log(`[Workflow] Plan approved for issue #${issueNumber}`);
        } else {
          yield ctx.callActivity(addCommentActivity, {
            issueNumber, repoOwner, repoName,
            body: `**Plan Review — Revision Needed** (confidence: ${(planReview.confidence * 100).toFixed(0)}%)\n\n${planReview.feedback}`,
          });
          yield ctx.callActivity(incrementRetryCycleActivity, {
            workflowId,
            phase: "planning",
            failureReason: planReview.feedback,
          });
          console.log(`[Workflow] Plan rejected for issue #${issueNumber}, cycle ${totalPlanCycles}`);
        }
      }
    }

    if (!planApproved) {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Plan not approved after ${maxCycles} revision cycles`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    // Plan approved -> move to In Progress
    yield ctx.callActivity(recordPendingMoveActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
    yield ctx.callActivity(moveCardActivity, {
      projectItemId,
      toColumn: "In Progress",
    });
  }

  console.log(`[Workflow] Issue #${issueNumber} moved to In Progress`);

  // =====================================================================
  // IMPLEMENTATION phase (card is in In Progress)
  // =====================================================================

  const architectActorIdImpl = `${repoOwner}/${repoName}/${issueNumber}`;
  const implActorId = `${repoOwner}-${repoName}-${issueNumber}`;
  let implComplete = false;
  let prNumber: number | null = null;

  while (!implComplete) {
    const implEvent: ImplEventPayload = yield ctx.waitForExternalEvent("impl-event");

    if (implEvent.type === "session-failed") {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `Implementation session failed: ${implEvent.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    if (implEvent.type === "question-detected") {
      const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
        consultArchitectActorActivity,
        { actorId: architectActorIdImpl, questionText: implEvent.questionText, source: "implementation" }
      );

      if (archAnswer.confident) {
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: archAnswer.answer!,
        });
      } else {
        yield ctx.callActivity(notifyHumanQuestionActivity, {
          issueNumber, repoOwner, repoName, workflowId,
          questionText: implEvent.questionText,
          architectBestGuess: archAnswer.bestGuess,
        });
        const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");
        yield ctx.callActivity(processHumanAnswerActivity, {
          architectActorId: architectActorIdImpl,
          questionText: implEvent.questionText,
          humanAnswer: humanAnswer.answer,
        });
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: humanAnswer.answer,
        });
      }
      continue;
    }

    if (implEvent.type === "pr-created") {
      prNumber = implEvent.prNumber;
      implComplete = true;
      console.log(`[Workflow] PR #${prNumber} created for issue #${issueNumber}`);
    }
  }

  // Move to QA
  yield ctx.callActivity(recordPendingMoveActivity, {
    projectItemId,
    toColumn: "QA",
  });
  yield ctx.callActivity(moveCardActivity, {
    projectItemId,
    toColumn: "QA",
  });

  console.log(`[Workflow] Issue #${issueNumber} moved to QA`);

  // =====================================================================
  // QA phase (card is in QA)
  // =====================================================================

  let qaCycles = retryBudget.qaCyclesUsed;
  let qaPassedFinal = false;

  while (qaCycles < maxCycles && !qaPassedFinal) {
    qaCycles++;
    console.log(
      `[Workflow] QA cycle ${qaCycles}/${maxCycles} for issue #${issueNumber}`
    );

    const qaEvent: QaEventPayload = yield ctx.waitForExternalEvent("qa-event");

    if (qaEvent.type === "session-failed") {
      yield ctx.callActivity(moveToFailedActivity, {
        issueNumber, repoOwner, repoName, projectItemId, workflowId,
        reason: `QA session failed: ${qaEvent.error}`,
      });
      return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
    }

    if (qaEvent.type === "question-detected") {
      const archAnswer: ConsultArchitectActorOutput = yield ctx.callActivity(
        consultArchitectActorActivity,
        { actorId: architectActorIdImpl, questionText: qaEvent.questionText, source: "qa" }
      );

      if (archAnswer.confident) {
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: archAnswer.answer!,
        });
      } else {
        yield ctx.callActivity(notifyHumanQuestionActivity, {
          issueNumber, repoOwner, repoName, workflowId,
          questionText: qaEvent.questionText,
          architectBestGuess: archAnswer.bestGuess,
        });
        const humanAnswer: HumanAnswerPayload = yield ctx.waitForExternalEvent("human-answer");
        yield ctx.callActivity(processHumanAnswerActivity, {
          architectActorId: architectActorIdImpl,
          questionText: qaEvent.questionText,
          humanAnswer: humanAnswer.answer,
        });
        yield ctx.callActivity(injectAnswerActivity, {
          implementerActorId: implActorId,
          answerText: humanAnswer.answer,
        });
      }
      continue;
    }

    if (qaEvent.type === "test-results") {
      const testEval: EvaluateTestResultsOutput = yield ctx.callActivity(
        evaluateTestResultsActivity,
        { issueNumber, repoOwner, repoName, testContent: qaEvent.testContent }
      );

      if (testEval.passed) {
        qaPassedFinal = true;
        console.log(`[Workflow] Tests passed for issue #${issueNumber}`);
      } else {
        yield ctx.callActivity(createBugIssueActivity, {
          repoOwner, repoName,
          parentIssueNumber: issueNumber,
          failures: testEval.failures,
        });
        yield ctx.callActivity(incrementRetryCycleActivity, {
          workflowId,
          phase: "qa",
          failureReason: testEval.failures.join("; "),
        });
        console.log(
          `[Workflow] Tests failed for issue #${issueNumber}, cycle ${qaCycles}`
        );
      }
    }
  }

  if (!qaPassedFinal) {
    yield ctx.callActivity(moveToFailedActivity, {
      issueNumber, repoOwner, repoName, projectItemId, workflowId,
      reason: `Tests did not pass after ${maxCycles} QA cycles`,
    });
    return { issueNumber, repoOwner, repoName, finalPhase: "FAILED" as WorkflowPhase };
  }

  // Tests pass -> move to Review
  yield ctx.callActivity(recordPendingMoveActivity, {
    projectItemId,
    toColumn: "Review",
  });
  yield ctx.callActivity(moveCardActivity, {
    projectItemId,
    toColumn: "Review",
  });

  console.log(`[Workflow] Issue #${issueNumber} moved to Review`);

  // =====================================================================
  // REVIEW phase (card is in Review)
  // =====================================================================

  // Construct the health URL from repo info
  // Convention: <repo-name>.bto.bar/healthz
  const healthUrl = `https://${repoName}.bto.bar/healthz`;

  // Wait for deployment to be live
  const deployResult: WaitForDeploymentOutput = yield ctx.callActivity(
    waitForDeploymentActivity,
    {
      repoOwner,
      repoName,
      healthUrl,
      timeoutMinutes: 10,
    }
  );

  if (deployResult.timedOut) {
    yield ctx.callActivity(notifyTimeoutActivity, {
      issueNumber,
      repoOwner,
      repoName,
      phase: "deployment",
      ntfyTopic: "mesh-six-pm",
    });
  }

  // Validate deployment via smoke tests
  const validationResult: ValidateDeploymentOutput = yield ctx.callActivity(
    validateDeploymentActivity,
    {
      repoOwner,
      repoName,
      healthUrl,
    }
  );

  if (!validationResult.passed) {
    // Validation failed -> move back to Planning
    yield ctx.callActivity(addCommentActivity, {
      issueNumber,
      repoOwner,
      repoName,
      body: `**Deployment Validation Failed**\n\nFailures:\n${validationResult.failures.map((f) => `- ${f}`).join("\n")}`,
    });

    yield ctx.callActivity(recordPendingMoveActivity, {
      projectItemId,
      toColumn: "Planning",
    });
    yield ctx.callActivity(moveCardActivity, {
      projectItemId,
      toColumn: "Planning",
    });

    yield ctx.callActivity(moveToFailedActivity, {
      issueNumber,
      repoOwner,
      repoName,
      projectItemId,
      workflowId,
      reason: `Deployment validation failed: ${validationResult.failures.join("; ")}`,
    });

    return {
      issueNumber,
      repoOwner,
      repoName,
      finalPhase: "FAILED" as WorkflowPhase,
    };
  }

  // Deployment validated -> move to Done
  yield ctx.callActivity(recordPendingMoveActivity, {
    projectItemId,
    toColumn: "Done",
  });
  yield ctx.callActivity(moveCardActivity, {
    projectItemId,
    toColumn: "Done",
  });

  console.log(`[Workflow] Issue #${issueNumber} moved to Done`);

  // =====================================================================
  // ACCEPTED — terminal success
  // =====================================================================

  yield ctx.callActivity(reportSuccessActivity, {
    issueNumber,
    repoOwner,
    repoName,
    projectItemId,
    workflowId,
  });

  console.log(
    `[Workflow] Issue #${issueNumber} completed successfully`
  );

  return {
    issueNumber,
    repoOwner,
    repoName,
    finalPhase: "ACCEPTED" as WorkflowPhase,
    prNumber: prNumber ?? undefined,
  } satisfies ProjectWorkflowResult;
};

// ---------------------------------------------------------------------------
// WorkflowActivityImplementations interface
// ---------------------------------------------------------------------------

export interface WorkflowActivityImplementations {
  consultArchitect: typeof consultArchitectActivity;
  enrichIssue: typeof enrichIssueActivity;
  recordPendingMove: typeof recordPendingMoveActivity;
  moveCard: typeof moveCardActivity;
  recordWorkflowMapping: typeof recordWorkflowMappingActivity;
  pollForPlan: typeof pollForPlanActivity;
  reviewPlan: typeof reviewPlanActivity;
  addComment: typeof addCommentActivity;
  pollForImplementation: typeof pollForImplementationActivity;
  pollForTestResults: typeof pollForTestResultsActivity;
  evaluateTestResults: typeof evaluateTestResultsActivity;
  waitForDeployment: typeof waitForDeploymentActivity;
  validateDeployment: typeof validateDeploymentActivity;
  createBugIssue: typeof createBugIssueActivity;
  notifyBlocked: typeof notifyBlockedActivity;
  notifyTimeout: typeof notifyTimeoutActivity;
  reportSuccess: typeof reportSuccessActivity;
  moveToFailed: typeof moveToFailedActivity;
  compressContext: typeof compressContextActivity;
  loadRetryBudget: typeof loadRetryBudgetActivity;
  incrementRetryCycle: typeof incrementRetryCycleActivity;
  attemptAutoResolve: typeof attemptAutoResolveActivity;
  complexityGate: typeof complexityGateActivity;
  startSession: typeof startSessionActivity;
  consultArchitectActor: typeof consultArchitectActorActivity;
  injectAnswer: typeof injectAnswerActivity;
  notifyHumanQuestion: typeof notifyHumanQuestionActivity;
  processHumanAnswer: typeof processHumanAnswerActivity;
  initializeArchitectActor: typeof initializeArchitectActorActivity;
}

// ---------------------------------------------------------------------------
// Runtime builder
// ---------------------------------------------------------------------------

export function createWorkflowRuntime(
  activityImpls: WorkflowActivityImplementations
): WorkflowRuntime {
  // Wire implementations to module-level stubs
  consultArchitectActivity = activityImpls.consultArchitect;
  enrichIssueActivity = activityImpls.enrichIssue;
  recordPendingMoveActivity = activityImpls.recordPendingMove;
  moveCardActivity = activityImpls.moveCard;
  recordWorkflowMappingActivity = activityImpls.recordWorkflowMapping;
  pollForPlanActivity = activityImpls.pollForPlan;
  reviewPlanActivity = activityImpls.reviewPlan;
  addCommentActivity = activityImpls.addComment;
  pollForImplementationActivity = activityImpls.pollForImplementation;
  pollForTestResultsActivity = activityImpls.pollForTestResults;
  evaluateTestResultsActivity = activityImpls.evaluateTestResults;
  waitForDeploymentActivity = activityImpls.waitForDeployment;
  validateDeploymentActivity = activityImpls.validateDeployment;
  createBugIssueActivity = activityImpls.createBugIssue;
  notifyBlockedActivity = activityImpls.notifyBlocked;
  notifyTimeoutActivity = activityImpls.notifyTimeout;
  reportSuccessActivity = activityImpls.reportSuccess;
  moveToFailedActivity = activityImpls.moveToFailed;
  compressContextActivity = activityImpls.compressContext;
  loadRetryBudgetActivity = activityImpls.loadRetryBudget;
  incrementRetryCycleActivity = activityImpls.incrementRetryCycle;
  attemptAutoResolveActivity = activityImpls.attemptAutoResolve;
  complexityGateActivity = activityImpls.complexityGate;
  startSessionActivity = activityImpls.startSession;
  consultArchitectActorActivity = activityImpls.consultArchitectActor;
  injectAnswerActivity = activityImpls.injectAnswer;
  notifyHumanQuestionActivity = activityImpls.notifyHumanQuestion;
  processHumanAnswerActivity = activityImpls.processHumanAnswer;
  initializeArchitectActorActivity = activityImpls.initializeArchitectActor;

  const runtime = new WorkflowRuntime({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });

  // Register the workflow
  runtime.registerWorkflow(projectWorkflow);

  // Register all activities
  runtime.registerActivity(consultArchitectActivity);
  runtime.registerActivity(enrichIssueActivity);
  runtime.registerActivity(recordPendingMoveActivity);
  runtime.registerActivity(moveCardActivity);
  runtime.registerActivity(recordWorkflowMappingActivity);
  runtime.registerActivity(pollForPlanActivity);
  runtime.registerActivity(reviewPlanActivity);
  runtime.registerActivity(addCommentActivity);
  runtime.registerActivity(pollForImplementationActivity);
  runtime.registerActivity(pollForTestResultsActivity);
  runtime.registerActivity(evaluateTestResultsActivity);
  runtime.registerActivity(waitForDeploymentActivity);
  runtime.registerActivity(validateDeploymentActivity);
  runtime.registerActivity(createBugIssueActivity);
  runtime.registerActivity(notifyBlockedActivity);
  runtime.registerActivity(notifyTimeoutActivity);
  runtime.registerActivity(reportSuccessActivity);
  runtime.registerActivity(moveToFailedActivity);
  runtime.registerActivity(compressContextActivity);
  runtime.registerActivity(loadRetryBudgetActivity);
  runtime.registerActivity(incrementRetryCycleActivity);
  runtime.registerActivity(attemptAutoResolveActivity);
  runtime.registerActivity(complexityGateActivity);
  runtime.registerActivity(startSessionActivity);
  runtime.registerActivity(consultArchitectActorActivity);
  runtime.registerActivity(injectAnswerActivity);
  runtime.registerActivity(notifyHumanQuestionActivity);
  runtime.registerActivity(processHumanAnswerActivity);
  runtime.registerActivity(initializeArchitectActorActivity);

  return runtime;
}

// ---------------------------------------------------------------------------
// Workflow client helpers
// ---------------------------------------------------------------------------

export function createWorkflowClient(): DaprWorkflowClient {
  return new DaprWorkflowClient({
    daprHost: DAPR_HOST,
    daprPort: DAPR_HTTP_PORT,
  });
}

/**
 * Start a new project workflow instance.
 */
export async function startProjectWorkflow(
  client: DaprWorkflowClient,
  input: ProjectWorkflowInput,
  instanceId?: string
): Promise<string> {
  const workflowInstanceId = instanceId || crypto.randomUUID();
  await client.scheduleNewWorkflow(projectWorkflow, input, workflowInstanceId);
  console.log(
    `[Workflow Client] Started workflow instance: ${workflowInstanceId} for issue #${input.issueNumber}`
  );
  return workflowInstanceId;
}

/**
 * Get workflow status.
 */
export async function getProjectWorkflowStatus(
  client: DaprWorkflowClient,
  instanceId: string,
  includeInputsOutputs = false
): Promise<unknown> {
  return client.getWorkflowState(instanceId, includeInputsOutputs);
}

/**
 * Raise an external event on a running workflow.
 */
export async function raiseWorkflowEvent(
  client: DaprWorkflowClient,
  instanceId: string,
  eventName: string,
  eventData?: unknown
): Promise<void> {
  await client.raiseEvent(instanceId, eventName, eventData ?? {});
  console.log(
    `[Workflow Client] Raised event "${eventName}" on instance ${instanceId}`
  );
}

/**
 * Terminate a workflow.
 */
export async function terminateProjectWorkflow(
  client: DaprWorkflowClient,
  instanceId: string,
  reason?: string
): Promise<void> {
  await client.terminateWorkflow(instanceId, {
    reason: reason || "Terminated by user",
  });
  console.log(
    `[Workflow Client] Terminated workflow ${instanceId}: ${reason || "No reason provided"}`
  );
}

/**
 * Purge a completed workflow from state store.
 */
export async function purgeProjectWorkflow(
  client: DaprWorkflowClient,
  instanceId: string
): Promise<boolean> {
  const result = await client.purgeWorkflow(instanceId);
  console.log(`[Workflow Client] Purged workflow ${instanceId}`);
  return result;
}

// ---------------------------------------------------------------------------
// Polling helper (used by activity implementations)
// ---------------------------------------------------------------------------

/**
 * Generic polling loop with deadline-based timeout and Blocked column detection.
 *
 * @param pollFn Function that performs one poll. Returns the result or null to keep polling.
 * @param checkBlocked Function that checks if the card has moved to Blocked column.
 * @param timeoutMinutes Total time budget for polling.
 * @param intervalMs Polling interval in milliseconds (default: 15000).
 * @returns The poll result, or { timedOut: true } / { blocked: true }.
 */
export async function pollGithubForCompletion<T>(
  pollFn: () => Promise<T | null>,
  checkBlocked: () => Promise<boolean>,
  timeoutMinutes: number,
  intervalMs = 15_000
): Promise<{ result: T | null; timedOut: boolean; blocked: boolean }> {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  while (Date.now() < deadline) {
    // Check if card has been moved to Blocked
    const isBlocked = await checkBlocked();
    if (isBlocked) {
      return { result: null, timedOut: false, blocked: true };
    }

    // Attempt the poll
    const result = await pollFn();
    if (result !== null) {
      return { result, timedOut: false, blocked: false };
    }

    // Add 0-5s random jitter to prevent synchronized polling from concurrent workflows
    const jitter = Math.floor(Math.random() * 5000);
    await new Promise((resolve) => setTimeout(resolve, intervalMs + jitter));
  }

  return { result: null, timedOut: true, blocked: false };
}
