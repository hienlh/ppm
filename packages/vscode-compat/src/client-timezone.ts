import { EventEmitter, type Event } from "./event-emitter.ts";

/** A browser told PPM its IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
export interface ClientTimeZoneChange {
  timeZone: string;
  /** The reporting browser's stable id, the one PPM's session trace files its rows under. */
  deviceId: string;
}

export interface ClientTimeZoneSource {
  /** The last reported zone; undefined until a browser connects after PPM starts. */
  readonly current: string | undefined;
  readonly onDidChange: Event<ClientTimeZoneChange>;
}

/**
 * The zone every extension in one host sees. The host feeds it the server's reports, and it
 * fires only when the zone differs from the one before, so a browser reconnecting with the same
 * zone is not news. One instance per host: the person has one zone, whichever extension asks.
 */
export class ClientTimeZoneState implements ClientTimeZoneSource {
  private zone: string | undefined;
  private readonly emitter = new EventEmitter<ClientTimeZoneChange>();
  readonly onDidChange = this.emitter.event;

  get current(): string | undefined {
    return this.zone;
  }

  /** Take a report; returns whether it changed the zone (and so fired). */
  report(change: ClientTimeZoneChange): boolean {
    if (change.timeZone === this.zone) return false;
    this.zone = change.timeZone;
    this.emitter.fire({ timeZone: change.timeZone, deviceId: change.deviceId });
    return true;
  }
}
