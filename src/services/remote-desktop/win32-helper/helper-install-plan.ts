/**
 * What one install of the helper contains: which fixed tasks, which `helper.ps1` actions, and
 * the extra admin-side steps with the payloads they read. The service builds the scripts from
 * this, so adding a capability is a change here, not in the install flow.
 *
 * Today: bring the session back (`Reattach`), the virtual display (`DisplayOn`/`DisplayOff`
 * plus the pinned driver) and the safety net behind both (`Confirm`/`Rescue`). One install, one
 * administrator prompt, covers all of it.
 */
import { join } from "node:path";
import { HELPER_ACTIONS, helperPaths, type HelperAction } from "./helper-paths.ts";
import { buildHelperScript, REATTACH_ACTION } from "./helper-script.ts";
import type { StagedPayload } from "./install-script.ts";
import { CONFIRM_ACTION, RESCUE_ACTION } from "./rescue-script.ts";
import type { HelperSystem } from "./helper-system.ts";
import { VDD_ZIP_NAME, VDD_ZIP_SHA256, VDD_ZIP_URL } from "./vdd-catalog.ts";
import {
  buildVddInstallSteps, buildVddUninstallSteps, DISPLAY_OFF_ACTION, DISPLAY_ON_ACTION,
} from "./vdd-scripts.ts";

export interface PreparedPayloads { ok: true; payloads: StagedPayload[] }
export interface PrepareFailed { ok: false; message: string }

export interface HelperInstallPlan {
  actions: HelperAction[];
  buildHelper(userSid: string): string;
  /** Downloads or stages what the admin side will verify and read. */
  prepare(sys: HelperSystem, kind: "install" | "uninstall"): Promise<PreparedPayloads | PrepareFailed>;
  installSteps: string;
  uninstallSteps: string;
}

async function stageDriver(sys: HelperSystem): Promise<PreparedPayloads | PrepareFailed> {
  const dest = join(helperPaths().stagingDir, VDD_ZIP_NAME);
  try {
    await sys.download(VDD_ZIP_URL, dest, VDD_ZIP_SHA256);
  } catch (e) {
    return { ok: false, message: `Could not download the virtual display driver: ${(e as Error).message}` };
  }
  // The pinned hash, not one computed from the file: the admin side checks the bytes it reads
  // against what PPM meant to install, whatever happened to the file in between.
  return { ok: true, payloads: [{ variable: "VddZipBytes", path: dest, sha256: VDD_ZIP_SHA256 }] };
}

export function helperInstallPlan(): HelperInstallPlan {
  return {
    actions: [...HELPER_ACTIONS],
    buildHelper: (sid) => buildHelperScript(sid, [REATTACH_ACTION, DISPLAY_ON_ACTION, DISPLAY_OFF_ACTION, CONFIRM_ACTION, RESCUE_ACTION]),
    prepare: async (sys, kind) => (kind === "install" ? stageDriver(sys) : { ok: true, payloads: [] }),
    installSteps: buildVddInstallSteps(),
    uninstallSteps: buildVddUninstallSteps(),
  };
}
