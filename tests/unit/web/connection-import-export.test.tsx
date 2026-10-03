/**
 * The database sidebar's Import / Export menu. Export is the one place PPM hands a connection's
 * secrets to the browser — Import recreates the connections from the file — so the menu has to
 * say that the file holds every saved password before anyone writes one to disk or a clipboard.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { ConnectionImportExport } = await import("../../../src/web/components/database/connection-import-export");

describe("the Import / Export menu", () => {
  it("says that an export holds every saved password", async () => {
    const view = await mount(
      <ConnectionImportExport
        onExport={async () => ({ version: 1, exported_at: "", connections: [] })}
        onImport={async () => ({ imported: 0, skipped: 0, errors: [] })}
      />,
    );
    try {
      expect(view.container.textContent).not.toContain("Export to file");
      await click(view.container.querySelector('button[title="Import / Export"]'));
      const text = view.container.textContent ?? "";
      expect(text).toContain("Export to file");
      expect(text).toContain("Includes every saved password, in plain text.");
    } finally {
      await view.unmount();
    }
  });
});
