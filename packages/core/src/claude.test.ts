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
