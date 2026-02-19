import { describe, it, expect } from "bun:test";
import { validateCompression, extractTechnicalTerms } from "../validation.js";

function makeValidOutput(): string {
  return [
    "METADATA:",
    "  sender: project-manager",
    "  receiver: architect-agent",
    "  project: test/repo",
    "  task: Design auth service",
    "  priority: 5",
    "",
    "DOMAIN_CONTEXT:",
    "- Uses Dapr for service invocation",
    "- @mesh-six/core provides agent registry",
    "",
    "OPEN_QUESTIONS:",
    "1. What database should we use?",
  ].join("\n");
}

function makeValidInput(): string {
  return [
    "Sender: project-manager",
    "Receiver: architect-agent",
    "Project: test/repo",
    "Task: Design auth service",
    "Priority: 5",
    "",
    "--- SENDER CONTEXT ---",
    "",
    "WORKFLOW STATE:",
    JSON.stringify({ phase: "INTAKE", issueNumber: 42 }),
    "",
    "Uses Dapr for service invocation",
    "@mesh-six/core provides agent registry",
    "",
    "SENDER'S QUESTIONS:",
    "1. What database should we use?",
  ].join("\n");
}

describe("validateCompression", () => {
  it("valid output with all required sections passes validation", () => {
    const result = validateCompression(makeValidOutput(), makeValidInput());
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("missing METADATA section fails validation", () => {
    const output = makeValidOutput().replace("METADATA:", "OMITTED:");
    const result = validateCompression(output, makeValidInput());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("METADATA:"))).toBe(true);
  });

  it("missing DOMAIN_CONTEXT section fails validation", () => {
    const output = makeValidOutput().replace("DOMAIN_CONTEXT:", "OMITTED:");
    const result = validateCompression(output, makeValidInput());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("DOMAIN_CONTEXT:"))).toBe(true);
  });

  it("invented library name is flagged as hallucination", () => {
    const output = makeValidOutput() + "\n- Uses @invented/library for caching";
    const result = validateCompression(output, makeValidInput());
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("@invented/library"))).toBe(true);
  });

  it("known library from input passes without hallucination error", () => {
    // @mesh-six/core appears in both input and output
    const result = validateCompression(makeValidOutput(), makeValidInput());
    const meshSixErrors = result.errors.filter((e) => e.includes("@mesh-six/core"));
    expect(meshSixErrors).toHaveLength(0);
  });

  it("relevance scores (0.87) flagged as leaked metadata warning", () => {
    const output = makeValidOutput() + "\n- Memory (0.87) about auth patterns";
    const result = validateCompression(output, makeValidInput());
    expect(result.warnings.some((w) => w.includes("pattern"))).toBe(true);
  });

  it("ISO timestamps flagged as leaked metadata warning", () => {
    const output = makeValidOutput() + "\n- Created at 2024-01-15T10:30:00Z";
    const result = validateCompression(output, makeValidInput());
    expect(result.warnings.some((w) => w.includes("pattern"))).toBe(true);
  });

  it("GitHub PVTI IDs flagged as leaked metadata warning", () => {
    const output = makeValidOutput() + "\n- Linked to PVTI_lADOBq7FVM4";
    const result = validateCompression(output, makeValidInput());
    expect(result.warnings.some((w) => w.includes("pattern"))).toBe(true);
  });

  it("output longer than input generates warning (not error)", () => {
    const shortInput = "short";
    const result = validateCompression(makeValidOutput(), shortInput);
    expect(result.warnings.some((w) => w.includes("not shorter"))).toBe(true);
  });
});

describe("extractTechnicalTerms", () => {
  it("finds @scope/package names", () => {
    const terms = extractTechnicalTerms("Uses @mesh-six/core and @ai-sdk/openai");
    expect(terms).toContain("@mesh-six/core");
    expect(terms).toContain("@ai-sdk/openai");
  });

  it("finds version numbers", () => {
    const terms = extractTechnicalTerms("Version v1.16.9 and 3.8");
    expect(terms.some((t) => t.includes("1.16.9"))).toBe(true);
    expect(terms.some((t) => t.includes("3.8"))).toBe(true);
  });

  it("ignores common English words", () => {
    const terms = extractTechnicalTerms("The Project Context Metadata Domain");
    // All these should be filtered by COMMON_WORDS
    expect(terms.some((t) => t.toLowerCase() === "the")).toBe(false);
    expect(terms.some((t) => t.toLowerCase() === "metadata")).toBe(false);
  });

  it("finds capitalized technical terms", () => {
    const terms = extractTechnicalTerms("Uses Dapr and XState for orchestration");
    expect(terms).toContain("Dapr");
    expect(terms).toContain("XState");
  });
});
