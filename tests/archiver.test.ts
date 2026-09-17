import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createArchiveController } from "../src/net/archiver";

describe("createArchiveController", () => {
  const cfg = {
    enabled: true,
    maxPerRun: 25,
    minIntervalMs: 0,
    saveTimeoutMs: 1000,
    logFile: path.join(os.tmpdir(), `archives-test-${Date.now()}.json`),
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    try {
      fs.unlinkSync(cfg.logFile);
    } catch {
      // ignore (not created yet)
    }
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      fs.unlinkSync(cfg.logFile);
    } catch {
      // ignore
    }
  });

  it("submits a failing URL to the archive endpoint", async () => {
    const controller = createArchiveController(cfg);
    const signal = new AbortController().signal;
    await controller.submit("https://example.com/failed", "test", signal, "boom");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://web.archive.org/save/https%3A%2F%2Fexample.com%2Ffailed",
    );
    const stats = controller.stats();
    expect(stats.submitted).toBe(1);
  });

  it("dedupes URLs within a run", async () => {
    const controller = createArchiveController(cfg);
    const signal = new AbortController().signal;
    await controller.submit("https://a.example/page", "t", signal);
    await controller.submit("https://a.example/page", "t", signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stats = controller.stats();
    expect(stats.submitted).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it("respects the maxPerRun cap", async () => {
    const controller = createArchiveController({ ...cfg, maxPerRun: 2 });
    const signal = new AbortController().signal;
    await controller.submit("https://a.example/1", "t", signal);
    await controller.submit("https://a.example/2", "t", signal);
    await controller.submit("https://a.example/3", "t", signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stats = controller.stats();
    expect(stats.submitted).toBe(2);
    expect(stats.skipped).toBe(1);
  });

  it("does nothing when disabled or aborted", async () => {
    const disabled = createArchiveController({ ...cfg, enabled: false });
    const aborted = new AbortController();
    aborted.abort();

    await disabled.submit("https://a.example/x", "t", aborted.signal);
    expect(fetchMock).not.toHaveBeenCalled();

    await createArchiveController(cfg).submit(
      "https://a.example/y",
      "t",
      aborted.signal,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records failures and allows reset between runs", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const controller = createArchiveController(cfg);
    const signal = new AbortController().signal;
    await controller.submit("https://a.example/f", "t", signal);

    const stats = controller.stats();
    expect(stats.submitted).toBe(1);
    expect(stats.failed).toBe(1);

    controller.reset();
    const reset = controller.stats();
    expect(reset.submitted).toBe(0);
    expect(reset.failed).toBe(0);
  });
});