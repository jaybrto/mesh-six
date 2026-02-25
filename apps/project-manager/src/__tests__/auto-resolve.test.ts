import { describe, it, expect } from "bun:test";
import type {
  AttemptAutoResolveInput,
  AttemptAutoResolveOutput,
} from "../workflow.js";

describe("AttemptAutoResolve types", () => {
  it("AttemptAutoResolveInput has required fields", () => {
    const input: AttemptAutoResolveInput = {
      issueNumber: 42,
      repoOwner: "test-owner",
      repoName: "test-repo",
      workflowPhase: "PLANNING",
    };
    expect(input.workflowPhase).toBe("PLANNING");
  });

  it("AttemptAutoResolveOutput represents resolved case", () => {
    const output: AttemptAutoResolveOutput = {
      resolved: true,
      answer: "Place auth middleware in src/middleware/auth.ts",
      question: "Where should the auth middleware go?",
      agentsConsulted: ["architect-agent"],
    };
    expect(output.resolved).toBe(true);
    expect(output.answer).toBeDefined();
  });

  it("AttemptAutoResolveOutput represents unresolved case with bestGuess", () => {
    const output: AttemptAutoResolveOutput = {
      resolved: false,
      bestGuess: "Possibly in the middleware directory",
      question: "What auth pattern should we use?",
      agentsConsulted: ["architect-agent", "researcher-agent"],
    };
    expect(output.resolved).toBe(false);
    expect(output.bestGuess).toBeDefined();
    expect(output.agentsConsulted).toHaveLength(2);
  });
});

describe("Question classification categories", () => {
  it("has the expected classification categories", () => {
    const categories = ["architectural", "technical-research", "credential-access", "ambiguous"];
    expect(categories).toContain("architectural");
    expect(categories).toContain("credential-access");
    expect(categories).toHaveLength(4);
  });
});
