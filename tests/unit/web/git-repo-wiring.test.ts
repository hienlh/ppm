/**
 * Every git surface has to go through the repo scope, and a call site that
 * skips it looks completely fine in review.
 *
 * A project whose folder is a container of repositories works only if *all* of
 * them ask the same question. One panel building `…/git/status` by hand runs
 * git in the container and reports "not a git repository" — for that one panel,
 * which reads as the feature working sometimes. So the wiring is asserted at
 * the source level, the same way `editor-lsp-lazy-boundary.test.ts` enumerates
 * imports that would merge a lazy chunk.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../../../src/web");

function webFiles(): string[] {
  const glob = new Glob("**/*.{ts,tsx}");
  return [...glob.scanSync(WEB)].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

/** The two places allowed to build a project git URL from scratch. */
const URL_BUILDERS = new Set(["hooks/use-git-repo.ts", "stores/git-repo-store.ts"]);

describe("git URLs go through the repo scope", () => {
  it("nothing else interpolates projectUrl() into a /git path", () => {
    const offenders = webFiles().filter((file) => {
      if (URL_BUILDERS.has(file)) return false;
      const source = readFileSync(resolve(WEB, file), "utf8");
      return /projectUrl\([^)]*\)\}\/git/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

/** Files that dispatch `ext:command:execute` with a path argument. */
const DISPATCHERS = [
  "lib/ext-command-dispatch.ts",
  "components/extensions/extension-webview.tsx",
  "components/git/git-status-panel.tsx",
  "lib/blame-hover-commands.ts",
];

describe("extension commands are dispatched with a resolved path", () => {
  it("no dispatcher pushes the active project's path unresolved", () => {
    // `activeProject.path` is the container folder. A git view handed that
    // opens on something that is not a repository, and the panel's own error
    // is the only symptom.
    const offenders = DISPATCHERS.filter((file) => {
      const source = readFileSync(resolve(WEB, file), "utf8");
      return /args\.push\((?:project|activeProject)\??\.path\)/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("every dispatcher is still one of the files this test knows about", () => {
    // A new dispatch site is exactly the regression this file exists to catch,
    // so it has to be added here — deliberately, not by accident.
    const found = webFiles().filter((file) => {
      const source = readFileSync(resolve(WEB, file), "utf8");
      return source.includes('new CustomEvent("ext:command:execute"');
    });
    // Two more dispatch, but invent no path: `status-bar.tsx` sends no
    // arguments at all, and `extension-tree-view.tsx` forwards the arguments
    // the extension itself put on the tree item. Both are pre-existing
    // behaviour and neither has a project path to get wrong.
    const NO_PATH = ["components/layout/status-bar.tsx", "components/extensions/extension-tree-view.tsx"];
    expect(found.sort()).toEqual([...DISPATCHERS, ...NO_PATH].sort());
  });
});
