/**
 * `ppm schedule owners [--dry-run]`: give every script and prompt schedule that has no owning chat
 * the chat the session trace shows made it (or that its script reports to), so that chat's footer
 * chip lists it. Always through the running server, which reads its own database and trace; with
 * no server the command does nothing, rather than open the database itself.
 */
import type { Command } from "commander";
import type { OwnerReason } from "../../services/schedule-creator-backfill.ts";
import { api, C } from "./schedule-cmd-api.ts";

interface PlanRow {
  id: number;
  name: string;
  sessionId: string;
  reason: OwnerReason;
  creator: string;
  ownerTitle: string | null;
  creatorTitle: string | null;
}

/** One line per schedule: `#39 slack-watch → QL Slack (3fb25aae) — created it`. */
export function ownerPlanLines(plans: PlanRow[]): string[] {
  return plans.map((p) => {
    const owner = `${p.ownerTitle ?? "Untitled chat"} (${p.sessionId.slice(0, 8)})`;
    const why = p.reason === "creator"
      ? "created it"
      : `its script reports to it; created by ${p.creatorTitle ?? "a chat"} (${p.creator.slice(0, 8)})`;
    return `#${p.id} ${p.name} → ${owner} — ${why}`;
  });
}

export function registerScheduleOwnerCommands(schedule: Command): void {
  schedule
    .command("owners")
    .description("Link schedules with no owning chat to the chat that made them, read from the session trace (through the running PPM)")
    .option("--dry-run", "Only list what would be linked")
    .action(async (opts: { dryRun?: boolean }) => {
      const res = opts.dryRun
        ? await api<{ plans: PlanRow[]; linked?: number }>("GET", "/schedules/owners")
        : await api<{ plans: PlanRow[]; linked?: number }>("POST", "/schedules/owners");
      if (res.plans.length === 0) {
        console.log(`${C.dim}No schedule without an owner can be traced to a chat.${C.reset}`);
        return;
      }
      for (const line of ownerPlanLines(res.plans)) console.log(line);
      console.log(opts.dryRun
        ? `${C.dim}Dry run: nothing was written. Run without --dry-run to link ${res.plans.length} schedule(s).${C.reset}`
        : `${C.green}✓${C.reset} Linked ${res.linked ?? 0} schedule(s)`);
    });
}
