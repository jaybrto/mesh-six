#!/usr/bin/env bun
/**
 * Credential Backup Script
 *
 * Exports all auth_credentials rows to a timestamped JSON file and
 * uploads to MinIO via the `mc` CLI. Prunes backups older than 30 days.
 *
 * Usage:
 *   bun run scripts/credential-backup.ts
 *
 * Environment:
 *   DATABASE_URL or PG_PRIMARY_URL   PostgreSQL connection string
 *   MINIO_ALIAS                      mc alias name (default: mesh-six)
 *   MINIO_BUCKET                     Bucket name (default: mesh-six-backups)
 *   BACKUP_RETENTION_DAYS            Days to keep backups (default: 30)
 */

import pg from "pg";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL or PG_PRIMARY_URL is required");
  process.exit(1);
}

const minioAlias = process.env.MINIO_ALIAS ?? "mesh-six";
const minioBucket = process.env.MINIO_BUCKET ?? "mesh-six-backups";
const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS ?? "30", 10);

const pool = new pg.Pool({ connectionString: databaseUrl });

interface CredentialRow {
  id: string;
  project_id: string;
  expires_at: string | null;
  invalidated_at: string | null;
  source: string;
  pushed_by: string | null;
  created_at: string;
  // Sensitive fields are included — backup should be stored encrypted/restricted
  access_token: string;
  refresh_token: string | null;
  account_uuid: string | null;
  email_address: string | null;
  organization_uuid: string | null;
  billing_type: string | null;
  display_name: string | null;
  scopes: string[] | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
}

async function run(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `credentials-${timestamp}.json`;
  const localPath = join(tmpdir(), fileName);
  const remotePath = `${minioAlias}/${minioBucket}/credentials/${fileName}`;

  // --- 1. Query credentials ---
  const { rows: credentials } = await pool.query<CredentialRow>(`
    SELECT
      c.id,
      c.project_id,
      c.access_token,
      c.refresh_token,
      c.expires_at,
      c.invalidated_at,
      c.account_uuid,
      c.email_address,
      c.organization_uuid,
      c.billing_type,
      c.display_name,
      c.scopes,
      c.subscription_type,
      c.rate_limit_tier,
      c.source,
      c.pushed_by,
      c.created_at
    FROM auth_credentials c
    ORDER BY c.created_at ASC
  `);

  console.log(`Backing up ${credentials.length} credential(s)...`);

  // --- 2. Write to temp file ---
  const payload = {
    exportedAt: new Date().toISOString(),
    count: credentials.length,
    credentials,
  };
  await mkdir(tmpdir(), { recursive: true });
  await writeFile(localPath, JSON.stringify(payload, null, 2), "utf-8");

  // --- 3. Upload to MinIO ---
  console.log(`Uploading to ${remotePath}...`);
  const uploadProc = Bun.spawn(["mc", "cp", localPath, remotePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [uploadOut, uploadErr] = await Promise.all([
    new Response(uploadProc.stdout).text(),
    new Response(uploadProc.stderr).text(),
  ]);
  const uploadExit = await uploadProc.exited;
  if (uploadExit !== 0) {
    console.error(`Error: mc upload failed (exit ${uploadExit}): ${uploadErr.trim()}`);
    await unlink(localPath).catch(() => undefined);
    await pool.end();
    process.exit(1);
  }
  if (uploadOut.trim()) {
    console.log(uploadOut.trim());
  }

  // Clean up temp file
  await unlink(localPath).catch(() => undefined);

  // --- 4. Prune old backups from MinIO ---
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  console.log(`\nPruning backups older than ${retentionDays} days (before ${cutoff})...`);

  // List existing backups
  const listProc = Bun.spawn(
    ["mc", "ls", "--json", `${minioAlias}/${minioBucket}/credentials/`],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [listOut] = await Promise.all([
    new Response(listProc.stdout).text(),
    new Response(listProc.stderr).text(),
  ]);
  await listProc.exited;

  let prunedCount = 0;
  const lines = listOut.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    let entry: { lastModified?: string; key?: string } = {};
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.lastModified || !entry.key) continue;
    if (entry.lastModified < cutoff) {
      const oldPath = `${minioAlias}/${minioBucket}/credentials/${entry.key}`;
      const rmProc = Bun.spawn(["mc", "rm", oldPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const rmExit = await rmProc.exited;
      if (rmExit === 0) {
        console.log(`  Pruned: ${entry.key}`);
        prunedCount++;
      } else {
        const rmErr = await new Response(rmProc.stderr).text();
        console.warn(`  Warning: Failed to prune ${entry.key}: ${rmErr.trim()}`);
      }
    }
  }

  // --- Summary ---
  console.log("\n--- Summary ---");
  console.log(`  Credentials backed up: ${credentials.length}`);
  console.log(`  Backup file:           ${fileName}`);
  console.log(`  Remote path:           ${remotePath}`);
  console.log(`  Old backups pruned:    ${prunedCount}`);

  await pool.end();
}

run().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
