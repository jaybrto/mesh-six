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
