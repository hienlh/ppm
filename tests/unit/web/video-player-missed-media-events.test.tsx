/**
 * The video player's seek bar, against a `<video>` that finished loading before React
 * committed it.
 *
 * React sets `src` while it renders, before the element is in the page, and the browser
 * starts loading right then. When the file is already in the browser's media cache —
 * reopening a video, or the app rendering the player more than once while it boots, which
 * measured two to six `<video>` elements for one player — `loadedmetadata` fired 1–7 ms
 * after the element was created, still detached. React ignores an event aimed at an
 * element it has not committed, and `loadedmetadata` never fires again for that load, so
 * the player never learned the duration: the clock read "0:18" with no total and the seek
 * bar, which is only drawn once the duration is known, was simply not there. Whether the
 * event landed before or after the commit was a race, so the bar came and went between
 * two opens of the same file.
 *
 * happy-dom loads no media and fires no media events, which makes it the right harness:
 * the only way the player can know the duration is by reading the element.
 */
import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";
import { VideoPlayer } from "../../../src/web/components/editor/video-player/video-player.tsx";

installDom();
afterAll(uninstallDom);

/** What every `<video>` created from here on reports, as the browser would leave it. */
const media = { readyState: 0, duration: Number.NaN, paused: true };

/** Give the next `<video>` React creates the state in `media` instead of happy-dom's. */
function stubVideoElements(): () => void {
  const original = document.createElement;
  document.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    const el = original.call(this, tag, options);
    if (tag.toLowerCase() === "video") {
      Object.defineProperties(el, {
        readyState: { get: () => media.readyState },
        duration: { get: () => media.duration },
        paused: { get: () => media.paused },
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

async function mountPlayer(): Promise<Mounted> {
  restore = stubVideoElements();
  view = await mount(<VideoPlayer filePath="clip.mp4" projectName="p" mode="native" />);
  return view;
}

const seekBar = (root: Element) => root.querySelector<HTMLInputElement>('input[aria-label="Seek"]');

describe("video player with media events it never received", () => {
  it("shows the seek bar for a video that loaded before React committed it", async () => {
    // HAVE_ENOUGH_DATA and already autoplaying: loadedmetadata, canplay and play are all gone.
    Object.assign(media, { readyState: 4, duration: 141.84, paused: false });
    const { container } = await mountPlayer();

    expect(seekBar(container)?.max).toBe("141.84");
    expect(container.textContent).toContain("0:00 / 2:21");
    // The spinner and the play button were stuck on the same missed events.
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector('button[aria-label="Pause"]')).not.toBeNull();
  });

  it("reads the duration from HAVE_METADATA on, and stops waiting only from HAVE_FUTURE_DATA", async () => {
    // The two levels the missed `loadedmetadata` and `canplay` fire at.
    const stateAt = async (readyState: number) => {
      Object.assign(media, { readyState, duration: 141.84, paused: true });
      const { container } = await mountPlayer();
      const state = { bar: seekBar(container)?.max ?? null, spinner: container.querySelector(".animate-spin") !== null };
      await view!.unmount(); view = null; restore!(); restore = null;
      return state;
    };
    expect(await stateAt(1)).toEqual({ bar: "141.84", spinner: true }); // HAVE_METADATA
    expect(await stateAt(2)).toEqual({ bar: "141.84", spinner: true }); // HAVE_CURRENT_DATA: no canplay yet
    expect(await stateAt(3)).toEqual({ bar: "141.84", spinner: false }); // HAVE_FUTURE_DATA
  });

  it("still takes the duration from loadedmetadata on a cold load", async () => {
    Object.assign(media, { readyState: 0, duration: Number.NaN, paused: true });
    const { container } = await mountPlayer();
    expect(seekBar(container)).toBeNull();
    expect(container.querySelector(".animate-spin")).not.toBeNull();

    Object.assign(media, { readyState: 1, duration: 60 });
    await act(async () => {
      container.querySelector("video")!.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(seekBar(container)?.max).toBe("60");
  });
});
