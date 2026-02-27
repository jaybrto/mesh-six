export const APP_PORT = Number(process.env.APP_PORT || "3000");
export const DAPR_HOST = process.env.DAPR_HOST || "127.0.0.1";
export const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

export const AGENT_ID = process.env.AGENT_ID || "onboarding-service";
export const AGENT_NAME = process.env.AGENT_NAME || "Onboarding Service";

export const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.PG_USER || "mesh_six"}:${process.env.PG_PASSWORD || ""}@${process.env.PG_HOST || "pgsql.k3s.bto.bar"}:${process.env.PG_PORT || "5432"}/${process.env.PG_DATABASE || "mesh_six"}`;

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const LITELLM_URL = process.env.LITELLM_URL || "http://litellm.k3s.bto.bar";
export const LITELLM_ADMIN_KEY = process.env.LITELLM_ADMIN_KEY || "";
export const VAULT_ADDR = process.env.VAULT_ADDR || "http://vault.vault.svc.cluster.local:8200";
export const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.default.svc.cluster.local:9000";
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
export const MINIO_BUCKET = process.env.MINIO_BUCKET || "mesh-six-recordings";
