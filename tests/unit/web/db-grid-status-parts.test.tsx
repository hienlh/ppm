/**
 * The small parts the data grid draws over itself: Rows / Count / Sum of a selection and the
 * "Loading data" boxes.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { GridLoadingBox, GridSelectionStats } = await import("../../../src/web/components/database/grid/grid-status-bar");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("Rows / Count / Sum of a selection", () => {
  const cells = () => [...document.querySelectorAll('table[aria-label="Selected cells"] tr')].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

  it("lists the rows, the cells and the sum", async () => {
    view = await mount(<GridSelectionStats stats={{ rows: 3, count: 6, sum: 9.5 }} right={8} bottom={20} />);
    expect(cells()).toEqual([["Rows:", "3"], ["Count:", "6"], ["Sum:", (9.5).toLocaleString()]]);
  });

  it("leaves Sum empty with no number selected, and keeps a sum's decimals", async () => {
    view = await mount(<GridSelectionStats stats={{ rows: 1, count: 2, sum: null }} right={8} bottom={20} />);
    expect(cells()[2]).toEqual(["Sum:", ""]);
    await view.unmount();
    view = await mount(<GridSelectionStats stats={{ rows: 2, count: 2, sum: 0.123456789 }} right={8} bottom={20} />);
    expect(cells()[2]).toEqual(["Sum:", (0.123456789).toLocaleString(undefined, { maximumFractionDigits: 10 })]);
  });
});

describe("the loading boxes", () => {
  it("covers the grid while it is read again, and sits at its foot while more rows come", async () => {
    view = await mount(<GridLoadingBox text="Loading data" cover />);
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Loading data");
    expect(document.querySelector('[role="status"]')!.parentElement!.className).toContain("inset-0");
    await view.unmount();
    view = await mount(<GridLoadingBox text="Loading data" cover={false} bottom={40} />);
    const foot = document.querySelector('[role="status"]')!.parentElement as HTMLElement;
    expect(foot.className).not.toContain("inset-0");
    expect(foot.style.bottom).toBe("40px");
  });
});
