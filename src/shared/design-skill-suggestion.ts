import {
  DESIGN_INSTRUCTIONS_MAX_BYTES, extractSkillMentions, resolveSkillMentions, utf8ByteLength, type SkillCandidate,
} from "./design-skill-mentions";

/**
 * The design skill PPM points to when a machine has none. The Install button puts this
 * `version` in place (`design-skill-install.service.ts`); `installs` are the upstream README's
 * own commands (github.com/nextlevelbuilder/ui-ux-pro-max-skill, MIT), kept for anyone who
 * would rather run them, copied rather than invented here.
 */
export const DESIGN_SKILL_SUGGESTION = {
  name: "ui-ux-pro-max",
  version: "2.15.0",
  repoUrl: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
  license: "MIT",
  requirement: "Its search scripts need Python 3.",
  installs: [
    {
      label: "Claude Code, inside a Claude Code session",
      lines: [
        "/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill",
        "/plugin install ui-ux-pro-max@ui-ux-pro-max-skill",
      ],
    },
    {
      label: "Claude Code, from a terminal (all projects)",
      lines: ["npm install -g ui-ux-pro-max-cli", "uipro init --ai claude --global"],
    },
    {
      label: "Codex, from the project folder",
      lines: ["npm install -g ui-ux-pro-max-cli", "uipro init --ai codex"],
    },
  ],
} as const;

/** Installed copies go by several names (`ui-ux-pro-max`, AgentKit's `ak:ui-ux-pro-max`). */
const KNOWN_DESIGN_SKILL_RE = /ui-ux-pro-max/i;

export function isKnownDesignSkill(skill: SkillCandidate): boolean {
  return KNOWN_DESIGN_SKILL_RE.test(skill.name) || !!skill.aliases?.some((a) => KNOWN_DESIGN_SKILL_RE.test(a));
}

/**
 * Whether to suggest installing a design skill: nothing the instructions name resolves
 * for any provider, and no known design skill is installed for any of them. One provider
 * having it is enough — the user is then already set up, whichever provider they design on.
 */
export function needsDesignSkillSuggestion(instructions: string, skillLists: ReadonlyArray<readonly SkillCandidate[]>): boolean {
  const mentions = extractSkillMentions(instructions);
  return !skillLists.some((skills) =>
    skills.some(isKnownDesignSkill) || resolveSkillMentions(mentions, skills).resolved.length > 0);
}

/**
 * The instructions with the suggested skill named in them. Installing a skill only makes its name
 * resolvable; design chats are told to use the skills the instructions name, so the Install button
 * adds the name too. Unchanged when the text already names it under any namespace
 * (`/ak:ui-ux-pro-max` counts), and null when one more line would pass the size cap.
 */
export function withDesignSkillMention(instructions: string): string | null {
  const name = DESIGN_SKILL_SUGGESTION.name;
  if (extractSkillMentions(instructions).some((m) => m === name || m.endsWith(`:${name}`))) return instructions;
  const line = `Use /${name} before designing.`;
  const next = instructions.trim() ? `${instructions.trimEnd()}\n${line}` : line;
  return utf8ByteLength(next) <= DESIGN_INSTRUCTIONS_MAX_BYTES ? next : null;
}
