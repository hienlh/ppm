/**
 * The create, pair-limit and escalation cards: each offers exactly the answers its kind allows,
 * says what it is asking about as text, answers over HTTP, and is what the approval slot draws.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { SESSION_COLLAB_APPROVAL, type SessionCollabApprovalInput } from "../../../src/shared/session-collab";

installDom();
afterAll(uninstallDom);
const { CollabApprovalCard, firstLines } = await import("../../../src/web/components/chat/collab-approval-card");
const { PendingApprovalCard } = await import("../../../src/web/components/chat/message-approval-cards");
const { HistoryWindowPendingPrompts } = await import("../../../src/web/components/chat/history-window-pending-prompts");
const { api } = await import("../../../src/web/lib/api-client");

const create: SessionCollabApprovalInput = {
  kind: "create", title: "<i>Docs</i> pass", providerId: "codex", model: "gpt-5", taskPreview: "line\n".repeat(10), depth: 1,
};
const pairLimit: SessionCollabApprovalInput = {
  kind: "pair_limit", targetSessionId: "cccccccc-2222-4000-8000-000000000002", targetTitle: "Reviewer", sent: 20, limit: 20, grant: 20,
};
const escalation: SessionCollabApprovalInput = {
  kind: "escalation", targetSessionId: "cccccccc-2222-4000-8000-000000000002", targetTitle: "Deployer",
  senderMode: "default", targetMode: "bypassPermissions", messagePreview: "run the release",
};
const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);
let view: Mounted | null = null;
let post: ReturnType<typeof spyOn>;

beforeEach(() => {
  post = spyOn(api, "post").mockImplementation((() => Promise.resolve({})) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  post.mockRestore();
});

describe("CollabApprovalCard", () => {
  it("asks to create a session with Allow once, Allow for this session and Deny", async () => {
    view = await mount(<CollabApprovalCard requestId="r1" input={create} />);
    expect(buttons(view.container)).toEqual(["Allow once", "Allow for this session", "Deny"]);
    expect(view.container.textContent).toContain("<i>Docs</i> pass");
    expect(view.container.querySelector("i")).toBeNull();
    expect(view.container.textContent).toContain("Codex · gpt-5 · depth 1");
  });

  it("offers more messages or Deny at the pair limit", async () => {
    view = await mount(<CollabApprovalCard requestId="r2" input={pairLimit} />);
    expect(buttons(view.container)).toEqual(["Allow 20 more", "Deny"]);
    expect(view.container.textContent).toContain("Reviewer");
    expect(view.container.textContent).toContain("20 of 20");
  });

  it("names both modes when a message would reach a session with more rights", async () => {
    view = await mount(<CollabApprovalCard requestId="r3" input={escalation} />);
    expect(buttons(view.container)).toEqual(["Allow once", "Allow for this session", "Deny"]);
    expect(view.container.textContent).toContain("Bypass permissions");
    expect(view.container.textContent).toContain("Ask");
    expect(view.container.textContent).toContain("run the release");
  });

  it("answers over HTTP with the chosen answer", async () => {
    view = await mount(<CollabApprovalCard requestId="r/1" input={create} />);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Allow for this session")!);
    expect(post).toHaveBeenCalledWith("/api/sessions-collab/approvals/r%2F1", { answer: "allow_session" });
  });

  it("shows a refused answer and lets the user try again", async () => {
    post.mockImplementation((() => Promise.reject(new Error("Request expired"))) as never);
    view = await mount(<CollabApprovalCard requestId="r4" input={pairLimit} />);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Deny")!);
    expect(view.container.textContent).toContain("Request expired");
    expect([...view.container.querySelectorAll("button")].every((b) => !b.disabled)).toBe(true);
  });

  it("cuts a long task to its first lines", () => {
    expect(firstLines("a\nb\nc", 2)).toBe("a\nb\n…");
    expect(firstLines("a\nb", 2)).toBe("a\nb");
  });
});

describe("approval slot", () => {
  const approval = { requestId: "r5", tool: SESSION_COLLAB_APPROVAL, input: create };

  it("draws the collab card in the live list's slot", async () => {
    view = await mount(<PendingApprovalCard approval={approval} onRespond={() => {}} />);
    expect(view.container.querySelector('[data-collab-approval="create"]')).not.toBeNull();
  });

  it("draws it in the floating block over the history window", async () => {
    view = await mount(<HistoryWindowPendingPrompts approval={{ ...approval, input: escalation }} onRespond={() => {}} question={null} />);
    expect(view.container.querySelector('[data-window-pending] [data-collab-approval="escalation"]')).not.toBeNull();
  });
});
