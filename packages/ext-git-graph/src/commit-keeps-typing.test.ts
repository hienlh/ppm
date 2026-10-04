/**
 * The Git Graph's commit box after a commit: what was committed goes, what was
 * typed while the commit's hooks ran stays — it is the next message, and the
 * box used to be emptied all the same.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { openPanelPage, type PanelPage } from "./panel-test-harness.ts";

let page: PanelPage;
afterEach(() => page.close());

const side = { blocks: [], whole: "binary", added: 0, removed: 0 };
const changes = {
  branch: { head: "main", oid: "a".repeat(40), upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
  operation: null, stashes: 0, lastCommit: null, truncated: false,
  files: [{ path: "a.txt", x: "M", y: ".", untracked: false, conflict: false, staged: side, unstaged: null }],
};

function type(box: HTMLTextAreaElement, text: string) {
  box.value = text;
  box.dispatchEvent(new page.window.Event("input") as unknown as Event);
}

/** The working tree's panel with "First" in its box, and the commit asked for. */
function commitFirst(): { box: HTMLTextAreaElement; answer: () => void } {
  page = openPanelPage();
  page.send({ command: "loadChanges", data: changes });
  page.read("state").selectedCommit = "uncommitted";
  page.read("renderInspector")();
  const box = page.document.getElementById("commit-message") as HTMLTextAreaElement;
  type(box, "First");
  (page.document.getElementById("btn-commit") as HTMLElement).click();
  const asked = page.posted.findLast((m) => m.command === "commitStaged")!;
  expect(asked.message).toBe("First");
  return {
    box,
    answer: () => page.send({ command: "actionResult", action: "commitStaged", reqId: asked.reqId, result: { ok: true, data: { hash: "b".repeat(40) } } }),
  };
}

describe("the Git Graph's commit box after a commit", () => {
  it("empties when it still holds what was committed", () => {
    const { box, answer } = commitFirst();
    answer();
    expect(box.value).toBe("");
  });

  it("keeps what was typed while the commit ran", () => {
    const { box, answer } = commitFirst();
    type(box, "Second");
    answer();
    expect(box.value).toBe("Second");
  });
});
