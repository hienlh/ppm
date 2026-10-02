/**
 * How many directories a project may watch. Raw inotify costs one kernel watch per directory and
 * no descriptor, so it gets far more room than `fs.watch` — bounded by a quarter of the machine's
 * `max_user_watches`, and never less than what `fs.watch` was already given.
 */
import { describe, expect, it } from "bun:test";
import { watchBudgets } from "../../../src/services/file-watcher.service.ts";

describe("watchBudgets", () => {
  it("keeps the fs.watch caps for fs.watch, whatever the machine allows", () => {
    expect(watchBudgets(false, 2_097_152)).toEqual({ perProject: 12_000, total: 30_000 });
  });

  it("covers a 28,684-directory project under raw inotify on a machine with room", () => {
    const budgets = watchBudgets(true, 2_097_152);
    expect(budgets).toEqual({ perProject: 100_000, total: 250_000 });
    expect(budgets.perProject).toBeGreaterThan(28_684);
  });

  it("takes at most a quarter of the machine's watches", () => {
    expect(watchBudgets(true, 160_000)).toEqual({ perProject: 40_000, total: 40_000 });
  });

  it("never drops below the fs.watch caps, including when the limit cannot be read", () => {
    expect(watchBudgets(true, 8_192)).toEqual({ perProject: 12_000, total: 30_000 });
    expect(watchBudgets(true, 0)).toEqual({ perProject: 12_000, total: 30_000 });
  });
});
