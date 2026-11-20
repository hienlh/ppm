/**
 * A Claude tool card offers Allow, Allow <rule> for this chat and Deny…, where Deny opens a box
 * for what Claude should do instead. An Assistant card (with a summary) and a card with no rule
 * keep plain Allow / Deny.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { ApprovalCard } = await import("../../../src/web/components/chat/approval-card");
const { approvalFromWire } = await import("../../../src/web/lib/approval-request");
afterAll(uninstallDom);

const buttons = (root: Element) => [...root.querySelectorAll("button")].map((b) => b.textContent);

describe("approval card scopes", () => {
  it("reads the rule off the wire", () => {
    expect(approvalFromWire({ requestId: "r", tool: "Bash", input: {}, rule: { label: "`git status` commands" } })?.rule)
      .toEqual({ label: "`git status` commands" });
    expect(approvalFromWire({ requestId: "r", tool: "Bash", input: {}, rule: { label: 3 } })?.rule).toBeUndefined();
  });

  it("offers the chat scope and sends it", async () => {
    const calls: unknown[][] = [];
    const view = await mount(<ApprovalCard
      approval={{ requestId: "r1", tool: "Bash", input: { command: "git status" }, rule: { label: "`git status` commands" } }}
      onRespond={(...a) => { calls.push(a); }}
    />);
    try {
      expect(buttons(view.container)).toEqual(["Allow", "Allow `git status` commands for this chat", "Deny…"]);
      await click(view.container.querySelector('[data-approval-scope="chat"]'));
      expect(calls).toEqual([["r1", true, { scope: "chat" }]]);
    } finally {
      await view.unmount();
    }
  });

  it("Deny… opens a box whose text goes to Claude", async () => {
    const calls: unknown[][] = [];
    const view = await mount(<ApprovalCard
      approval={{ requestId: "r2", tool: "Bash", input: { command: "npm i" }, rule: { label: "`npm i` commands" } }}
      onRespond={(...a) => { calls.push(a); }}
    />);
    try {
      await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Deny…")!);
      const box = view.container.querySelector("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!;
      setter.call(box, "use bun install");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await Bun.sleep(0);
      await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Deny and send")!);
      expect(calls).toEqual([["r2", false, { message: "use bun install" }]]);
    } finally {
      await view.unmount();
    }
  });

  it("a card with no rule keeps plain Allow and Deny", async () => {
    const calls: unknown[][] = [];
    const view = await mount(<ApprovalCard approval={{ requestId: "r3", tool: "X", input: {} }} onRespond={(...a) => { calls.push(a); }} />);
    try {
      expect(buttons(view.container)).toEqual(["Allow", "Deny"]);
      await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Deny")!);
      expect(calls).toEqual([["r3", false]]);
    } finally {
      await view.unmount();
    }
  });
});
