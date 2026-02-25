import { describe, it, expect } from "bun:test";
import { TokenBucket } from "./github.js";

describe("TokenBucket", () => {
  it("allows requests up to max tokens", () => {
    const bucket = new TokenBucket({ maxTokens: 3, refillRate: 60 });
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills tokens over time", async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 1000 });
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(bucket.tryConsume()).toBe(true);
  });

  it("waitForToken resolves immediately when tokens available", async () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRate: 60 });
    const start = Date.now();
    await bucket.waitForToken();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waitForToken waits when no tokens available", async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 600 });
    bucket.tryConsume();
    const start = Date.now();
    await bucket.waitForToken();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
