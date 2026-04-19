import { describe, expect, it } from "bun:test";
import { scoreFileSearch, compareScores, type FileSearchScore } from "../../../src/web/lib/score-file-search";

/** Helper: score and sort candidates, return labels in ranked order */
function ranked(query: string, candidates: Array<{ label: string; path: string }>): string[] {
  const scored: Array<{ label: string; score: FileSearchScore }> = [];
  for (const c of candidates) {
    const s = scoreFileSearch(query, c.label, c.path);
    if (s) scored.push({ label: c.label, score: s });
  }
  scored.sort((a, b) => compareScores(a.score, b.score));
  return scored.map((s) => s.label);
}

describe("scoreFileSearch", () => {
  it("returns null for non-matching query", () => {
    expect(scoreFileSearch("xyz", "README.md", "README.md")).toBeNull();
  });

  it("tier 0: exact filename match (case-insensitive)", () => {
    const s = scoreFileSearch("readme.md", "README.md", "README.md");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(0);
  });

  it("tier 1: filename prefix match", () => {
    const s = scoreFileSearch("read", "README.md", "README.md");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(1);
  });

  it("tier 2: filename contains query", () => {
    const s = scoreFileSearch("adme", "README.md", "README.md");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(2);
  });

  it("tier 3: path contains query but filename doesn't", () => {
    const s = scoreFileSearch("260419", "plan.md", "plans/260419/plan.md");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(3);
  });

  it("tier 4: fuzzy match on filename", () => {
    const s = scoreFileSearch("rdm", "README.md", "README.md");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(4);
  });

  it("tier 5: fuzzy match on path only", () => {
    const s = scoreFileSearch("plnmd", "index.ts", "plans/some/plan.md/index.ts");
    expect(s).not.toBeNull();
    expect(s!.tier).toBe(5);
  });
});

describe("ranking — the screenshot bug", () => {
  const candidates = [
    { label: "implementation-260419-16...", path: "docs/journals/implementation-260419" },
    { label: "phase-01-types-and-state...", path: "plans/260419-2309-workflow-engine/phase-01" },
    { label: "phase-02-node-registry-a...", path: "plans/260419-2309-workflow-engine/phase-02" },
    { label: "phase-02-create-video-co...", path: "plans/260419-2334-integrate-editly/phase-02" },
    { label: "phase-03-add-compose-c...", path: "plans/260419-2334-integrate-editly/phase-03" },
    { label: "docs-manager-260419-16...", path: "plans/reports/docs-manager-260419" },
    { label: "project-manager-260420-...", path: "plans/reports/project-manager-260420" },
    { label: "README.md", path: "README.md" },
  ];

  it("ranks README.md first when searching 'readme.md'", () => {
    const result = ranked("readme.md", candidates);
    expect(result[0]).toBe("README.md");
  });

  it("ranks README.md first when searching 'readme'", () => {
    const result = ranked("readme", candidates);
    expect(result[0]).toBe("README.md");
  });

  it("ranks README.md first when searching 'README'", () => {
    const result = ranked("README", candidates);
    expect(result[0]).toBe("README.md");
  });
});

describe("ranking — general file search quality", () => {
  const candidates = [
    { label: "config.service.ts", path: "src/services/config.service.ts" },
    { label: "config-validation.test.ts", path: "tests/unit/config-validation.test.ts" },
    { label: "some-config-helper.ts", path: "src/lib/some-config-helper.ts" },
    { label: "package.json", path: "package.json" },
  ];

  it("exact filename match beats substring match", () => {
    const result = ranked("package.json", candidates);
    expect(result[0]).toBe("package.json");
  });

  it("prefix match ranks before substring match", () => {
    const result = ranked("config", candidates);
    // Both config.service.ts and config-validation.test.ts are prefix matches
    expect(result[0]).toBe("config.service.ts");
    expect(result[1]).toBe("config-validation.test.ts");
    // some-config-helper is substring (contains), should be after
    expect(result.indexOf("some-config-helper.ts")).toBeGreaterThan(1);
  });

  it("shorter filename wins within same tier", () => {
    const files = [
      { label: "utils.ts", path: "src/utils.ts" },
      { label: "test-utils.ts", path: "src/test-utils.ts" },
      { label: "utils-helper.ts", path: "src/lib/utils-helper.ts" },
    ];
    const result = ranked("utils", files);
    expect(result[0]).toBe("utils.ts");
  });
});
