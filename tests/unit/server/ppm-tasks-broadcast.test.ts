/**
 * The `/ws/global` push of task changes: gathered per project for the delay, ids only, one event
 * per kind and project, and nothing for a project PPM no longer has a name for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { createPpmTasksBroadcaster } from "../../../src/server/ws/ppm-tasks-broadcast.ts";
import { ppmTasksEvents, type PpmTasksEvent } from "../../../src/services/ppm-tasks/ppm-tasks-events.ts";
import type { TasksGlobalEvent } from "../../../src/shared/ppm-tasks-api.ts";

const NAMES: Record<string, string> = { "/p/demo": "demo", "/p/web": "web" };
const actor = { kind: "manager" as const, label: "Manager demo" };

function taskEvent(projectKey: string, ...taskIds: string[]): PpmTasksEvent {
  return { type: "task", projectKey, taskIds, historyIds: [1], actor, via: "tool", kind: "updated", unattended: false };
}

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

function setup(delayMs = 20) {
  const sent: TasksGlobalEvent[] = [];
  const b = createPpmTasksBroadcaster({ send: (e) => sent.push(e), nameOf: (k) => NAMES[k] ?? null, delayMs });
  stop = b.stop;
  return { b, sent };
}

describe("ppm tasks broadcaster", () => {
  it("coalesces a burst into one event per project, ids de-duplicated", async () => {
    const { b, sent } = setup();
    for (let i = 0; i < 20; i++) b.handle(taskEvent("/p/demo", `t${i % 5}`));
    b.handle(taskEvent("/p/web", "w1"));
    expect(sent).toEqual([]);
    await Bun.sleep(40);
    expect(sent).toEqual([
      { type: "tasks:changed", project: "demo", taskIds: ["t0", "t1", "t2", "t3", "t4"] },
      { type: "tasks:changed", project: "web", taskIds: ["w1"] },
    ]);
  });

  it("sends project and link-state changes as their own events", () => {
    const { b, sent } = setup();
    b.handle({ type: "project", projectKey: "/p/demo", what: "statuses", actor, via: "ppm" });
    b.handle({ type: "link_states", projectKeys: ["/p/demo", "/p/web"] });
    b.handle(taskEvent("/p/demo", "t1"));
    b.flush();
    expect(sent).toEqual([
      { type: "tasks:project_changed", project: "demo" },
      { type: "tasks:changed", project: "demo", taskIds: ["t1"] },
      { type: "tasks:link_states", project: "demo" },
      { type: "tasks:link_states", project: "web" },
    ]);
  });

  it("drops a project with no PPM name, and starts a new window after a flush", async () => {
    const { b, sent } = setup();
    b.handle(taskEvent("/p/gone", "x"));
    b.flush();
    expect(sent).toEqual([]);
    b.handle(taskEvent("/p/demo", "a"));
    await Bun.sleep(40);
    b.handle(taskEvent("/p/demo", "b"));
    await Bun.sleep(40);
    expect(sent.map((e) => (e.type === "tasks:changed" ? e.taskIds : []))).toEqual([["a"], ["b"]]);
  });

  it("listens to the store's events once started, and not after stop", async () => {
    const { b, sent } = setup(5);
    b.start();
    b.start();
    ppmTasksEvents.emit(taskEvent("/p/demo", "live"));
    await Bun.sleep(20);
    expect(sent).toEqual([{ type: "tasks:changed", project: "demo", taskIds: ["live"] }]);
    b.stop();
    ppmTasksEvents.emit(taskEvent("/p/demo", "after"));
    await Bun.sleep(20);
    expect(sent).toHaveLength(1);
  });
});
