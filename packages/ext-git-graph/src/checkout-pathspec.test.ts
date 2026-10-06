/**
 * A checkout from the graph names a branch, a tag or a commit — never a path.
 *
 * `git checkout <name>` reads a name that is not a ref as a path when a file or
 * folder of that name exists, and puts it back as the index has it, with no
 * question asked. A branch deleted in a terminal stays drawn in the graph until
 * its next read, so checking out its pill could throw away every edit under the
 * folder of the same name. `--` after the name makes git refuse instead.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanelHost, type PanelHost } from "./panel-test-harness.ts";

let host: PanelHost;
afterEach(() => host.close());

async function checkout(target: string) {
  const asked = host.sent("actionResult").length;
  host.send({ command: "gitAction", action: "checkout", args: { target } });
  await host.until(() => host.sent("actionResult").length > asked);
  return host.sent("actionResult").at(-1)!.result as { ok: boolean; error?: string };
}

describe("a checkout from the graph", () => {
  it("refuses a name that is no ref, and leaves the edits under a folder of that name alone", async () => {
    host = await openPanelHost();
    mkdirSync(join(host.repo, "docs"));
    writeFileSync(join(host.repo, "docs", "guide.md"), "one\n");
    host.git("add", "docs");
    host.git("commit", "-qm", "docs");
    writeFileSync(join(host.repo, "docs", "guide.md"), "edited\n");

    const result = await checkout("docs");

    expect(result.ok).toBe(false);
    expect(readFileSync(join(host.repo, "docs", "guide.md"), "utf8")).toBe("edited\n");
  });

  it("still switches branches, and makes a remote one a local branch that tracks it", async () => {
    host = await openPanelHost();
    host.git("branch", "local-one");
    host.git("remote", "add", "origin", "https://example.invalid/demo.git");
    host.git("update-ref", "refs/remotes/origin/feature", "HEAD");

    expect(await checkout("local-one")).toEqual({ ok: true });
    expect(host.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("local-one");
    // What the remote pill's Checkout sends: the local name, for git to set up tracking.
    expect(await checkout("feature")).toEqual({ ok: true });
    expect(host.git("rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe("origin/feature");
  });
});
