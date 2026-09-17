import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../src/swarm/visited-cache";

describe("normalizeUrl", () => {
  it("strips tracking parameters", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&utm_medium=y&id=1")).toBe(
      "https://example.com/a?id=1",
    );
  });

  it("strips the URL fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe(
      "https://example.com/page",
    );
  });

  it("removes www prefix", () => {
    expect(normalizeUrl("https://www.example.com/")).toBe(
      "https://example.com/",
    );
  });

  it("normalizes trailing slashes", () => {
    expect(normalizeUrl("https://example.com/path///")).toBe(
      "https://example.com/path",
    );
    expect(normalizeUrl("https://example.com/path/")).toBe(
      "https://example.com/path",
    );
  });

  it("sorts query parameters deterministically", () => {
    expect(normalizeUrl("https://example.com/?b=2&a=1")).toBe(
      "https://example.com/?a=1&b=2",
    );
  });

  it("returns malformed input unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
    expect(normalizeUrl("")).toBe("");
  });
});