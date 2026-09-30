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

export const VARIANT_LABELS = ["Calm", "Bold", "Playful"];

export function variantHtml(label: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${label}</title>
<style>:root { --accent: #0f766e; } body { margin: 0; font-family: Arial, sans-serif; } h1 { color: var(--accent); }</style>
</head>
<body><main><h1 id="headline">${label} direction</h1><p>One of three variants.</p></main></body>
</html>
`;
}

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
    const project = this.projects.get(sessionId);
    if (step) {
      if (!designSlug || !project) {
        yield { type: "error", message: "Scripted design step outside a design session" };
        return;
      }
      answer = await this.runStep(step, join(project, "designs", designSlug));
    } else if (project && designSlug?.startsWith("system-") && /^Set up the design system for/.test(message)) {
      // The real setup brief (buildDesignSystemInitPrompt), auto-sent to a showcase design's
      // chat: writes the app's DESIGN.md/tokens.css/kit the way the real brief asks an agent
      // to, plus the showcase page itself.
      answer = await this.runSystemSetup(designSlug.slice("system-".length), project, join(project, "designs", designSlug));
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
    if (step === "variants") {
      // Three directions for one page, declared the way the design instructions ask.
      const manifestPath = join(dir, "design.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const files = ["index.html", "variant-2.html", "variant-3.html"];
      for (const [i, file] of files.entries()) await writeFile(join(dir, file), variantHtml(VARIANT_LABELS[i]!));
      const variants = files.map((file, i) => ({ file, label: VARIANT_LABELS[i] }));
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, variants }, null, 2)}\n`);
      return "Made three variants.";
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

  /** What the real design-system setup brief asks an agent to produce, for one app. */
  private async runSystemSetup(systemId: string, project: string, showcaseDir: string): Promise<string> {
    const systemDir = systemId === "default" ? join(project, "designs") : join(project, "designs", "systems", systemId);
    await mkdir(join(systemDir, "kit"), { recursive: true });
    await writeFile(join(systemDir, "DESIGN.md"), "# Design system\n\nTeal brand, Arial.\n\n## Screens and components\n- Home: `src/Home.tsx`\n");
    await writeFile(join(systemDir, "tokens.css"), ":root { --accent: #0f766e; }\n");
    await writeFile(join(systemDir, "kit", "app.css"), ".kit-card { background-color: rgb(15, 23, 42); }\n");
    await mkdir(showcaseDir, { recursive: true });
    await writeFile(join(showcaseDir, "index.html"), `<!doctype html><html><head>
<link rel="stylesheet" href="../systems/${systemId}/tokens.css">
<link rel="stylesheet" href="../systems/${systemId}/kit/app.css">
</head><body><h1 id="showcase-title">Design system</h1><div class="kit-card" id="showcase-card">Sample</div></body></html>\n`);
    return "Set up the design system.";
  }

  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
}

export class PlainTestProvider extends MockProvider {
  override id = "plain-test";
  override name = "Plain test AI";
}
