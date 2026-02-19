import { describe, it, expect } from "bun:test";
import type {
  CompressContextInput,
  CompressContextOutput,
} from "../workflow.js";

/**
 * Tests for the compressContext activity behavior.
 * These test the activity contract (input/output shape, fallback behavior)
 * without requiring a running Dapr sidecar or Context Service.
 */

function makeCompressInput(
  overrides: Partial<CompressContextInput> = {}
): CompressContextInput {
  return {
    sender: "project-manager",
    receiver: "architect-agent",
    projectId: "test-owner/test-repo",
    taskSummary: "Decide technical approach for issue #42: Add auth",
    priority: 5,
    workflowState: {
      phase: "INTAKE",
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test-owner",
      repoName: "test-repo",
      projectItemId: "PVTI_abc123",
    },
    senderMemories: [],
    senderQuestions: [
      "What technical approach do you recommend?",
      "What are the acceptance criteria?",
      "Any integration concerns with existing services?",
    ],
    constraints: [],
    knownFailures: [],
    ...overrides,
  };
}

/**
 * Simulate the fallback behavior that runs when the Context Service is unreachable.
 * This mirrors the logic in the activity implementation in index.ts.
 */
function buildFallbackContext(input: CompressContextInput): CompressContextOutput {
  const fallbackContext = [
    `Task: ${input.taskSummary}`,
    `Priority: ${input.priority}`,
    `Project: ${input.projectId}`,
    ...(input.senderQuestions.length > 0
      ? ["", "Questions:", ...input.senderQuestions.map((q, i) => `${i + 1}. ${q}`)]
      : []),
  ].join("\n");

  return {
    compressedContext: fallbackContext,
    method: "passthrough",
    compressionRatio: 1,
    durationMs: 0,
    fallback: true,
  };
}

describe("CompressContext activity contract", () => {
  it("CompressContextInput has all required fields for the context-service /compress endpoint", () => {
    const input = makeCompressInput();
    expect(input.sender).toBe("project-manager");
    expect(input.receiver).toBe("architect-agent");
    expect(input.projectId).toBe("test-owner/test-repo");
    expect(input.taskSummary).toContain("issue #42");
    expect(input.priority).toBe(5);
    expect(input.workflowState).toBeDefined();
    expect(input.senderMemories).toBeArray();
    expect(input.senderQuestions).toBeArray();
  });

  it("CompressContextOutput has compressedContext and method fields", () => {
    const output: CompressContextOutput = {
      compressedContext: "METADATA:\n  sender: project-manager\n  receiver: architect-agent",
      method: "deterministic",
      compressionRatio: 0.3,
      durationMs: 2,
      fallback: false,
    };
    expect(output.compressedContext).toContain("METADATA:");
    expect(output.method).toBe("deterministic");
    expect(output.fallback).toBe(false);
  });

  it("fallback context includes task summary and priority", () => {
    const input = makeCompressInput();
    const fallback = buildFallbackContext(input);
    expect(fallback.compressedContext).toContain("Task: Decide technical approach for issue #42: Add auth");
    expect(fallback.compressedContext).toContain("Priority: 5");
    expect(fallback.compressedContext).toContain("Project: test-owner/test-repo");
  });

  it("fallback context includes sender questions", () => {
    const input = makeCompressInput();
    const fallback = buildFallbackContext(input);
    expect(fallback.compressedContext).toContain("Questions:");
    expect(fallback.compressedContext).toContain("1. What technical approach do you recommend?");
    expect(fallback.compressedContext).toContain("2. What are the acceptance criteria?");
    expect(fallback.compressedContext).toContain("3. Any integration concerns with existing services?");
  });

  it("fallback context omits Questions section when no questions", () => {
    const input = makeCompressInput({ senderQuestions: [] });
    const fallback = buildFallbackContext(input);
    expect(fallback.compressedContext).not.toContain("Questions:");
  });

  it("fallback output has method passthrough and fallback true", () => {
    const input = makeCompressInput();
    const fallback = buildFallbackContext(input);
    expect(fallback.method).toBe("passthrough");
    expect(fallback.fallback).toBe(true);
    expect(fallback.compressionRatio).toBe(1);
    expect(fallback.durationMs).toBe(0);
  });

  it("INTAKE phase compression input includes correct workflow state fields", () => {
    const input = makeCompressInput();
    expect(input.workflowState.phase).toBe("INTAKE");
    expect(input.workflowState.issueNumber).toBe(42);
    expect(input.workflowState.issueTitle).toBe("Add auth");
    expect(input.workflowState.repoOwner).toBe("test-owner");
    expect(input.workflowState.repoName).toBe("test-repo");
    expect(input.workflowState.projectItemId).toBe("PVTI_abc123");
  });

  it("compressed context string can be passed as ConsultArchitectInput.question", () => {
    const output: CompressContextOutput = {
      compressedContext: "METADATA:\n  sender: project-manager\n  receiver: architect-agent\n  project: test/repo\n  task: Design auth\n  priority: 5\n\nDOMAIN_CONTEXT:\n- phase: INTAKE\n\nOPEN_QUESTIONS:\n1. What approach?",
      method: "deterministic",
      compressionRatio: 0.3,
      durationMs: 2,
      fallback: false,
    };
    // The architect activity takes { question: string }
    const architectInput = { question: output.compressedContext };
    expect(architectInput.question).toContain("METADATA:");
    expect(architectInput.question).toContain("DOMAIN_CONTEXT:");
    expect(architectInput.question.length).toBeGreaterThan(0);
  });
});
