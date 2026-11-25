/**
 * What one install of the helper contains: which fixed tasks, which `helper.ps1` actions, and
 * any extra admin-side steps with the payloads they read. The service builds the scripts from
 * this, so adding a capability is a change here, not in the install flow.
 */
import { HELPER_ACTIONS, type HelperAction } from "./helper-paths.ts";
import { buildHelperScript, REATTACH_ACTION } from "./helper-script.ts";
import type { StagedPayload } from "./install-script.ts";
import type { HelperSystem } from "./helper-system.ts";

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

export function helperInstallPlan(): HelperInstallPlan {
  return {
    actions: [...HELPER_ACTIONS],
    buildHelper: (sid) => buildHelperScript(sid, [REATTACH_ACTION]),
    prepare: async () => ({ ok: true, payloads: [] }),
    installSteps: "",
    uninstallSteps: "",
  };
}
