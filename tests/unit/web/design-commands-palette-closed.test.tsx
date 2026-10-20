/**
 * The PPM Assistant lists the device's commands while the command palette is closed, so the
 * per-design "Open Design" commands must be in the registry without the palette open, and
 * follow designs created afterwards.
 */
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom";

installDom();
const { useDesignCommands } = await import("../../../src/web/components/layout/command-palette-design-commands");
const { listCommands } = await import("../../../src/web/lib/commands/command-registry");
const { announceDesignsChanged } = await import("../../../src/web/lib/design/design-ui-events");

const realFetch = globalThis.fetch;
let designs: Array<{ slug: string; title: string; kind: string }> = [];
let requests = 0;
let view: Mounted | null = null;

beforeEach(() => {
  requests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/designs")) throw new Error(`unexpected request ${url}`);
    requests++;
    return new Response(JSON.stringify({ ok: true, data: { designs, systems: [] } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(async () => { await view?.unmount(); view = null; });
afterAll(() => { globalThis.fetch = realFetch; uninstallDom(); });

function Host({ project, open }: { project: string; open: boolean }) {
  useDesignCommands(project, open);
  return null;
}

const ctx = { project: { name: "p" }, isMobile: false, isTouchOnly: false, lspEnabled: false, getBinding: () => "", extensions: null };
const designIds = () => listCommands(ctx).map((c) => c.id).filter((id) => id.startsWith("design:"));

async function settle(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await Bun.sleep(5); });
}

it("publishes Open Design commands while the palette is closed", async () => {
  designs = [{ slug: "landing", title: "Landing", kind: "page" }];
  view = await mount(<Host project="p" open={false} />);
  await settle(() => designIds().length > 0);
  expect(designIds()).toEqual(["design:landing"]);
});

it("picks up a design created later without the palette opening", async () => {
  designs = [];
  view = await mount(<Host project="p" open={false} />);
  await settle(() => requests > 0);
  expect(designIds()).toEqual([]);
  designs = [{ slug: "deck", title: "Deck", kind: "slides" }];
  await act(async () => { announceDesignsChanged("p"); });
  await settle(() => designIds().length > 0);
  expect(designIds()).toEqual(["design:deck"]);
});
