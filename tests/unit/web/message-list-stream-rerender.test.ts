/**
 * A streamed flush replaces only the last message, so it may redraw only the last bubble.
 *
 * From the Reply feature on it redrew all of them, ten times a second: two callbacks every
 * bubble holds depended on the message list, which `use-chat.ts` makes a new array on each
 * flush, so `memo(MessageBubble)` never held and every Markdown block in the transcript was
 * parsed again. Measured on 1,000 messages: 264 ms a flush, against 8 ms with the callbacks
 * off the list. Opening a chat also drew every bubble twice, because two of them depended on
 * the scroll container, which mounts after the first render.
 *
 * Every turn's action bar also reads the session's changes from context, past the bubble's
 * memo, so the context value must survive a flush too: it did not while the list was unasked
 * for (a fresh `[]` each render) or while the Review opener depended on the written paths.
 *
 * The counts come from a child process, which wraps the components in `mock.module` without
 * reaching the other suites (see `tests/fixtures/message-list-render-counts.tsx`).
 */
import { beforeAll, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

interface Counts { userBubbles: number; assistantBubbles: number; markdown: number; actionBars: number }
interface Report { expected: Counts; flushCount: number; mount: Counts; flushes: Counts }

const fixture = fileURLToPath(new URL("../../fixtures/message-list-render-counts.tsx", import.meta.url));

function run(): Report {
  const child = Bun.spawnSync([process.execPath, fixture], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.toString();
  if (child.exitCode !== 0) throw new Error(`fixture exited ${child.exitCode}\n${child.stderr.toString()}\n${stdout}`);
  return JSON.parse(stdout.trim().split("\n").pop()!) as Report;
}

let report: Report;
beforeAll(() => { report = run(); }, 30_000);

it("draws each bubble, Markdown block and action bar once when a chat opens", () => {
  expect(report.mount).toEqual(report.expected);
});

it("redraws only the streaming bubble on a streamed flush", () => {
  expect(report.flushes).toEqual({
    userBubbles: 0,
    assistantBubbles: report.flushCount,
    markdown: report.flushCount,
    actionBars: 0,
  });
});
