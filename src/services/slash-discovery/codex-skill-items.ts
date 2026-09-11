import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { CodexSkill } from "../../providers/codex-app-server/codex-protocol.ts";
import type { SlashItem } from "./types.ts";

/** Icons above this are not worth inlining into every picker response. */
const MAX_ICON_BYTES = 32 * 1024;

const ICON_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * Map the skills codex reported for a session into picker items.
 *
 * These are deliberately NOT merged with the disk-discovered Claude-side list.
 * A codex session cannot run a Claude skill and vice versa, so mixing them
 * offers the user entries that do nothing.
 *
 * Every item is marked `$`: codex activates a skill from a `$name` mention in
 * the prompt, not from a leading slash.
 */
export function codexSkillsToSlashItems(skills: CodexSkill[]): SlashItem[] {
  return skills.map((s) => ({
    type: "skill" as const,
    name: s.name,
    description: s.interface?.shortDescription || s.description || "",
    // "system" is codex's own bundled set; anything else the user put there.
    scope: s.scope === "system" ? ("bundled" as const) : ("user" as const),
    invokeSigil: "$" as const,
    displayName: s.interface?.displayName,
    iconDataUri: readIconDataUri(s.interface?.iconSmall),
  }));
}

/**
 * Read a skill icon into a data URI, or return undefined for anything that is
 * missing, oversized, or of an unknown type.
 *
 * Never throws: a skill with a broken icon path still belongs in the picker,
 * just without a picture.
 */
function readIconDataUri(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const mime = ICON_MIME[extname(path).toLowerCase()];
  if (!mime) return undefined;
  try {
    if (statSync(path).size > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return undefined;
  }
}
