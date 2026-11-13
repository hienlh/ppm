/**
 * "Show me this account in Settings": the chat's Switch account view asks for one account, and
 * the Accounts pane opens that provider's sub-tab and scrolls the account's card into view.
 *
 * The request is kept until a pane takes it, because the pane is usually not mounted yet when it
 * is made (Settings opens right after); an already mounted pane hears the event instead.
 */

export type AccountFocusProvider = "claude" | "codex";
export interface AccountFocus { provider: AccountFocusProvider; accountId: string }

export const ACCOUNT_FOCUS_EVENT = "ppm:accounts-focus";

let pending: AccountFocus | null = null;

export function requestAccountFocus(focus: AccountFocus): void {
  pending = focus;
  window.dispatchEvent(new CustomEvent(ACCOUNT_FOCUS_EVENT));
}

/** The request not yet acted on, which is then cleared. */
export function takeAccountFocus(): AccountFocus | null {
  const f = pending;
  pending = null;
  return f;
}

/**
 * Scroll the card into view once it is rendered (the pane loads its accounts after mounting) and
 * briefly ring it, so the eye lands on it. Gives up after `timeoutMs`. Returns a cancel function.
 */
export function revealAccountCard(root: () => ParentNode | null, accountId: string, timeoutMs = 5000): () => void {
  const started = Date.now();
  const timer = setInterval(() => {
    const card = [...(root()?.querySelectorAll<HTMLElement>("[data-account-id]") ?? [])]
      .find((el) => el.getAttribute("data-account-id") === accountId);
    if (card) {
      clearInterval(timer);
      card.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      card.animate?.(
        [{ boxShadow: "0 0 0 2px var(--color-primary)" }, { boxShadow: "0 0 0 2px var(--color-primary)", offset: 0.6 }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1800, easing: "ease-out" },
      );
    } else if (Date.now() - started > timeoutMs) {
      clearInterval(timer);
    }
  }, 100);
  return () => clearInterval(timer);
}
