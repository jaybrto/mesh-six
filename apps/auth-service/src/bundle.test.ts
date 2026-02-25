import { describe, it, expect } from "bun:test";
import { computeConfigHash } from "./bundle.js";
import type { ProjectConfig, ProjectCredential } from "@mesh-six/core";

const baseProject: ProjectConfig = {
  id: "test-project",
  displayName: "Test Project",
  createdAt: "2026-02-25T00:00:00Z",
  updatedAt: "2026-02-25T00:00:00Z",
};

const baseCred: ProjectCredential = {
  id: "cred-1",
  projectId: "test-project",
  accessToken: "sk-ant-test",
  expiresAt: "2026-03-01T00:00:00Z",
  billingType: "stripe_subscription",
  displayName: "Test",
  source: "push",
  createdAt: "2026-02-25T00:00:00Z",
};

describe("computeConfigHash", () => {
  it("returns a consistent hex string", () => {
    const hash = computeConfigHash(baseProject, "cred-1");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when credentialId changes", () => {
    const h1 = computeConfigHash(baseProject, "cred-1");
    const h2 = computeConfigHash(baseProject, "cred-2");
    expect(h1).not.toBe(h2);
  });

  it("changes when settingsJson changes", () => {
    const h1 = computeConfigHash(baseProject, "cred-1");
    const h2 = computeConfigHash(
      { ...baseProject, settingsJson: '{"theme":"light"}' },
      "cred-1"
    );
    expect(h1).not.toBe(h2);
  });

  it("is stable across calls", () => {
    const h1 = computeConfigHash(baseProject, "cred-1");
    const h2 = computeConfigHash(baseProject, "cred-1");
    expect(h1).toBe(h2);
  });
});

describe("generateBundle", () => {
  it("produces a non-empty buffer", async () => {
    const { generateBundle } = await import("./bundle.js");
    const buf = generateBundle({ project: baseProject, credential: baseCred });
    expect(buf.length).toBeGreaterThan(0);
  });
});
