/**
 * One CHANGELOG section as the release-notes window draws it: bold lead-ins and code spans
 * become elements — including code inside a bold lead-in, which is how most entries begin —
 * and nothing in the text is ever parsed as HTML.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { ReleaseNotesEntry } = await import("../../../src/web/components/release-notes/release-notes-entry");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("ReleaseNotesEntry", () => {
  it("renders a bold lead-in with code inside it, and code outside", async () => {
    view = await mount(<ReleaseNotesEntry version="1.2.3" size="comfortable" body={
      "### Added\n\n- **Accounts from `claude setup-token` work.** Run `ppm upgrade` to get it."
    } />);

    const strong = document.body.querySelector("strong")!;
    expect(strong.textContent).toBe("Accounts from claude setup-token work.");
    expect(strong.querySelector("code")?.textContent).toBe("claude setup-token");
    expect([...document.body.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["claude setup-token", "ppm upgrade"]);
    expect(document.body.textContent).not.toContain("`");
    expect(document.body.textContent).not.toContain("**");
    expect(document.body.textContent).toContain("Added");
  });

  it("marks the installed version, and only that one", async () => {
    view = await mount(<>
      <ReleaseNotesEntry version="1.2.3" body="- a" installed />
      <ReleaseNotesEntry version="1.2.2" body="- b" />
    </>);
    const badges = [...document.body.querySelectorAll("section")].map((s) => s.textContent?.includes("installed"));
    expect(badges).toEqual([true, false]);
  });

  it("shows markup in an entry as text", async () => {
    view = await mount(<ReleaseNotesEntry version="1.2.3" body="- <img src=x onerror=alert(1)> stays text" />);
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)> stays text");
  });
});
