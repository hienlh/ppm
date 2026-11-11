/**
 * Replace All asks first, counting only what is listed (dismissed matches and files left out),
 * then sends exactly those matches — never a file open with unsaved edits — and reports what
 * happened: how many were replaced, which files were skipped (unsaved, changed on disk) and
 * which failed with the reason (5.5, 5.7, 5.8).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import type {
  ReplaceReport,
  ReplaceRequest,
  SearchMatch,
  SearchResponse,
} from "../../../../src/services/content-search/search-options.ts";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { ReplaceAllDialog } = await import("../../../../src/web/components/explorer/replace-all-dialog");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function dialogText(): string {
  const el = document.body.querySelector('[data-testid="replace-all-dialog"]');
  if (!el) throw new Error("no replace-all dialog");
  return (el.textContent ?? "").replace(/\s+/g, " ");
}

function m(line: number, column: number, text = "useStore", replacement: string | undefined = "useAppStore"): SearchMatch {
  return { line, column, length: text.length, before: "", cutBefore: false, text, after: "", replacement };
}

function response(results: SearchResponse["results"]): SearchResponse {
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  return { results, total, files: results.length, limitHit: false, engine: "rg" };
}

const REPORT_OK: ReplaceReport = { replaced: 0, files: 0, skipped: [], failed: [] };

interface Setup {
  res: SearchResponse;
  dismissed?: Set<string>;
  unsaved?: string[];
  replaceText?: string;
  onReplace?: (files: ReplaceRequest["files"]) => Promise<ReplaceReport>;
}

async function open(setup: Setup) {
  const calls = { replace: [] as ReplaceRequest["files"][], close: 0, searchAgain: 0 };
  const unsaved = new Set(setup.unsaved ?? []);
  view = await mount(
    <ReplaceAllDialog
      response={setup.res}
      dismissed={setup.dismissed ?? new Set()}
      replaceText={setup.replaceText ?? "useAppStore"}
      isUnsaved={(file) => unsaved.has(file)}
      onReplace={async (files) => {
        calls.replace.push(files);
        return setup.onReplace ? setup.onReplace(files) : { ...REPORT_OK };
      }}
      onSearchAgain={() => { calls.searchAgain++; }}
      onClose={() => { calls.close++; }}
    />,
  );
  return calls;
}

describe("ReplaceAllDialog — confirmation", () => {
  it("states the matches and files that are listed, leaving dismissed ones out", async () => {
    await open({
      res: response([
        { file: "src/a.ts", matches: [m(1, 0), m(4, 2)] },
        { file: "src/b.ts", matches: [m(1, 0), m(9, 0)] },
        { file: "src/c.ts", matches: [m(3, 0)] },
      ]),
      dismissed: new Set(["src/b.ts:1:0", "src/c.ts"]),
    });

    const text = dialogText();
    expect(text).toContain("Replace 3 occurrences across 2 files with useAppStore?");
    expect(text).toContain("2 dismissed matches are left as they are");
  });

  it("says one occurrence in one file in the singular, and mentions no dismissed matches when there are none", async () => {
    await open({ res: response([{ file: "a.ts", matches: [m(2, 5)] }]) });

    const text = dialogText();
    expect(text).toContain("Replace 1 occurrence across 1 file with useAppStore?");
    expect(text).not.toContain("dismissed");
  });

  it("Cancel closes without replacing anything", async () => {
    const calls = await open({ res: response([{ file: "a.ts", matches: [m(1, 0)] }]) });

    await click(button("Cancel"));
    await settle();

    expect(calls.close).toBe(1);
    expect(calls.replace).toEqual([]);
  });
});

describe("ReplaceAllDialog — replacing", () => {
  it("sends exactly the listed matches, and never a file with unsaved changes", async () => {
    const calls = await open({
      res: response([
        { file: "src/a.ts", matches: [m(1, 0), m(4, 2, "UseStore", "UseAppStore")] },
        { file: "src/b.ts", matches: [m(1, 0), m(9, 0)] },
        { file: "src/open.ts", matches: [m(7, 1)] },
      ]),
      dismissed: new Set(["src/b.ts:9:0"]),
      unsaved: ["src/open.ts"],
    });

    await click(button("Replace"));
    await settle();

    expect(calls.replace).toEqual([
      [
        {
          file: "src/a.ts",
          matches: [
            { line: 1, column: 0, text: "useStore", replacement: "useAppStore" },
            { line: 4, column: 2, text: "UseStore", replacement: "UseAppStore" },
          ],
        },
        { file: "src/b.ts", matches: [{ line: 1, column: 0, text: "useStore", replacement: "useAppStore" }] },
      ],
    ]);
  });

  it("reports what was replaced, what was skipped and why, and what failed and why", async () => {
    await open({
      res: response([
        { file: "src/a.ts", matches: [m(1, 0), m(2, 0)] },
        { file: "src/moved.ts", matches: [m(5, 0)] },
        { file: "docs/readme.md", matches: [m(1, 0)] },
        { file: "src/tab-store.ts", matches: [m(3, 0)] },
      ]),
      unsaved: ["src/tab-store.ts"],
      onReplace: async () => ({
        replaced: 2,
        files: 1,
        skipped: [{ file: "src/moved.ts", reason: "changed" }],
        failed: [{ file: "docs/readme.md", reason: "permission denied" }],
      }),
    });

    await click(button("Replace"));
    await settle();

    const text = dialogText();
    expect(text).toContain("Replaced 2 occurrences in 1 file");
    expect(text).toContain("src/tab-store.ts");
    expect(text).toContain("Skipped: unsaved changes in an open tab");
    expect(text).toContain("src/moved.ts");
    expect(text).toContain("Skipped: changed on disk since the search");
    expect(text).toContain("docs/readme.md");
    expect(text).toContain("Failed: permission denied");
  });

  it("does not call the server when every listed file has unsaved changes, and reports them skipped", async () => {
    const calls = await open({
      res: response([{ file: "src/open.ts", matches: [m(1, 0)] }]),
      unsaved: ["src/open.ts"],
    });

    await click(button("Replace"));
    await settle();

    expect(calls.replace).toEqual([]);
    const text = dialogText();
    expect(text).toContain("Replaced 0 occurrences in 0 files");
    expect(text).toContain("src/open.ts");
    expect(text).toContain("Skipped: unsaved changes in an open tab");
  });

  it("keeps the confirmation open with the reason when the request itself fails, so it can be tried again", async () => {
    let attempts = 0;
    await open({
      res: response([{ file: "a.ts", matches: [m(1, 0)] }]),
      onReplace: async () => {
        attempts++;
        throw new Error("Search could not start: spawn failed");
      },
    });

    await click(button("Replace"));
    await settle();

    expect(dialogText()).toContain("Search could not start: spawn failed");
    expect(button("Replace").disabled).toBe(false);

    await click(button("Replace"));
    await settle();
    expect(attempts).toBe(2);
  });

  it("offers Search again and Done once the report is shown", async () => {
    const calls = await open({
      res: response([{ file: "a.ts", matches: [m(1, 0)] }]),
      onReplace: async () => ({ replaced: 1, files: 1, skipped: [], failed: [] }),
    });

    await click(button("Replace"));
    await settle();
    expect(dialogText()).toContain("Replaced 1 occurrence in 1 file");

    await click(button("Search again"));
    await settle();
    expect(calls.searchAgain).toBe(1);

    await click(button("Done"));
    await settle();
    expect(calls.close).toBeGreaterThanOrEqual(1);
  });
});
