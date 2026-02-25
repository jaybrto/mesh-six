import { Hono } from "hono";
import { randomUUID } from "crypto";
import type { Pool, QueryResult } from "pg";
import {
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  ProjectConfigSchema,
  ProjectCredentialSchema,
  type ProjectConfig,
  type ProjectCredential,
  type ProvisionResponse,
} from "@mesh-six/core";
import { generateBundle, computeConfigHash } from "../bundle.js";

// -------------------------------------------------------------------------
// Row mappers
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

interface CredentialRow {
  id: string;
  project_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: Date;
  account_uuid: string | null;
  email_address: string | null;
  organization_uuid: string | null;
  billing_type: string;
  display_name: string;
  scopes: unknown[] | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
  source: "push" | "refresh" | "import";
  pushed_by: string | null;
  created_at: Date;
  invalidated_at: Date | null;
}

interface BundleRow {
  id: string;
  project_id: string;
  credential_id: string;
  version: number;
  config_hash: string;
  credential_expires_at: Date;
  created_at: Date;
  expired_at: Date | null;
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

function rowToCredential(row: CredentialRow): ProjectCredential {
  return ProjectCredentialSchema.parse({
    id: row.id,
    projectId: row.project_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token ?? undefined,
    expiresAt: row.expires_at.toISOString(),
    accountUuid: row.account_uuid ?? undefined,
    emailAddress: row.email_address ?? undefined,
    organizationUuid: row.organization_uuid ?? undefined,
    billingType: row.billing_type,
    displayName: row.display_name,
    scopes: row.scopes ?? undefined,
    subscriptionType: row.subscription_type ?? undefined,
    rateLimitTier: row.rate_limit_tier ?? undefined,
    source: row.source,
    pushedBy: row.pushed_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    invalidatedAt: row.invalidated_at ? row.invalidated_at.toISOString() : undefined,
  });
}

// Per-project generation locks to prevent concurrent bundle creation
const generationLocks = new Map<string, Promise<ProvisionResponse>>();

// -------------------------------------------------------------------------
// Route factory
// -------------------------------------------------------------------------

export function createProvisionRouter(pool: Pool): Hono {
  const app = new Hono();

  // POST /:id/provision — provision or return current bundle
  app.post("/:id/provision", async (c) => {
    const projectId = c.req.param("id");

    // Get project
    const projResult: QueryResult<ProjectRow> = await pool.query(
      "SELECT * FROM auth_projects WHERE id = $1",
      [projectId]
    );
    if (projResult.rows.length === 0) {
      const resp: ProvisionResponse = ProvisionResponseSchema.parse({
        status: "no_credentials",
        message: `Project '${projectId}' not found`,
      });
      return c.json(resp);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = ProvisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const req = parsed.data;
    const project = rowToProject(projResult.rows[0]);

    // Per-project mutex
    const existing = generationLocks.get(projectId);
    if (existing) {
      console.log(`[auth-service] Awaiting in-flight provision for ${projectId}`);
      const resp = await existing;
      return c.json(resp);
    }

    const promise = doProvision(pool, project, req.currentBundleId);
    generationLocks.set(projectId, promise);
    try {
      const resp = await promise;
      return c.json(resp);
    } finally {
      generationLocks.delete(projectId);
    }
  });

  // GET /:id/provision/:bundleId — download bundle tar.gz
  app.get("/:id/provision/:bundleId", async (c) => {
    const projectId = c.req.param("id");
    const bundleId = c.req.param("bundleId");

    const result: QueryResult<{ bundle_data: Buffer; project_id: string }> = await pool.query(
      "SELECT bundle_data, project_id FROM auth_bundles WHERE id = $1",
      [bundleId]
    );

    if (result.rows.length === 0) {
      return c.json({ error: `Bundle '${bundleId}' not found` }, 404);
    }

    const row = result.rows[0];
    if (row.project_id !== projectId) {
      return c.json({ error: `Bundle '${bundleId}' not found` }, 404);
    }

    return new Response(row.bundle_data.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="bundle-${bundleId}.tar.gz"`,
      },
    });
  });

  return app;
}

// -------------------------------------------------------------------------
// Core provision logic
// -------------------------------------------------------------------------

async function doProvision(
  pool: Pool,
  project: ProjectConfig,
  currentBundleId?: string
): Promise<ProvisionResponse> {
  // Check active bundle
  const bundleResult: QueryResult<BundleRow> = await pool.query(
    `SELECT * FROM auth_bundles
     WHERE project_id = $1 AND expired_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [project.id]
  );

  const activeBundle = bundleResult.rows.length > 0 ? bundleResult.rows[0] : null;

  // Get active credential
  const credResult: QueryResult<CredentialRow> = await pool.query(
    `SELECT * FROM auth_credentials
     WHERE project_id = $1
       AND invalidated_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [project.id]
  );

  const activeCred = credResult.rows.length > 0
    ? rowToCredential(credResult.rows[0])
    : null;

  if (!activeCred) {
    return ProvisionResponseSchema.parse({
      status: "no_credentials",
      message: "No valid credentials available",
    });
  }

  // Check if current bundle is still valid
  if (activeBundle && currentBundleId === activeBundle.id) {
    const configHash = computeConfigHash(project, activeBundle.credential_id);
    if (
      configHash === activeBundle.config_hash &&
      activeBundle.credential_expires_at > new Date()
    ) {
      return ProvisionResponseSchema.parse({
        status: "current",
        bundleId: activeBundle.id,
        credentialExpiresAt: activeBundle.credential_expires_at.toISOString(),
      });
    }
  }

  // Generate new bundle (synchronous — pure Buffer/zlib, no I/O)
  const bundleData = generateBundle({ project, credential: activeCred });
  const configHash = computeConfigHash(project, activeCred.id);

  // Get next version number
  const versionResult = await pool.query<{ max_version: number | null }>(
    "SELECT MAX(version) AS max_version FROM auth_bundles WHERE project_id = $1",
    [project.id]
  );
  const version = (versionResult.rows[0].max_version ?? 0) + 1;

  // Invalidate previous active bundles
  await pool.query(
    "UPDATE auth_bundles SET expired_at = NOW() WHERE project_id = $1 AND expired_at IS NULL",
    [project.id]
  );

  // Insert new bundle record
  const bundleId = randomUUID();
  await pool.query(
    `INSERT INTO auth_bundles
       (id, project_id, credential_id, version, bundle_data, config_hash, credential_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      bundleId,
      project.id,
      activeCred.id,
      version,
      bundleData,
      configHash,
      activeCred.expiresAt,
    ]
  );

  console.log(
    `[auth-service] Generated bundle v${version} for ${project.id} (${bundleData.length} bytes)`
  );

  return ProvisionResponseSchema.parse({
    status: "provisioned",
    bundleId,
    credentialExpiresAt: activeCred.expiresAt,
  });
}
