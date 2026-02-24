import { LLM_ACTOR_TYPE } from "@mesh-six/core";

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

export const AGENT_ID = process.env.AGENT_ID || "llm-service";
export const APP_PORT = Number(process.env.APP_PORT) || 3000;
export const DAPR_HOST = process.env.DAPR_HOST || "127.0.0.1";
export const DAPR_HTTP_PORT = Number(process.env.DAPR_HTTP_PORT) || 3500;

// MinIO / S3-compatible storage for credentials and configs
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://minio.minio:9000";
export const MINIO_REGION = process.env.MINIO_REGION || "us-east-1";
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
export const MINIO_BUCKET = process.env.MINIO_BUCKET || "llm-service";

// Actor configuration
export const MAX_ACTORS = Number(process.env.MAX_ACTORS) || 3;
export const ACTOR_IDLE_TIMEOUT = process.env.ACTOR_IDLE_TIMEOUT || "30m";
export const CREDENTIAL_SYNC_INTERVAL = process.env.CREDENTIAL_SYNC_INTERVAL || "5m";
export const ACTOR_TYPE = LLM_ACTOR_TYPE;

// Default model if not specified in request
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-20250514";

// Allowed models — comma-separated list, overridden by Dapr config at runtime
export const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || "claude-sonnet-4-20250514,claude-opus-4-20250514,claude-haiku-4-5-20251001")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Claude CLI binary path
export const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || "claude";

// Base directory for per-actor config directories
export const ACTOR_CONFIG_BASE = process.env.ACTOR_CONFIG_BASE || "/tmp/llm-service/actors";

// Hook event publisher script path (baked into Docker image)
export const HOOK_SCRIPT_PATH = process.env.HOOK_SCRIPT_PATH || "/app/apps/llm-service/src/hooks/event-publisher.ts";

// ============================================================================
// DAPR ACTOR CONFIG RESPONSE
// ============================================================================

/** Returned by GET /dapr/config to register actor types with the sidecar */
export const DAPR_ACTOR_CONFIG = {
  entities: [ACTOR_TYPE],
  actorIdleTimeout: ACTOR_IDLE_TIMEOUT,
  drainOngoingCallTimeout: "60s",
  drainRebalancedActors: true,
  reentrancy: { enabled: false },
  remindersStoragePartitions: 1,
};
