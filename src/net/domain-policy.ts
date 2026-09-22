// src/net/domain-policy.ts
// Deterministic domain allow/deny guardrails (item 7). Applied to every
// candidate, page fetch, and outlink evaluation so the swarm can never wander
// into wide-open territory. The allow-list is an explicit domain whitelist
// (subdomains of a listed parent count as allowed); the deny-list always wins,
// so a deny outranks an allow for the same host.
export interface DomainPolicy {
  readonly allowed: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
}

export interface DomainPolicyResult {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export type DomainPolicySource = {
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly blockedDomains?: ReadonlyArray<string>;
};

function normalise(raw?: ReadonlyArray<string>): Set<string> {
  const set = new Set<string>();
  for (const entry of raw ?? []) {
    const cleaned = String(entry)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/[\/?#].*$/, "")
      .replace(/^www\./, "");
    if (cleaned) set.add(cleaned);
  }
  return set;
}

export function buildDomainPolicy(source: DomainPolicySource = {}): DomainPolicy {
  return { allowed: normalise(source.allowedDomains), blocked: normalise(source.blockedDomains) };
}

function parentDomain(hostname: string): string {
  const labels = hostname.split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : hostname;
}

export function domainAllowed(hostname: string, policy: DomainPolicy): DomainPolicyResult {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (!host) return { allowed: false, reason: "empty-host" };
  const parent = parentDomain(host);
  if (policy.blocked.has(host) || policy.blocked.has(parent)) {
    return { allowed: false, reason: "blocked-domain" };
  }
  if (policy.allowed.size > 0 && !policy.allowed.has(host) && !policy.allowed.has(parent)) {
    return { allowed: false, reason: "domain-not-allowed" };
  }
  return { allowed: true, reason: null };
}

export function urlAllowed(url: string, policy: DomainPolicy): DomainPolicyResult {
  try {
    return domainAllowed(new URL(url).hostname, policy);
  } catch {
    return { allowed: false, reason: "malformed-url" };
  }
}

export function buildDomainPolicyFromTask(
  task: DomainPolicySource,
): DomainPolicy {
  return buildDomainPolicy(task);
}