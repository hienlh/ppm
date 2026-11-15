import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import type { VaultStatus } from "../../shared/vault.ts";

/**
 * `ppm vault`: whether each tier of the secret vault is on and open, and a way to lock it. There
 * is deliberately no command that reads, adds or changes an item: values are given out only
 * through PPM's own screen, with the tier's password.
 */

type StatusWithGrants = VaultStatus & { grants: { tier: string; expiresAt: number; settings: boolean }[] };

const left = (until: number) => `${Math.max(0, Math.round((until - Date.now()) / 1000))}s`;

export function registerVaultCommands(program: Command): void {
  const vault = program.command("vault").description("The secret vault: status and lock (values are read only in PPM)");

  vault
    .command("status")
    .description("Show which vault tiers are on, how many items each holds, and what is unlocked")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const s = await ppmApiRequest<StatusWithGrants>("GET", "/vault/status");
      if (opts.json) { console.log(JSON.stringify(s, null, 2)); return; }
      console.log(`Public:  ${s.publicCount} item(s)`);
      for (const tier of ["secure", "sealed"] as const) {
        const t = s.tiers[tier];
        const label = tier === "secure" ? "Secure: " : "Sealed: ";
        if (!t.enabled) { console.log(`${label} off`); continue; }
        const open = s.grants.filter((g) => g.tier === tier);
        const lock = t.lockedUntil > Date.now() ? ` ${C.yellow}locked out for ${left(t.lockedUntil)}${C.reset}` : "";
        console.log(`${label} ${t.itemCount} item(s), ${open.length ? `${open.length} unlock(s) open (${open.map((g) => `${g.settings ? "Settings" : "a chat"}, ${left(g.expiresAt)}`).join("; ")})` : "locked"}${lock}`);
      }
    })());

  vault
    .command("lock")
    .description("Lock every vault tier now: ends Settings' unlock and every chat's open window")
    .action(() => run(async () => {
      const r = await ppmApiRequest<{ closed: number }>("POST", "/vault/lock", {});
      console.log(`${C.green}✓${C.reset} Vault locked${r.closed ? ` (${r.closed} open unlock(s) ended)` : ""}.`);
    })());
}
