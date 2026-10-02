import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { FfmpegInstallButton } = await import("../../../src/web/components/remote-desktop/ffmpeg-install-button");
const { api } = await import("../../../src/web/lib/api-client");
const endpoint = "/api/remote-desktop/requirements/ffmpeg/install";
let view: Mounted | undefined;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function statusGet(state: string, error?: string) {
  const spy = spyOn(api, "get").mockResolvedValue({ state, error });
  spies.push(spy);
  return spy;
}
function button() { return view!.container.querySelector("button")!; }

it("one click requests host installation and disables repeated submissions until it finishes", async () => {
  const get = statusGet("idle");
  let resolve!: (status: { state: string }) => void;
  const post = spyOn(api, "post").mockImplementation(() => new Promise(r => { resolve = r; }));
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  expect(get).toHaveBeenCalledWith(endpoint);
  await click(button());
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(endpoint);
  expect(button().disabled).toBe(true);
  await click(button());
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ state: "installing" }); });
  expect(button().disabled).toBe(true);
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain("Installing on the host");
  expect(view.container.querySelector("input,textarea,[role='dialog']")).toBeNull();
});

it("restores an installation already running on the host when the panel is reopened", async () => {
  statusGet("installing");
  const post = spyOn(api, "post");
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  expect(button().disabled).toBe(true);
  expect(button().textContent).toContain("Installing ffmpeg");
  await click(button());
  expect(post).not.toHaveBeenCalled();
});

it("shows the host installer error and lets the user retry", async () => {
  statusGet("error", "winget failed: download unavailable");
  const post = spyOn(api, "post").mockResolvedValue({ state: "installing" });
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("download unavailable");
  expect(button().disabled).toBe(false);
  await click(button());
  expect(post).toHaveBeenCalledWith(endpoint);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(button().disabled).toBe(true);
});

it("shows a failed installation request and allows a second click", async () => {
  statusGet("idle");
  const post = spyOn(api, "post").mockRejectedValueOnce(new Error("Host unreachable"))
    .mockResolvedValueOnce({ state: "installing" });
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  await click(button());
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Host unreachable");
  expect(button().disabled).toBe(false);
  await click(button());
  expect(post).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(button().disabled).toBe(true);
});

it("does not offer another installation once ffmpeg is installed", async () => {
  statusGet("installed");
  const post = spyOn(api, "post");
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  expect(button().disabled).toBe(true);
  expect(button().textContent).toContain("Installed");
  await click(button());
  expect(post).not.toHaveBeenCalled();
});

it("ignores an old idle response that arrives after the installation has started", async () => {
  let resolve!: (status: { state: string }) => void;
  spies.push(spyOn(api, "get").mockImplementation(() => new Promise(r => { resolve = r; })));
  const post = spyOn(api, "post").mockResolvedValue({ state: "installing" });
  spies.push(post);
  view = await mount(<FfmpegInstallButton label="Install with winget" />);
  await click(button());
  expect(button().disabled).toBe(true);
  await act(async () => { resolve({ state: "idle" }); });
  expect(button().disabled).toBe(true);
  expect(button().textContent).toContain("Installing ffmpeg");
  await click(button());
  expect(post).toHaveBeenCalledTimes(1);
});
