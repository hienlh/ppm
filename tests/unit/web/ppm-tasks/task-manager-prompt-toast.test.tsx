/**
 * "Tell the manager now?" after a save: asked only when the save says so (`managerPrompt`), once
 * for a burst of saves, by one host however many are mounted; Tell now wakes the manager, Next
 * turn sends nothing.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";

afterAll(uninstallDom);

const { act } = await import("react");
const { TaskManagerPromptHost, offerTaskManagerPrompt } = await import("../../../../src/web/components/ppm-tasks/task-manager-prompt-toast");
const { ASK_AFTER_MS } = await import("../../../../src/web/hooks/use-ppm-task-manager-prompt");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let notified: unknown[] = [];

afterEach(async () => { await view?.unmount(); view = null; notified = []; globalThis.fetch = realFetch; });

function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/tasks/notify-manager") notified.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, data: { sent: true, sessionId: "m1" } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const prompts = () => document.querySelectorAll("[data-task-manager-prompt]");
const answer = (yes: boolean) => [...document.querySelectorAll("[data-task-manager-prompt] button")].find((b) => b.textContent === (yes ? "Tell now" : "Next turn"))!;

describe("Tell the manager now?", () => {
  it("is not asked for a save that does not call for it", async () => {
    serve();
    view = await mount(<TaskManagerPromptHost />);
    await act(async () => { offerTaskManagerPrompt({ managerPrompt: false, task: { project: "demo" } }); offerTaskManagerPrompt(null); });
    await wait(ASK_AFTER_MS + 200);
    expect(prompts()).toHaveLength(0);
  });

  it("asks once for a burst of saves, from one host of two, and Tell now wakes the manager", async () => {
    serve();
    view = await mount(<><TaskManagerPromptHost /><TaskManagerPromptHost /></>);
    await act(async () => {
      for (let i = 0; i < 3; i++) offerTaskManagerPrompt({ managerPrompt: true, task: { project: "demo" } });
    });
    expect(prompts()).toHaveLength(0);
    await wait(ASK_AFTER_MS + 200);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.textContent).toContain("Tell the demo manager now?");
    await click(answer(true));
    await wait(20);
    expect(notified).toEqual([{ project: "demo" }]);
    expect(prompts()).toHaveLength(0);
  });

  it("Next turn sends nothing", async () => {
    serve();
    view = await mount(<TaskManagerPromptHost />);
    await act(async () => { offerTaskManagerPrompt({ managerPrompt: true, task: { project: "demo" } }); });
    await wait(ASK_AFTER_MS + 200);
    await click(answer(false));
    await wait(20);
    expect(notified).toEqual([]);
    expect(prompts()).toHaveLength(0);
  });
});
