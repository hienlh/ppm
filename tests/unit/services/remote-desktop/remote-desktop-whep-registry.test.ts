import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearWhepTickets, registerWhepTarget, releaseWhepTicket, resolveWhepTarget,
} from "../../../../src/services/remote-desktop/remote-desktop-whep-registry.ts";

beforeEach(() => clearWhepTickets());

describe("the WHEP ticket registry", () => {
  // The whole reason this indirection exists: the proxy resolves a ticket PPM minted, so a
  // client can never name the upstream. A URL parameter in its place would be an SSRF hole in
  // a feature that already carries host control.
  test("a ticket is the only way to name an upstream, and it is unguessable", () => {
    const a = registerWhepTarget("http://127.0.0.1:9001/sx/whep");
    const b = registerWhepTarget("http://127.0.0.1:9002/sy/whep");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);   // base64url, safe in a path segment
    expect(resolveWhepTarget(a)).toBe("http://127.0.0.1:9001/sx/whep");
    expect(resolveWhepTarget(b)).toBe("http://127.0.0.1:9002/sy/whep");
  });

  test("an unknown ticket resolves to nothing rather than to a default", () => {
    registerWhepTarget("http://127.0.0.1:9001/sx/whep");
    expect(resolveWhepTarget("not-a-ticket")).toBeNull();
    expect(resolveWhepTarget("")).toBeNull();
  });

  // A captured ticket has to stop working when the viewer does, or it outlives the session
  // whose media it grants access to.
  test("releasing a ticket makes it dead immediately", () => {
    const t = registerWhepTarget("http://127.0.0.1:9001/sx/whep");
    releaseWhepTicket(t);
    expect(resolveWhepTarget(t)).toBeNull();
  });

  test("releasing one session's ticket leaves another's alone", () => {
    const a = registerWhepTarget("http://127.0.0.1:9001/sa/whep");
    const b = registerWhepTarget("http://127.0.0.1:9002/sb/whep");
    releaseWhepTicket(a);
    expect(resolveWhepTarget(a)).toBeNull();
    expect(resolveWhepTarget(b)).toBe("http://127.0.0.1:9002/sb/whep");
  });
});
