/** Environment-driven configuration for the scraper service */

export const config = {
  // Service identity
  SERVICE_ID: process.env.SERVICE_ID || "scraper-service",
  APP_PORT: Number(process.env.APP_PORT) || 3000,

  // Dapr
  DAPR_HOST: process.env.DAPR_HOST || "localhost",
  DAPR_HTTP_PORT: process.env.DAPR_HTTP_PORT || "3500",

  // MinIO S3
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://s3.k3s.bto.bar",
  MINIO_REGION: process.env.MINIO_REGION || "us-east-1",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "",
  MINIO_BUCKET: process.env.MINIO_BUCKET || "mesh-six-research",

  // LiteLLM (for accessibility tree parsing via Gemini)
  LITELLM_BASE_URL:
    process.env.LITELLM_BASE_URL || "http://litellm.litellm:4000/v1",
  LITELLM_API_KEY: process.env.LITELLM_API_KEY || "sk-local",
  LITELLM_MODEL: process.env.LITELLM_MODEL || "gemini-1.5-flash",

  // Playwright
  WINDSURF_APP_PATH:
    process.env.WINDSURF_APP_PATH ||
    "/Applications/Windsurf.app/Contents/MacOS/Electron",
  CHROME_PROFILE_DIR:
    process.env.CHROME_PROFILE_DIR ||
    `${process.env.HOME || "/Users/jay"}/.config/scraper-chrome-profile`,
  WINDSURF_WORKSPACE_BASE:
    process.env.WINDSURF_WORKSPACE_BASE ||
    `${process.env.HOME || "/Users/jay"}/scraper-workspaces`,

  // Dapr Workflow base URL on k3s (for raising external events)
  K3S_DAPR_URL:
    process.env.K3S_DAPR_URL || "http://localhost:3500",

  // OpenTelemetry
  OTEL_ENDPOINT:
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
} as const;
