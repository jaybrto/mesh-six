import { describe, expect, it } from "bun:test";
import type { OnboardingRun } from "./db.js";

describe("OnboardingRun type", () => {
  it("should have required fields", () => {
    const run: OnboardingRun = {
      id: "test-id",
      repoOwner: "jaybrto",
      repoName: "test-repo",
      status: "pending",
      currentPhase: null,
      currentActivity: null,
      completedActivities: [],
      errorMessage: null,
      oauthDeviceUrl: null,
      oauthUserCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(run.status).toBe("pending");
  });

  it("should accept all valid status values", () => {
    const statuses: OnboardingRun["status"][] = [
      "pending",
      "running",
      "waiting_auth",
      "completed",
      "failed",
    ];
    for (const status of statuses) {
      const run: OnboardingRun = {
        id: "test-id",
        repoOwner: "jaybrto",
        repoName: "test-repo",
        status,
        currentPhase: null,
        currentActivity: null,
        completedActivities: [],
        errorMessage: null,
        oauthDeviceUrl: null,
        oauthUserCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(run.status).toBe(status);
    }
  });
});
