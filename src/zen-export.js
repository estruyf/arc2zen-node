// Export Zen Browser pinned tabs, folders and essentials to bookmark HTML.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { bookmark, countItems, folder, outputPath, toBookmarksHtml } from "./bookmarks.js";
import { findZenProfile } from "./zen-profile.js";
import { readZenData } from "./zen-session.js";

function tabToBookmark(tab) {
  const entries = tab.entries ?? [];
  if (!entries.length) return null;
  const entry = entries.at(-1);
  const url = entry.url ?? "";
  if (!url || url === "about:blank") return null;
  const title = entry.title || tab._zenPinnedInitialState?.entry?.title || "";
  return bookmark(title || url, url);
}

// Essentials with zenWorkspace set belong to that workspace; the others are
// shared across workspaces whose containerTabId matches the tab's userContextId.
// Essentials matching no workspace are collected under the "" key.
function essentialsByWorkspace(tabs, spaces) {
  const containerToWs = new Map();
  for (const s of spaces) {
    if (!s.uuid) continue;
    const ct = s.containerTabId ?? 0;
    containerToWs.set(ct, [...(containerToWs.get(ct) ?? []), s.uuid]);
  }

  const result = new Map();
  const add = (ws, bm) => result.set(ws, [...(result.get(ws) ?? []), bm]);

  for (const tab of tabs) {
    if (!tab?.pinned || !tab.zenEssential || tab.zenIsEmpty) continue;
    const bm = tabToBookmark(tab);
    if (!bm) continue;
    if (tab.zenWorkspace) {
      add(tab.zenWorkspace, bm);
    } else {
      const targets = containerToWs.get(tab.userContextId ?? 0) ?? [""];
      for (const ws of targets) add(ws, bm);
    }
  }
  return result;
}

// Orders sibling folders by following the prevSiblingInfo linked list.
function sortBySiblingOrder(folders, parentId) {
  const siblings = folders.filter((f) => (f.parentId ?? null) === parentId);
  const byPrev = new Map();
  for (const f of siblings) {
    const prev = f.prevSiblingInfo?.type === "folder" ? f.prevSiblingInfo.id : null;
    byPrev.set(prev, f);
  }

  const ordered = [];
  const seen = new Set();
  let prev = null;
  while (byPrev.has(prev) && !seen.has(prev)) {
    seen.add(prev);
    const f = byPrev.get(prev);
    ordered.push(f);
    prev = f.id;
  }
  for (const f of siblings) if (!ordered.includes(f)) ordered.push(f);
  return ordered;
}

function buildTree(tabs, folders) {
  const folderChildren = new Map(folders.map((f) => [f.id, []]));
  const root = [];

  for (const tab of tabs) {
    const bm = tabToBookmark(tab);
    if (!bm) continue;
    const target = tab.groupId && folderChildren.get(tab.groupId);
    (target || root).push(bm);
  }

  const build = (data, seen) => {
    if (seen.has(data.id)) return null;
    seen.add(data.id);
    const children = folderChildren.get(data.id) ?? [];
    for (const child of sortBySiblingOrder(folders, data.id)) {
      const built = build(child, seen);
      if (built) children.push(built);
    }
    return children.length ? folder(data.name ?? "Unnamed", children) : null;
  };

  const seen = new Set();
  for (const f of sortBySiblingOrder(folders, null)) {
    const built = build(f, seen);
    if (built) root.push(built);
  }
  return root;
}

// One top-level folder per workspace, with an "Essentials" folder first.
export function parseZenBookmarks(profile) {
  const data = readZenData(profile);
  const tabs = (data.tabs ?? []).filter((t) => t && typeof t === "object");
  const folders = (data.folders ?? []).filter((f) => f && typeof f === "object" && "id" in f);
  const spaces = data.spaces ?? [];

  const names = new Map(spaces.filter((s) => s.uuid && s.name?.trim()).map((s) => [s.uuid, s.name.trim()]));
  const essentials = essentialsByWorkspace(tabs, spaces);

  const wsTabs = new Map();
  for (const tab of tabs) {
    if (!tab.pinned || tab.zenIsEmpty || tab.zenEssential) continue;
    const ws = tab.zenWorkspace || "default";
    wsTabs.set(ws, [...(wsTabs.get(ws) ?? []), tab]);
  }
  const wsFolders = new Map();
  for (const f of folders) {
    const ws = f.workspaceId || "default";
    wsFolders.set(ws, [...(wsFolders.get(ws) ?? []), f]);
  }

  // Zen's workspace order first, then anything orphaned.
  const ids = [...new Set([...spaces.map((s) => s.uuid), ...wsTabs.keys(), ...wsFolders.keys(), ...essentials.keys()])];

  const result = [];
  for (const id of ids) {
    if (!id) continue;
    const children = buildTree(wsTabs.get(id) ?? [], wsFolders.get(id) ?? []);
    const ess = essentials.get(id);
    if (ess?.length) children.unshift(folder("Essentials", ess));
    if (children.length) result.push(folder(names.get(id) ?? `Workspace ${id.slice(0, 8)}`, children));
  }
  const unassigned = essentials.get("");
  if (unassigned?.length) result.unshift(folder("Essentials", unassigned));
  return result;
}

// Returns [bookmarks, folders].
export function exportZenToHtml({ output, splitBySpace = false } = {}) {
  const profile = findZenProfile();
  if (!profile) throw new Error("Zen Browser profile not found");
  console.log(`Zen profile: ${profile}`);

  console.log("Reading Zen Browser data...");
  const folders = parseZenBookmarks(profile);
  if (!folders.length) {
    console.log("No bookmarks found in Zen Browser");
    return [0, 0];
  }

  if (splitBySpace && folders.length > 1) {
    let total = [0, 0];
    for (const f of folders) {
      const file = outputPath(output, "zen_bookmarks", f.title);
      writeFileSync(file, toBookmarksHtml([f]), "utf8");
      const [bm, fl] = countItems([f]);
      total = [total[0] + bm, total[1] + fl];
      console.log(`  ${path.basename(file)}: ${bm} bookmarks`);
    }
    return total;
  }

  const file = outputPath(output, "zen_bookmarks");
  writeFileSync(file, toBookmarksHtml(folders), "utf8");
  console.log(`Saved to: ${file}`);
  return countItems(folders);
}
