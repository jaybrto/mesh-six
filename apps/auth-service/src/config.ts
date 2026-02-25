import { DAPR_PUBSUB_NAME as CORE_PUBSUB_NAME } from "@mesh-six/core";

export const APP_PORT = Number(process.env.APP_PORT) || 3000;
export const DAPR_HOST = process.env.DAPR_HOST || "127.0.0.1";
export const DAPR_HTTP_PORT = Number(process.env.DAPR_HTTP_PORT) || 3500;
export const DATABASE_URL = process.env.DATABASE_URL || "";

// Claude OAuth endpoints (kept configurable for testing)
export const CLAUDE_OAUTH_TOKEN_URL =
  process.env.CLAUDE_OAUTH_TOKEN_URL ||
  "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID =
  process.env.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Timer intervals
export const REFRESH_CHECK_INTERVAL_MS =
  Number(process.env.REFRESH_CHECK_INTERVAL_MS) || 30 * 60_000; // 30 minutes
export const CREDENTIAL_REFRESH_THRESHOLD_MS =
  Number(process.env.CREDENTIAL_REFRESH_THRESHOLD_MS) || 60 * 60_000; // 60 minutes

export const DAPR_PUBSUB_NAME = CORE_PUBSUB_NAME;
