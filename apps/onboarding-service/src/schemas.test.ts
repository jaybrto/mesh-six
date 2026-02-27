import { describe, expect, it } from "bun:test";
import { OnboardProjectRequestSchema } from "./schemas";

describe("OnboardProjectRequestSchema", () => {
  it("accepts a minimal valid request with just repoOwner and repoName", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "my-repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a request missing repoOwner", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoName: "my-repo",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full request with all optional fields populated", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "my-repo",
      displayName: "My Repo",
      defaultBranch: "develop",
      skipAuth: true,
      skipLiteLLM: true,
      resourceLimits: {
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        cpuRequest: "200m",
        cpuLimit: "1000m",
        storageWorktrees: "10Gi",
        storageClaude: "2Gi",
      },
      litellm: {
        teamAlias: "acme-team",
        defaultModel: "claude-3-5-sonnet",
        maxBudget: 100,
      },
      settings: {
        cloudflareDomain: "acme.example.com",
        terminalStreamingRate: 50,
      },
    });
    expect(result.success).toBe(true);
  });

  it("applies correct defaults for defaultBranch, skipAuth, and skipLiteLLM", () => {
    const result = OnboardProjectRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "my-repo",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultBranch).toBe("main");
      expect(result.data.skipAuth).toBe(false);
      expect(result.data.skipLiteLLM).toBe(false);
    }
  });
});
