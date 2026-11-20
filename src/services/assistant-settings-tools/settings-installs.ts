import type { ApprovalFact } from "../../shared/assistant-approval.ts";
import type { WriteCall } from "./settings-catalog-types.ts";

/**
 * The software Settings installs on request, as the `settings_install` tool sees it: Whisper and a
 * speech model, a language server, a database driver, the WebRTC relay. Every install and every
 * removal is a card, Full mode included — it downloads and runs a program, or deletes one. What
 * is fetched, from where and how it is checked is each installer's own (pinned versions and
 * SHA-256), and the route is the Settings pane's: nothing here chooses a package or a URL.
 *
 * Whisper and the relay run as background jobs (`status().running`); a language server and a
 * database driver install inside the request.
 */

export type InstallComponentId = "whisper" | "language_server" | "database_driver" | "webrtc_relay";
export const INSTALL_COMPONENTS: readonly InstallComponentId[] = ["whisper", "language_server", "database_driver", "webrtc_relay"];

export interface InstallOption { id: string; label: string; installed: boolean; removable: boolean; detail?: string }

export interface InstallStatus {
  installed: boolean;
  /** A background install under way. */
  running: { phase: string; receivedBytes: number; totalBytes: number } | null;
  error: string | null;
}

export interface InstallComponent {
  id: InstallComponentId;
  label: string;
  /** The Settings category the pane is in, for the history and the link. */
  category: string;
  /** Whether an install needs `option` (a model, a server, a driver). */
  needsOption: boolean;
  background: boolean;
  /** Why this host cannot install it, or null. */
  unavailable(): Promise<string | null>;
  options(): Promise<InstallOption[]>;
  status(option: string | null): Promise<InstallStatus>;
  install(option: string | null): WriteCall;
  uninstall(option: string | null): WriteCall;
  /** What the card says it fetches or removes. */
  facts(option: string | null, action: "install" | "uninstall"): Promise<ApprovalFact[]>;
}

const mb = (bytes: number) => `${Math.max(0.1, Math.round(bytes / 100_000) / 10)} MB`;

const whisper: InstallComponent = {
  id: "whisper", label: "Whisper speech to text", category: "voice", needsOption: true, background: true,
  async unavailable() {
    const { getWhisperStatus } = await import("../speech-to-text/whisper-install.service.ts");
    const s = getWhisperStatus();
    return s.installable ? null : `PPM cannot install Whisper on this host. ${s.installHint ?? ""}`.trim();
  },
  async options() {
    const { getWhisperStatus } = await import("../speech-to-text/whisper-install.service.ts");
    const s = getWhisperStatus();
    return s.models.map((m) => ({ id: m.id, label: m.label, installed: s.model?.id === m.id, removable: s.model?.id === m.id, detail: `${mb(m.bytes)} · ${m.note}` }));
  },
  async status(option) {
    const { getWhisperStatus } = await import("../speech-to-text/whisper-install.service.ts");
    const s = getWhisperStatus();
    const job = s.install;
    return {
      installed: s.ready && (!option || s.model?.id === option),
      running: job && !job.done ? { phase: job.phase, receivedBytes: job.receivedBytes, totalBytes: job.totalBytes } : null,
      error: job?.error ?? null,
    };
  },
  install: (option) => ({ method: "POST", path: "/api/speech/install", body: { model: option } }),
  uninstall: () => ({ method: "POST", path: "/api/speech/uninstall", body: {} }),
  async facts(option, action) {
    const [{ getWhisperStatus }, { WHISPER_VERSION, WHISPER_BUILD }] = await Promise.all([
      import("../speech-to-text/whisper-install.service.ts"), import("../speech-to-text/whisper-catalog.ts"),
    ]);
    const s = getWhisperStatus();
    if (action === "uninstall") return [{ label: "Removes", value: `Whisper and its model${s.model ? ` (${s.model.label})` : ""} from PPM's folder` }];
    const model = s.models.find((m) => m.id === option);
    return [
      { label: "Downloads", value: `whisper.cpp ${WHISPER_VERSION} (build ${WHISPER_BUILD}) and the ${model?.label ?? option} model (${model ? mb(model.bytes) : "?"}), plus the Silero VAD model` },
      { label: "From", value: "github.com/ggml-org/whisper.cpp and huggingface.co — each file checked against a pinned SHA-256" },
      { label: "Into", value: "PPM's folder (whisper)" },
    ];
  },
};

const languageServer: InstallComponent = {
  id: "language_server", label: "Language server", category: "language-servers", needsOption: true, background: false,
  unavailable: async () => null,
  async options() {
    const { lspManager } = await import("../lsp/lsp-manager.ts");
    return (await lspManager.availability()).map((s) => ({ id: s.id, label: s.displayName, installed: s.installed, removable: s.removable, detail: s.installable ? undefined : "not installable by PPM" }));
  },
  async status(option) {
    const opt = (await this.options()).find((o) => o.id === option);
    return { installed: opt?.installed === true, running: null, error: null };
  },
  install: (option) => ({ method: "POST", path: "/api/lsp/install", body: { serverId: option } }),
  uninstall: (option) => ({ method: "POST", path: "/api/lsp/uninstall", body: { serverId: option } }),
  async facts(option, action) {
    const { serverById } = await import("../lsp/server-registry.ts");
    const def = option ? serverById(option) : undefined;
    if (!def) return [{ label: "Server", value: String(option) }];
    const how = def.install ? `with ${def.install.with}` : "not installable by PPM";
    return action === "uninstall"
      ? [{ label: "Removes", value: `${def.displayName} from PPM's folder` }]
      : [{ label: "Installs", value: `${def.displayName} (${how})` }, { label: "Into", value: "PPM's folder (lsp-servers)" }];
  },
};

const databaseDriver: InstallComponent = {
  id: "database_driver", label: "Database driver", category: "database-drivers", needsOption: true, background: false,
  unavailable: async () => null,
  async options() {
    const { listDbDrivers } = await import("../database/drivers/db-driver-install.ts");
    return listDbDrivers().map((d) => ({ id: d.id, label: d.displayName, installed: d.installed !== null, removable: d.installed !== null, detail: `${d.package}@${d.version}, for ${d.usedFor}` }));
  },
  async status(option) {
    const opt = (await this.options()).find((o) => o.id === option);
    return { installed: opt?.installed === true, running: null, error: null };
  },
  install: (option) => ({ method: "POST", path: `/api/db/drivers/${encodeURIComponent(String(option))}/install`, body: {} }),
  uninstall: (option) => ({ method: "DELETE", path: `/api/db/drivers/${encodeURIComponent(String(option))}`, body: {} }),
  async facts(option, action) {
    const { listDbDrivers } = await import("../database/drivers/db-driver-install.ts");
    const d = listDbDrivers().find((x) => x.id === option);
    if (!d) return [{ label: "Driver", value: String(option) }];
    return action === "uninstall"
      ? [{ label: "Removes", value: `${d.displayName} from PPM's folder` }]
      : [{ label: "Installs", value: `${d.package}@${d.version} (${d.license}) from npm, for ${d.usedFor}` }];
  },
};

const webrtcRelay: InstallComponent = {
  id: "webrtc_relay", label: "WebRTC relay (MediaMTX)", category: "remote-desktop", needsOption: false, background: true,
  async unavailable() {
    const { relayStatus } = await import("../remote-desktop/mediamtx-install.service.ts");
    return relayStatus().available ? null : "MediaMTX publishes no build for this host.";
  },
  options: async () => [],
  async status() {
    const { relayStatus } = await import("../remote-desktop/mediamtx-install.service.ts");
    const s = relayStatus();
    return { installed: s.installed, running: s.job && !s.job.done ? { phase: "download", receivedBytes: s.job.receivedBytes, totalBytes: s.job.totalBytes } : null, error: s.job?.error ?? null };
  },
  install: () => ({ method: "POST", path: "/api/remote-desktop/relay/install", body: {} }),
  uninstall: () => ({ method: "POST", path: "/api/remote-desktop/relay/uninstall", body: {} }),
  async facts(_option, action) {
    const { relayStatus } = await import("../remote-desktop/mediamtx-install.service.ts");
    return action === "uninstall"
      ? [{ label: "Removes", value: "the MediaMTX relay PPM installed" }]
      : [{ label: "Downloads", value: `MediaMTX ${relayStatus().pinnedVersion} from github.com/bluenviron/mediamtx, checked against a pinned SHA-256` }];
  },
};

const BY_ID: Readonly<Record<InstallComponentId, InstallComponent>> = {
  whisper, language_server: languageServer, database_driver: databaseDriver, webrtc_relay: webrtcRelay,
};

export function installComponent(id: unknown): InstallComponent | null {
  return typeof id === "string" && Object.hasOwn(BY_ID, id) ? BY_ID[id as InstallComponentId] : null;
}
