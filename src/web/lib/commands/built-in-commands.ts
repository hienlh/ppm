/**
 * PPM's own commands, in the order the command palette lists them. Each is visible only where
 * it does something (`builtInCommands` leaves out what `ctx` rules out) and declares whether
 * running it changes data: opening a tab, a window or a dialog does not; flipping a saved
 * setting, starting a language server or turning the microphone on does.
 */
import {
  AppWindow, BotMessageSquare, Bug, CircleX, Cloud, Columns2, Cpu, Database, FilePlus, GitCommitHorizontal, Globe,
  MessageSquare, Mic, MonitorSmartphone, ScrollText, Settings, Terminal, WrapText, Zap,
} from "@/lib/icons";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import { openSettings } from "@/components/settings/open-settings";
import { openAssistant } from "@/components/assistant/open-assistant";
import { openRemoteAccess } from "@/components/settings/remote-access/remote-access-tab-store";
import { openPortForwarding } from "@/components/tunnels/open-port-forwarding";
import { openSystemMonitor } from "@/components/system/use-open-system-monitor";
import { openLogs } from "@/components/logs/open-logs";
import { openConnectionForm } from "@/components/database/open-connection-form";
import { openNewQuery } from "@/components/database/explorer/open-new-query";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useCompareStore } from "@/stores/compare-store";
import { usePanelStore } from "@/stores/panel-store";
import { basename } from "@/lib/utils";
import { formatShortcut } from "./format-shortcut";
import type { AppCommand, CommandContext } from "./command-registry";

/** A new tab of `type` in the project `ctx` shows. */
function openProjectTab(ctx: CommandContext, type: TabType, title: string): void {
  const project = ctx.project;
  useTabStore.getState().openTab({
    type, title, projectId: project?.name ?? null, metadata: project ? { projectName: project.name } : undefined, closable: true,
  });
}

/** Seed the compare picker's first side from the editor in front, then open the picker. */
function compareFiles(): void {
  const { activeTabId, tabs } = useTabStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  const meta = active?.metadata as { filePath?: string; projectName?: string; unsavedContent?: string } | undefined;
  if (active?.type === "editor" && meta?.filePath && meta?.projectName) {
    useCompareStore.getState().setSelection({
      filePath: meta.filePath, projectName: meta.projectName, dirtyContent: meta.unsavedContent, label: basename(meta.filePath),
    });
  }
  window.dispatchEvent(new CustomEvent("open-compare-picker"));
}

/**
 * The sidebar's Source Control section, expanding a collapsed sidebar on the way. A phone has
 * no sidebar to expand, and flipping the saved collapsed state from there would change it for
 * the desktop too.
 */
function showGitStatus(ctx: CommandContext): void {
  const settings = useSettingsStore.getState();
  if (settings.sidebarCollapsed && !ctx.isMobile) settings.toggleSidebar();
  settings.setSidebarActiveTab("git");
}

export function builtInCommands(ctx: CommandContext): AppCommand[] {
  const { isMobile, isTouchOnly, lspEnabled } = ctx;
  /** The keybinding that runs a command, and the shortcut the palette shows for it. */
  const bound = (binding: string) => ({ binding, shortcut: formatShortcut(ctx.getBinding(binding)) || undefined });

  return [
    {
      id: "chat", label: "New AI Chat", icon: MessageSquare, keywords: "ai assistant claude", changesData: false,
      ...bound("open-chat"), run: (c) => openProjectTab(c, "chat", "AI Chat"),
    },
    {
      id: "ppm-assistant", label: "PPM Assistant", icon: BotMessageSquare, changesData: false,
      keywords: "assistant agent helper control ppm ai claude codex",
      ...bound("open-assistant"), run: () => openAssistant(),
    },
    {
      id: "new-file", label: "New File", icon: FilePlus, keywords: "create untitled blank empty", changesData: false,
      ...bound("new-file"), run: () => useTabStore.getState().openNewFile(),
    },
    {
      id: "new-db-query", label: "New DB Query", icon: Database, keywords: "sql database query scratchpad new", changesData: false,
      run: () => openNewQuery(),
    },
    {
      id: "terminal", label: "New Terminal", icon: Terminal, keywords: "bash shell console", changesData: false,
      ...bound("open-terminal"), run: (c) => openProjectTab(c, "terminal", "Terminal"),
    },
    {
      id: "remote-access", label: "Remote Access", icon: MonitorSmartphone, changesData: false,
      keywords: "remote access tunnel cloudflare tailscale public link share url phone domain",
      run: () => openRemoteAccess(),
    },
    {
      id: "forward-port", label: "Forward a Port", icon: Globe, changesData: false,
      keywords: "forward port forwarding localhost web preview tunnel cloudflare tailscale dev server url",
      run: () => openPortForwarding(),
    },
    {
      id: "cloud-share", label: "PPM Cloud & Share", icon: Cloud, changesData: false,
      keywords: "cloud permanent link alias share phone remote device qr sign in login",
      run: () => { window.dispatchEvent(new CustomEvent("open-cloud-share")); },
    },
    {
      id: "new-db-connection", label: "New connection…", icon: Database, changesData: false,
      keywords: "database connection postgres pg mysql mariadb sqlite add",
      run: () => openConnectionForm(),
    },
    {
      // It turns the microphone on, which nobody but the user should do unasked.
      id: "voice-input", label: "Voice Input", icon: Mic, keywords: "speech microphone dictate voice", changesData: true,
      ...bound("voice-input"), run: () => { window.dispatchEvent(new CustomEvent("toggle-voice-input")); },
    },
    {
      id: "git-status", label: "Git Status", icon: GitCommitHorizontal, keywords: "changes diff staged", changesData: false,
      ...bound("open-git-status"), run: (c) => showGitStatus(c),
    },
    {
      id: "problems", label: "Problems", icon: CircleX, keywords: "errors warnings diagnostics lint typescript", changesData: false,
      ...bound("open-problems"),
      run: () => usePanelStore.getState().openInDock({ type: "problems", title: "Problems", projectId: null, closable: true }),
    },
    {
      // The editor's own wrap toggle is in the desktop-only breadcrumb bar,
      // so on a phone this and Settings are the way to reach it. A saved setting.
      id: "word-wrap", label: "Toggle Word Wrap", icon: WrapText, changesData: true,
      keywords: "wrap unwrap word lines editor soft",
      shortcut: isMobile ? undefined : "Alt+Z",
      run: (c) => {
        const settings = useSettingsStore.getState();
        if (c.isMobile) settings.toggleMobileWordWrap();
        else settings.toggleWordWrap();
      },
    },
    {
      id: "compare-files", label: "Compare Files...", icon: Columns2, keywords: "diff compare two files select", changesData: false,
      ...bound("compare-files"), run: () => compareFiles(),
    },
    // `isTouchOnly`, not `isMobile`: the editor gates the server on the device
    // rather than on the viewport, so a wide touch-only tablet was offered this
    // entry while the setting it toggles did nothing there. The two have to ask
    // the same question or the palette advertises a switch with no effect.
    // A saved setting that starts or stops a language server process.
    ...(isTouchOnly ? [] : [{
      id: "language-server",
      label: lspEnabled ? "Turn Off Language Server" : "Turn On Language Server",
      icon: Zap,
      keywords: "lsp language server completions intellisense hover definition typescript pyright gopls",
      hint: "This device",
      changesData: true,
      run: () => {
        const settings = useSettingsStore.getState();
        settings.setLspEnabled(!settings.lspEnabled);
      },
    }]),
    {
      id: "settings", label: "Settings", icon: Settings, keywords: "config preferences theme", changesData: false,
      ...bound("open-settings"), run: () => openSettings(),
    },
    {
      id: "open-file-explorer", label: "Open File Explorer", icon: AppWindow, changesData: false,
      keywords: "open file explorer finder browse files folders disk drive window",
      run: () => openExplorer(),
    },
    // A phone's only way in: the status bar's CPU/MEM chip, the other one, is hidden below md.
    {
      id: "system-monitor", label: "System Monitor", icon: Cpu, changesData: false,
      keywords: "task manager activity monitor cpu memory ram disk network gpu processes services apps performance resources",
      run: (c) => openSystemMonitor(c.isMobile),
    },
    {
      id: "logs", label: "Logs", icon: ScrollText, changesData: false,
      keywords: "logs server errors warnings debug tail ppm.log browser console cloudflared",
      run: () => openLogs(),
    },
    {
      // Opens the report form; nothing is posted until the user sends it.
      id: "report-bug", label: "Report a Bug", icon: Bug, changesData: false,
      keywords: "report bug issue github feedback problem crash",
      run: () => openLogs({ view: "report" }),
    },
  ];
}
