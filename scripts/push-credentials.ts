#!/usr/bin/env bun
/**
 * Push Credentials CLI
 *
 * Reads local ~/.claude/.credentials.json (and optionally ~/.claude.json,
 * ~/.claude/settings.json) and pushes them to the mesh-six auth-service.
 *
 * Usage:
 *   bun run scripts/push-credentials.ts [options]
 *
 * Options:
 *   -p, --project <id>     Project ID (default: AUTH_PROJECT_ID env var)
 *   -u, --url <url>        Auth-service URL (default: AUTH_SERVICE_URL env var)
 *   -k, --api-key <key>    API key (default: AUTH_API_KEY env var)
 *   -h, --help             Show this help
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string", short: "p" },
    url: { type: "string", short: "u" },
    "api-key": { type: "string", short: "k" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: bun run scripts/push-credentials.ts [options]

Options:
  -p, --project <id>     Project ID (default: AUTH_PROJECT_ID env var)
  -u, --url <url>        Auth-service URL (default: AUTH_SERVICE_URL env var)
  -k, --api-key <key>    API key (default: AUTH_API_KEY env var)
  -h, --help             Show this help

Environment variables:
  AUTH_PROJECT_ID        Project ID
  AUTH_SERVICE_URL       Auth-service base URL (e.g. http://auth-service:3000)
  AUTH_API_KEY           API key for auth-service requests
`);
  process.exit(0);
}

const projectId = values.project || process.env.AUTH_PROJECT_ID;
const authServiceUrl = values.url || process.env.AUTH_SERVICE_URL;
const apiKey = values["api-key"] || process.env.AUTH_API_KEY;

if (!projectId) {
  console.error("Error: --project or AUTH_PROJECT_ID required");
  process.exit(1);
}
if (!authServiceUrl) {
  console.error("Error: --url or AUTH_SERVICE_URL required");
  process.exit(1);
}
if (!apiKey) {
  console.error("Error: --api-key or AUTH_API_KEY required");
  process.exit(1);
}

const HOME = process.env.HOME || "";
const credentialsPath = join(HOME, ".claude", ".credentials.json");

if (!existsSync(credentialsPath)) {
  console.error(`Error: No credentials file found at ${credentialsPath}`);
  console.error("Run 'claude auth login' first to authenticate.");
  process.exit(1);
}

let creds: Record<string, unknown>;
try {
  creds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
} catch (e) {
  console.error(`Error: Failed to parse ${credentialsPath}:`, e);
  process.exit(1);
}

const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
if (!oauth?.accessToken) {
  console.error("Error: No accessToken found in credentials file");
  process.exit(1);
}

const expiresAt = oauth.expiresAt as number | string | undefined;
if (expiresAt) {
  const expMs = typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();
  if (expMs < Date.now()) {
    console.warn(
      "Warning: These credentials are already expired. " +
      "Pushing anyway — auth-service may be able to refresh them."
    );
  }
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${apiKey}`,
  "X-Pushed-By": process.env.USER || "unknown",
};

// Ensure the project exists (create if needed)
const projectUrl = `${authServiceUrl}/projects/${projectId}`;
const checkResp = await fetch(projectUrl, { headers });

if (checkResp.status === 404) {
  console.log(`Project "${projectId}" not found, creating...`);
  const createResp = await fetch(`${authServiceUrl}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: projectId, displayName: projectId }),
  });
  if (!createResp.ok) {
    console.error(`Error: Failed to create project: ${createResp.status} ${await createResp.text()}`);
    process.exit(1);
  }
  console.log(`Project "${projectId}" created.`);
} else if (!checkResp.ok) {
  console.error(`Error: Failed to check project: ${checkResp.status} ${await checkResp.text()}`);
  process.exit(1);
}

// Normalize expiresAt to ISO string for auth-service (Zod expects datetime string)
const expiresAtIso = expiresAt
  ? (typeof expiresAt === "number"
    ? new Date(expiresAt).toISOString()
    : new Date(expiresAt).toISOString())
  : new Date(Date.now() + 3600000).toISOString(); // fallback: 1h from now

// Push credentials
const pushUrl = `${authServiceUrl}/projects/${projectId}/credentials`;
const response = await fetch(pushUrl, {
  method: "POST",
  headers,
  body: JSON.stringify({
    accessToken: oauth.accessToken as string,
    refreshToken: (oauth.refreshToken as string) || undefined,
    expiresAt: expiresAtIso,
    accountUuid: (oauth.accountUuid as string) || undefined,
    emailAddress: (oauth.emailAddress as string) || undefined,
    organizationUuid: (oauth.organizationUuid as string) || undefined,
    billingType: (oauth.billingType as string) || undefined,
    displayName: (oauth.displayName as string) || undefined,
    scopes: (oauth.scopes as string[]) || undefined,
    subscriptionType: (oauth.subscriptionType as string) || undefined,
    rateLimitTier: (oauth.rateLimitTier as string) || undefined,
  }),
});

if (!response.ok) {
  console.error(`Error: Push failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const result = await response.json() as Record<string, unknown>;
console.log("Credentials pushed successfully.");
console.log(`  Credential ID: ${result.id}`);
console.log(`  Expires at:    ${result.expiresAt}`);

const expiresAtMs = new Date(result.expiresAt as string).getTime();
if (expiresAtMs > Date.now()) {
  const hoursLeft = ((expiresAtMs - Date.now()) / 3600000).toFixed(1);
  console.log(`  Time remaining: ${hoursLeft}h`);
}

// Push config files (.claude.json, settings.json) to update project
const claudeJsonPath = join(HOME, ".claude.json");
const settingsPath = join(HOME, ".claude", "settings.json");
const projectUpdateBody: Record<string, unknown> = {};

if (existsSync(claudeJsonPath)) {
  projectUpdateBody.claudeJson = readFileSync(claudeJsonPath, "utf-8");
}
if (existsSync(settingsPath)) {
  projectUpdateBody.settingsJson = readFileSync(settingsPath, "utf-8");
}

// Extract account metadata from .claude.json oauthAccount
if (existsSync(claudeJsonPath)) {
  try {
    const claudeJsonData = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    const account = claudeJsonData.oauthAccount as Record<string, unknown> | undefined;
    if (account) {
      if (account.accountUuid) projectUpdateBody.claudeAccountUuid = account.accountUuid;
      if (account.organizationUuid) projectUpdateBody.claudeOrgUuid = account.organizationUuid;
      if (account.emailAddress) projectUpdateBody.claudeEmail = account.emailAddress;
    }
  } catch {
    // Ignore parse errors
  }
}

if (Object.keys(projectUpdateBody).length > 0) {
  const updateResp = await fetch(projectUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(projectUpdateBody),
  });
  if (updateResp.ok) {
    const pushed: string[] = [];
    if (projectUpdateBody.claudeJson) pushed.push(".claude.json");
    if (projectUpdateBody.settingsJson) pushed.push("settings.json");
    if (projectUpdateBody.claudeAccountUuid) pushed.push("account metadata");
    if (pushed.length > 0) {
      console.log(`  Config files pushed: ${pushed.join(", ")}`);
    }
  } else {
    console.warn(`  Warning: Failed to push config files: ${updateResp.status}`);
  }
}
