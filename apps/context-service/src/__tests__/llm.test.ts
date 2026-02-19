import { describe, it, expect } from "bun:test";
import { formatRequestForLLM, COMPRESSION_SYSTEM_PROMPT } from "../llm.js";
import type { CompressionRequest } from "@mesh-six/core";

function makeRequest(overrides: Partial<CompressionRequest> = {}): CompressionRequest {
  return {
    sender: "project-manager",
    receiver: "architect-agent",
    projectId: "test/repo",
    taskSummary: "Design the payment service",
    priority: 7,
    workflowState: { phase: "design", components: ["api-gateway", "payment-processor"] },
    senderMemories: ["Use idempotency keys for payment APIs"],
    senderQuestions: ["Should we support multi-currency from day one?"],
    conversationSnippet: [
      { role: "user", content: "We need PCI compliance" },
      { role: "assistant", content: "Understood, scoping PII storage" },
    ],
    constraints: ["Must be PCI DSS compliant"],
    knownFailures: ["Previous payment integration timed out under load"],
    ...overrides,
  };
}

describe("formatRequestForLLM", () => {
  it("includes sender, receiver, project, task, and priority", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("project-manager");
    expect(text).toContain("architect-agent");
    expect(text).toContain("test/repo");
    expect(text).toContain("Design the payment service");
    expect(text).toContain("7");
  });

  it("includes workflow state as JSON", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("WORKFLOW STATE:");
    expect(text).toContain("api-gateway");
    expect(text).toContain("payment-processor");
  });

  it("includes sender memories when present", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("SENDER'S LONG-TERM MEMORIES:");
    expect(text).toContain("Use idempotency keys for payment APIs");
  });

  it("omits SENDER'S LONG-TERM MEMORIES section when array is empty", () => {
    const text = formatRequestForLLM(makeRequest({ senderMemories: [] }));
    expect(text).not.toContain("SENDER'S LONG-TERM MEMORIES:");
  });

  it("includes sender questions when present", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("SENDER'S QUESTIONS:");
    expect(text).toContain("Should we support multi-currency from day one?");
  });

  it("includes constraints when present", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("HARD CONSTRAINTS:");
    expect(text).toContain("Must be PCI DSS compliant");
  });

  it("includes conversation history when present", () => {
    const text = formatRequestForLLM(makeRequest());
    expect(text).toContain("CONVERSATION HISTORY:");
    expect(text).toContain("[user]: We need PCI compliance");
  });
});

describe("COMPRESSION_SYSTEM_PROMPT", () => {
  it("contains anti-hallucination instruction", () => {
    expect(COMPRESSION_SYSTEM_PROMPT).toContain("NEVER invent");
  });

  it("specifies token budget of under 300 tokens", () => {
    expect(COMPRESSION_SYSTEM_PROMPT).toContain("under 300 tokens");
  });

  it("specifies the METADATA/DOMAIN_CONTEXT output format", () => {
    expect(COMPRESSION_SYSTEM_PROMPT).toContain("METADATA:");
    expect(COMPRESSION_SYSTEM_PROMPT).toContain("DOMAIN_CONTEXT:");
  });
});
