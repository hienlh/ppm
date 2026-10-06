/**
 * The service manager the Services routes talk to: launchd on macOS, the Service
 * Control Manager on Windows, systemd everywhere else. Each collector keeps its own vocabulary; this is the one shape
 * the routes see, so a route never branches on the platform.
 */
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServiceManager, ServiceScope, ServicesSnapshot,
} from "../../types/system-services.ts";
import {
  collectServices, createSystemdServices, runServiceAction, serviceDetails, type SystemdDeps,
} from "./systemd-collector.ts";
import { isPlausibleUnitName } from "./service-guard.ts";
import { createLaunchdBackend } from "./launchd-collector.ts";
import { createWindowsServicesBackend } from "./windows-services.ts";

export interface ServiceBackend {
  manager: ServiceManager;
  /** Whether a name may be handed to the manager at all: a unit name, a job label. */
  isName(unit: string): boolean;
  collect(): Promise<ServicesSnapshot>;
  /** Null when the manager knows no such unit — the route's 404. */
  details(unit: string, scope: ServiceScope): Promise<ServiceDetails | null>;
  /** Throws `ServiceActionRefused` for PPM's own refusals (403), any other error for
   *  the manager's (500). */
  action(unit: string, scope: ServiceScope, action: ServiceAction): Promise<ServiceActionResult>;
}

export function systemdBackend(deps: SystemdDeps = createSystemdServices()): ServiceBackend {
  return {
    manager: "systemd",
    isName: isPlausibleUnitName,
    collect: () => collectServices(deps),
    details: (unit, scope) => serviceDetails(unit, scope, deps),
    action: (unit, scope, action) => runServiceAction(unit, scope, action, deps),
  };
}

export function createServiceBackend(platform: NodeJS.Platform = process.platform): ServiceBackend {
  if (platform === "darwin") return createLaunchdBackend();
  if (platform === "win32") return createWindowsServicesBackend();
  return systemdBackend();
}
