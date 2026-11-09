/**
 * The chat footer's right end is one chip-shaped group: a labelled ring per usage window
 * ("5h 47%", "Wk 52%"), each coloured on its own, then History and ···. Other accounts' figures
 * are never shown; a window with no figure is not drawn, and with no figure at all there is no
 * usage part — and no divider, which belongs to it.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatFooterTools } from "../../../src/web/components/chat/chat-footer-tools.tsx";

describe("session account usage chip", () => {
  test("shows no ring when the snapshot belongs to a different account than the picked one", () => {
    const html = renderToStaticMarkup(<ChatFooterTools
      projectName="test"
      providerId="claude"
      pickedAccountId="developers"
      pickedAccountLabel="Developers"
      usageInfo={{ activeAccountId: "vincent", fiveHour: 0, sevenDay: 1 }}
    />);
    expect(html).not.toContain("100%");
    expect(html).not.toContain("--%");
    expect(html).not.toContain("data-usage-ring");
  });

  test("shows the selected account's quota when its snapshot arrives", () => {
    const html = renderToStaticMarkup(<ChatFooterTools
      projectName="test"
      providerId="claude"
      pickedAccountId="developers"
      pickedAccountLabel="Developers"
      usageInfo={{ activeAccountId: "developers", fiveHour: 0, sevenDay: 0.82 }}
    />);
    expect(html).toContain("82%");
    expect(html).not.toContain("--%");
    expect(html).toContain("Developers");
  });

  test("does not borrow another account's name when the selected label is missing", () => {
    const html = renderToStaticMarkup(<ChatFooterTools
      projectName="test"
      providerId="claude"
      pickedAccountId="developers"
      usageInfo={{ activeAccountId: "vincent", activeAccountLabel: "Vincent", sevenDay: 1 }}
    />);
    expect(html).not.toContain("Vincent");
    expect(html).not.toContain("100%");
  });

  test("shows no ring before any usage figure exists", () => {
    const html = renderToStaticMarkup(<ChatFooterTools projectName="test" providerId="claude" usageInfo={{}} />);
    expect(html).not.toContain("data-usage-ring");
    expect(html).not.toContain("--%");
  });

  test("uses the session snapshot when there is no picked account", () => {
    const html = renderToStaticMarkup(<ChatFooterTools
      projectName="test"
      providerId="claude"
      usageInfo={{ activeAccountId: "developers", activeAccountLabel: "Developers", sevenDay: 0.82 }}
    />);
    expect(html).toContain("Developers");
    expect(html).toContain("82%");
  });

  test("labels each window and colours it on its own", () => {
    const html = renderToStaticMarkup(<ChatFooterTools
      projectName="test"
      providerId="claude"
      usageInfo={{ activeAccountId: "a", fiveHour: 0.47, sevenDay: 0.93 }}
    />);
    const h5 = html.slice(html.indexOf('data-usage-window="5h"'));
    const wk = html.slice(html.indexOf('data-usage-window="Wk"'));
    expect(h5).toMatch(/^data-usage-window="5h"[^]*?>5h<\/span><span class="[^"]*text-text-2[^"]*">47%/);
    expect(wk).toMatch(/^data-usage-window="Wk"[^]*?>Wk<\/span><span class="[^"]*text-error[^"]*">93%/);
    expect(html).toContain("data-usage-divider");
  });

  test("a window with no figure hides alone", () => {
    const html = renderToStaticMarkup(<ChatFooterTools projectName="test" providerId="claude" usageInfo={{ activeAccountId: "a", sevenDay: 0.52 }} />);
    expect(html).not.toContain('data-usage-window="5h"');
    expect(html).toContain('data-usage-window="Wk"');
    expect(html).toContain("data-usage-divider");
  });

  test("no usage, no divider: History follows nothing", () => {
    const html = renderToStaticMarkup(<ChatFooterTools projectName="test" providerId="claude" usageInfo={{}} />);
    expect(html).toContain("data-footer-cluster");
    expect(html).not.toContain("data-usage-divider");
  });

  test("on a narrow chat with connection trouble the usage and its divider give way together", () => {
    const html = renderToStaticMarkup(<ChatFooterTools projectName="test" providerId="claude" connectionTrouble usageInfo={{ activeAccountId: "a", fiveHour: 0.2 }} />);
    const divider = html.match(/<span[^>]*data-usage-divider[^>]*>/)?.[0] ?? "";
    const usage = html.match(/<button[^>]*data-usage-ring[^>]*>/)?.[0] ?? "";
    expect(divider).toContain("@max-[420px]/chat:hidden");
    expect(usage).toContain("@max-[420px]/chat:hidden");
  });
});
