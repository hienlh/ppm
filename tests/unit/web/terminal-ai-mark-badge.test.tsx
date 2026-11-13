/**
 * A terminal an AI typed into carries an "AI" badge on its tab chip, and the reason is written out
 * where a phone can read it: no hover is needed to learn why `ppm` there follows the AI-chat rules.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TERMINAL_AI_MARK_EXPLANATION, TerminalAiMarkBadge, isAiMarkedTerminalTab,
} from "../../../src/web/components/terminal/terminal-ai-mark-badge";

describe("the terminal AI badge", () => {
  it("marks only a terminal tab whose metadata says an AI typed into it", () => {
    expect(isAiMarkedTerminalTab({ type: "terminal", metadata: { aiMark: true } })).toBe(true);
    for (const tab of [
      { type: "terminal" }, { type: "terminal", metadata: { aiMark: "yes" } }, { type: "editor", metadata: { aiMark: true } },
    ]) expect(isAiMarkedTerminalTab(tab)).toBe(false);
  });

  it("reads AI, names itself for a screen reader, and explains the mark", () => {
    const html = renderToStaticMarkup(<TerminalAiMarkBadge />);
    expect(html).toContain(">AI</span>");
    expect(html).toContain('aria-label="Typed by an AI"');
    expect(TERMINAL_AI_MARK_EXPLANATION).toContain("ppm commands here follow the AI-chat rules");
    expect(TERMINAL_AI_MARK_EXPLANATION).toContain("A terminal you open yourself does not");
  });
});
