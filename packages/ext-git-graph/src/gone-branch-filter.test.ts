/**
 * A graph filtered to one branch, when that branch goes away.
 *
 * Renamed from the panel's own menu, deleted in a terminal, pruned by a fetch:
 * the next read asked git for the old name, git refused, and the refusal was
 * read as an empty history — a blank graph, under a picker still naming the
 * branch, and every refresh after asked for it again. The read now falls back
 * to every branch and drops the filter.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanelHost, type PanelHost } from "./panel-test-harness.ts";

let host: PanelHost;
afterEach(() => host.close());

const lastList = () => host.sent("loadCommits").at(-1)!;
const logsFor = (name: string) => host.spawned.filter((args) => args[0] === "log" && args.includes(name));

async function gitAction(action: string, args: Record<string, unknown>) {
  const answered = host.sent("actionResult").length;
  const lists = host.sent("loadCommits").length;
  host.send({ command: "gitAction", action, args });
  // The re-read after the answer ends with the working tree.
  await host.until(() => host.sent("actionResult").length > answered && host.sent("loadCommits").length > lists);
  await host.until(() => host.posted.at(-1)!.command === "loadChanges" || host.posted.at(-1)!.command === "loadDraft");
}

describe("a branch filter", () => {
  it("falls back to every branch when its branch is renamed, and stops asking for the old name", async () => {
    host = await openPanelHost();
    host.git("checkout", "-q", "-b", "feature");
    writeFileSync(join(host.repo, "b.txt"), "two\n");
    host.git("add", "b.txt");
    host.git("commit", "-qm", "two");
    host.git("checkout", "-q", "main");

    host.send({ command: "requestCommits", branch: "feature" });
    await host.until(() => lastList().scope === "feature");
    expect(lastList().data.map((c: { message: string }) => c.message)).toEqual(["two", "one"]);

    await gitAction("renameBranch", { oldName: "feature", newName: "renamed" });
    expect(lastList().scope).toBe("all");
    expect(lastList().data.map((c: { message: string }) => c.message)).toEqual(["two", "one"]);

    const asked = logsFor("feature").length;
    await gitAction("createTag", { name: "v1" });
    expect(logsFor("feature").length).toBe(asked);
    expect(lastList().scope).toBe("all");
  });

  it("answers a page asked for under a branch that is gone with every branch from the top", async () => {
    host = await openPanelHost();
    host.git("branch", "feature");
    host.send({ command: "requestCommits", branch: "feature" });
    await host.until(() => lastList().scope === "feature");
    host.git("branch", "-D", "feature");

    host.send({ command: "requestCommits", branch: "feature", skip: 1 });
    await host.until(() => lastList().scope === "all");
    expect(lastList().append).toBe(false);
    expect(lastList().data).toHaveLength(1);
  });
});
