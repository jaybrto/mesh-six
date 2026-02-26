import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface MinioConfig {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createMinioClient(config: MinioConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function uploadToMinio(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | Buffer | string,
  contentType = "application/octet-stream",
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );
}

export async function downloadFromMinio(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Empty response body for key: ${key}`);
  }
  return response.Body.transformToByteArray();
}

export async function getPresignedUrl(
  client: S3Client,
  bucket: string,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  // Type cast needed: @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner may
  // resolve different patch versions of @smithy/types causing structural
  // incompatibility at the type level despite being identical at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSignedUrl(client as any, command as any, { expiresIn });
}
