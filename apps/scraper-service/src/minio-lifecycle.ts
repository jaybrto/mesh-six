/**
 * MinIO Claim Check lifecycle management.
 *
 * Every scrape job tracks status via a `status.json` file in MinIO.
 * The ResearcherActor creates the initial PENDING status; this module
 * transitions it through IN_PROGRESS → COMPLETED | FAILED.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import {
  uploadToMinio,
  downloadFromMinio,
  type ScrapeStatus,
  type ScrapeStatusFile,
  type ScrapeProvider,
} from "@mesh-six/core";

const STATUS_FILE = "status.json";
const RESULT_FILE = "result.md";

export async function readStatusFile(
  client: S3Client,
  bucket: string,
  folderPath: string,
): Promise<ScrapeStatusFile | null> {
  try {
    const data = await downloadFromMinio(client, bucket, `${folderPath}/${STATUS_FILE}`);
    return JSON.parse(new TextDecoder().decode(data)) as ScrapeStatusFile;
  } catch {
    return null;
  }
}

export async function writeStatusFile(
  client: S3Client,
  bucket: string,
  folderPath: string,
  status: ScrapeStatusFile,
): Promise<void> {
  await uploadToMinio(
    client,
    bucket,
    `${folderPath}/${STATUS_FILE}`,
    JSON.stringify(status, null, 2),
    "application/json",
  );
}

export async function markInProgress(
  client: S3Client,
  bucket: string,
  folderPath: string,
  taskId: string,
  provider: ScrapeProvider,
): Promise<void> {
  const status: ScrapeStatusFile = {
    taskId,
    status: "IN_PROGRESS",
    provider,
    startedAt: new Date().toISOString(),
  };
  await writeStatusFile(client, bucket, folderPath, status);
  console.log(`[minio] ${folderPath}/status.json → IN_PROGRESS`);
}

export async function markCompleted(
  client: S3Client,
  bucket: string,
  folderPath: string,
  taskId: string,
  provider: ScrapeProvider,
): Promise<void> {
  const status: ScrapeStatusFile = {
    taskId,
    status: "COMPLETED",
    provider,
    completedAt: new Date().toISOString(),
  };
  await writeStatusFile(client, bucket, folderPath, status);
  console.log(`[minio] ${folderPath}/status.json → COMPLETED`);
}

export async function markFailed(
  client: S3Client,
  bucket: string,
  folderPath: string,
  taskId: string,
  provider: ScrapeProvider,
  error: string,
): Promise<void> {
  const status: ScrapeStatusFile = {
    taskId,
    status: "FAILED",
    provider,
    completedAt: new Date().toISOString(),
    error,
  };
  await writeStatusFile(client, bucket, folderPath, status);
  console.log(`[minio] ${folderPath}/status.json → FAILED: ${error}`);
}

export async function uploadResult(
  client: S3Client,
  bucket: string,
  folderPath: string,
  markdown: string,
): Promise<string> {
  const key = `${folderPath}/${RESULT_FILE}`;
  await uploadToMinio(client, bucket, key, markdown, "text/markdown");
  console.log(`[minio] Uploaded result to ${key} (${markdown.length} bytes)`);
  return key;
}
