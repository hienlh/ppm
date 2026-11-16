/**
 * Telegram's "Open in PPM" on a task card links to `/project/<name>?openTask=<id>`: the address
 * names the task to open in its tab once the project is open, and nothing that is not a task id.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { parseUrlState, buildMetadataFromUrl } = await import("../../../../src/web/hooks/use-url-sync");

const ID = "0f6c2a4e-8b1d-4c3a-9e7f-2d5b6a1c9e04";

describe("?openTask=", () => {
  it("names the task on a project address", () => {
    const state = parseUrlState({ pathname: "/project/alpha", search: `?openTask=${ID}` });
    expect(state.projectName).toBe("alpha");
    expect(state.openTask).toBe(ID);
    // The task tab it opens is the same one `/project/alpha/task/<id>` opens.
    expect(buildMetadataFromUrl("task", state.openTask!, "alpha")).toEqual({ taskId: ID, projectName: "alpha" });
  });

  it("ignores anything that is not a task id", () => {
    expect(parseUrlState({ pathname: "/project/alpha", search: "?openTask=../../etc" }).openTask).toBeUndefined();
    expect(parseUrlState({ pathname: "/project/alpha", search: "" }).openTask).toBeUndefined();
  });
});
