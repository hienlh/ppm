import { getDbProfile } from "./db.service.ts";
import { serverInstanceId } from "./server-instance-id.ts";
import { localServerBaseUrl } from "./server-listen-address.ts";

export const PPM_PROFILE_ENV = "PPM_PROFILE";
export const PPM_INSTANCE_ID_ENV = "PPM_INSTANCE_ID";

/**
 * What every process PPM starts for a chat or a terminal carries, so a `ppm …` command run there
 * reaches this PPM: its database profile, and which server it is when several share that
 * database. Always set — an empty profile means the default — because these processes copy PPM's
 * own environment, and a stray `PPM_PROFILE` inherited from whoever started PPM would otherwise
 * point every command at another instance. The instance id is empty in a process that serves
 * nothing (the CLI running a chat turn itself).
 */
export function ppmInstanceEnv(): Record<string, string> {
  return {
    [PPM_PROFILE_ENV]: getDbProfile() ?? "",
    [PPM_INSTANCE_ID_ENV]: localServerBaseUrl() ? serverInstanceId() : "",
  };
}
