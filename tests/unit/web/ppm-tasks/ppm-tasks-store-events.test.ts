/**
 * A check of handed-off work changes no task, so it reaches the page only as `tasks:link_states`.
 * Rows and details read the check from the task itself, so that event has to re-read the project's
 * lists and details too, or "stalled 40 min" shows only after some unrelated edit.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { ensurePpmTasksEvents, ppmTasksStore } = await import("../../../../src/web/stores/ppm-tasks-store");

describe("task store events", () => {
  it("re-reads the project's lists and details when its link states change", () => {
    const reread: string[] = [];
    const original = ppmTasksStore.getState().onProjectChanged;
    ppmTasksStore.setState({ onProjectChanged: (project: string) => { reread.push(project); } });
    try {
      ensurePpmTasksEvents();
      window.dispatchEvent(new CustomEvent("tasks:link_states", { detail: { type: "tasks:link_states", project: "alpha" } }));
      window.dispatchEvent(new CustomEvent("tasks:project_changed", { detail: { type: "tasks:project_changed", project: "beta" } }));
      expect(reread).toEqual(["alpha", "beta"]);
    } finally {
      ppmTasksStore.setState({ onProjectChanged: original });
    }
  });
});
