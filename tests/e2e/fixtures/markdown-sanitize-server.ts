/**
 * `design-threads-server.ts` (isolated PPM_HOME, sign-in on, scripted providers) with one
 * scripted turn added: a message containing `[[sanitize-reply]]` is answered with the hostile
 * Markdown in `PPM_SANITIZE_REPLY_FILE`, so it reaches the page as the AI's own reply — live,
 * and again from history after a reload. Every other turn is the design provider's usual one.
 */
import { readFileSync } from "node:fs";

const replyFile = process.env.PPM_SANITIZE_REPLY_FILE;
if (!process.env.PPM_HOME || !replyFile) throw new Error("Fixture requires an isolated PPM_HOME and PPM_SANITIZE_REPLY_FILE");
// Read fresh each turn so one e2e run can serve several replies by rewriting the file.
const currentReply = () => readFileSync(replyFile, "utf8");

type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;
type Send = (sessionId: string, message: string, opts?: SendOpts) => AsyncIterable<ChatEvent>;

const { DesignScriptProvider } = await import("./design-script-provider");
const proto = DesignScriptProvider.prototype as unknown as { sendMessage: Send };
const scripted = proto.sendMessage;
proto.sendMessage = async function* (this: unknown, sessionId, message, opts) {
  if (!message.includes("[[sanitize-reply]]")) { yield* scripted.call(this, sessionId, message, opts); return; }
  // The provider keeps its transcript in a private map; getMessages() serves the reload from it.
  const self = this as { resumeSession(id: string): Promise<unknown>; history: Map<string, ChatMessage[]> };
  await self.resumeSession(sessionId);
  const log = self.history.get(sessionId) ?? [];
  const at = () => new Date().toISOString();
  const reply = currentReply();
  log.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: at() } as ChatMessage);
  yield { type: "text", content: reply };
  log.push({ id: crypto.randomUUID(), role: "assistant", content: reply, timestamp: at() } as ChatMessage);
  self.history.set(sessionId, log);
  yield { type: "done", sessionId };
};

await import("./design-threads-server");
