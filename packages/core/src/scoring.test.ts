import { describe, it, expect, mock, beforeEach } from "bun:test";
import { AgentScorer } from "./scoring.js";
import type { AgentRegistration, TaskResult } from "./types.js";

// --- Mock Pool ---
function createMockPool(queryFn?: (...args: any[]) => any) {
  return {
    query: queryFn ?? mock(() => Promise.resolve({ rows: [] })),
  } as any;
}

function makeAgent(
  appId: string,
  capabilities: AgentRegistration["capabilities"],
  healthChecks: Record<string, string> = {}
): AgentRegistration {
  return {
    name: appId,
    appId,
    capabilities,
    status: "online",
    healthChecks,
    lastHeartbeat: new Date().toISOString(),
  };
}

describe("AgentScorer", () => {
  // Stub global fetch for health check tests
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("scoreAgents", () => {
    it("returns empty array when no agents match the capability", async () => {
      const pool = createMockPool();
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "other", weight: 0.5, preferred: false, requirements: [] }]),
      ];
      const result = await scorer.scoreAgents(agents, "code-review");
      expect(result).toEqual([]);
    });

    it("defaults rollingSuccessRate to 1.0 when no history", async () => {
      const pool = createMockPool(mock(() => Promise.resolve({ rows: [] })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "code-review", weight: 0.8, preferred: false, requirements: [] }]),
      ];
      const scores = await scorer.scoreAgents(agents, "code-review");
      expect(scores).toHaveLength(1);
      expect(scores[0].rollingSuccessRate).toBe(1.0);
      expect(scores[0].recencyBoost).toBe(1.0);
      expect(scores[0].dependencyHealth).toBe(1);
      // finalScore = 0.8 * 1 * 1.0 * 1.0 * 1.0 = 0.8
      expect(scores[0].finalScore).toBe(0.8);
    });

    it("calculates recency-weighted success rate", async () => {
      const decay = 0.95;
      // 5 tasks: success, success, fail, success, fail (newest first)
      const history = [
        { success: true, created_at: new Date() },
        { success: true, created_at: new Date() },
        { success: false, created_at: new Date() },
        { success: true, created_at: new Date() },
        { success: false, created_at: new Date() },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows: history })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 1.0, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");

      // Manually compute expected weighted success rate
      let weightedSuccess = 0;
      let totalWeight = 0;
      history.forEach((row, i) => {
        const weight = Math.pow(decay, i);
        weightedSuccess += row.success ? weight : 0;
        totalWeight += weight;
      });
      const expectedRate = weightedSuccess / totalWeight;

      expect(scores[0].rollingSuccessRate).toBeCloseTo(expectedRate, 10);
    });

    it("applies recency boost when last 3 tasks all successful", async () => {
      const history = [
        { success: true, created_at: new Date() },
        { success: true, created_at: new Date() },
        { success: true, created_at: new Date() },
        { success: false, created_at: new Date() },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows: history })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 1.0, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].recencyBoost).toBe(1.1);
    });

    it("no recency boost when fewer than 3 tasks in history", async () => {
      const history = [
        { success: true, created_at: new Date() },
        { success: true, created_at: new Date() },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows: history })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 1.0, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].recencyBoost).toBe(1.0);
    });

    it("no recency boost when one of last 3 failed", async () => {
      const history = [
        { success: true, created_at: new Date() },
        { success: false, created_at: new Date() },
        { success: true, created_at: new Date() },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows: history })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 1.0, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].recencyBoost).toBe(1.0);
    });

    it("applies preferred capability bonus of 1.05x", async () => {
      const pool = createMockPool(mock(() => Promise.resolve({ rows: [] })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 0.8, preferred: true, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      // finalScore = 0.8 * 1 * 1.0 * 1.0 * 1.05 = 0.84
      expect(scores[0].finalScore).toBeCloseTo(0.84, 10);
    });

    it("sets dependencyHealth to 0 when health check fails", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({ ok: false } as Response)
      ) as any;

      const pool = createMockPool(mock(() => Promise.resolve({ rows: [] })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent(
          "a1",
          [{ name: "test", weight: 1.0, preferred: false, requirements: ["db"] }],
          { db: "http://localhost:5432/health" }
        ),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].dependencyHealth).toBe(0);
      expect(scores[0].finalScore).toBe(0);
    });

    it("sets dependencyHealth to 0 when fetch throws", async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("connection refused"))
      ) as any;

      const pool = createMockPool(mock(() => Promise.resolve({ rows: [] })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent(
          "a1",
          [{ name: "test", weight: 1.0, preferred: false, requirements: ["redis"] }],
          { redis: "http://localhost:6379/health" }
        ),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].dependencyHealth).toBe(0);
    });

    it("all failures yields rollingSuccessRate of 0", async () => {
      const history = [
        { success: false, created_at: new Date() },
        { success: false, created_at: new Date() },
        { success: false, created_at: new Date() },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows: history })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 1.0, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].rollingSuccessRate).toBe(0);
      expect(scores[0].finalScore).toBe(0);
    });

    it("sorts agents by finalScore descending", async () => {
      // Agent a1: weight 0.5, agent a2: weight 0.9
      const pool = createMockPool(mock(() => Promise.resolve({ rows: [] })));
      const scorer = new AgentScorer(pool);
      const agents = [
        makeAgent("a1", [{ name: "test", weight: 0.5, preferred: false, requirements: [] }]),
        makeAgent("a2", [{ name: "test", weight: 0.9, preferred: false, requirements: [] }]),
      ];

      const scores = await scorer.scoreAgents(agents, "test");
      expect(scores[0].agentId).toBe("a2");
      expect(scores[1].agentId).toBe("a1");
      expect(scores[0].finalScore).toBeGreaterThan(scores[1].finalScore);
    });
  });

  describe("recordTaskResult", () => {
    it("inserts task result with correct parameters", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const scorer = new AgentScorer(pool);

      const result: TaskResult = {
        taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        agentId: "agent-1",
        success: true,
        durationMs: 1500,
        completedAt: "2025-01-01T00:00:00Z",
      };

      await scorer.recordTaskResult(result, "code-review");

      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("INSERT INTO agent_task_history");
      expect(params).toEqual([
        result.taskId,
        result.agentId,
        "code-review",
        true,
        1500,
        null,
        "2025-01-01T00:00:00Z",
      ]);
    });

    it("passes error type when present", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const scorer = new AgentScorer(pool);

      const result: TaskResult = {
        taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        agentId: "agent-1",
        success: false,
        error: { type: "TIMEOUT", message: "Timed out" },
        durationMs: 120000,
        completedAt: "2025-01-01T00:00:00Z",
      };

      await scorer.recordTaskResult(result, "code-review");

      const [, params] = queryMock.mock.calls[0];
      expect(params[5]).toBe("TIMEOUT");
    });
  });

  describe("getAgentHistory", () => {
    it("returns formatted results", async () => {
      const rows = [
        {
          id: "task-1",
          capability: "code-review",
          success: true,
          duration_ms: 500,
          error_type: null,
          created_at: new Date("2025-01-01"),
        },
        {
          id: "task-2",
          capability: "code-review",
          success: false,
          duration_ms: 120000,
          error_type: "TIMEOUT",
          created_at: new Date("2025-01-02"),
        },
      ];
      const pool = createMockPool(mock(() => Promise.resolve({ rows })));
      const scorer = new AgentScorer(pool);

      const history = await scorer.getAgentHistory("agent-1");

      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        id: "task-1",
        capability: "code-review",
        success: true,
        durationMs: 500,
        errorType: null,
        createdAt: new Date("2025-01-01"),
      });
      expect(history[1].errorType).toBe("TIMEOUT");
    });

    it("passes limit to query", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const scorer = new AgentScorer(pool);

      await scorer.getAgentHistory("agent-1", 10);

      const [, params] = queryMock.mock.calls[0];
      expect(params[1]).toBe(10);
    });

    it("defaults limit to 20", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const scorer = new AgentScorer(pool);

      await scorer.getAgentHistory("agent-1");

      const [, params] = queryMock.mock.calls[0];
      expect(params[1]).toBe(20);
    });
  });
});
