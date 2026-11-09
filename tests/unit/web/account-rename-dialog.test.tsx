/**
 * Renaming an account from its card. The dialog saves the trimmed name, refuses a blank or
 * unchanged one, and keeps itself open with the server's reason when the save is refused.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { AccountRenameDialog } = await import("../../../src/web/components/settings/accounts/account-rename-dialog");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function saveButton(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save");
  if (!found) throw new Error('no button "Save"');
  return found;
}

async function typeName(text: string): Promise<void> {
  const el = document.body.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AccountRenameDialog", () => {
  it("saves the trimmed name", async () => {
    const saved: string[] = [];
    view = await mount(<AccountRenameDialog current="Claude Pro/Max (setup-token)" onSave={async (l) => { saved.push(l); }} onCancel={() => {}} />);

    await typeName("  Work laptop  ");
    await click(saveButton());
    await settle();

    expect(saved).toEqual(["Work laptop"]);
  });

  it("does not offer to save a blank or unchanged name", async () => {
    view = await mount(<AccountRenameDialog current="Personal" onSave={async () => {}} onCancel={() => {}} />);
    expect(saveButton().disabled).toBe(true);

    await typeName("   ");
    expect(saveButton().disabled).toBe(true);

    await typeName("Personal 2");
    expect(saveButton().disabled).toBe(false);
  });

  it("stays open and shows why when the server refuses the name", async () => {
    view = await mount(<AccountRenameDialog current="A" onSave={async () => { throw new Error("Name is too long"); }} onCancel={() => {}} />);

    await typeName("B");
    await click(saveButton());
    await settle();

    expect(document.body.querySelector('[data-testid="account-rename-dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Name is too long");
    expect(saveButton().disabled).toBe(false);
  });
});
