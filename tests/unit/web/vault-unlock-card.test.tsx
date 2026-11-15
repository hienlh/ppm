/**
 * The vault's chat cards: what each one offers, the exact body it posts to
 * `/api/vault/cards/:id` (never the chat socket), and that a refused password keeps the card up
 * with the attempts left or the lock-out. Every password and value here is fake.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { VAULT_CARD_APPROVAL, type VaultCardInput } from "../../../src/shared/vault";

installDom();
afterAll(uninstallDom);
const { act } = await import("react");
const { VaultUnlockCard } = await import("../../../src/web/components/chat/vault-unlock-card");
const { PendingApprovalCard } = await import("../../../src/web/components/chat/message-approval-cards");
const { api, ApiError } = await import("../../../src/web/lib/api-client");
const sonner = await import("sonner");

const requester = { sessionTitle: "Tax return", assistant: false, fromTelegram: false };
const sealed = (allowGiveToAi: boolean): VaultCardInput => ({
  kind: "read-sealed", requester, purpose: "Fill in the form", item: { id: "s1", name: "Passport", kind: "passport" },
  allowGiveToAi, attemptsLeft: 5, lockedUntil: 0,
});
const secure: VaultCardInput = {
  kind: "read-secure", requester, purpose: "Fill in the form",
  items: [{ id: "a", name: "NI number", kind: "ni_number" }, { id: "b", name: "Home", kind: "address" }, { id: "c", name: "Other", kind: "other" }],
  requested: ["b", "a"], attemptsLeft: 5, lockedUntil: 0,
};
const propose = (hasPrefill: boolean): VaultCardInput => ({
  kind: "propose", requester, name: "Bank sort code", itemKind: "other", suggestedTier: "sealed", hasPrefill,
  enabled: { secure: true, sealed: false },
});

let view: Mounted | null = null;
let post: ReturnType<typeof spyOn>;
beforeEach(() => {
  post = spyOn(api, "post").mockImplementation((() => Promise.resolve({ approved: true })) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  post.mockRestore();
});

const q = <T extends Element = HTMLElement>(sel: string) => view!.container.querySelector<T>(sel);
const button = (text: string) => [...view!.container.querySelectorAll("button")].find((b) => b.textContent === text) ?? null;
async function type(sel: string, text: string) {
  const el = q<HTMLInputElement>(sel)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("read-sealed card", () => {
  it("offers giving the value to the AI only when allowed", async () => {
    view = await mount(<VaultUnlockCard requestId="r1" input={sealed(false)} />);
    expect(q("[data-vault-give-to-ai]")).toBeNull();
    expect(q('[data-vault-check="give-to-ai"]')).toBeNull();
    expect(view.container.textContent).toContain("can only be shown to you");
    await view.unmount();
    view = await mount(<VaultUnlockCard requestId="r1" input={sealed(true)} />);
    expect(q('[data-vault-check="give-to-ai"]')?.textContent).toContain("Let the AI read this item once");
  });

  it("shows the value to the user by default, and gives it to the AI only when ticked", async () => {
    view = await mount(<VaultUnlockCard requestId="r/1" input={sealed(true)} />);
    expect(button("Show to me")?.hasAttribute("disabled")).toBe(true);
    await type('input[aria-label="Sealed tier password"]', "fake-sealed-pass");
    await click(button("Show to me"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r%2F1", { approved: true, password: "fake-sealed-pass", giveToAi: false });

    await click(q('[data-vault-check="give-to-ai"] input'));
    await click(button("Give to the AI once"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r%2F1", { approved: true, password: "fake-sealed-pass", giveToAi: true });
  });

  it("puts a value shown to the user in a toast, not anywhere the AI reads", async () => {
    post.mockImplementation((() => Promise.resolve({ approved: true, shown: { name: "Passport", value: "FAKE-000" } })) as never);
    const custom = spyOn(sonner.toast, "custom").mockImplementation((() => "id") as never);
    try {
      view = await mount(<VaultUnlockCard requestId="r2" input={sealed(true)} />);
      await type('input[aria-label="Sealed tier password"]', "fake-sealed-pass");
      await click(button("Show to me"));
      await flush();
      expect(custom).toHaveBeenCalledTimes(1);
      expect(custom.mock.calls[0]![1]).toMatchObject({ id: "vault-shown-r2", duration: 60_000 });
    } finally { custom.mockRestore(); }
  });

  it("keeps the card on a wrong password and says how many attempts are left", async () => {
    post.mockImplementation((() => Promise.reject(new ApiError("Wrong password.", 403, { ok: false, error: "Wrong password.", attemptsLeft: 2 }))) as never);
    view = await mount(<VaultUnlockCard requestId="r3" input={sealed(true)} />);
    await type('input[aria-label="Sealed tier password"]', "fake-wrong");
    await click(button("Show to me"));
    await flush();
    expect(q("[data-vault-card-error]")?.textContent).toBe("Wrong password. 2 attempts left.");
    expect(q('[data-vault-card="read-sealed"]')).not.toBeNull();
  });

  it("says how long a locked-out tier waits and refuses to send meanwhile", async () => {
    post.mockImplementation((() => Promise.reject(new ApiError("Too many wrong passwords.", 423, { ok: false, error: "Too many wrong passwords.", retryAfterMs: 30_000 }))) as never);
    view = await mount(<VaultUnlockCard requestId="r4" input={sealed(false)} />);
    await type('input[aria-label="Sealed tier password"]', "fake-wrong");
    await click(button("Show to me"));
    await flush();
    expect(q("[data-vault-card-error]")?.textContent).toBe("Too many wrong passwords. Try again in 30 s.");
    expect(button("Show to me")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("read-secure card", () => {
  it("pre-ticks what the AI asked for and sends a one-time read by default", async () => {
    view = await mount(<VaultUnlockCard requestId="r5" input={secure} />);
    const ticked = [...view.container.querySelectorAll<HTMLInputElement>("[data-vault-items] input")].map((i) => i.checked);
    expect(ticked).toEqual([true, true, false]);
    expect(view.container.textContent).toContain("Tax return");
    await type('input[aria-label="Secure tier password"]', "fake-secure-pass");
    await click(button("Approve"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r5", { approved: true, password: "fake-secure-pass", itemIds: ["a", "b"], mode: "once" });
  });

  it("opens a window for this chat when picked, with the items ticked now", async () => {
    view = await mount(<VaultUnlockCard requestId="r6" input={secure} />);
    await click(q('[data-vault-check="c"] input'));
    await click(q('[data-vault-check="a"] input'));
    await click(button("Open 10 min for this chat"));
    await type('input[aria-label="Secure tier password"]', "fake-secure-pass");
    await click(button("Approve"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r6", { approved: true, password: "fake-secure-pass", itemIds: ["b", "c"], mode: "window", minutes: 10 });
  });

  it("declines without a password, and keeps its answers at the thumb on a phone", async () => {
    view = await mount(<VaultUnlockCard requestId="r7" input={secure} />);
    const actions = q("[data-vault-card-actions]")!;
    expect(actions.className.split(" ")).toEqual(expect.arrayContaining(["flex-col-reverse", "md:flex-row"]));
    for (const b of actions.querySelectorAll("button")) expect(b.className).toContain("h-11");
    await click(button("Decline"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r7", { approved: false });
  });
});

describe("propose card", () => {
  it("shows the AI's value masked with its warning, and does not send it back untouched", async () => {
    const get = spyOn(api, "get").mockImplementation((() => Promise.resolve({ value: "FAKE-12-34-56" })) as never);
    try {
      view = await mount(<VaultUnlockCard requestId="r8" input={propose(true)} />);
      await flush();
      expect(get).toHaveBeenCalledWith("/api/vault/cards/r8/prefill");
      const value = q<HTMLInputElement>('input[aria-label="Value"]')!;
      expect(value.type).toBe("password");
      expect(value.value).toBe("FAKE-12-34-56");
      expect(q("[data-vault-prefill-warning]")?.textContent).toBe("This value is already in the chat history.");
      // Sealed is off, so the suggestion falls back to Public, which asks no password and warns.
      const sealedTier = [...view.container.querySelectorAll("[data-vault-tier-picker] button")].find((b) => b.textContent?.startsWith("Sealed"))!;
      expect(sealedTier.hasAttribute("disabled")).toBe(true);
      expect(q("[data-vault-public-warning]")).not.toBeNull();
      expect(q('input[aria-label$="tier password"]')).toBeNull();
      await click(button("Save"));
      expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r8", { approved: true, tier: "public", name: "Bank sort code", itemKind: "other" });
    } finally { get.mockRestore(); }
  });

  it("asks the Secure password and sends a value the user typed", async () => {
    view = await mount(<VaultUnlockCard requestId="r9" input={propose(false)} />);
    await click([...view.container.querySelectorAll("[data-vault-tier-picker] button")].find((b) => b.textContent === "Secure")!);
    expect(q("[data-vault-public-warning]")).toBeNull();
    await type('input[aria-label="Value"]', "FAKE-VALUE");
    await type('input[aria-label="Secure tier password"]', "fake-secure-pass");
    await click(button("Save"));
    expect(post).toHaveBeenLastCalledWith("/api/vault/cards/r9", {
      approved: true, tier: "secure", name: "Bank sort code", itemKind: "other", value: "FAKE-VALUE", password: "fake-secure-pass",
    });
  });
});

describe("PendingApprovalCard", () => {
  it("draws the vault's own card for a ppm:vault approval", async () => {
    view = await mount(<PendingApprovalCard approval={{ requestId: "r10", tool: VAULT_CARD_APPROVAL, input: sealed(false) } as never} onRespond={() => {}} />);
    expect(q('[data-vault-card="read-sealed"]')).not.toBeNull();
  });
});
