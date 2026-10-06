/**
 * What a selection of log lines can be turned into — copied text, a chat attachment, a report
 * snippet, a `.log` file — with the toast each one answers with. Every pane goes through these,
 * so the desktop list, the phone's bar and an issue card say the same thing.
 */
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { codeFence } from "@/lib/code-fence";
import { resolveSelectedChatTabId, sendToChat } from "@/lib/send-to-chat";
import { usePanelStore } from "@/stores/panel-store";
import type { Tab } from "@/stores/tab-store";
import { plural, type LogRow } from "@/lib/logs/logs-view-model";
import { logSourceLabel, rawLogLine } from "../../../shared/logs-model";
import { useLogsReportStore } from "./logs-report-store";

/** Records in `rows`, a folded row counting every copy. */
export const recordCount = (rows: readonly LogRow[]) => rows.reduce((a, r) => a + r.count, 0);

/** The lines as they read in the files. */
export const rowsText = (rows: readonly LogRow[]) => rows.map((r) => rawLogLine(r.entry, r.count)).join("\n");

export async function copyRows(rows: readonly LogRow[]): Promise<void> {
  if (!rows.length) return;
  if (await copyToClipboard(rowsText(rows))) toast.success(`Copied ${plural(recordCount(rows), "line")}`);
  else toast.error("Could not copy the lines");
}

/** The chat "Add to current chat" goes to: the one the person last had in front of them. */
export function currentChatTab(): Tab | undefined {
  const id = resolveSelectedChatTabId();
  if (!id) return undefined;
  return Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === id);
}

/** The lines as one quoted block in a chat's composer, like a terminal selection. */
export function rowsToChat(rows: readonly LogRow[], newTab: boolean): void {
  if (!rows.length) return;
  const sources = [...new Set(rows.map((r) => logSourceLabel(r.entry.src)))].join(", ");
  const text = rowsText(rows);
  const fence = codeFence(text);
  sendToChat({
    text: `Selected lines from the PPM logs (${sources})\n${fence}\n${text}\n${fence}`,
    label: "Log selection",
    newTab,
    asContext: true,
  });
}

/** False when the same lines are already in the report. `open` adds an Open button to the toast. */
export function rowsToReport(rows: readonly LogRow[], open?: () => void, quiet = false): boolean {
  if (!rows.length) return false;
  if (!useLogsReportStore.getState().add([...rows])) {
    if (!quiet) toast("These lines are already in the report");
    return false;
  }
  if (!quiet) {
    toast.success(`Added ${plural(recordCount(rows), "line")} to the report`, open ? { action: { label: "Open", onClick: open } } : undefined);
  }
  return true;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The lines as a `.log` file. Typed as a download rather than text, so a browser that ignores
 * `download` (iOS Safari) saves it instead of opening it on PPM's origin.
 */
export function downloadRows(rows: readonly LogRow[]): void {
  if (!rows.length) return;
  const d = new Date();
  const name = `ppm-logs-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.log`;
  const url = URL.createObjectURL(new Blob([`${rowsText(rows)}\n`], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same tick can beat the download the click starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast.success(`Saved ${name} with ${plural(recordCount(rows), "line")}`);
}
