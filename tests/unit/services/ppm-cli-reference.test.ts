/**
 * The CLI reference the Assistant reads: generated from the CLI source (and failing here when
 * someone changes a command without regenerating it), free of the old PPMBot commands, and
 * headed by how to reach this instance — with a warning when this server runs on a database
 * profile the CLI cannot select.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  PPM_CLI_REFERENCE, currentPpmInstance, ppmCliReference, ppmCliReferenceHeader,
} from "../../../src/services/assistant/ppm-cli-reference.ts";
import { generatePpmCliReference } from "../../../scripts/generate-ppm-cli-reference.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

describe("PPM_CLI_REFERENCE", () => {
  it("matches what the generator produces from the CLI source now", () => {
    // On failure: bun scripts/generate-ppm-cli-reference.ts --update
    // (the source literal ends with the newline before its closing backtick).
    expect(PPM_CLI_REFERENCE).toBe(`${generatePpmCliReference()}\n`);
  });

  it("covers every command group, nested sub-commands included", () => {
    for (const group of ["Core Commands", "ppm projects", "ppm config", "ppm git", "ppm chat", "ppm db", "ppm autostart", "ppm cloud", "ppm ext", "ppm schedule"]) {
      expect(PPM_CLI_REFERENCE).toContain(group);
    }
    expect(PPM_CLI_REFERENCE).toContain("ppm git branch create");
    expect(PPM_CLI_REFERENCE).toContain("ppm db driver install");
  });

  it("leaves the PPMBot coordinator's commands out", () => {
    expect(PPM_CLI_REFERENCE).not.toContain("ppm bot");
    expect(PPM_CLI_REFERENCE).not.toContain("delegate");
  });
});

describe("the header", () => {
  const base = { ppmDir: "/home/u/.ppm", dbFile: "/home/u/.ppm/ppm.db", profile: null, command: "ppm" };

  it("names this instance's folder and how to invoke its CLI, and sorts commands by how they reach PPM", () => {
    const header = ppmCliReferenceHeader(base);
    expect(header).toContain("/home/u/.ppm (database ppm.db)");
    expect(header).toContain("Invoke the CLI as: ppm");
    expect(header).toContain("## Commands that go through the running server");
    expect(header).toContain("## Commands that read or write PPM's data directly");
    expect(header).not.toContain("WARNING");
  });

  it("warns that a profile server's data is out of the CLI's reach", () => {
    const header = ppmCliReferenceHeader({ ...base, dbFile: "/home/u/.ppm/ppm.dev.db", profile: "dev" });
    expect(header).toContain('WARNING: this server runs on the "dev" database profile (ppm.dev.db)');
    expect(header).toContain("opens ppm.db, which belongs to a different PPM instance");
  });

  it("describes the running instance: this test's own folder", () => {
    const instance = currentPpmInstance();
    expect(instance.ppmDir).toBe(getPpmDir());
    expect(instance.command).toContain("index.ts");
    expect(ppmCliReference(instance)).toEndWith(PPM_CLI_REFERENCE);
  });
});
