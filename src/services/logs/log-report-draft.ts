/**
 * "Draft with AI" on the Report tab: Claude Haiku reads the lines the person put in the report
 * and the environment, and fills in the title, labels, what happened, the steps and what they
 * expected. The person reads it over and sends it themselves; nothing here talks to GitHub
 * beyond reading the label list.
 */
import type { ReportDraft, ReportDraftRequest } from "../../shared/logs-api.ts";
import { DEFAULT_REDACT, redactLogText } from "../../shared/log-redact.ts";
import { askClaude, clip, extractJson, LOGS_AI_MODEL_NAME, type AskFn } from "./log-ai.ts";
import { repoLabels } from "./github-issues.ts";

const MAX_LINES = 400;
const MAX_LINE_CHARS = 600;

const SYSTEM_PROMPT = `You write GitHub bug reports for PPM, a self-hosted web IDE (a Bun server and a React web app) that runs Claude Code and Codex chats, terminals, git tools, remote desktop and tunnels. You are given log lines the user picked from PPM's logs and their environment. Write the report its author needs to fix the problem, from what the lines show; do not invent steps the lines do not suggest, and say so plainly where they do not show something.

- "title": at most 80 characters, says what went wrong, no "Bug:" prefix.
- "labels": one to three names, only from the list given.
- "what": two to five sentences on what happened and what the lines show, with times.
- "steps": a numbered list, one step per line ("1. …"), as far as the lines let you tell.
- "expected": one or two sentences.

Answer with JSON only: {"title":"…","labels":["bug"],"what":"…","steps":"1. …\\n2. …","expected":"…"}`;

export async function draftReport(req: ReportDraftRequest, ask: AskFn = askClaude): Promise<ReportDraft> {
  const labels = await repoLabels();
  const redact = (t: string) => redactLogText(t, DEFAULT_REDACT);
  let budget = MAX_LINES;
  const blocks: string[] = [];
  for (const s of req.snippets) {
    if (budget <= 0) break;
    const lines = s.lines.slice(-budget).map((l) => clip(redact(l), MAX_LINE_CHARS));
    budget -= lines.length;
    blocks.push(`--- ${clip(s.label, 120)} ---\n${lines.join("\n")}`);
  }
  if (!blocks.length) throw new Error("There are no lines in the report");
  const prompt = [
    `Labels in the repository: ${labels.join(", ")}`,
    "",
    "Environment:",
    ...req.environment.map(([k, v]) => `- ${clip(k, 40)}: ${clip(redact(v), 200)}`),
    ...(req.note?.trim() ? ["", `What the user wrote so far: ${clip(redact(req.note), 1500)}`] : []),
    "",
    "Log lines (times are UTC):",
    ...blocks,
  ].join("\n");
  const answer = await ask(SYSTEM_PROMPT, prompt);
  const raw = extractJson(answer.text) as Record<string, unknown>;
  const known = new Map(labels.map((l) => [l.toLowerCase(), l]));
  const picked = (Array.isArray(raw.labels) ? raw.labels : [])
    .map((l) => known.get(String(l).toLowerCase()))
    .filter((l): l is string => !!l);
  const draft: ReportDraft = {
    title: clip(raw.title, 120),
    labels: [...new Set(picked)].slice(0, 3),
    what: clip(raw.what, 2000),
    steps: clip(raw.steps, 2000),
    expected: clip(raw.expected, 1000),
    model: LOGS_AI_MODEL_NAME,
  };
  if (!draft.title) throw new Error("Claude's answer had no title");
  return draft;
}
