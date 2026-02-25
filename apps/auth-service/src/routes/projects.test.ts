import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import type { Pool } from "pg";

// Mock dapr client
const mockDapr = {
  pubsub: { publish: mock(() => Promise.resolve()) },
} as unknown as import("@dapr/dapr").DaprClient;

// Minimal pg Pool mock — overridden per test
function makePool(queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  return { query: queryFn } as unknown as Pool;
}

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return app.fetch(req);
}

describe("POST /", () => {
  it("creates a project and returns 201", async () => {
    const now = new Date("2026-02-25T00:00:00Z");
    const pool = makePool(async (sql: string) => {
      if (sql.includes("INSERT")) {
        return {
          rows: [{
            id: "proj-1",
            display_name: "Test",
            claude_account_uuid: null,
            claude_org_uuid: null,
            claude_email: null,
            settings_json: null,
            claude_json: null,
            mcp_json: null,
            claude_md: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      return { rows: [] };
    });

    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/", { id: "proj-1", displayName: "Test" });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe("proj-1");
    expect(body.displayName).toBe("Test");
  });

  it("returns 400 on missing displayName", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/", { id: "proj-1" });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate project id", async () => {
    const pool = makePool(async () => {
      const err = new Error("duplicate") as Error & { code: string };
      err.code = "23505";
      throw err;
    });

    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/", { id: "proj-1", displayName: "Test" });
    expect(res.status).toBe(409);
  });
});

describe("GET /:id", () => {
  it("returns 404 for missing project", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "GET", "/missing");
    expect(res.status).toBe(404);
  });

  it("returns project data for known id", async () => {
    const now = new Date("2026-02-25T00:00:00Z");
    const pool = makePool(async () => ({
      rows: [{
        id: "proj-1",
        display_name: "Test",
        claude_account_uuid: null,
        claude_org_uuid: null,
        claude_email: null,
        settings_json: null,
        claude_json: null,
        mcp_json: null,
        claude_md: null,
        created_at: now,
        updated_at: now,
      }],
    }));

    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "GET", "/proj-1");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe("proj-1");
  });
});

describe("PUT /:id", () => {
  it("returns 404 for missing project", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "PUT", "/missing", { displayName: "Updated" });
    expect(res.status).toBe(404);
  });

  it("updates and returns project", async () => {
    const now = new Date("2026-02-25T00:00:00Z");
    const pool = makePool(async (sql: string) => {
      if (sql.includes("UPDATE auth_projects")) {
        return {
          rows: [{
            id: "proj-1",
            display_name: "Updated",
            claude_account_uuid: null,
            claude_org_uuid: null,
            claude_email: null,
            settings_json: null,
            claude_json: null,
            mcp_json: null,
            claude_md: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      return { rows: [] };
    });

    const { createProjectsRouter } = await import("./projects.js");
    const app = new Hono();
    app.route("/", createProjectsRouter(pool, mockDapr));

    const res = await request(app, "PUT", "/proj-1", { displayName: "Updated" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.displayName).toBe("Updated");
  });
});
