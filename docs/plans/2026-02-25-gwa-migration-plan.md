# GWA → Mesh-Six Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge github-workflow-agents (GWA) credential management, dialog handling, and implementation agent into mesh-six.

**Architecture:** Auth-service as a Hono+Dapr microservice backed by PostgreSQL. Core library gains credential utilities and dialog handler. LLM service drops GWA dependency. Implementer agent runs as StatefulSet with tmux. PR agent handles PR creation and code review.

**Tech Stack:** Bun, Hono, Dapr, PostgreSQL, Zod, tmux (implementer only)

**Design Doc:** `docs/plans/2026-02-25-gwa-migration-design.md`

**GWA Source Reference:** `/Users/jay.barreto/dev/util/bto/github-workflow-agents/`

---

## Phase 1 — Foundation (auth-service + core enhancements)

Phase 1 has no external dependencies. Tasks 1-6 (core library) can run in parallel. Tasks 7-14 (auth-service) depend on Tasks 1-6. Task 15 (CI) depends on Task 13.

### Task 1: Database migration for auth tables

**Files:**
- Create: `migrations/006_auth_tables.sql`

**Step 1: Write the migration**

Follow the pattern from `migrations/005_context_compression_log.sql`. Use TIMESTAMPTZ (not INTEGER) for timestamps, gen_random_uuid() for IDs, and proper CHECK constraints.

```sql
-- Migration: 006_auth_tables
-- Auth service tables for credential lifecycle management

CREATE TABLE auth_projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    claude_account_uuid TEXT,
    claude_org_uuid TEXT,
    claude_email TEXT,
    settings_json TEXT,
    claude_json TEXT,
    mcp_json TEXT,
    claude_md TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth_credentials (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    account_uuid TEXT,
    email_address TEXT,
    organization_uuid TEXT,
    billing_type TEXT DEFAULT 'stripe_subscription',
    display_name TEXT DEFAULT 'mesh-six',
    scopes JSONB,
    subscription_type TEXT,
    rate_limit_tier TEXT,
    source TEXT NOT NULL CHECK (source IN ('push', 'refresh', 'import')),
    pushed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at TIMESTAMPTZ
);

CREATE INDEX idx_auth_credentials_project_active
    ON auth_credentials(project_id)
    WHERE invalidated_at IS NULL;

CREATE INDEX idx_auth_credentials_expiry
    ON auth_credentials(expires_at)
    WHERE invalidated_at IS NULL;

CREATE TABLE auth_bundles (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    bundle_data BYTEA NOT NULL,
    config_hash TEXT NOT NULL,
    credential_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ
);

CREATE INDEX idx_auth_bundles_project_active
    ON auth_bundles(project_id)
    WHERE expired_at IS NULL;
```

**Step 2: Run the migration**

```bash
DATABASE_URL=postgres://mesh_six:password@pgsql.k3s.bto.bar:5432/mesh_six bun run db:migrate
```

Expected: `Migration 006_auth_tables applied`

**Step 3: Commit**

```bash
git add migrations/006_auth_tables.sql
git commit -m "add auth tables migration for credential lifecycle management"
```

---

### Task 2: Core auth and session types

**Files:**
- Modify: `packages/core/src/types.ts` (append new schemas)
- Test: `packages/core/src/types.test.ts` (add validation tests)

**Step 1: Write failing tests for new schemas**

Add to the existing test file (or create if needed). Tests verify Zod parse/reject behavior.

```typescript
import { describe, it, expect } from "bun:test";
import {
  ProjectConfigSchema,
  CredentialPushRequestSchema,
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  CredentialHealthSchema,
  ImplementationSessionSchema,
} from "./types.js";

describe("Auth types", () => {
  it("parses valid ProjectConfig", () => {
    const result = ProjectConfigSchema.parse({
      id: "mesh-six",
      displayName: "Mesh Six",
      createdAt: "2026-02-25T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    });
    expect(result.id).toBe("mesh-six");
  });

  it("rejects ProjectConfig missing required fields", () => {
    expect(() => ProjectConfigSchema.parse({ id: "x" })).toThrow();
  });

  it("parses valid CredentialPushRequest", () => {
    const result = CredentialPushRequestSchema.parse({
      accessToken: "sk-ant-test",
      expiresAt: "2026-03-01T00:00:00Z",
    });
    expect(result.accessToken).toBe("sk-ant-test");
  });

  it("rejects CredentialPushRequest without accessToken", () => {
    expect(() =>
      CredentialPushRequestSchema.parse({ expiresAt: "2026-03-01T00:00:00Z" })
    ).toThrow();
  });

  it("parses ProvisionResponse with all statuses", () => {
    for (const status of ["current", "provisioned", "no_credentials"]) {
      const result = ProvisionResponseSchema.parse({ status });
      expect(result.status).toBe(status);
    }
  });

  it("rejects ProvisionResponse with invalid status", () => {
    expect(() =>
      ProvisionResponseSchema.parse({ status: "invalid" })
    ).toThrow();
  });

  it("parses CredentialHealth", () => {
    const result = CredentialHealthSchema.parse({
      projectId: "mesh-six",
      hasValidCredential: true,
      hasRefreshToken: true,
    });
    expect(result.hasValidCredential).toBe(true);
  });

  it("parses ImplementationSession", () => {
    const result = ImplementationSessionSchema.parse({
      id: "sess-1",
      issueNumber: 42,
      repoOwner: "jaybrto",
      repoName: "mesh-six",
      status: "running",
      createdAt: "2026-02-25T00:00:00Z",
    });
    expect(result.status).toBe("running");
  });

  it("rejects ImplementationSession with invalid status", () => {
    expect(() =>
      ImplementationSessionSchema.parse({
        id: "x",
        issueNumber: 1,
        repoOwner: "a",
        repoName: "b",
        status: "invalid",
        createdAt: "2026-02-25T00:00:00Z",
      })
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test packages/core/src/types.test.ts
```

Expected: FAIL — schemas not yet exported

**Step 3: Add schemas to types.ts**

Append to the end of `packages/core/src/types.ts` (after existing board event schemas around line 149):

```typescript
// ---------------------------------------------------------------------------
// Auth service types (ported from GWA)
// ---------------------------------------------------------------------------

export const ProjectConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  claudeAccountUuid: z.string().optional(),
  claudeOrgUuid: z.string().optional(),
  claudeEmail: z.string().optional(),
  settingsJson: z.string().optional(),
  claudeJson: z.string().optional(),
  mcpJson: z.string().optional(),
  claudeMd: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CredentialPushRequestSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime(),
  accountUuid: z.string().optional(),
  emailAddress: z.string().optional(),
  organizationUuid: z.string().optional(),
  billingType: z.string().optional(),
  displayName: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});
export type CredentialPushRequest = z.infer<typeof CredentialPushRequestSchema>;

export const ProjectCredentialSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime(),
  accountUuid: z.string().optional(),
  emailAddress: z.string().optional(),
  organizationUuid: z.string().optional(),
  billingType: z.string(),
  displayName: z.string(),
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
  source: z.enum(["push", "refresh", "import"]),
  pushedBy: z.string().optional(),
  createdAt: z.string().datetime(),
  invalidatedAt: z.string().datetime().optional(),
});
export type ProjectCredential = z.infer<typeof ProjectCredentialSchema>;

export const ProvisionRequestSchema = z.object({
  podName: z.string(),
  currentBundleId: z.string().optional(),
});
export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const ProvisionResponseSchema = z.object({
  status: z.enum(["current", "provisioned", "no_credentials"]),
  bundleId: z.string().optional(),
  credentialExpiresAt: z.string().datetime().optional(),
  message: z.string().optional(),
});
export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;

export const CredentialHealthSchema = z.object({
  projectId: z.string(),
  hasValidCredential: z.boolean(),
  expiresAt: z.string().datetime().optional(),
  expiresInMs: z.number().optional(),
  hasRefreshToken: z.boolean(),
  lastRefreshAt: z.string().datetime().optional(),
  activeBundleId: z.string().optional(),
});
export type CredentialHealth = z.infer<typeof CredentialHealthSchema>;

// ---------------------------------------------------------------------------
// Implementation session types
// ---------------------------------------------------------------------------

export const ImplementationSessionSchema = z.object({
  id: z.string(),
  issueNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  status: z.enum(["idle", "running", "blocked", "completed", "failed"]),
  actorId: z.string().optional(),
  tmuxWindow: z.number().optional(),
  credentialBundleId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});
export type ImplementationSession = z.infer<typeof ImplementationSessionSchema>;

export const SessionQuestionSchema = z.object({
  id: z.number(),
  sessionId: z.string(),
  questionText: z.string(),
  answerText: z.string().optional(),
  askedAt: z.string().datetime(),
  answeredAt: z.string().datetime().optional(),
});
export type SessionQuestion = z.infer<typeof SessionQuestionSchema>;

// ---------------------------------------------------------------------------
// Auth service constants
// ---------------------------------------------------------------------------

export const AUTH_SERVICE_APP_ID = "auth-service";
export const CREDENTIAL_REFRESHED_TOPIC = "credential-refreshed";
export const CONFIG_UPDATED_TOPIC = "config-updated";
export const SESSION_BLOCKED_TOPIC = "session-blocked";
```

**Step 4: Run test to verify it passes**

```bash
bun test packages/core/src/types.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts
git commit -m "add auth and session Zod schemas to core types"
```

---

### Task 3: Core credentials module

**Files:**
- Create: `packages/core/src/credentials.ts`
- Test: `packages/core/src/credentials.test.ts`

Port credential utilities from GWA's `src/lib/credentials-manager.ts`. Adapt to be library functions (no global state, no S3 dependency). The auth-service handles storage — these are pure utilities for bundle extraction and config sync.

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isCredentialExpired,
  syncEphemeralConfig,
  buildCredentialsJson,
  buildConfigJson,
  buildSettingsJson,
} from "./credentials.js";

describe("isCredentialExpired", () => {
  it("returns true when file does not exist", () => {
    expect(isCredentialExpired("/nonexistent/.credentials.json")).toBe(true);
  });

  it("returns true when credentials are expired", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-test-"));
    const path = join(dir, ".credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { expiresAt: Date.now() - 60_000 },
      })
    );
    expect(isCredentialExpired(path)).toBe(true);
  });

  it("returns false when credentials are valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-test-"));
    const path = join(dir, ".credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { expiresAt: Date.now() + 3_600_000 },
      })
    );
    expect(isCredentialExpired(path)).toBe(false);
  });

  it("returns true when expiry is within buffer", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-test-"));
    const path = join(dir, ".credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { expiresAt: Date.now() + 60_000 },
      })
    );
    // Default 5-minute buffer — 1 minute remaining is within buffer
    expect(isCredentialExpired(path)).toBe(true);
  });
});

describe("syncEphemeralConfig", () => {
  it("creates config.json from credentials.json", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
    const configDir = mkdtempSync(join(tmpdir(), "config-"));
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "test-token-123" },
      })
    );
    syncEphemeralConfig(claudeDir, configDir);
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(config.oauthToken).toBe("test-token-123");
  });

  it("does nothing when credentials file missing", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
    const configDir = mkdtempSync(join(tmpdir(), "config-"));
    syncEphemeralConfig(claudeDir, configDir);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });
});

describe("buildCredentialsJson", () => {
  it("builds valid credentials JSON", () => {
    const result = buildCredentialsJson({
      accessToken: "sk-ant-test",
      expiresAt: 1740000000000,
      accountUuid: "uuid-1",
      emailAddress: "test@example.com",
      organizationUuid: "org-1",
    });
    const parsed = JSON.parse(result);
    expect(parsed.claudeAiOauth.accessToken).toBe("sk-ant-test");
    expect(parsed.claudeAiOauth.expiresAt).toBe(1740000000000);
    expect(parsed.claudeAiOauth.accountUuid).toBe("uuid-1");
  });
});

describe("buildConfigJson", () => {
  it("builds config with oauthToken", () => {
    const result = buildConfigJson("sk-ant-test");
    const parsed = JSON.parse(result);
    expect(parsed.oauthToken).toBe("sk-ant-test");
  });
});

describe("buildSettingsJson", () => {
  it("returns custom settings when provided", () => {
    const custom = JSON.stringify({ theme: "light" });
    expect(buildSettingsJson(custom)).toBe(custom);
  });

  it("returns headless defaults when no custom settings", () => {
    const result = JSON.parse(buildSettingsJson());
    expect(result.skipDangerousModePermissionPrompt).toBe(true);
    expect(result.hasCompletedOnboarding).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test packages/core/src/credentials.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement credentials.ts**

```typescript
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
```

**Step 4: Run test to verify it passes**

```bash
bun test packages/core/src/credentials.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/credentials.ts packages/core/src/credentials.test.ts
git commit -m "add credential utilities to core library"
```

---

### Task 4: Core dialog handler module

**Files:**
- Create: `packages/core/src/dialog-handler.ts`
- Test: `packages/core/src/dialog-handler.test.ts`

Port from GWA `src/lib/dialog-handler.ts`. Remove tmux dependency — make it a pure analysis library. The caller (llm-service, implementer) provides terminal output and receives key sequences to send. This decouples dialog detection from tmux specifics.

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "bun:test";
import {
  matchKnownDialog,
  parseDialogResponse,
  looksNormal,
  KNOWN_DIALOGS,
  ClaudeDialogError,
} from "./dialog-handler.js";

describe("matchKnownDialog", () => {
  it("matches bypass permissions dialog", () => {
    const result = matchKnownDialog("Do you want to bypass permissions for this session?");
    expect(result).not.toBeNull();
    expect(result!.keys).toEqual(["Enter"]);
  });

  it("matches trust project dialog", () => {
    const result = matchKnownDialog("Do you trust this project directory?");
    expect(result).not.toBeNull();
    expect(result!.keys).toEqual(["Enter"]);
  });

  it("matches theme selection dialog", () => {
    const result = matchKnownDialog("Choose the text style that looks best on your terminal");
    expect(result).not.toBeNull();
  });

  it("returns null for normal output", () => {
    expect(matchKnownDialog("> ")).toBeNull();
    expect(matchKnownDialog("Thinking...")).toBeNull();
  });
});

describe("looksNormal", () => {
  it("returns true for empty pane", () => {
    expect(looksNormal("")).toBe(true);
    expect(looksNormal("   \n  \n")).toBe(true);
  });

  it("returns true for REPL prompt", () => {
    expect(looksNormal("> ")).toBe(true);
    expect(looksNormal("some output\n> ")).toBe(true);
  });

  it("returns true for spinner characters", () => {
    expect(looksNormal("⠋ Thinking")).toBe(true);
  });

  it("returns false for dialog text", () => {
    expect(looksNormal("Do you want to bypass permissions?")).toBe(false);
  });
});

describe("parseDialogResponse", () => {
  it("parses blocked response with keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Down", "Enter"], "reason": "test"}'
    );
    expect(result.blocked).toBe(true);
    expect(result.keys).toEqual(["Down", "Enter"]);
    expect(result.reason).toBe("test");
  });

  it("parses not-blocked response", () => {
    const result = parseDialogResponse('{"blocked": false}');
    expect(result.blocked).toBe(false);
    expect(result.keys).toEqual([]);
  });

  it("filters invalid keys", () => {
    const result = parseDialogResponse(
      '{"blocked": true, "keys": ["Enter", "rm -rf", "Tab"], "reason": "test"}'
    );
    expect(result.keys).toEqual(["Enter", "Tab"]);
  });

  it("enforces max key limit", () => {
    const keys = Array(15).fill("Enter");
    const result = parseDialogResponse(
      JSON.stringify({ blocked: true, keys, reason: "test" })
    );
    expect(result.keys.length).toBe(10);
  });
});

describe("ClaudeDialogError", () => {
  it("includes captured output", () => {
    const err = new ClaudeDialogError("test error", "pane output");
    expect(err.name).toBe("ClaudeDialogError");
    expect(err.capturedOutput).toBe("pane output");
    expect(err.message).toBe("test error");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test packages/core/src/dialog-handler.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement dialog-handler.ts**

```typescript
/**
 * Dialog detection and analysis for Claude Code CLI.
 *
 * Detects interactive TUI dialogs blocking Claude from starting.
 * Returns key sequences to dismiss them. Does NOT send keys itself —
 * the caller (llm-service, implementer) handles tmux/terminal interaction.
 *
 * Ported from GWA src/lib/dialog-handler.ts
 */

const MAX_KEYS = 10;

/** Allowed tmux key names */
const ALLOWED_KEYS = new Set([
  "Down", "Up", "Enter", "Tab", "Space", "Escape",
  "y", "n", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

/** Known dialog patterns dismissable without an API call */
export const KNOWN_DIALOGS: Array<{
  pattern: RegExp;
  keys: string[];
  reason: string;
}> = [
  {
    pattern: /bypass permissions/i,
    keys: ["Enter"],
    reason: "Accepting bypass permissions dialog",
  },
  {
    pattern: /trust this project/i,
    keys: ["Enter"],
    reason: "Trusting project directory",
  },
  {
    pattern: /Choose the text style|text style that looks best|Dark mode.*Light mode/i,
    keys: ["Enter"],
    reason: "Selecting default theme (dark mode)",
  },
  {
    pattern: /Select login method.*Claude account with subscription/is,
    keys: ["Enter"],
    reason: "Selecting Claude account with subscription login",
  },
  {
    pattern: /Browser didn't open.*Paste code here/is,
    keys: ["Escape"],
    reason: "Dismissing OAuth browser flow (token already cached)",
  },
  {
    pattern: /token revoked|please run \/login/i,
    keys: ["Escape"],
    reason: "Token revoked — cannot dismiss, need credential refresh",
  },
];

/** System prompt for LLM-based dialog analysis */
export const DIALOG_ANALYSIS_PROMPT = `You are monitoring a terminal where Claude Code CLI is starting up.
Check if there is an interactive dialog, prompt, or permission request
blocking Claude from running.

If blocked, respond with the tmux key sequence to accept/proceed.
Always accept permissions, agree to terms, and choose options that
let Claude Code start. Use tmux key names: Down, Up, Enter, Tab,
Space, Escape, y, n, or digits 0-9.

Respond ONLY with JSON (no markdown):
{"blocked": true, "keys": ["Down", "Enter"], "reason": "Accepting bypass permissions"}
or
{"blocked": false}`;

export interface DialogResponse {
  blocked: boolean;
  keys: string[];
  reason: string;
}

export class ClaudeDialogError extends Error {
  public readonly capturedOutput: string;
  constructor(message: string, capturedOutput: string) {
    super(message);
    this.name = "ClaudeDialogError";
    this.capturedOutput = capturedOutput;
  }
}

/**
 * Check if pane text matches a known dialog pattern.
 * Returns the matching entry or null.
 */
export function matchKnownDialog(
  paneText: string
): { keys: string[]; reason: string } | null {
  for (const dialog of KNOWN_DIALOGS) {
    if (dialog.pattern.test(paneText)) {
      return { keys: dialog.keys, reason: dialog.reason };
    }
  }
  return null;
}

/**
 * Quick heuristic: does the pane text look like normal Claude operation?
 */
export function looksNormal(paneText: string): boolean {
  const trimmed = paneText.trim();
  if (trimmed.length === 0) return true;

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return true;

  const lastLine = lines[lines.length - 1].trim();

  // Claude REPL prompt
  if (lastLine.startsWith(">") && lastLine.length <= 2) return true;

  // Claude is processing (spinner characters)
  const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  if (
    lastLine.includes("Thinking") ||
    spinnerChars.some((c) => lastLine.includes(c))
  ) {
    return true;
  }

  return false;
}

/**
 * Parse and validate an LLM JSON response for dialog detection.
 * Filters keys to allowed whitelist, enforces max key count.
 */
export function parseDialogResponse(raw: string): DialogResponse {
  const parsed = JSON.parse(raw.trim());
  const blocked = Boolean(parsed.blocked);

  if (!blocked) {
    return { blocked: false, keys: [], reason: "" };
  }

  const rawKeys: unknown[] = Array.isArray(parsed.keys) ? parsed.keys : [];
  const keys = rawKeys
    .filter((k): k is string => typeof k === "string" && ALLOWED_KEYS.has(k))
    .slice(0, MAX_KEYS);

  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { blocked, keys, reason };
}
```

**Step 4: Run test to verify it passes**

```bash
bun test packages/core/src/dialog-handler.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/dialog-handler.ts packages/core/src/dialog-handler.test.ts
git commit -m "add dialog handler to core library for CLI prompt detection"
```

---

### Task 5: Enhance core claude.ts with GWA auth patterns

**Files:**
- Modify: `packages/core/src/claude.ts`
- Modify: `packages/core/src/claude.test.ts` (add tests for new patterns)

GWA has 15 auth failure patterns. Mesh-six currently has a subset. Merge them.

**Step 1: Write failing tests for missing patterns**

Add to existing test file:

```typescript
import { describe, it, expect } from "bun:test";
import { detectAuthFailure } from "./claude.js";

describe("detectAuthFailure - GWA patterns", () => {
  const gwaPatterns = [
    "choose how to authenticate",
    "sign in at https://console.anthropic.com",
    "/oauth/authorize?client_id=...",
    "enter api key",
    "login required",
    "not authenticated",
    "authentication required",
    "authenticate with your account",
    "sign in to continue",
    "oauth.anthropic.com/callback",
    "anthropic login",
    "max plan required",
    "usage limit reached",
    "you need to login first",
    "please authenticate before continuing",
  ];

  for (const pattern of gwaPatterns) {
    it(`detects: "${pattern}"`, () => {
      expect(detectAuthFailure(pattern)).toBe(true);
    });
  }

  it("returns false for normal output", () => {
    expect(detectAuthFailure("Hello! How can I help you?")).toBe(false);
    expect(detectAuthFailure("Thinking...")).toBe(false);
    expect(detectAuthFailure("> ")).toBe(false);
  });
});
```

**Step 2: Run test to verify some fail**

```bash
bun test packages/core/src/claude.test.ts
```

Expected: Some FAIL (patterns not yet in AUTH_FAILURE_PATTERNS)

**Step 3: Update AUTH_FAILURE_PATTERNS in claude.ts**

Replace the existing `AUTH_FAILURE_PATTERNS` array (around line 9-25) with the merged set:

```typescript
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
```

**Step 4: Run test to verify it passes**

```bash
bun test packages/core/src/claude.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/claude.ts packages/core/src/claude.test.ts
git commit -m "merge GWA auth failure patterns into core claude module"
```

---

### Task 6: Update core index.ts exports

**Files:**
- Modify: `packages/core/src/index.ts`

**Step 1: Add new exports**

After the existing Claude Code CLI exports (around line 90-95), add:

```typescript
// Credential utilities
export {
  isCredentialExpired,
  syncEphemeralConfig,
  buildCredentialsJson,
  buildConfigJson,
  buildSettingsJson,
  buildClaudeJson,
} from "./credentials.js";

// Dialog handler
export {
  matchKnownDialog,
  parseDialogResponse,
  looksNormal,
  KNOWN_DIALOGS,
  DIALOG_ANALYSIS_PROMPT,
  ClaudeDialogError,
} from "./dialog-handler.js";
export type { DialogResponse } from "./dialog-handler.js";
```

Add new type exports to the existing types section (around line 2-24):

```typescript
// Auth service types
export {
  ProjectConfigSchema,
  CredentialPushRequestSchema,
  ProjectCredentialSchema,
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  CredentialHealthSchema,
  ImplementationSessionSchema,
  SessionQuestionSchema,
  AUTH_SERVICE_APP_ID,
  CREDENTIAL_REFRESHED_TOPIC,
  CONFIG_UPDATED_TOPIC,
  SESSION_BLOCKED_TOPIC,
} from "./types.js";
export type {
  ProjectConfig,
  CredentialPushRequest,
  ProjectCredential,
  ProvisionRequest,
  ProvisionResponse,
  CredentialHealth,
  ImplementationSession,
  SessionQuestion,
} from "./types.js";
```

**Step 2: Verify typecheck passes**

```bash
bun run --filter @mesh-six/core typecheck
```

Expected: No errors

**Step 3: Run all core tests**

```bash
bun run --filter @mesh-six/core test
```

Expected: All PASS

**Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "export credential utilities, dialog handler, and auth types from core"
```

---

### Task 7: Auth service scaffold

**Files:**
- Create: `apps/auth-service/package.json`
- Create: `apps/auth-service/tsconfig.json`
- Create: `apps/auth-service/src/index.ts`
- Create: `apps/auth-service/src/config.ts`
- Create: `apps/auth-service/src/db.ts`

**Step 1: Create package.json**

Follow the pattern from `apps/llm-service/package.json`:

```json
{
  "name": "@mesh-six/auth-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mesh-six/core": "workspace:*",
    "hono": "^4.7.4",
    "pg": "^8.13.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/pg": "^8.11.11",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "paths": {
      "@mesh-six/core": ["../../packages/core/src"]
    }
  },
  "include": ["src"]
}
```

**Step 3: Create config.ts**

```typescript
export const APP_PORT = Number(process.env.APP_PORT || "3000");
export const DAPR_HOST = process.env.DAPR_HOST || "localhost";
export const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

// PostgreSQL (from DATABASE_URL or individual vars)
export const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgres://${process.env.PG_USER || "mesh_six"}:${process.env.PG_PASSWORD || ""}@${process.env.PG_HOST || "localhost"}:${process.env.PG_PORT || "5432"}/${process.env.PG_DATABASE || "mesh_six"}`;

// Claude OAuth endpoints (for token refresh)
export const CLAUDE_OAUTH_TOKEN_URL =
  "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID =
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Timer intervals
export const REFRESH_CHECK_INTERVAL_MS = 30 * 60_000; // 30 min
export const CREDENTIAL_REFRESH_THRESHOLD_MS = 60 * 60_000; // Refresh if < 60 min remaining

// Dapr pub/sub
export const DAPR_PUBSUB_NAME = "agent-pubsub";
```

**Step 4: Create db.ts**

```typescript
import pg from "pg";
import { DATABASE_URL } from "./config.js";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
});

export default pool;
```

**Step 5: Create minimal index.ts with health endpoints**

```typescript
import { Hono } from "hono";
import { APP_PORT } from "./config.js";
import pool from "./db.js";

const app = new Hono();

app.get("/healthz", async (c) => {
  try {
    await pool.query("SELECT 1");
    return c.json({ status: "healthy", service: "auth-service" });
  } catch {
    return c.json({ status: "unhealthy" }, 503);
  }
});

app.get("/readyz", (c) => c.json({ status: "ready" }));

console.log(`[auth-service] Starting on port ${APP_PORT}`);

export default {
  port: APP_PORT,
  fetch: app.fetch,
};
```

**Step 6: Install dependencies**

```bash
bun install
```

**Step 7: Verify typecheck**

```bash
bun run --filter @mesh-six/auth-service typecheck
```

Expected: No errors

**Step 8: Verify it starts**

```bash
timeout 3 bun run apps/auth-service/src/index.ts || true
```

Expected: `[auth-service] Starting on port 3000` (then exits from timeout)

**Step 9: Commit**

```bash
git add apps/auth-service/
git commit -m "scaffold auth-service with health endpoints and database pool"
```

---

### Task 8: Auth service — project CRUD endpoints

**Files:**
- Create: `apps/auth-service/src/routes/projects.ts`
- Modify: `apps/auth-service/src/index.ts` (mount routes)
- Test: `apps/auth-service/src/routes/projects.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { projectRoutes } from "./projects.js";
import pg from "pg";

// Uses test database — set DATABASE_URL to test DB before running
const testPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://mesh_six:mesh_six@localhost:5432/mesh_six_test",
  max: 2,
});

describe("project routes", () => {
  const app = new Hono();
  app.route("/projects", projectRoutes(testPool));

  beforeAll(async () => {
    // Ensure clean state
    await testPool.query("DELETE FROM auth_bundles");
    await testPool.query("DELETE FROM auth_credentials");
    await testPool.query("DELETE FROM auth_projects");
  });

  afterAll(async () => {
    await testPool.query("DELETE FROM auth_bundles");
    await testPool.query("DELETE FROM auth_credentials");
    await testPool.query("DELETE FROM auth_projects");
    await testPool.end();
  });

  it("POST / creates a project", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-proj", displayName: "Test Project" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("test-proj");
    expect(body.displayName).toBe("Test Project");
  });

  it("GET /:id returns the project", async () => {
    const res = await app.request("/projects/test-proj");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("test-proj");
  });

  it("GET /:id returns 404 for missing project", async () => {
    const res = await app.request("/projects/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PUT /:id updates project settings", async () => {
    const res = await app.request("/projects/test-proj", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settingsJson: '{"theme":"light"}' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settingsJson).toBe('{"theme":"light"}');
  });

  it("POST / rejects duplicate id", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-proj", displayName: "Duplicate" }),
    });
    expect(res.status).toBe(409);
  });
});
```

**Step 2: Implement project routes**

```typescript
import { Hono } from "hono";
import type pg from "pg";

export function projectRoutes(pool: pg.Pool) {
  const router = new Hono();

  // Create project
  router.post("/", async (c) => {
    const body = await c.req.json();
    const { id, displayName, ...config } = body;

    if (!id || !displayName) {
      return c.json({ error: "id and displayName required" }, 400);
    }

    try {
      const result = await pool.query(
        `INSERT INTO auth_projects (id, display_name, claude_account_uuid, claude_org_uuid, claude_email, settings_json, claude_json, mcp_json, claude_md)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          id,
          displayName,
          config.claudeAccountUuid ?? null,
          config.claudeOrgUuid ?? null,
          config.claudeEmail ?? null,
          config.settingsJson ?? null,
          config.claudeJson ?? null,
          config.mcpJson ?? null,
          config.claudeMd ?? null,
        ]
      );
      return c.json(rowToProject(result.rows[0]), 201);
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "23505") {
        return c.json({ error: "Project already exists" }, 409);
      }
      throw e;
    }
  });

  // Get project
  router.get("/:id", async (c) => {
    const { id } = c.req.param();
    const result = await pool.query(
      "SELECT * FROM auth_projects WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(rowToProject(result.rows[0]));
  });

  // Update project
  router.put("/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json();

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const updatable = [
      ["display_name", "displayName"],
      ["claude_account_uuid", "claudeAccountUuid"],
      ["claude_org_uuid", "claudeOrgUuid"],
      ["claude_email", "claudeEmail"],
      ["settings_json", "settingsJson"],
      ["claude_json", "claudeJson"],
      ["mcp_json", "mcpJson"],
      ["claude_md", "claudeMd"],
    ] as const;

    for (const [col, key] of updatable) {
      if (key in body) {
        fields.push(`${col} = $${paramIndex}`);
        values.push(body[key]);
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE auth_projects SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json(rowToProject(result.rows[0]));
  });

  return router;
}

function rowToProject(row: Record<string, unknown>) {
  return {
    id: row.id,
    displayName: row.display_name,
    claudeAccountUuid: row.claude_account_uuid ?? undefined,
    claudeOrgUuid: row.claude_org_uuid ?? undefined,
    claudeEmail: row.claude_email ?? undefined,
    settingsJson: row.settings_json ?? undefined,
    claudeJson: row.claude_json ?? undefined,
    mcpJson: row.mcp_json ?? undefined,
    claudeMd: row.claude_md ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
```

**Step 3: Mount routes in index.ts**

Add to `apps/auth-service/src/index.ts`:

```typescript
import { projectRoutes } from "./routes/projects.js";

// After app creation:
app.route("/projects", projectRoutes(pool));
```

**Step 4: Run tests**

```bash
bun test apps/auth-service/src/routes/projects.test.ts
```

Expected: PASS (requires auth tables to exist in test DB)

**Step 5: Commit**

```bash
git add apps/auth-service/src/
git commit -m "add project CRUD endpoints to auth-service"
```

---

### Task 9: Auth service — credential endpoints

**Files:**
- Create: `apps/auth-service/src/routes/credentials.ts`
- Modify: `apps/auth-service/src/index.ts` (mount)
- Test: `apps/auth-service/src/routes/credentials.test.ts`

Implements `POST /projects/:id/credentials` (push), `GET /projects/:id/health`, and `POST /projects/:id/refresh`.

The credential push endpoint accepts OAuth tokens, invalidates previous active credentials, and stores the new one. The health endpoint returns expiry status and refresh capability. The refresh endpoint calls Claude's OAuth token endpoint to exchange a refresh token for a new access token.

**Step 1: Write failing tests**

Tests cover: push credential, health check, push invalidates previous, refresh endpoint. Follow the same pattern as Task 8 tests.

**Step 2: Implement credential routes**

The route handler should:
- `POST /projects/:id/credentials`: Validate with `CredentialPushRequestSchema.parse()`, invalidate active creds (`UPDATE SET invalidated_at = NOW() WHERE project_id = $1 AND invalidated_at IS NULL`), insert new credential, return the credential row.
- `GET /projects/:id/health`: Query active credential (`WHERE project_id = $1 AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1`), compute expiresInMs, check hasRefreshToken, find activeBundleId from auth_bundles.
- `POST /projects/:id/refresh`: Find active credential with refresh_token, call `CLAUDE_OAUTH_TOKEN_URL` with grant_type=refresh_token, store new credential, invalidate old one.

**Step 3: Mount routes, run tests, commit**

```bash
git commit -m "add credential push, health, and refresh endpoints to auth-service"
```

---

### Task 10: Auth service — provisioning and bundle generation

**Files:**
- Create: `apps/auth-service/src/routes/provision.ts`
- Create: `apps/auth-service/src/bundle.ts`
- Modify: `apps/auth-service/src/index.ts` (mount)
- Test: `apps/auth-service/src/bundle.test.ts`
- Test: `apps/auth-service/src/routes/provision.test.ts`

**Step 1: Write failing tests for bundle generation**

Test that `generateBundle()` produces a valid tar.gz containing the expected files (.credentials.json, config.json, settings.json, .claude.json). Use Bun's built-in zlib/tar support or the `tar` npm package to verify contents.

**Step 2: Implement bundle.ts**

Port the bundle generation from GWA's `EnvironmentProvisioner.buildTarGz()`. Use `@mesh-six/core` credential utilities (`buildCredentialsJson`, `buildConfigJson`, `buildSettingsJson`, `buildClaudeJson`). Store the generated bundle as BYTEA in `auth_bundles` table.

Key function:

```typescript
export async function generateBundle(
  pool: pg.Pool,
  project: ProjectConfig,
  credential: { accessToken: string; refreshToken?: string; expiresAt: number; accountUuid?: string; emailAddress?: string; organizationUuid?: string; billingType?: string; displayName?: string }
): Promise<{ bundleId: string; bundleData: Buffer }>
```

**Step 3: Implement provision route**

`POST /projects/:id/provision`:
1. Parse `ProvisionRequestSchema`
2. Find active credential for project
3. If none: return `{ status: "no_credentials" }`
4. Find active bundle. If exists and config hash matches: return `{ status: "current", bundleId }`
5. Generate new bundle, expire old bundles, store new one
6. Return `{ status: "provisioned", bundleId, credentialExpiresAt }`

Add `GET /projects/:id/provision/:bundleId` to download the bundle data (returns `application/octet-stream`).

**Step 4: Run tests, commit**

```bash
git commit -m "add provisioning and bundle generation to auth-service"
```

---

### Task 11: Auth service — OAuth refresh timer

**Files:**
- Create: `apps/auth-service/src/refresh-timer.ts`
- Modify: `apps/auth-service/src/index.ts` (start timer)

**Step 1: Implement refresh timer**

Port from GWA's `EnvironmentProvisioner.refreshAllCredentials()`. Every 30 minutes, query all active credentials expiring within 60 minutes that have a refresh token. For each, call Claude OAuth endpoint to refresh. Store new credential, invalidate old.

```typescript
export function startRefreshTimer(pool: pg.Pool, daprHost: string, daprPort: string): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    // Query credentials expiring within CREDENTIAL_REFRESH_THRESHOLD_MS
    // For each: refresh via CLAUDE_OAUTH_TOKEN_URL
    // Publish "credential-refreshed" via Dapr pub/sub
  }, REFRESH_CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
```

**Step 2: Wire into index.ts startup**

Call `startRefreshTimer(pool, DAPR_HOST, DAPR_HTTP_PORT)` after Hono server starts.

**Step 3: Commit**

```bash
git commit -m "add OAuth credential refresh timer to auth-service"
```

---

### Task 12: Auth service — Dapr pub/sub events

**Files:**
- Modify: `apps/auth-service/src/index.ts` (add /dapr/subscribe)
- Modify: `apps/auth-service/src/routes/credentials.ts` (publish events)
- Modify: `apps/auth-service/src/routes/provision.ts` (publish events)

**Step 1: Add Dapr subscription endpoint**

Auth-service doesn't subscribe to any topics — it only publishes. But it still needs the `/dapr/subscribe` endpoint (Dapr expects it):

```typescript
app.get("/dapr/subscribe", (c) => c.json([]));
```

**Step 2: Add event publishing helper**

```typescript
async function publishEvent(topic: string, data: unknown) {
  await fetch(`http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/publish/${DAPR_PUBSUB_NAME}/${topic}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

**Step 3: Publish events on credential operations**

- After credential push: publish to `CREDENTIAL_REFRESHED_TOPIC`
- After credential refresh: publish to `CREDENTIAL_REFRESHED_TOPIC`
- After project config update: publish to `CONFIG_UPDATED_TOPIC`

**Step 4: Commit**

```bash
git commit -m "add Dapr pub/sub event publishing to auth-service"
```

---

### Task 13: Auth service — K8s manifests

**Files:**
- Create: `k8s/base/auth-service/deployment.yaml`
- Create: `k8s/base/auth-service/service.yaml`
- Create: `k8s/base/auth-service/kustomization.yaml`
- Modify: `k8s/base/kustomization.yaml` (add auth-service)

**Step 1: Create deployment.yaml**

Follow the pattern from `k8s/base/llm-service/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: auth-service
  namespace: mesh-six
  labels:
    app: auth-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: auth-service
  template:
    metadata:
      labels:
        app: auth-service
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "auth-service"
        dapr.io/app-port: "3000"
        dapr.io/log-level: "info"
    spec:
      containers:
        - name: auth-service
          image: registry.bto.bar/jaybrto/mesh-six-auth-service:latest
          ports:
            - containerPort: 3000
          env:
            - name: APP_PORT
              value: "3000"
            - name: PG_HOST
              value: "pgsql.k3s.bto.bar"
            - name: PG_PORT
              value: "5432"
            - name: PG_DATABASE
              value: "mesh_six"
            - name: PG_USER
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: pg-user
            - name: PG_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mesh-six-secrets
                  key: pg-password
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "200m"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 20
```

**Step 2: Create service.yaml**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: auth-service
  namespace: mesh-six
spec:
  selector:
    app: auth-service
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
```

**Step 3: Create kustomization.yaml**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
```

**Step 4: Add to base kustomization**

Add `- auth-service` to the resources list in `k8s/base/kustomization.yaml`.

**Step 5: Commit**

```bash
git add k8s/base/auth-service/ k8s/base/kustomization.yaml
git commit -m "add auth-service k8s manifests"
```

---

### Task 14: Push credentials CLI script

**Files:**
- Create: `scripts/push-credentials.ts`

Port from GWA's `src/push-credentials.ts`. Adapt env var names: `AUTH_SERVICE_URL` instead of `ORCHESTRATOR_URL`, `AUTH_API_KEY` instead of `GWA_API_KEY`, `AUTH_PROJECT_ID` instead of `GWA_PROJECT_ID`.

The script reads `~/.claude/.credentials.json`, `~/.claude.json`, and `~/.claude/settings.json` from the developer's machine and pushes them to auth-service.

**Step 1: Implement the script**

Follow GWA's push-credentials.ts closely. Key differences:
- Uses `AUTH_SERVICE_URL` / `--auth-service` flag
- Uses `AUTH_PROJECT_ID` / `--project` flag
- Uses `AUTH_API_KEY` / `--api-key` flag
- Calls auth-service endpoints instead of GWA orchestrator

**Step 2: Test manually**

```bash
bun run scripts/push-credentials.ts --help
```

Expected: Usage output

**Step 3: Commit**

```bash
git add scripts/push-credentials.ts
git commit -m "add push-credentials CLI script for auth-service"
```

---

### Task 15: CI pipeline — add auth-service to build matrix

**Files:**
- Modify: `.github/workflows/build-deploy.yaml`

**Step 1: Add auth-service to buildable agents list**

In the `detect-changes` job, add `auth-service` to the `all_buildable_agents` list (around the existing agent list).

**Step 2: Commit**

```bash
git add .github/workflows/build-deploy.yaml
git commit -m "add auth-service to CI build matrix"
```

---

## Phase 2 — LLM Service Migration

Depends on Phase 1 completion. Tasks 16-21 are mostly sequential (each modifies llm-service files that overlap).

### Task 16: Create auth-client.ts in llm-service

**Files:**
- Create: `apps/llm-service/src/auth-client.ts`
- Test: `apps/llm-service/src/auth-client.test.ts`

Replaces `gwa-client.ts`. Calls auth-service via Dapr service invocation instead of direct HTTP to GWA orchestrator.

**Step 1: Write failing tests**

Test `isAuthServiceConfigured()`, mock Dapr service invocation for `provisionFromAuthService()` and `checkAuthServiceHealth()`.

**Step 2: Implement auth-client.ts**

```typescript
import { AUTH_SERVICE_APP_ID } from "@mesh-six/core";

const AUTH_PROJECT_ID = process.env.AUTH_PROJECT_ID || process.env.GWA_PROJECT_ID || "mesh-six";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

export function isAuthServiceConfigured(): boolean {
  return Boolean(AUTH_PROJECT_ID);
}

export interface AuthProvisionResult {
  status: "current" | "provisioned" | "no_credentials";
  bundleId?: string;
  credentialExpiresAt?: string;
}

export async function provisionFromAuthService(
  podName: string,
  currentBundleId?: string
): Promise<AuthProvisionResult | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podName, currentBundleId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as AuthProvisionResult;
  } catch {
    return null;
  }
}

export async function downloadBundle(bundleId: string): Promise<Buffer | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/provision/${bundleId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function checkAuthServiceHealth(): Promise<{ hasValidCredential: boolean; expiresInMs?: number } | null> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${AUTH_SERVICE_APP_ID}/method/projects/${AUTH_PROJECT_ID}/health`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as { hasValidCredential: boolean; expiresInMs?: number };
  } catch {
    return null;
  }
}
```

**Step 3: Run tests, commit**

```bash
git commit -m "add auth-client for Dapr-based auth-service invocation in llm-service"
```

---

### Task 17: Update claude-cli-actor.ts to use auth-client

**Files:**
- Modify: `apps/llm-service/src/claude-cli-actor.ts`

Replace all references to `gwa-client.ts` imports with `auth-client.ts` imports. Key changes:

1. Replace `import { isGWAConfigured, provisionFromGWA, checkGWAHealth } from "./gwa-client.js"` with `import { isAuthServiceConfigured, provisionFromAuthService, downloadBundle, checkAuthServiceHealth } from "./auth-client.js"`
2. In `onActivate()`: replace `provisionFromGWA()` calls with `provisionFromAuthService()` + `downloadBundle()`
3. In `syncCredentials()`: replace GWA health check with auth-service health check
4. In `provisionFromGWAOrchestrator()`: rename to `provisionFromAuth()`, use auth-client

**Step 1: Make the replacements**

Search for all occurrences of `gwa`, `GWA`, `provisionFromGWA`, `checkGWAHealth`, `isGWAConfigured` and replace with auth-service equivalents.

**Step 2: Verify typecheck**

```bash
bun run --filter @mesh-six/llm-service typecheck
```

**Step 3: Commit**

```bash
git commit -m "migrate llm-service actors from GWA client to auth-service client"
```

---

### Task 18: Add credential-refreshed subscription to llm-service

**Files:**
- Modify: `apps/llm-service/src/index.ts`

**Step 1: Add subscription**

In the `/dapr/subscribe` endpoint, add:

```typescript
{
  pubsubname: DAPR_PUBSUB_NAME,
  topic: CREDENTIAL_REFRESHED_TOPIC,
  route: "/events/credential-refreshed",
}
```

**Step 2: Add event handler**

```typescript
app.post("/events/credential-refreshed", async (c) => {
  // When auth-service refreshes credentials, all actors should re-provision
  // This is fire-and-forget — actors will pick up new creds on next sync
  console.log("[llm-service] Credential refreshed event received, actors will sync on next timer");
  return c.json({ status: "SUCCESS" });
});
```

**Step 3: Commit**

```bash
git commit -m "subscribe llm-service to credential-refreshed events from auth-service"
```

---

### Task 19: Integrate dialog handler in llm-service CLI spawner

**Files:**
- Modify: `apps/llm-service/src/cli-spawner.ts` (or wherever CLI is spawned)

**Step 1: Add dialog detection after CLI spawn**

Import `matchKnownDialog`, `looksNormal`, `parseDialogResponse` from `@mesh-six/core`. After spawning CLI process, capture initial output and check for dialogs. If detected, send appropriate keys to stdin.

This is optional for headless CLI (less likely to hit dialogs than tmux), but provides a safety net.

**Step 2: Commit**

```bash
git commit -m "integrate dialog handler in llm-service CLI spawner"
```

---

### Task 20: Remove gwa-client.ts and GWA env vars

**Files:**
- Delete: `apps/llm-service/src/gwa-client.ts`
- Modify: `apps/llm-service/src/config.ts` (remove GWA vars, add auth-service vars)

**Step 1: Delete gwa-client.ts**

```bash
rm apps/llm-service/src/gwa-client.ts
```

**Step 2: Update config.ts**

Remove:
```typescript
export const GWA_ORCHESTRATOR_URL = process.env.GWA_ORCHESTRATOR_URL || "";
export const GWA_API_KEY = process.env.GWA_API_KEY || "";
export const GWA_PROJECT_ID = process.env.GWA_PROJECT_ID || "mesh-six";
```

Add:
```typescript
export const AUTH_PROJECT_ID = process.env.AUTH_PROJECT_ID || "mesh-six";
```

**Step 3: Verify no remaining GWA references**

```bash
grep -r "GWA\|gwa-client\|gwa_client" apps/llm-service/src/
```

Expected: No matches

**Step 4: Typecheck**

```bash
bun run --filter @mesh-six/llm-service typecheck
```

**Step 5: Commit**

```bash
git add -A apps/llm-service/
git commit -m "remove GWA client and env vars from llm-service"
```

---

### Task 21: Update llm-service deployment.yaml

**Files:**
- Modify: `k8s/base/llm-service/deployment.yaml`

**Step 1: Remove GWA env vars**

Remove:
```yaml
- name: GWA_ORCHESTRATOR_URL
  value: "http://gwa-orchestrator.gwa:3001"
- name: GWA_API_KEY
  valueFrom:
    secretKeyRef:
      name: mesh-six-secrets
      key: gwa-api-key
- name: GWA_PROJECT_ID
  value: "mesh-six"
```

**Step 2: Add auth-service env vars**

```yaml
- name: AUTH_PROJECT_ID
  value: "mesh-six"
```

Note: No auth-service URL needed — Dapr service invocation handles discovery.

**Step 3: Commit**

```bash
git add k8s/base/llm-service/deployment.yaml
git commit -m "update llm-service deployment to use auth-service instead of GWA"
```

---

## Phase 3 — Implementer Agent + Session Tracking

Depends on Phase 1. Can run in parallel with Phase 2.

### Task 22: Session tables migration

**Files:**
- Create: `migrations/007_session_tables.sql`

**Step 1: Write the migration**

Use the SQL from the design doc (Section 5: Session Tracking Tables). Includes `implementation_sessions`, `session_prompts`, `session_tool_calls`, `session_activity_log`, `session_questions` with appropriate indexes.

**Step 2: Run migration**

```bash
DATABASE_URL=postgres://mesh_six:password@pgsql.k3s.bto.bar:5432/mesh_six bun run db:migrate
```

**Step 3: Commit**

```bash
git add migrations/007_session_tables.sql
git commit -m "add session tracking tables for implementer agent"
```

---

### Task 23: Implementer agent scaffold

**Files:**
- Create: `apps/implementer/package.json`
- Create: `apps/implementer/tsconfig.json`
- Create: `apps/implementer/src/index.ts`
- Create: `apps/implementer/src/config.ts`

Follow the same pattern as Task 7 (auth-service scaffold) and the reference agent pattern from `apps/simple-agent/src/index.ts`. Register with capabilities: `implementation` (weight 1.0) and `bug-fix-implementation` (weight 0.9).

Include standard endpoints: `/healthz`, `/readyz`, `/dapr/subscribe` (subscribe to `tasks.implementer`), `/tasks` (receive dispatched work).

**Step 1: Implement, typecheck, commit**

```bash
git commit -m "scaffold implementer agent with capability registration"
```

---

### Task 24: Implementer Dapr actor runtime

**Files:**
- Create: `apps/implementer/src/actor.ts`
- Modify: `apps/implementer/src/index.ts` (mount actor endpoints)

Implement `ImplementerActor` as a Dapr actor. Each actor represents one active issue session.

Key methods:
- `onActivate()`: Provision credentials from auth-service, clone/fetch repo, create worktree
- `startSession(issueNumber, repo, prompt)`: Start Claude CLI in tmux
- `getStatus()`: Return current session state
- `onDeactivate()`: Cleanup tmux, archive state

**Step 1: Implement actor, commit**

```bash
git commit -m "add Dapr actor runtime for implementer sessions"
```

---

### Task 25: Tmux session management

**Files:**
- Create: `apps/implementer/src/tmux.ts`

Utility functions for tmux operations:
- `createSession(sessionName)`: Create named tmux session
- `sendCommand(sessionName, command)`: Send keys to session
- `capturePane(sessionName, lines)`: Capture terminal output
- `killSession(sessionName)`: Destroy session
- `sendKeys(sessionName, ...keys)`: Send specific key sequences

Uses `Bun.spawn` to call tmux commands. Include dialog handler integration: after starting Claude CLI in tmux, call `matchKnownDialog` / `looksNormal` on captured output.

**Step 1: Implement, test, commit**

```bash
git commit -m "add tmux session management for implementer agent"
```

---

### Task 26: Session monitoring and database writes

**Files:**
- Create: `apps/implementer/src/monitor.ts`
- Create: `apps/implementer/src/session-db.ts`

`session-db.ts`: CRUD functions for session tables (insert session, insert prompt, insert tool call, update status, insert question).

`monitor.ts`: Periodic loop that captures tmux pane output and:
- Detects auth failures → attempts re-provision from auth-service
- Detects questions → inserts into session_questions, publishes `session-blocked` event
- Detects completion → updates session status, publishes task result
- Writes activity log entries for state changes
- Publishes MQTT events for dashboard

**Step 1: Implement, test, commit**

```bash
git commit -m "add session monitoring and database writes for implementer"
```

---

### Task 27: Dockerfile.implementer

**Files:**
- Create: `docker/Dockerfile.implementer`

Based on `docker/Dockerfile.agent` but adds:
- tmux package
- git package (full, not just git-daemon)
- Claude CLI installation (follow GWA's Dockerfile pattern)
- Non-root user with home directory for PVCs

```dockerfile
FROM registry.bto.bar/jaybrto/bun:1.2 AS builder
# ... same dependency install as Dockerfile.agent ...

FROM registry.bto.bar/jaybrto/bun:1.2-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN curl -fsSL https://claude.ai/install.sh | sh

# ... copy workspace from builder ...

USER bun
EXPOSE 3000
CMD ["bun", "run", "apps/implementer/src/index.ts"]
```

**Step 1: Implement, commit**

```bash
git add docker/Dockerfile.implementer
git commit -m "add Dockerfile.implementer with tmux and Claude CLI"
```

---

### Task 28: Implementer K8s manifests

**Files:**
- Create: `k8s/base/implementer/statefulset.yaml`
- Create: `k8s/base/implementer/service.yaml`
- Create: `k8s/base/implementer/kustomization.yaml`
- Modify: `k8s/base/kustomization.yaml` (add implementer)

StatefulSet pattern (from GWA's `gwa-runner-statefulset.yaml`):
- 1 replica
- PVC: `claude-session` (10Gi), `worktrees` (30Gi)
- Dapr annotations
- Auth-service env vars (AUTH_PROJECT_ID)
- PostgreSQL connection for session tables

**Step 1: Implement, commit**

```bash
git add k8s/base/implementer/ k8s/base/kustomization.yaml
git commit -m "add implementer StatefulSet k8s manifests"
```

---

### Task 29: CI pipeline — add implementer

**Files:**
- Modify: `.github/workflows/build-deploy.yaml`

Add `implementer` to buildable agents list. Map it to `docker/Dockerfile.implementer` (same pattern as dashboard/llm-service custom Dockerfiles). Add the StatefulSet to the deploy job's rollout restart list.

**Step 1: Implement, commit**

```bash
git commit -m "add implementer to CI build matrix with custom Dockerfile"
```

---

## Phase 4 — Workflow Unification + PR Agent

Depends on Phases 1-3.

### Task 30: PR agent scaffold

**Files:**
- Create: `apps/pr-agent/package.json`
- Create: `apps/pr-agent/tsconfig.json`
- Create: `apps/pr-agent/src/index.ts`
- Create: `k8s/base/pr-agent/deployment.yaml`
- Create: `k8s/base/pr-agent/service.yaml`
- Create: `k8s/base/pr-agent/kustomization.yaml`

Stateless Hono agent. Capabilities: `create-pr` (weight 1.0), `code-review` (weight 0.8). Invokes Claude CLI via llm-service for PR description generation and code review.

`/tasks` handler routes to `handleCreatePR()` or `handleCodeReview()` based on capability in the task request.

**Step 1: Implement, typecheck, commit**

```bash
git commit -m "scaffold pr-agent with create-pr and code-review capabilities"
```

---

### Task 31: PM workflow — question-blocking handler

**Files:**
- Modify: `apps/project-manager/src/index.ts`

Add subscription to `SESSION_BLOCKED_TOPIC`. When received:
1. Find active workflow for the issue
2. Move card to Blocked column via GitHub Projects API
3. Send ntfy.sh notification with question text
4. On `session-unblocked` event: move card back to In Progress

**Step 1: Implement, commit**

```bash
git commit -m "add question-blocking handler to project-manager workflow"
```

---

### Task 32: PM workflow — PR creation dispatch

**Files:**
- Modify: `apps/project-manager/src/index.ts` (or workflow activities file)

After QA phase passes, add a new workflow activity that dispatches `create-pr` capability to the orchestrator. The orchestrator routes to pr-agent. PM waits for task result with PR URL.

**Step 1: Implement, commit**

```bash
git commit -m "add PR creation dispatch to project-manager workflow"
```

---

### Task 33: Webhook receiver — PR events

**Files:**
- Modify: `apps/webhook-receiver/src/index.ts`

Handle `pull_request` webhook events (opened, synchronize, review_requested). Publish typed `PREvent` to Dapr `pr-events` topic. PM can subscribe to trigger code reviews.

**Step 1: Implement, commit**

```bash
git commit -m "add PR event handling to webhook-receiver"
```

---

### Task 34: Dashboard — session monitoring views

**Files:**
- Modify: `apps/dashboard/src/` (add session monitoring components)

Add a sessions page that queries `implementation_sessions` table and displays:
- Active sessions with status, issue, repo
- Session detail view with prompts, tool calls, activity log
- Real-time updates via MQTT subscription

**Step 1: Implement, commit**

```bash
git commit -m "add session monitoring views to dashboard"
```

---

### Task 35: End-to-end validation

**Files:**
- Create: `tests/e2e/gwa-migration.test.ts` (or manual test plan)

Validate the full flow:
1. Push credentials to auth-service via `scripts/push-credentials.ts`
2. Verify llm-service actors can provision from auth-service
3. Create test issue on GitHub board
4. Verify webhook-receiver publishes board event
5. Verify PM picks up issue and starts workflow
6. Verify implementer receives task and starts session
7. Verify session monitoring in dashboard
8. Verify PR creation on completion

**Step 1: Run manual validation, commit test plan**

```bash
git commit -m "add e2e validation plan for GWA migration"
```

---

## Post-Migration Cleanup

### Task 36: Update documentation

Run the `update-docs` skill to update:
- `CLAUDE.md` — add auth-service, implementer, pr-agent to architecture section
- `CHANGELOG.md` — document the migration
- `README.md` — update service list
- `docs/PLAN.md` — add migration milestone

### Task 37: Archive GWA repository

After all functionality is validated in mesh-six:
1. Add deprecation notice to GWA README
2. Archive the GWA repository on GitHub

---

## Dependency Graph

```
Phase 1 (Foundation):
  Tasks 1-6 (core + migration) → can run in parallel
  Tasks 7-14 (auth-service) → depend on Tasks 1-6
  Task 15 (CI) → depends on Task 13

Phase 2 (LLM Service):
  Tasks 16-21 → sequential, depend on Phase 1

Phase 3 (Implementer):
  Task 22 (migration) → depends on Phase 1
  Tasks 23-29 → sequential after Task 22, parallel with Phase 2

Phase 4 (Workflow):
  Tasks 30-35 → depend on Phases 1-3
```

## File Ownership for Parallel Execution

| Agent | Files | Phase |
|-------|-------|-------|
| Agent A | `migrations/006_auth_tables.sql` | 1 |
| Agent B | `packages/core/src/types.ts`, `types.test.ts` | 1 |
| Agent C | `packages/core/src/credentials.ts`, `credentials.test.ts` | 1 |
| Agent D | `packages/core/src/dialog-handler.ts`, `dialog-handler.test.ts` | 1 |
| Agent E | `packages/core/src/claude.ts`, `claude.test.ts` | 1 |
| Agent F (after A-E) | `packages/core/src/index.ts` | 1 |
| Agent G (after F) | `apps/auth-service/**` | 1 |
| Agent H (after G) | `apps/llm-service/**` | 2 |
| Agent I (after F) | `apps/implementer/**`, `docker/Dockerfile.implementer` | 3 |
| Agent J (after H, I) | `apps/pr-agent/**`, `apps/project-manager/**`, `apps/webhook-receiver/**`, `apps/dashboard/**` | 4 |

---

## Agent Teams Execution Plan

> **For Claude:** Follow these instructions to execute this plan using Claude Code Agent Teams.
> Load `superpowers:executing-plans` first, then follow the session setup below.

### Team Structure

- **Lead** — Coordinates phases, delegates foundation to subagents, spawns teammates, runs integration
- **Teammate A: auth-service** — Builds the entire auth-service app + push-credentials CLI
- **Teammate B: llm-migration** — Migrates llm-service from GWA client to auth-service client
- **Teammate C: implementer** — Builds the implementer agent, session tables, Dockerfile
- **Teammate D: infra** — K8s manifests for all new services, CI pipeline updates, deployment.yaml changes

### Phase 1: Foundation (Sequential — Lead Delegates to Subagents)

The lead delegates each foundation task to a synchronous subagent (context preservation). The lead sees only summaries, not file contents.

**Task 1.1: Database migration** (subagent)
- Create: `migrations/006_auth_tables.sql`
- Content: auth_projects, auth_credentials, auth_bundles tables (exact SQL in Task 1 above)
- Verify: File exists and is valid SQL

**Task 1.2: Core auth types** (subagent)
- Modify: `packages/core/src/types.ts` — append ProjectConfigSchema, CredentialPushRequestSchema, ProjectCredentialSchema, ProvisionRequestSchema, ProvisionResponseSchema, CredentialHealthSchema, ImplementationSessionSchema, SessionQuestionSchema, and constants (AUTH_SERVICE_APP_ID, CREDENTIAL_REFRESHED_TOPIC, CONFIG_UPDATED_TOPIC, SESSION_BLOCKED_TOPIC)
- Create: `packages/core/src/types.test.ts` — add validation tests for all new schemas
- Reference: Task 2 above has exact code

**Task 1.3: Core credentials module** (subagent)
- Create: `packages/core/src/credentials.ts` — isCredentialExpired, syncEphemeralConfig, buildCredentialsJson, buildConfigJson, buildSettingsJson, buildClaudeJson
- Create: `packages/core/src/credentials.test.ts`
- Reference: Task 3 above has exact code

**Task 1.4: Core dialog handler** (subagent)
- Create: `packages/core/src/dialog-handler.ts` — matchKnownDialog, looksNormal, parseDialogResponse, KNOWN_DIALOGS, DIALOG_ANALYSIS_PROMPT, ClaudeDialogError
- Create: `packages/core/src/dialog-handler.test.ts`
- Reference: Task 4 above has exact code

**Task 1.5: Core claude.ts enhancements** (subagent)
- Modify: `packages/core/src/claude.ts` — merge GWA's 15 AUTH_FAILURE_PATTERNS
- Modify or create: `packages/core/src/claude.test.ts`
- Reference: Task 5 above has exact patterns

**Task 1.6: Core index.ts exports** (subagent, after 1.2-1.5 complete)
- Modify: `packages/core/src/index.ts` — add exports for credentials, dialog-handler, and new types
- Reference: Task 6 above has exact export statements

**Foundation Gate:**
```bash
bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/core test
```
Both must pass before spawning Phase 2 teammates.

### Phase 2: Parallel Implementation (4 Teammates)

#### Teammate A: auth-service

**Exclusively Owns:**
- `apps/auth-service/package.json`
- `apps/auth-service/tsconfig.json`
- `apps/auth-service/src/index.ts`
- `apps/auth-service/src/config.ts`
- `apps/auth-service/src/db.ts`
- `apps/auth-service/src/routes/projects.ts`
- `apps/auth-service/src/routes/projects.test.ts`
- `apps/auth-service/src/routes/credentials.ts`
- `apps/auth-service/src/routes/credentials.test.ts`
- `apps/auth-service/src/routes/provision.ts`
- `apps/auth-service/src/routes/provision.test.ts`
- `apps/auth-service/src/bundle.ts`
- `apps/auth-service/src/bundle.test.ts`
- `apps/auth-service/src/refresh-timer.ts`
- `scripts/push-credentials.ts`

**Reads (no writes):**
- `packages/core/src/*` — imports types, credential utilities
- `apps/simple-agent/src/index.ts` — reference agent pattern
- `apps/llm-service/src/config.ts` — reference config pattern
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/orchestrator/environment-provisioner.ts`
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/push-credentials.ts`
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/shared/types.ts`

**Tasks (plan Tasks 7-12, 14):**
1. Scaffold app: package.json, tsconfig.json, config.ts, db.ts, minimal index.ts with /healthz and /readyz
2. Project CRUD routes (POST /, GET /:id, PUT /:id) with tests
3. Credential routes (POST /:id/credentials, GET /:id/health, POST /:id/refresh) with tests
4. Provisioning route (POST /:id/provision) + bundle.ts for tar.gz generation with tests
5. OAuth refresh timer (refresh-timer.ts)
6. Dapr pub/sub event publishing (credential-refreshed, config-updated topics)
7. Wire all routes into index.ts, add /dapr/subscribe endpoint
8. Port push-credentials.ts CLI script (adapted env var names: AUTH_SERVICE_URL, AUTH_PROJECT_ID, AUTH_API_KEY)

**Validation:**
```bash
bun install && bun run --filter @mesh-six/auth-service typecheck
```

**subagent_type:** `bun-service`

---

#### Teammate B: llm-migration

**Exclusively Owns:**
- `apps/llm-service/src/auth-client.ts`
- `apps/llm-service/src/auth-client.test.ts`
- `apps/llm-service/src/claude-cli-actor.ts` (modify)
- `apps/llm-service/src/config.ts` (modify)
- `apps/llm-service/src/gwa-client.ts` (delete)
- `apps/llm-service/src/index.ts` (modify — add subscription)

**Reads (no writes):**
- `packages/core/src/*` — imports AUTH_SERVICE_APP_ID, CREDENTIAL_REFRESHED_TOPIC, dialog handler
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/lib/credentials-manager.ts`
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/orchestrator/rest-api.ts`

**Tasks (plan Tasks 16-20):**
1. Create auth-client.ts — provisionFromAuthService(), downloadBundle(), checkAuthServiceHealth() via Dapr service invocation to auth-service
2. Update claude-cli-actor.ts — replace all gwa-client imports with auth-client imports, rename provisionFromGWAOrchestrator to provisionFromAuth, update onActivate/syncCredentials
3. Add credential-refreshed subscription to index.ts (/dapr/subscribe + /events/credential-refreshed handler)
4. Integrate dialog handler from @mesh-six/core into CLI spawner (import matchKnownDialog, looksNormal from core)
5. Update config.ts — remove GWA_ORCHESTRATOR_URL, GWA_API_KEY, GWA_PROJECT_ID; add AUTH_PROJECT_ID
6. Delete gwa-client.ts
7. Verify no remaining GWA references: `grep -r "GWA\|gwa-client\|gwa_client" apps/llm-service/src/`

**Validation:**
```bash
bun run --filter @mesh-six/llm-service typecheck
```

**subagent_type:** `bun-service`

---

#### Teammate C: implementer

**Exclusively Owns:**
- `migrations/007_session_tables.sql`
- `apps/implementer/package.json`
- `apps/implementer/tsconfig.json`
- `apps/implementer/src/index.ts`
- `apps/implementer/src/config.ts`
- `apps/implementer/src/actor.ts`
- `apps/implementer/src/tmux.ts`
- `apps/implementer/src/monitor.ts`
- `apps/implementer/src/session-db.ts`
- `docker/Dockerfile.implementer`

**Reads (no writes):**
- `packages/core/src/*` — imports types, registry, credentials, dialog-handler
- `apps/simple-agent/src/index.ts` — reference agent pattern
- `apps/llm-service/src/claude-cli-actor.ts` — reference Dapr actor pattern
- `docker/Dockerfile.agent` — base Dockerfile pattern
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/lib/credentials-manager.ts`
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/src/lib/dialog-handler.ts`
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/k8s/gwa-runner-statefulset.yaml`

**Tasks (plan Tasks 22-27):**
1. Write session tables migration (007_session_tables.sql) — implementation_sessions, session_prompts, session_tool_calls, session_activity_log, session_questions with indexes
2. Scaffold app: package.json, tsconfig.json, config.ts, index.ts with /healthz, /readyz, /dapr/subscribe, /tasks endpoints. Register capabilities: implementation (1.0), bug-fix-implementation (0.9)
3. Implement Dapr actor runtime (actor.ts) — ImplementerActor with onActivate (provision from auth-service, clone repo, create worktree), startSession, getStatus, onDeactivate
4. Implement tmux.ts — createSession, sendCommand, capturePane, killSession, sendKeys using Bun.spawn
5. Implement session-db.ts — CRUD for session tables (insert session, update status, insert prompt/tool_call/activity/question)
6. Implement monitor.ts — periodic pane capture, auth failure detection, question detection, completion detection, MQTT event publishing, session DB writes
7. Create Dockerfile.implementer — based on Dockerfile.agent, adds tmux + git + Claude CLI

**Validation:**
```bash
bun install && bun run --filter @mesh-six/implementer typecheck
```

**subagent_type:** `bun-service`

---

#### Teammate D: infra

**Exclusively Owns:**
- `k8s/base/auth-service/deployment.yaml`
- `k8s/base/auth-service/service.yaml`
- `k8s/base/auth-service/kustomization.yaml`
- `k8s/base/implementer/statefulset.yaml`
- `k8s/base/implementer/service.yaml`
- `k8s/base/implementer/kustomization.yaml`
- `k8s/base/kustomization.yaml` (modify)
- `k8s/base/llm-service/deployment.yaml` (modify)
- `.github/workflows/build-deploy.yaml` (modify)

**Reads (no writes):**
- `k8s/base/llm-service/*` — reference deployment pattern
- `k8s/base/webhook-receiver/*` — reference Dapr service pattern
- `docker/Dockerfile.agent` — verify build arg pattern
- GWA source: `/Users/jay.barreto/dev/util/bto/github-workflow-agents/k8s/gwa-runner-statefulset.yaml` — reference StatefulSet pattern

**Tasks (plan Tasks 13, 15, 21, 28, 29):**
1. Create k8s/base/auth-service/ — deployment.yaml (Dapr sidecar, PG env vars from mesh-six-secrets, 128Mi/256Mi resources), service.yaml (ClusterIP 80→3000), kustomization.yaml
2. Create k8s/base/implementer/ — statefulset.yaml (Dapr sidecar, PVCs: claude-session 10Gi + worktrees 30Gi on longhorn-claude, AUTH_PROJECT_ID env var, PG connection), service.yaml, kustomization.yaml
3. Modify k8s/base/kustomization.yaml — add `- auth-service` and `- implementer` to resources list
4. Modify k8s/base/llm-service/deployment.yaml — remove GWA_ORCHESTRATOR_URL, GWA_API_KEY, GWA_PROJECT_ID env vars; add AUTH_PROJECT_ID: "mesh-six"
5. Modify .github/workflows/build-deploy.yaml — add `auth-service` and `implementer` to all_buildable_agents list; map implementer to docker/Dockerfile.implementer in the dockerfile selection matrix

**Validation:**
```bash
kubectl kustomize k8s/base/ > /dev/null && echo "kustomize valid"
```

**subagent_type:** `k8s`

### Phase 3: Integration + Verification (Lead Delegates to Subagent)

After all 4 teammates complete, spawn a fresh integration subagent:

**Integration subagent prompt:**
```
Read all files created/modified by the teammates:
- apps/auth-service/src/**
- apps/llm-service/src/auth-client.ts, claude-cli-actor.ts, config.ts, index.ts
- apps/implementer/src/**
- docker/Dockerfile.implementer
- k8s/base/auth-service/**, k8s/base/implementer/**, k8s/base/kustomization.yaml
- k8s/base/llm-service/deployment.yaml
- .github/workflows/build-deploy.yaml
- migrations/007_session_tables.sql
- scripts/push-credentials.ts

Also read the shared foundation files:
- packages/core/src/types.ts, credentials.ts, dialog-handler.ts, claude.ts, index.ts

Fix all integration mismatches:
- Import paths that don't resolve
- Type names that don't match between modules
- Missing exports from core index.ts
- package.json workspace references

Then run:
1. bun install
2. bun run typecheck (all packages)
3. bun run --filter @mesh-six/core test
4. bun run --filter @mesh-six/auth-service typecheck

Return a summary of all changes made and verification results.
```

**subagent_type:** `general-purpose`

**After integration subagent returns:**
- Lead runs verification independently: `bun run typecheck && bun run --filter @mesh-six/core test`
- Lead commits all Phase 1-3 work
- Lead updates CHANGELOG.md, bumps version in relevant package.json files

### Phase 4: Workflow (Deferred to Separate Session)

Tasks 30-35 (pr-agent, PM workflow enhancements, webhook-receiver PR events, dashboard session views, E2E validation) depend on the full Phase 1-3 stack being deployed and testable. These should be executed in a separate session after Phase 3 is verified and deployed.

Use `/handoff` to create a handoff document after Phase 3 commits.

### File Ownership Matrix (No Conflicts)

| Teammate | Exclusively Owns | Reads (shared, no writes) |
|----------|-----------------|--------------------------|
| **Lead** | `migrations/006_auth_tables.sql`, `packages/core/src/types.ts`, `packages/core/src/types.test.ts`, `packages/core/src/credentials.ts`, `packages/core/src/credentials.test.ts`, `packages/core/src/dialog-handler.ts`, `packages/core/src/dialog-handler.test.ts`, `packages/core/src/claude.ts`, `packages/core/src/claude.test.ts`, `packages/core/src/index.ts` | Everything |
| **A: auth-service** | `apps/auth-service/**`, `scripts/push-credentials.ts` | `packages/core/src/*`, `apps/simple-agent/src/index.ts`, GWA source |
| **B: llm-migration** | `apps/llm-service/src/auth-client.ts`, `apps/llm-service/src/auth-client.test.ts`, `apps/llm-service/src/claude-cli-actor.ts`, `apps/llm-service/src/config.ts`, `apps/llm-service/src/gwa-client.ts` (delete), `apps/llm-service/src/index.ts` | `packages/core/src/*`, GWA source |
| **C: implementer** | `migrations/007_session_tables.sql`, `apps/implementer/**`, `docker/Dockerfile.implementer` | `packages/core/src/*`, `apps/simple-agent/src/index.ts`, `docker/Dockerfile.agent`, GWA source |
| **D: infra** | `k8s/base/auth-service/**`, `k8s/base/implementer/**`, `k8s/base/kustomization.yaml`, `k8s/base/llm-service/deployment.yaml`, `.github/workflows/build-deploy.yaml` | `k8s/base/llm-service/*`, `k8s/base/webhook-receiver/*`, GWA source |

### Task Dependency DAG

```
Phase 1 (Lead — subagent delegated):
  1.1 Migration ───────┐
  1.2 Core types ──────┤
  1.3 Credentials ─────┼── 1.6 Core exports ──► Foundation Gate
  1.4 Dialog handler ──┤     (typecheck + test)
  1.5 Claude.ts ───────┘

Phase 2 (Parallel Teammates):
  A: auth-service ─────┐
  B: llm-migration ────┼── All must complete before Phase 3
  C: implementer ──────┤
  D: infra ────────────┘

Phase 3 (Lead — integration subagent):
  3.1 Integration fixes ──► 3.2 Full typecheck ──► 3.3 Tests ──► 3.4 Commit

Phase 4 (Separate session):
  4.1 PR agent ──► 4.2 PM workflow ──► 4.3 Webhook PR events ──► 4.4 Dashboard ──► 4.5 E2E
```

### Claude Code Session Setup

**Prerequisites:**
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Execution steps:**

1. Start Claude Code in `/Users/jay.barreto/dev/util/bto/mesh-six`
2. Tell Claude: `Execute docs/plans/2026-02-25-gwa-migration-plan.md following the Agent Teams Execution Plan section`
3. Claude loads `superpowers:executing-plans` skill
4. Claude creates feature branch: `git checkout -b feat/gwa-migration`
5. Claude creates the full task list with dependencies:
   - Tasks 1-6: Phase 1 foundation (1.6 blocked by 1.2-1.5)
   - Task 7: Foundation gate (blocked by 1.1-1.6)
   - Tasks 8-11: Phase 2 teammates (each blocked by Task 7)
   - Task 12: Phase 3 integration (blocked by Tasks 8-11)
6. Claude delegates Phase 1 tasks to synchronous subagents (one per task, lead sees summaries)
7. Claude runs foundation gate: `bun run --filter @mesh-six/core typecheck && bun run --filter @mesh-six/core test`
8. Claude calls `TeamCreate` with team name `gwa-migration`
9. Claude spawns 4 teammates via `Task` tool:
   - `name: "auth-service"`, `subagent_type: "bun-service"`, `team_name: "gwa-migration"`, `run_in_background: true`
   - `name: "llm-migration"`, `subagent_type: "bun-service"`, `team_name: "gwa-migration"`, `run_in_background: true`
   - `name: "implementer"`, `subagent_type: "bun-service"`, `team_name: "gwa-migration"`, `run_in_background: true`
   - `name: "infra"`, `subagent_type: "k8s"`, `team_name: "gwa-migration"`, `run_in_background: true`
10. Claude monitors via `TaskList` polling (30s intervals)
11. When all teammates complete, Claude sends `SendMessage(type="shutdown_request")` to each
12. Claude spawns integration subagent (Phase 3 prompt above)
13. Claude runs `superpowers:verification-before-completion`
14. Claude commits, updates docs
15. Claude uses `superpowers:finishing-a-development-branch`

### Teammate Prompt Template

Each teammate receives this structure:

```
You are Teammate [name] on team gwa-migration. Your job is to [description].

**Task Management:**
- Use `TaskList` to see available tasks
- Use `TaskUpdate` to claim your task (set owner to your name)
- Use `TaskGet` to read the full task description

**File Ownership:**
- You EXCLUSIVELY own: [file list]
- You may READ (but NOT modify): [shared file list]
- Do NOT touch any other files

**Context — read these first:**
- [list of reference files to read for patterns]

**Available imports from @mesh-six/core:**
- Types: ProjectConfigSchema, CredentialPushRequestSchema, ProjectCredentialSchema, ProvisionRequestSchema, ProvisionResponseSchema, CredentialHealthSchema, ImplementationSessionSchema, SessionQuestionSchema, AUTH_SERVICE_APP_ID, CREDENTIAL_REFRESHED_TOPIC, CONFIG_UPDATED_TOPIC, SESSION_BLOCKED_TOPIC
- Credentials: isCredentialExpired, syncEphemeralConfig, buildCredentialsJson, buildConfigJson, buildSettingsJson, buildClaudeJson
- Dialog: matchKnownDialog, parseDialogResponse, looksNormal, KNOWN_DIALOGS, DIALOG_ANALYSIS_PROMPT, ClaudeDialogError
- Auth: preloadClaudeConfig, detectAuthFailure, checkAuthEnvironment, ClaudeAuthError
- Constants: DAPR_PUBSUB_NAME, DAPR_STATE_STORE, TASK_RESULTS_TOPIC

**GWA Source Reference:**
- Read files from /Users/jay.barreto/dev/util/bto/github-workflow-agents/src/ for porting reference
- [specific files relevant to this teammate]

**Implementation details:**
[task-specific instructions from the Phase 2 teammate section above]

**Validation:**
- Run [typecheck/test command] before marking complete

**When complete:**
- Mark your task as completed via `TaskUpdate`
- Send completion report via `SendMessage` to team lead
```
