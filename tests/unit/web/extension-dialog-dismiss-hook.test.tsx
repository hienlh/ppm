/**
 * The server's `quickpick:dismiss` / `inputbox:dismiss` close the dialog in this tab without
 * answering it. Drives the real `useExtensionWs` hook against a fake WebSocket.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useExtensionWs } from "../../../src/web/hooks/use-extension-ws.ts";
import { useExtensionStore } from "../../../src/web/stores/extension-store.ts";

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

function Bridge() {
  useExtensionWs(true);
  return null;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  FakeSocket.instances = [];
  installGlobal("WebSocket", FakeSocket);
  useExtensionStore.setState({ quickPick: null, inputBox: null });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

afterAll(() => uninstallDom());

async function deliver(...messages: Record<string, unknown>[]): Promise<FakeSocket> {
  const { act } = await import("react");
  mounted ??= await mount(<Bridge />);
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    for (const msg of messages) socket.onmessage?.({ data: JSON.stringify(msg) });
  });
  return socket;
}

const answers = (socket: FakeSocket, type: string) =>
  socket.sent.map((s) => JSON.parse(s) as { type: string }).filter((m) => m.type === type);

describe("dialog dismiss from the server", () => {
  it("closes the quick pick it names and sends no answer for it", async () => {
    const socket = await deliver(
      { type: "quickpick:show", requestId: "q1", items: [{ label: "a" }] },
      { type: "quickpick:dismiss", requestId: "q1" },
    );
    expect(useExtensionStore.getState().quickPick).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(answers(socket, "quickpick:resolve")).toEqual([]);
  });

  it("closes the input box it names and leaves one for another request open", async () => {
    await deliver(
      { type: "inputbox:show", requestId: "i1", options: {} },
      { type: "inputbox:dismiss", requestId: "i1" },
    );
    expect(useExtensionStore.getState().inputBox).toBeNull();

    await deliver(
      { type: "inputbox:show", requestId: "i2", options: {} },
      { type: "inputbox:dismiss", requestId: "i1" },
    );
    expect(useExtensionStore.getState().inputBox?.requestId).toBe("i2");
  });
});
