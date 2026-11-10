/**
 * Two composer bugs seen together on 2026-11-10 (ppm.log):
 *
 * - One file dropped on the composer was uploaded twice, 4 ms apart, and showed as two chips:
 *   the textarea handled the drop itself and the drop then bubbled to the chat area, which
 *   hands the same files back through `externalFiles`.
 * - A chip the user removed came back after a reload and went out with the next message,
 *   pointing at an upload the removal had already deleted: removing a chip never reached
 *   the saved draft.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { act, useState } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { MessageInput } = await import("../../../src/web/components/chat/message-input.tsx");

let view: Mounted | null = null;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

/** Records every upload/delete the composer makes and answers like the server. */
function fakeServer() {
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "POST" && url.endsWith("/chat/upload")) {
      return new Response(JSON.stringify([{ path: `/uploads/${calls.length}-notes.txt` }]), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** The chat area's own drop handling, as `chat-tab.tsx` does it. */
function ChatArea() {
  const [externalFiles, setExternalFiles] = useState<File[] | null>(null);
  return (
    <div
      onDrop={(e) => {
        e.preventDefault();
        setExternalFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <MessageInput projectName="drop-test" onSend={() => {}} externalFiles={externalFiles} />
    </div>
  );
}

it("uploads a file dropped on the textarea once", async () => {
  const calls = fakeServer();
  view = await mount(<ChatArea />);
  const textarea = view.container.querySelector("textarea")!;
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { files: [file], types: ["Files"], getData: () => "" },
  });
  await act(async () => { textarea.dispatchEvent(drop); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/chat/upload"))).toHaveLength(1);
  expect(view.container.querySelectorAll('[aria-label="Remove notes.txt"]')).toHaveLength(1);
});

it("saves the draft without a chip the user removed", async () => {
  fakeServer();
  const saved: Array<Array<{ name: string; path: string }> | undefined> = [];
  view = await mount(
    <MessageInput
      projectName="drop-test"
      onSend={() => {}}
      initialAttachments={[{ name: "image.png", path: "/uploads/f532a0fe-image.png" }]}
      onContentChange={(_text, attachments) => { saved.push(attachments); }}
    />,
  );
  await click(view.container.querySelector('[aria-label="Remove image.png"]'));

  expect(view.container.querySelector('[aria-label="Remove image.png"]')).toBeNull();
  expect(saved.at(-1)).toEqual([]);
});
