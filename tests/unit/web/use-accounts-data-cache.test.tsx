/**
 * The chat's usage panel is mounted afresh on every open, so it showed "Loading..." until all
 * three account requests had answered — every time, and for most of a minute while the server
 * was stalled. These pin the two halves of the fix: what one load answered is shown at once by
 * the next mount, and one slow request no longer holds back the ones that already answered.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, installGlobal, mount, uninstallDom } from "../../helpers/react-dom";

installDom();
const { act } = await import("react");
const { useAccountsData } = await import("../../../src/web/components/settings/accounts/use-accounts-data");

afterAll(uninstallDom);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });

const USAGE = [{ accountId: "acc-1", accountLabel: "Jim", accountStatus: "active", isOAuth: true, usage: {} }];
const ACCOUNTS = [{ id: "acc-1", label: "Jim", status: "active" }];

/** Answers each account endpoint from `routes`; a route holding a deferred answers when told to. */
function serve(routes: Record<string, () => Promise<Response>>) {
  installGlobal("fetch", (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const route = routes[path];
    return route ? route() : Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function Probe() {
  const { usages, accounts, initialLoading } = useAccountsData();
  return <p>{`loading=${initialLoading} usages=${usages.length} accounts=${accounts.length}`}</p>;
}

describe("useAccountsData", () => {
  it("shows the requests that answered while a slow one is still out", async () => {
    const usage = deferred<Response>();
    serve({
      "/api/accounts/usage": () => usage.promise,
      "/api/accounts": async () => envelope(ACCOUNTS),
      "/api/accounts/active": async () => envelope(ACCOUNTS[0]),
    });
    const view = await mount(<Probe />);
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(view.container.textContent).toBe("loading=true usages=0 accounts=1");

      await act(async () => { usage.resolve(envelope(USAGE)); await new Promise((r) => setTimeout(r, 20)); });
      expect(view.container.textContent).toBe("loading=false usages=1 accounts=1");
    } finally {
      await view.unmount();
    }
  });

  it("opens on what the last load answered instead of on a spinner", async () => {
    // A server that never answers: anything shown came from the previous mount.
    const never = () => new Promise<Response>(() => {});
    serve({ "/api/accounts/usage": never, "/api/accounts": never, "/api/accounts/active": never });
    const view = await mount(<Probe />);
    try {
      expect(view.container.textContent).toBe("loading=false usages=1 accounts=1");
    } finally {
      await view.unmount();
    }
  });
});
