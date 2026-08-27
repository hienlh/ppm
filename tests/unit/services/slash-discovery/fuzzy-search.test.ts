import { describe, it, expect } from "bun:test";
import {
  levenshtein,
  scoreFuzzy,
  searchSlashItems,
} from "../../../../src/services/slash-discovery/fuzzy-search.ts";
import type { SlashItem } from "../../../../src/services/slash-discovery/types.ts";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns correct distance for empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("calculates distance correctly for known pairs", () => {
    // kitten -> sitting should be 3 (substitute k->s, e->i, insert g)
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("saturday", "sunday")).toBe(3);
    expect(levenshtein("cat", "dog")).toBe(3);
  });

  it("handles single character differences", () => {
    expect(levenshtein("a", "b")).toBe(1);
    expect(levenshtein("ab", "ac")).toBe(1);
  });

  it("is case-sensitive", () => {
    expect(levenshtein("Hello", "hello")).toBe(1); // capital H
  });
});

describe("scoreFuzzy", () => {
  it("returns rank 0 (prefix match) when query is prefix of candidate", () => {
    const score = scoreFuzzy("dev", "develop");
    expect(score).toEqual({ rank: 0, distance: 0 });
  });

  it("handles case-insensitive prefix match", () => {
    const score = scoreFuzzy("DEV", "develop");
    expect(score).toEqual({ rank: 0, distance: 0 });
  });

  it("returns rank 1 (contains) when query is substring but not prefix", () => {
    const score = scoreFuzzy("build", "rebuild");
    expect(score).toEqual({ rank: 1, distance: 2 }); // "rebuild".indexOf("build") = 2
  });

  it("returns rank 0 (prefix) for 'test' in 'testing'", () => {
    const score = scoreFuzzy("test", "testing");
    expect(score).not.toBeNull();
    expect(score!.rank).toBe(0); // "test" is prefix of "testing"
  });

  it("returns null when no reasonable match", () => {
    const score = scoreFuzzy("xyz", "abcdefghijklmnop");
    expect(score).toBeNull();
  });

  it("prioritizes prefix over contains", () => {
    const prefixScore = scoreFuzzy("skill", "skill-loader");
    const containsScore = scoreFuzzy("skill", "reskill");
    expect(prefixScore!.rank).toBeLessThan(containsScore!.rank);
  });

  it("uses Levenshtein distance up to maxDist threshold", () => {
    const score = scoreFuzzy("tst", "test");
    // "tst" vs "test" should have low distance, so should match at rank 2
    expect(score).not.toBeNull();
    expect(score!.rank).toBe(2);
  });
});

describe("searchSlashItems", () => {
  const sampleItems: SlashItem[] = [
    {
      type: "skill",
      name: "review",
      description: "Review code changes",
      scope: "user",
    },
    {
      type: "skill",
      name: "test",
      description: "Run test suite",
      scope: "user",
    },
    {
      type: "skill",
      name: "deploy",
      description: "Deploy to production",
      scope: "project",
    },
    {
      type: "command",
      name: "help",
      description: "Show help information",
      scope: "user",
    },
    {
      type: "skill",
      name: "debug",
      description: "Debug and troubleshoot",
      scope: "bundled",
    },
  ];

  it("returns all items when query is empty", () => {
    const results = searchSlashItems(sampleItems, "");
    expect(results).toHaveLength(5);
  });

  it("filters items by prefix match in name", () => {
    const results = searchSlashItems(sampleItems, "de");
    expect(results.map((r) => r.name)).toContain("deploy");
    expect(results.map((r) => r.name)).toContain("debug");
  });

  it("filters items by fuzzy match in description", () => {
    const results = searchSlashItems(sampleItems, "production");
    const names = results.map((r) => r.name);
    expect(names).toContain("deploy");
  });

  it("ranks prefix matches higher than contains matches", () => {
    const results = searchSlashItems(sampleItems, "test");
    // "test" is exact match in name (test), should come before any contains match
    expect(results[0]!.name).toBe("test");
  });

  it("applies limit to results when query is provided", () => {
    const results = searchSlashItems(sampleItems, "e", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("scores and ranks items by best match (name or description)", () => {
    const results = searchSlashItems(sampleItems, "code");
    // "code" should match "review" (description: "Review code changes")
    const names = results.map((r) => r.name);
    expect(names).toContain("review");
  });

  it("case-insensitively matches query and names", () => {
    const results = searchSlashItems(sampleItems, "REVIEW");
    expect(results.map((r) => r.name)).toContain("review");
  });

  it("sorts results by rank then distance then name", () => {
    const items: SlashItem[] = [
      {
        type: "skill",
        name: "zebra",
        description: "Starts with test",
        scope: "user",
      },
      {
        type: "skill",
        name: "test",
        description: "Exact name match",
        scope: "user",
      },
      {
        type: "skill",
        name: "contest",
        description: "Contains test",
        scope: "user",
      },
    ];
    const results = searchSlashItems(items, "test");
    // Prefix match ("test" name) should come first (rank 0)
    // Followed by other rank 0 match from description
    // Followed by contains match ("contest")
    expect(results[0]!.name).toBe("test");
    expect(results[1]!.name).toBe("contest");
  });

  it("respects custom limit parameter when query is provided", () => {
    const results = searchSlashItems(sampleItems, "e", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe("searchSlashItems — recency ordering", () => {
  const item = (name: string, description = ""): SlashItem =>
    ({ type: "skill", name, description, scope: "user" });

  it("orders recent matches most-recent-first, not alphabetically", () => {
    const items = [item("alpha-run"), item("beta-run"), item("gamma-run")];

    const results = searchSlashItems(items, "run", 20, ["gamma-run", "alpha-run"]);

    expect(results.map((i) => i.name)).toEqual(["gamma-run", "alpha-run", "beta-run"]);
  });

  it("keeps recency ahead of match offset for contains-matches", () => {
    // Same tier, different offsets (2 vs 4) — the offset used to decide every
    // comparison before recency was ever read.
    const items = [item("aadeploy"), item("bbbbdeploy")];

    const results = searchSlashItems(items, "deploy", 20, ["bbbbdeploy"]);

    expect(results[0]!.name).toBe("bbbbdeploy");
  });

  it("promotes a recent item one tier — a recent contains-hit beats a stranger's prefix-hit", () => {
    const items = [item("test"), item("latest")];

    const results = searchSlashItems(items, "test", 20, ["latest"]);

    expect(results[0]!.name).toBe("latest");
  });

  it("does not boost a recent item that only matched in its description", () => {
    // Otherwise every recent item floats to the top of every search, since prose
    // contains almost any short query.
    const items = [item("deploy"), item("git-manager", "Handles code deduplication")];

    const results = searchSlashItems(items, "de", 20, ["git-manager"]);

    expect(results[0]!.name).toBe("deploy");
  });

  it("still boosts when the name matched the winning tier but the description matched closer", () => {
    // "review" sits at offset 5 in the name and offset 3 in the description —
    // the description winning on offset must not disqualify the boost.
    const items = [
      item("code-reviewer", "Pre-review helper"),
      item("ak:code-review", "Audit changes"),
    ];

    const results = searchSlashItems(items, "review", 20, ["code-reviewer"]);

    expect(results[0]!.name).toBe("code-reviewer");
  });

  it("stops at one tier — a recent fuzzy-hit still loses to a prefix-hit", () => {
    // "tost" only matches "test" by edit distance (two tiers below a prefix hit).
    const items = [item("test"), item("tost")];

    const results = searchSlashItems(items, "test", 20, ["tost"]);

    expect(results[0]!.name).toBe("test");
  });

  it("falls back to match offset, then name, when nothing is recent", () => {
    // zeta-run/alfa-run share offset 5 so the name decides; gamma-run's offset
    // is 6 and must sort after both.
    const items = [item("gamma-run"), item("zeta-run"), item("alfa-run")];

    const results = searchSlashItems(items, "run", 20, []);

    expect(results.map((i) => i.name)).toEqual(["alfa-run", "zeta-run", "gamma-run"]);
  });

  it("matches the unfiltered picker's recency order for the same items", () => {
    const recentNames = ["deploy", "review"];
    const items = [item("review"), item("deploy"), item("debug")];

    const searched = searchSlashItems(items, "e", 20, recentNames);

    expect(searched.slice(0, 2).map((i) => i.name)).toEqual(recentNames);
  });
});
