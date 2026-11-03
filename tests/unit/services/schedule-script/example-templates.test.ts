import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseScheduleTemplate, type ScheduleTemplate } from "../../../../src/shared/schedule-template.ts";
import { resolveInputValues } from "../../../../src/shared/schedule-inputs.ts";
import { ScriptProcess } from "../../../../src/services/schedule-script/script-process.ts";
import type { ScheduleInputValue } from "../../../../src/types/scheduler.ts";

// The example templates in templates/schedules, imported the way PPM imports a file and run
// the way the scheduler runs a script: in a real child, with ctx answered here.
const TEMPLATES = resolve(import.meta.dir, "../../../../templates/schedules");

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ppm-example-templates-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function load(name: string): ScheduleTemplate {
  const parsed = parseScheduleTemplate(readFileSync(join(TEMPLATES, `${name}.ppm-schedule.json`), "utf8"));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.template;
}

interface Call { method: string; params: any }
let n = 0;

/** One run of the template's script with these input values and this state. */
async function runOnce(t: ScheduleTemplate, values: Record<string, ScheduleInputValue>, state: unknown = {},
  answer: (method: string, params: any) => unknown = () => null) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const scriptPath = join(dir, `${t.name}-${++n}.mjs`);
  writeFileSync(scriptPath, t.script ?? "");
  const child = new ScriptProcess({
    init: {
      schedule: { id: 1, name: t.name, mode: t.mode },
      project: { name: "proj", path: dir },
      inputs: resolveInputValues(t.inputs ?? [], values, {}),
      state,
      scriptPath,
    },
    cwd: dir,
    token: "example-token",
    onCall: async (method, params) => {
      calls.push({ method, params });
      return answer(method, params);
    },
    onLine: (line) => lines.push(line),
  });
  const exit = await Promise.race([child.exited, Bun.sleep(15_000).then(() => { throw new Error("no exit within 15 s"); })]);
  return { error: exit.error, state: exit.state ? JSON.parse(exit.state) : null, calls, lines };
}

describe("example schedule templates", () => {
  it("every file in templates/schedules is a template PPM imports", () => {
    const files = readdirSync(TEMPLATES).filter((f) => f.endsWith(".ppm-schedule.json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const parsed = parseScheduleTemplate(readFileSync(join(TEMPLATES, f), "utf8"));
      expect(parsed.ok ? f : `${f}: ${parsed.errors.join("; ")}`).toBe(f);
      if (parsed.ok) expect(`${parsed.template.name}.ppm-schedule.json`).toBe(f);
    }
  });

  describe("url-watch", () => {
    let page = "";
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => { server = Bun.serve({ port: 0, fetch: () => new Response(page) }); });
    afterAll(() => { server.stop(true); });
    const url = () => `http://127.0.0.1:${server.port}/release`;
    const notes = (calls: Call[]) => calls.filter((c) => c.method === "notify").map((c) => c.params);

    it("remembers the page on its first run and notifies only when a later run differs", async () => {
      const t = load("url-watch");
      page = "<h1>v1.0</h1>";
      const first = await runOnce(t, { url: url() });
      expect(first.error).toBeNull();
      expect(notes(first.calls)).toEqual([]);
      expect(first.lines).toContain(`watching ${url()}`);

      const same = await runOnce(t, { url: url() }, first.state);
      expect(notes(same.calls)).toEqual([]);

      page = "<h1>v1.1</h1>";
      const changed = await runOnce(t, { url: url() }, same.state);
      expect(notes(changed.calls)).toEqual([{ title: "A page you watch changed", body: url() }]);
      expect(changed.state).not.toEqual(same.state);
    });

    it("with a pattern, watches that part only and shows its new value", async () => {
      const t = load("url-watch");
      const values = { url: url(), pattern: "Price: \\d+" };
      page = "Price: 10 · updated 12:00";
      const first = await runOnce(t, values);
      page = "Price: 10 · updated 12:01";
      const clock = await runOnce(t, values, first.state);
      expect(notes(clock.calls)).toEqual([]);
      page = "Price: 12 · updated 12:02";
      const price = await runOnce(t, values, clock.state);
      expect(notes(price.calls)).toEqual([{ title: "A page you watch changed", body: `${url()}\nPrice: 12` }]);

      page = "Sold out";
      const gone = await runOnce(t, values, price.state);
      expect(gone.error).toContain("nothing on");
      expect(notes(gone.calls)).toEqual([]);
    });
  });

  describe("weekly-summary", () => {
    it("asks in the one chat of its key and sends the answer as a notification that opens it", async () => {
      const t = load("weekly-summary");
      const run = await runOnce(t, {}, {}, (method) =>
        (method === "ai.chat" ? { ok: true, text: "Done: login; open: payroll export.", sessionId: "s-1" } : null));
      expect(run.error).toBeNull();
      const prompt = t.inputs!.find((i) => i.key === "prompt")!.default;
      expect(run.calls).toEqual([
        { method: "ai.chat", params: { key: "weekly-summary", prompt, opts: { title: "Weekly summary", timeoutMs: 20 * 60_000 } } },
        { method: "notify", params: { title: "Weekly summary", body: "Done: login; open: payroll export.", sessionId: "s-1" } },
      ]);
    });

    it("a busy or failed turn fails the run and notifies nothing", async () => {
      const t = load("weekly-summary");
      const busy = await runOnce(t, {}, {}, (method) =>
        (method === "ai.chat" ? { ok: false, busy: true, text: "", sessionId: null, error: "PPM session is running" } : null));
      expect(busy.error).toContain("busy");
      const failed = await runOnce(t, {}, {}, (method) =>
        (method === "ai.chat" ? { ok: false, text: "", sessionId: null, error: "All accounts have hit their usage limit." } : null));
      expect(failed.error).toContain("usage limit");
      expect([...busy.calls, ...failed.calls].some((c) => c.method === "notify")).toBe(false);
    });
  });
});
