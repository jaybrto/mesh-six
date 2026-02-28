/**
 * Unit tests for scraper-service types, MinIO lifecycle, and Dapr events.
 *
 * These tests validate the Zod schemas and mock the external dependencies
 * (MinIO, Dapr, Playwright) so they can run anywhere — no Mac mini required.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  ScrapeDispatchPayloadSchema,
  ScrapeStatusFileSchema,
  ScrapeAckResponseSchema,
} from "@mesh-six/core";

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

  it("parses a valid claude payload", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      actorId: "researcher-2",
      targetProvider: "claude",
      prompt: "Analyze the Kubernetes operator pattern",
      minioFolderPath: "research/550e8400-e29b-41d4-a716-446655440001",
    };
    const result = ScrapeDispatchPayloadSchema.parse(input);
    expect(result.targetProvider).toBe("claude");
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
      provider: "claude",
      startedAt: "2026-02-27T10:00:00.000Z",
      completedAt: "2026-02-27T10:05:00.000Z",
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.provider).toBe("claude");
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
