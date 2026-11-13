/**
 * Test fixture extension for the extension-AI e2e. Everything it does goes through the API an
 * extension is handed (`vscode.ppm.*`, `context.globalStoragePath`) and answers through command
 * results, so the e2e sees exactly what an extension would. Never shipped.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ExtensionContext, PpmNamespace } from "@ppm/vscode-compat";

interface ProbeApi {
  ppm: PpmNamespace;
  commands: { registerCommand(id: string, handler: (...args: never[]) => unknown): { dispose(): void } };
}

const seen: Array<{ name: string; text: unknown; sessionId: string; turnOrigin: string }> = [];

const errorOf = (error: unknown) => {
  const e = error as { name?: string; code?: string; message?: string };
  return { name: e?.name, code: e?.code, message: e?.message ?? String(error) };
};

export function activate(context: ExtensionContext, vscode: ProbeApi): void {
  const { ppm } = vscode;
  const registration = ppm.mcp.registerToolset({
    id: "probe",
    title: "Probe",
    tools: [{
      name: "echo",
      description: "Echo the text back with the turn's origin.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }],
  }, async (name, args, ctx) => {
    seen.push({ name, text: args.text, sessionId: ctx.sessionId, turnOrigin: ctx.turnOrigin });
    return { text: `echo:${String(args.text)}:${ctx.turnOrigin}` };
  });
  context.subscriptions.push(registration);

  const command = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command("probe.registered", () => registration.registered);

  command("probe.storage", () => {
    const db = new Database(join(context.globalStoragePath, "probe.db"));
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const journal = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
      db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
      db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run("greeting", "xin chào");
      const row = db.query("SELECT v FROM kv WHERE k = ?").get("greeting") as { v: string };
      return { path: context.globalStoragePath, value: row.v, journal: journal.journal_mode };
    } finally {
      db.close();
    }
  });

  command("probe.session", async (projectName: string, binding: Parameters<PpmNamespace["chat"]["bind"]>[1] | null) => {
    const session = await ppm.chat.createSession({ projectName, providerId: "claude", bindable: true, title: "Probe chat" });
    const bound = binding ? await ppm.chat.bind(session.sessionId, binding) : null;
    return { session, bound };
  });

  command("probe.turn", async (sessionId: string, content: string) => {
    const before = await ppm.chat.lastAssistantText(sessionId);
    const sent = await ppm.chat.send(sessionId, { content, timeoutMs: 60_000 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await ppm.chat.state(sessionId);
      const last = await ppm.chat.lastAssistantText(sessionId);
      if (!state.running && last && last !== before) return { sent, state, last };
      if (Date.now() > deadline) return { sent, state, last, timedOut: true };
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  command("probe.calls", () => seen);

  command("probe.ai", async (request: Parameters<PpmNamespace["ai"]["complete"]>[0]) => {
    try {
      return { result: await ppm.ai.complete(request) };
    } catch (error) {
      return { error: errorOf(error) };
    }
  });

  command("probe.aiCancel", async (request: Parameters<PpmNamespace["ai"]["complete"]>[0], afterMs: number) => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), afterMs);
    try {
      return { result: await ppm.ai.complete(request, { signal: controller.signal }), elapsedMs: Date.now() - started };
    } catch (error) {
      return { error: errorOf(error), elapsedMs: Date.now() - started };
    }
  });

  command("probe.signals", async () => ({ usage: await ppm.usage.get(), presence: await ppm.presence.get() }));
}

export function deactivate(): void {}
