/**
 * Thin re-export wrapper — actual discovery logic lives in slash-discovery/.
 * Kept for backward compatibility with existing imports.
 */
export { listSlashItems, searchSlashItems } from "./slash-discovery/index.ts";
export type { SlashItem } from "./slash-discovery/types.ts";
