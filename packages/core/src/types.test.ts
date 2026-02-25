import { describe, it, expect } from "bun:test";
import {
  AgentCapabilitySchema,
  AgentRegistrationSchema,
  TaskRequestSchema,
  TaskResultSchema,
  AgentScoreCardSchema,
  TaskStatusSchema,
  ProjectConfigSchema,
  CredentialPushRequestSchema,
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  CredentialHealthSchema,
  ImplementationSessionSchema,
} from "./types.js";

describe("AgentCapabilitySchema", () => {
  it("parses valid input with all fields", () => {
    const input = {
      name: "code-review",
      weight: 0.8,
      preferred: true,
      requirements: ["github"],
      async: true,
      estimatedDuration: "5m",
      platforms: ["linux"],
    };
    const result = AgentCapabilitySchema.parse(input);
    expect(result.name).toBe("code-review");
    expect(result.weight).toBe(0.8);
    expect(result.preferred).toBe(true);
    expect(result.requirements).toEqual(["github"]);
    expect(result.async).toBe(true);
    expect(result.estimatedDuration).toBe("5m");
    expect(result.platforms).toEqual(["linux"]);
  });

  it("applies defaults for preferred and requirements", () => {
    const result = AgentCapabilitySchema.parse({
      name: "test",
      weight: 0.5,
    });
    expect(result.preferred).toBe(false);
    expect(result.requirements).toEqual([]);
  });

  it("rejects missing name", () => {
    expect(() =>
      AgentCapabilitySchema.parse({ weight: 0.5 })
    ).toThrow();
  });

  it("rejects weight below 0", () => {
    expect(() =>
      AgentCapabilitySchema.parse({ name: "test", weight: -0.1 })
    ).toThrow();
  });

  it("rejects weight above 1", () => {
    expect(() =>
      AgentCapabilitySchema.parse({ name: "test", weight: 1.1 })
    ).toThrow();
  });
});

describe("AgentRegistrationSchema", () => {
  const validRegistration = {
    name: "Test Agent",
    appId: "test-agent-1",
    capabilities: [{ name: "code-review", weight: 0.9 }],
    status: "online" as const,
    lastHeartbeat: new Date().toISOString(),
  };

  it("parses valid full input", () => {
    const result = AgentRegistrationSchema.parse(validRegistration);
    expect(result.name).toBe("Test Agent");
    expect(result.appId).toBe("test-agent-1");
    expect(result.capabilities).toHaveLength(1);
    expect(result.status).toBe("online");
    expect(result.healthChecks).toEqual({});
  });

  it("applies default for healthChecks", () => {
    const result = AgentRegistrationSchema.parse(validRegistration);
    expect(result.healthChecks).toEqual({});
  });

  it("validates status enum", () => {
    expect(() =>
      AgentRegistrationSchema.parse({
        ...validRegistration,
        status: "unknown",
      })
    ).toThrow();
  });

  it("accepts all valid status values", () => {
    for (const status of ["online", "degraded", "offline"] as const) {
      const result = AgentRegistrationSchema.parse({
        ...validRegistration,
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it("accepts optional metadata", () => {
    const result = AgentRegistrationSchema.parse({
      ...validRegistration,
      metadata: { version: "1.0", tags: ["fast"] },
    });
    expect(result.metadata).toEqual({ version: "1.0", tags: ["fast"] });
  });
});

describe("TaskRequestSchema", () => {
  const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const validTask = {
    id: validUuid,
    capability: "code-review",
    payload: { file: "main.ts" },
    requestedBy: "orchestrator",
    createdAt: new Date().toISOString(),
  };

  it("parses valid input with defaults", () => {
    const result = TaskRequestSchema.parse(validTask);
    expect(result.id).toBe(validUuid);
    expect(result.priority).toBe(5);
    expect(result.timeout).toBe(120);
  });

  it("rejects invalid UUID for id", () => {
    expect(() =>
      TaskRequestSchema.parse({ ...validTask, id: "not-a-uuid" })
    ).toThrow();
  });

  it("rejects priority out of range", () => {
    expect(() =>
      TaskRequestSchema.parse({ ...validTask, priority: 11 })
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({ ...validTask, priority: -1 })
    ).toThrow();
  });

  it("rejects non-positive timeout", () => {
    expect(() =>
      TaskRequestSchema.parse({ ...validTask, timeout: 0 })
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({ ...validTask, timeout: -5 })
    ).toThrow();
  });

  it("accepts custom priority and timeout", () => {
    const result = TaskRequestSchema.parse({
      ...validTask,
      priority: 9,
      timeout: 300,
    });
    expect(result.priority).toBe(9);
    expect(result.timeout).toBe(300);
  });
});

describe("TaskResultSchema", () => {
  const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("parses success variant", () => {
    const result = TaskResultSchema.parse({
      taskId: validUuid,
      agentId: "agent-1",
      success: true,
      result: { output: "done" },
      durationMs: 1500,
      completedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ output: "done" });
    expect(result.error).toBeUndefined();
  });

  it("parses error variant", () => {
    const result = TaskResultSchema.parse({
      taskId: validUuid,
      agentId: "agent-1",
      success: false,
      error: { type: "TIMEOUT", message: "Timed out" },
      durationMs: 120000,
      completedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("TIMEOUT");
  });

  it("rejects invalid taskId", () => {
    expect(() =>
      TaskResultSchema.parse({
        taskId: "bad",
        agentId: "agent-1",
        success: true,
        durationMs: 100,
        completedAt: new Date().toISOString(),
      })
    ).toThrow();
  });
});

describe("AgentScoreCardSchema", () => {
  it("validates all fields", () => {
    const result = AgentScoreCardSchema.parse({
      agentId: "agent-1",
      capability: "code-review",
      baseWeight: 0.9,
      dependencyHealth: 1,
      rollingSuccessRate: 0.85,
      recencyBoost: 1.1,
      finalScore: 0.84,
    });
    expect(result.agentId).toBe("agent-1");
    expect(result.finalScore).toBe(0.84);
  });

  it("rejects dependencyHealth out of range", () => {
    expect(() =>
      AgentScoreCardSchema.parse({
        agentId: "a",
        capability: "c",
        baseWeight: 0.5,
        dependencyHealth: 1.5,
        rollingSuccessRate: 0.5,
        recencyBoost: 1,
        finalScore: 0.5,
      })
    ).toThrow();
  });

  it("rejects rollingSuccessRate out of range", () => {
    expect(() =>
      AgentScoreCardSchema.parse({
        agentId: "a",
        capability: "c",
        baseWeight: 0.5,
        dependencyHealth: 1,
        rollingSuccessRate: -0.1,
        recencyBoost: 1,
        finalScore: 0.5,
      })
    ).toThrow();
  });
});

describe("TaskStatusSchema", () => {
  const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("parses valid status with defaults", () => {
    const result = TaskStatusSchema.parse({
      taskId: validUuid,
      capability: "code-review",
      dispatchedTo: null,
      dispatchedAt: null,
      status: "pending",
    });
    expect(result.status).toBe("pending");
    expect(result.attempts).toBe(0);
  });

  it("validates status enum values", () => {
    for (const status of ["pending", "dispatched", "completed", "failed", "timeout"] as const) {
      const result = TaskStatusSchema.parse({
        taskId: validUuid,
        capability: "test",
        dispatchedTo: null,
        dispatchedAt: null,
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it("rejects invalid status value", () => {
    expect(() =>
      TaskStatusSchema.parse({
        taskId: validUuid,
        capability: "test",
        dispatchedTo: null,
        dispatchedAt: null,
        status: "running",
      })
    ).toThrow();
  });

  it("accepts optional result", () => {
    const result = TaskStatusSchema.parse({
      taskId: validUuid,
      capability: "test",
      dispatchedTo: "agent-1",
      dispatchedAt: new Date().toISOString(),
      status: "completed",
      attempts: 1,
      result: {
        taskId: validUuid,
        agentId: "agent-1",
        success: true,
        durationMs: 500,
        completedAt: new Date().toISOString(),
      },
    });
    expect(result.result?.success).toBe(true);
  });
});

describe("Auth types", () => {
  it("parses valid ProjectConfig", () => {
    const result = ProjectConfigSchema.parse({
      id: "mesh-six",
      displayName: "Mesh Six",
      createdAt: "2026-02-25T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    });
    expect(result.id).toBe("mesh-six");
  });

  it("rejects ProjectConfig missing required fields", () => {
    expect(() => ProjectConfigSchema.parse({ id: "x" })).toThrow();
  });

  it("parses valid CredentialPushRequest", () => {
    const result = CredentialPushRequestSchema.parse({
      accessToken: "sk-ant-test",
      expiresAt: "2026-03-01T00:00:00Z",
    });
    expect(result.accessToken).toBe("sk-ant-test");
  });

  it("rejects CredentialPushRequest without accessToken", () => {
    expect(() =>
      CredentialPushRequestSchema.parse({ expiresAt: "2026-03-01T00:00:00Z" })
    ).toThrow();
  });

  it("parses ProvisionResponse with all statuses", () => {
    for (const status of ["current", "provisioned", "no_credentials"] as const) {
      const result = ProvisionResponseSchema.parse({ status });
      expect(result.status).toBe(status);
    }
  });

  it("rejects ProvisionResponse with invalid status", () => {
    expect(() =>
      ProvisionResponseSchema.parse({ status: "invalid" })
    ).toThrow();
  });

  it("parses CredentialHealth", () => {
    const result = CredentialHealthSchema.parse({
      projectId: "mesh-six",
      hasValidCredential: true,
      hasRefreshToken: true,
    });
    expect(result.hasValidCredential).toBe(true);
  });

  it("parses ImplementationSession", () => {
    const result = ImplementationSessionSchema.parse({
      id: "sess-1",
      issueNumber: 42,
      repoOwner: "jaybrto",
      repoName: "mesh-six",
      status: "running",
      createdAt: "2026-02-25T00:00:00Z",
    });
    expect(result.status).toBe("running");
  });

  it("rejects ImplementationSession with invalid status", () => {
    expect(() =>
      ImplementationSessionSchema.parse({
        id: "x",
        issueNumber: 1,
        repoOwner: "a",
        repoName: "b",
        status: "invalid",
        createdAt: "2026-02-25T00:00:00Z",
      })
    ).toThrow();
  });
});
