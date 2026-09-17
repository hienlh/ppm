import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexContextSettings } from "../../../src/web/components/settings/codex-context-settings";

describe("Codex context settings", () => {
  test("selects Codex defaults and explains when overrides take effect", () => {
    const html = renderToStaticMarkup(<CodexContextSettings saving={false} onSave={async () => true} />);
    expect(html.match(/value="default" selected=""/g)).toHaveLength(2);
    expect(html).not.toContain('type="number"');
    expect(html).toContain("Context window (tokens)");
    expect(html).toContain("Auto-compact threshold (tokens)");
    expect(html).toContain("after a PPM restart");
  });

  test("renders both persisted limits for editing", () => {
    const html = renderToStaticMarkup(<CodexContextSettings saving={false} onSave={async () => true}
      config={{ model_context_window: 872000, model_auto_compact_token_limit: 750000 }} />);
    expect(html).toContain('value="872000" selected=""');
    expect(html).toContain('value="750000" selected=""');
  });

  test("keeps existing non-preset limits editable as custom values", () => {
    const html = renderToStaticMarkup(<CodexContextSettings saving={false} onSave={async () => true}
      config={{ model_context_window: 650000, model_auto_compact_token_limit: 550000 }} />);
    expect(html.match(/value="custom" selected=""/g)).toHaveLength(2);
    expect(html).toContain('value="650000"');
    expect(html).toContain('value="550000"');
  });

  test("disables context inputs and submission while saving", () => {
    const html = renderToStaticMarkup(<CodexContextSettings compact saving onSave={async () => true} />);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Saving...");
  });
});
