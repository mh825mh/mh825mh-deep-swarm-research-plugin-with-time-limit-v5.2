// src/net/ssrf.ts
// SSRF guard helpers. Kept in a separate module (no network side-effects) so
// they can be unit-tested without pulling in http.ts.
import { BlockList, isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

const privateBlock = new BlockList();
// Guarded individually: some special-use ranges (e.g. "::") are rejected by
// Node's BlockList and must never crash the module at import time.
function safeAddSubnet(cidr: string, prefix: number, family: "ipv4" | "ipv6"): void {
  try {
    privateBlock.addSubnet(cidr, prefix, family);
  } catch {
    // Non-fatal: the decode/isPrivateIp checks below still catch most cases.
  }
}
// --- IPv4 ---
safeAddSubnet("0.0.0.0", 8, "ipv4");
safeAddSubnet("10.0.0.0", 8, "ipv4");
safeAddSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
safeAddSubnet("127.0.0.0", 8, "ipv4");
safeAddSubnet("169.254.0.0", 16, "ipv4"); // link-local
safeAddSubnet("172.16.0.0", 12, "ipv4");
safeAddSubnet("192.0.0.0", 24, "ipv4");
safeAddSubnet("192.168.0.0", 16, "ipv4");
safeAddSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
safeAddSubnet("224.0.0.0", 4, "ipv4"); // multicast
safeAddSubnet("240.0.0.0", 4, "ipv4"); // reserved
// --- IPv6 ---
safeAddSubnet("::", 128, "ipv6"); // unspecified
safeAddSubnet("::1", 128, "ipv6"); // loopback
safeAddSubnet("fc00::", 7, "ipv6"); // unique local
safeAddSubnet("fe80::", 10, "ipv6"); // link-local
safeAddSubnet("2001:db8::", 32, "ipv6"); // documentation
safeAddSubnet("ff00::", 8, "ipv6"); // multicast

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

function decodeNumericIpv4(host: string): string | null {
  const h = stripBrackets(host);
  try {
    let intVal: number | null = null;
    if (/^0x[0-9a-f]+$/i.test(h)) intVal = parseInt(h, 16);
    else if (/^\d{1,10}$/.test(h)) intVal = parseInt(h, 10);
    if (
      intVal === null ||
      !Number.isSafeInteger(intVal) ||
      intVal < 0 ||
      intVal > 0xffffffff
    ) {
      return null;
    }
    return `${(intVal >>> 24) & 255}.${(intVal >>> 16) & 255}.${(intVal >>> 8) & 255}.${intVal & 255}`;
  } catch {
    return null;
  }
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;

  let address = ip;
  let fam = family;

  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:xxxx).
  if (family === 6) {
    const lower = stripBrackets(ip);
    // Unspecified / wildcard addresses are always local-adjacent.
    if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
    const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f.]+)$/);
    if (mapped) {
      if (mapped[1].includes(".")) {
        address = mapped[1];
        fam = 4;
      } else {
        const parsed = parseInt(mapped[1], 16);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
          address = `${(parsed >>> 24) & 255}.${(parsed >>> 16) & 255}.${(parsed >>> 8) & 255}.${parsed & 255}`;
          fam = 4;
        }
      }
    }
  }

  try {
    return privateBlock.check(address, fam === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

const NON_ROUTABLE_SUFFIXES = [
  ".local",
  ".internal",
  ".lan",
  ".localhost",
  ".home.arpa",
];

export function isPrivateUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }

  const host = stripBrackets(u.hostname);
  if (!host) return true;

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    NON_ROUTABLE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }

  const decoded = decodeNumericIpv4(host);
  if (decoded && isPrivateIp(decoded)) return true;

  return isPrivateIp(host);
}

/**
 * Best-effort DNS rebinding check: resolves the hostname through the plugin's
 * configured DNS resolvers and blocks if any address is private. Resolver
 * failures / unknown hosts are treated as safe so normal fetch errors surface
 * naturally (this guard must never cause valid public research to be dropped).
 */
export async function isDnsRisky(rawUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }

  const host = stripBrackets(u.hostname);
  if (!host) return true;
  if (isIP(host) !== 0) return isPrivateIp(host);

  try {
    const [v4, v6] = await Promise.all([
      resolve4(host).catch(() => [] as string[]),
      resolve6(host).catch(() => [] as string[]),
    ]);
    const all = [...v4, ...v6];
    if (all.length === 0) return false;
    return all.some(isPrivateIp);
  } catch {
    return false;
  }
}

export async function isRiskyUrl(rawUrl: string): Promise<boolean> {
  if (isPrivateUrl(rawUrl)) return true;
  return isDnsRisky(rawUrl);
}