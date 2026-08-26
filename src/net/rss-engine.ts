import { SearchHit } from "../types";
import { buildBrowserHeaders } from "./http";

export async function searchRssFeeds(
  feedUrls: string[],
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  const hits: SearchHit[] = [];
  const queryLower = query.toLowerCase();

  for (const url of feedUrls) {
    if (signal.aborted) break;
    try {
      const res = await fetch(url, { signal, headers: buildBrowserHeaders(url) });
      if (!res.ok) continue;
      const xml = await res.text();
      
      // Basic RSS/Atom XML parsing
      const itemRe = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
      let match: RegExpExecArray | null;
      
      while (hits.length < maxResults && (match = itemRe.exec(xml)) !== null) {
        const block = match[1] || match[2];
        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>|<link[^>]*href="([^"]+)"/i);
        const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>|<summary[^>]*>([\s\S]*?)<\/summary>/i);
        
        const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
        const link = linkMatch ? (linkMatch[1] || linkMatch[2]).trim() : "";
        const desc = descMatch ? (descMatch[1] || descMatch[2]).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
        
        if (link && (title.toLowerCase().includes(queryLower) || desc.toLowerCase().includes(queryLower) || query === "")) {
          hits.push({ url: link, title, snippet: desc.slice(0, 300), discoveredBy: "rss" });
        }
      }
    } catch {}
  }
  return hits;
}