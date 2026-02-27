/**
 * Research MinIO Helpers
 *
 * Extends the base MinIO module with research-specific operations
 * implementing the Claim Check pattern for the research sub-workflow.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import { uploadToMinio, downloadFromMinio } from "./minio.js";
import {
  ResearchStatusDocSchema,
  type ResearchStatusDoc,
  type ResearchStatus,
  RESEARCH_BUCKET,
  RESEARCH_STATUS_PREFIX,
  RESEARCH_RAW_PREFIX,
  RESEARCH_CLEAN_PREFIX,
} from "./research-types.js";

// ---------------------------------------------------------------------------
// Status document operations (Claim Check pattern)
// ---------------------------------------------------------------------------

/**
 * Write a research status document to MinIO.
 * Used by the researcher to track scraping job state.
 */
export async function writeResearchStatus(
  client: S3Client,
  bucket: string,
  taskId: string,
  status: ResearchStatus,
  extra?: Partial<ResearchStatusDoc>,
): Promise<string> {
  const key = `${RESEARCH_STATUS_PREFIX}/${taskId}/status.json`;
  const doc: ResearchStatusDoc = {
    taskId,
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  // Validate before writing
  ResearchStatusDocSchema.parse(doc);
  await uploadToMinio(client, bucket, key, JSON.stringify(doc), "application/json");
  return key;
}

/**
 * Read the current research status from MinIO.
 * Returns null if no status document exists.
 */
export async function readResearchStatus(
  client: S3Client,
  bucket: string,
  taskId: string,
): Promise<ResearchStatusDoc | null> {
  const key = `${RESEARCH_STATUS_PREFIX}/${taskId}/status.json`;
  try {
    const data = await downloadFromMinio(client, bucket, key);
    const json = JSON.parse(new TextDecoder().decode(data));
    return ResearchStatusDocSchema.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw research data operations
// ---------------------------------------------------------------------------

/**
 * Upload raw scraped content to MinIO.
 * Called by the scraper service or researcher actor.
 */
export async function uploadRawResearch(
  client: S3Client,
  bucket: string,
  taskId: string,
  content: string,
  filename = "raw-scraper-result.md",
): Promise<string> {
  const key = `${RESEARCH_RAW_PREFIX}/${taskId}/${filename}`;
  await uploadToMinio(client, bucket, key, content, "text/markdown");
  return key;
}

/**
 * Download raw research content from MinIO.
 */
export async function downloadRawResearch(
  client: S3Client,
  bucket: string,
  rawMinioKey: string,
): Promise<string> {
  const data = await downloadFromMinio(client, bucket, rawMinioKey);
  return new TextDecoder().decode(data);
}

// ---------------------------------------------------------------------------
// Clean research document operations
// ---------------------------------------------------------------------------

/**
 * Upload validated and formatted research content.
 * Called by the researcher after review/validation.
 */
export async function uploadCleanResearch(
  client: S3Client,
  bucket: string,
  taskId: string,
  content: string,
  filename = "clean-research.md",
): Promise<string> {
  const key = `${RESEARCH_CLEAN_PREFIX}/${taskId}/${filename}`;
  await uploadToMinio(client, bucket, key, content, "text/markdown");
  return key;
}

/**
 * Download clean research content from MinIO.
 */
export async function downloadCleanResearch(
  client: S3Client,
  bucket: string,
  cleanMinioKey: string,
): Promise<string> {
  const data = await downloadFromMinio(client, bucket, cleanMinioKey);
  return new TextDecoder().decode(data);
}

// ---------------------------------------------------------------------------
// Convenience: build default bucket config from env
// ---------------------------------------------------------------------------

export function getResearchBucket(): string {
  return process.env.RESEARCH_BUCKET || RESEARCH_BUCKET;
}
