import { Hono } from "hono";
import { randomUUID } from "crypto";
import type { Pool, QueryResult } from "pg";
import {
  CredentialPushRequestSchema,
  ProjectCredentialSchema,
  CredentialHealthSchema,
  type ProjectCredential,
  type CredentialHealth,
  DAPR_PUBSUB_NAME,
  CREDENTIAL_REFRESHED_TOPIC,
} from "@mesh-six/core";
import type { DaprClient } from "@dapr/dapr";
import {
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
} from "../config.js";

// -------------------------------------------------------------------------
// Row → API response mapper
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Route factory
// -------------------------------------------------------------------------

export function createCredentialsRouter(pool: Pool, dapr: DaprClient): Hono {
  const app = new Hono();

  // POST /:id/credentials — push new credentials
  app.post("/:id/credentials", async (c) => {
    const projectId = c.req.param("id");
    const pushedBy = c.req.header("x-pushed-by");

    // Verify project exists
    const projResult = await pool.query(
      "SELECT id FROM auth_projects WHERE id = $1",
      [projectId]
    );
    if (projResult.rows.length === 0) {
      return c.json({ error: `Project '${projectId}' not found` }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = CredentialPushRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation error", details: parsed.error.issues }, 400);
    }

    const req = parsed.data;

    // Invalidate existing active credentials
    await pool.query(
      "UPDATE auth_credentials SET invalidated_at = NOW() WHERE project_id = $1 AND invalidated_at IS NULL",
      [projectId]
    );

    // Invalidate active bundles
    await pool.query(
      "UPDATE auth_bundles SET expired_at = NOW() WHERE project_id = $1 AND expired_at IS NULL",
      [projectId]
    );

    const id = randomUUID();

    const result: QueryResult<CredentialRow> = await pool.query(
      `INSERT INTO auth_credentials
         (id, project_id, access_token, refresh_token, expires_at,
          account_uuid, email_address, organization_uuid,
          billing_type, display_name, scopes, subscription_type,
          rate_limit_tier, source, pushed_by)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, 'push', $14)
       RETURNING *`,
      [
        id,
        projectId,
        req.accessToken,
        req.refreshToken ?? null,
        req.expiresAt,
        req.accountUuid ?? null,
        req.emailAddress ?? null,
        req.organizationUuid ?? null,
        req.billingType ?? "stripe_subscription",
        req.displayName ?? "mesh-six",
        req.scopes ? JSON.stringify(req.scopes) : null,
        req.subscriptionType ?? null,
        req.rateLimitTier ?? null,
        pushedBy ?? null,
      ]
    );

    // Update project account metadata if provided
    if (req.accountUuid || req.emailAddress || req.organizationUuid) {
      await pool.query(
        `UPDATE auth_projects SET
           claude_account_uuid = COALESCE($2, claude_account_uuid),
           claude_org_uuid = COALESCE($3, claude_org_uuid),
           claude_email = COALESCE($4, claude_email),
           updated_at = NOW()
         WHERE id = $1`,
        [
          projectId,
          req.accountUuid ?? null,
          req.organizationUuid ?? null,
          req.emailAddress ?? null,
        ]
      );
    }

    const credential = rowToCredential(result.rows[0]);

    // Publish credential-refreshed event
    try {
      await dapr.pubsub.publish(DAPR_PUBSUB_NAME, CREDENTIAL_REFRESHED_TOPIC, {
        projectId,
        credentialId: id,
        source: "push",
      });
    } catch {
      // Non-fatal
    }

    console.log(`[auth-service] Credential pushed for project ${projectId} (expires ${req.expiresAt})`);
    return c.json(credential, 201);
  });

  // GET /:id/health — credential health status
  app.get("/:id/health", async (c) => {
    const projectId = c.req.param("id");

    // Verify project exists
    const projResult = await pool.query(
      "SELECT id FROM auth_projects WHERE id = $1",
      [projectId]
    );
    if (projResult.rows.length === 0) {
      return c.json({ error: `Project '${projectId}' not found` }, 404);
    }

    // Get active credential (not invalidated and not expired)
    const credResult: QueryResult<CredentialRow> = await pool.query(
      `SELECT * FROM auth_credentials
       WHERE project_id = $1
         AND invalidated_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId]
    );

    const activeCred = credResult.rows.length > 0
      ? rowToCredential(credResult.rows[0])
      : null;

    // Check if any credential has a refresh token
    const refreshResult = await pool.query(
      `SELECT 1 FROM auth_credentials
       WHERE project_id = $1 AND refresh_token IS NOT NULL
       LIMIT 1`,
      [projectId]
    );
    const hasRefreshToken = refreshResult.rows.length > 0;

    // Get last refresh time
    const lastRefreshResult = await pool.query<{ last: Date | null }>(
      `SELECT MAX(created_at) AS last FROM auth_credentials
       WHERE project_id = $1 AND source = 'refresh'`,
      [projectId]
    );
    const lastRefreshAt = lastRefreshResult.rows[0].last
      ? lastRefreshResult.rows[0].last.toISOString()
      : undefined;

    // Get active bundle ID
    const bundleResult = await pool.query<{ id: string }>(
      `SELECT id FROM auth_bundles
       WHERE project_id = $1 AND expired_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId]
    );
    const activeBundleId = bundleResult.rows.length > 0
      ? bundleResult.rows[0].id
      : undefined;

    const health: CredentialHealth = CredentialHealthSchema.parse({
      projectId,
      hasValidCredential: activeCred !== null,
      expiresAt: activeCred?.expiresAt,
      expiresInMs: activeCred
        ? new Date(activeCred.expiresAt).getTime() - Date.now()
        : undefined,
      hasRefreshToken,
      lastRefreshAt,
      activeBundleId,
    });

    return c.json(health);
  });

  // POST /:id/refresh — force OAuth token refresh
  app.post("/:id/refresh", async (c) => {
    const projectId = c.req.param("id");

    // Verify project exists
    const projResult = await pool.query(
      "SELECT id FROM auth_projects WHERE id = $1",
      [projectId]
    );
    if (projResult.rows.length === 0) {
      return c.json({ error: `Project '${projectId}' not found` }, 404);
    }

    // Find most recent credential with a refresh token
    const credResult: QueryResult<CredentialRow> = await pool.query(
      `SELECT * FROM auth_credentials
       WHERE project_id = $1 AND refresh_token IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId]
    );

    if (credResult.rows.length === 0) {
      return c.json({ error: "No refresh token available for this project" }, 422);
    }

    const oldCred = rowToCredential(credResult.rows[0]);
    if (!oldCred.refreshToken) {
      return c.json({ error: "No refresh token available for this project" }, 422);
    }

    // Perform OAuth token refresh
    let tokenData: { access_token: string; refresh_token?: string; expires_in: number };
    try {
      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oldCred.refreshToken,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[auth-service] OAuth refresh failed for ${projectId}: ${response.status} ${body}`);
        return c.json({ error: `OAuth refresh failed: ${response.status}` }, 502);
      }

      tokenData = await response.json() as typeof tokenData;
    } catch (err) {
      console.error(`[auth-service] OAuth refresh network error for ${projectId}:`, err);
      return c.json({ error: "OAuth refresh request failed" }, 502);
    }

    // Invalidate old credential
    await pool.query(
      "UPDATE auth_credentials SET invalidated_at = NOW() WHERE id = $1",
      [oldCred.id]
    );

    // Invalidate active bundles
    await pool.query(
      "UPDATE auth_bundles SET expired_at = NOW() WHERE project_id = $1 AND expired_at IS NULL",
      [projectId]
    );

    const newId = randomUUID();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    const newCredResult: QueryResult<CredentialRow> = await pool.query(
      `INSERT INTO auth_credentials
         (id, project_id, access_token, refresh_token, expires_at,
          account_uuid, email_address, organization_uuid,
          billing_type, display_name, scopes, subscription_type,
          rate_limit_tier, source)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, 'refresh')
       RETURNING *`,
      [
        newId,
        projectId,
        tokenData.access_token,
        tokenData.refresh_token ?? oldCred.refreshToken,
        expiresAt,
        oldCred.accountUuid ?? null,
        oldCred.emailAddress ?? null,
        oldCred.organizationUuid ?? null,
        oldCred.billingType,
        oldCred.displayName,
        oldCred.scopes ? JSON.stringify(oldCred.scopes) : null,
        oldCred.subscriptionType ?? null,
        oldCred.rateLimitTier ?? null,
      ]
    );

    const newCred = rowToCredential(newCredResult.rows[0]);

    // Publish credential-refreshed event
    try {
      await dapr.pubsub.publish(DAPR_PUBSUB_NAME, CREDENTIAL_REFRESHED_TOPIC, {
        projectId,
        credentialId: newId,
        source: "refresh",
      });
    } catch {
      // Non-fatal
    }

    console.log(`[auth-service] Refreshed credential for ${projectId} (expires ${expiresAt})`);
    return c.json(newCred);
  });

  return app;
}
