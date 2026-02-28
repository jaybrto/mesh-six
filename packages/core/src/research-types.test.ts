import { describe, it, expect } from "bun:test";
import {
  ResearchSessionStatusSchema,
  ReviewVerdictSchema,
  ResearchAndPlanInputSchema,
  ResearchAndPlanOutputSchema,
  ArchitectTriageInputSchema,
  ArchitectTriageOutputSchema,
  StartDeepResearchInputSchema,
  StartDeepResearchOutputSchema,
  ReviewResearchInputSchema,
  ReviewResearchOutputSchema,
  ArchitectDraftPlanInputSchema,
  SendPushNotificationInputSchema,
  UpdateResearchSessionInputSchema,
  TriageLLMResponseSchema,
  ReviewLLMResponseSchema,
  ScrapeCompletedPayloadSchema,
  SCRAPE_COMPLETED_EVENT,
  MAX_RESEARCH_CYCLES,
  RESEARCH_TIMEOUT_MS,
  RESEARCH_MINIO_BUCKET,
  TIMEOUT_SENTINEL,
} from "./research-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Research constants", () => {
  it("SCRAPE_COMPLETED_EVENT is a non-empty string", () => {
    expect(SCRAPE_COMPLETED_EVENT).toBe("ScrapeCompleted");
  });

  it("MAX_RESEARCH_CYCLES is a positive integer", () => {
    expect(MAX_RESEARCH_CYCLES).toBe(3);
    expect(Number.isInteger(MAX_RESEARCH_CYCLES)).toBe(true);
  });

  it("RESEARCH_TIMEOUT_MS equals 15 minutes", () => {
    expect(RESEARCH_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it("RESEARCH_MINIO_BUCKET is set", () => {
    expect(RESEARCH_MINIO_BUCKET).toBe("mesh-six-research");
  });

  it("TIMEOUT_SENTINEL is a unique string", () => {
    expect(TIMEOUT_SENTINEL).toBe("__TIMEOUT__");
  });
});

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

describe("ResearchSessionStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const s of ["TRIAGING", "DISPATCHED", "IN_PROGRESS", "REVIEW", "COMPLETED", "FAILED", "TIMEOUT"] as const) {
      expect(ResearchSessionStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    expect(() => ResearchSessionStatusSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("ReviewVerdictSchema", () => {
  it("accepts APPROVED and INCOMPLETE", () => {
    expect(ReviewVerdictSchema.parse("APPROVED")).toBe("APPROVED");
    expect(ReviewVerdictSchema.parse("INCOMPLETE")).toBe("INCOMPLETE");
  });

  it("rejects invalid verdict", () => {
    expect(() => ReviewVerdictSchema.parse("REJECTED")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workflow I/O schemas
// ---------------------------------------------------------------------------

describe("ResearchAndPlanInputSchema", () => {
  const validInput = {
    taskId: "task-123",
    issueNumber: 42,
    issueTitle: "Add caching layer",
    repoOwner: "jaybrto",
    repoName: "mesh-six",
    workflowId: "wf-abc",
    architectActorId: "jaybrto/mesh-six/42",
  };

  it("accepts valid input", () => {
    const result = ResearchAndPlanInputSchema.parse(validInput);
    expect(result.taskId).toBe("task-123");
    expect(result.issueNumber).toBe(42);
  });

  it("accepts optional projectItemId", () => {
    const result = ResearchAndPlanInputSchema.parse({ ...validInput, projectItemId: "item-1" });
    expect(result.projectItemId).toBe("item-1");
  });

  it("rejects empty taskId", () => {
    expect(() => ResearchAndPlanInputSchema.parse({ ...validInput, taskId: "" })).toThrow();
  });

  it("rejects missing workflowId", () => {
    const { workflowId, ...rest } = validInput;
    expect(() => ResearchAndPlanInputSchema.parse(rest)).toThrow();
  });
});

describe("ResearchAndPlanOutputSchema", () => {
  it("accepts valid output", () => {
    const result = ResearchAndPlanOutputSchema.parse({
      plan: "# Plan\n\nDo the thing",
      researchCompleted: true,
      totalResearchCycles: 2,
      timedOut: false,
      deepResearchDocId: "research/clean/task-123/clean-research.md",
    });
    expect(result.researchCompleted).toBe(true);
  });

  it("accepts null deepResearchDocId", () => {
    const result = ResearchAndPlanOutputSchema.parse({
      plan: "# Plan",
      researchCompleted: false,
      totalResearchCycles: 0,
      timedOut: true,
      deepResearchDocId: null,
    });
    expect(result.deepResearchDocId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Activity I/O schemas
// ---------------------------------------------------------------------------

describe("ArchitectTriageInputSchema", () => {
  it("requires workflowId (fixes H2)", () => {
    expect(() =>
      ArchitectTriageInputSchema.parse({
        taskId: "t1",
        issueNumber: 1,
        issueTitle: "Test",
        repoOwner: "o",
        repoName: "r",
        // workflowId missing
      }),
    ).toThrow();
  });
});

describe("StartDeepResearchOutputSchema", () => {
  it("includes optional rawMinioKey (fixes GPT-H2)", () => {
    const result = StartDeepResearchOutputSchema.parse({
      status: "STARTED",
      statusDocKey: "research/status/t1/status.json",
      rawMinioKey: "research/raw/t1/raw-scraper-result.md",
    });
    expect(result.rawMinioKey).toBe("research/raw/t1/raw-scraper-result.md");
  });

  it("allows COMPLETED status with rawMinioKey for idempotent path", () => {
    const result = StartDeepResearchOutputSchema.parse({
      status: "COMPLETED",
      statusDocKey: "research/status/t1/status.json",
      rawMinioKey: "research/raw/t1/raw-scraper-result.md",
    });
    expect(result.status).toBe("COMPLETED");
  });
});

describe("ReviewResearchOutputSchema", () => {
  it("accepts APPROVED with cleanMinioKey", () => {
    const result = ReviewResearchOutputSchema.parse({
      status: "APPROVED",
      cleanMinioKey: "research/clean/t1/clean-research.md",
    });
    expect(result.status).toBe("APPROVED");
  });

  it("accepts INCOMPLETE with newFollowUpPrompt", () => {
    const result = ReviewResearchOutputSchema.parse({
      status: "INCOMPLETE",
      newFollowUpPrompt: "Need more info about X",
    });
    expect(result.newFollowUpPrompt).toBe("Need more info about X");
  });
});

describe("ArchitectDraftPlanInputSchema", () => {
  it("includes researchFailed and failureReason (fixes Gemini-3)", () => {
    const result = ArchitectDraftPlanInputSchema.parse({
      taskId: "t1",
      issueNumber: 1,
      issueTitle: "Test",
      repoOwner: "o",
      repoName: "r",
      initialContext: "context",
      deepResearchDocId: null,
      researchFailed: true,
      failureReason: "scraper timed out after 15 minutes",
    });
    expect(result.researchFailed).toBe(true);
    expect(result.failureReason).toContain("timed out");
  });
});

describe("SendPushNotificationInputSchema", () => {
  it("accepts valid input with priority", () => {
    const result = SendPushNotificationInputSchema.parse({
      message: "Test notification",
      title: "Test",
      priority: "high",
    });
    expect(result.priority).toBe("high");
  });
});

describe("UpdateResearchSessionInputSchema", () => {
  it("accepts all optional fields", () => {
    const result = UpdateResearchSessionInputSchema.parse({
      sessionId: "s1",
      status: "DISPATCHED",
      rawMinioKey: "key",
      researchCycles: 2,
    });
    expect(result.researchCycles).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LLM response schemas
// ---------------------------------------------------------------------------

describe("TriageLLMResponseSchema", () => {
  it("accepts valid triage response", () => {
    const result = TriageLLMResponseSchema.parse({
      needsDeepResearch: true,
      reasoning: "Complex integration requires reading external docs",
      researchPrompt: "How does Dapr workflow replay work?",
      estimatedComplexity: "high",
    });
    expect(result.needsDeepResearch).toBe(true);
  });
});

describe("ReviewLLMResponseSchema", () => {
  it("accepts APPROVED with formatted markdown", () => {
    const result = ReviewLLMResponseSchema.parse({
      status: "APPROVED",
      formattedMarkdown: "# Research\n\nFindings...",
      confidence: 0.95,
    });
    expect(result.confidence).toBe(0.95);
  });

  it("rejects confidence > 1", () => {
    expect(() =>
      ReviewLLMResponseSchema.parse({
        status: "APPROVED",
        confidence: 1.5,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scrape event payload
// ---------------------------------------------------------------------------

describe("ScrapeCompletedPayloadSchema", () => {
  it("accepts structured payload (fixes Gemini-2 — standardized payload)", () => {
    const result = ScrapeCompletedPayloadSchema.parse({
      minioKey: "research/raw/t1/raw-scraper-result.md",
      taskId: "t1",
    });
    expect(result.minioKey).toContain("raw-scraper-result");
  });

  it("rejects empty minioKey", () => {
    expect(() =>
      ScrapeCompletedPayloadSchema.parse({ minioKey: "" }),
    ).toThrow();
  });
});
