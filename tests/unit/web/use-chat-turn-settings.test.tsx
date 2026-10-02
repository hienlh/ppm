/**
 * What a new chat's first message carries is what its warm Claude process was started
 * with, so `turnSettings` has to leave out exactly the picks the user never made.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");

let chat: ReturnType<typeof useChat> | null = null;
let view: Mounted | null = null;
function Probe() {
  chat = useChat(null, "claude", "proj");
  return null;
}
afterEach(async () => { await view?.unmount(); view = null; });

it("carries only the picks the user made, as they made them", async () => {
  view = await mount(<Probe />);
  expect(chat!.turnSettings()).toEqual({});
  await act(async () => { chat!.setThinking(false); });
  expect(chat!.turnSettings()).toEqual({ thinking: false });
  await act(async () => {
    chat!.setModel("claude-opus-4-5");
    chat!.setEffort("high");
  });
  expect(chat!.turnSettings()).toEqual({ model: "claude-opus-4-5", effort: "high", thinking: false });
});
