/**
 * @ppm/vscode-compat — VSCode-compatible API shim for PPM extensions.
 *
 * Extension authors replace `import * as vscode from 'vscode'`
 * with `import * as vscode from '@ppm/vscode-compat'`.
 *
 * All API calls serialize over RPC to the main PPM process.
 */

// Re-export types and classes
export { Disposable } from "./disposable.ts";
export { EventEmitter, type Event } from "./event-emitter.ts";
export { Uri } from "./uri.ts";
export {
  TreeItemCollapsibleState, ViewColumn, StatusBarAlignment,
  ConfigurationTarget, DiagnosticSeverity, ThemeIcon,
  type TreeItem, type TreeDataProvider, type WebviewPanel,
  type Webview, type WebviewOptions, type StatusBarItem,
  type QuickPickItem, type QuickPickOptions, type InputBoxOptions,
  type OutputChannel, type WorkspaceFolder, type WorkspaceConfiguration,
  type RpcClient,
} from "./types.ts";
export { type ExtensionContext, Memento } from "./context.ts";
export { ProcessService, type SpawnResult, type SpawnOptions } from "./process.ts";
export { type PpmNamespace } from "./ppm/index.ts";
export {
  type PpmChat, type PpmChatProject, type PpmChatCreateSessionOptions, type PpmChatSession,
  type PpmChatSendOptions, type PpmChatSendResult, type PpmChatState, type PpmChatWaitOptions,
  type PpmChatToolPolicy, type PpmChatBindOptions, type PpmChatBinding, type PpmChatBindResult,
  type PpmChatOpenTabOptions,
} from "./ppm/ppm-chat.ts";
export { type TabPlacementOptions } from "./tab-placement.ts";
export {
  PpmAiError, type PpmAi, type PpmAiProvider, type PpmAiCompleteRequest, type PpmAiCompleteResult,
  type PpmAiErrorCode,
} from "./ppm/ppm-ai.ts";
export {
  type PpmUsage, type PpmUsageProviderId, type PpmUsageWindow, type PpmUsageAccount, type PpmUsageSummary,
  type PpmPresence, type PpmPresenceSnapshot,
} from "./ppm/ppm-usage.ts";
export {
  type PpmMcp, type PpmMcpToolset, type PpmMcpToolDefinition, type PpmMcpCallContext, type PpmMcpToolResult,
  type PpmMcpToolHandler, type PpmMcpRegistration, type PpmMcpHost,
} from "./ppm/ppm-mcp.ts";
export {
  PpmNotifyError, type PpmNotify, type PpmNotifyRequest, type PpmNotifyOutcome, type PpmNotifyErrorCode,
} from "./ppm/ppm-notify.ts";

// Service imports
import { CommandService } from "./commands.ts";
import { WindowService } from "./window.ts";
import { WorkspaceService } from "./workspace.ts";
import { ProcessService } from "./process.ts";
import { createExtensionContext, type ExtensionContext } from "./context.ts";
import { createEnvNamespace } from "./env.ts";
import { createPpmNamespace } from "./ppm/index.ts";
import { createPpmMcp } from "./ppm/ppm-mcp.ts";
import { createNotSupported } from "./not-supported.ts";
import { Uri } from "./uri.ts";
import { Disposable } from "./disposable.ts";
import { EventEmitter } from "./event-emitter.ts";
import {
  TreeItemCollapsibleState, ViewColumn, StatusBarAlignment,
  ConfigurationTarget, DiagnosticSeverity, ThemeIcon,
} from "./types.ts";
import type { RpcClient } from "./types.ts";

export interface CreateVscodeCompatOptions {
  extensionId: string;
  extensionPath: string;
  storagePath: string;
  /** Per-extension data folder that survives reinstall and rebuild; `storagePath` when absent. */
  globalStoragePath?: string;
  rpc: RpcClient;
  appName?: string;
  machineId?: string;
  storedState?: { global?: Record<string, string | null>; workspace?: Record<string, string | null> };
}

/** Create a scoped vscode-compatible API instance for an extension */
export function createVscodeCompat(options: CreateVscodeCompatOptions) {
  const { extensionId, extensionPath, storagePath, rpc, storedState } = options;
  const globalStoragePath = options.globalStoragePath ?? storagePath;

  const commands = new CommandService(rpc, extensionId);
  const window = new WindowService(rpc, extensionId);
  const workspace = new WorkspaceService(rpc, extensionId);
  const process = new ProcessService(rpc);
  const mcp = createPpmMcp(rpc, extensionId);

  return {
    // Active API namespaces
    commands,
    window,
    workspace,
    process,
    env: createEnvNamespace(options.appName ?? "PPM", options.machineId ?? "ppm-local"),
    /** PPM's own API, beyond what VSCode offers. */
    ppm: createPpmNamespace(rpc, extensionId, mcp.api),

    // Classes & utilities
    Uri,
    Disposable,
    EventEmitter,

    // Enums
    TreeItemCollapsibleState,
    ViewColumn,
    StatusBarAlignment,
    ConfigurationTarget,
    DiagnosticSeverity,
    ThemeIcon,

    // Unsupported namespaces (throw descriptive errors)
    languages: createNotSupported("languages"),
    debug: createNotSupported("debug"),
    tasks: createNotSupported("tasks"),
    scm: createNotSupported("scm"),
    notebooks: createNotSupported("notebooks"),
    authentication: createNotSupported("authentication"),
    tests: createNotSupported("tests"),

    // Helper: create ExtensionContext for this extension
    _createContext(): ExtensionContext {
      return createExtensionContext(rpc, extensionId, extensionPath, storagePath, storedState, globalStoragePath);
    },
    /** For the extension host: routes the tool calls of this extension's toolsets. */
    _mcpHost: mcp.host,
  };
}
