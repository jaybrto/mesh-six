import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// AUTH FAILURE DETECTION
// ============================================================================

/** Patterns that indicate Claude is stuck on the authentication/login screen */
const AUTH_FAILURE_PATTERNS = [
  "choose how to authenticate",
  "sign in at",
  "/oauth/authorize",
  "enter api key",
  "login required",
  "not authenticated",
  "authentication required",
  "authenticate with",
  "sign in to",
  "oauth.anthropic.com",
  "anthropic login",
  "max plan",
  "usage limit",
  "you need to login",
  "please authenticate",
];

/**
 * Error thrown when Claude Code is stuck on the auth/login screen.
 */
export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

/**
 * Check if output text contains patterns indicating Claude is stuck
 * on the login/authentication screen.
 */
export function detectAuthFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Pre-flight check: verify Claude auth environment variables are configured.
 * Does NOT make API calls — just checks env vars exist.
 */
export function checkAuthEnvironment(): { ok: boolean; error?: string } {
  const hasOAuth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  if (!hasOAuth && !hasApiKey) {
    return {
      ok: false,
      error: "Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set",
    };
  }

  return { ok: true };
}

// ============================================================================
// CONFIG PRE-LOADING
// ============================================================================

/**
 * Pre-load Claude Code CLI configuration to prevent first-run interactive dialogs.
 * Writes credentials and settings files so Claude starts without prompting.
 *
 * Safe to call multiple times — merges into existing settings and only
 * writes credentials if the env var is set and file doesn't exist.
 *
 * Call this BEFORE launching `claude` or `claude --dangerously-skip-permissions`.
 */
export function preloadClaudeConfig(): void {
  const home = process.env.HOME;
  if (!home) {
    console.warn("[claude] HOME not set, skipping config pre-load");
    return;
  }

  const claudeDir = join(home, ".claude");

  // Ensure ~/.claude/ exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // 1. Write credentials + account info from env vars
  const credentialsPath = join(claudeDir, ".credentials.json");
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (oauthToken) {
    let existingCreds: Record<string, unknown> = {};
    if (existsSync(credentialsPath)) {
      try {
        existingCreds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
      } catch {
        // Corrupted file, overwrite
      }
    }

    let credsChanged = false;

    // Set/update OAuth token
    if (existingCreds.oauthToken !== oauthToken) {
      existingCreds.oauthToken = oauthToken;
      credsChanged = true;
    }

    // Set oauthAccount from env vars (prevents account selection dialog)
    const accountUuid = process.env.CLAUDE_OAUTH_ACCOUNT_UUID;
    if (accountUuid && !existingCreds.oauthAccount) {
      existingCreds.oauthAccount = {
        accountUuid,
        emailAddress: process.env.CLAUDE_OAUTH_EMAIL || "",
        organizationUuid: process.env.CLAUDE_OAUTH_ORG_UUID || "",
        hasExtraUsageEnabled: process.env.CLAUDE_OAUTH_EXTRA_USAGE !== "false",
        billingType:
          process.env.CLAUDE_OAUTH_BILLING_TYPE || "stripe_subscription",
        displayName: process.env.CLAUDE_OAUTH_DISPLAY_NAME || "mesh-six",
      };
      credsChanged = true;
    }

    if (credsChanged) {
      writeFileSync(
        credentialsPath,
        JSON.stringify(existingCreds, null, 2),
        { mode: 0o600 },
      );
      console.log("[claude] Wrote credentials file", credentialsPath);
    }
  }

  // 2. Merge headless settings into settings.json
  const settingsPath = join(claudeDir, "settings.json");
  const headlessSettings: Record<string, unknown> = {
    skipDangerousModePermissionPrompt: true,
    theme: "dark",
    hasCompletedOnboarding: true,
  };

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.warn("[claude] Failed to parse existing settings.json, overwriting");
    }
  }

  let needsWrite = false;
  for (const [key, value] of Object.entries(headlessSettings)) {
    if (!(key in existing)) {
      existing[key] = value;
      needsWrite = true;
    }
  }

  if (needsWrite) {
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), {
      mode: 0o600,
    });
    console.log("[claude] Updated settings.json with headless defaults", settingsPath);
  }
}
