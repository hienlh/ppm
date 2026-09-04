import { describe, it, expect, afterEach } from "bun:test";
import {
  isDocumentPipSupported,
  documentPipApi,
} from "../../../src/web/components/floating-window/pip/pip-support.ts";

const g = globalThis as { window?: unknown };
const original = Object.prototype.hasOwnProperty.call(globalThis, "window")
  ? { present: true, value: g.window }
  : { present: false, value: undefined };

afterEach(() => {
  if (original.present) g.window = original.value;
  else delete g.window;
});

describe("isDocumentPipSupported", () => {
  it("is false without a window (server render)", () => {
    delete g.window;
    expect(isDocumentPipSupported()).toBe(false);
    expect(documentPipApi()).toBeNull();
  });

  it("is false in a browser without the API", () => {
    g.window = {};
    expect(isDocumentPipSupported()).toBe(false);
    expect(documentPipApi()).toBeNull();
  });

  it("is true when the API is present, and exposes it", () => {
    const api = { requestWindow: async () => ({}), window: null };
    g.window = { documentPictureInPicture: api };
    expect(isDocumentPipSupported()).toBe(true);
    expect(documentPipApi()).toBe(api as never);
  });
});
