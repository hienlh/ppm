/**
 * Scripted AI providers for the design-mode e2e. Never registered by product code.
 *
 * `DesignScriptProvider` stands in for an agent in a design session: it checks that the turn
 * carries the design instructions, then writes the design's files the way an agent's Write
 * tool would, and ends the turn. Which files it writes is chosen by a `[[design:<step>]]`
 * marker in the message, so the e2e decides what each turn does. Every call is recorded so
 * the e2e can assert what the server handed the provider (mode, design flag, instructions).
 *
 * `PlainTestProvider` is an ordinary mock without `supportsDesignInstructions`: the New Design
 * dialog must not offer it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockProvider } from "../../../src/providers/mock-provider";
import type { ChatEvent, ChatMessage, Session, SessionConfig, SendMessageOpts } from "../../../src/providers/provider.interface";

export interface RecordedCall {
  sessionId: string;
  message: string;
  step: string | null;
  permissionMode: string | null;
  designSession: boolean;
  designSlug: string | null;
  at: number;
  /**
   * Set once the consumer has taken the turn's `done`. The chat service schedules the turn
   * snapshot before it passes `done` on, so by now that snapshot is at least pending.
   */
  done: boolean;
}

/** A 1x1 PNG, so the deck has a real local image for the HTML and PPTX exports. */
const LOGO_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const DECK_STYLES = `* { box-sizing: border-box; }
.slide { width: 1280px; height: 720px; margin: 0 auto 24px; padding: 64px; background: #fff; overflow: hidden; position: relative; }
.slide h2 { margin: 0 0 24px; font-size: 48px; color: #111827; }
.slide p { margin: 0 0 16px; font-size: 28px; color: #4b5563; }
.card { display: inline-block; padding: 24px; background: #eef2ff; font-size: 28px; border-radius: var(--radius); }
body { margin: 0; background: #e5e7eb; font-family: Arial, sans-serif; }
`;

export function deckHtml(footer = "Questions?"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Q3 deck</title>
  <link rel="stylesheet" href="../tokens.css">
  <link rel="stylesheet" href="styles.css">
  <style>
    :root {
      --accent: #4f46e5;
      --radius: 12px;
      --heading-size: 64px;
    }
    .slide h1 { margin: 0 0 24px; font-size: var(--heading-size); color: var(--accent); }
  </style>
</head>
<body>
  <section class="slide" id="s1">
    <h1>Quarterly review</h1>
    <p id="note">Editable card text</p>
    <div class="card" id="card">Revenue up 42%</div>
    <img id="logo" src="logo.png" alt="Logo" width="64" height="64">
  </section>
  <section class="slide" id="s2">
    <h2>Highlights</h2>
    <p id="send-me">Send this element</p>
    <a id="ext-link" href="https://example.com/">External link</a>
  </section>
  <section class="slide" id="s3">
    <h2>Next steps</h2>
    <p class="footer" id="footer">${footer}</p>
  </section>
  <script>document.getElementById("send-me").setAttribute("data-page", "PAGE-ALTERED");</script>
</body>
</html>
`;
}

export const DECK_TWEAKS = [
  { id: "accent", label: "Accent colour", type: "color", var: "--accent", default: "#4f46e5" },
  { id: "radius", label: "Corner radius", type: "range", var: "--radius", min: 0, max: 32, step: 1, unit: "px", default: 12 },
  { id: "heading", label: "Heading size", type: "range", var: "--heading-size", min: 32, max: 96, step: 1, unit: "px", default: 64 },
];

const STEP_RE = /\[\[design:([a-z-]+)\]\]/;
const SLUG_RE = /`designs\/([a-z0-9][a-z0-9-]*)\/`/;

export class DesignScriptProvider extends MockProvider {
  override id = "design-test";
  override name = "Design test AI";
  readonly supportsDesignInstructions = true;
  readonly calls: RecordedCall[] = [];
  private projects = new Map<string, string>();
  private history = new Map<string, ChatMessage[]>();

  override async createSession(config: SessionConfig): Promise<Session> {
    const session = await super.createSession(config);
    if (config.projectPath) this.projects.set(session.id, config.projectPath);
    return session;
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const step = STEP_RE.exec(message)?.[1] ?? null;
    const designSlug = opts?.designInstructions ? SLUG_RE.exec(opts.designInstructions)?.[1] ?? null : null;
    const call: RecordedCall = {
      sessionId, message, step, designSlug, at: Date.now(), done: false,
      permissionMode: typeof opts?.permissionMode === "string" ? opts.permissionMode : null,
      designSession: opts?.designSession === true,
    };
    this.calls.push(call);
    const log = this.history.get(sessionId) ?? [];
    log.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    let answer = "Noted.";
    if (step) {
      const project = this.projects.get(sessionId);
      if (!designSlug || !project) {
        yield { type: "error", message: "Scripted design step outside a design session" };
        return;
      }
      answer = await this.runStep(step, join(project, "designs", designSlug));
    }
    yield { type: "text", content: answer };
    log.push({ id: crypto.randomUUID(), role: "assistant", content: answer, timestamp: new Date().toISOString() });
    this.history.set(sessionId, log);
    yield { type: "done", sessionId };
    call.done = true;
  }

  /** What an agent's Write tool would do for each scripted step. */
  private async runStep(step: string, dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    if (step === "build") {
      const manifestPath = join(dir, "design.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(join(dir, "styles.css"), DECK_STYLES);
      await writeFile(join(dir, "logo.png"), Buffer.from(LOGO_PNG, "base64"));
      await writeFile(join(dir, "index.html"), deckHtml());
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, tweaks: DECK_TWEAKS }, null, 2)}\n`);
      return "Built a three-slide deck.";
    }
    if (step === "noop") {
      // Rewrites the same bytes: a turn that touched files but changed nothing.
      const path = join(dir, "index.html");
      await writeFile(path, await readFile(path));
      return "Nothing to change.";
    }
    if (step === "edit-footer") {
      const path = join(dir, "index.html");
      const html = await readFile(path, "utf8");
      if (!html.includes(">Questions?<")) throw new Error("footer not found");
      await writeFile(path, html.replace(">Questions?<", ">Questions? Ask away<"));
      return "Updated the footer.";
    }
    throw new Error(`Unknown scripted step "${step}"`);
  }

  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
}

export class PlainTestProvider extends MockProvider {
  override id = "plain-test";
  override name = "Plain test AI";
}
