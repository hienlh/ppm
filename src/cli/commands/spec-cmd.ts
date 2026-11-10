/**
 * `ppm spec` — Spec mode from the shell. The user's commands go to the running server like the
 * Spec pane's buttons; `ppm spec call` is the AI's door when its provider has no MCP (Cursor):
 * it posts to the same `/api/specs-mcp` with the chat's own token from the environment, so it can
 * do what the MCP tools do and nothing more — no approval.
 */
import { resolve, sep } from "node:path";
import { Command } from "commander";
import { api, C, fail } from "./schedule-cmd-api.ts";
import { SPEC_TOKEN_ENV, SPEC_URL_ENV } from "../../shared/spec-tools.ts";
import type { SpecSummary } from "../../shared/spec-types.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";

/** Approvals and the check level are the user's: an AI chat's shell is told so (a guard, like `ppm db`'s). */
function userOnly(): void {
  if (inAiChat()) fail("Only the user approves a spec or changes its checks, in PPM. Submit the document with spec_submit and wait.");
}

interface SpecViewLite {
  slug: string;
  title: string;
  kind: string;
  checks: string;
  folder: string;
  current: string;
  order: string[];
  phases: Record<string, { status: string; file: string; submitted: boolean }>;
  tasks: { id: string; title: string; done: boolean; status: string; wave: number | null; next: string; optional: boolean; blockedReason: string | null }[];
  run: { active: boolean } | null;
  runLive: boolean;
}

/** The project named, or the registered project holding the current directory. */
async function projectName(named?: string): Promise<string> {
  const { configService } = await import("../../services/config.service.ts");
  configService.load();
  const projects = configService.get("projects");
  if (named) {
    const p = projects.find((x) => x.name === named || resolve(x.path) === resolve(named));
    return p ? p.name : fail(`No project "${named}"`);
  }
  const cwd = resolve(process.cwd());
  const inside = projects
    .filter((p) => cwd === resolve(p.path) || cwd.startsWith(resolve(p.path) + sep))
    .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];
  return inside ? inside.name : fail("Not inside a PPM project; pass --project <name>.");
}

const base = (project: string) => `/project/${encodeURIComponent(project)}/specs`;

function printSpec(v: SpecViewLite): void {
  console.log(`${C.bold}${v.title}${C.reset} ${C.dim}${v.folder}/ · ${v.kind} · ${v.checks}${C.reset}`);
  for (const p of v.order) {
    const ph = v.phases[p]!;
    const mark = ph.status === "approved" ? `${C.green}✓${C.reset}` : ph.submitted ? `${C.yellow}●${C.reset}` : ph.status === "invalid" ? `${C.red}✗${C.reset}` : "○";
    console.log(`  ${mark} ${ph.file} ${C.dim}${ph.submitted ? "waiting for approval" : ph.status}${C.reset}`);
  }
  if (v.tasks.length) {
    console.log("");
    for (const t of v.tasks) {
      const box = t.done ? `${C.green}[x]${C.reset}` : t.status === "running" || t.status === "red" ? `${C.cyan}[~]${C.reset}` : t.status === "failed" ? `${C.red}[!]${C.reset}` : "[ ]";
      const wave = t.wave === null ? "" : `${C.dim}w${t.wave + 1}${C.reset} `;
      console.log(`  ${box} ${wave}${t.id}${t.optional ? "*" : ""}. ${t.title} ${C.dim}${t.done ? "" : t.blockedReason ?? t.next}${C.reset}`);
    }
  }
  if (v.run?.active) console.log(`\n  ${v.runLive ? `${C.cyan}Running${C.reset}` : `${C.yellow}Run interrupted by a restart${C.reset}`}`);
}

/** `ppm spec call`: one tools/call to the spec endpoint with the chat's token. */
async function callTool(tool: string, json?: string): Promise<void> {
  const url = process.env[SPEC_URL_ENV];
  const token = process.env[SPEC_TOKEN_ENV];
  if (!url || !token) fail(`${SPEC_TOKEN_ENV} is not set: \`ppm spec call\` works inside a PPM chat.`);
  let args: unknown = {};
  if (json) {
    try { args = JSON.parse(json); } catch { fail("The arguments must be JSON, e.g. '{\"task\":\"1\"}'"); }
  }
  const res = await fetch(url!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }).catch((e: Error) => fail(`PPM did not answer: ${e.message}`));
  const body = await res.json().catch(() => null) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } } | null;
  if (!body) fail(`HTTP ${res.status}`);
  if (body!.error) fail(body!.error.message);
  const text = body!.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (body!.result?.isError) fail(text);
  console.log(text);
}

export function registerSpecCommands(program: Command): void {
  const spec = program.command("spec").description("Spec mode: requirements → design → tasks, approved step by step");

  spec.command("list").description("Specs of a project")
    .option("--project <name>", "Project name (default: the one holding the current directory)")
    .action(async (o: { project?: string }) => {
      const list = await api<SpecSummary[]>("GET", base(await projectName(o.project)));
      if (!list.length) return console.log("No specs.");
      for (const s of list) {
        const at = s.current === "execution" ? `${s.tasksDone}/${s.tasksTotal} tasks` : s.current;
        console.log(`${s.slug}  ${C.bold}${s.title}${C.reset}  ${C.dim}${s.kind} · ${s.checks} · ${at}${s.waitingForYou ? " · waiting for you" : ""}${C.reset}`);
      }
    });

  spec.command("status <slug>").description("Documents, tasks and waves of one spec")
    .option("--project <name>", "Project name")
    .action(async (slug: string, o: { project?: string }) => {
      printSpec(await api<SpecViewLite>("GET", `${base(await projectName(o.project))}/${encodeURIComponent(slug)}`));
    });

  spec.command("new <title>").description("Start a spec (its chat is the one you open on it in PPM)")
    .option("--project <name>", "Project name")
    .option("--kind <kind>", "feature | bugfix | quick", "feature")
    .option("--checks <checks>", "standard | thorough", "standard")
    .option("--design-first", "Write design.md before requirements.md")
    .action(async (title: string, o: { project?: string; kind: string; checks: string; designFirst?: boolean }) => {
      const v = await api<SpecViewLite>("POST", base(await projectName(o.project)), {
        title, kind: o.kind, checks: o.checks, workflow: o.designFirst ? "design-first" : "requirements-first",
      });
      printSpec(v);
    });

  spec.command("approve <slug> <phase>").description("Approve requirements, design, tasks or drawing")
    .option("--project <name>", "Project name")
    .option("--quiet", "Do not tell the spec's chat to go on")
    .action(async (slug: string, phase: string, o: { project?: string; quiet?: boolean }) => {
      userOnly();
      const r = await api<{ message: string; spec: SpecViewLite }>("POST", `${base(await projectName(o.project))}/${encodeURIComponent(slug)}/approve/${encodeURIComponent(phase)}`, { continue: !o.quiet });
      console.log(`${C.green}✓${C.reset} ${r.message}`);
    });

  spec.command("checks <slug> <level>").description("Switch between standard and thorough checks")
    .option("--project <name>", "Project name")
    .action(async (slug: string, level: string, o: { project?: string }) => {
      userOnly();
      printSpec(await api<SpecViewLite>("PUT", `${base(await projectName(o.project))}/${encodeURIComponent(slug)}/checks`, { checks: level }));
    });

  spec.command("run <slug>").description("Run every open task, wave by wave, each in a chat of its own")
    .option("--project <name>", "Project name")
    .option("--provider <id>", "Provider for the task chats (default: the spec chat's)")
    .action(async (slug: string, o: { project?: string; provider?: string }) => {
      const r = await api<{ message: string }>("POST", `${base(await projectName(o.project))}/${encodeURIComponent(slug)}/run`, o.provider ? { providerId: o.provider } : {});
      console.log(`${C.green}✓${C.reset} ${r.message}`);
    });

  spec.command("stop <slug>").description("Stop a run; running tasks go back to not started")
    .option("--project <name>", "Project name")
    .action(async (slug: string, o: { project?: string }) => {
      const r = await api<{ message: string }>("POST", `${base(await projectName(o.project))}/${encodeURIComponent(slug)}/stop`);
      console.log(`${C.green}✓${C.reset} ${r.message}`);
    });

  spec.command("call <tool> [json]").description("For an AI chat without MCP: call a spec tool (spec_status, spec_submit, task_start, task_done, task_red, task_green, suite_check)")
    .action(async (tool: string, json?: string) => callTool(tool, json));
}
