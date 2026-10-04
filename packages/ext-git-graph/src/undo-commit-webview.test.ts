/**
 * The panel's half of "Undo last commit": both ways to it name a commit. The
 * menu names the one the composer shows, the toast after a commit names the
 * commit just made — so PPM can refuse once another one has landed on top.
 * Run from the shipped script, with what they call stubbed.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getWebviewHtml } from "./webview-html.ts";

const SCRIPT = (() => {
  const html = getWebviewHtml();
  return html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
})();

/** One top-level function, as source; nothing it reaches for has a brace inside a string. */
function functionSource(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no ${name} in the shipped script`);
  let depth = 0;
  for (let i = SCRIPT.indexOf("{", start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === "{") depth++;
    else if (SCRIPT[i] === "}" && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

interface MenuItem { label?: string; action?: () => void }
interface Panel {
  commitSplitItems(): MenuItem[];
  commitStaged(opts?: Record<string, unknown>): void;
}
interface Toast { text: string; opts?: { undo?: (() => void) | null } }

const SHOWN = "a".repeat(40);
const MADE = "c".repeat(40);

let requests: Array<Record<string, unknown>>;
let toasts: Toast[];
let panel: Panel;

beforeEach(() => {
  requests = [];
  toasts = [];
  const answers: Record<string, unknown> = {
    commitStaged: { ok: true, data: { hash: MADE } },
    undoCommit: { ok: true, data: {} },
  };
  const state = { changes: { lastCommit: { hash: SHOWN, pushed: false, hasParent: true } }, draft: { message: "" } };
  panel = new Function("state", "requests", "toasts", "answers", `
    let draftTimer = 0;
    const document = { getElementById: () => null };
    function anyBusy() { return false; }
    function setBusy() {}
    function request(msg, action, done) { requests.push(msg); if (done) done(answers[action]); }
    function showToast(text, opts) { toasts.push({ text, opts }); }
    function showActionError(title, error) { toasts.push({ text: title + ': ' + error }); }
    function composerState() { return { message: 'Fix it', totals: { filesStaged: 1 }, ready: true, amendable: true, undoable: true }; }
    function branchState() { return null; }
    function clearComposer() {}
    function updateCommitControls() {}
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
    function syncMode() { return 'push'; }
    ${["undoLastCommit", "commitSplitItems", "commitStaged"].map(functionSource).join("\n")}
    return { commitSplitItems, commitStaged };
  `)(state, requests, toasts, answers) as Panel;
});

const undoRequests = () => requests.filter((r) => r.command === "undoCommit");

describe("Undo last commit, from the panel", () => {
  it("names the commit the composer shows, from the commit menu", () => {
    panel.commitSplitItems().find((item) => item.label === "Undo last commit")!.action!();
    expect(undoRequests()).toEqual([{ command: "undoCommit", hash: SHOWN }]);
  });

  it("names the commit just made, from the toast after it", () => {
    panel.commitStaged({});
    const toast = toasts.find((t) => t.text.startsWith("Committed "));
    toast!.opts!.undo!();
    expect(undoRequests()).toEqual([{ command: "undoCommit", hash: MADE }]);
  });
});
