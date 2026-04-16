import { Hono } from "hono";
import { jiraConfigRoutes } from "./jira-config-routes.ts";
import { jiraWatcherRoutes } from "./jira-watcher-routes.ts";

export const jiraRoutes = new Hono();
jiraRoutes.route("/config", jiraConfigRoutes);
jiraRoutes.route("/", jiraWatcherRoutes);
