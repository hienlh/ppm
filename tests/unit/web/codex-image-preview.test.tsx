import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
const { act } = await import("react");
const { AuthImageThumbnail } = await import("../../../src/web/components/chat/message-media.tsx");
const { parseUserMessage } = await import("../../../src/shared/user-message-parse.ts");
const { parseRolloutJsonl } = await import("../../../src/providers/codex-app-server/codex-history.ts");
const { setAuthToken } = await import("../../../src/web/lib/api-client.ts");
const { useImageOverlay } = await import("../../../src/web/stores/image-overlay-store.ts");
const originalFetch = globalThis.fetch;
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = originalFetch;
  useImageOverlay.getState().close();
});
afterAll(uninstallDom);

for (const filePath of ["/project/native screenshot.png", "C:\\project\\screenshot.png", "/home/user/.ppm/uploads/upload.png", "legacy-upload.png"]) {
  it(`renders and opens an authenticated attachment preview: ${filePath}`, async () => {
    const record = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
      type: "UserMessage", content: [{ type: "local_image", path: filePath }],
    } } }) + "\n";
    const message = parseRolloutJsonl(record)[0]!;
    const parsed = parseUserMessage(message.content);
    expect(parsed.files).toEqual([filePath]);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    setAuthToken("image-preview-test-token");
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
      return new Response(new Blob(["image"], { type: "image/png" }));
    }) as typeof fetch;
    view = await mount(<AuthImageThumbnail filePath={parsed.files[0]!} projectName="project" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(requests).toEqual([{
      url: filePath === "legacy-upload.png" || filePath.includes("/uploads/")
        ? `/api/project/project/chat/uploads/${filePath.split("/").pop()}`
        : `/api/fs/raw?path=${encodeURIComponent(filePath)}`,
      authorization: "Bearer image-preview-test-token",
    }]);
    const img = view.container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.src.startsWith("blob:")).toBe(true);
    await act(() => { view!.container.querySelector("button")!.click(); });
    expect(useImageOverlay.getState().src).toBe(img.src);
  });
}
