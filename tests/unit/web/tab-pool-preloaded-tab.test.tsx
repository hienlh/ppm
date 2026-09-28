/**
 * The spinner the tab pool shows while a tab's code loads must not appear at all for a tab
 * whose code was loaded ahead — react-dom keeps a spinner up for at least 300 ms once it has
 * shown one. Checked through the real registry entry and the real `ReparentingTab`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
const { lazy } = await import("react");
const { TAB_COMPONENTS } = await import("../../../src/web/components/layout/tab-pool");
const { ReparentingTab } = await import("../../../src/web/components/layout/reparenting-tab");
const { ProblemsPanel } = await import("../../../src/web/components/problems/problems-panel");

afterAll(uninstallDom);

/** Opens `component` as a tab and reports whether the pool's spinner was ever in the DOM. */
async function open(component: Parameters<typeof ReparentingTab>[0]["component"]) {
  const hidden = document.createElement("div");
  document.body.appendChild(hidden);
  let spun = false;
  const observer = new window.MutationObserver(() => {
    if (hidden.querySelector(".animate-spin")) spun = true;
  });
  observer.observe(hidden, { childList: true, subtree: true });
  const view = await mount(
    <ReparentingTab tabId="problems-1" panelId="panel-1" component={component} isActive hiddenContainer={hidden} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer.disconnect();
  const text = hidden.textContent ?? "";
  await view.unmount();
  hidden.remove();
  return { spun, text };
}

describe("a tab whose code was loaded ahead", () => {
  it("opens without the pool's spinner", async () => {
    await TAB_COMPONENTS.problems.preload();
    const { spun, text } = await open(TAB_COMPONENTS.problems);
    expect(text).not.toBe("");
    expect(spun).toBe(false);
  });

  it("is measured against React.lazy, which shows it for the same loaded module", async () => {
    const Plain = lazy(async () => ({ default: ProblemsPanel }));
    const { spun, text } = await open(Plain);
    expect(text).not.toBe("");
    expect(spun).toBe(true);
  });
});
