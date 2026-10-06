/**
 * DBGate's Find column, as the Columns panel takes it: the section unfolded if it was folded, the
 * cursor in its search box with the last search selected, so what is typed next replaces it — and
 * the ask answered once, so a later render does not take the focus back.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { ColumnsSection } = await import("../../../src/web/components/database/grid/columns-panel");

const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, autoIncrement: true, fk: null },
  { name: "status", type: "text", nullable: false, pk: false, defaultValue: null, fk: null },
];

let ask: (asked: boolean) => void = () => {};
let answered = 0;

function Panel({ folded }: { folded: boolean }) {
  const [collapsed, setCollapsed] = useState(folded);
  const [asked, setAsked] = useState(false);
  ask = setAsked;
  return (
    <ColumnsSection
      schema={SCHEMA} hidden={new Set()} onHiddenChange={() => {}} onJump={() => {}}
      collapsed={collapsed} onCollapsedChange={setCollapsed}
      focusSearch={asked ? () => { answered += 1; setAsked(false); } : undefined}
    />
  );
}

const search = () => document.querySelector<HTMLInputElement>('input[placeholder="Search columns"]');

describe("Find column in the Columns panel", () => {
  it("unfolds the section and puts the cursor in its search, the last search selected", async () => {
    answered = 0;
    const view = await mount(<Panel folded />);
    expect(search()).toBeNull();
    await act(async () => { ask(true); });
    expect(document.activeElement).toBe(search());
    expect(answered).toBe(1);
    // A search typed before: selected, so the next key replaces it.
    await act(async () => {
      const box = search()!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(box, "sta");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.blur();
    });
    await act(async () => { ask(true); });
    expect(document.activeElement).toBe(search());
    expect([search()!.selectionStart, search()!.selectionEnd]).toEqual([0, 3]);
    expect(answered).toBe(2);
    await view.unmount();
  });

  it("takes the focus only when asked", async () => {
    answered = 0;
    const view = await mount(<Panel folded={false} />);
    expect(document.activeElement).not.toBe(search());
    await act(async () => { ask(true); });
    search()!.blur();
    // Folding and unfolding again is no ask.
    await act(async () => { document.querySelector<HTMLButtonElement>('section[aria-label="Columns"] button')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('section[aria-label="Columns"] button')!.click(); });
    expect(document.activeElement).not.toBe(search());
    expect(answered).toBe(1);
    await view.unmount();
  });
});
