import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Pool } from "pg";
import { appendEvent, loadEvents, loadEventsByType } from "./event-db.js";

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL || "";

describe("architect event-db", () => {
  let pool: Pool;
  const testActorId = `test/repo/${Date.now()}`;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error("DATABASE_URL required for DB tests");
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM architect_events WHERE actor_id = $1", [testActorId]);
    await pool.end();
  });

  it("appends and loads events in order", async () => {
    await appendEvent(pool, testActorId, "activated", { issueTitle: "Test" });
    await appendEvent(pool, testActorId, "consulted", { question: "How?" });
    await appendEvent(pool, testActorId, "question-received", { questionText: "What auth?" });

    const events = await loadEvents(pool, testActorId);
    expect(events).toHaveLength(3);
    expect(events[0].event_type).toBe("activated");
    expect(events[1].event_type).toBe("consulted");
    expect(events[2].event_type).toBe("question-received");
    expect(events[0].payload).toEqual({ issueTitle: "Test" });
  });

  it("loads events filtered by type", async () => {
    const consulted = await loadEventsByType(pool, testActorId, "consulted");
    expect(consulted).toHaveLength(1);
    expect(consulted[0].payload).toEqual({ question: "How?" });
  });
});
