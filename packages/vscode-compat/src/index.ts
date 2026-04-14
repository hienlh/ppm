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

// Service imports
import { CommandService } from "./commands.ts";
import { WindowService } from "./window.ts";
import { WorkspaceService } from "./workspace.ts";
import { ProcessService } from "./process.ts";
import { createExtensionContext, type ExtensionContext } from "./context.ts";
import { createEnvNamespace } from "./env.ts";
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
  rpc: RpcClient;
  appName?: string;
  machineId?: string;
  storedState?: { global?: Record<string, string | null>; workspace?: Record<string, string | null> };
}

/** Create a scoped vscode-compatible API instance for an extension */
export function createVscodeCompat(options: CreateVscodeCompatOptions) {
  const { extensionId, extensionPath, storagePath, rpc, storedState } = options;

  const commands = new CommandService(rpc, extensionId);
  const window = new WindowService(rpc, extensionId);
  const workspace = new WorkspaceService(rpc, extensionId);
  const process = new ProcessService(rpc);

  return {
    // Active API namespaces
    commands,
    window,
    workspace,
    process,
    env: createEnvNamespace(options.appName ?? "PPM", options.machineId ?? "ppm-local"),

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
      return createExtensionContext(rpc, extensionId, extensionPath, storagePath, storedState);
    },
  };
}
