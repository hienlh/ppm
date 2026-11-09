import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { click, installDom, mount, uninstallDom } from "../../helpers/react-dom";
import type { DesignShareGuestInfo } from "../../../src/shared/design-share-guest-types";

installDom();
const { act } = await import("react");
const { useShareSession } = await import("../../../src/web/design-share-page/use-share-session");
const { ShareUpdatedBar } = await import("../../../src/web/design-share-page/share-states");
const { isVersionChanged } = await import("../../../src/web/design-share-page/share-api");
const { repinnedSince } = await import("../../../src/web/design-share-page/use-share-threads");
afterAll(uninstallDom);

/**
 * A reviewer page left open while the owner re-pins its link has to find out: from the next
 * poll, which names the version the link shows now, or from a comment the server refused
 * for naming the old one. Either way it shows the reload bar.
 */

const SHOWN = "20261021-100000-aaaa";
const NEWER = "20261021-110000-bbbb";
const info: DesignShareGuestInfo = {
  linkId: "0123456789ab", slug: "home", title: "Home", kind: "page", entry: "index.html", variants: [],
  expiresAt: null, versionCreatedAt: new Date().toISOString(), versionId: SHOWN,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = answer(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ETag: `"e${Math.random()}"` } });
  }) as unknown as typeof fetch;
}

let session: ReturnType<typeof useShareSession> | null = null;
function Probe() {
  session = useShareSession(info, "code");
  return <p data-changed={String(session.versionChanged)}>{session.notice?.message ?? ""}</p>;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("design share page after a re-pin", () => {
  it("shows the bar once a poll names another version, and not while it names the shown one", async () => {
    let version = SHOWN;
    serve(() => ({ status: 200, body: { ok: true, data: { threads: [], versionId: version } } }));
    const page = await mount(<Probe />);
    await settle();
    expect(page.container.querySelector("p")!.dataset.changed).toBe("false");
    version = NEWER;
    await act(async () => { session!.actions.reply("aaaaaaaaaaaa", "x", "Ann"); });
    await settle();
    expect(page.container.querySelector("p")!.dataset.changed).toBe("true");
    await page.unmount();
  });

  it("shows the bar, not a notice, when a new comment is refused for naming the old version", async () => {
    const posted: unknown[] = [];
    serve((url, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { status: 409, body: { ok: false, error: "This design was updated.", code: "version-changed" } };
      }
      return { status: 200, body: { ok: true, data: { threads: [], versionId: SHOWN } } };
    });
    const page = await mount(<Probe />);
    await settle();
    let ok = true;
    await act(async () => { ok = await session!.actions.addThread({ file: "index.html" }, "hi", "Ann", () => {}); });
    await settle();
    expect(ok).toBe(false);
    expect(posted).toEqual([expect.objectContaining({ versionId: SHOWN })]);
    const p = page.container.querySelector("p")!;
    expect(p.dataset.changed).toBe("true");
    expect(p.textContent).toBe("");
    await page.unmount();
  });

  it("offers one reload button big enough to tap", async () => {
    const onReload = mock(() => {});
    const bar = await mount(<ShareUpdatedBar onReload={onReload} />);
    const button = bar.container.querySelector("button")!;
    expect(button.textContent).toBe("Reload");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
    await click(button);
    expect(onReload).toHaveBeenCalledTimes(1);
    await bar.unmount();
  });

  it("reads the version from the answer and the refusal's code", () => {
    expect(repinnedSince(SHOWN, SHOWN)).toBe(false);
    expect(repinnedSince(SHOWN, null)).toBe(false);
    expect(repinnedSince(SHOWN, NEWER)).toBe(true);
    expect(isVersionChanged({ kind: "error", status: 409, message: "x", code: "version-changed" })).toBe(true);
    expect(isVersionChanged({ kind: "error", status: 409, message: "x", code: "EHASREPLIES" })).toBe(false);
  });
});
