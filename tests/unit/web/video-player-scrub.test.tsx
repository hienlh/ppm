/**
 * Dragging the video player's seek bar.
 *
 * Measured in Chrome against the player as it was: a 1.3 s drag across a paused video
 * showed no frame at all until the thumb was released, and a drag across a playing one
 * showed the video carrying on from where it had been. After the release the thumb went
 * back to the position from before the drag — briefly when paused, and for good when
 * playing, together with the clock, while the video played on 80 seconds further along.
 * The last part came from the slider snapping its value to `step` behind React's back;
 * happy-dom does not snap, so that is pinned through `seekBarValue` instead.
 */
import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";
import { VideoPlayer } from "../../../src/web/components/editor/video-player/video-player.tsx";
import { seekBarValue } from "../../../src/web/components/editor/video-player/video-player-controls.tsx";

installDom();
afterAll(uninstallDom);

/** What the `<video>` reports and what the player asked of it. */
const media = { paused: true, currentTime: 0, seeks: [] as number[], plays: 0, pauses: 0 };

function stubVideoElements(): () => void {
  const original = document.createElement;
  document.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    const el = original.call(this, tag, options);
    if (tag.toLowerCase() === "video") {
      Object.defineProperties(el, {
        readyState: { get: () => 4 },
        duration: { get: () => 141.84 },
        paused: { get: () => media.paused },
        currentTime: {
          get: () => media.currentTime,
          set: (t: number) => { media.currentTime = t; media.seeks.push(t); },
        },
        // The browser announces both a moment later, as a queued task.
        play: {
          value: () => {
            media.paused = false; media.plays++;
            queueMicrotask(() => el.dispatchEvent(new Event("play")));
            return Promise.resolve();
          },
        },
        pause: {
          value: () => {
            media.paused = true; media.pauses++;
            queueMicrotask(() => el.dispatchEvent(new Event("pause")));
          },
        },
      });
    }
    return el;
  } as typeof document.createElement;
  return () => { document.createElement = original; };
}

let view: Mounted | null = null;
let restore: (() => void) | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  restore?.();
  restore = null;
});

async function mountPlayer(mode: "native" | "transcode", state: { paused: boolean; currentTime: number }) {
  Object.assign(media, state, { seeks: [], plays: 0, pauses: 0 });
  restore = stubVideoElements();
  view = await mount(
    <VideoPlayer filePath="clip.mp4" projectName="p" mode={mode} probeDuration={mode === "transcode" ? 141.84 : null} />,
  );
  // Only what the drag itself does should be counted.
  Object.assign(media, { seeks: [], plays: 0, pauses: 0 });
  return view.container;
}

const seekBar = (root: Element) => root.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!;

/** Move the thumb as the browser does: set the value underneath React, then fire `input`. */
async function dragTo(input: HTMLInputElement, value: number) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function release(input: HTMLInputElement, type = "pointerup") {
  await act(async () => {
    input.dispatchEvent(new PointerEvent(type, { bubbles: true }));
  });
}

const playButtonLabel = (root: Element) =>
  root.querySelector('button[aria-label="Pause"], button[aria-label="Play"]')!.getAttribute("aria-label");

describe("dragging the seek bar", () => {
  it("seeks the video while the thumb moves, not only on release", async () => {
    const root = await mountPlayer("native", { paused: true, currentTime: 2 });
    await dragTo(seekBar(root), 30);
    await dragTo(seekBar(root), 60);
    expect(media.seeks).toEqual([30, 60]);
  });

  it("shows the dropped position at once instead of the one from before the drag", async () => {
    const root = await mountPlayer("native", { paused: true, currentTime: 2 });
    await dragTo(seekBar(root), 85.4);
    await release(seekBar(root));
    // No timeupdate has arrived: the seek has not decoded yet.
    expect(root.textContent).toContain("1:25 / 2:21");
    expect(seekBar(root).value).toBe("85.4");
  });

  it("holds a playing video still during the drag and plays on after it", async () => {
    const root = await mountPlayer("native", { paused: false, currentTime: 3.617 });
    await dragTo(seekBar(root), 40);
    expect(media.pauses).toBe(1);
    await dragTo(seekBar(root), 60);
    expect(media.pauses).toBe(1);
    expect(media.plays).toBe(0);
    // Chrome's own controls do the same: the button does not flip for the drag.
    expect(playButtonLabel(root)).toBe("Pause");
    await release(seekBar(root));
    expect(media.plays).toBe(1);
    expect(media.currentTime).toBe(60);
    expect(playButtonLabel(root)).toBe("Pause");
  });

  it("ends the drag when the browser takes the touch over for a scroll", async () => {
    const root = await mountPlayer("native", { paused: false, currentTime: 3.617 });
    await dragTo(seekBar(root), 40);
    await release(seekBar(root), "pointercancel");
    expect(media.plays).toBe(1);
    expect(root.textContent).toContain("0:40 / 2:21");
  });

  it("still says Play when the video is paused some other way", async () => {
    const root = await mountPlayer("native", { paused: false, currentTime: 3.617 });
    await act(async () => { root.querySelector<HTMLVideoElement>("video")!.pause(); });
    expect(playButtonLabel(root)).toBe("Play");
  });

  it("leaves a paused video paused after the drag", async () => {
    const root = await mountPlayer("native", { paused: true, currentTime: 2 });
    await dragTo(seekBar(root), 40);
    await release(seekBar(root));
    expect(media.plays).toBe(0);
  });

  it("does not seek a transcoded stream until the thumb is released", async () => {
    const root = await mountPlayer("transcode", { paused: true, currentTime: 0 });
    await dragTo(seekBar(root), 40);
    expect(media.seeks).toEqual([]);
    expect(media.pauses).toBe(0);
    expect(root.textContent).toContain("0:40 / 2:21");
  });
});

describe("seekBarValue", () => {
  it("is what the slider renders while the video plays", async () => {
    // happy-dom keeps whatever value React writes, so an unsnapped position shows up as itself.
    const root = await mountPlayer("native", { paused: false, currentTime: 0 });
    media.currentTime = 3.617423;
    await act(async () => { root.querySelector("video")!.dispatchEvent(new Event("timeupdate")); });
    expect(seekBar(root).value).toBe("3.6");
  });

  it("puts the value on the slider's 0.1 s grid, where the browser would snap it anyway", () => {
    expect(seekBarValue(3.617423, 141.84)).toBe(3.6);
    expect(String(seekBarValue(0.30000000000000004, 141.84))).toBe("0.3");
    // The end of a clip that does not sit on the grid rounds down onto it, never past max.
    expect(seekBarValue(141.84, 141.84)).toBe(141.8);
    expect(seekBarValue(200, 141.84)).toBe(141.8);
  });
});
