/**
 * What the Services page renders on a host with no systemd — i.e. on macOS and
 * Windows, which is every platform this repository cannot run.
 *
 * The page has a branch for it, and the branch has to come *before* the table:
 * a column header row over "no units" would claim the host was measured and
 * found empty, which is a different statement from "PPM cannot read this host's
 * services at all". The warnings carry the reason, and they are the only thing
 * that will explain an empty page on a machine nobody can attach a debugger to.
 *
 * Pinned here because the failure mode is invisible on Linux: every check on
 * this host takes the supported branch.
 */
import { describe, it, expect, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServicesSnapshot } from "../../../src/types/system-services";

let snapshot: ServicesSnapshot | null = null;

mock.module("../../../src/web/components/system/services/use-services.ts", () => ({
  useServices: () => ({ snapshot, error: null, loading: false, refresh: async () => {} }),
  runServiceAction: async () => {},
  fetchServiceDetails: async () => null,
}));

const { ServicesPanel } = await import(
  "../../../src/web/components/system/services/services-panel.tsx"
);

const render = () => renderToStaticMarkup(<ServicesPanel active metrics={null} />);

describe("a host with no service manager", () => {
  it("says so, and does not draw a table of nothing", () => {
    snapshot = {
      supported: false,
      services: [],
      warnings: ['system services unavailable: Executable not found in $PATH: "systemctl"'],
    };
    const html = render();
    expect(html).toContain("no service manager");
    // No header: the columns must not imply a measurement that never happened.
    expect(html).not.toContain("sysmon-services-header");
    expect(html).not.toContain("GPU Memory");
  });

  it("shows the reason it could not read them", () => {
    snapshot = {
      supported: false,
      services: [],
      warnings: ['system services unavailable: Executable not found in $PATH: "systemctl"'],
    };
    expect(render()).toContain("systemctl");
  });
});

describe("a host that does have one", () => {
  it("draws the header with Mission Center's whole column set", () => {
    snapshot = {
      supported: true,
      warnings: [],
      services: [{
        unit: "sshd.service", scope: "system", description: "OpenSSH", activeState: "active",
        subState: "running", unitFileState: "enabled", running: true, failed: false,
        enabled: true, mainPid: 1234,
      }],
    };
    const html = render();
    expect(html).toContain("sysmon-services-header");
    for (const label of ["Name", "PID", "CPU", "Memory", "Swap", "Drive", "GPU", "GPU Memory"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("sshd.service");
  });

  it("an empty but supported host is the other message entirely", () => {
    snapshot = { supported: true, warnings: [], services: [] };
    const html = render();
    expect(html).toContain("No units match");
    expect(html).not.toContain("no service manager");
  });
});
