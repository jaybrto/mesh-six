import { describe, it, expect } from "bun:test";
import {
  ResearchStatusSchema,
  ResearchStatusDocSchema,
  TriageOutputSchema,
  ResearchAndPlanInputSchema,
  ResearchAndPlanOutputSchema,
  ReviewResearchOutputSchema,
  StartDeepResearchInputSchema,
  StartDeepResearchOutputSchema,
  ReviewResearchInputSchema,
  DraftPlanInputSchema,
  ArchitectTriageInputSchema,
  SendPushNotificationInputSchema,
  ResearchSessionSchema,
  RESEARCH_BUCKET,
  RESEARCH_TIMEOUT_MS,
  MAX_RESEARCH_CYCLES,
} from "./research-types.js";

describe("Research Types", () => {
  describe("ResearchStatusSchema", () => {
    it("accepts valid statuses", () => {
      expect(ResearchStatusSchema.parse("PENDING")).toBe("PENDING");
      expect(ResearchStatusSchema.parse("IN_PROGRESS")).toBe("IN_PROGRESS");
      expect(ResearchStatusSchema.parse("COMPLETED")).toBe("COMPLETED");
      expect(ResearchStatusSchema.parse("FAILED")).toBe("FAILED");
      expect(ResearchStatusSchema.parse("TIMEOUT")).toBe("TIMEOUT");
    });

    it("rejects invalid status", () => {
      expect(() => ResearchStatusSchema.parse("INVALID")).toThrow();
    });
  });

  describe("ResearchStatusDocSchema", () => {
    it("parses a valid status document", () => {
      const doc = ResearchStatusDocSchema.parse({
        taskId: "task-123",
        status: "PENDING",
        updatedAt: new Date().toISOString(),
      });
      expect(doc.taskId).toBe("task-123");
      expect(doc.status).toBe("PENDING");
    });

    it("parses a full status document", () => {
      const now = new Date().toISOString();
      const doc = ResearchStatusDocSchema.parse({
        taskId: "task-456",
        status: "COMPLETED",
        prompt: "Research Dapr workflows",
        minioKey: "research/clean/task-456/clean-research.md",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      expect(doc.status).toBe("COMPLETED");
      expect(doc.minioKey).toBe("research/clean/task-456/clean-research.md");
    });

    it("rejects missing required fields", () => {
      expect(() =>
        ResearchStatusDocSchema.parse({ status: "PENDING" }),
      ).toThrow();
    });
  });

  describe("TriageOutputSchema", () => {
    it("parses minimal triage output", () => {
      const result = TriageOutputSchema.parse({
        needsDeepResearch: false,
        context: "Simple task, no research needed",
      });
      expect(result.needsDeepResearch).toBe(false);
      expect(result.researchQuestions).toEqual([]);
      expect(result.suggestedSources).toEqual([]);
      expect(result.complexity).toBe("medium");
    });

    it("parses full triage output", () => {
      const result = TriageOutputSchema.parse({
        needsDeepResearch: true,
        researchQuestions: ["How does X work?", "What API does Y use?"],
        context: "Needs external API research",
        suggestedSources: ["https://docs.example.com"],
        complexity: "high",
      });
      expect(result.needsDeepResearch).toBe(true);
      expect(result.researchQuestions).toHaveLength(2);
      expect(result.complexity).toBe("high");
    });
  });

  describe("ResearchAndPlanInputSchema", () => {
    it("parses valid input", () => {
      const input = ResearchAndPlanInputSchema.parse({
        taskId: "task-789",
        issueNumber: 42,
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        issueTitle: "Add web scraping",
        workflowId: "wf-123",
        architectActorId: "jaybrto/mesh-six/42",
      });
      expect(input.taskId).toBe("task-789");
      expect(input.issueBody).toBe("");
      expect(input.architectGuidance).toBe("");
    });
  });

  describe("ResearchAndPlanOutputSchema", () => {
    it("parses minimal output", () => {
      const output = ResearchAndPlanOutputSchema.parse({
        plan: "# Implementation Plan\n\n## Overview\nDo the thing.",
      });
      expect(output.plan).toContain("Implementation Plan");
      expect(output.totalResearchCycles).toBe(0);
      expect(output.timedOut).toBe(false);
    });

    it("parses full output", () => {
      const output = ResearchAndPlanOutputSchema.parse({
        plan: "Full plan here",
        researchDocId: "research/clean/task-123/clean-research.md",
        triageResult: {
          needsDeepResearch: true,
          context: "Needed research",
          researchQuestions: ["Q1"],
          suggestedSources: [],
          complexity: "high",
        },
        totalResearchCycles: 2,
        timedOut: false,
      });
      expect(output.totalResearchCycles).toBe(2);
      expect(output.triageResult?.needsDeepResearch).toBe(true);
    });
  });

  describe("ReviewResearchOutputSchema", () => {
    it("parses approved output", () => {
      const result = ReviewResearchOutputSchema.parse({
        status: "APPROVED",
        formattedMarkdown: "# Clean docs\n\nContent here",
        cleanMinioId: "research/clean/task-123/clean-research.md",
      });
      expect(result.status).toBe("APPROVED");
    });

    it("parses incomplete output", () => {
      const result = ReviewResearchOutputSchema.parse({
        status: "INCOMPLETE",
        missingInformation: "Need more details on authentication flow",
      });
      expect(result.status).toBe("INCOMPLETE");
      expect(result.missingInformation).toContain("authentication");
    });
  });

  describe("StartDeepResearchInputSchema", () => {
    it("parses valid input", () => {
      const input = StartDeepResearchInputSchema.parse({
        taskId: "task-123",
        prompt: "Research Dapr workflows",
        researchQuestions: ["How do Dapr workflows handle timers?"],
      });
      expect(input.taskId).toBe("task-123");
      expect(input.suggestedSources).toEqual([]);
    });
  });

  describe("StartDeepResearchOutputSchema", () => {
    it("parses started output", () => {
      const output = StartDeepResearchOutputSchema.parse({
        status: "STARTED",
        statusDocKey: "research/status/task-123/status.json",
      });
      expect(output.status).toBe("STARTED");
    });

    it("parses failed output", () => {
      const output = StartDeepResearchOutputSchema.parse({
        status: "FAILED",
        statusDocKey: "research/status/task-123/status.json",
        error: "Scraper unreachable",
      });
      expect(output.status).toBe("FAILED");
      expect(output.error).toContain("unreachable");
    });
  });

  describe("DraftPlanInputSchema", () => {
    it("parses valid input", () => {
      const input = DraftPlanInputSchema.parse({
        taskId: "task-123",
        issueNumber: 42,
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        issueTitle: "Implement feature",
        initialContext: "Architect analysis here",
      });
      expect(input.issueBody).toBe("");
      expect(input.architectGuidance).toBe("");
    });

    it("parses input with research doc", () => {
      const input = DraftPlanInputSchema.parse({
        taskId: "task-123",
        issueNumber: 42,
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        issueTitle: "Implement feature",
        initialContext: "Context",
        deepResearchDocId: "research/clean/task-123/clean-research.md",
        architectGuidance: "Use Dapr workflows",
      });
      expect(input.deepResearchDocId).toBe("research/clean/task-123/clean-research.md");
    });
  });

  describe("ArchitectTriageInputSchema", () => {
    it("parses valid input", () => {
      const input = ArchitectTriageInputSchema.parse({
        taskId: "task-123",
        issueNumber: 42,
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        issueTitle: "Add dark mode",
      });
      expect(input.issueBody).toBe("");
    });
  });

  describe("SendPushNotificationInputSchema", () => {
    it("parses minimal notification", () => {
      const input = SendPushNotificationInputSchema.parse({
        message: "Research timed out",
      });
      expect(input.priority).toBe("default");
      expect(input.tags).toEqual([]);
    });

    it("parses full notification", () => {
      const input = SendPushNotificationInputSchema.parse({
        message: "Scraper timed out on task-123",
        title: "Research Timeout",
        priority: "high",
        tags: ["warning", "research"],
      });
      expect(input.title).toBe("Research Timeout");
      expect(input.priority).toBe("high");
    });
  });

  describe("ResearchSessionSchema", () => {
    it("parses a research session record", () => {
      const session = ResearchSessionSchema.parse({
        id: "sess-123",
        taskId: "task-456",
        workflowId: "wf-789",
        issueNumber: 42,
        repoOwner: "jaybrto",
        repoName: "mesh-six",
        status: "COMPLETED",
        researchCycles: 2,
        cleanMinioKey: "research/clean/task-456/clean-research.md",
        finalPlan: "# Plan\n\nDo the thing",
        createdAt: new Date().toISOString(),
      });
      expect(session.researchCycles).toBe(2);
      expect(session.status).toBe("COMPLETED");
    });
  });

  describe("Constants", () => {
    it("has correct bucket name", () => {
      expect(RESEARCH_BUCKET).toBe("mesh-six-research");
    });

    it("has 15 minute timeout", () => {
      expect(RESEARCH_TIMEOUT_MS).toBe(15 * 60 * 1000);
    });

    it("has max 3 research cycles", () => {
      expect(MAX_RESEARCH_CYCLES).toBe(3);
    });
  });
});
