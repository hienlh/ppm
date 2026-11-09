/**
 * Which repository the file-scoped git calls go to, asked of the real call
 * sites rather than of the helper: the inline blame hook and the diff viewer.
 *
 * A file has one repository whatever Source Control is pointed at, so in a
 * container folder both must scope by the file — with nothing picked, git used
 * to run in the container ("not a git repository"), and with another repository
 * picked the file was never asked about. A project folder *inside* a repository
 * finds no repository below itself and must still go out unscoped, as it always
 * did, because git run there finds the enclosing one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { GitRepoDiscovery } from "../../../src/web/lib/git-repo-scope";

installDom();
afterAll(uninstallDom);
const { useInlineBlame } = await import("../../../src/web/hooks/use-inline-blame");
const { DiffViewer } = await import("../../../src/web/components/editor/diff-viewer");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store");
const { api } = await import("../../../src/web/lib/api-client");

function BlameProbe({ filePath }: { filePath: string }) {
  useInlineBlame({ editor: null, monaco: null, projectName: "p", filePath, enabled: true });
  return null;
}

const CONTAINER: GitRepoDiscovery = {
  root: "/ws",
  rootIsRepo: false,
  repos: [
    { path: "/ws/backend", name: "backend", relative: "backend" },
    { path: "/ws/frontend", name: "frontend", relative: "frontend" },
  ],
};
const INSIDE_A_REPO: GitRepoDiscovery = { root: "/mono/packages/web", rootIsRepo: false, repos: [] };

let view: Mounted | null = null;
let urls: string[] = [];
let spy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  urls = [];
  spy = spyOn(api, "get").mockImplementation(((url: string) => {
    urls.push(url);
    // The diff viewer is only asked for its request: a reply would mount Monaco.
    // Discovery stays whatever the test put in the store, or pending.
    if (url.includes("/file-full-diff?") || url.endsWith("/git/repos")) return new Promise(() => {});
    return Promise.resolve({ lines: [], commits: {} });
  }) as never);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  spy?.mockRestore();
  useGitRepoStore.setState({ discovery: {}, chosen: {} });
});

function setRepos(discovery: GitRepoDiscovery | undefined, chosen?: string) {
  useGitRepoStore.setState({
    discovery: discovery ? { p: discovery } : {},
    chosen: chosen ? { p: chosen } : {},
  });
}

function requests(route: string): URLSearchParams[] {
  return urls.filter((u) => u.includes(`/git${route}?`)).map((u) => new URL(u, "http://x").searchParams);
}

describe("inline blame", () => {
  async function blame(discovery: GitRepoDiscovery | undefined, filePath: string, chosen?: string) {
    setRepos(discovery, chosen);
    view = await mount(<BlameProbe filePath={filePath} />);
    return requests("/blame");
  }

  it("container, nothing picked: blames in the file's own repository", async () => {
    const [q] = await blame(CONTAINER, "backend/src/a.ts");
    expect(q?.get("repo")).toBe("/ws/backend");
    expect(q?.get("path")).toBe("src/a.ts");
  });

  it("container, another repository picked: still the file's own", async () => {
    const [q] = await blame(CONTAINER, "backend/src/a.ts", "/ws/frontend");
    expect(q?.get("repo")).toBe("/ws/backend");
    expect(q?.get("path")).toBe("src/a.ts");
  });

  it("project folder inside a repository: still blamed, unscoped", async () => {
    const found = await blame(INSIDE_A_REPO, "src/a.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.get("repo")).toBeNull();
    expect(found[0]!.get("path")).toBe("src/a.ts");
  });

  it("asks nothing for a file under no repository, or before discovery answers", async () => {
    expect(await blame(CONTAINER, "docs/readme.md")).toHaveLength(0);
    await view?.unmount();
    // No discovery in the store, and the hook's own load never answers.
    expect(await blame(undefined, "backend/src/a.ts")).toHaveLength(0);
  });

  it("does not blame again when the pick changes", async () => {
    await blame(CONTAINER, "backend/src/a.ts");
    const { act } = await import("react");
    await act(async () => useGitRepoStore.getState().choose("p", "/ws/frontend"));
    expect(requests("/blame")).toHaveLength(1);
  });
});

describe("diff viewer", () => {
  async function fullDiff(discovery: GitRepoDiscovery, filePath: string, chosen?: string) {
    setRepos(discovery, chosen);
    view = await mount(<DiffViewer metadata={{ projectName: "p", filePath, ref1: "abc1234" }} />);
    return requests("/file-full-diff");
  }

  it("asks the file's own repository, whatever is picked", async () => {
    const [q] = await fullDiff(CONTAINER, "backend/src/a.ts", "/ws/frontend");
    expect(q?.get("repo")).toBe("/ws/backend");
    expect(q?.get("file")).toBe("src/a.ts");
  });

  it("goes out unscoped for a project folder inside a repository", async () => {
    const [q] = await fullDiff(INSIDE_A_REPO, "src/a.ts");
    expect(q?.get("repo")).toBeNull();
    expect(q?.get("file")).toBe("src/a.ts");
  });
});
