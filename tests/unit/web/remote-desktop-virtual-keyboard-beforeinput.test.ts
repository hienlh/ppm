import { describe, it, expect } from "bun:test";
import { forwardBeforeInput } from "../../../src/web/components/remote-desktop/use-remote-desktop-virtual-keyboard";

function collect() {
  const sent: Record<string, unknown>[] = [];
  return { sent, send: (m: Record<string, unknown>) => { sent.push(m); } };
}

describe("virtual keyboard: beforeinput → messages (soft keyboards have no key codes)", () => {
  it("insertText becomes one text message, consumed", () => {
    const { sent, send } = collect();
    expect(forwardBeforeInput("insertText", "xin chào 日本", send)).toBe(true);
    expect(sent).toEqual([{ type: "text", text: "xin chào 日本" }]);
  });

  it("Enter and Backspace are mapped back to key taps so hosts without a text path still get them", () => {
    const { sent, send } = collect();
    forwardBeforeInput("insertLineBreak", null, send);
    forwardBeforeInput("deleteContentBackward", null, send);
    expect(sent).toEqual([
      { type: "key", code: "Enter", down: true }, { type: "key", code: "Enter", down: false },
      { type: "key", code: "Backspace", down: true }, { type: "key", code: "Backspace", down: false },
    ]);
  });

  it("composition updates are left alone (compositionend sends the settled text)", () => {
    const { sent, send } = collect();
    expect(forwardBeforeInput("insertCompositionText", "nh", send)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("insertText without data sends nothing but still consumes the event", () => {
    const { sent, send } = collect();
    expect(forwardBeforeInput("insertText", null, send)).toBe(true);
    expect(sent).toEqual([]);
  });
});
