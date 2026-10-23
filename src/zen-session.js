// Paths and readers for Zen's session files.

import { existsSync } from "node:fs";
import path from "node:path";
import { readMozLz4Json } from "./mozlz4.js";

export const sessionPaths = (profile) => ({
  zenSessions: path.join(profile, "zen-sessions.jsonlz4"),
  recovery: path.join(profile, "sessionstore-backups", "recovery.jsonlz4"),
  recoveryBak: path.join(profile, "sessionstore-backups", "recovery.baklz4"),
});

// zen-sessions.jsonlz4, falling back to the first window of recovery.jsonlz4.
export function readZenData(profile) {
  const { zenSessions, recovery } = sessionPaths(profile);
  if (existsSync(zenSessions)) return readMozLz4Json(zenSessions);
  if (existsSync(recovery)) {
    const win = readMozLz4Json(recovery).windows?.[0];
    if (win) {
      return { tabs: win.tabs ?? [], folders: win.folders ?? [], groups: win.groups ?? [], spaces: win.spaces ?? [] };
    }
  }
  throw new Error(`Zen Browser session data not found in ${profile}`);
}

// Workspaces in Zen's order: [{ name, uuid, containerTabId }]
export function readZenWorkspaces(profile) {
  return (readZenData(profile).spaces ?? [])
    .map((s) => ({ name: (s.name ?? "").trim(), uuid: s.uuid ?? "", containerTabId: s.containerTabId ?? 0 }))
    .filter((s) => s.name && s.uuid);
}
