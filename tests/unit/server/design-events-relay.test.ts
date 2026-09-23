import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalWebSocket } from "../../../src/server/ws/global.ts";
import { configService } from "../../../src/services/config.service.ts";
import { emitDesignEvent } from "../../../src/services/design/design-events.ts";

describe("design event relay on /ws/global", () => {
  let project: string;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  let sent: unknown[];
  const socket = { data: { type: "global" }, send: (raw: string) => { sent.push(JSON.parse(raw)); } };

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-relay-")));
    previousProjects = [...configService.get("projects")];
    configService.set("projects", [{ name: "demo", path: project }]);
    sent = [];
    globalWebSocket.open(socket);
    sent = [];
  });
  afterEach(() => {
    globalWebSocket.close(socket);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("broadcasts design events by project name", () => {
    emitDesignEvent("history_changed", { projectPath: project, slug: "home" });
    emitDesignEvent("comments_changed", { projectPath: join(project, "."), slug: "home" });
    expect(sent).toEqual([
      { type: "design:history_changed", projectName: "demo", slug: "home" },
      { type: "design:comments_changed", projectName: "demo", slug: "home" },
    ]);
  });

  it("drops events for a path no registered project owns", () => {
    emitDesignEvent("history_changed", { projectPath: join(project, "elsewhere"), slug: "home" });
    expect(sent).toEqual([]);
  });
});
