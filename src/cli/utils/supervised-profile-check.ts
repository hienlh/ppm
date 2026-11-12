import { pidAlive } from "../../services/share-host/share-host-status.ts";

/**
 * `ppm stop`, `down` and `restart` act on the supervisor named in status.json, which is shared by
 * every profile in the PPM folder. Run for a non-default profile, they would stop or restart
 * whatever that supervisor serves — usually the default PPM. They act only when the supervisor
 * that is alive serves the profile they were given; a profile run some other way (a dev server)
 * is stopped where it runs.
 */
export function supervisedProfileRefusal(profile: string | null, status: Record<string, unknown>): string | null {
  if (profile === null) return null;
  const served = typeof status.profile === "string" && status.profile ? status.profile : null;
  if (pidAlive(status.supervisorPid) && served === profile) return null;
  return `The PPM on ppm.${profile}.db is not supervisor-managed; stop it where it runs.`;
}

/** Exits with the refusal when this command's profile has no supervisor of its own. */
export async function exitUnlessSupervisedProfile(): Promise<void> {
  const { getDbProfile } = await import("../../services/db.service.ts");
  const { readStatus } = await import("../../services/supervisor-state.ts");
  const refusal = supervisedProfileRefusal(getDbProfile(), readStatus());
  if (refusal) {
    console.error(`  ✗  ${refusal}`);
    process.exit(1);
  }
}
