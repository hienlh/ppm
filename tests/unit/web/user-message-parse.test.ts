/**
 * user-message-parse — decomposition of stored user-message content.
 *
 * Covers both consumers: the transcript bubble (parseUserMessage) and the
 * composer's ArrowUp history recall (toComposerDraft), which must give back what
 * the user typed rather than the wrapped payload that was actually sent.
 */
import { describe, it, expect } from "bun:test";

import { parseUserMessage, toComposerDraft, parseUserAttachments } from "../../../src/web/components/chat/user-message-parse.ts";

describe("parseUserMessage", () => {
  it("leaves plain text untouched", () => {
    const p = parseUserMessage("just a question");
    expect(p.text).toBe("just a question");
    expect(p.agent).toBeNull();
    expect(p.command).toBeNull();
    expect(p.files).toEqual([]);
  });

  it("splits the agent delegation prefix off as a chip", () => {
    const p = parseUserMessage("Use the planner agent to draft the migration");
    expect(p.agent).toBe("planner");
    expect(p.text).toBe("draft the migration");
  });

  it("pulls single and multi attachment markers out of the body", () => {
    expect(parseUserMessage("[Attached file: /tmp/a.png]\nlook at this").files).toEqual(["/tmp/a.png"]);
    const multi = parseUserMessage("[Attached files:\n/tmp/a.png\n/tmp/b.png\n]\ncompare these");
    expect(multi.files).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(multi.text).toBe("compare these");
  });

  it("extracts the IDE-opened-file context tag", () => {
    const raw = "<ide_opened_file>The user opened the file /repo/src/app.ts in the IDE.</ide_opened_file>\nexplain this";
    const p = parseUserMessage(raw);
    expect(p.idePath).toBe("/repo/src/app.ts");
    expect(p.text).toBe("explain this");
  });

  it("collects system-injected tags as badges, not body text", () => {
    const p = parseUserMessage("<system-reminder>be brief</system-reminder>hello");
    expect(p.text).toBe("hello");
    expect(p.tags.map((t) => t.label)).toEqual(["Context"]);
  });

  it("folds slash-command args into the display text but keeps body separate", () => {
    const raw = "<command-name>/ak:plan</command-name><command-args>add auth</command-args>";
    const p = parseUserMessage(raw);
    expect(p.command).toEqual({ name: "/ak:plan", args: "add auth" });
    expect(p.text).toBe("add auth");
    expect(p.body).toBe("");
  });
});

describe("toComposerDraft", () => {
  it("returns plain text as-is", () => {
    expect(toComposerDraft("just a question")).toEqual({ agent: null, text: "just a question" });
  });

  it("restores the agent as a chip instead of inline prose", () => {
    expect(toComposerDraft("Use the planner agent to draft the migration")).toEqual({
      agent: "planner",
      text: "draft the migration",
    });
  });

  it("drops attachment markers — files cannot be re-attached from a keystroke", () => {
    expect(toComposerDraft("[Attached file: /tmp/a.png]\nlook at this")).toEqual({
      agent: null,
      text: "look at this",
    });
  });

  it("drops injected IDE context", () => {
    const raw = "<ide_opened_file>The user opened the file /repo/src/app.ts in the IDE.</ide_opened_file>\nexplain this";
    expect(toComposerDraft(raw)).toEqual({ agent: null, text: "explain this" });
  });

  it("rebuilds a slash command into its typed form", () => {
    const raw = "<command-name>ak:plan</command-name><command-args>add auth</command-args>";
    expect(toComposerDraft(raw)).toEqual({ agent: null, text: "/ak:plan add auth" });
  });

  it("does not double the slash when the stored name already has one", () => {
    const raw = "<command-name>/ak:plan</command-name><command-args>add auth</command-args>";
    expect(toComposerDraft(raw)).toEqual({ agent: null, text: "/ak:plan add auth" });
  });

  it("keeps an argument-less command usable", () => {
    expect(toComposerDraft("<command-name>/clear</command-name>")).toEqual({ agent: null, text: "/clear" });
  });

  it("handles an attachment and an agent together", () => {
    const raw = "[Attached file: /tmp/a.png]\nUse the tester agent to check this";
    expect(toComposerDraft(raw)).toEqual({ agent: "tester", text: "check this" });
  });

  it("gives back an empty draft for an attachment-only message", () => {
    expect(toComposerDraft("[Attached file: /tmp/a.png]")).toEqual({ agent: null, text: "" });
  });
});

/**
 * An image sent inline carries a different marker from one sent by path — the model must not
 * be told to open a file it was already handed. Both still name the path, because the chat
 * re-renders from the transcript and the path is what a thumbnail is drawn from.
 */
describe("parseUserAttachments — inline image marker", () => {
  const inline = (p: string) => `[Attached image (contents included in this message): ${p}]`;

  it("extracts the path from an inline-image marker", () => {
    const out = parseUserAttachments(`${inline("C:/up/a.png")}\n\nwhat is this?`);
    expect(out.files).toEqual(["C:/up/a.png"]);
    expect(out.text).toBe("what is this?");
  });

  it("handles several inline images on one message", () => {
    const out = parseUserAttachments(`${inline("/up/a.png")}\n${inline("/up/b.png")}\n\nboth`);
    expect(out.files).toEqual(["/up/a.png", "/up/b.png"]);
    expect(out.text).toBe("both");
  });

  // A HEIC that could not be downscaled travels by path in the same message as a PNG that could.
  it("mixes an inline image with a plain file attachment", () => {
    const out = parseUserAttachments(`${inline("/up/a.png")}\n\n[Attached file: /up/b.heic]\n\nhi`);
    expect(out.files).toEqual(["/up/a.png", "/up/b.heic"]);
    expect(out.text).toBe("hi");
  });

  it("an inline image with no text leaves the text empty", () => {
    const out = parseUserAttachments(inline("/up/a.png"));
    expect(out.files).toEqual(["/up/a.png"]);
    expect(out.text).toBe("");
  });

  it("the plain file marker still parses as before", () => {
    const out = parseUserAttachments("[Attached file: /up/a.txt]\n\nread it");
    expect(out.files).toEqual(["/up/a.txt"]);
    expect(out.text).toBe("read it");
  });
});
