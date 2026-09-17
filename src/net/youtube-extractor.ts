import { buildBrowserHeaders } from "./http";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const ANDROID_CLIENT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    hl: "en",
    gl: "US",
  },
};

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    const match = u.pathname.match(/\/(embed|shorts)\/([^\/]+)/);
    if (match) return match[2];
    return null;
  } catch {
    return null;
  }
}

async function fetchInnerTube(
  videoId: string,
  signal: AbortSignal,
): Promise<Record<string, any> | null> {
  // Fetch the watch page to extract the INNERTUBE API key. YouTube gates the
  // legacy "captionTracks" blob on the page, but a fresh innerTube player POST
  // (ANDROID client) returns working timedtext URLs.
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageRes = await fetch(watchUrl, {
    signal,
    headers: buildBrowserHeaders(watchUrl),
  });
  if (!pageRes.ok) return null;
  const html = await pageRes.text();

  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const apiKey = keyMatch ? keyMatch[1] : undefined;
  if (!apiKey) return null;

  const res = await fetch(`${INNERTUBE_PLAYER_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...buildBrowserHeaders(INNERTUBE_PLAYER_URL),
    },
    body: JSON.stringify({ context: ANDROID_CLIENT, videoId }),
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, any>;
}

function pickTrack(tracks: any[]): any | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const manual = tracks.filter((t) => !t.kind || t.kind !== "asr");
  const pool = manual.length > 0 ? manual : tracks;
  return (
    pool.find((t) => t.languageCode === "en") ??
    pool.find((t) => t.languageCode === "en-US") ??
    pool[0] ??
    null
  );
}

function parseTranscriptXml(
  xml: string,
  maxChars: number,
): { text: string; totalChars: number } | null {
  const segments: string[] = [];
  const regex = /<text start="([\d.]+)" dur="[\d.]+">([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  let totalChars = 0;

  while ((match = regex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1]);
    const mins = Math.floor(startSec / 60).toString().padStart(2, "0");
    const secs = Math.floor(startSec % 60).toString().padStart(2, "0");
    const text = match[2]
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n/g, " ")
      .trim();

    const line = `[${mins}:${secs}] ${text}`;
    if (totalChars + line.length > maxChars) break;
    segments.push(line);
    totalChars += line.length;
  }

  return segments.length > 0 ? { text: segments.join("\n"), totalChars } : null;
}

export async function extractYouTubeTranscript(
  url: string,
  signal: AbortSignal,
  maxChars: number = 6000,
): Promise<{ text: string; title: string; description: string } | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    const data = await fetchInnerTube(videoId, signal);
    if (!data) return null;

    const title = data?.videoDetails?.title ?? url;
    const description = (data?.videoDetails?.shortDescription ?? "").slice(0, 250);

    const fallbackText =
      description.slice(0, maxChars) || "No transcript or description available.";

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = pickTrack(tracks);
    if (!track?.baseUrl) {
      return {
        text: fallbackText,
        title,
        description,
      };
    }

    // YouTube adds &exp=xpe (proof-of-origin gating) to timedtext URLs it
    // refuses to serve anonymously; treat those like "no captions available".
    const baseUrl = String(track.baseUrl).replace("&fmt=srv3", "");
    if (baseUrl.includes("exp=xpe")) {
      return { text: fallbackText, title, description };
    }

    const capRes = await fetch(baseUrl, {
      signal,
      headers: buildBrowserHeaders(baseUrl),
    });
    if (!capRes.ok) return null;
    const xml = await capRes.text();

    const parsed = parseTranscriptXml(xml, maxChars);
    if (!parsed) {
      return {
        text: description.slice(0, maxChars) || "Failed to parse transcript.",
        title,
        description,
      };
    }

    return {
      text: parsed.text,
      title,
      description,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}