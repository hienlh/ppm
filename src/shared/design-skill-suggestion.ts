import {
  extractSkillMentions, resolveSkillMentions, type SkillCandidate,
} from "./design-skill-mentions";

/**
 * The design skill PPM points to when a machine has none. PPM never installs it: the
 * commands are shown for the user to run, copied from the upstream README
 * (github.com/nextlevelbuilder/ui-ux-pro-max-skill, MIT) rather than invented here.
 */
export const DESIGN_SKILL_SUGGESTION = {
  name: "ui-ux-pro-max",
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
