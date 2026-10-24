import { afterAll, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { useInlineBlame } = await import("../../../src/web/hooks/use-inline-blame");
const { api } = await import("../../../src/web/lib/api-client");

it("does not discover repositories or fetch blame while disabled", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ rootIsRepo: false, repos: [] });
  function Probe() {
    useInlineBlame({ editor: null, monaco: null, projectName: "disabled-blame", filePath: "README.md", enabled: false });
    return null;
  }
  const view = await mount(<Probe />);
  try { expect(get).not.toHaveBeenCalled(); }
  finally { await view.unmount(); get.mockRestore(); }
});
