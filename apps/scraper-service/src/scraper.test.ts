/**
 * Unit tests for scraper-service types, MinIO lifecycle, and Dapr events.
 *
 * These tests validate the Zod schemas and mock the external dependencies
 * (MinIO, Dapr, Playwright) so they can run anywhere — no Mac mini required.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  ScrapeDispatchPayloadSchema,
  ScrapeStatusFileSchema,
  ScrapeAckResponseSchema,
  ScrapeValidationErrorSchema,
  type ScrapeStatusFile,
} from "@mesh-six/core";
import {
  SCRAPE_COMPLETED_CONTRACT_VERSION,
  type ScrapeCompletedEvent,
} from "./dapr-events.js";

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("ScrapeDispatchPayloadSchema", () => {
  it("parses a valid windsurf payload", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      actorId: "researcher-1",
      targetProvider: "windsurf",
      prompt: "Research the latest Bun runtime features",
      minioFolderPath: "research/550e8400-e29b-41d4-a716-446655440000",
    };
    const result = ScrapeDispatchPayloadSchema.parse(input);
    expect(result.targetProvider).toBe("windsurf");
    expect(result.taskId).toBe(input.taskId);
  });

  it("parses a valid gemini payload", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      actorId: "researcher-2",
      targetProvider: "gemini",
      prompt: "Analyze the Kubernetes operator pattern",
      minioFolderPath: "research/550e8400-e29b-41d4-a716-446655440001",
    };
    const result = ScrapeDispatchPayloadSchema.parse(input);
    expect(result.targetProvider).toBe("gemini");
  });

  it("rejects legacy claude provider name", () => {
    expect(() =>
      ScrapeDispatchPayloadSchema.parse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        actorId: "researcher-1",
        targetProvider: "claude",
        prompt: "test",
        minioFolderPath: "research/test",
      }),
    ).toThrow();
  });

  it("rejects invalid provider", () => {
    expect(() =>
      ScrapeDispatchPayloadSchema.parse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        actorId: "researcher-1",
        targetProvider: "invalid-provider",
        prompt: "test",
        minioFolderPath: "research/test",
      }),
    ).toThrow();
  });

  it("rejects non-UUID taskId", () => {
    expect(() =>
      ScrapeDispatchPayloadSchema.parse({
        taskId: "not-a-uuid",
        actorId: "researcher-1",
        targetProvider: "windsurf",
        prompt: "test",
        minioFolderPath: "research/test",
      }),
    ).toThrow();
  });

  it("rejects empty prompt", () => {
    expect(() =>
      ScrapeDispatchPayloadSchema.parse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        actorId: "researcher-1",
        targetProvider: "windsurf",
        prompt: "",
        minioFolderPath: "research/test",
      }),
    ).toThrow();
  });

  it("rejects empty minioFolderPath", () => {
    expect(() =>
      ScrapeDispatchPayloadSchema.parse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        actorId: "researcher-1",
        targetProvider: "windsurf",
        prompt: "test",
        minioFolderPath: "",
      }),
    ).toThrow();
  });
});

describe("ScrapeStatusFileSchema", () => {
  it("parses a PENDING status", () => {
    const result = ScrapeStatusFileSchema.parse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "PENDING",
    });
    expect(result.status).toBe("PENDING");
  });

  it("parses a COMPLETED status with all fields", () => {
    const result = ScrapeStatusFileSchema.parse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "COMPLETED",
      provider: "gemini",
      startedAt: "2026-02-27T10:00:00.000Z",
      completedAt: "2026-02-27T10:05:00.000Z",
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.provider).toBe("gemini");
  });

  it("parses a FAILED status with error", () => {
    const result = ScrapeStatusFileSchema.parse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "FAILED",
      provider: "windsurf",
      error: "Playwright timeout exceeded",
    });
    expect(result.error).toBe("Playwright timeout exceeded");
  });

  it("rejects invalid status values", () => {
    expect(() =>
      ScrapeStatusFileSchema.parse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        status: "UNKNOWN",
      }),
    ).toThrow();
  });
});

describe("ScrapeAckResponseSchema", () => {
  it("parses STARTED response", () => {
    const result = ScrapeAckResponseSchema.parse({
      status: "STARTED",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.status).toBe("STARTED");
  });

  it("parses REJECTED response with message", () => {
    const result = ScrapeAckResponseSchema.parse({
      status: "REJECTED",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Task already in progress",
    });
    expect(result.status).toBe("REJECTED");
    expect(result.message).toBe("Task already in progress");
  });
});

describe("ScrapeValidationErrorSchema", () => {
  it("parses error with non-UUID taskId", () => {
    const result = ScrapeValidationErrorSchema.parse({
      status: "REJECTED",
      taskId: "unknown",
      message: "Validation failed: invalid provider",
    });
    expect(result.status).toBe("REJECTED");
    expect(result.taskId).toBe("unknown");
  });

  it("parses error with valid UUID taskId", () => {
    const result = ScrapeValidationErrorSchema.parse({
      status: "REJECTED",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "At capacity",
    });
    expect(result.message).toBe("At capacity");
  });
});

describe("ScrapeStatusFileSchema — callbackError field", () => {
  it("parses COMPLETED status with callbackError", () => {
    const result = ScrapeStatusFileSchema.parse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "COMPLETED",
      provider: "gemini",
      startedAt: "2026-02-27T10:00:00.000Z",
      completedAt: "2026-02-27T10:05:00.000Z",
      callbackError: "Dapr raiseEvent failed: 503 Service Unavailable",
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.callbackError).toBe(
      "Dapr raiseEvent failed: 503 Service Unavailable",
    );
  });

  it("allows callbackError to be omitted", () => {
    const result = ScrapeStatusFileSchema.parse({
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "COMPLETED",
    });
    expect(result.callbackError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ScrapeCompleted contract envelope tests
// ---------------------------------------------------------------------------

describe("ScrapeCompletedEvent contract", () => {
  it("has a stable contract version", () => {
    expect(SCRAPE_COMPLETED_CONTRACT_VERSION).toBe(1);
  });

  it("envelope contains all required fields", () => {
    const event: ScrapeCompletedEvent = {
      contractVersion: SCRAPE_COMPLETED_CONTRACT_VERSION,
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      minioResultPath: "research/550e8400/result.md",
      success: true,
      completedAt: new Date().toISOString(),
    };
    expect(event.contractVersion).toBe(1);
    expect(event.taskId).toBeTruthy();
    expect(event.minioResultPath).toContain("result.md");
    expect(event.success).toBe(true);
    expect(event.completedAt).toBeTruthy();
    expect(event.error).toBeUndefined();
  });

  it("envelope includes error on failure", () => {
    const event: ScrapeCompletedEvent = {
      contractVersion: SCRAPE_COMPLETED_CONTRACT_VERSION,
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      minioResultPath: "research/550e8400/result.md",
      success: false,
      error: "Playwright timeout",
      completedAt: new Date().toISOString(),
    };
    expect(event.success).toBe(false);
    expect(event.error).toBe("Playwright timeout");
  });
});

// ---------------------------------------------------------------------------
// MinIO lifecycle mock tests
// ---------------------------------------------------------------------------

describe("minio-lifecycle (mocked S3)", () => {
  // Simulates an in-memory MinIO bucket for lifecycle transitions
  let store: Map<string, string>;
  let mockClient: any;

  beforeEach(() => {
    store = new Map();

    // Minimal mock of S3Client.send() for PutObjectCommand / GetObjectCommand
    mockClient = {
      send: mock((cmd: any) => {
        const cmdName = cmd.constructor?.name || cmd.input?.__type || "";

        if (cmdName === "PutObjectCommand" || cmd.input?.Body !== undefined) {
          const key = cmd.input.Key as string;
          const body =
            typeof cmd.input.Body === "string"
              ? cmd.input.Body
              : new TextDecoder().decode(cmd.input.Body);
          store.set(key, body);
          return Promise.resolve({});
        }

        if (cmdName === "GetObjectCommand" || cmd.input?.Key !== undefined) {
          const key = cmd.input.Key as string;
          const data = store.get(key);
          if (!data) return Promise.reject(new Error("NoSuchKey"));
          return Promise.resolve({
            Body: {
              transformToByteArray: () =>
                Promise.resolve(new TextEncoder().encode(data)),
            },
          });
        }

        return Promise.reject(new Error("Unknown command"));
      }),
    };
  });

  it("markInProgress writes IN_PROGRESS with startedAt", async () => {
    const { markInProgress } = await import("./minio-lifecycle.js");
    await markInProgress(mockClient, "bucket", "research/t1", "t1", "gemini");

    const raw = store.get("research/t1/status.json");
    expect(raw).toBeDefined();
    const status: ScrapeStatusFile = JSON.parse(raw!);
    expect(status.status).toBe("IN_PROGRESS");
    expect(status.taskId).toBe("t1");
    expect(status.provider).toBe("gemini");
    expect(status.startedAt).toBeTruthy();
  });

  it("markCompleted preserves startedAt from IN_PROGRESS", async () => {
    const { markInProgress, markCompleted } = await import(
      "./minio-lifecycle.js"
    );
    await markInProgress(mockClient, "bucket", "research/t2", "t2", "windsurf");
    const inProgressRaw = store.get("research/t2/status.json");
    const inProgress: ScrapeStatusFile = JSON.parse(inProgressRaw!);
    const originalStartedAt = inProgress.startedAt;

    await markCompleted(mockClient, "bucket", "research/t2", "t2", "windsurf");
    const completedRaw = store.get("research/t2/status.json");
    const completed: ScrapeStatusFile = JSON.parse(completedRaw!);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.startedAt).toBe(originalStartedAt);
    expect(completed.completedAt).toBeTruthy();
  });

  it("markFailed preserves startedAt from IN_PROGRESS", async () => {
    const { markInProgress, markFailed } = await import(
      "./minio-lifecycle.js"
    );
    await markInProgress(mockClient, "bucket", "research/t3", "t3", "gemini");
    const inProgressRaw = store.get("research/t3/status.json");
    const inProgress: ScrapeStatusFile = JSON.parse(inProgressRaw!);

    await markFailed(
      mockClient,
      "bucket",
      "research/t3",
      "t3",
      "gemini",
      "timeout",
    );
    const failedRaw = store.get("research/t3/status.json");
    const failed: ScrapeStatusFile = JSON.parse(failedRaw!);
    expect(failed.status).toBe("FAILED");
    expect(failed.startedAt).toBe(inProgress.startedAt);
    expect(failed.error).toBe("timeout");
  });

  it("markCallbackError preserves COMPLETED status", async () => {
    const { markInProgress, markCompleted, markCallbackError } = await import(
      "./minio-lifecycle.js"
    );
    await markInProgress(mockClient, "bucket", "research/t4", "t4", "gemini");
    await markCompleted(mockClient, "bucket", "research/t4", "t4", "gemini");

    await markCallbackError(
      mockClient,
      "bucket",
      "research/t4",
      "Dapr 503",
    );
    const raw = store.get("research/t4/status.json");
    const status: ScrapeStatusFile = JSON.parse(raw!);
    expect(status.status).toBe("COMPLETED");
    expect(status.callbackError).toBe("Dapr 503");
  });

  it("uploadResult writes result.md and returns key", async () => {
    const { uploadResult } = await import("./minio-lifecycle.js");
    const key = await uploadResult(
      mockClient,
      "bucket",
      "research/t5",
      "# Hello World",
    );
    expect(key).toBe("research/t5/result.md");
    expect(store.get("research/t5/result.md")).toBe("# Hello World");
  });
});

// ---------------------------------------------------------------------------
// Dapr events — raiseScrapeCompleted mock tests
// ---------------------------------------------------------------------------

describe("raiseScrapeCompleted (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a versioned envelope with POST", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedMethod = "";

    globalThis.fetch = mock(async (input: any, init: any) => {
      capturedUrl = typeof input === "string" ? input : input.url;
      capturedMethod = init?.method || "GET";
      capturedBody = init?.body || "";
      return new Response("", { status: 200 });
    }) as any;

    const { raiseScrapeCompleted } = await import("./dapr-events.js");
    await raiseScrapeCompleted("task-uuid-123", {
      minioResultPath: "research/task-uuid-123/result.md",
      success: true,
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("raiseEvent");
    expect(capturedUrl).toContain("task-uuid-123");

    const body = JSON.parse(capturedBody) as ScrapeCompletedEvent;
    expect(body.contractVersion).toBe(SCRAPE_COMPLETED_CONTRACT_VERSION);
    expect(body.taskId).toBe("task-uuid-123");
    expect(body.success).toBe(true);
    expect(body.completedAt).toBeTruthy();
  });

  it("throws on non-200 response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("workflow not found", { status: 404 });
    }) as any;

    const { raiseScrapeCompleted } = await import("./dapr-events.js");
    await expect(
      raiseScrapeCompleted("bad-id", {
        minioResultPath: "research/bad-id/result.md",
        success: false,
        error: "test",
      }),
    ).rejects.toThrow("Dapr raiseEvent failed");
  });
});
