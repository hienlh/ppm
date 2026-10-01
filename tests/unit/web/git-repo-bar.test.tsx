/**
 * The repository row above Source Control and Branch Review, now a searchable
 * select.
 *
 * The one thing this can get wrong that the branch picker cannot: a branch is
 * shown and chosen by the same string, but a repository is *shown* by its path
 * relative to the project and *chosen* by its absolute one. Hand `onChoose` the
 * label and the git routes are scoped to a directory that does not exist — which
 * the server answers with a 400 and the panel as "not a git repository".
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { installDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";
import type { GitRepoCandidate } from "../../../src/web/lib/git-repo-scope.ts";

installDom();

const { GitRepoBar } = await import("../../../src/web/components/git/git-repo-picker.tsx");

const repo = (relative: string): GitRepoCandidate => ({
  path: `/home/u/work/${relative}`,
  name: relative.split("/").pop()!,
  relative,
});

const repos = [
  repo("nxsys-backend-nx5833"),
  repo("nxsys-backend-nx5838"),
  repo("nxsys-backend-nx5838-ma"),
  repo("prod-ref/nxsys-backend"),
];

let chosen: string[] = [];
let view: Mounted | null = null;

beforeEach(() => { chosen = []; });
afterEach(async () => { await view?.unmount(); view = null; });

const trigger = () => document.querySelector<HTMLElement>('[data-testid="git-repo-picker"]');
const rowValues = () =>
  [...document.querySelectorAll<HTMLElement>("[data-value]")].map((el) => el.dataset.value);

async function type(text: string) {
  const el = document.querySelector<HTMLInputElement>('input[aria-label="Search repository"]');
  if (!el) throw new Error("the filter box is not open");
  const { act } = await import("react");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the repository row", () => {
  it("names the repository by its relative path, with the full one as the tooltip", async () => {
    view = await mount(<GitRepoBar repo={repos[0]!} repos={repos} onChoose={(p) => chosen.push(p)} />);
    expect(trigger()?.textContent).toContain("nxsys-backend-nx5833");
    expect(trigger()?.textContent).not.toContain("/home/u/work");
    expect(trigger()?.getAttribute("title")).toBe("/home/u/work/nxsys-backend-nx5833");
  });

  it("narrows thirty look-alike checkouts to the ones that differ where you typed", async () => {
    view = await mount(<GitRepoBar repo={repos[0]!} repos={repos} onChoose={(p) => chosen.push(p)} />);
    await click(trigger());
    await type("5838");
    expect(rowValues()).toEqual(["/home/u/work/nxsys-backend-nx5838", "/home/u/work/nxsys-backend-nx5838-ma"]);
  });

  it("hands back the absolute path, not the label it showed", async () => {
    view = await mount(<GitRepoBar repo={repos[0]!} repos={repos} onChoose={(p) => chosen.push(p)} />);
    await click(trigger());
    await click(document.querySelector('[data-value="/home/u/work/prod-ref/nxsys-backend"]'));
    expect(chosen).toEqual(["/home/u/work/prod-ref/nxsys-backend"]);
  });

  it("is plain text, not a picker, when there is nothing else to pick", async () => {
    view = await mount(<GitRepoBar repo={repos[0]!} repos={[repos[0]!]} onChoose={(p) => chosen.push(p)} />);
    expect(trigger()).toBeNull();
    expect(view.container.textContent).toContain("nxsys-backend-nx5833");
  });
});
