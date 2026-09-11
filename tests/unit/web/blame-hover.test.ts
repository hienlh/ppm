/**
 * The markdown behind the editor's blame hover.
 *
 * The security-relevant case is the commit message. Monaco strips `command:`
 * links from untrusted markdown, so the hover has to be trusted for its own
 * buttons to work at all — and a trusted string with `isTrusted: true` allows
 * *every* registered command. This string carries a commit message, and anyone
 * who can land a commit can write `[click](command:whatever)` in one. So there
 * are two independent defences and a test for each: the trust is narrowed to
 * this hover's own four commands, and the message is escaped so it cannot form
 * a link in the first place.
 */
import { describe, it, expect } from "bun:test";
import {
  BLAME_HOVER_COMMANDS,
  authorColour,
  authorInitials,
  avatarDataUri,
  buildBlameHoverMarkdown,
  escapeMarkdown,
} from "../../../src/web/lib/blame-hover.ts";
import { UNCOMMITTED_HASH, type BlameCommitInfo, type BlameLineDetail } from "../../../src/shared/blame.ts";

const COMMIT: BlameCommitInfo = {
  hash: "8abb115ec0ff33aabbccddeeff00112233445566",
  author: "Victor Nguyen",
  authorMail: "victor@example.com",
  authorTime: Math.floor(Date.UTC(2025, 11, 2, 9, 17) / 1000),
  summary: "feat: clean up migrations",
};

const DETAIL: BlameLineDetail = {
  ...COMMIT,
  message: "feat: clean up migrations\n\nA body paragraph.",
  removed: ["  const old = 1;"],
  added: ["  const next = 2;"],
};

const NOW = Date.UTC(2026, 8, 10);

function build(overrides: Partial<Parameters<typeof buildBlameHoverMarkdown>[0]> = {}) {
  return buildBlameHoverMarkdown({
    commit: COMMIT,
    detail: DETAIL,
    filePath: "src/a.ts",
    projectPath: "/repo",
    now: NOW,
    ...overrides,
  });
}

describe("escapeMarkdown", () => {
  it("defuses a link, which is how a command would be smuggled in", () => {
    const escaped = escapeMarkdown("see [click me](command:ppm.evil)");

    expect(escaped).not.toContain("[click me](");
    expect(escaped).toContain("\\[click me\\]");
  });

  it("escapes emphasis and code so a message reads as written", () => {
    expect(escapeMarkdown("*not bold* and `not code`")).toBe("\\*not bold\\* and \\`not code\\`");
  });

  it("escapes angle brackets, which the renderer would otherwise eat", () => {
    // Not a script that runs — the renderer drops the tag and keeps the text,
    // so `<script>alert(1)</script>` displayed as `alert(1)`: the commit
    // message silently rewritten in the one view meant to show it verbatim.
    expect(escapeMarkdown("<script>alert(1)</script>")).toBe("\\<script\\>alert\\(1\\)\\</script\\>");
  });

  it("leaves newlines alone", () => {
    expect(escapeMarkdown("one\ntwo")).toBe("one\ntwo");
  });
});

describe("authorInitials", () => {
  it("takes the first and last word", () => {
    expect(authorInitials("Victor Nguyen")).toBe("VN");
    expect(authorInitials("Ada Byron Lovelace")).toBe("AL");
  });

  it("handles one name, and no name", () => {
    expect(authorInitials("thawngho")).toBe("T");
    expect(authorInitials("   ")).toBe("?");
  });

  it("handles a non-ASCII name", () => {
    expect(authorInitials("Hiển Lê")).toBe("HL");
  });
});

describe("authorColour", () => {
  it("is stable for the same author", () => {
    expect(authorColour("Victor Nguyen")).toBe(authorColour("Victor Nguyen"));
  });

  it("is a bare hex triple, which is what the SVG fill needs", () => {
    expect(authorColour("Ada")).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe("avatarDataUri", () => {
  it("declares utf-8, or a non-ASCII initial draws as mojibake", () => {
    expect(avatarDataUri("Hiển Lê")).toContain("charset=utf-8");
  });

  it("carries no reference to a third party", () => {
    // Deliberately not a gravatar: that would send a hash of the committer's
    // email off-host on every hover.
    const uri = avatarDataUri("Victor Nguyen");

    expect(uri.startsWith("data:image/svg+xml")).toBe(true);
    expect(uri).not.toContain("gravatar");
  });

  it("escapes the initials into the SVG", () => {
    expect(decodeURIComponent(avatarDataUri("<b> Tag"))).toContain("&lt;T");
  });
});

describe("buildBlameHoverMarkdown", () => {
  it("is null for an uncommitted line", () => {
    // There is no commit to describe, and the annotation already says so.
    expect(build({ commit: { ...COMMIT, hash: UNCOMMITTED_HASH } })).toBeNull();
  });

  it("trusts only its own commands", () => {
    const md = build()!;

    expect(md.isTrusted).toEqual({ enabledCommands: [...BLAME_HOVER_COMMANDS] });
  });

  it("never trusts every command", () => {
    // `isTrusted: true` would let a commit message's own command link run
    // anything registered on the page.
    expect(build()!.isTrusted).not.toBe(true);
  });

  it("leaves HTML support off", () => {
    // The avatar is a markdown image precisely so this can stay off.
    expect(build()!.supportHtml).toBeUndefined();
  });

  it("shows both readings of the date", () => {
    const md = build()!;

    expect(md.value).toContain("9 months ago");
    expect(md.value).toContain("December 2nd, 2025");
  });

  it("shows the full message, not just the summary", () => {
    expect(build()!.value).toContain("A body paragraph.");
  });

  it("falls back to the blame summary before the detail arrives", () => {
    // The hover is built from whatever is ready, because Monaco reads it
    // synchronously — a spinner is what this editor is trying to stop having.
    const md = build({ detail: null })!;

    expect(md.value).toContain("clean up migrations");
    expect(md.value).not.toContain("```diff");
  });

  it("escapes the message it embeds", () => {
    const md = build({ detail: { ...DETAIL, message: "fix [x](command:ppm.evil) done" } })!;

    expect(md.value).not.toContain("[x](command:ppm.evil)");
  });

  it("puts the abbreviated sha on the button and the whole one in the command", () => {
    const md = build()!;

    expect(md.value).toContain("8abb115]");
    expect(md.value).toContain(encodeURIComponent(JSON.stringify([COMMIT.hash])));
  });

  it("offers the Git Graph views only with a project path", () => {
    // Those commands read a falsy first argument as "resolve the project
    // yourself", which for a hover naming one file could open another project.
    const withPath = build()!.value;
    const without = build({ projectPath: undefined })!.value;

    expect(withPath).toContain("File History");
    expect(without).not.toContain("File History");
    expect(without).toContain("8abb115]");
  });

  it("says added when the commit only added the line", () => {
    expect(build({ detail: { ...DETAIL, removed: [] } })!.value).toContain("Changes added in");
  });

  it("says changed when the commit replaced it", () => {
    const value = build()!.value;

    expect(value).toContain("Changes in `8abb115`");
    expect(value).not.toContain("Changes added in");
  });

  it("writes the diff as a fenced diff block with the markers git uses", () => {
    const value = build()!.value;

    expect(value).toContain("```diff");
    expect(value).toContain("-  const old = 1;");
    expect(value).toContain("+  const next = 2;");
  });

  it("omits the diff section entirely when the commit did not touch the line", () => {
    // A merge commit, or a commit that only moved the line.
    const md = build({ detail: { ...DETAIL, removed: [], added: [] } })!;

    expect(md.value).not.toContain("```diff");
    expect(md.value).not.toContain("Changes");
  });

  it("keeps a blank line before every rule", () => {
    // `text` then `---` on the next line is a setext heading in markdown, which
    // would turn the last line of a commit message into a title.
    for (const [index, line] of build()!.value.split("\n").entries()) {
      if (line === "---") expect(build()!.value.split("\n")[index - 1]).toBe("");
    }
  });

  it("has no relative date when the commit carries no timestamp", () => {
    const md = build({ commit: { ...COMMIT, authorTime: 0 } })!;

    expect(md.value).not.toContain("ago");
    expect(md.value).toContain("Victor Nguyen");
  });

  it("names an author git had none for", () => {
    expect(build({ commit: { ...COMMIT, author: "" } })!.value).toContain("Unknown");
  });
});
