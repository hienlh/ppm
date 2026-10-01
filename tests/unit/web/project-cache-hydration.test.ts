import { describe, expect, it } from "bun:test";
import {
  hydrateProjectCache,
  registerProjectHydrator,
  resetHydrationDedupe,
} from "../../../src/web/lib/browser-cache/project-cache-hydration";

const project = { name: "late-hydrator", path: "/tmp/late-hydrator" };

describe("project cache hydration", () => {
  it("runs a hydrator registered after its project was already hydrated", async () => {
    resetHydrationDedupe();
    await hydrateProjectCache(project);

    const seen: string[] = [];
    registerProjectHydrator(async (p) => { seen.push(p.name); });
    await Promise.resolve();

    expect(seen).toEqual(["late-hydrator"]);
  });

  it("does not run a hydrator twice when it registers again", async () => {
    resetHydrationDedupe();
    await hydrateProjectCache({ ...project, name: "once" });

    let runs = 0;
    const fn = async () => { runs += 1; };
    registerProjectHydrator(fn);
    registerProjectHydrator(fn);
    await Promise.resolve();

    expect(runs).toBe(1);
  });
});
