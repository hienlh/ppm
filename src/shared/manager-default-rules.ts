/**
 * Default manager rules that PPM's template carries and that a project seeded before the rule
 * existed may still lack. The server builds its template from these lines; the rules dialog offers
 * the missing one to the user, who adds it as their own edit. PPM never adds it by itself: a rules
 * file is the user's.
 */

/** The manager's role: it hands hands-on work to child chats. One list item, five lines, no trailing newline. */
export const MANAGER_DELEGATE_RULE = [
  "- Manage the work; do not do it yourself. Hand every piece of hands-on work to a child chat:",
  "  investigating, writing code and tests, screenshots, posting a comment or message the user",
  "  approved (pass the approved text on unchanged), merges, releases and upgrades the user OK'd,",
  "  cleaning up disks or machines. Your own tool use is planning, briefing child chats, light checks",
  "  of what they claim (a git log, a file, a screenshot), the project's task list and cards.",
].join("\n");

/**
 * The opening sentence that names the rule. A file holding it has the rule, however the user
 * reworded the rest: the dialog offers the rule to files without it, not to every wording.
 */
const DELEGATE_RULE_MARKER = "manage the work; do not do it yourself.";

const squash = (text: string) => text.replace(/\s+/g, " ").toLowerCase();

export function hasManagerDelegateRule(rules: string): boolean {
  return squash(rules).includes(DELEGATE_RULE_MARKER);
}

const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^[-*]\s/;

/**
 * `rules` with the delegate rule added once, where the template has it: before the first rule of
 * the opening section. It never lands inside a later section, whose heading may change what a line
 * under it means ("Allowed without asking"): with a section before any rule, it goes just above
 * that heading; with neither, at the end. Unchanged when the rule is already there.
 */
export function withManagerDelegateRule(rules: string): string {
  if (hasManagerDelegateRule(rules)) return rules;
  const body = rules.endsWith("\n") ? rules.slice(0, -1) : rules;
  if (!body.trim()) return `${MANAGER_DELEGATE_RULE}\n`;
  const lines = body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const titled = HEADING.test(lines[first] ?? "");
  for (let i = titled ? first + 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (LIST_ITEM.test(line)) {
      lines.splice(i, 0, MANAGER_DELEGATE_RULE);
      return `${lines.join("\n")}\n`;
    }
    if (HEADING.test(line)) {
      const gap = i > 0 && lines[i - 1]!.trim() !== "" ? [""] : [];
      lines.splice(i, 0, ...gap, MANAGER_DELEGATE_RULE, "");
      return `${lines.join("\n")}\n`;
    }
  }
  // Prose only, no rule and no section: the rule follows it as a paragraph of its own.
  const gap = lines[lines.length - 1]!.trim() === "" ? [] : [""];
  return `${[...lines, ...gap, MANAGER_DELEGATE_RULE].join("\n")}\n`;
}
