/**
 * The Review changes tab side by side, mounted for real with only the diff
 * editor faked: the file is read whole, each block's bar lands in a view zone
 * above its first changed line, the bar's buttons and the J/K/Y/N keys answer
 * the block, and the toggle goes back to the block list.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("shows the whole file side by side with each block's bar in place", () => {
  // Module mocks stay in a child process so other suites keep the real diff editor.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { installDom, installGlobal } from "./tests/helpers/react-dom";
    installDom();
    installGlobal("CSS", window.CSS);

    const report = { zones: [], fullDiffs: 0, writes: [] };
    let mountedProps = null;
    // The diff editor, faked down to what the tab uses: a right-hand editor that takes view zones.
    const modified = {
      changeViewZones(fn) {
        fn({
          addZone(zone) {
            document.body.appendChild(zone.domNode);
            report.zones.push(zone.afterLineNumber);
            return String(report.zones.length);
          },
          removeZone() {},
        });
      },
      getTopForLineNumber: (n) => n * 19,
      getScrollTop: () => 0,
      setScrollTop() {},
      getLayoutInfo: () => ({ height: 600, contentWidth: 700 }),
      getScrollLeft: () => 0,
      onMouseDown: () => ({ dispose() {} }),
      onDidLayoutChange: () => ({ dispose() {} }),
      onDidScrollChange: () => ({ dispose() {} }),
    };
    const React = await import("react");
    mock.module("./src/web/components/editor/monaco-diff-editor.tsx", () => ({
      getMonacoLanguage: () => "typescript",
      DiffEditor: (props) => {
        mountedProps = props;
        React.useEffect(() => { props.onMount({ getModifiedEditor: () => modified }, {}); }, []);
        // Monaco's own input: a textarea where the browser has no EditContext.
        return React.createElement("div", { "data-fake-diff": "" }, React.createElement("textarea", { className: "inputarea" }));
      },
    }));

    const ok = (data) => new Response(JSON.stringify({ ok: true, data }));
    const hunk = { id: "h1", index: 0, oldStart: 8, oldLines: 4, newStart: 8, newLines: 4, added: 1, removed: 1 };
    const listed = {
      path: "src/app.ts", x: ".", y: "M", untracked: false, conflict: false, staged: null,
      unstaged: { blocks: [hunk], added: 1, removed: 1 },
    };
    installGlobal("fetch", async (input, init) => {
      const u = String(input);
      if (init?.method === "POST") report.writes.push(u.slice(u.indexOf("/git/")));
      if (u.includes("/git/repos")) return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
      if (u.includes("/git/file-full-diff")) {
        report.fullDiffs++;
        return ok({ original: "a\\n", modified: "b\\n", binary: false, originalSize: 2, modifiedSize: 2 });
      }
      if (u.includes("/git/changes/file")) {
        return ok({ ...listed, unstaged: { added: 1, removed: 1, hunks: [{ ...hunk, heading: "", lines: [
          { kind: " ", text: "x" }, { kind: " ", text: "y" }, { kind: "-", text: "old" }, { kind: "+", text: "new" }, { kind: " ", text: "z" },
        ] }] } });
      }
      if (u.includes("/git/changes")) {
        return ok({
          branch: { head: "main", oid: "a".repeat(40), upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
          operation: null, stashes: 0, lastCommit: null, truncated: false, files: [listed],
        });
      }
      if (u.includes("/git/commit-draft")) return ok({ message: "", updatedAt: null });
      return ok({ undo: null });
    });

    const { useSettingsStore } = await import("./src/web/stores/settings-store");
    useSettingsStore.setState({ diffSideBySide: true });
    const { createRoot } = await import("react-dom/client");
    const { GitReviewTab } = await import("./src/web/components/git-review/git-review-tab");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const until = async (check, ms = 3000) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
    };
    await React.act(async () => { root.render(React.createElement(GitReviewTab, { metadata: { projectName: "demo" }, tabId: "t1" })); });
    await until(() => document.querySelector(".ppm-review-zone button[title='Stage this block (Y)']"));
    report.sideBySide = !!document.querySelector("[data-review-diff]");
    report.texts = [mountedProps.original, mountedProps.modified];
    report.hideUnchanged = mountedProps.options.hideUnchangedRegions.enabled;

    // The bar's own button.
    await React.act(async () => { document.querySelector(".ppm-review-zone button[title='Stage this block (Y)']").click(); });
    await until(() => report.writes.length >= 1);

    // A key pressed in the code reaches the tab, as one pressed in the list does.
    const code = document.querySelector("[data-review-diff] [data-fake-diff] textarea");
    await until(() => document.querySelector(".ppm-review-zone button[title='Discard this block (N)']"));
    await React.act(async () => { code.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true })); });
    await until(() => report.writes.length >= 2);

    // Back to the block list.
    await React.act(async () => { document.querySelector("button[aria-label='Side by side']").click(); });
    report.listAfterToggle = !document.querySelector("[data-review-diff]") && useSettingsStore.getState().diffSideBySide === false;
    await React.act(async () => { root.unmount(); });
    console.log(JSON.stringify(report));
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...process.env },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = result.stderr.toString();
  expect(result.exitCode, stderr).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  const report = JSON.parse(lines[lines.length - 1]!);
  expect(report.sideBySide).toBe(true);
  expect(report.fullDiffs).toBeGreaterThanOrEqual(1);
  expect(report.texts).toEqual(["a\n", "b\n"]);
  expect(report.hideUnchanged).toBe(true);
  // Two context lines (8, 9), then the change at line 10: the bar sits after line 9.
  expect(report.zones).toContain(9);
  expect(report.writes[0]).toContain("/git/stage-hunks");
  expect(report.writes[1]).toContain("/git/discard-hunks");
  expect(report.listAfterToggle).toBe(true);
});
