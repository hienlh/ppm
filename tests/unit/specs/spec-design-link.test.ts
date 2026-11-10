/** UI: yes — the drawing gates the design, and changing it reopens its approval. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-spec-draw-home-"));

const svc = await import("../../../src/services/specs/spec.service.ts");
const { createSpecDrawing, drawingHash } = await import("../../../src/services/specs/spec-design-link.ts");

const REQ = "# R\n\nUI: yes\n\n### Requirement 1: A\n\n#### Acceptance Criteria\n\n1. WHEN x THE SYSTEM SHALL y\n";

describe("the drawing", () => {
  it("must be approved before design, and reopens when it changes", async () => {
    const project = mkdtempSync(join(tmpdir(), "ppm-spec-draw-proj-"));
    await svc.createSpec(project, { title: "Export", slug: "export" });
    writeFileSync(join(project, "specs", "export", "requirements.md"), REQ);
    expect((await svc.approvePhase(project, "export", "requirements")).ok).toBe(true);

    let v = await svc.getSpec(project, "export");
    expect(v.needsDrawing).toBe(true);
    expect(v.drawing).toBe("missing");
    expect((await svc.approvePhase(project, "export", "design")).message).toMatch(/drawing/i);

    const designSlug = await createSpecDrawing(project, "Export");
    v = await svc.setDesignSlug(project, "export", designSlug);
    expect(v.drawing).toBe("draft");
    const before = await drawingHash(project, designSlug);
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    expect((await svc.approvePhase(project, "export", "drawing")).ok).toBe(true);
    expect((await svc.approvePhase(project, "export", "design")).ok).toBe(true);

    writeFileSync(join(project, "designs", designSlug, "index.html"), "<!doctype html><p>changed</p>");
    v = await svc.getSpec(project, "export");
    expect(v.drawing).toBe("stale");
    expect(v.current).toBe("design");
  });
});
