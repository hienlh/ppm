import { describe, expect, it } from "bun:test";
import { acceptsExpired } from "../../../src/web/components/design/canvas/use-design-canvas";

describe("acceptsExpired", () => {
  it("accepts expired only before the current load has proved itself with ready", () => {
    // Before ready: the real expired stand-in never sends ready, so this is the only case
    // where trusting `expired` is safe.
    expect(acceptsExpired(false)).toBe(true);
    // After ready: the real design document could forge `expired` too (its own script can
    // read the nonce off `?n=`), and must not be able to loop the canvas through remints.
    expect(acceptsExpired(true)).toBe(false);
  });
});
