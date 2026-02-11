#!/usr/bin/env bun
/**
 * Database Migration Runner
 *
 * Reads SQL files from migrations/ directory and applies them in order.
 * Tracks applied migrations in a _migrations table.
 */

import { Pool } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const ENV_FILE = join(process.cwd(), ".env");

// Load .env file if DATABASE_URL not already set
async function loadEnv() {
  if (process.env.DATABASE_URL) return;

  try {
    const envFile = Bun.file(ENV_FILE);
    if (!(await envFile.exists())) return;

    const envContent = await envFile.text();
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error("Failed to load .env:", e);
  }
}

async function migrate() {
  await loadEnv();

  const databaseUrl = process.env.DATABASE_URL || process.env.PG_PRIMARY_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL or PG_PRIMARY_URL environment variable is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Get applied migrations
    const { rows: applied } = await pool.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY id"
    );
    const appliedSet = new Set(applied.map((m) => m.name));

    // Get migration files
    const files = await readdir(MIGRATIONS_DIR);
    const migrations = files.filter((f) => f.endsWith(".sql")).sort();

    if (migrations.length === 0) {
      console.log("No migrations found");
      await pool.end();
      return;
    }

    // Apply pending migrations
    let appliedCount = 0;
    for (const migration of migrations) {
      if (appliedSet.has(migration)) {
        console.log(`✓ ${migration} (already applied)`);
        continue;
      }

      const filePath = join(MIGRATIONS_DIR, migration);
      const content = await readFile(filePath, "utf-8");

      console.log(`→ Applying ${migration}...`);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Execute migration
        await client.query(content);

        // Record migration
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          migration,
        ]);

        await client.query("COMMIT");
        console.log(`✓ ${migration} applied`);
        appliedCount++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      console.log("\nAll migrations already applied");
    } else {
      console.log(`\n${appliedCount} migration(s) applied successfully`);
    }
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
