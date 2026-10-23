// Locate the Zen profile and detect a running Zen instance.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, Colors } from "./ui.js";

export const zenRoot = () => path.join(os.homedir(), "Library", "Application Support", "zen");

let profileOverride = null;

export function setProfileOverride(dir) {
  profileOverride = dir ? path.resolve(dir) : null;
}

function parseIni(file) {
  const sections = {};
  let current = null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = sections[header[1]] = {};
    } else if (current) {
      const eq = line.indexOf("=");
      if (eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

// Same precedence as Firefox: the install's dedicated profile (installs.ini),
// then the Default=1 profile in profiles.ini, then any profile with session data.
export function findZenProfile() {
  if (profileOverride) return isDir(profileOverride) ? profileOverride : null;

  const root = zenRoot();
  const candidates = [];

  const installsIni = path.join(root, "installs.ini");
  if (existsSync(installsIni)) {
    for (const section of Object.values(parseIni(installsIni))) {
      if (section.Default) candidates.push(path.join(root, section.Default));
    }
  }

  const profilesIni = path.join(root, "profiles.ini");
  if (existsSync(profilesIni)) {
    const profiles = Object.entries(parseIni(profilesIni)).filter(([name]) => name.startsWith("Profile"));
    profiles.sort(([, a], [, b]) => Number(b.Default === "1") - Number(a.Default === "1"));
    for (const [, p] of profiles) {
      if (p.Path) candidates.push(p.IsRelative === "0" ? p.Path : path.join(root, p.Path));
    }
  }

  const profilesDir = path.join(root, "Profiles");
  if (isDir(profilesDir)) {
    const dirs = readdirSync(profilesDir)
      .map((name) => path.join(profilesDir, name))
      .filter(isDir);
    dirs.sort((a, b) => Number(/default/i.test(path.basename(b))) - Number(/default/i.test(path.basename(a))));
    candidates.push(...dirs);
  }

  // Prefer a profile that actually has Zen session data.
  const existing = candidates.filter(isDir);
  return existing.find((dir) => existsSync(path.join(dir, "zen-sessions.jsonlz4"))) ?? existing[0] ?? null;
}

export function isZenRunning() {
  const result = spawnSync("pgrep", ["-ix", "zen"], { encoding: "utf8" });
  if (result.status === 0) {
    console.log(`Zen Browser is running (pid ${result.stdout.trim().split("\n").join(", ")})`);
    return true;
  }
  return false;
}

export async function waitForZenClosed() {
  while (isZenRunning()) {
    console.log(`\n${Colors.RED}Zen Browser is currently running!${Colors.RESET}`);
    await ask("Please quit Zen Browser (Cmd+Q) and press Enter to continue...");
  }
  console.log(`${Colors.GREEN}Zen Browser is closed.${Colors.RESET}`);
}
