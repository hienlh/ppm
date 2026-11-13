/**
 * The Assistant fixture (`assistant-server.ts`) on a database profile, reachable by the `ppm` CLI
 * the way a real PPM is: once it listens, it publishes `server-endpoint.<db>.<pid>.json` into its
 * isolated PPM_HOME, so a command finds it through that file and the hello, never through a port
 * guess. Used by `tests/e2e/assistant-cli-through-server-e2e.mjs`.
 *
 * Requires PPM_PROFILE to name a profile other than the default, so the run has a database
 * (`ppm.<profile>.db`) whose name the CLI's target line must print, and a `ppm.db` that nothing may
 * create; everything `assistant-server.ts` refuses (a real home, a used PPM_HOME) is refused too.
 */
const profile = process.env.PPM_PROFILE;
if (!profile || profile === "default") throw new Error("assistant-cli-server needs PPM_PROFILE set to a non-default profile");

// As `ppm start --profile` does before anything opens the database. Nothing is opened yet:
// assistant-server.ts checks the isolation first.
const { setDbProfile } = await import("../../../src/services/db.service");
setDbProfile(profile);

await import("./assistant-server");

const { publishServerEndpoint } = await import("../../../src/services/server-endpoint-file");
const { serverInstanceId } = await import("../../../src/services/server-instance-id");
const { getDbPath } = await import("../../../src/services/db.service");
const port = Number(process.env.PPM_HTML_TEST_PORT);
const file = publishServerEndpoint({ port, host: "127.0.0.1", dbFile: getDbPath(), version: "e2e", instanceId: serverInstanceId() });
console.log(`Endpoint published at ${file} for ${getDbPath()}`);
