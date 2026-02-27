import pg from "pg";
import { createMinioClient, uploadToMinio } from "@mesh-six/core";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
} from "../config.js";

export interface ProvisionBackendInput {
  repoOwner: string;
  repoName: string;
}

export async function provisionBackend(
  pool: pg.Pool,
  input: ProvisionBackendInput
): Promise<void> {
  const { repoOwner, repoName } = input;

  // Verify PostgreSQL connectivity
  await pool.query("SELECT 1");

  // Create MinIO prefix marker so the repo's storage prefix is initialized
  const minioClient = createMinioClient({
    endpoint: MINIO_ENDPOINT,
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
    bucket: MINIO_BUCKET,
  });

  const prefixKey = `repos/${repoOwner}/${repoName}/.keep`;
  await uploadToMinio(
    minioClient,
    MINIO_BUCKET,
    prefixKey,
    "",
    "application/octet-stream"
  );
}
