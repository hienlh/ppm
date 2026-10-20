/**
 * A header saved for an Assistant MCP server is not sent to another origin: the server refuses
 * a blank value once the URL moves elsewhere. The dialog says so before Done, instead of
 * promising that leaving the field blank keeps the saved value.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { act } from "react";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
const { AssistantMcpServerDialog } = await import("../../../src/web/components/settings/assistant-mcp-server-dialog");
afterAll(uninstallDom);

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const SERVER = {
  id: "s1", name: "vanta", enabled: true, transport: "http" as const,
  url: "https://mcp.vanta.example/mcp", headers: { Authorization: "" },
};

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDialog(onDone: (s: unknown) => void) {
  view = await mount(
    <AssistantMcpServerDialog open server={SERVER} savedKeys={new Set(["Authorization"])} takenNames={new Set()} onClose={() => {}} onDone={onDone} />,
  );
  const url = document.body.querySelector("#asst-mcp-url") as HTMLInputElement;
  const value = document.body.querySelector("input[aria-label=Value]") as HTMLInputElement;
  const done = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Done")!;
  return { url, value, done };
}

it("keeps a saved header on the same origin when left blank", async () => {
  const saved: unknown[] = [];
  const { url, value, done } = await openDialog((s) => saved.push(s));
  expect(value.placeholder).toContain("blank keeps it");
  await typeInto(url, "https://mcp.vanta.example/v2/mcp");
  expect(value.placeholder).toContain("blank keeps it");
  await click(done);
  expect(saved).toHaveLength(1);
});

it("asks for the header again once the URL points at another origin", async () => {
  const saved: unknown[] = [];
  const { url, value, done } = await openDialog((s) => saved.push(s));
  await typeInto(url, "https://evil.example/mcp");
  expect(value.placeholder).not.toContain("blank keeps it");
  expect(value.placeholder).toContain("type it again");
  await click(done);
  expect(saved).toHaveLength(0);
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Authorization needs a value");
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain("different server");
});
