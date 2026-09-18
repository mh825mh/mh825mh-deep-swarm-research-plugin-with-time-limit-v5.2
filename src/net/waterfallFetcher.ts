/**
 * Multi-tiered resilient fetcher for LM Studio research swarm workers.
 *
 * NOTE: `got-scraping` v4 is ESM-only. LM Studio bundles plugins as CommonJS
 * and leaves dependencies external, so a top-level `import` becomes a
 * `require("got-scraping")` that throws ERR_PACKAGE_PATH_NOT_EXPORTED on load.
 * We therefore load it lazily via an indirect dynamic import (opaque to the
 * bundler) and gracefully disable the tier if it can't be loaded.
 */

type GotScrapingResponse = { statusCode?: number; body: unknown };
type GotScrapingModule = {
  gotScraping: {
    get(url: string, options?: Record<string, unknown>): Promise<GotScrapingResponse>;
  };
};

let modPromise: Promise<GotScrapingModule | null> | null = null;

function loadGotScraping(): Promise<GotScrapingModule | null> {
  if (!modPromise) {
    const dynamicImport = new Function("s", "return import(s)") as (
      specifier: string,
    ) => Promise<GotScrapingModule>;
    modPromise = dynamicImport("got-scraping").catch((err: any) => {
      console.warn(
        `[Tier A] got-scraping unavailable (${err?.code ?? err?.message}); skipping TLS tier.`,
      );
      return null;
    });
  }
  return modPromise;
}

/**
 * Multi-tiered resilient fetcher for LM Studio research swarm workers.
 *
 * @param url The target URL to fetch.
 * @param abortSignal AbortSignal to propagate timeouts and cancellation.
 * @param flaresolverrUrl Optional FlareSolverr endpoint (e.g. "http://127.0.0.1:8191/v1").
 * @returns Clean HTML string if successful, or null if all tiers fail.
 */
export async function fetchWithWaterfall(
  url: string,
  abortSignal: AbortSignal,
  flaresolverrUrl?: string
): Promise<string | null> {
  // ==========================================
  // TIER A: got-scraping (Native TLS Fingerprinting)
  // ==========================================
  const gs = await loadGotScraping();
  if (gs) {
    try {
      console.log(`[Tier A] Fetching ${url} with got-scraping...`);
      const response = await gs.gotScraping.get(url, {
        signal: abortSignal,
        throwHttpErrors: false, // Don't throw on 403/503 so we can inspect the challenge body
      });

      const body = response.body as string;

      // Verify status and ensure no Cloudflare/DDoS challenge indicators are present
      const isChallenge =
        body.includes('Just a moment...') ||
        body.includes('cf-browser-verification') ||
        body.includes('Attention Required! | Cloudflare');

      if (response.statusCode === 200 && !isChallenge) {
        return body;
      }

      console.warn(`[Tier A] Block or challenge detected for ${url} (HTTP ${response.statusCode}). Falling back...`);
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;
      console.warn(`[Tier A] Network error for ${url}: ${error.message}. Falling back...`);
    }
  }

  // ==========================================
  // TIER B: FlareSolverr (Optional Headless Bypass)
  // ==========================================
  if (flaresolverrUrl && flaresolverrUrl.trim() !== '') {
    try {
      console.log(`[Tier B] Advanced bypass enabled. Requesting ${url} via FlareSolverr...`);
      const fsResponse = await fetch(flaresolverrUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url: url,
          maxTimeout: 15000,
        }),
        signal: abortSignal,
      });

      if (fsResponse.ok) {
        const fsData = (await fsResponse.json()) as {
          status?: string;
          solution?: { response?: string };
        };

        if (fsData.status === 'ok' && fsData.solution?.response) {
          console.log(`[Tier B] Successfully resolved ${url} via FlareSolverr.`);
          return fsData.solution.response;
        }
      }
      console.warn(`[Tier B] FlareSolverr could not resolve ${url}. Falling back...`);
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;
      console.warn(`[Tier B] FlareSolverr request failed (${error.message}). Falling back...`);
    }
  }

  // ==========================================
  // TIER C: Wayback Machine (Archive.org Fallback)
  // ==========================================
  try {
    console.log(`[Tier C] Fetching snapshot for ${url} from Web Archive...`);
    const archiveUrl = `https://web.archive.org/web/2/${url}`;
    const archiveResponse = await fetch(archiveUrl, { signal: abortSignal });

    if (archiveResponse.ok) {
      const body = await archiveResponse.text();
      if (body) return body;
    }
  } catch (error: any) {
    if (error.name === 'AbortError') throw error;
    console.warn(`[Tier C] Web Archive fallback failed for ${url}: ${error.message}.`);
  }

  // All strategies exhausted; gracefully exit without crashing worker thread
  console.error(`[Waterfall] All tiers exhausted for ${url}. Returning null.`);
  return null;
}
