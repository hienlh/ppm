import type { Command } from "commander";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";
import { noteDirectWrite, serverRequest, ServerDownError } from "../utils/ppm-server-client.ts";
import { C, run } from "./chat-cmd-request.ts";

/**
 * `ppm cloud link|unlink` and `ppm cloud alias set|remove`, through `/api/cloud` on the running
 * PPM — the routes the Share button's PPM Cloud card calls, so a link made here starts the running
 * server's heartbeat at once. PPM Cloud's state is a pair of files in the PPM folder, not the
 * database: with no PPM running, the same calls run here after the notice (no heartbeat starts,
 * since nothing would keep sending it).
 *
 * `link` and `alias set` are refused from an AI chat (advisory): both make a public address for
 * this machine that lasts until someone removes it.
 */

const CLOUD_PANE = "the Share button → PPM Cloud";

async function cloudRequest<T>(method: string, sub: string, body: unknown, here: () => Promise<T>): Promise<T> {
  try {
    return await serverRequest<T>(method, `/cloud${sub}`, body);
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  await noteDirectWrite();
  return here();
}

/** The cloud service in this process, with the config it reads (the device name, the cloud URL) loaded. */
async function cloud() {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  return import("../../services/cloud.service.ts");
}

/** The address an alias makes, from this machine's link (the same folder the server reads). */
async function aliasUrl(slug: string): Promise<string> {
  const device = (await cloud()).getCloudDevice();
  return device ? `${device.cloud_url}/${slug}` : slug;
}

export function registerCloudLinkCommands(cmd: Command): void {
  cmd
    .command("link")
    .description("Register this machine in PPM Cloud (needs `ppm cloud login`). Refused from an AI chat")
    .option("--name <name>", "The name PPM Cloud shows (default: this machine's device name)")
    .action((opts: { name?: string }) => run(async () => {
      refuseInAiChat("This machine's PPM Cloud link", CLOUD_PANE);
      const linked = await cloudRequest<{ name: string; synced?: boolean }>("POST", "/link", { ...(opts.name && { name: opts.name }) },
        async () => (await cloud()).linkDevice(opts.name));
      console.log(`${C.green}✓${C.reset} Machine linked: ${linked.name}`);
    })());

  cmd
    .command("unlink")
    .description("Remove this machine from PPM Cloud (its permanent link stops working)")
    .action(() => run(async () => {
      await cloudRequest("POST", "/unlink", {}, async () => (await cloud()).unlinkDevice());
      console.log(`${C.green}✓${C.reset} Machine unlinked`);
    })());
}

/** `ppm cloud alias set <slug>`. */
export const cloudAliasSet = (slug: string) => run(async () => {
  refuseInAiChat("This machine's PPM Cloud alias", CLOUD_PANE);
  const result = await cloudRequest<{ slug: string }>("PATCH", "/alias", { slug }, async () => (await cloud()).setAlias(slug));
  console.log(`Alias set: ${await aliasUrl(result.slug)}`);
})();

/** `ppm cloud alias remove`. */
export const cloudAliasRemove = () => run(async () => {
  await cloudRequest("PATCH", "/alias", { slug: null }, async () => (await cloud()).removeAlias());
  console.log("Alias removed.");
})();
