/**
 * The extension host gets a base URL for its `fetch()` calls back into PPM (Git Graph's project
 * lookup). Built from the configured port, it pointed at another instance — or nothing — whenever
 * the server listened elsewhere: under the supervisor (port 0) and on a dev or scratch port.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { extensionHostBaseUrl } from "../../../src/services/extension.service.ts";

afterEach(() => setServerListenAddress(0, ""));

describe("extensionHostBaseUrl", () => {
  it("is the port the server listens on, not the configured one", () => {
    configService.set("port", 8080);
    setServerListenAddress(43117, "0.0.0.0");
    expect(extensionHostBaseUrl()).toBe("http://127.0.0.1:43117");
  });

  it("falls back to the configured port when nothing listens in this process", () => {
    configService.set("port", 8123);
    expect(extensionHostBaseUrl()).toBe("http://localhost:8123");
  });
});
