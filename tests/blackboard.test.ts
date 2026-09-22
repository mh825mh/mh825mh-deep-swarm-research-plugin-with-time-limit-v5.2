import { describe, it, expect } from "vitest";
import { SwarmBlackboard } from "../src/swarm/blackboard";
import { ResearchPlan, EvidenceCard, BlockedUrlEntry } from "../src/types";

function makePlan(): ResearchPlan {
  return {
    workers: [
      {
        role: "academic",
        label: "Academic Worker",
        queries: ["q1"],
        budgetWeight: 0.2,
        followLinks: false,
      },
    ],
    questions: ["Q1"],
    stopConditions: ["stop"],
    estimatedRemainingMs: 60_000,
    citationPolicy: "index-only",
    domainTags: ["medicine"],
  };
}

function makeCard(id: string): EvidenceCard {
  return {
    id,
    entityType: "web",
    title: `Title ${id}`,
    authorOrHost: "example.com",
    canonicalUrl: `https://example.com/${id}`,
    sourceTier: "news",
    relevantClaim: "claim",
    supportingExcerpt: "excerpt",
    confidence: "High",
    claimStrength: "disputed",
    freshness: "2024-01-01",
    worker: "Breadth",
    verificationTier: "B",
    metadataConfidence: 0.6,
    topicFit: 0.7,
    recommendationStrength: 0.5,
    entityMetadata: undefined,
  };
}

function makeBlocked(): BlockedUrlEntry[] {
  return [
    {
      url: "https://blocked.example/a",
      reason: "domain blacklist",
      count: 3,
    },
  ];
}

describe("SwarmBlackboard", () => {
  it("stores the plan and gaps", () => {
    const bb = new SwarmBlackboard(() => [], Infinity);
    bb.attachPlan(makePlan());
    bb.addGap("Regulatory landscape");
    bb.addGap("Regulatory landscape"); // dedupe
    const snap = bb.snapshot();
    expect(snap.plan?.domainTags).toEqual(["medicine"]);
    expect(snap.gaps).toEqual(["Regulatory landscape"]);
  });

  it("exposes blocked urls through the callback and computes time-left", () => {
    const bb = new SwarmBlackboard(() => makeBlocked(), Date.now() + 5000);
    expect(bb.blockedUrls[0].url).toContain("blocked.example");
    expect(bb.timeLeft()).toBeGreaterThan(0);
    expect(bb.timeLeft()).toBeLessThanOrEqual(5000);
  });

  it("returns Infinity time-left for an unbounded deadline", () => {
    const bb = new SwarmBlackboard(() => [], Infinity);
    expect(bb.timeLeft()).toBe(Infinity);
  });

  it("returns 0 time-left after the deadline passes", () => {
    const bb = new SwarmBlackboard(() => [], Date.now() - 10_000);
    expect(bb.timeLeft()).toBe(0);
  });

  it("merges cards and graded cards idempotently", () => {
    const bb = new SwarmBlackboard(() => [], Infinity);
    bb.mergeCards([makeCard("E1")]);
    bb.mergeCards([makeCard("E1"), makeCard("E2")]);
    expect(bb.cards).toHaveLength(2);

    const graded = { ...makeCard("E1"), critic: {
      cardId: "E1", onTopic: true, dated: "dated", sourceNature: "primary",
      contradicts: [], claimStrength: "documented", pass: true, note: "",
    } };
    bb.mergeGraded([graded]);
    bb.mergeGraded([graded]);
    expect(bb.gradedCards).toHaveLength(1);

    // replaceGraded wipes prior content and re-merges
    const graded2 = { ...makeCard("E2"), critic: {
      cardId: "E2", onTopic: false, dated: "undated", sourceNature: "unknown",
      contradicts: [], claimStrength: "speculation", pass: false, note: "",
    } };
    bb.replaceGraded([graded2]);
    expect(bb.gradedCards).toHaveLength(1);
    expect(bb.gradedCards[0].id).toBe("E2");
  });
});