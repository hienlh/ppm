import { Uri } from "./uri.ts";

/** VSCode-compatible env namespace */
export function createEnvNamespace(appName: string, machineId: string) {
  return {
    appName,
    appRoot: "",
    language: "en",
    machineId,
    uriScheme: "ppm",
    clipboard: {
      async readText(): Promise<string> { return ""; },
      async writeText(_value: string): Promise<void> {},
    },
    openExternal(target: Uri): Promise<boolean> {
      // Cannot open browser from Worker — notify main process
      return Promise.resolve(false);
    },
  };
}
