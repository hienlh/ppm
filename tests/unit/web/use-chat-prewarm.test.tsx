/**
 * A new chat's composer has the server start its Claude process ahead of the first message:
 * once the picks have settled, again whenever one changes (the process only serves a message
 * carrying the picks it was started with), and while the user types at most once a minute.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChatPrewarm } = await import("../../../src/web/hooks/use-chat-prewarm");
const { api, projectUrl } = await import("../../../src/web/lib/api-client");
type Input = Parameters<typeof useChatPrewarm>[0];

const base: Input = { enabled: true, projectName: "my proj", providerId: "claude", permissionMode: "acceptEdits", accountId: "acc-1", picks: {} };
// Read through the module rather than written out: another suite may have replaced it.
const URL = `${projectUrl("my proj")}/chat/prewarm`;

let post: ReturnType<typeof spyOn>;
let now = 1_000_000;
let clock: ReturnType<typeof spyOn>;
let view: Mounted | null = null;
let touch = () => {};
let setInput: (input: Input) => void = () => {};

function Harness({ initial }: { initial: Input }) {
  const [input, set] = useState(initial);
  setInput = set;
  touch = useChatPrewarm(input);
  return null;
}

async function render(initial: Input) {
  view = await mount(<Harness initial={initial} />);
}
async function change(input: Input) {
  await act(async () => setInput(input));
}

beforeEach(() => {
  jest.useFakeTimers();
  clock = spyOn(Date, "now").mockImplementation(() => now);
  post = spyOn(api, "post").mockResolvedValue({ accepted: true });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  jest.useRealTimers();
  clock.mockRestore();
  post.mockRestore();
});

describe("useChatPrewarm", () => {
  it("asks once the composer has settled, with exactly the picks the first message will carry", async () => {
    await render({ ...base, picks: { model: "claude-opus-4-5", thinking: false } });
    jest.advanceTimersByTime(299);
    expect(post).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(URL, {
      providerId: "claude", permissionMode: "acceptEdits", accountId: "acc-1", model: "claude-opus-4-5", thinking: false,
    });
  });

  it("asks nothing for a tab that only passed through, or once the chat has its session", async () => {
    await render(base);
    jest.advanceTimersByTime(100);
    await change({ ...base, enabled: false });
    jest.advanceTimersByTime(10_000);
    now += 120_000;
    touch();
    expect(post).not.toHaveBeenCalled();
  });

  it("asks again when a pick changes, and not for a render that changes none", async () => {
    await render(base);
    jest.advanceTimersByTime(300);
    await change({ ...base, picks: {} });
    jest.advanceTimersByTime(300);
    expect(post).toHaveBeenCalledTimes(1);

    await change({ ...base, picks: { effort: "high" } });
    jest.advanceTimersByTime(300);
    await change({ ...base, picks: { effort: "high" }, accountId: "acc-2" });
    jest.advanceTimersByTime(300);
    expect(post.mock.calls.map(([, body]: any) => [body.effort, body.accountId])).toEqual([
      [undefined, "acc-1"], ["high", "acc-1"], ["high", "acc-2"],
    ]);
  });

  it("while the user types, asks again at most once a minute", async () => {
    await render(base);
    jest.advanceTimersByTime(300);
    now += 59_999;
    touch();
    expect(post).toHaveBeenCalledTimes(1);
    now += 1;
    touch();
    touch();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
