/**
 * Child process for `tests/unit/web/message-list-stream-rerender.test.ts`: mounts a transcript,
 * streams into its last message the way `flushMessages()` in `use-chat.ts` does, and prints how
 * often each part rendered as one line of JSON.
 *
 * The counts come from pass-through wrappers installed with `mock.module`, which is why this is
 * a process of its own: a module mock outlives the file that made it, and the wrappers must not
 * reach the other suites.
 */
import { mock } from "bun:test";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { installDom, installGlobal } from "../helpers/react-dom";
import { encodeReply } from "../../src/shared/chat-reply";
import type { ChatEvent, ChatMessage } from "../../src/types/chat";

installDom();
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
installGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, data: { count: 0, files: [] } })));

const counts = { userBubbles: 0, assistantBubbles: 0, markdown: 0, actionBars: 0 };

async function countRenders(path: string, name: string, counter: keyof typeof counts): Promise<void> {
  const exports = { ...(await import(path)) };
  const Real = exports[name] as ComponentType<Record<string, unknown>>;
  const Counted = (props: Record<string, unknown>) => {
    counts[counter]++;
    return createElement(Real, props);
  };
  mock.module(path, () => ({ ...exports, [name]: Counted }));
}

// Before anything imports these: `message-events` loads `message-markdown`, whose module body
// starts the Markdown chunk's import, and that has to reach the wrapper.
await countRenders("../../src/web/components/shared/markdown-renderer", "MarkdownRenderer", "markdown");
await countRenders("../../src/web/components/chat/message-action-bar", "MessageActionBar", "actionBars");
await countRenders("../../src/web/components/chat/message-user-bubble", "UserBubble", "userBubbles");
await countRenders("../../src/web/components/chat/message-events", "InterleavedEvents", "assistantBubbles");

const { MessageList } = await import("../../src/web/components/chat/message-list");
const { SessionChangesContext, useSessionChangesValue } = await import("../../src/web/components/chat/session-changes-context");
const { useSessionFileChanges } = await import("../../src/web/hooks/use-session-file-changes");
const { createReplyReference } = await import("../../src/web/components/chat/message-reply-reference");
const { createRoot } = await import("react-dom/client");

const SESSION = "s1";
const PROVIDER = "claude";
const TURNS = 20;
const FLUSHES = 5;
const timestamp = "2026-10-28T10:00:00Z";
const noop = () => {};

function turn(i: number): ChatMessage[] {
  const id = (part: string) => `${part}-${i}`;
  const read: ChatEvent[] = [
    { type: "text", content: `Reading \`src/feature-${i}.ts\` first.` },
    { type: "tool_use", tool: "Read", input: { file_path: `/repo/src/feature-${i}.ts` }, toolUseId: id("read") },
    { type: "tool_result", output: "1\tconst a = 1;\n2\tconst b = 2;", toolUseId: id("read") },
  ];
  const edit: ChatEvent[] = [
    { type: "tool_use", tool: "Edit", input: { file_path: `/repo/src/feature-${i}.ts`, old_string: "a = 1", new_string: "a = 2" }, toolUseId: id("edit") },
    { type: "tool_result", output: "The file has been updated.", toolUseId: id("edit") },
  ];
  const bash: ChatEvent[] = [
    { type: "tool_use", tool: "Bash", input: { command: `bun test feature-${i}`, description: "Run tests" }, toolUseId: id("bash") },
    { type: "tool_result", output: "(pass) feature", toolUseId: id("bash") },
  ];
  return [
    { id: id("u"), role: "user", content: `Fix feature ${i}.`, timestamp },
    { id: id("a1"), role: "assistant", content: "", events: read, timestamp },
    { id: id("a2"), role: "assistant", content: "", events: edit, timestamp },
    { id: id("a3"), role: "assistant", content: "", events: bash, timestamp },
    { id: id("a4"), role: "assistant", content: "", events: [{ type: "text", content: `## Done ${i}\n\n- fixed **feature ${i}**\n- see [docs](https://example.com/${i})` }], timestamp: `2026-10-28T10:00:${String(i).padStart(2, "0")}Z` },
  ];
}

const history = Array.from({ length: TURNS }, (_, i) => turn(i)).flat();
// A quote whose source is on screen: the bubble showing it must not redraw on a flush either.
const quoted = history.find((m) => m.id === "a4-3")!;
const reply = createReplyReference(quoted, SESSION, PROVIDER);
if (!reply) throw new Error("fixture: no reply reference");
const live: ChatMessage = { id: "u-live", role: "user", content: encodeReply("And the next one.", reply), timestamp };
let streamed = "Working on it.";
const streaming = (): ChatMessage => ({ id: "streaming-1", role: "assistant", content: streamed, events: [{ type: "text", content: streamed }], timestamp });

/** The transcript as chat-tab.tsx wires it: the session's changes in context around the list. */
function Chat({ messages }: { messages: ChatMessage[] }) {
  const changes = useSessionFileChanges({ projectName: "proj", sessionId: SESSION, messages, isStreaming: true });
  const { value } = useSessionChangesValue({ projectName: "proj", sessionId: SESSION, providerId: PROVIDER, changes });
  return createElement(SessionChangesContext.Provider, { value }, createElement(MessageList, {
    messages, sessionId: SESSION, providerId: PROVIDER, isStreaming: true,
    pendingApproval: null, onApprovalResponse: noop, onReply: noop,
  }));
}
const list = (messages: ChatMessage[]): ReactElement => createElement(Chat, { messages });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

// The Markdown renderer is `lazy()`: until its chunk has resolved once, a first render suspends
// and comes back later, which would hide a second render of every bubble on mount.
{
  const warm = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { warm.render(list([streaming()])); });
  await settle();
  await act(async () => { warm.unmount(); });
}

const messages = [...history, live, streaming()];
const expected: Record<string, number> = {
  userBubbles: messages.filter((m) => m.role === "user").length,
  assistantBubbles: messages.filter((m) => m.role === "assistant").length,
  // One Markdown block per assistant message with text: none here holds two runs of it.
  markdown: messages.filter((m) => m.role === "assistant" && m.events?.some((e) => e.type === "text")).length,
};

const reset = () => { counts.userBubbles = counts.assistantBubbles = counts.markdown = counts.actionBars = 0; };
reset();
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
await act(async () => { root.render(list(messages)); });
await settle();
const mount = { ...counts };
// Each action bar draws one <time>: the bars on screen are the ones a mount should have drawn.
expected.actionBars = host.querySelectorAll("time").length;

reset();
for (let i = 0; i < FLUSHES; i++) {
  streamed += ` More text ${i}.`;
  // What `flushMessages()` does: a new array, every message but the last one kept as it was.
  await act(async () => { root.render(list([...history, live, streaming()])); });
}
const flushes = { ...counts };
await act(async () => { root.unmount(); });

console.log(JSON.stringify({ expected, flushCount: FLUSHES, mount, flushes }));
process.exit(0);
