/**
 * Login with Claude in the Add Account dialog. The page Claude shows after sign-in reads
 * `<code>#<state>`, and that state names the link the code was issued for — so the paste goes to
 * the server whole. A link the server no longer holds (410) cannot be finished, so the dialog
 * goes back to the step that opens a new one instead of leaving a Connect button that always fails.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { AddAccountDialog } = await import("../../../src/web/components/settings/accounts/account-add-dialog");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };

const realFetch = globalThis.fetch;
const realOpen = window.open;
let requests: Req[] = [];
let exchangeAnswer: Answer;
let opened: string[] = [];

beforeEach(() => {
  requests = [];
  opened = [];
  window.open = ((url?: string | URL) => { opened.push(String(url)); return null; }) as typeof window.open;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const answer: Answer = req.url === "/api/accounts/oauth/url"
      ? { body: { ok: true, data: { url: "https://claude.ai/oauth/authorize?state=s-newer", state: "s-newer" } } }
      : req.url === "/api/accounts/oauth/exchange"
        ? exchangeAnswer
        : { status: 599, body: { ok: false, error: `no stub for ${req.method} ${req.url}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  window.open = realOpen;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

function button(text: string): HTMLButtonElement {
  const found = findButton(text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

async function pasteCode(text: string): Promise<void> {
  const el = document.body.querySelector<HTMLInputElement>('input[placeholder="Paste code here..."]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function connectWith(pasted: string): Promise<void> {
  view = await mount(<AddAccountDialog open onOpenChange={() => {}} onSuccess={() => {}} />);
  await click(button("Login with Claude"));
  await settle();
  expect(opened).toEqual(["https://claude.ai/oauth/authorize?state=s-newer"]);
  await pasteCode(pasted);
  await click(button("Connect"));
  await settle();
}

const exchanges = () => requests.filter((r) => r.method === "POST" && r.url === "/api/accounts/oauth/exchange");

describe("Login with Claude", () => {
  it("sends the pasted code with its #state, which names the link it came from", async () => {
    exchangeAnswer = { body: { ok: true, data: { id: "acc-1", status: "active" } } };

    await connectWith("  code-1#s-earlier  ");

    expect(exchanges().map((r) => r.body)).toEqual([{ code: "code-1#s-earlier", state: "s-newer" }]);
  });

  it("goes back to Login with Claude when the server no longer holds the link", async () => {
    const expired = "This sign-in link has expired. Click Login with Claude to get a new one.";
    exchangeAnswer = { status: 410, body: { ok: false, error: expired } };

    await connectWith("code-1#s-gone");

    expect(findButton("Connect")).toBeUndefined();
    expect(findButton("Login with Claude")).toBeDefined();
    expect(document.body.textContent).toContain(expired);
  });

  it("keeps the code field up for any other refusal, so a corrected code can be tried", async () => {
    exchangeAnswer = { status: 400, body: { ok: false, error: "OAuth token exchange failed: 400 invalid_grant" } };

    await connectWith("code-1#s-newer");

    expect(findButton("Connect")).toBeDefined();
    expect(document.body.textContent).toContain("invalid_grant");
  });
});
