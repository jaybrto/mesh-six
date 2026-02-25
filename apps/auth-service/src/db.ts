import pg from "pg";
import { DATABASE_URL } from "./config.js";

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
});

/** Verify DB connectivity — used in /healthz */
export async function checkDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}
