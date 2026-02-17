import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventLog, type MeshEvent } from "./events.js";

function createMockPool(queryFn?: (...args: any[]) => any) {
  return {
    query: queryFn ?? mock(() => Promise.resolve({ rows: [] })),
  } as any;
}

function makeEvent(overrides: Partial<MeshEvent> = {}): MeshEvent {
  return {
    traceId: "trace-1",
    agentId: "test-agent",
    eventType: "test.event",
    payload: { key: "value" },
    ...overrides,
  };
}

describe("EventLog", () => {
  describe("emit", () => {
    it("inserts a single event with correct parameters", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.emit(makeEvent({ taskId: "task-1", aggregateId: "agg-1" }));

      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("INSERT INTO mesh_six_events");
      expect(params[0]).toBe("trace-1");
      expect(params[1]).toBe("task-1");
      expect(params[2]).toBe("test-agent");
      expect(params[3]).toBe("test.event");
      expect(params[4]).toBe(1);
      expect(JSON.parse(params[5] as string)).toEqual({ key: "value" });
      expect(params[6]).toBe("agg-1");
      expect(params[7]).toBeNull();
    });

    it("sets optional fields to null when not provided", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.emit(makeEvent());

      const [, params] = queryMock.mock.calls[0];
      expect(params[1]).toBeNull(); // taskId
      expect(params[6]).toBeNull(); // aggregateId
      expect(params[7]).toBeNull(); // idempotencyKey
    });
  });

  describe("emitBatch", () => {
    it("does nothing for empty array", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.emitBatch([]);

      expect(queryMock).not.toHaveBeenCalled();
    });

    it("inserts multiple events in one query", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.emitBatch([
        makeEvent({ traceId: "t1" }),
        makeEvent({ traceId: "t2" }),
      ]);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("VALUES");
      expect(params).toHaveLength(16); // 2 events x 8 fields
      expect(params[0]).toBe("t1");
      expect(params[8]).toBe("t2");
    });
  });

  describe("query", () => {
    it("returns mapped events with snake_case to camelCase", async () => {
      const queryMock = mock(() =>
        Promise.resolve({
          rows: [
            {
              seq: 1,
              trace_id: "t1",
              task_id: null,
              agent_id: "agent-1",
              event_type: "test.event",
              event_version: 1,
              payload: { key: "value" },
              aggregate_id: null,
              idempotency_key: null,
            },
          ],
        })
      );
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      const results = await log.query({ traceId: "t1" });

      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe("t1");
      expect(results[0].agentId).toBe("agent-1");
      expect(results[0].eventType).toBe("test.event");
      expect(results[0].seq).toBe(1);
    });

    it("builds WHERE clause from provided options", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.query({ traceId: "t1", agentId: "a1", eventType: "llm.call" });

      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("trace_id = $1");
      expect(sql).toContain("agent_id = $2");
      expect(sql).toContain("event_type = $3");
      expect(params[0]).toBe("t1");
      expect(params[1]).toBe("a1");
      expect(params[2]).toBe("llm.call");
    });

    it("uses default limit of 100", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.query({});

      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("LIMIT $1");
      expect(params[0]).toBe(100);
    });
  });

  describe("replay", () => {
    it("queries by aggregate_id ordered by seq", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.replay("task:abc");

      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("aggregate_id = $1");
      expect(sql).toContain("ORDER BY seq ASC");
      expect(params[0]).toBe("task:abc");
    });

    it("filters by afterSeq when provided", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.replay("task:abc", 42);

      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("seq > $2");
      expect(params[1]).toBe(42);
    });
  });

  describe("idempotency", () => {
    it("passes idempotency_key through emit", async () => {
      const queryMock = mock(() => Promise.resolve({ rows: [] }));
      const pool = createMockPool(queryMock);
      const log = new EventLog(pool);

      await log.emit(makeEvent({ idempotencyKey: "dedup-key-1" }));

      const [, params] = queryMock.mock.calls[0];
      expect(params[7]).toBe("dedup-key-1");
    });
  });
});
