import { afterAll, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { act } = await import("react");
const { useConnections } = await import("../../../src/web/components/database/use-connections");
const { DB_CONNECTIONS_CHANGED } = await import("../../../src/web/components/database/db-sidebar-reveal");
const { api } = await import("../../../src/web/lib/api-client");

it("does not contact database services when disabled, including refresh events and callbacks", async () => {
  const get = spyOn(api, "get").mockResolvedValue([]);
  const put = spyOn(api, "put").mockResolvedValue({});
  let connections!: ReturnType<typeof useConnections>;
  function Probe() {
    connections = useConnections(false);
    return null;
  }
  const view = await mount(<Probe />);
  try {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DB_CONNECTIONS_CHANGED, { detail: { connectionId: 7, refreshTables: true } }));
      await connections.refreshTables(7);
      await connections.updateConnection(7, { name: "ignored" });
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(connections.connections).toEqual([]);
  } finally {
    await view.unmount();
    get.mockRestore();
    put.mockRestore();
  }
});

it("still loads connections when enabled by default", async () => {
  const get = spyOn(api, "get").mockResolvedValue([]);
  function Probe() { useConnections(); return null; }
  const view = await mount(<Probe />);
  try { expect(get).toHaveBeenCalledWith("/api/db/connections"); }
  finally { await view.unmount(); get.mockRestore(); }
});
