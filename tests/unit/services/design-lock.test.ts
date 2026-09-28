import { describe, expect, it } from "bun:test";
import {
  activeDesignLockCount, designLockKey, detachFromDesignLocks, withDesignLock,
} from "../../../src/services/design/design-lock.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withDesignLock", () => {
  it("runs holders of one key strictly one after another, in arrival order", async () => {
    const log: string[] = [];
    const job = (name: string) => withDesignLock("p::a", async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
      return name;
    });
    const results = await Promise.all([job("1"), job("2"), job("3")]);
    expect(results).toEqual(["1", "2", "3"]);
    expect(log).toEqual(["1:start", "1:end", "2:start", "2:end", "3:start", "3:end"]);
  });

  it("does not serialize different designs", async () => {
    const log: string[] = [];
    await Promise.all(["a", "b"].map((slug) => withDesignLock(`p::${slug}`, async () => {
      log.push(`${slug}:start`);
      await tick();
      log.push(`${slug}:end`);
    })));
    expect(log.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  it("drops the entry once the chain settles, including after failures, and loses no waiter", async () => {
    const before = activeDesignLockCount();
    const outcomes = await Promise.allSettled([
      withDesignLock("p::evict", async () => { await tick(); throw new Error("boom"); }),
      withDesignLock("p::evict", async () => "second"),
      withDesignLock("p::evict", async () => { throw new Error("third"); }),
      withDesignLock("p::evict", async () => "fourth"),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    expect(activeDesignLockCount()).toBe(before);
    // A new acquisition after eviction still works.
    expect(await withDesignLock("p::evict", async () => "again")).toBe("again");
    expect(activeDesignLockCount()).toBe(before);
  });

  it("is reentrant for the caller holding it, so a nested snapshot cannot deadlock", async () => {
    const result = await withDesignLock("p::nested", () => withDesignLock("p::nested", async () => "inner"));
    expect(result).toBe("inner");
    expect(activeDesignLockCount()).toBe(0);
  });

  it("does not let deferred work escape the queue through the inherited context", async () => {
    const log: string[] = [];
    let deferred!: Promise<void>;
    await withDesignLock("p::defer", async () => {
      deferred = new Promise<void>((resolveDeferred) => {
        setTimeout(() => {
          void detachFromDesignLocks(() => withDesignLock("p::defer", async () => { log.push("deferred"); }))
            .then(resolveDeferred);
        }, 1);
      });
      await tick();
      await tick();
      log.push("holder-done");
    });
    await deferred;
    expect(log).toEqual(["holder-done", "deferred"]);
  });

  it("folds case on Windows only", () => {
    const a = designLockKey("/Proj/X", "s");
    const b = designLockKey("/proj/x", "s");
    expect(a === b).toBe(process.platform === "win32");
  });
});
