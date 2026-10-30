/**
 * The Review opener the chat's changes bar holds. It is built once per session, so that the
 * context every turn's action bar reads stays the same object while the agent streams — which
 * makes it easy to hand it the paths of the render that built it rather than the current ones.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { useSessionChangesValue } = await import("../../../src/web/components/chat/session-changes-context.tsx");
const { useTabStore } = await import("../../../src/web/stores/tab-store.ts");

afterEach(() => {
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

const files: never[] = [];
const refresh = () => {};
let openReview: ((path?: string) => void) | null = null;

function Chat({ paths }: { paths: string[] }) {
  ({ openReview } = useSessionChangesValue({
    projectName: "proj", sessionId: "s1", providerId: "claude", changes: { files, paths, refresh },
  }));
  return null;
}

describe("the session's Review opener", () => {
  it("is built once, and opens the tab on the paths of the latest render", async () => {
    const view = await mount(<Chat paths={["a.ts"]} />);
    try {
      const first = openReview;
      await view.rerender(<Chat paths={["a.ts", "b.ts"]} />);
      expect(openReview).toBe(first);

      openReview!();
      const tab = useTabStore.getState().tabs.find((t) => t.type === "session-review");
      expect(tab?.metadata?.paths).toEqual(["a.ts", "b.ts"]);
    } finally {
      await view.unmount();
    }
  });
});
