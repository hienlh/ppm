import { Uri } from "./uri.ts";
import { Disposable } from "./disposable.ts";
import type { ClientTimeZoneChange, ClientTimeZoneSource } from "./client-timezone.ts";
import type { Event } from "./event-emitter.ts";

const NEVER: Event<ClientTimeZoneChange> = () => new Disposable(() => {});

/** VSCode-compatible env namespace, plus the zone of the person's device (a PPM addition). */
export function createEnvNamespace(appName: string, machineId: string, timeZone?: ClientTimeZoneSource) {
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
    /**
     * The IANA zone the user's browser last reported, or undefined until a browser connects
     * after PPM starts. Use it for anything shown or scheduled for the person: the host
     * machine's own zone can be another country's.
     */
    get clientTimeZone(): string | undefined {
      return timeZone?.current;
    },
    /** Fires when a browser reports a zone different from the last one. */
    onDidChangeClientTimeZone: timeZone?.onDidChange ?? NEVER,
  };
}
