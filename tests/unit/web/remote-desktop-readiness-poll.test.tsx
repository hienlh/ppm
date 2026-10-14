/**
 * The readiness gate wraps the viewer for the whole session, and it polled `/capabilities` for
 * all of it: the only thing that turned the poll off was `accepted`, set by a Continue button a
 * ready host never shows. Each poll re-runs the host's probes — on a Wayland host without a GPU
 * encoder, four `gst-inspect-1.0`, on the machine that is encoding the session in software. The
 * poll is there to watch an unmet checklist clear, so it stops once it has.
 */
import { afterAll, afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act } from "react";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { RemoteDesktopReadinessGate } = await import("../../../src/web/components/remote-desktop/remote-desktop-readiness-gate.tsx");
const { READINESS_POLL_MS } = await import("../../../src/web/components/remote-desktop/use-remote-desktop-readiness.ts");
const { api } = await import("../../../src/web/lib/api-client");

/** What `/capabilities` answers on a Wayland host, with or without its H.264 encoder. */
function caps(ready: boolean) {
  return {
    platform: "linux", platformSupported: true, videoReady: ready, inputReady: ready,
    requirements: [{
      id: "gst-h264", ok: ready, gates: "video", title: "A GStreamer H.264 encoder",
      detail: "Install gst-plugins-ugly.", actions: [],
    }],
  };
}

let view: Mounted | undefined;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  for (const spy of spies.splice(0)) spy.mockRestore();
  jest.useRealTimers();
});

/** Let an answer already resolved reach the screen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

/** One poll interval at a time: advancing several in one go would batch their re-renders into
 *  one, and the requests with them. */
async function wait(polls: number): Promise<void> {
  for (let i = 0; i < polls; i++) {
    await act(async () => { jest.advanceTimersByTime(READINESS_POLL_MS); });
    await settle();
  }
}

async function openGate(): Promise<void> {
  view = await mount(
    <RemoteDesktopReadinessGate onCancel={() => {}}>
      <div data-testid="viewer" />
    </RemoteDesktopReadinessGate>,
  );
  await settle();
}

const viewer = () => view!.container.querySelector('[data-testid="viewer"]');

describe("the readiness gate's poll", () => {
  it("stops once the host is ready, rather than running for the whole session", async () => {
    const get = spyOn(api, "get").mockResolvedValue(caps(true));
    spies.push(get);
    jest.useFakeTimers();
    await openGate();
    expect(viewer()).not.toBeNull();

    await wait(30); // a minute of session
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while the checklist is unmet, and stops once it clears", async () => {
    const get = spyOn(api, "get").mockResolvedValue(caps(false));
    spies.push(get);
    jest.useFakeTimers();
    await openGate();
    expect(viewer()).toBeNull();

    // The user is installing what is missing: this is when asking again is the point.
    await wait(2);
    expect(get).toHaveBeenCalledTimes(3);

    get.mockResolvedValue(caps(true));
    await wait(1);
    expect(get).toHaveBeenCalledTimes(4);
    expect(viewer()).not.toBeNull();

    await wait(30);
    expect(get).toHaveBeenCalledTimes(4);
  });
});
