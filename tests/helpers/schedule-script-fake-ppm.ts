/**
 * A stand-in for the PPM server in the orphan tests: starts one script child the way the
 * scheduler does, writes the child's pid to `outFile`, then idles until the test kills it.
 * Usage: bun schedule-script-fake-ppm.ts <scriptPath> <outFile>
 */
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ScriptProcess } from "../../src/services/schedule-script/script-process.ts";

const [scriptPath, outFile] = process.argv.slice(2) as [string, string];
const child = new ScriptProcess({
  init: {
    schedule: { id: 1, name: "orphan-test", mode: "always-on" },
    project: { name: "p", path: dirname(scriptPath) },
    inputs: {},
    state: {},
    scriptPath,
  },
  cwd: dirname(scriptPath),
  token: "orphan-test-token",
  onCall: async () => null,
  onLine: () => {},
});
writeFileSync(outFile, String(child.pid));
setInterval(() => {}, 1000);
