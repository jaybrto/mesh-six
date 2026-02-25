import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { Pool } from "pg";

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

const now = new Date("2026-02-25T00:00:00Z");
const future = new Date(Date.now() + 3600000);

const projectRow = {
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
};

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

describe("POST /:id/provision", () => {
  it("returns no_credentials when project not found", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createProvisionRouter } = await import("./provision.js");
    const app = new Hono();
    app.route("/", createProvisionRouter(pool));

    const res = await request(app, "POST", "/unknown/provision", { podName: "pod-1" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("no_credentials");
  });

  it("returns no_credentials when no active credential", async () => {
    const pool = makePool(async (sql: string) => {
      if (sql.includes("auth_projects")) return { rows: [projectRow] };
      return { rows: [] };
    });
    const { createProvisionRouter } = await import("./provision.js");
    const app = new Hono();
    app.route("/", createProvisionRouter(pool));

    const res = await request(app, "POST", "/proj-1/provision", { podName: "pod-1" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("no_credentials");
  });

  it("generates bundle and returns provisioned status", async () => {
    let insertedBundle = false;
    const pool = makePool(async (sql: string) => {
      if (sql.includes("auth_projects")) return { rows: [projectRow] };
      if (sql.includes("MAX(version)")) return { rows: [{ max_version: null }] };
      if (sql.includes("INSERT INTO auth_bundles")) {
        insertedBundle = true;
        return { rows: [] };
      }
      if (sql.includes("auth_bundles")) return { rows: [] };
      if (sql.includes("auth_credentials")) return { rows: [credRow] };
      return { rows: [] };
    });
    const { createProvisionRouter } = await import("./provision.js");
    const app = new Hono();
    app.route("/", createProvisionRouter(pool));

    const res = await request(app, "POST", "/proj-1/provision", { podName: "pod-1" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("provisioned");
    expect(typeof body.bundleId).toBe("string");
    expect(insertedBundle).toBe(true);
  });
});

describe("GET /:id/provision/:bundleId", () => {
  it("returns 404 for unknown bundle", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const { createProvisionRouter } = await import("./provision.js");
    const app = new Hono();
    app.route("/", createProvisionRouter(pool));

    const res = await request(app, "GET", "/proj-1/provision/no-such-bundle");
    expect(res.status).toBe(404);
  });
});
