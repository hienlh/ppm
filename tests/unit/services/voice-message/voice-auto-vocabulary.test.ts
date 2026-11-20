import { describe, expect, it } from "bun:test";
import {
  instructionTermsOf, rankVocabulary, termOf, termsInText,
} from "../../../../src/services/voice-message/voice-auto-vocabulary.ts";

describe("termOf", () => {
  it("keeps names, acronyms, identifiers and task codes as strong terms", () => {
    for (const t of ["PPM", "NX-2231", "ppm/53", "vn-legal-rag", "Bun.spawn", "SQLite", "P45"]) {
      expect(termOf(t)).toEqual({ term: t, strong: true });
    }
  });

  it("keeps a plain English word as weak, and drops everyday words, short words and Vietnamese", () => {
    expect(termOf("worktree")).toEqual({ term: "worktree", strong: false });
    expect(termOf("Hono")).toEqual({ term: "Hono", strong: false });
    for (const t of ["the", "release", "ok", "lệnh", "đi", "12", "https://x.y", "a/b/c"]) expect(termOf(t)).toBeNull();
  });

  it("drops the punctuation around a word, not inside it", () => {
    expect(termOf("(Telegram),")).toEqual({ term: "Telegram", strong: false });
    expect(termOf("`ppm/51`.")).toEqual({ term: "ppm/51", strong: true });
  });
});

describe("termsInText", () => {
  it("takes only strong terms from a Vietnamese sentence: its plain words are Vietnamese without marks", () => {
    expect(termsInText("Voice tự học từ vựng trong PPM theo ppm/53").map((t) => t.term)).toEqual(["PPM", "ppm/53"]);
  });

  it("takes weak terms too from an English sentence", () => {
    expect(termsInText("Release the worktree cleanup for Hono").map((t) => t.term)).toEqual(["worktree", "cleanup", "Hono"]);
  });
});

describe("rankVocabulary", () => {
  it("puts the project's own name first, then by weight, and keeps the most-weighted spelling", () => {
    const ranked = rankVocabulary({
      projectNames: ["PPM"],
      taskCodes: ["ppm/53", "ppm/51"],
      taskTitles: ["Telegram voice off says so", "Telegram audio files"],
      chatTitles: ["ppm voice notes"],
      instructionTerms: ["getPpmDir", "Hono"],
    });
    expect(ranked[0]).toEqual({ term: "PPM", score: 20, strong: true });
    expect(ranked.map((r) => r.term).slice(1, 3)).toEqual(["ppm/53", "ppm/51"]);
    expect(ranked.find((r) => r.term === "Telegram")).toMatchObject({ strong: false });
    // "ppm" from a chat title adds to PPM rather than becoming a second entry.
    expect(ranked.filter((r) => r.term.toLowerCase() === "ppm")).toHaveLength(1);
  });

  it("caps task codes, so a busy board cannot fill the list with codes", () => {
    const codes = Array.from({ length: 20 }, (_, i) => `ppm/${i + 1}`);
    expect(rankVocabulary({ taskCodes: codes }).length).toBe(8);
  });
});

describe("instructionTermsOf", () => {
  it("reads backticked terms and heading words, skipping fenced code", () => {
    const md = "# Stack Hono\nUse `Bun.spawn` and `getPpmDir()`.\n```\n`NotThis`\n```\n";
    expect(instructionTermsOf(md)).toEqual(["Stack", "Hono", "Bun.spawn"]);
  });
});
