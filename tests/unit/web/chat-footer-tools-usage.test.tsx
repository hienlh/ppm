/**
 * The usage ring in the chat footer's right end shows the highest of 5h/week percent,
 * labeled with the account that put it there. Other accounts' figures are never shown, and with
 * no figure for this chat's account there is no ring at all rather than a "--%".
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
});
