// Migrate Arc spaces into Zen workspaces as pinned tabs and folders.
// Zen Browser must be closed while this runs.

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getArcSpaces } from "./arc.js";
import { countItems, isFolder } from "./bookmarks.js";
import { backupStamp } from "./backups.js";
import { readMozLz4Json, writeMozLz4Json } from "./mozlz4.js";
import { findZenProfile, waitForZenClosed } from "./zen-profile.js";
import { readZenWorkspaces, sessionPaths } from "./zen-session.js";
import { ask, rule } from "./ui.js";

// ============== IDs ==============

let idCounter = 0;

// Zen format "<timestamp>-<counter>"; the counter keeps IDs unique within one millisecond.
const generateId = () => `${Date.now()}-${++idCounter}`;

// Small deterministic hash for the per-entry ID fields Firefox expects to be numbers.
function hashUrl(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 16777619);
  return h >>> 0;
}

const braced = () => `{${randomUUID()}}`;

// ============== Tabs & folders ==============

function baseTab(workspaceId) {
  return {
    lastAccessed: Date.now(),
    pinned: true,
    hidden: false,
    zenWorkspace: workspaceId,
    zenSyncId: generateId(),
    zenEssential: false,
    zenDefaultUserContextId: null,
    zenPinnedIcon: null,
    zenIsEmpty: false,
    zenHasStaticIcon: false,
    zenGlanceId: null,
    zenIsGlance: false,
  };
}

const tabTail = () => ({
  searchMode: null,
  userContextId: 0,
  attributes: {},
  index: 1,
  userTypedValue: "",
  userTypedClear: 0,
  image: null,
});

// Placeholder tab Zen keeps inside every folder.
function createEmptyTab(workspaceId, groupId) {
  return {
    entries: [{ url: "about:blank", title: "" }],
    ...baseTab(workspaceId),
    groupId,
    zenIsEmpty: true,
    ...tabTail(),
  };
}

function createTab(url, title, workspaceId, groupId) {
  const id = hashUrl(url) % 1_000_000_000;
  const tab = {
    entries: [
      {
        url,
        title,
        cacheKey: 0,
        ID: id,
        docshellUUID: braced(),
        resultPrincipalURI: null,
        hasUserInteraction: false,
        triggeringPrincipal_base64: '{"3":{}}',
        docIdentifier: id % 1000,
        transient: false,
        navigationKey: braced(),
        navigationId: braced(),
      },
    ],
    ...baseTab(workspaceId),
    _zenPinnedInitialState: {
      entry: { url, title, cacheKey: 0, ID: id, triggeringPrincipal_base64: '{"3":{}}' },
      image: null,
    },
    ...tabTail(),
  };
  if (groupId) tab.groupId = groupId;
  return tab;
}

function createFolderAndGroup(name, workspaceId, parentId, prevSiblingId) {
  const id = generateId();
  const folder = {
    pinned: true,
    splitViewGroup: false,
    id,
    name: name || "Unnamed",
    collapsed: true,
    saveOnWindowClose: true,
    parentId: parentId ?? null,
    prevSiblingInfo: prevSiblingId ? { type: "folder", id: prevSiblingId } : { type: "start", id: null },
    emptyTabIds: [],
    userIcon: "",
    workspaceId,
  };
  const group = {
    pinned: true,
    splitView: false,
    id,
    name: name || "Unnamed",
    color: "zen-workspace-color",
    collapsed: true,
    saveOnWindowClose: true,
  };
  return { folder, group };
}

// Accumulates the folders/groups/tabs generated for the import.
class ZenBuilder {
  constructor(existingTabs) {
    this.folders = [];
    this.groups = [];
    this.tabs = [...existingTabs];
    this.parentOf = new Map();
    this.skipped = 0;
  }

  addItems(items, workspaceId, parentId) {
    let prevFolderId = null;
    for (const item of items) {
      if (isFolder(item)) {
        prevFolderId = this.addFolder(item, workspaceId, parentId, prevFolderId);
      } else if (item.url) {
        this.tabs.push(createTab(item.url, item.title, workspaceId, parentId));
      } else {
        this.skipped++;
      }
    }
  }

  addFolder(item, workspaceId, parentId, prevSiblingId) {
    const { folder, group } = createFolderAndGroup(item.title, workspaceId, parentId, prevSiblingId);
    const emptyTab = createEmptyTab(workspaceId, folder.id);
    folder.emptyTabIds = [emptyTab.zenSyncId];

    this.folders.push(folder);
    this.groups.push(group);
    this.tabs.push(emptyTab);
    if (parentId) this.parentOf.set(folder.id, parentId);

    this.addItems(item.children, workspaceId, folder.id);
    return folder.id;
  }

  // Every ancestor folder also lists the placeholder tabs of its descendants.
  propagateEmptyTabIds() {
    const byId = new Map(this.folders.map((f) => [f.id, f]));
    for (const f of this.folders) {
      const ids = [...f.emptyTabIds];
      for (let p = this.parentOf.get(f.id); p; p = this.parentOf.get(p)) {
        const parent = byId.get(p);
        if (!parent) continue;
        for (const id of ids) if (!parent.emptyTabIds.includes(id)) parent.emptyTabIds.push(id);
      }
    }
  }
}

// ============== Workspace matching ==============

// Returns Map<arcSpaceName, zenWorkspaceUuid | null>, exact match then case-insensitive.
function matchSpacesToWorkspaces(arcSpaces, workspaces) {
  const mapping = new Map();
  for (const space of arcSpaces) {
    const name = space.title.trim();
    const ws = workspaces.find((w) => w.name === name) ?? workspaces.find((w) => w.name.toLowerCase() === name.toLowerCase());
    mapping.set(name, ws?.uuid ?? null);
  }
  return mapping;
}

async function resolveMissingWorkspaces(mapping, workspaces, profile) {
  const missing = [...mapping].filter(([, uuid]) => !uuid).map(([name]) => name);
  const resolved = new Map([...mapping].filter(([, uuid]) => uuid));
  if (!missing.length) return resolved;

  console.log();
  rule();
  console.log("MISSING WORKSPACES");
  rule();
  console.log("\nThe following Arc Spaces have no matching Zen Workspace:");
  for (const name of missing) console.log(`  - ${name}`);
  console.log("\nAvailable Zen Workspaces:");
  workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name}`));
  console.log(`\n${"-".repeat(60)}`);

  for (const arcName of missing) {
    for (;;) {
      console.log(`\nArc Space: '${arcName}'`);
      console.log("Options:");
      console.log("  1. Create a new workspace in Zen with this name");
      console.log("  2. Map to an existing Zen workspace");
      console.log("  3. Skip this space (don't import)");
      const choice = await ask("\nChoose option (1/2/3): ");

      if (choice === "1") {
        console.log(`\n>>> Please create workspace '${arcName}' in Zen Browser now.`);
        console.log("    1. Open Zen Browser");
        console.log(`    2. Create workspace with exact name: ${arcName}`);
        console.log("    3. Quit Zen Browser (Cmd+Q)");
        await ask("\nPress Enter when done...");
        await waitForZenClosed();

        workspaces = readZenWorkspaces(profile);
        const found = workspaces.find((w) => w.name.toLowerCase() === arcName.toLowerCase());
        if (found) {
          resolved.set(arcName, found.uuid);
          console.log(`Found workspace '${found.name}'!`);
          break;
        }
        console.log(`Workspace '${arcName}' not found. Try again.`);
      } else if (choice === "2") {
        console.log("\nAvailable workspaces:");
        workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name}`));
        const idx = Number.parseInt(await ask("Enter number: "), 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < workspaces.length) {
          resolved.set(arcName, workspaces[idx].uuid);
          console.log(`Mapped '${arcName}' -> '${workspaces[idx].name}'`);
          break;
        }
        console.log("Invalid number.");
      } else if (choice === "3") {
        console.log(`Skipping '${arcName}'`);
        break;
      } else {
        console.log("Invalid choice. Enter 1, 2, or 3.");
      }
    }
  }
  return resolved;
}

// ============== Session file updates ==============

const withoutPinned = (tabs) => (tabs ?? []).filter((t) => !t.pinned);

function cleanPinnedTabsAndFolders(profile) {
  const { recovery, recoveryBak, zenSessions } = sessionPaths(profile);
  console.log("Cleaning all pinned tabs and folders...");

  for (const file of [recovery, recoveryBak]) {
    if (!existsSync(file)) continue;
    const data = readMozLz4Json(file);
    const win = data.windows?.[0];
    if (win) {
      win.tabs = withoutPinned(win.tabs);
      win.folders = [];
      win.groups = [];
      if (file === recovery) data.session = { ...data.session, lastUpdate: Date.now() };
    }
    writeMozLz4Json(file, data);
    console.log(`  Cleaned: ${path.basename(file)}`);
  }

  if (existsSync(zenSessions)) {
    const data = readMozLz4Json(zenSessions);
    data.tabs = withoutPinned(data.tabs);
    data.folders = [];
    data.groups = [];
    data.lastCollected = Date.now();
    writeMozLz4Json(zenSessions, data);
    console.log(`  Cleaned: ${path.basename(zenSessions)}`);
  }
}

function importSpaces(profile, arcSpaces, spaceToWorkspace) {
  const { recovery, recoveryBak, zenSessions } = sessionPaths(profile);
  const recoveryData = existsSync(recovery) ? readMozLz4Json(recovery) : null;
  const zenData = readMozLz4Json(zenSessions);
  const win = recoveryData?.windows?.[0];

  // The recovery window has the live unpinned tabs; fall back to zen-sessions.
  const builder = new ZenBuilder(win ? win.tabs ?? [] : zenData.tabs ?? []);

  for (const space of arcSpaces) {
    const workspaceId = spaceToWorkspace.get(space.title.trim());
    if (!workspaceId) continue;
    console.log(`Importing space '${space.title}' -> workspace ${workspaceId}...`);
    builder.addItems(space.children, workspaceId, null);
  }
  builder.propagateEmptyTabIds();

  console.log("\nWriting session files...");
  if (win) {
    win.tabs = builder.tabs;
    win.folders = builder.folders;
    win.groups = builder.groups;
    recoveryData.session = { ...recoveryData.session, lastUpdate: Date.now() };
    writeMozLz4Json(recovery, recoveryData);
    console.log(`  Updated: ${path.basename(recovery)}`);
    if (existsSync(recoveryBak)) {
      writeMozLz4Json(recoveryBak, recoveryData);
      console.log(`  Updated: ${path.basename(recoveryBak)}`);
    }
  }

  zenData.tabs = builder.tabs;
  zenData.folders = builder.folders;
  zenData.groups = builder.groups;
  zenData.lastCollected = Date.now();
  writeMozLz4Json(zenSessions, zenData);
  console.log(`  Updated: ${path.basename(zenSessions)}`);

  const imported = builder.tabs.filter((t) => t.pinned && !t.zenIsEmpty).length;
  console.log(`\nImported ${imported} bookmarks in ${builder.folders.length} folders`);
  if (builder.skipped) console.log(`Skipped ${builder.skipped} bookmarks without a URL`);
}

function backupSessionFiles(profile) {
  console.log("\nCreating backups...");
  const stamp = backupStamp();
  const { zenSessions, recovery } = sessionPaths(profile);
  for (const file of [zenSessions, recovery]) {
    if (!existsSync(file)) continue;
    const dst = `${file}.backup_${stamp}`;
    copyFileSync(file, dst);
    console.log(`  Backup: ${path.basename(dst)}`);
  }
}

// ============== Entry point ==============

export async function importToZen({ arcFile } = {}) {
  rule();
  console.log("Arc Browser -> Zen Browser Migration");
  rule();

  const profile = findZenProfile();
  if (!profile) {
    console.log("ERROR: No Zen Browser profile found.");
    return false;
  }
  console.log(`\nZen profile: ${profile}`);
  if (!existsSync(sessionPaths(profile).zenSessions)) {
    console.log("ERROR: zen-sessions.jsonlz4 not found. Open and quit Zen once, then retry.");
    return false;
  }

  console.log("\nReading Arc Browser data...");
  let arcSpaces;
  try {
    arcSpaces = getArcSpaces(arcFile);
  } catch (e) {
    console.log(`ERROR: Failed to read Arc data: ${e.message}`);
    return false;
  }
  if (!arcSpaces.length) {
    console.log("No Arc Spaces found.");
    return false;
  }

  console.log(`\nFound ${arcSpaces.length} Arc Spaces:`);
  for (const space of arcSpaces) {
    const folders = space.children.filter(isFolder).length;
    console.log(`  - ${space.title}: ${folders} folders, ${space.children.length - folders} standalone tabs`);
  }

  let totalBm = 0;
  let totalFolders = 0;
  let standalone = 0;
  for (const space of arcSpaces) {
    for (const item of space.children) {
      if (isFolder(item)) {
        const [bm, fl] = countItems([item]);
        totalBm += bm;
        totalFolders += fl;
      } else {
        standalone++;
      }
    }
  }
  console.log(`\nTotal: ${totalBm} bookmarks in ${totalFolders} folders + ${standalone} standalone tabs`);

  console.log("\nReading Zen workspaces...");
  const workspaces = readZenWorkspaces(profile);
  console.log(`Found ${workspaces.length} Zen Workspaces:`);
  for (const w of workspaces) console.log(`  - ${w.name}`);

  console.log("\nMatching Arc Spaces to Zen Workspaces...");
  const mapping = matchSpacesToWorkspaces(arcSpaces, workspaces);
  const matched = [...mapping].filter(([, uuid]) => uuid);
  const unmatched = [...mapping].filter(([, uuid]) => !uuid).map(([name]) => name);

  console.log(`\nMatched: ${matched.length}`);
  for (const [arcName, uuid] of matched) {
    console.log(`  + ${arcName} -> ${workspaces.find((w) => w.uuid === uuid)?.name ?? "?"}`);
  }
  if (unmatched.length) {
    console.log(`\nUnmatched: ${unmatched.length}`);
    for (const name of unmatched) console.log(`  - ${name}`);
  }

  const finalMapping = await resolveMissingWorkspaces(mapping, workspaces, profile);
  if (!finalMapping.size) {
    console.log("\nNo spaces to import.");
    return false;
  }

  console.log();
  rule();
  console.log("READY TO IMPORT");
  rule();
  console.log(`\nWill import ${finalMapping.size} spaces:`);
  for (const name of finalMapping.keys()) console.log(`  - ${name}`);

  console.log("\nWARNING: This will DELETE all existing pinned tabs, essentials and folders in Zen!");
  if ((await ask("\nProceed? (yes/no): ")).toLowerCase() !== "yes") {
    console.log("Aborted.");
    return false;
  }

  // Zen may have been reopened while the prompts were waiting.
  await waitForZenClosed();

  backupSessionFiles(profile);
  cleanPinnedTabsAndFolders(profile);
  console.log("\nImporting...");
  importSpaces(profile, arcSpaces, finalMapping);

  console.log();
  rule();
  console.log("DONE!");
  rule();
  console.log("\nNow open Zen Browser to see your imported tabs and folders.");
  return true;
}
