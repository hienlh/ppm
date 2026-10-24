import type { TabType } from "@/stores/tab-store";

/** Tabs available in the reduced workspace; all other saved tabs stay untouched. */
export function isMinimalTab(type: TabType): boolean {
  return type === "chat" || type === "settings" || type === "editor";
}
