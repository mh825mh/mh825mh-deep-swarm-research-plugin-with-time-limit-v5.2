/**
 * @file net/social-engines.ts
 * Public social-source search providers.
 *
 * X.com support was intentionally removed:
 * plain scraping is unreliable, authenticated-cookie scraping is brittle,
 * and the old implementation imposed delay without reliably returning hits.
 */

import { SearchHit } from "../types";
import { buildBrowserHeaders } from "./http";

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseChannelName(channel: string): string {
  return channel
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "");
}

function extractTelegramPosts(
  html: string,
  channel: string,
  query: string,
  maxResults: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);

  const postRe =
    /<div[^>]*class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

  let postMatch: RegExpExecArray | null;

  while (
    hits.length < maxResults &&
    (postMatch = postRe.exec(html)) !== null
  ) {
    const postHtml = postMatch[1];

    const linkMatch = postHtml.match(
      /href="(https:\/\/t\.me\/[^"/]+\/\d+)"/i,
    );

    const textMatch = postHtml.match(
      /<div[^>]*class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );

    const dateMatch = postHtml.match(
      /<time[^>]*datetime="([^"]+)"/i,
    );

    const url = linkMatch?.[1];
    const text = textMatch ? stripHtml(textMatch[1]) : "";

    if (!url || !text || seen.has(url)) continue;

    const textLower = text.toLowerCase();
    const relevanceHits = queryTerms.filter((term) =>
      textLower.includes(term),
    ).length;

    if (queryTerms.length > 0 && relevanceHits === 0) continue;

    seen.add(url);

    const published = dateMatch?.[1]
      ? new Date(dateMatch[1]).toLocaleDateString("en-GB", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";

    hits.push({
      url,
      title: published
        ? `Telegram: @${channel} — ${published}`
        : `Telegram: @${channel}`,
      snippet: text.slice(0, 500),
      discoveredBy: "telegram",
    });
  }

  return hits;
}

/**
 * Searches public Telegram channel preview pages.
 *
 * This only works for public channels. Telegram may return no posts or a
 * challenge page, in which case the function fails safely with no results.
 */
export async function searchTelegram(
  channels: ReadonlyArray<string>,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const configuredChannel of channels) {
    if (signal.aborted || hits.length >= maxResults) break;

    const channel = normaliseChannelName(configuredChannel);
    if (!channel) continue;

    const url = `https://t.me/s/${encodeURIComponent(channel)}`;

    try {
      const res = await fetch(url, {
        signal,
        headers: {
          ...buildBrowserHeaders(url),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!res.ok) continue;

      const html = await res.text();
      const remaining = maxResults - hits.length;
      const channelHits = extractTelegramPosts(
        html,
        channel,
        query,
        remaining,
      );

      for (const hit of channelHits) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);

        if (hits.length >= maxResults) break;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
    }
  }

  return hits;
}