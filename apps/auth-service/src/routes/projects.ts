import { Hono } from "hono";
import { z } from "zod";
import type { Pool, QueryResult } from "pg";
import { ProjectConfigSchema, type ProjectConfig } from "@mesh-six/core";
import { DAPR_PUBSUB_NAME, CONFIG_UPDATED_TOPIC } from "@mesh-six/core";
import type { DaprClient } from "@dapr/dapr";

// -------------------------------------------------------------------------
// Row → API response mapper
// -------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  display_name: string;
  claude_account_uuid: string | null;
  claude_org_uuid: string | null;
  claude_email: string | null;
  settings_json: string | null;
  claude_json: string | null;
  mcp_json: string | null;
  claude_md: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToProject(row: ProjectRow): ProjectConfig {
  return ProjectConfigSchema.parse({
    id: row.id,
    displayName: row.display_name,
    claudeAccountUuid: row.claude_account_uuid ?? undefined,
    claudeOrgUuid: row.claude_org_uuid ?? undefined,
    claudeEmail: row.claude_email ?? undefined,
    settingsJson: row.settings_json ?? undefined,
    claudeJson: row.claude_json ?? undefined,
    mcpJson: row.mcp_json ?? undefined,
    claudeMd: row.claude_md ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

// -------------------------------------------------------------------------
// Request schemas
// -------------------------------------------------------------------------

const CreateProjectSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  claudeAccountUuid: z.string().optional(),
  claudeOrgUuid: z.string().optional(),
  claudeEmail: z.string().optional(),
  settingsJson: z.string().optional(),
  claudeJson: z.string().optional(),
  mcpJson: z.string().optional(),
  claudeMd: z.string().optional(),
});

const UpdateProjectSchema = CreateProjectSchema.omit({ id: true }).partial();

// -------------------------------------------------------------------------
// Route factory
// -------------------------------------------------------------------------

export function createProjectsRouter(pool: Pool, dapr: DaprClient): Hono {
  const app = new Hono();

  // POST / — create project
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = CreateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const { id, displayName, claudeAccountUuid, claudeOrgUuid, claudeEmail,
            settingsJson, claudeJson, mcpJson, claudeMd } = parsed.data;

    try {
      const result: QueryResult<ProjectRow> = await pool.query(
        `INSERT INTO auth_projects
           (id, display_name, claude_account_uuid, claude_org_uuid, claude_email,
            settings_json, claude_json, mcp_json, claude_md)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          id, displayName,
          claudeAccountUuid ?? null, claudeOrgUuid ?? null, claudeEmail ?? null,
          settingsJson ?? null, claudeJson ?? null, mcpJson ?? null, claudeMd ?? null,
        ]
      );

      const project = rowToProject(result.rows[0]);
      return c.json(project, 201);
    } catch (err: unknown) {
      const pg = err as { code?: string };
      if (pg.code === "23505") {
        return c.json({ error: `Project '${id}' already exists` }, 409);
      }
      console.error("[auth-service] createProject error:", err);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // GET /:id — get project
  app.get("/:id", async (c) => {
    const id = c.req.param("id");

    const result: QueryResult<ProjectRow> = await pool.query(
      "SELECT * FROM auth_projects WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: `Project '${id}' not found` }, 404);
    }

    return c.json(rowToProject(result.rows[0]));
  });

  // PUT /:id — update project
  app.put("/:id", async (c) => {
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = UpdateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    // Build dynamic SET clause for only provided fields
    const updates = parsed.data;
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [id];

    const fieldMap: Record<string, string> = {
      displayName: "display_name",
      claudeAccountUuid: "claude_account_uuid",
      claudeOrgUuid: "claude_org_uuid",
      claudeEmail: "claude_email",
      settingsJson: "settings_json",
      claudeJson: "claude_json",
      mcpJson: "mcp_json",
      claudeMd: "claude_md",
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        params.push((updates as Record<string, unknown>)[key] ?? null);
        setClauses.push(`${col} = $${params.length}`);
      }
    }

    const result: QueryResult<ProjectRow> = await pool.query(
      `UPDATE auth_projects SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: `Project '${id}' not found` }, 404);
    }

    // Invalidate active bundles if config fields changed
    const configFields = ["settingsJson", "claudeJson", "mcpJson", "claudeMd"];
    const configChanged = configFields.some((f) => f in updates);
    if (configChanged) {
      await pool.query(
        "UPDATE auth_bundles SET expired_at = NOW() WHERE project_id = $1 AND expired_at IS NULL",
        [id]
      );
      // Publish config-updated event
      try {
        await dapr.pubsub.publish(DAPR_PUBSUB_NAME, CONFIG_UPDATED_TOPIC, { projectId: id });
      } catch {
        // Non-fatal
      }
    }

    return c.json(rowToProject(result.rows[0]));
  });

  return app;
}
