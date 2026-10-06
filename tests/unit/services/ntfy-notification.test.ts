import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { notificationLink } from "../../../src/services/notification-link.ts";
import type { NotificationPayload } from "../../../src/services/notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { tailscaleAppService } from "../../../src/services/tailscale/tailscale-app-service.ts";
import { startFakeNtfy, WRITER_TOKEN, type FakeNtfy } from "../../helpers/fake-ntfy-server.ts";

const original = configService.get("ntfy");
const originalReadState = tailscaleAppService.readState;
// The link would otherwise ask this machine's own Tailscale CLI.
tailscaleAppService.readState = async () => { throw new Error("no Tailscale in this test"); };
afterAll(() => {
  configService.set("ntfy", original!);
  tailscaleAppService.readState = originalReadState;
});

const payload: NotificationPayload = {
  title: "Chat completed", body: "ppm — Fix login", detail: "All 12 tests pass.", project: "ppm", sessionId: "s1", providerId: "codex",
};

describe("ntfyService.send", () => {
  let ntfy: FakeNtfy;
  beforeEach(() => {
    setDb(openTestDb());
    ntfy = startFakeNtfy();
    configService.set("ntfy", { server: ntfy.url, topic: "ppm-alerts", token: WRITER_TOKEN });
  });
  afterEach(() => ntfy.stop());

  it("publishes the same title and text as push, with a link back to the chat", async () => {
    await ntfyService.send(payload, false);
    expect(ntfy.published).toHaveLength(1);
    const message = ntfy.published[0]!;
    expect(message).toMatchObject({ topic: "ppm-alerts", title: "Chat completed · PPM", message: "ppm — Fix login\nAll 12 tests pass." });
    expect(message).not.toHaveProperty("priority");
    expect(message.click).toBe(await notificationLink(payload));
    expect(String(message.click)).toEndWith("/project/ppm?openChat=codex%2Fs1");
    expect(ntfy.requests[0]!.auth).toBe(`Bearer ${WRITER_TOKEN}`);
  });

  it("raises what is waiting on you to ntfy's high priority", async () => {
    await ntfyService.send(payload, true);
    expect(ntfy.published[0]!.priority).toBe(4);
  });

  it("carries any language in the title, which ntfy's header form could not", async () => {
    await ntfyService.send({ ...payload, title: "Đã xong", body: "ppm — Sửa đăng nhập 🚀" }, false);
    expect(ntfy.published[0]).toMatchObject({ title: "Đã xong · PPM", message: "ppm — Sửa đăng nhập 🚀\nAll 12 tests pass." });
  });

  it("does nothing while ntfy is not set up, and throws when the server refuses", async () => {
    configService.set("ntfy", { server: "", topic: "", token: "" });
    await ntfyService.send(payload, false);
    expect(ntfy.requests).toEqual([]);

    configService.set("ntfy", { server: ntfy.url, topic: "ppm-alerts", token: "" });
    await expect(ntfyService.send(payload, false)).rejects.toThrow('needs an access token to publish to "ppm-alerts"');
  });
});
