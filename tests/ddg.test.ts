import { describe, it, expect } from "vitest";
import {
  DdgRateLimiter,
  DDG_BACKOFF_BASE_MS,
  DDG_BACKOFF_MAX_MS,
  ddgBackoffDelayMs,
  isDdgBackoffActive,
} from "../src/net/ddg";

describe("DdgRateLimiter inter-query delay", () => {
  it("paces sequential acquires with a jittered delay (no tight loop)", async () => {
    const minDelay = 20;
    const limiter = new DdgRateLimiter(minDelay);
    await limiter.acquire(); // No wait on first call.

    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    // jittered delay = minDelay * (1 + rand) => between 1x and 2x minDelay.
    expect(elapsed).toBeGreaterThanOrEqual(minDelay);
    expect(elapsed).toBeLessThan(minDelay * 3); // Allow scheduler slack.
  });
});

describe("DDG 202 backoff", () => {
  it("starts idle with no active backoff", () => {
    expect(isDdgBackoffActive()).toBe(false);
  });

  it("doubles exponentially from BASE and caps at MAX", () => {
    const first = ddgBackoffDelayMs(1);
    const second = ddgBackoffDelayMs(2);
    const third = ddgBackoffDelayMs(3);

    // 16s, 32s and 64s nominal (±15% jitter).
    expect(first).toBeGreaterThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 2 * 0.85));
    expect(first).toBeLessThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 2 * 1.15));
    expect(second).toBeGreaterThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 4 * 0.85));
    expect(second).toBeLessThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 4 * 1.15));
    expect(third).toBeGreaterThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 8 * 0.85));
    expect(third).toBeLessThanOrEqual(Math.round(DDG_BACKOFF_BASE_MS * 8 * 1.15));
  });

  it("never exceeds the configured cap even at high consecutive counts", () => {
    expect(ddgBackoffDelayMs(5)).toBeLessThanOrEqual(DDG_BACKOFF_MAX_MS);
    expect(ddgBackoffDelayMs(10)).toBeLessThanOrEqual(DDG_BACKOFF_MAX_MS);
  });
});