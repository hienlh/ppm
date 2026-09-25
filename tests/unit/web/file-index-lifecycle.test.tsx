import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { FileNode } from "../../../src/types/project";

installDom();
afterAll(uninstallDom);
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useFileIndexInvalidation } = await import("../../../src/web/hooks/use-file-index-invalidation");
const { MessageInput } = await import("../../../src/web/components/chat/message-input");
const { FilePicker } = await import("../../../src/web/components/chat/file-picker");
const { fsChanged } = await import("../../../src/web/components/os-explorer/explorer-store");
const { api } = await import("../../../src/web/lib/api-client");
const projectA = { name: "index-a", path: "C:\\projects\\index-a" };
const projectB = { name: "index-b", path: "C:\\projects\\index-b" };
const fileA: FileNode = { name: "only-a.ts", path: "only-a.ts", type: "file" };
const fileB: FileNode = { name: "only-b.ts", path: "only-b.ts", type: "file" };
const newFile: FileNode = { name: "created.ts", path: "created.ts", type: "file" };
const initialFiles = useFileStore.getState();
const initialProjects = useProjectStore.getState();
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  useFileStore.getState().reset();
  useProjectStore.setState({ projects: [projectA, projectB], activeProject: projectA });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  useFileStore.getState().reset();
  useFileStore.setState(initialFiles, true);
  useProjectStore.setState(initialProjects, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Invalidation() {
  useFileIndexInvalidation();
  return null;
}

function Composer({ projectName }: { projectName: string }) {
  const [items, setItems] = useState<FileNode[]>([]);
  const [picker, setPicker] = useState({ visible: false, filter: "" });
  return <>
    <MessageInput projectName={projectName} onSend={() => {}} onFileItemsLoaded={setItems}
      onFileStateChange={(visible, filter) => setPicker({ visible, filter })} />
    <FilePicker items={items} {...picker} onSelect={() => {}} onClose={() => {}} />
    <output>{items.map((item) => item.name).join(",")}</output>
  </>;
}

async function openPicker() {
  const textarea = view!.container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "@");
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("does not expose project A's cached files to a composer for B", async () => {
  useFileStore.setState({ indexProject: projectA.name, indexStatus: "ready", fileIndex: [fileA] });
  useProjectStore.setState({ activeProject: projectB });
  const response = deferred<FileNode[]>();
  const get = spyOn(api, "get").mockImplementation(() => response.promise);
  spies.push(get);
  view = await mount(<Composer projectName={projectB.name} />);
  expect(view.container.querySelector("output")!.textContent).toBe("");
  expect(get).not.toHaveBeenCalled();
  await openPicker();
  expect(get.mock.calls[0]![0]).toBe("/api/project/index-b/files/index");
  expect(view.container.textContent).not.toContain(fileA.name);
  await act(async () => response.resolve([fileB]));
  expect(view.container.textContent).toContain(fileB.name);
  expect(view.container.textContent).not.toContain(fileA.name);
});

it("clears an old project on switch and ignores its late index response after B is ready", async () => {
  const responseA = deferred<FileNode[]>();
  const responseB = deferred<FileNode[]>();
  const get = spyOn(api, "get").mockImplementation((path: string) => path.includes("index-a/") ? responseA.promise : responseB.promise);
  spies.push(get);
  view = await mount(<Invalidation />);
  const loadingA = useFileStore.getState().loadIndex(projectA.name);
  useProjectStore.setState({ activeProject: projectB });
  expect(useFileStore.getState().indexProject).toBeNull();
  expect(useFileStore.getState().indexStatus).toBe("idle");
  expect(get).toHaveBeenCalledTimes(1); // Switching never eagerly loads B.
  const loadingB = useFileStore.getState().loadIndex(projectB.name);
  responseB.resolve([fileB]);
  await loadingB;
  responseA.resolve([fileA]);
  await loadingA;
  expect(useFileStore.getState().indexProject).toBe(projectB.name);
  expect(useFileStore.getState().fileIndex).toEqual([fileB]);
  expect(useFileStore.getState().indexStatus).toBe("ready");
});

for (const event of ["file:changed", "fsChanged"] as const) {
  it(`marks the index stale on ${event} with the drawer closed, then refreshes it on @`, async () => {
    useFileStore.setState({ indexProject: projectA.name, indexStatus: "ready", fileIndex: [fileA] });
    const response = deferred<FileNode[]>();
    const get = spyOn(api, "get").mockImplementation(() => response.promise);
    spies.push(get);
    // Only the app-level subscription and composer exist: no drawer/file tree.
    view = await mount(<><Invalidation /><Composer projectName={projectA.name} /></>);
    const change = async (project = projectA) => act(async () => {
      if (event === "file:changed") {
        window.dispatchEvent(new CustomEvent("file:changed", { detail: { projectName: project.name, action: "created", path: "created.ts" } }));
      } else fsChanged(`${project.path}\\src`);
    });
    await change(projectB);
    expect(useFileStore.getState().indexStatus).toBe("ready");
    await change();
    // Stale, not dropped: the list stays until something opens to read it (see `indexStale`).
    expect(get).not.toHaveBeenCalled();
    expect(useFileStore.getState().indexStatus).toBe("ready");
    expect(useFileStore.getState().indexStale).toBe(true);
    expect(useFileStore.getState().fileIndex).toEqual([fileA]);
    await openPicker();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toBe("/api/project/index-a/files/index");
    await act(async () => response.resolve([fileA, newFile]));
    expect(view.container.textContent).toContain(newFile.name);
    expect(useFileStore.getState().indexStale).toBe(false);
    // A change while the picker is open still downloads nothing: on a large project every
    // refetch is the whole list, and a session writing files would make that back to back.
    await change();
    expect(get).toHaveBeenCalledTimes(1);
    expect(useFileStore.getState().indexStale).toBe(true);
    expect(useFileStore.getState().indexStatus).toBe("ready");
  });
}
