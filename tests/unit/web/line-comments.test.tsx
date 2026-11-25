/**
 * Line comments: on a chat's changes in the Review tab, and on a plan waiting for approval — what
 * each turns into for the AI, where the Review tab keeps them, and the two places a person writes them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";
import { formatPlanComments, formatReviewComments } from "../../../src/web/lib/line-comments";

describe("formatReviewComments", () => {
  it("groups by file in line order, quotes each line, and leaves out empty comments", () => {
    const text = formatReviewComments([
      { id: "3", path: "src/b.ts", line: 9, side: "new", quote: "  return x;", body: "Handle null" },
      { id: "1", path: "src/a.ts", line: 12, side: "new", quote: "const a = `x`;", body: "Rename\nthis" },
      { id: "2", path: "src/a.ts", line: 4, side: "old", quote: "old()", body: "Why was this removed?" },
      { id: "4", path: "src/c.ts", line: 1, side: "new", quote: "x", body: "   " },
    ]);
    expect(text).toBe([
      "Review comments on the changes in this chat — please address each one:",
      "**src/b.ts**",
      "- line 9 `return x;`\n  Handle null",
      "**src/a.ts**",
      "- removed line 4 `old()`\n  Why was this removed?",
      "- line 12 ``const a = `x`;``\n  Rename\n  this",
    ].join("\n\n"));
    expect(formatReviewComments([])).toBe("");
  });
});

describe("formatPlanComments", () => {
  const plan = ["# Plan", "1. Add a table", "2. Write tests"];
  it("quotes each commented line with its number, then the overall note", () => {
    expect(formatPlanComments(plan, { 2: "Tests first", 1: "Use the lazy table" }, "Keep it small")).toBe([
      "Comments on the plan — revise it to address each one, then present it again:",
      "> 2: 1. Add a table\n\nUse the lazy table",
      "> 3: 2. Write tests\n\nTests first",
      "Also: Keep it small",
    ].join("\n\n"));
  });
  it("is the overall note alone with no line comments, and empty with nothing", () => {
    expect(formatPlanComments(plan, {}, " Simpler please ")).toBe("Simpler please");
    expect(formatPlanComments(plan, { 9: "out of range", 0: " " })).toBe("");
  });
});

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { useReviewComments } = await import("../../../src/web/stores/review-comments-store");
const { ReviewCode, ReviewCommentScope } = await import("../../../src/web/components/session-review/review-code.tsx");
const { paneModel } = await import("../../../src/web/lib/session-review-model.ts");
const { PlanApprovalCard } = await import("../../../src/web/components/chat/plan-approval-card");

let view: Mounted | null = null;
beforeEach(() => {
  localStorage.clear();
  useReviewComments.setState({ bySession: {} });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const buttonByText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe("review comments store", () => {
  it("keeps one comment per id, drops an emptied one, and persists across a reload", () => {
    const c = { id: "a", path: "x.ts", line: 1, side: "new" as const, quote: "q", body: "first" };
    useReviewComments.getState().save("s1", c);
    useReviewComments.getState().save("s1", { ...c, body: "second" });
    expect(useReviewComments.getState().bySession.s1).toEqual([{ ...c, body: "second" }]);
    expect(JSON.parse(localStorage.getItem("ppm.reviewComments")!).s1[0].body).toBe("second");
    useReviewComments.getState().save("s1", { ...c, body: " " });
    expect(useReviewComments.getState().bySession.s1).toBeUndefined();
  });
});

describe("Review tab: a comment on a changed line", () => {
  const original = Array.from({ length: 10 }, (_, i) => "line " + (i + 1) + "\n").join("");
  const modified = original.replace("line 3\n", "line three\n");
  const file = { path: "/p/src/a.ts", status: "modified" as const, baseline: "session" as const, additions: 1, deletions: 1, version: "1:1" };

  it("opens from the line number, saves under the line, and can be deleted", async () => {
    const noop = () => {};
    view = await mount(
      <ReviewCommentScope.Provider value={{ sessionId: "s1", path: "src/a.ts" }}>
        <ReviewCode
          file={file}
          model={paneModel({ original, modified, version: "1:1", kept: new Set(), reverted: [] })!}
          focusKey={null}
          compact={false}
          lang={undefined}
          turns={new Map()}
          actions={{ focus: noop, keep: noop, revert: noop, reopen: noop, undo: noop, showInChat: noop }}
        />
      </ReviewCommentScope.Provider>,
    );
    const added = view.container.querySelector<HTMLButtonElement>('[data-comment-line="src/a.ts\nnew\n3"]')!;
    expect(added).not.toBeNull();
    await click(added);
    await type(view.container.querySelector<HTMLTextAreaElement>("[data-line-comment-editor] textarea")!, "Call it 3, not three");
    await click(buttonByText(view.container, "Comment"));

    expect(useReviewComments.getState().bySession.s1).toEqual([
      { id: "src/a.ts\nnew\n3", path: "src/a.ts", line: 3, side: "new", quote: "line three", body: "Call it 3, not three" },
    ]);
    expect(view.container.querySelector("[data-line-comment]")?.textContent).toContain("Call it 3, not three");

    await click(view.container.querySelector<HTMLButtonElement>('[aria-label="Delete comment"]')!);
    expect(useReviewComments.getState().bySession.s1).toBeUndefined();
    expect(view.container.querySelector("[data-line-comment]")).toBeNull();
  });
});

describe("PlanApprovalCard", () => {
  const plan = "# Plan\n1. Add a table\n2. Write tests";

  it("sends the line comments back as feedback, quoting each line", async () => {
    const answers: unknown[] = [];
    view = await mount(<PlanApprovalCard requestId="r1" plan={plan} onRespond={(...a) => answers.push(a)} />);
    expect(buttonByText(view.container, "Keep planning")).toBeTruthy();

    await click(view.container.querySelector<HTMLButtonElement>('[data-plan-line="1"]')!);
    await type(view.container.querySelector<HTMLTextAreaElement>("[data-line-comment-editor] textarea")!, "Use the lazy table");
    await click(buttonByText(view.container, "Comment"));
    expect(view.container.textContent).toContain("Approving ignores the comments.");

    await click(view.container.querySelector<HTMLButtonElement>("[data-plan-feedback]")!);
    expect(answers).toEqual([["r1", false, { message: "Comments on the plan — revise it to address each one, then present it again:\n\n> 2: 1. Add a table\n\nUse the lazy table" }]]);
  });

  it("approves as is", async () => {
    const answers: unknown[] = [];
    view = await mount(<PlanApprovalCard requestId="r2" plan={plan} onRespond={(...a) => answers.push(a)} />);
    await click(buttonByText(view.container, "Approve plan"));
    expect(answers).toEqual([["r2", true]]);
  });
});
