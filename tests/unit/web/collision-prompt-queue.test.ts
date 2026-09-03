import { describe, it, expect } from "bun:test";
import { CollisionPromptQueue } from "../../../src/web/components/os-explorer/actions/collision-prompt-queue.ts";

describe("CollisionPromptQueue", () => {
  it("serializes concurrent requests: only one shows at a time, in arrival order", () => {
    const queue = new CollisionPromptQueue(() => {});
    const results: string[] = [];

    const p1 = queue.request({ name: "a.txt", destination: "/a.txt" }).then((c) => results.push(`a:${c}`));
    const p2 = queue.request({ name: "b.txt", destination: "/b.txt" }).then((c) => results.push(`b:${c}`));
    const p3 = queue.request({ name: "c.txt", destination: "/c.txt" }).then((c) => results.push(`c:${c}`));

    // All three raised "concurrently" (no await between them) — only the first is visible,
    // and the other two never got the chance to overwrite it.
    expect(queue.snapshot()?.request.name).toBe("a.txt");
    expect(queue.snapshot()?.remaining).toBe(2);

    queue.choose("skip", false);
    expect(queue.snapshot()?.request.name).toBe("b.txt");
    expect(queue.snapshot()?.remaining).toBe(1);

    queue.choose("keep-both", false);
    expect(queue.snapshot()?.request.name).toBe("c.txt");
    expect(queue.snapshot()?.remaining).toBe(0);

    queue.choose("replace", false);
    expect(queue.snapshot()).toBeNull();

    return Promise.all([p1, p2, p3]).then(() => {
      expect(results).toEqual(["a:skip", "b:keep-both", "c:replace"]);
    });
  });

  it('"apply to all" resolves every request queued right now with the same choice', async () => {
    const queue = new CollisionPromptQueue(() => {});
    const choices: string[] = [];
    const promises = ["a", "b", "c"].map((name) =>
      queue.request({ name, destination: `/${name}` }).then((c) => choices.push(c)),
    );

    expect(queue.snapshot()?.remaining).toBe(2);
    queue.choose("replace", true); // ticked on the first prompt
    await Promise.all(promises);

    expect(choices).toEqual(["replace", "replace", "replace"]);
    expect(queue.snapshot()).toBeNull();
  });

  it("a sticky choice also answers requests that arrive after it was set, within the batch", async () => {
    const queue = new CollisionPromptQueue(() => {});
    queue.startBatch();

    const first = queue.request({ name: "a", destination: "/a" });
    queue.choose("skip", true);
    expect(await first).toBe("skip");

    // Arrives later in the same batch — never opens a second dialog.
    const second = await queue.request({ name: "b", destination: "/b" });
    expect(second).toBe("skip");
    expect(queue.snapshot()).toBeNull();

    queue.endBatch();
  });

  it("endBatch resets the sticky choice once every overlapping batch has ended", async () => {
    const queue = new CollisionPromptQueue(() => {});
    queue.startBatch(); // e.g. a drag-drop transfer
    queue.startBatch(); // an unrelated paste, overlapping in time

    const first = queue.request({ name: "a", destination: "/a" });
    queue.choose("replace", true);
    expect(await first).toBe("replace");

    queue.endBatch(); // the drag-drop finishes — one batch still open
    const stillSticky = await queue.request({ name: "b", destination: "/b" });
    expect(stillSticky).toBe("replace");

    queue.endBatch(); // the paste finishes too — sticky choice clears
    const promptsAgain = queue.request({ name: "c", destination: "/c" });
    expect(queue.snapshot()?.request.name).toBe("c");
    queue.choose("skip", false);
    expect(await promptsAgain).toBe("skip");
  });

  it("choose() on an empty queue is a no-op", () => {
    const queue = new CollisionPromptQueue(() => {});
    expect(() => queue.choose("skip", false)).not.toThrow();
    expect(queue.snapshot()).toBeNull();
  });
});
