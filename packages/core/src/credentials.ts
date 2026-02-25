/**
 * Credential utilities for Claude CLI authentication.
 *
 * Pure functions for building credential files, checking expiry,
 * and syncing ephemeral config directories. No network or storage
 * dependencies — those belong in auth-service.
 *
 * Ported from GWA src/lib/credentials-manager.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DEFAULT_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check whether stored Claude OAuth credentials are expired or near expiry.
 * Returns true if file is missing, unparseable, or expires within buffer.
 */
export function isCredentialExpired(
  credentialsPath: string,
  bufferMs: number = DEFAULT_EXPIRY_BUFFER_MS
): boolean {
  if (!existsSync(credentialsPath)) return true;
  try {
    const raw = readFileSync(credentialsPath, "utf-8");
    const creds = JSON.parse(raw);
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (!expiresAt || typeof expiresAt !== "number") return true;
    return expiresAt < Date.now() + bufferMs;
  } catch {
    return true;
  }
}

/**
 * Sync ~/.config/claude/config.json from ~/.claude/.credentials.json.
 * Called on pod start since ~/.config/claude/ is ephemeral in k8s.
 */
export function syncEphemeralConfig(claudeDir: string, configDir: string): void {
  const credPath = join(claudeDir, ".credentials.json");
  if (!existsSync(credPath)) return;

  try {
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    const accessToken = creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (!accessToken) return;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), buildConfigJson(accessToken));
  } catch {
    // Swallow — don't block startup
  }
}

/**
 * Build .claude/.credentials.json content from credential fields.
 */
export function buildCredentialsJson(opts: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  billingType?: string;
  displayName?: string;
}): string {
  return JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: opts.accessToken,
        refreshToken: opts.refreshToken,
        expiresAt: opts.expiresAt,
        accountUuid: opts.accountUuid,
        emailAddress: opts.emailAddress,
        organizationUuid: opts.organizationUuid,
        billingType: opts.billingType ?? "stripe_subscription",
        displayName: opts.displayName ?? "mesh-six",
      },
    },
    null,
    2
  );
}

/**
 * Build .config/claude/config.json content.
 */
export function buildConfigJson(oauthToken: string): string {
  return JSON.stringify({ oauthToken }, null, 2);
}

/**
 * Build .claude/settings.json content.
 * Returns custom settings if provided, otherwise headless defaults.
 */
export function buildSettingsJson(customSettings?: string): string {
  if (customSettings) return customSettings;
  return JSON.stringify(
    {
      skipDangerousModePermissionPrompt: true,
      theme: "dark",
      hasCompletedOnboarding: true,
    },
    null,
    2
  );
}

/**
 * Build .claude.json (account metadata) content.
 */
export function buildClaudeJson(
  customClaudeJson?: string,
  opts?: {
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    billingType?: string;
    displayName?: string;
  }
): string {
  if (customClaudeJson) return customClaudeJson;
  return JSON.stringify(
    {
      hasCompletedOnboarding: true,
      theme: "dark-ansi",
      preferredNotifChannel: "notifications_disabled",
      fileCheckpointingEnabled: false,
      ...(opts?.accountUuid && {
        oauthAccount: {
          accountUuid: opts.accountUuid,
          emailAddress: opts.emailAddress,
          organizationUuid: opts.organizationUuid,
          hasExtraUsageEnabled: true,
          billingType: opts.billingType ?? "stripe_subscription",
          displayName: opts.displayName ?? "mesh-six",
        },
      }),
    },
    null,
    2
  );
}
