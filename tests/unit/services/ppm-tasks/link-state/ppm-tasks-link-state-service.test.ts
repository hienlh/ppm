import { beforeEach, describe, expect, it } from "bun:test";
import "../../../../test-setup.ts";
import { createTask, updateTask } from "../../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { setTasksEnabled } from "../../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { listLinkStateChangesSince } from "../../../../../src/services/ppm-tasks/ppm-tasks-db.ts";
import {
  comparable, createLinkStateService, LINK_READ_CONCURRENCY, LINK_STATE_TTL_MS, stableJson, type LinkStateEnv,
} from "../../../../../src/services/ppm-tasks/link-state/ppm-tasks-link-state.service.ts";
import type { ReadResult } from "../../../../../src/services/ppm-tasks/link-state/github-pr-link-state-reader.ts";
import { freshProject, PROJECT_PATH, USER, type Fixture } from "../ppm-tasks-fixture.ts";

let f: Fixture;
let clock: number;
let jiraStatus: string;
let jiraCalls: string[][];
let prCalls: string[][];
let emitted: string[][];

function env(over: Partial<LinkStateEnv> = {}): LinkStateEnv {
  return {
    now: () => clock,
    readJira: async (_p, refs) => {
      jiraCalls.push(refs);
      return new Map<string, ReadResult>(refs.map((r) => [r, { state: { status: jiraStatus, summary: "S", updated: String(clock) }, error: null }]));
    },
    readPrs: async (refs) => {
      prCalls.push(refs);
      return new Map<string, ReadResult>(refs.map((r) => [r, { state: null, error: "gh not available" }]));
    },
    emit: (keys) => { emitted.push(keys); },
    ...over,
  };
}

beforeEach(() => {
  f = freshProject();
  clock = 1_000_000;
  jiraStatus = "To Do";
  jiraCalls = [];
  prCalls = [];
  emitted = [];
});

describe("stableJson / comparable", () => {
  it("ignores key order, and a Jira issue's `updated`", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(comparable("jira", stableJson({ status: "A", updated: "1" }))).toBe(comparable("jira", stableJson({ updated: "2", status: "A" })));
    expect(comparable("pr", stableJson({ state: "open", x: 1 }))).not.toBe(comparable("pr", stableJson({ state: "open", x: 2 })));
  });
});

describe("states", () => {
  it("answers from the cache at once, refreshes missing and stale links in the background, and pushes an event", async () => {
    const svc = createLinkStateService(env());
    const links = [{ kind: "jira" as const, ref: "NX-1" }, { kind: "pr" as const, ref: "acme/app#2" }, { kind: "url" as const, ref: "https://x" }];
    const first = svc.source.states(f.projectKey, links);
    expect(first.map((s) => s.state)).toEqual([null, null, null]);
    await svc.idle();
    expect(jiraCalls).toEqual([["NX-1"]]);
    expect(prCalls).toEqual([["acme/app#2"]]);
    expect(emitted.flat()).toEqual([f.projectKey, f.projectKey]);
    const second = svc.source.states(f.projectKey, links);
    expect(second[0]).toMatchObject({ state: { status: "To Do" }, error: null, checkedAt: clock, changedAt: null });
    expect(second[1]).toMatchObject({ state: null, error: "gh not available" });
    // Fresh: nothing is read again within the TTL.
    await svc.idle();
    expect(jiraCalls).toHaveLength(1);
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(jiraCalls).toHaveLength(2);
  });

  it("sets changed_at only when the state really changed", async () => {
    const svc = createLinkStateService(env());
    const links = [{ kind: "jira" as const, ref: "NX-1" }];
    svc.source.states(f.projectKey, links);
    await svc.idle();
    // Same status, new `updated` (a comment): not a change, no news.
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(svc.source.states(f.projectKey, links)[0]!.changedAt).toBeNull();
    expect(listLinkStateChangesSince(f.projectKey, 0)).toEqual([]);
    jiraStatus = "Done";
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    const changeAt = clock;
    expect(svc.source.states(f.projectKey, links)[0]).toMatchObject({ state: { status: "Done" }, changedAt: changeAt });
    expect(listLinkStateChangesSince(f.projectKey, 0).map((l) => l.ref)).toEqual(["NX-1"]);
  });

  it("keeps the last good state when a read fails", async () => {
    let fail = false;
    const svc = createLinkStateService(env({
      readJira: async (_p, refs) => new Map<string, ReadResult>(refs.map((r) => [r, fail ? { state: null, error: "Jira 503" } : { state: { status: "To Do" }, error: null }])),
    }));
    const links = [{ kind: "jira" as const, ref: "NX-1" }];
    svc.source.states(f.projectKey, links);
    await svc.idle();
    fail = true;
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(svc.source.states(f.projectKey, links)[0]).toMatchObject({ state: { status: "To Do" }, error: "Jira 503", changedAt: null });
  });

  it("a first good read after failed ones is not a change", async () => {
    let fail = true;
    const svc = createLinkStateService(env({
      readJira: async (_p, refs) => new Map<string, ReadResult>(refs.map((r) => [r, fail ? { state: null, error: "Jira 503" } : { state: { status: "To Do" }, error: null }])),
    }));
    const links = [{ kind: "jira" as const, ref: "NX-1" }];
    svc.source.states(f.projectKey, links);
    await svc.idle();
    fail = false;
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(svc.source.states(f.projectKey, links)[0]).toMatchObject({ state: { status: "To Do" }, error: null, changedAt: null });
  });

  it("leaves a paused site alone for a TTL", async () => {
    let calls = 0;
    const svc = createLinkStateService(env({ readJira: async () => { calls++; return null; } }));
    const links = [{ kind: "jira" as const, ref: "NX-1" }];
    svc.source.states(f.projectKey, links);
    await svc.idle();
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(calls).toBe(1);
    clock += LINK_STATE_TTL_MS;
    svc.source.states(f.projectKey, links);
    await svc.idle();
    expect(calls).toBe(2);
  });

  it("never runs more than four reads at once", async () => {
    let active = 0;
    let peak = 0;
    const svc = createLinkStateService(env({
      readPrs: async (refs) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new Map<string, ReadResult>(refs.map((r) => [r, { state: { state: "open" }, error: null }]));
      },
    }));
    // Ten projects' worth of PR groups, each its own batch.
    for (let i = 0; i < 10; i++) svc.source.states(`proj-${i}`, [{ kind: "pr", ref: `acme/app#${i + 1}` }]);
    await svc.idle();
    expect(LINK_READ_CONCURRENCY).toBe(4);
    expect(peak).toBe(4);
  });

  it("reads a session link live", () => {
    const svc = createLinkStateService(env());
    const [s] = svc.source.states(f.projectKey, [{ kind: "session", ref: "nope" }]);
    expect(s!.state).toMatchObject({ sessionId: "nope", state: "gone" });
  });
});

describe("refreshAll", () => {
  it("does nothing when no switched-on project has open tasks with Jira or PR links", () => {
    const svc = createLinkStateService(env());
    createTask({ projectKey: f.projectKey, title: "no links" }, USER);
    expect(svc.refreshAll()).toBe(0);
  });

  it("queues the Jira and PR links of open tasks in switched-on projects only", async () => {
    const svc = createLinkStateService(env());
    createTask({ projectKey: f.projectKey, title: "open", links: [{ kind: "jira", ref: "NX-5" }, { kind: "url", ref: "https://x.test" }] }, USER);
    const closed = createTask({ projectKey: f.projectKey, title: "closed", links: [{ kind: "jira", ref: "NX-6" }] }, USER);
    updateTask(closed.id, { statusId: f.status("Done").id }, closed.revision, USER);
    expect(svc.refreshAll()).toBe(1);
    await svc.idle();
    expect(jiraCalls).toEqual([["NX-5"]]);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(svc.refreshAll()).toBe(0);
  });
});
