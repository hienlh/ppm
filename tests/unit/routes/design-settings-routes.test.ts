import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { getConfigValue, setConfigValue } from "../../../src/services/db.service.ts";
import { designSettingsRoutes } from "../../../src/server/routes/design-settings.ts";
import {
  DESIGN_INSTRUCTIONS_KEY, getDesignInstructions, setDesignInstructions,
} from "../../../src/services/design/design-settings.service.ts";
import { DESIGN_INSTRUCTIONS_MAX_BYTES } from "../../../src/shared/design-skill-mentions.ts";

const app = new Hono().route("/settings/design", designSettingsRoutes);

function put(body: string) {
  return app.request("/settings/design", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
}

describe("/settings/design", () => {
  beforeEach(() => setDesignInstructions(""));

  it("saves normalised text and reads it back", async () => {
    const res = await put(JSON.stringify({ instructions: "  Use /brand-kit\r\nfirst.  " }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.instructions).toBe("Use /brand-kit\nfirst.");
    expect(getDesignInstructions()).toBe("Use /brand-kit\nfirst.");
    expect(JSON.parse(getConfigValue(DESIGN_INSTRUCTIONS_KEY)!)).toBe("Use /brand-kit\nfirst.");

    const got = await (await app.request("/settings/design")).json();
    expect(got.data.instructions).toBe("Use /brand-kit\nfirst.");
    expect(got.data.maxBytes).toBe(DESIGN_INSTRUCTIONS_MAX_BYTES);
    expect(Array.isArray(got.data.providers)).toBe(true);
    const claude = got.data.providers.find((p: { id: string }) => p.id === "claude");
    expect(claude?.runtime).toBe("claude");
    expect(claude?.available).toBe(true);
  });

  it("refuses a body that is not valid instructions and keeps the saved text", async () => {
    setDesignInstructions("kept");
    for (const body of ["not json", JSON.stringify({}), JSON.stringify({ instructions: 5 }),
      JSON.stringify({ instructions: "x".repeat(DESIGN_INSTRUCTIONS_MAX_BYTES + 1) })]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(getDesignInstructions()).toBe("kept");
  });

  it("reads an unreadable stored row as empty", () => {
    setDesignInstructions("x");
    // A row written by hand or by a future build with another shape.
    setConfigValue(DESIGN_INSTRUCTIONS_KEY, "{not json");
    expect(getDesignInstructions()).toBe("");
    setConfigValue(DESIGN_INSTRUCTIONS_KEY, JSON.stringify({ text: "x" }));
    expect(getDesignInstructions()).toBe("");
  });
});
