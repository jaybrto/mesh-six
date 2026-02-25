import { describe, it, expect } from "bun:test";
import { pollGithubForCompletion } from "../workflow.js";
import type {
  ProjectWorkflowInput,
  LoadRetryBudgetInput,
  LoadRetryBudgetOutput,
  IncrementRetryCycleInput,
} from "../workflow.js";

describe("Retry Budget types", () => {
  it("ProjectWorkflowInput accepts optional retryBudget", () => {
    const input: ProjectWorkflowInput = {
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test-owner",
      repoName: "test-repo",
      projectItemId: "PVTI_abc",
      contentNodeId: "I_abc",
      retryBudget: 5,
    };
    expect(input.retryBudget).toBe(5);
  });

  it("ProjectWorkflowInput defaults retryBudget to undefined", () => {
    const input: ProjectWorkflowInput = {
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test-owner",
      repoName: "test-repo",
      projectItemId: "PVTI_abc",
      contentNodeId: "I_abc",
    };
    expect(input.retryBudget).toBeUndefined();
  });

  it("LoadRetryBudgetOutput has cycle counts and budget", () => {
    const output: LoadRetryBudgetOutput = {
      planCyclesUsed: 1,
      qaCyclesUsed: 0,
      retryBudget: 3,
    };
    expect(output.planCyclesUsed).toBe(1);
    expect(output.qaCyclesUsed).toBe(0);
    expect(output.retryBudget).toBe(3);
  });

  it("IncrementRetryCycleInput specifies phase and failure reason", () => {
    const input: IncrementRetryCycleInput = {
      workflowId: "wf-123",
      phase: "planning",
      failureReason: "Plan lacked test coverage section",
    };
    expect(input.phase).toBe("planning");
    expect(input.failureReason).toContain("test coverage");
  });
});

describe("pollGithubForCompletion", () => {
  it("completes when pollFn returns a result", async () => {
    let calls = 0;
    const { result, timedOut, blocked } = await pollGithubForCompletion(
      async () => {
        calls++;
        return calls >= 2 ? "found" : null;
      },
      async () => false,
      1,
      50
    );
    expect(result).toBe("found");
    expect(timedOut).toBe(false);
    expect(blocked).toBe(false);
    expect(calls).toBe(2);
  });

  it("returns blocked when checkBlocked returns true", async () => {
    const { result, blocked } = await pollGithubForCompletion(
      async () => null,
      async () => true,
      1,
      50
    );
    expect(result).toBeNull();
    expect(blocked).toBe(true);
  });
});
