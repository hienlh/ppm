/** A task's date field saves once, on blur, and never a half-typed year. */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";

afterAll(uninstallDom);
const { act } = await import("react");
const { TaskDateInput, isSaveableDate } = await import("../../../../src/web/components/ppm-tasks/task-date-input");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

describe("TaskDateInput", () => {
  it("accepts whole dates from 1900 on, and empty", () => {
    expect(isSaveableDate("2026-11-17")).toBe(true);
    expect(isSaveableDate("")).toBe(true);
    expect(isSaveableDate("0020-11-17")).toBe(false);
    expect(isSaveableDate("2026-11")).toBe(false);
  });

  it("does not save while typing, saves once on blur", async () => {
    const saved: Array<string | null> = [];
    view = await mount(<TaskDateInput label="Due" value="2026-11-17" onSave={(v) => saved.push(v)} />);
    const input = document.querySelector('input[aria-label="Due"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      for (const v of ["0002-11-17", "0020-11-17", "0202-11-17", "2027-11-17"]) {
        setValue.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(saved).toEqual([]);
    await act(async () => { input.focus(); input.blur(); });
    expect(saved).toEqual(["2027-11-17"]);
  });
});
