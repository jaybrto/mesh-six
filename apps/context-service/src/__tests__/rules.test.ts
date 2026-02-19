import { describe, it, expect } from "bun:test";
import { findRule, applyRules, deleteNestedField } from "../rules.js";
import type { CompressionRequest, CompressionRule } from "@mesh-six/core";

function makeRequest(overrides: Partial<CompressionRequest> = {}): CompressionRequest {
  return {
    sender: "project-manager",
    receiver: "architect-agent",
    projectId: "test/repo",
    taskSummary: "Design the auth service",
    priority: 5,
    workflowState: {
      phase: "INTAKE",
      issueNumber: 42,
      issueTitle: "Add auth",
      repoOwner: "test",
      repoName: "repo",
      createdAt: "2024-01-01T00:00:00Z",
      projectItemId: "PVTI_abc123",
      workflowId: "wf-123",
      planCycles: 2,
      qaCycles: 0,
      blockers: [],
      contentNodeId: "cn-1",
      detectedVia: "webhook",
    },
    senderMemories: [
      "Use JWT for auth",
      "Prefer stateless design",
      "Cache tokens in Redis",
      "Rotate secrets every 90 days",
      "Use bcrypt for passwords",
      "Rate limit login attempts",
    ],
    senderQuestions: [
      "What database should we use?",
      "Should we support OAuth?",
    ],
    conversationSnippet: [
      { role: "user", content: "Message 1" },
      { role: "assistant", content: "Message 2" },
      { role: "user", content: "Message 3" },
      { role: "assistant", content: "Message 4" },
    ],
    constraints: ["Must support SSO"],
    knownFailures: ["Previous JWT implementation had token leaks"],
    ...overrides,
  };
}

describe("findRule", () => {
  it("returns pm-to-architect for project-manager -> architect-agent", () => {
    const rule = findRule("project-manager", "architect-agent");
    expect(rule.id).toBe("pm-to-architect");
  });

  it("returns pm-to-researcher for project-manager -> researcher-agent", () => {
    const rule = findRule("project-manager", "researcher-agent");
    expect(rule.id).toBe("pm-to-researcher");
  });

  it("returns generic catch-all for unknown pair", () => {
    const rule = findRule("unknown", "unknown");
    expect(rule.id).toBe("generic");
    expect(rule.sender).toBe("*");
    expect(rule.receiver).toBe("*");
  });

  it("custom rules take priority over defaults", () => {
    const custom: CompressionRule = {
      id: "custom-rule",
      sender: "project-manager",
      receiver: "architect-agent",
      stripFields: [],
      preserveFields: [],
      maxMemories: 1,
      maxConversationMessages: 1,
      tokenCeiling: 100,
    };
    const rule = findRule("project-manager", "architect-agent", [custom]);
    expect(rule.id).toBe("custom-rule");
  });
});

describe("applyRules", () => {
  it("strips specified fields from workflow state", () => {
    const rule = findRule("project-manager", "architect-agent");
    const result = applyRules(makeRequest(), rule);
    // pm-to-architect strips createdAt, projectItemId, workflowId, etc.
    expect(result.text).not.toContain("PVTI_abc123");
    expect(result.text).not.toContain("wf-123");
    expect(result.text).not.toContain("2024-01-01");
  });

  it("preserves non-stripped fields", () => {
    const rule = findRule("project-manager", "architect-agent");
    const result = applyRules(makeRequest(), rule);
    // issueNumber, issueTitle, repoOwner, repoName, phase are preserved
    expect(result.text).toContain("42");
    expect(result.text).toContain("Add auth");
    expect(result.text).toContain("INTAKE");
  });

  it("truncates memories to maxMemories", () => {
    const rule = findRule("project-manager", "architect-agent"); // maxMemories: 4
    const result = applyRules(makeRequest(), rule);
    expect(result.text).toContain("Use JWT for auth");
    expect(result.text).toContain("Rotate secrets every 90 days"); // 4th memory
    expect(result.text).not.toContain("Use bcrypt for passwords"); // 5th, truncated
  });

  it("truncates conversation to maxConversationMessages", () => {
    const rule = findRule("project-manager", "architect-agent"); // maxConversationMessages: 2
    const result = applyRules(makeRequest(), rule);
    // Takes last N messages: Message 3 and Message 4
    expect(result.text).toContain("Message 3");
    expect(result.text).toContain("Message 4");
    expect(result.text).not.toContain("Message 1");
  });

  it("returns sufficient=true when under token ceiling", () => {
    const rule: CompressionRule = {
      id: "big",
      sender: "*",
      receiver: "*",
      stripFields: [],
      preserveFields: [],
      maxMemories: 1,
      maxConversationMessages: 0,
      tokenCeiling: 999999,
    };
    const result = applyRules(makeRequest(), rule);
    expect(result.sufficient).toBe(true);
  });

  it("returns sufficient=false when over token ceiling", () => {
    const rule: CompressionRule = {
      id: "tiny",
      sender: "*",
      receiver: "*",
      stripFields: [],
      preserveFields: [],
      maxMemories: 5,
      maxConversationMessages: 4,
      tokenCeiling: 1,
    };
    const result = applyRules(makeRequest(), rule);
    expect(result.sufficient).toBe(false);
  });

  it("output contains all required sections", () => {
    const rule = findRule("project-manager", "architect-agent");
    const result = applyRules(makeRequest(), rule);
    expect(result.text).toContain("METADATA:");
    expect(result.text).toContain("sender: project-manager");
    expect(result.text).toContain("receiver: architect-agent");
    expect(result.text).toContain("DOMAIN_CONTEXT:");
    expect(result.text).toContain("CONSTRAINTS:");
    expect(result.text).toContain("KNOWN_FAILURES:");
    expect(result.text).toContain("OPEN_QUESTIONS:");
  });

  it("omits CONSTRAINTS section when constraints array is empty", () => {
    const rule = findRule("project-manager", "architect-agent");
    const result = applyRules(makeRequest({ constraints: [] }), rule);
    expect(result.text).not.toContain("CONSTRAINTS:");
  });

  it("omits KNOWN_FAILURES section when knownFailures array is empty", () => {
    const rule = findRule("project-manager", "architect-agent");
    const result = applyRules(makeRequest({ knownFailures: [] }), rule);
    expect(result.text).not.toContain("KNOWN_FAILURES:");
  });
});

describe("deleteNestedField", () => {
  it("deletes a top-level field", () => {
    const obj: Record<string, unknown> = { a: 1, b: 2 };
    deleteNestedField(obj, "a");
    expect(obj).not.toHaveProperty("a");
    expect(obj.b).toBe(2);
  });

  it("handles dot-notation paths", () => {
    const obj: Record<string, unknown> = {
      nested: { deep: { value: 42 }, keep: "yes" },
    };
    deleteNestedField(obj, "nested.deep");
    const nested = obj.nested as Record<string, unknown>;
    expect(nested).not.toHaveProperty("deep");
    expect(nested.keep).toBe("yes");
  });

  it("does nothing when path does not exist", () => {
    const obj: Record<string, unknown> = { a: 1 };
    expect(() => deleteNestedField(obj, "b.c.d")).not.toThrow();
    expect(obj.a).toBe(1);
  });
});
