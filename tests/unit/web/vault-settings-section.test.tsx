/**
 * Settings → Vault: turning a tier on needs the password twice at its minimum length and the
 * forgotten-password tick; the public add box warns about secrets; an unlocked Secure tier shows
 * how long it stays open. Every password and value here is fake.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { VaultItemMeta } from "../../../src/shared/vault";

installDom();
// Radix's dialog watches its content with a MutationObserver, which the helper does not install by default.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
const { act } = await import("react");
const { VaultSettingsSection } = await import("../../../src/web/components/settings/vault/vault-settings-section");
const { passwordStrength } = await import("../../../src/web/lib/vault-password-strength");
const { api } = await import("../../../src/web/lib/api-client");

const tierStatus = (enabled: boolean, settingsOpenUntil = 0) => ({ enabled, itemCount: 0, lockedUntil: 0, attemptsLeft: 5, settingsOpenUntil });
const items: VaultItemMeta[] = [
  { id: "p1", tier: "public", name: "Shoe size", kind: "other", createdAt: 1, updatedAt: 1 },
  { id: "s1", tier: "secure", name: "NI number", kind: "ni_number", createdAt: 1, updatedAt: 1 },
];

let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;
let post: ReturnType<typeof spyOn>;
let secureOpenUntil = 0;
beforeEach(() => {
  secureOpenUntil = 0;
  get = spyOn(api, "get").mockImplementation(((path: string) => Promise.resolve(path.endsWith("/status")
    ? { publicCount: 1, tiers: { secure: tierStatus(true, secureOpenUntil), sealed: tierStatus(false) }, grants: [] }
    : items)) as never);
  post = spyOn(api, "post").mockImplementation(((path: string) => Promise.resolve(path.includes("/reveal") ? { ...items[0], value: "42" } : {})) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
  post.mockRestore();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const inBody = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const buttonIn = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
async function type(label: string, text: string) {
  const el = inBody(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  view = await mount(<VaultSettingsSection />);
  await flush();
  await flush();
}

describe("VaultSettingsSection", () => {
  it("lists public values and offers Turn on for a tier that is off", async () => {
    await open();
    expect(view!.container.querySelector('[data-vault-item="p1"] [data-vault-value]')?.textContent).toBe("42");
    const sealed = view!.container.querySelector('[data-vault-tier="sealed"]')!;
    expect(buttonIn(sealed, "Turn on")).not.toBeNull();
    // A locked item's value is never loaded with the list.
    expect(view!.container.querySelector('[data-vault-item="s1"] [data-vault-value]')).toBeNull();
  });

  it("turns a tier on only with a long enough password typed twice and the warning ticked", async () => {
    await open();
    await click(buttonIn(view!.container.querySelector('[data-vault-tier="sealed"]')!, "Turn on"));
    expect(inBody("[data-vault-forget-warning]")?.textContent).toContain("PPM cannot recover it");
    expect(document.body.textContent).toContain("must differ from the Secure tier's password");
    const turnOn = () => buttonIn(inBody('[role="dialog"]')!, "Turn on")!;
    await type("Sealed tier password", "fake-too-short");
    await type("Type it again", "fake-too-short");
    await click(inBody('[data-vault-check="forget-ack"] input'));
    expect(turnOn().hasAttribute("disabled")).toBe(true);
    await type("Sealed tier password", "fake-sealed-password-1");
    await type("Type it again", "fake-sealed-password-1");
    expect(turnOn().hasAttribute("disabled")).toBe(false);
    await click(turnOn());
    expect(post).toHaveBeenCalledWith("/api/vault/tiers/sealed/enable", { password: "fake-sealed-password-1" });
  });

  it("warns in the public add box, more strongly when the name looks secret", async () => {
    await open();
    await click(buttonIn(view!.container.querySelector('[data-vault-tier="public"]')!, "Add"));
    expect(inBody("[data-vault-public-warning]")?.textContent).toContain("Do not keep secrets here.");
    expect(inBody("[data-vault-secret-name-warning]")).toBeNull();
    await type("Name", "Bank password");
    expect(inBody("[data-vault-secret-name-warning]")).not.toBeNull();
  });

  it("shows how long Settings keeps the Secure tier open, and locks it on request", async () => {
    secureOpenUntil = Date.now() + 252_000;
    await open();
    expect(view!.container.querySelector("[data-vault-unlocked]")?.textContent).toMatch(/^Unlocked, 4:1\d left$/);
    await click(buttonIn(view!.container, "Lock now"));
    expect(post).toHaveBeenCalledWith("/api/vault/lock", { tier: "secure" });
  });
});

describe("passwordStrength", () => {
  it("is too short below the tier's minimum and stronger with length and variety", () => {
    expect(passwordStrength("short", 12).score).toBe(0);
    expect(passwordStrength("aaaaaaaaaaaaaaaa", 12).score).toBe(1);
    expect(passwordStrength("correct horse battery staple 9!", 12).score).toBeGreaterThanOrEqual(3);
  });
});
