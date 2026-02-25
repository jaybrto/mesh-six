import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import type { Pool } from "pg";

const mockDapr = {
  pubsub: { publish: mock(() => Promise.resolve()) },
} as unknown as import("@dapr/dapr").DaprClient;

function makePool(queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  return { query: queryFn } as unknown as Pool;
}

async function request(app: Hono, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return app.fetch(req);
}

const now = new Date("2026-02-25T00:00:00Z");
const future = new Date(Date.now() + 3600000);

const credRow = {
  id: "cred-1",
  project_id: "proj-1",
  access_token: "sk-ant-test",
  refresh_token: null,
  expires_at: future,
  account_uuid: null,
  email_address: null,
  organization_uuid: null,
  billing_type: "stripe_subscription",
  display_name: "mesh-six",
  scopes: null,
  subscription_type: null,
  rate_limit_tier: null,
  source: "push",
  pushed_by: null,
  created_at: now,
  invalidated_at: null,
};

describe("POST /:id/credentials", () => {
  it("returns 404 for unknown project", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/unknown/credentials", {
      accessToken: "sk-ant-test",
      expiresAt: future.toISOString(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid body", async () => {
    const pool = makePool(async (sql: string) => {
      if (sql.includes("SELECT id FROM auth_projects")) return { rows: [{ id: "proj-1" }] };
      return { rows: [] };
    });
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/proj-1/credentials", { bad: "data" });
    expect(res.status).toBe(400);
  });

  it("creates credential and returns 201", async () => {
    const pool = makePool(async (sql: string) => {
      if (sql.includes("SELECT id FROM auth_projects")) return { rows: [{ id: "proj-1" }] };
      if (sql.includes("INSERT INTO auth_credentials")) return { rows: [credRow] };
      return { rows: [] };
    });
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/proj-1/credentials", {
      accessToken: "sk-ant-test",
      expiresAt: future.toISOString(),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe("cred-1");
    expect(body.accessToken).toBe("sk-ant-test");
  });
});

describe("GET /:id/health", () => {
  it("returns 404 for unknown project", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "GET", "/unknown/health");
    expect(res.status).toBe(404);
  });

  it("returns health with hasValidCredential=true", async () => {
    const pool = makePool(async (sql: string) => {
      if (sql.includes("SELECT id FROM auth_projects")) return { rows: [{ id: "proj-1" }] };
      if (sql.includes("SELECT * FROM auth_credentials")) return { rows: [credRow] };
      if (sql.includes("SELECT 1 FROM auth_credentials")) return { rows: [{ "1": 1 }] };
      if (sql.includes("MAX(created_at)")) return { rows: [{ last: null }] };
      if (sql.includes("auth_bundles")) return { rows: [{ id: "bundle-1" }] };
      return { rows: [] };
    });
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "GET", "/proj-1/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.hasValidCredential).toBe(true);
    expect(body.hasRefreshToken).toBe(true);
    expect(body.activeBundleId).toBe("bundle-1");
  });
});

describe("POST /:id/refresh", () => {
  it("returns 422 when no refresh token exists", async () => {
    const pool = makePool(async (sql: string) => {
      if (sql.includes("SELECT id FROM auth_projects")) return { rows: [{ id: "proj-1" }] };
      return { rows: [] };
    });
    const { createCredentialsRouter } = await import("./credentials.js");
    const app = new Hono();
    app.route("/", createCredentialsRouter(pool, mockDapr));

    const res = await request(app, "POST", "/proj-1/refresh");
    expect(res.status).toBe(422);
  });
});
