import { Hono } from "hono";
import { jiraConfigRoutes } from "./jira-config-routes.ts";
import { jiraWatcherRoutes } from "./jira-watcher-routes.ts";
import { announceJiraChanges } from "./jira-broadcast.ts";

export const jiraRoutes = new Hono();
jiraRoutes.use("*", announceJiraChanges);
jiraRoutes.route("/config", jiraConfigRoutes);
jiraRoutes.route("/", jiraWatcherRoutes);
