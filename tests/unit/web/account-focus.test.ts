/**
 * "Show this account in Settings": the request waits for a pane to take it, and the card is
 * scrolled to once it has rendered.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ACCOUNT_FOCUS_EVENT, requestAccountFocus, revealAccountCard, takeAccountFocus } = await import("../../../src/web/components/settings/accounts/account-focus");

describe("account focus", () => {
  it("keeps the request for one taker and announces it", () => {
    let heard = 0;
    const on = () => { heard++; };
    window.addEventListener(ACCOUNT_FOCUS_EVENT, on);
    requestAccountFocus({ provider: "codex", accountId: "c2" });
    window.removeEventListener(ACCOUNT_FOCUS_EVENT, on);
    expect(heard).toBe(1);
    expect(takeAccountFocus()).toEqual({ provider: "codex", accountId: "c2" });
    expect(takeAccountFocus()).toBeNull();
  });

  it("scrolls to the card once it appears", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const scrolled: string[] = [];
    revealAccountCard(() => root, "a 2", 2000);
    await new Promise((r) => setTimeout(r, 150));
    const card = document.createElement("div");
    card.setAttribute("data-account-id", "a 2");
    card.scrollIntoView = () => { scrolled.push("a 2"); };
    root.appendChild(card);
    await new Promise((r) => setTimeout(r, 250));
    expect(scrolled).toEqual(["a 2"]);
    root.remove();
  });
});
