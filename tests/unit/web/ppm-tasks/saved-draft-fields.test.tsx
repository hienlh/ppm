/**
 * The fields that save when left (due date, next step) never lose what was typed: a field removed
 * while it holds an unsaved value saves it, a save that came back failed or stale is sent again on
 * the next blur instead of looking saved, and the stored value changing under the field does not
 * throw away text typed since.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";

afterAll(uninstallDom);
const { act } = await import("react");
const { TaskDateInput } = await import("../../../../src/web/components/ppm-tasks/task-date-input");
const { TaskNextStepField } = await import("../../../../src/web/components/ppm-tasks/peek/task-peek-fields");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const area = () => document.querySelector("textarea[aria-label='Next step']") as HTMLTextAreaElement;
async function type(el: HTMLTextAreaElement | HTMLInputElement, v: string) {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const blur = async (el: HTMLElement) => { await act(async () => { el.focus(); el.blur(); }); await settle(); };

describe("fields that save when left", () => {
  it("saves a next step typed but never left when the field is removed", async () => {
    const saved: Array<string | null> = [];
    view = await mount(<TaskNextStepField value={null} onSave={(v) => { saved.push(v); }} />);
    await type(area(), "  Call the bank  ");
    await view.unmount();
    view = null;
    expect(saved).toEqual(["Call the bank"]);
  });

  it("does not send the same value twice while its answer is on the way", async () => {
    const saved: Array<string | null> = [];
    view = await mount(<TaskNextStepField value={null} onSave={(v) => { saved.push(v); return new Promise(() => {}); }} />);
    await type(area(), "Call the bank");
    await blur(area());
    await blur(area());
    await view.unmount();
    view = null;
    expect(saved).toEqual(["Call the bank"]);
  });

  it("sends a save that came back failed or stale again on the next blur", async () => {
    const saved: Array<string | null> = [];
    view = await mount(<TaskDateInput label="Due" value="2026-11-17" onSave={(v) => { saved.push(v); return Promise.resolve(null); }} />);
    const input = document.querySelector("input[aria-label='Due']") as HTMLInputElement;
    await type(input, "2026-12-01");
    await blur(input);
    expect(saved).toEqual(["2026-12-01"]);
    await blur(input);
    expect(saved).toEqual(["2026-12-01", "2026-12-01"]);
    expect(input.value).toBe("2026-12-01");
  });

  it("keeps text typed after a save when the stored value then changes", async () => {
    let setValue: (v: string | null) => void = () => {};
    const { useState } = await import("react");
    function Host() {
      const [value, set] = useState<string | null>(null);
      setValue = set;
      return <TaskNextStepField value={value} onSave={() => new Promise(() => {})} />;
    }
    view = await mount(<Host />);
    await type(area(), "Call the bank");
    await blur(area());
    await type(area(), "Call the bank, then the accountant");
    // The answer to the first save arrives while the user is still typing.
    await act(async () => { setValue("Call the bank"); });
    expect(area().value).toBe("Call the bank, then the accountant");
    // Someone else's change while the field holds only what was saved: the field follows it.
    await type(area(), "Call the bank");
    await act(async () => { setValue("Ask the manager"); });
    expect(area().value).toBe("Ask the manager");
  });
});
