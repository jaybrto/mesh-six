#!/usr/bin/env bun
/**
 * Credential History Script
 *
 * Displays each project's credential refresh history with expiry status.
 * Highlights credentials expiring within 24 hours.
 *
 * Usage:
 *   bun run scripts/credential-history.ts
 *
 * Environment:
 *   DATABASE_URL or PG_PRIMARY_URL
 */

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL or PG_PRIMARY_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

interface CredentialHistoryRow {
  project_id: string;
  project_display_name: string | null;
  credential_id: string;
  source: string;
  pushed_by: string | null;
  display_name: string | null;
  email_address: string | null;
  expires_at: string | null;
  invalidated_at: string | null;
  created_at: string;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(d);
  }
}

function getExpiryStatus(expiresAt: string | null, invalidatedAt: string | null): string {
  if (invalidatedAt) return "invalidated";
  if (!expiresAt) return "unknown";
  const expiryMs = new Date(expiresAt).getTime();
  const now = Date.now();
  if (expiryMs <= now) return "EXPIRED";
  const msLeft = expiryMs - now;
  const hoursLeft = msLeft / (1000 * 60 * 60);
  if (hoursLeft < 24) return `EXPIRING ${hoursLeft.toFixed(1)}h`;
  const daysLeft = hoursLeft / 24;
  return `valid (${daysLeft.toFixed(1)}d)`;
}

function padEnd(str: string | null | undefined, len: number): string {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

async function run() {
  const { rows } = await pool.query<CredentialHistoryRow>(`
    SELECT
      c.project_id,
      p.display_name AS project_display_name,
      c.id AS credential_id,
      c.source,
      c.pushed_by,
      c.display_name,
      c.email_address,
      c.expires_at,
      c.invalidated_at,
      c.created_at
    FROM auth_credentials c
    LEFT JOIN project_configs p ON p.id = c.project_id
    ORDER BY c.project_id, c.created_at DESC
  `);

  if (rows.length === 0) {
    console.log("No credentials found.");
    await pool.end();
    return;
  }

  console.log(`mesh-six Credential History — ${new Date().toISOString()}\n`);

  const WARN_WITHIN_MS = 24 * 60 * 60 * 1000;
  let expiringCount = 0;
  let expiredCount = 0;

  const header =
    `${"PROJECT".padEnd(22)} ${"CRED ID".padEnd(36)} ${"SOURCE".padEnd(10)} ` +
    `${"PUSHED BY".padEnd(18)} ${"EMAIL".padEnd(28)} ${"CREATED".padEnd(20)} STATUS`;
  console.log(header);
  console.log("-".repeat(150));

  let lastProject = "";
  for (const r of rows) {
    const status = getExpiryStatus(r.expires_at, r.invalidated_at);
    const isExpired = status === "EXPIRED";
    const isExpiring =
      !r.invalidated_at &&
      r.expires_at !== null &&
      new Date(r.expires_at).getTime() > Date.now() &&
      new Date(r.expires_at).getTime() - Date.now() < WARN_WITHIN_MS;

    if (isExpired) expiredCount++;
    if (isExpiring) expiringCount++;

    const projectLabel = r.project_id === lastProject
      ? " ".repeat(22)
      : padEnd(r.project_display_name ?? r.project_id, 22);
    lastProject = r.project_id;

    const warn = isExpired || isExpiring ? "  <-- WARNING" : "";
    const line =
      `${projectLabel} ${padEnd(r.credential_id, 36)} ${padEnd(r.source, 10)} ` +
      `${padEnd(r.pushed_by ?? "—", 18)} ${padEnd(r.email_address ?? "—", 28)} ` +
      `${formatDate(r.created_at).padEnd(20)} ${status}${warn}`;
    console.log(line);
  }

  console.log("\n" + "-".repeat(150));
  console.log(`Total credentials: ${rows.length}`);
  if (expiringCount > 0) {
    console.log(`WARNING: ${expiringCount} credential(s) expiring within 24 hours`);
  }
  if (expiredCount > 0) {
    console.log(`WARNING: ${expiredCount} credential(s) already expired`);
  }
  if (expiringCount === 0 && expiredCount === 0) {
    console.log("All credentials are valid.");
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Credential history failed:", err);
  process.exit(1);
});
