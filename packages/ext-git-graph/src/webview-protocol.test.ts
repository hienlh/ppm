/**
 * The panel and its host talk in plain objects that nothing type-checks across
 * the boundary, and every mismatch fails quietly: a command with no `case`
 * does nothing, an answer filed under another name leaves its button waiting
 * forever, a menu item naming a git action the host does not build answers
 * "Unknown git action". So this reads both sides and holds them together.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { getWebviewHtml } from "./webview-html.ts";

const html = getWebviewHtml();
const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
const host = readFileSync(new URL("./extension.ts", import.meta.url), "utf8");

/** The host's handling of one command: from its `case` in the message handler to the `break` that ends it. */
function hostCase(command: string): string {
  const at = host.indexOf(`case "${command}":`, host.indexOf("onMessage: async"));
  if (at === -1) throw new Error(`the host has no case for "${command}"`);
  return host.slice(at, host.indexOf("break;", at));
}

/** A top-level function of the host, as source. */
function hostFunction(name: string): string {
  const at = host.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`the host has no function ${name}`);
  return host.slice(at, host.indexOf("\n}\n", at));
}

describe("commands", () => {
  it("are all ones the host handles", () => {
    // `__ppm.openExternal` and `__ppm.fileIcons` are not plain names: the app takes them before the host could.
    const sent = new Set([...script.matchAll(/command: '(\w+)'/g)].map((m) => m[1]!));
    expect(sent.size).toBeGreaterThan(30);
    const handler = host.slice(host.indexOf("onMessage: async"));
    const unhandled = [...sent].filter((c) => !handler.includes(`case "${c}":`));
    expect(unhandled).toEqual([]);
  });

  it("from the host are all ones the panel handles", () => {
    const posted = new Set([...host.matchAll(/command: "(\w+)"/g)].map((m) => m[1]!));
    const listener = script.slice(script.indexOf("window.addEventListener('message'"));
    const handled = new Set([...listener.matchAll(/case '(\w+)':/g)].map((m) => m[1]!));
    expect(posted.size).toBeGreaterThan(10);
    expect([...posted].filter((c) => !handled.has(c))).toEqual([]);
  });
});

describe("every request is answered under the name it waits on", () => {
  /** Literal names a request is filed under: `request(…, 'name', …)`. */
  const keys = new Set([...script.matchAll(/\brequest\((?:\{[^}]*\}|\w+), '([\w:]+)'/g)].map((m) => m[1]!));

  it("finds the requests it checks", () => {
    expect(keys.size).toBeGreaterThan(10);
  });

  it("files each one under its own command, which is the name the host answers with", () => {
    for (const key of keys) {
      if (key === "fetch") continue; // a sync action; see below
      const answered = host.includes(`runAction("${key}"`) || hostCase(key).includes("runAction(msg.command");
      expect({ key, answered }).toEqual({ key, answered: true });
    }
  });

  it("names the same request when the host fails before it could answer", () => {
    const failed = hostFunction("actionKeyFor");
    for (const key of keys) {
      if (key === "fetch") continue;
      expect(failed).toContain(`case "${key}":`);
    }
    expect(host).toContain('postMessage({ command: "error", message: errMsg, failed: actionKeyFor(msg), reqId: msg.reqId })');
  });

  it("files a sync under its action, and the host answers under the same", () => {
    expect(script).toContain("request({ command: 'sync', action }, action,");
    expect(script).toContain("request({ command: 'sync', action: 'fetch' }, 'fetch', null)");
    const sync = hostCase("sync");
    expect(sync).toContain("const action = syncAction(msg.action);");
    expect(sync).toContain("await runAction(action,");
  });

  it("asks only for sync actions the host accepts", () => {
    const accepted = /const SYNC_ACTIONS = \[([^\]]*)\]/.exec(host)?.[1] ?? "";
    const asked = new Set([...script.matchAll(/runSync\('(\w+)'\)/g)].map((m) => m[1]!));
    // The toolbar's push button and the phone's one button choose by mode.
    for (const m of script.matchAll(/runSync\(([^)]*)\)/g)) {
      for (const v of m[1]!.matchAll(/'(\w+)'/g)) if (v[1] !== "synced") asked.add(v[1]!);
    }
    expect(asked.size).toBeGreaterThanOrEqual(4);
    for (const action of asked) expect(accepted).toContain(`"${action}"`);
  });

  it("files a stopped operation under the action, as the host does", () => {
    expect(script).toContain("const name = 'operation:' + action;");
    expect(hostCase("operation")).toContain("runAction(`operation:${action}`");
  });

  it("answers a git action under the action's own name", () => {
    expect(script).toContain("request({ command: 'gitAction', action, args }, action, cb);");
    expect(hostCase("gitAction")).toContain("handleGitAction(vscode, panel, pp, msg.action,");
    expect(hostFunction("handleGitAction")).toContain('postMessage({ command: "actionResult", action, args, result, reqId })');
  });

  it("sends an answer even when an argument is refused", () => {
    // A refused argument used to throw past the answer, and the button waited.
    const handle = hostFunction("handleGitAction");
    expect(handle.indexOf("buildGitActionArgs(action, args)")).toBeGreaterThan(handle.indexOf("try {"));
    expect(handle.indexOf("buildGitActionArgs(action, args)")).toBeLessThan(handle.indexOf("} catch (e) {"));
  });
});

describe("git actions", () => {
  const asked = new Set([...script.matchAll(/\b(?:runGitWrite|gitAction)\('(\w+)'/g)].map((m) => m[1]!));
  const built = new Set([...hostFunction("buildGitActionArgs").matchAll(/case "(\w+)":/g)].map((m) => m[1]!));

  it("are all ones the host builds a command for", () => {
    expect(asked.size).toBeGreaterThan(10);
    expect([...asked].filter((a) => !built.has(a))).toEqual([]);
  });

  it("are all ones some menu asks for", () => {
    // A command nothing sends is a command nobody tests.
    expect([...built].filter((a) => !asked.has(a))).toEqual([]);
  });

  it("never open an editor git would wait on", () => {
    expect(hostFunction("buildGitActionArgs")).toContain('["revert", "--no-edit", assertValidHash(args.hash)]');
  });

  it("name a stash by its position and the hash the panel saw", () => {
    // Positions shift as stashes come and go; the host checks the pair first.
    expect(script).toContain("runGitWrite('stashBranch', { name, index: s.index, hash: s.hash }");
    expect(hostFunction("handleGitAction")).toContain('if (action === "stashBranch") await assertStashUnchanged(');
  });
});
