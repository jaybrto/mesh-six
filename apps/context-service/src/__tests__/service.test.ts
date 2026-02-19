import { describe, it, expect } from "bun:test";
import { createApp } from "../app.js";
import type { CompressionRequest } from "@mesh-six/core";

function makeRequest(overrides: Partial<CompressionRequest> = {}): CompressionRequest {
  return {
    sender: "project-manager",
    receiver: "architect-agent",
    projectId: "test/repo",
    taskSummary: "Small task for testing",
    priority: 5,
    workflowState: { phase: "INTAKE", issueNumber: 1 },
    senderMemories: [],
    senderQuestions: [],
    conversationSnippet: [],
    constraints: [],
    knownFailures: [],
    ...overrides,
  };
}

async function postCompress(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/compress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Context Service HTTP routes", () => {
  const app = createApp("test-context-service");

  it("GET /healthz returns 200 with status ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.agent).toBe("test-context-service");
  });

  it("GET /readyz returns 200 with status ready", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ready");
  });

  it("POST /compress with valid deterministic-sufficient request returns 200 with method deterministic", async () => {
    const res = await postCompress(app, makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.method).toBe("deterministic");
    expect(body.compressedContext).toContain("METADATA:");
    expect(body.compressedContext).toContain("project-manager");
  });

  it("POST /compress with invalid request returns 400", async () => {
    const res = await postCompress(app, { projectId: "only-one-field" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  it("POST /compress with empty body returns 400", async () => {
    const res = await postCompress(app, {});
    expect(res.status).toBe(400);
  });

  it("compression stats have positive token estimates", async () => {
    const res = await postCompress(app, makeRequest());
    const body = await res.json() as any;
    expect(body.stats.inputTokensEstimate).toBeGreaterThan(0);
    expect(body.stats.outputTokensEstimate).toBeGreaterThan(0);
    expect(body.stats.compressionRatio).toBeGreaterThan(0);
    expect(body.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("compression ratio equals outputTokens / inputTokens", async () => {
    const res = await postCompress(app, makeRequest());
    const body = await res.json() as any;
    const expected = body.stats.outputTokensEstimate / body.stats.inputTokensEstimate;
    expect(body.stats.compressionRatio).toBeCloseTo(expected, 5);
  });
});
