import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, StrictMode, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import { useDraft } from "../../../src/web/hooks/use-draft";
import { api } from "../../../src/web/lib/api-client";

installDom();
afterAll(uninstallDom);
let view: Mounted | null = null;
let current: ReturnType<typeof useDraft>;
let selectSession: (id: string | null) => void;
const spies: Array<{ mockRestore(): void }> = [];
function Harness({ session = null, tab = "tab-a", project = "project" }: { session?: string | null; tab?: string; project?: string }) {
  const [id, setId] = useState(session);
  selectSession = setId;
  current = useDraft(project, id, tab || undefined);
  return <div>{current.draft?.content}</div>;
}
beforeEach(() => {
  spies.push(spyOn(api, "get").mockResolvedValue(null), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined));
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear();
});
async function remount(element: React.ReactNode) {
  await view?.unmount();
  view = await mount(element);
}
it("preserves a newer local draft across StrictMode reload and a stale server draft", async () => {
  view = await mount(<Harness />);
  await act(async () => { current.saveDraft("unsaved text"); current.cancelPendingSave(); });
  spies.push(spyOn(api, "get").mockResolvedValue({ content: "old server text", attachments: "[]" }));
  await remount(<StrictMode><Harness /></StrictMode>);
  expect(view!.container.textContent).toBe("unsaved text");
});
it("does not recover another session, tab or project's draft", async () => {
  view = await mount(<Harness session="a" />);
  await act(async () => { current.saveDraft("only a"); current.cancelPendingSave(); selectSession("b"); });
  await remount(<Harness session="b" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" tab="tab-b" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" project="another" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" />);
  expect(current.draft?.content).toBe("only a");
});
for (const tab of ["tab-a", ""]) it(`moves a pending first draft and clears both owners after send (${tab || "no tab id"})`, async () => {
  view = await mount(<Harness tab={tab} />);
  await act(async () => {
    current.saveDraft("pending"); current.cancelPendingSave();
    current.moveDraft("created"); selectSession("created");
  });
  await remount(<Harness tab={tab} session="created" />);
  expect(current.draft?.content).toBe("pending");
  await act(async () => { current.clearDraft("__new__"); });
  await remount(<Harness tab={tab} />);
  expect(current.draft).toBeNull();
  await remount(<Harness tab={tab} session="created" />);
  expect(current.draft).toBeNull();
});
