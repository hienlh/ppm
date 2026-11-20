/**
 * `/btw` and Claude's suggested next prompt, as the browser uses them: the composer offers the
 * suggestion only when it is empty and idle and takes it with Tab (a tap on a phone); a side
 * question goes to its own route and its answer is shown apart from the chat.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { MessageInput } = await import("../../../src/web/components/chat/message-input.tsx");
const { SideQuestionPanel, sideQuestionOf, useSideQuestion } = await import("../../../src/web/components/chat/side-question-panel.tsx");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

describe("sideQuestionOf", () => {
  it("reads /btw and nothing else", () => {
    expect(sideQuestionOf("/btw where is the config?")).toBe("where is the config?");
    expect(sideQuestionOf("  /btw\nline one\nline two ")).toBe("line one\nline two");
    expect(sideQuestionOf("/btw")).toBe("");
    expect(sideQuestionOf("/btwx hi")).toBeNull();
    expect(sideQuestionOf("tell me /btw hi")).toBeNull();
  });
});

describe("the suggested prompt", () => {
  const textareas = () => [...view!.container.querySelectorAll("textarea")];
  const tab = async (ta: HTMLTextAreaElement) => {
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  };

  it("shows in the empty composer and Tab takes it", async () => {
    installGlobal("fetch", async () => new Response("{}"));
    const saved: string[] = [];
    view = await mount(<MessageInput projectName="p" onSend={() => {}} suggestion="run the tests" onContentChange={(t: string) => { saved.push(t); }} />);
    const [mobile, desktop] = textareas();
    expect(mobile!.placeholder).toBe("run the tests");
    expect(desktop!.placeholder).toBe("run the tests  (Tab)");
    await tab(desktop!);
    expect(desktop!.value).toBe("run the tests");
    expect(saved.at(-1)).toBe("run the tests");
    // Once there is text, Tab is the textarea's own again and the suggestion is gone.
    expect(desktop!.placeholder).toBe("Ask anything...");
  });

  it("a phone takes it with a tap", async () => {
    installGlobal("fetch", async () => new Response("{}"));
    view = await mount(<MessageInput projectName="p" onSend={() => {}} suggestion="commit it" />);
    await click(view.container.querySelector("[data-testid=prompt-suggestion-chip]"));
    expect(textareas()[0]!.value).toBe("commit it");
    expect(view.container.querySelector("[data-testid=prompt-suggestion-chip]")).toBeNull();
  });

  it("is not offered while a turn runs", async () => {
    installGlobal("fetch", async () => new Response("{}"));
    view = await mount(<MessageInput projectName="p" onSend={() => {}} suggestion="run the tests" isStreaming />);
    const desktop = textareas()[1]!;
    expect(desktop.placeholder).toBe("Follow-up or Stop...");
    await tab(desktop);
    expect(desktop.value).toBe("");
    expect(view.container.querySelector("[data-testid=prompt-suggestion-chip]")).toBeNull();
  });
});

describe("a side question", () => {
  let hook: ReturnType<typeof useSideQuestion> | null = null;
  function Harness() {
    hook = useSideQuestion("proj", "s1");
    return hook.state ? <SideQuestionPanel state={hook.state} onClose={hook.close} /> : null;
  }

  it("goes to the side-question route and its answer is shown apart from the chat", async () => {
    const posted: { url: string; body: unknown }[] = [];
    installGlobal("fetch", async (url: string, init?: RequestInit) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, data: { response: "It lives in **src/a.ts**." } }));
    });
    view = await mount(<Harness />);
    await act(async () => { void hook!.ask("where is a?"); });
    await settle();
    // The answer's Markdown may look up the path it names (`/api/fs/locate`); only the question counts here.
    expect(posted.filter((p) => !p.url.includes("/api/fs/locate"))).toEqual([{ url: expect.stringContaining("/chat/sessions/s1/side-question"), body: { question: "where is a?" } }]);
    const panel = view.container.querySelector("[data-testid=side-question-panel]")!;
    expect(panel.textContent).toContain("not added to the chat");
    expect(panel.textContent).toContain("where is a?");
    await click(panel.querySelector('[aria-label="Close side question"]'));
    expect(view.container.querySelector("[data-testid=side-question-panel]")).toBeNull();
  });

  it("says why when there is no Claude process to ask", async () => {
    installGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, error: "This chat's Claude process is not running." }), { status: 409 }));
    view = await mount(<Harness />);
    await act(async () => { void hook!.ask("anything"); });
    await settle();
    expect(view.container.querySelector("[role=alert]")!.textContent).toContain("not running");
  });
});
