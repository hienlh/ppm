/**
 * Whether a failed `POST /api/upgrade/apply` means "the server is restarting into the new version"
 * or "the upgrade failed". Wrong one way, a dead install shows "Updating, reconnecting…": the
 * health check passes at once because the server never went down, the page reloads, and the
 * error is never seen. Wrong the other way, a real restart is reported as a failure.
 *
 * The failures come from the real `ApiClient` against a stubbed `fetch`, not from hand-built
 * errors: the answer rests on the shape the client gives a failure (`ApiError.status`, and a
 * `body` that is null when the response was not JSON), so a change there must turn this red.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

// api-client reads the token from localStorage when it builds headers; see api-client-get-dedup.test.ts.
const store = new Map<string, string>();
installGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
afterAll(uninstallDom);

const { ApiClient } = await import("../../../src/web/lib/api-client");
const { looksLikeServerRestart } = await import("../../../src/web/lib/upgrade-restart");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** What `POST /api/upgrade/apply` throws when the server answers with a response, or fetch rejects with an error. */
async function failureOf(answer: Response | Error): Promise<unknown> {
  globalThis.fetch = (() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))) as unknown as typeof fetch;
  try {
    await new ApiClient().post("/api/upgrade/apply");
  } catch (e) {
    return e;
  }
  throw new Error("the request was expected to fail");
}

/** PPM's own answer: JSON, in the `{ ok: false, error }` envelope. */
const ppmJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A proxy or tunnel's page, or a bare error: an answer that is not JSON. */
const notJson = (status: number) =>
  new Response("<html><body><h1>error page</h1></body></html>", { status, headers: { "Content-Type": "text/html" } });

describe("looksLikeServerRestart", () => {
  describe("an answer from PPM itself is a failed upgrade, whatever its message or status says", () => {
    it("when the installer's output names the network", async () => {
      const error = await failureOf(
        ppmJson(500, { ok: false, error: "Install failed (exit 1): npm ERR! network request to https://registry.npmjs.org/@hienlh%2fppm failed, reason: getaddrinfo EAI_AGAIN" }),
      );
      expect(looksLikeServerRestart(error)).toBe(false);
    });

    it("when the installer's output names a fetch", async () => {
      const error = await failureOf(
        ppmJson(500, { ok: false, error: "Install failed (exit 1): error: failed to fetch https://registry.npmjs.org/@hienlh/ppm" }),
      );
      expect(looksLikeServerRestart(error)).toBe(false);
    });

    it("when the installer's output quotes a gateway status", async () => {
      const error = await failureOf(
        ppmJson(500, { ok: false, error: "Install failed (exit 1): npm ERR! 502 Bad Gateway - GET https://registry.npmjs.org/@hienlh%2fppm (HTTP 502)" }),
      );
      expect(looksLikeServerRestart(error)).toBe(false);
    });

    it.each([502, 503, 504, 522])("when the status is a gateway's %d", async (status) => {
      const error = await failureOf(ppmJson(status, { ok: false, error: "Upgrade is not available right now" }));
      expect(looksLikeServerRestart(error)).toBe(false);
    });

    it("when the JSON carries no message, so the client words it `HTTP 503`", async () => {
      const error = await failureOf(ppmJson(503, { ok: false }));
      expect((error as Error).message).toBe("HTTP 503");
      expect(looksLikeServerRestart(error)).toBe(false);
    });
  });

  it("does not take a plain Error for a restart", () => {
    expect(looksLikeServerRestart(new Error("Unauthorized"))).toBe(false);
  });

  describe("no response at all is a restart, in any engine's words", () => {
    it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])("%s", async (message) => {
      expect(looksLikeServerRestart(await failureOf(new TypeError(message)))).toBe(true);
    });
  });

  describe("a gateway answering for an origin that is down is a restart", () => {
    it.each([502, 503, 504, 520, 522, 529])("a %d that is not JSON", async (status) => {
      expect(looksLikeServerRestart(await failureOf(notJson(status)))).toBe(true);
    });
  });

  describe("any other answer that is not JSON is a failed upgrade", () => {
    it.each([500, 501, 505, 519, 530])("a %d that is not JSON", async (status) => {
      expect(looksLikeServerRestart(await failureOf(notJson(status)))).toBe(false);
    });
  });
});
