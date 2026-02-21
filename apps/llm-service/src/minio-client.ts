import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import {
  MINIO_ENDPOINT,
  MINIO_REGION,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
  AGENT_ID,
} from "./config.js";

const log = (msg: string) => console.log(`[${AGENT_ID}][minio] ${msg}`);

let s3: S3Client | null = null;

function getClient(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: MINIO_REGION,
      forcePathStyle: true, // Required for MinIO
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
    });
  }
  return s3;
}

/**
 * List available credential archives in the MinIO bucket.
 * Returns keys like "creds/0.tar.gz", "creds/1.tar.gz", etc.
 */
export async function listCredentials(
  prefix = "creds/",
): Promise<string[]> {
  const client = getClient();
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: prefix,
    }),
  );

  return (response.Contents || [])
    .map((obj) => obj.Key!)
    .filter((key) => key.endsWith(".tar.gz"));
}

/**
 * Download a tar.gz archive from MinIO and extract it to a target directory.
 * Used for credentials, configs, skills, and session data.
 */
export async function downloadAndExtract(
  key: string,
  targetDir: string,
  bucket?: string,
): Promise<void> {
  const client = getClient();

  // Ensure target directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket || MINIO_BUCKET,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error(`Empty response body for key: ${key}`);
  }

  // Stream the tar.gz content to Bun.spawn for extraction
  const bodyBytes = await response.Body.transformToByteArray();

  const proc = Bun.spawn(["tar", "xzf", "-", "-C", targetDir], {
    stdin: new Blob([bodyBytes]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed (exit ${exitCode}): ${stderr}`);
  }

  log(`Extracted ${key} → ${targetDir}`);
}

/**
 * Create a tar.gz archive from a source directory and upload to MinIO.
 * Used to sync credentials/configs back to MinIO.
 */
export async function archiveAndUpload(
  sourceDir: string,
  key: string,
): Promise<void> {
  const client = getClient();

  // Create tar.gz of the source directory
  const proc = Bun.spawn(["tar", "czf", "-", "-C", sourceDir, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar archival failed (exit ${exitCode}): ${stderr}`);
  }

  await client.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      Body: new Uint8Array(stdout),
      ContentType: "application/gzip",
    }),
  );

  log(`Uploaded ${sourceDir} → ${key}`);
}

/**
 * Download a specific actor's config archive (skills, settings, MCP config).
 */
export async function downloadActorConfig(
  actorId: string,
  targetDir: string,
  configPath?: string,
): Promise<void> {
  const key = configPath || `configs/${actorId}/config.tar.gz`;

  try {
    await downloadAndExtract(key, targetDir);
  } catch (err) {
    log(`No config found for actor ${actorId} at ${key}: ${err}`);
    // Not fatal — actor can run without custom config
  }
}

/**
 * Download a session's JSONL data for resumption.
 */
export async function downloadSession(
  sessionId: string,
  targetDir: string,
): Promise<boolean> {
  const key = `sessions/${sessionId}.tar.gz`;

  try {
    await downloadAndExtract(key, targetDir);
    log(`Restored session ${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload a session's data for persistence.
 */
export async function uploadSession(
  sessionId: string,
  sourceDir: string,
): Promise<void> {
  const key = `sessions/${sessionId}.tar.gz`;
  await archiveAndUpload(sourceDir, key);
}

/**
 * Clean up a local directory (used during actor deactivation).
 */
export function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log(`Cleaned up ${dir}`);
  }
}

/**
 * List available actor config archives.
 */
export async function listActorConfigs(): Promise<string[]> {
  const client = getClient();
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: "configs/",
    }),
  );

  return (response.Contents || [])
    .map((obj) => obj.Key!)
    .filter((key) => key.endsWith(".tar.gz"));
}
