import type { S3Client } from "@aws-sdk/client-s3";
import {
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { uploadToMinio, downloadFromMinio } from "./minio.js";
import { RESEARCH_MINIO_BUCKET } from "./research-types.js";

// ---------------------------------------------------------------------------
// Research-specific MinIO helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the research bucket exists (fixes M1 — no bucket auto-creation).
 * Safe to call repeatedly; silently succeeds if bucket already exists.
 */
export async function ensureResearchBucket(client: S3Client, bucket = RESEARCH_MINIO_BUCKET): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

// ---------------------------------------------------------------------------
// Status document (claim-check pattern)
// ---------------------------------------------------------------------------

export interface ResearchStatusDoc {
  taskId: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  startedAt?: string;
  completedAt?: string;
  minioKey?: string;
  error?: string;
}

/** Build the canonical status doc key for a task */
export function statusDocKey(taskId: string): string {
  return `research/status/${taskId}/status.json`;
}

/** Write a status document to MinIO */
export async function writeResearchStatus(
  client: S3Client,
  bucket: string,
  taskId: string,
  doc: ResearchStatusDoc,
): Promise<string> {
  const key = statusDocKey(taskId);
  await uploadToMinio(client, bucket, key, JSON.stringify(doc), "application/json");
  return key;
}

/** Read a status document from MinIO */
export async function readResearchStatus(
  client: S3Client,
  bucket: string,
  taskId: string,
): Promise<ResearchStatusDoc | null> {
  try {
    const data = await downloadFromMinio(client, bucket, statusDocKey(taskId));
    return JSON.parse(new TextDecoder().decode(data)) as ResearchStatusDoc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw research documents
// ---------------------------------------------------------------------------

/** Build the canonical raw research key for a task */
export function rawResearchKey(taskId: string): string {
  return `research/raw/${taskId}/raw-scraper-result.md`;
}

/** Upload raw scraped research */
export async function uploadRawResearch(
  client: S3Client,
  bucket: string,
  taskId: string,
  content: string,
): Promise<string> {
  const key = rawResearchKey(taskId);
  await uploadToMinio(client, bucket, key, content, "text/markdown");
  return key;
}

/** Download raw scraped research */
export async function downloadRawResearch(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const data = await downloadFromMinio(client, bucket, key);
  return new TextDecoder().decode(data);
}

// ---------------------------------------------------------------------------
// Clean (reviewed) research documents
// ---------------------------------------------------------------------------

/** Build the canonical clean research key for a task */
export function cleanResearchKey(taskId: string): string {
  return `research/clean/${taskId}/clean-research.md`;
}

/** Upload validated/formatted research */
export async function uploadCleanResearch(
  client: S3Client,
  bucket: string,
  taskId: string,
  content: string,
): Promise<string> {
  const key = cleanResearchKey(taskId);
  await uploadToMinio(client, bucket, key, content, "text/markdown");
  return key;
}

/** Download validated/formatted research (fixes H1 — use this for clean docs) */
export async function downloadCleanResearch(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const data = await downloadFromMinio(client, bucket, key);
  return new TextDecoder().decode(data);
}
