/**
 * The virtual keyboard hook with real DOM events on a real `<input>`: a Gboard composition, a
 * Backspace in a field that looks empty, and Enter with no `code` — the three paths that used
 * to lag or drop keys on an Android phone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useRemoteDesktopVirtualKeyboard } from "../../../src/web/components/remote-desktop/use-remote-desktop-virtual-keyboard.ts";
import { KEYBOARD_PADDING as PAD } from "../../../src/web/components/remote-desktop/remote-desktop-soft-keyboard.ts";

let mounted: Mounted | null = null;
let sent: Record<string, unknown>[] = [];
const record = (m: Record<string, unknown>) => { sent.push(m); };

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  uninstallDom();
});

function Harness() {
  const { inputRef } = useRemoteDesktopVirtualKeyboard(record, true);
  return <input ref={inputRef} data-testid="kbd" />;
}

async function setup(): Promise<HTMLInputElement> {
  sent = [];
  mounted = await mount(<Harness />);
  return mounted.container.querySelector("[data-testid=kbd]") as HTMLInputElement;
}

function fire(el: HTMLElement, type: string, props: Record<string, unknown> = {}): boolean {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return el.dispatchEvent(e);
}

/** What a keyboard does to the field: change the value, then `input`. */
function edit(el: HTMLInputElement, value: string, isComposing = false) {
  el.value = value;
  fire(el, "input", { isComposing, inputType: isComposing ? "insertCompositionText" : "insertText" });
}

const keyMsgs = () => sent.filter((m) => m.type !== "releaseAll");

describe("virtual keyboard hook on a real input", () => {
  it("starts with the padding in the field", async () => {
    const el = await setup();
    expect(el.value).toBe(PAD);
  });

  it("Gboard: letters go out during the composition, the commit adds nothing twice", async () => {
    const el = await setup();
    fire(el, "compositionstart");
    for (const w of ["x", "xi", "xin"]) {
      expect(fire(el, "keydown", { key: "Unidentified", code: "", keyCode: 229, isComposing: true })).toBe(true);
      edit(el, PAD + w, true);
    }
    expect(keyMsgs()).toEqual([{ type: "text", text: "x" }, { type: "text", text: "i" }, { type: "text", text: "n" }]);
    fire(el, "compositionend", { data: "xin" });
    edit(el, PAD + "xin ");
    expect(keyMsgs().at(-1)).toEqual({ type: "text", text: " " });
    expect(keyMsgs()).toHaveLength(4);
  });

  it("Backspace with no code and nothing typed still deletes on the host", async () => {
    const el = await setup();
    // Not cancelled: the browser deletes one padding character, which is what gets sent.
    expect(fire(el, "keydown", { key: "Backspace", code: "", keyCode: 8 })).toBe(true);
    edit(el, el.value.slice(0, -1));
    expect(keyMsgs()).toEqual([{ type: "key", code: "Backspace", down: true }, { type: "key", code: "Backspace", down: false }]);
  });

  it("Enter with no code is sent and its default is cancelled", async () => {
    const el = await setup();
    expect(fire(el, "keydown", { key: "Enter", code: "", keyCode: 13 })).toBe(false);
    expect(keyMsgs()).toEqual([{ type: "key", code: "Enter", down: true }, { type: "key", code: "Enter", down: false }]);
  });
});
