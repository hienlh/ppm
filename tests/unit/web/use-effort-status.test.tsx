/**
 * A chat with a session hears about effort overrides over its socket; the new-chat composer has
 * no session yet, so it asks the project's settings — otherwise its chip would claim High under a
 * global Max right up to the first message.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { EffortStatus } from "../../../src/shared/effort-status";

installDom();
afterAll(uninstallDom);
const { useEffortStatus } = await import("../../../src/web/hooks/use-effort-status");
const { api, projectUrl } = await import("../../../src/web/lib/api-client");
type Input = Parameters<typeof useEffortStatus>[0];

const FROM_FILES: EffortStatus = { env: { value: "max", source: "userSettings" } };
const FROM_SESSION: EffortStatus = { observed: { requested: "high", applied: "high" } };

let view: Mounted | null = null;
let restore: (() => void) | undefined;
let seen: EffortStatus | null = null;
afterEach(async () => { await view?.unmount(); view = null; restore?.(); });

function Harness(input: Input) {
  seen = useEffortStatus(input);
  return null;
}

function answer(status: EffortStatus | null) {
  const get = spyOn(api, "get").mockResolvedValue({ status } as never);
  restore = () => get.mockRestore();
  return get;
}

it("asks the project's settings for a chat that has no session yet", async () => {
  const get = answer(FROM_FILES);
  view = await mount(<Harness projectName="draft proj" providerId="claude" model="claude-opus-5-5" sessionStatus={undefined} />);
  await act(async () => {});
  expect(get).toHaveBeenCalledWith(`${projectUrl("draft proj")}/chat/providers/claude/effort-status?model=claude-opus-5-5`);
  expect(seen).toEqual(FROM_FILES);
});

it("uses what the session's socket said, without asking", async () => {
  const get = answer(FROM_FILES);
  view = await mount(<Harness projectName="live proj" providerId="claude" sessionStatus={FROM_SESSION} />);
  await act(async () => {});
  expect(get).not.toHaveBeenCalled();
  expect(seen).toEqual(FROM_SESSION);
  // A provider nothing overrides is told as null, which is an answer too.
  await view.unmount();
  view = await mount(<Harness projectName="live proj" providerId="codex" sessionStatus={null} />);
  expect(get).not.toHaveBeenCalled();
  expect(seen).toBeNull();
});

it("waits for the provider to be known", async () => {
  const get = answer(FROM_FILES);
  view = await mount(<Harness projectName="pending proj" providerId={undefined} sessionStatus={undefined} />);
  await act(async () => {});
  expect(get).not.toHaveBeenCalled();
  expect(seen).toBeNull();
});
