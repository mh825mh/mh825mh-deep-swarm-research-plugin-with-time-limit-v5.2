import { buildBrowserHeaders } from "./http";

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

export async function extractYouTubeTranscript(
  url: string,
  signal: AbortSignal,
  maxChars: number = 6000,
): Promise<{ text: string; title: string; description: string } | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    // 1. Fetch the video page to get metadata and captions URL
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(videoUrl, { signal, headers: buildBrowserHeaders(videoUrl) });
    if (!res.ok) return null;
    const html = await res.text();

    // 2. Extract Title
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : url;

    // 3. Extract Description (for fallback)
    const descMatch = html.match(/"shortDescription":"(.*?)"/);
    const description = descMatch ? descMatch[1].replace(/\\n/g, "\n").trim() : "";

    // 4. Find Caption Tracker URL
    const captionsMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!captionsMatch) {
      // No captions available, return description as fallback text
      return {
        text: description.slice(0, maxChars) || "No transcript or description available.",
        title,
        description: description.slice(0, 250),
      };
    }

    let captionTracks: any[] = [];
    try {
      // Safely parse the JSON array
      const jsonStr = captionsMatch[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"');
      captionTracks = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    if (captionTracks.length === 0) {
      return { text: description.slice(0, maxChars) || "No transcript available.", title, description: description.slice(0, 250) };
    }

    // Prefer English captions
    const track = captionTracks.find(t => t.languageCode === "en") ?? captionTracks[0];
    const captionUrl = track.baseUrl;
    if (!captionUrl) return null;

    // 5. Fetch and Parse Transcript XML
    const capRes = await fetch(captionUrl, { signal, headers: buildBrowserHeaders(captionUrl) });
    if (!capRes.ok) return null;
    const xml = await capRes.text();

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

    if (segments.length === 0) {
      return { text: description.slice(0, maxChars) || "Failed to parse transcript.", title, description: description.slice(0, 250) };
    }

    return {
      text: segments.join("\n"),
      title,
      description: description.slice(0, 250),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}