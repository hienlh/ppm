import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryBar } from "../../../src/web/components/chat/chat-history-bar.tsx";

describe("session account usage chip", () => {
  test("does not label Vincent's cached quota as Developers after rotation", () => {
    const html = renderToStaticMarkup(<ChatHistoryBar projectName="test" providerId="claude"
      pickedAccountId="developers" pickedAccountLabel="Developers"
      usageInfo={{ activeAccountId: "vincent", fiveHour: 0, sevenDay: 1 }} />);
    expect(html).toContain("Developers");
    expect(html).not.toContain("100%");
    expect(html).toContain("--%");
  });

  test("shows the selected account's quota when its snapshot arrives", () => {
    const html = renderToStaticMarkup(<ChatHistoryBar projectName="test" providerId="claude"
      pickedAccountId="developers" pickedAccountLabel="Developers"
      usageInfo={{ activeAccountId: "developers", fiveHour: 0, sevenDay: 0.82 }} />);
    expect(html).toContain("82%");
    expect(html).not.toContain("--%");
  });

  test("does not borrow another account's name when the selected label is missing", () => {
    const html = renderToStaticMarkup(<ChatHistoryBar projectName="test" providerId="claude"
      pickedAccountId="developers"
      usageInfo={{ activeAccountId: "vincent", activeAccountLabel: "Vincent", sevenDay: 1 }} />);
    expect(html).not.toContain("Vincent");
    expect(html).not.toContain("100%");
  });

  test("uses the session snapshot when there is no stream override", () => {
    const html = renderToStaticMarkup(<ChatHistoryBar projectName="test" providerId="claude"
      usageInfo={{ activeAccountId: "developers", activeAccountLabel: "Developers", sevenDay: 0.82 }} />);
    expect(html).toContain("Developers");
    expect(html).toContain("82%");
  });
});
