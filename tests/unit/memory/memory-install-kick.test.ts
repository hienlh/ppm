import { describe, expect, test } from "bun:test";
import { kickWhenInstalled } from "../../../src/services/memory/memory-host-client.ts";

// Found on the live server (2026-11-12): the queue ran once while the model was still downloading,
// kept "Local embedding model is not installed", and nothing kicked it after the install finished.
describe("the embedding queue runs once the local model is installed", () => {
  test("downloading → ready kicks the queue once", () => {
    let kicks = 0;
    const onInstall = kickWhenInstalled(() => kicks++);
    onInstall({ state: "installing" });
    onInstall({ state: "installing" });
    expect(kicks).toBe(0);
    onInstall({ state: "ready" });
    expect(kicks).toBe(1);
    onInstall({ state: "ready" });
    expect(kicks).toBe(1);
  });

  test("an install after an uninstall kicks again", () => {
    let kicks = 0;
    const onInstall = kickWhenInstalled(() => kicks++);
    onInstall({ state: "ready" });
    onInstall({ state: "not-installed" });
    onInstall({ state: "installing" });
    onInstall({ state: "ready" });
    expect(kicks).toBe(2);
  });
});
