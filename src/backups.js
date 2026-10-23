// Backups of Zen session files, named <file>.backup_YYYYMMDD_HHMMSS
// (same naming as the original Python arc2zen, so its backups are picked up too).

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { findZenProfile } from "./zen-profile.js";
import { sessionPaths } from "./zen-session.js";

const pad = (n) => String(n).padStart(2, "0");

export function backupStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// "20260123_101530" -> "2026-01-23 10:15:30"
export const formatStamp = (ts) =>
  `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`;

// [{ file, stamp }] for zen-sessions and recovery backups.
export function listBackupFiles(profile = findZenProfile()) {
  if (!profile) return [];
  const { zenSessions, recovery } = sessionPaths(profile);
  const result = [];
  for (const target of [zenSessions, recovery]) {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.backup_`;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) result.push({ file: path.join(dir, name), stamp: name.slice(prefix.length) });
    }
  }
  return result;
}

// Unique timestamps, newest first.
export function listBackupStamps(profile) {
  return [...new Set(listBackupFiles(profile).map((b) => b.stamp))].sort().reverse();
}

// Returns the number of session files restored.
export function restoreBackup(stamp, profile = findZenProfile()) {
  const { zenSessions, recovery, recoveryBak } = sessionPaths(profile);
  let restored = 0;

  if (existsSync(`${zenSessions}.backup_${stamp}`)) {
    copyFileSync(`${zenSessions}.backup_${stamp}`, zenSessions);
    console.log(`  Restored: ${path.basename(zenSessions)}`);
    restored++;
  }
  if (existsSync(`${recovery}.backup_${stamp}`)) {
    copyFileSync(`${recovery}.backup_${stamp}`, recovery);
    console.log(`  Restored: ${path.basename(recovery)}`);
    copyFileSync(`${recovery}.backup_${stamp}`, recoveryBak);
    console.log(`  Restored: ${path.basename(recoveryBak)}`);
    restored++;
  }
  return restored;
}

export function deleteAllBackups(profile) {
  const files = listBackupFiles(profile);
  for (const { file } of files) unlinkSync(file);
  return files.length;
}
