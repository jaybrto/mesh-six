/**
 * Background OAuth credential refresh timer.
 *
 * Runs every REFRESH_CHECK_INTERVAL_MS (default 30min).
 * For each project, refreshes credentials expiring within CREDENTIAL_REFRESH_THRESHOLD_MS.
 */
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import type { DaprClient } from "@dapr/dapr";
import {
  DAPR_PUBSUB_NAME,
  CREDENTIAL_REFRESHED_TOPIC,
} from "@mesh-six/core";
import {
  REFRESH_CHECK_INTERVAL_MS,
  CREDENTIAL_REFRESH_THRESHOLD_MS,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
} from "./config.js";

export function startRefreshTimer(pool: Pool, dapr: DaprClient): () => void {
  const timer = setInterval(
    () => refreshAllCredentials(pool, dapr).catch((err) => {
      console.error("[auth-service] refreshAllCredentials error:", err);
    }),
    REFRESH_CHECK_INTERVAL_MS
  );

  console.log(`[auth-service] Refresh timer started (interval: ${REFRESH_CHECK_INTERVAL_MS / 60000}min)`);

  return () => clearInterval(timer);
}

async function refreshAllCredentials(pool: Pool, dapr: DaprClient): Promise<void> {
  const projects = await pool.query<{ id: string }>("SELECT id FROM auth_projects");

  for (const { id: projectId } of projects.rows) {
    try {
      await maybeRefreshProject(pool, dapr, projectId);
    } catch (err) {
      console.error(`[auth-service] refresh error for ${projectId}:`, err);
    }
  }
}

async function maybeRefreshProject(pool: Pool, dapr: DaprClient, projectId: string): Promise<void> {
  // Check if active credential is expiring soon
  const credResult = await pool.query<{
    id: string;
    expires_at: Date;
    refresh_token: string | null;
    account_uuid: string | null;
    email_address: string | null;
    organization_uuid: string | null;
    billing_type: string;
    display_name: string;
    scopes: unknown[] | null;
    subscription_type: string | null;
    rate_limit_tier: string | null;
  }>(
    `SELECT * FROM auth_credentials
     WHERE project_id = $1
       AND invalidated_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId]
  );

  const activeCred = credResult.rows.length > 0 ? credResult.rows[0] : null;
  const timeUntilExpiry = activeCred
    ? activeCred.expires_at.getTime() - Date.now()
    : -1;

  // Skip if credential is valid and not expiring soon
  if (activeCred && timeUntilExpiry >= CREDENTIAL_REFRESH_THRESHOLD_MS) {
    return;
  }

  // Find any credential with a refresh token (even expired)
  const refreshResult = await pool.query<{
    id: string;
    refresh_token: string;
    account_uuid: string | null;
    email_address: string | null;
    organization_uuid: string | null;
    billing_type: string;
    display_name: string;
    scopes: unknown[] | null;
    subscription_type: string | null;
    rate_limit_tier: string | null;
  }>(
    `SELECT * FROM auth_credentials
     WHERE project_id = $1 AND refresh_token IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (refreshResult.rows.length === 0) {
    if (!activeCred) {
      console.log(`[auth-service] No credentials or refresh token for ${projectId}`);
    }
    return;
  }

  const oldCred = refreshResult.rows[0];
  console.log(`[auth-service] Proactive refresh for ${projectId} (expires in ${Math.round(timeUntilExpiry / 60000)}min)`);

  // Perform OAuth refresh
  let tokenData: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oldCred.refresh_token,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[auth-service] OAuth refresh failed for ${projectId}: ${response.status} ${body}`);
      return;
    }

    tokenData = await response.json() as typeof tokenData;
  } catch (err) {
    console.error(`[auth-service] OAuth refresh network error for ${projectId}:`, err);
    return;
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

  await pool.query(
    `INSERT INTO auth_credentials
       (id, project_id, access_token, refresh_token, expires_at,
        account_uuid, email_address, organization_uuid,
        billing_type, display_name, scopes, subscription_type,
        rate_limit_tier, source)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, 'refresh')`,
    [
      newId,
      projectId,
      tokenData.access_token,
      tokenData.refresh_token ?? oldCred.refresh_token,
      expiresAt,
      oldCred.account_uuid,
      oldCred.email_address,
      oldCred.organization_uuid,
      oldCred.billing_type,
      oldCred.display_name,
      oldCred.scopes ? JSON.stringify(oldCred.scopes) : null,
      oldCred.subscription_type,
      oldCred.rate_limit_tier,
    ]
  );

  // Publish event
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
}
